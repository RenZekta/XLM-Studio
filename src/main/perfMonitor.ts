// Monitoring tab backend. Since "Chat UI" mode opens llama-server's
// web UI in the user's DEFAULT SYSTEM BROWSER (shell.openExternal — see
// run-model in ipc.ts), the Electron main process has no visibility into
// individual chat requests/responses at all. The only viable data source is
// polling llama-server's own HTTP endpoints directly — specifically
// /metrics (Prometheus text format, enabled via --metrics, which run-model
// now force-adds to every launch). This module polls that endpoint every
// ~2s for each running template, derives rolling generation speed and
// prefill (prompt-processing) speed from the deltas between polls, and
// persists session history to disk with a configurable retention cap.
//
// Caveat (documented honestly, not hidden): llama-server's /metrics doesn't
// directly expose whether a given prompt-processing burst hit the KV cache
// (warm) or not (cold). We classify bursts as "cached (warm)" when their
// processing throughput is anomalously high relative to this session's own
// observed COLD median — cache hits skip actual compute for the reused
// prefix, so they're typically 5-50x faster than a genuine cold prefill on
// the same hardware. This is a heuristic, not a certainty from the protocol.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import * as http from 'http'
import { BrowserWindow, ipcMain, dialog } from 'electron'

export interface PerfGenPoint { ts: number; contextTokens: number; genTps: number }
export interface PerfPrefillPoint { ts: number; promptSize: number; promptTps: number; cached: boolean }
export interface PerfSessionMeta {
  id: string
  templateId: string
  templateNameSnapshot: string
  startedAt: number
  endedAt: number | null
}
export interface PerfSessionData extends PerfSessionMeta {
  genPoints: PerfGenPoint[]
  prefillPoints: PerfPrefillPoint[]
}

const POLL_INTERVAL_MS = 2000

let SESSIONS_DIR = ''
let INDEX_PATH = ''
let getLiveTemplateName: (templateId: string) => string | undefined = () => undefined
let getMaxSessions: () => number = () => 20

// Active (currently running) sessions, keyed by templateId.
const active = new Map<string, {
  session: PerfSessionData
  port: number
  timer: NodeJS.Timeout
  // Last raw counters read from /metrics, for delta computation.
  lastPromptTokens: number
  lastPromptSeconds: number
  lastPredTokens: number
  lastPredSeconds: number
  // Rolling median of COLD prefill throughput (tok/s) observed this
  // session, used as the baseline for the cached-vs-cold heuristic above.
  coldThroughputSamples: number[]
}>

function broadcast(channel: string, payload: any) {
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  })
}

function loadIndex(): PerfSessionMeta[] {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, 'utf-8'))
  } catch {}
  return []
}
function saveIndex(list: PerfSessionMeta[]) {
  try { writeFileSync(INDEX_PATH, JSON.stringify(list, null, 2)) } catch {}
}
function sessionFilePath(id: string) {
  return join(SESSIONS_DIR, `${id}.json`)
}
function saveSessionToDisk(session: PerfSessionData) {
  try { writeFileSync(sessionFilePath(session.id), JSON.stringify(session, null, 2)) } catch {}
}
function pruneHistory() {
  const max = Math.max(1, getMaxSessions())
  let index = loadIndex()
  // Oldest first by startedAt.
  index.sort((a, b) => a.startedAt - b.startedAt)
  while (index.length > max) {
    const removed = index.shift()
    if (removed) { try { unlinkSync(sessionFilePath(removed.id)) } catch {} }
  }
  saveIndex(index)
}

function parsePrometheusMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    // Format: metric_name{labels} value  OR  metric_name value
    const m = trimmed.match(/^([a-zA-Z0-9_:]+)(?:\{[^}]*\})?\s+([-\d.eE+]+)/)
    if (m) {
      const val = parseFloat(m[2])
      if (!isNaN(val)) out[m[1]] = val
    }
  }
  return out
}

function fetchMetrics(port: number): Promise<Record<string, number> | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/metrics', timeout: 3000 }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(null); return }
        resolve(parsePrometheusMetrics(data))
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
}

function poll(templateId: string) {
  const entry = active.get(templateId)
  if (!entry) return
  fetchMetrics(entry.port).then((m) => {
    if (!m) return
    const stillActive = active.get(templateId)
    if (!stillActive) return  // stopped mid-flight

    const promptTokens = m['llamacpp:prompt_tokens_total'] ?? stillActive.lastPromptTokens
    const promptSeconds = m['llamacpp:prompt_seconds_total'] ?? stillActive.lastPromptSeconds
    const predTokens = m['llamacpp:tokens_predicted_total'] ?? stillActive.lastPredTokens
    const predSeconds = m['llamacpp:tokens_predicted_seconds_total'] ?? stillActive.lastPredSeconds
    const now = Date.now()

    // Generation-speed data point: fires whenever new tokens were predicted
    // since the last poll.
    const dPredTokens = predTokens - stillActive.lastPredTokens
    const dPredSeconds = predSeconds - stillActive.lastPredSeconds
    if (dPredTokens > 0 && dPredSeconds > 0) {
      const genTps = dPredTokens / dPredSeconds
      const contextTokens = Math.round(promptTokens + predTokens)
      const point: PerfGenPoint = { ts: now, contextTokens, genTps: Math.round(genTps * 100) / 100 }
      stillActive.session.genPoints.push(point)
      broadcast('perf-data-point', { templateId, type: 'gen', point })
    }

    // Prefill-speed data point: fires whenever new prompt tokens were
    // processed since the last poll.
    const dPromptTokens = promptTokens - stillActive.lastPromptTokens
    const dPromptSeconds = promptSeconds - stillActive.lastPromptSeconds
    if (dPromptTokens > 0 && dPromptSeconds > 0) {
      const promptTps = dPromptTokens / dPromptSeconds
      // Heuristic cold/warm classification — see module header comment.
      // With very few samples, a single noisy early poll becomes
      // the "median" outright, and normal poll-to-poll timing variance can
      // easily look like a big jump — spuriously flagging an otherwise
      // perfectly normal COLD burst as "cached". Require a minimum number
      // of genuine cold samples before ever classifying anything as cached,
      // so early-session noise can't trigger a false positive.
      //
      // The original 4x threshold turned out to never
      // fire in practice. A real cache hit only skips compute for the
      // REUSED prefix — a typical chat turn reuses most of the previous
      // context but still has to cold-process the new user message, so the
      // BLENDED throughput for that request is nowhere near 4x faster than
      // pure-cold, even though a meaningful chunk of it genuinely was
      // cached. Lowered to a more realistic 2x, which is still comfortably
      // above normal poll-to-poll variance but low enough to actually catch
      // partial-cache-hit turns.
      const MIN_COLD_SAMPLES_BEFORE_CLASSIFYING = 3
      const CACHE_HIT_THRESHOLD_MULTIPLIER = 2
      const coldSamples = stillActive.coldThroughputSamples
      const coldMedian = coldSamples.length >= MIN_COLD_SAMPLES_BEFORE_CLASSIFYING
        ? [...coldSamples].sort((a, b) => a - b)[Math.floor(coldSamples.length / 2)]
        : null
      const cached = coldMedian !== null && promptTps > coldMedian * CACHE_HIT_THRESHOLD_MULTIPLIER
      if (!cached) {
        coldSamples.push(promptTps)
        if (coldSamples.length > 20) coldSamples.shift()
      }
      const point: PerfPrefillPoint = {
        ts: now, promptSize: Math.round(dPromptTokens),
        promptTps: Math.round(promptTps * 100) / 100, cached
      }
      stillActive.session.prefillPoints.push(point)
      broadcast('perf-data-point', { templateId, type: 'prefill', point })
    }

    stillActive.lastPromptTokens = promptTokens
    stillActive.lastPromptSeconds = promptSeconds
    stillActive.lastPredTokens = predTokens
    stillActive.lastPredSeconds = predSeconds

    // Periodically persist so a crash/force-quit doesn't lose the whole session.
    saveSessionToDisk(stillActive.session)
  }).catch(() => {})
}

export function initPerfMonitor(appRoot: string, opts: {
  getLiveTemplateName: (templateId: string) => string | undefined
  getMaxSessions: () => number
}) {
  SESSIONS_DIR = join(appRoot, 'perf-sessions')
  INDEX_PATH = join(SESSIONS_DIR, 'index.json')
  getLiveTemplateName = opts.getLiveTemplateName
  getMaxSessions = opts.getMaxSessions
  if (!existsSync(SESSIONS_DIR)) { try { mkdirSync(SESSIONS_DIR, { recursive: true }) } catch {} }
}

export function startTracking(templateId: string, port: number, templateName: string) {
  if (active.has(templateId)) stopTracking(templateId)  // shouldn't happen, but stay safe
  const session: PerfSessionData = {
    id: randomUUID(),
    templateId,
    templateNameSnapshot: templateName,
    startedAt: Date.now(),
    endedAt: null,
    genPoints: [],
    prefillPoints: []
  }
  const timer = setInterval(() => poll(templateId), POLL_INTERVAL_MS)
  active.set(templateId, {
    session, port, timer,
    lastPromptTokens: 0, lastPromptSeconds: 0, lastPredTokens: 0, lastPredSeconds: 0,
    coldThroughputSamples: []
  })
  broadcast('perf-session-started', { templateId, sessionId: session.id, startedAt: session.startedAt })
}

export function stopTracking(templateId: string) {
  const entry = active.get(templateId)
  if (!entry) return
  clearInterval(entry.timer)
  active.delete(templateId)
  entry.session.endedAt = Date.now()
  // Bug fix pattern (item 3/4's "dynamically change if template name
  // changes"): snapshot the CURRENT live name (not whatever it was at
  // startTracking time) when the session actually ends and gets archived,
  // so a rename mid-session is reflected in the persisted history entry.
  const liveName = getLiveTemplateName(templateId)
  if (liveName) entry.session.templateNameSnapshot = liveName
  saveSessionToDisk(entry.session)
  const index = loadIndex()
  index.push({
    id: entry.session.id, templateId: entry.session.templateId,
    templateNameSnapshot: entry.session.templateNameSnapshot,
    startedAt: entry.session.startedAt, endedAt: entry.session.endedAt
  })
  saveIndex(index)
  pruneHistory()
  broadcast('perf-session-ended', { templateId, sessionId: entry.session.id })
}

export function getActiveSessionsList(): { sessionId: string; templateId: string; templateName: string; startedAt: number }[] {
  return Array.from(active.entries()).map(([templateId, e]) => ({
    sessionId: e.session.id,
    templateId,
    // Live name lookup — see item 3/4's "dynamically reflect renames" requirement.
    templateName: getLiveTemplateName(templateId) || e.session.templateNameSnapshot,
    startedAt: e.session.startedAt
  }))
}

export function getActiveSessionData(templateId: string): PerfSessionData | null {
  const entry = active.get(templateId)
  if (!entry) return null
  return {
    ...entry.session,
    templateNameSnapshot: getLiveTemplateName(templateId) || entry.session.templateNameSnapshot
  }
}

export function registerPerfHandlers() {
  ipcMain.handle('perf-get-active-sessions', async () => getActiveSessionsList())

  ipcMain.handle('perf-get-active-session-data', async (_e, templateId: string) => getActiveSessionData(templateId))

  ipcMain.handle('perf-get-session-history', async () => {
    const index = loadIndex()
    index.sort((a, b) => b.startedAt - a.startedAt)  // newest first
    return index
  })

  ipcMain.handle('perf-get-session-data', async (_e, sessionId: string) => {
    try {
      const path = sessionFilePath(sessionId)
      if (!existsSync(path)) return null
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch { return null }
  })

  ipcMain.handle('perf-get-max-sessions', async () => getMaxSessions())
  ipcMain.handle('perf-set-max-sessions', async (_e, _n: number) => {
    // The caller (renderer, via modelDefaults) owns persisting the number
    // itself — this handler just triggers an immediate prune against
    // whatever getMaxSessions() now returns, so lowering the limit takes
    // effect right away instead of waiting for the next session to end.
    pruneHistory()
    return { success: true }
  })

  ipcMain.handle('perf-export-session', async (_e, sessionId: string) => {
    try {
      const path = sessionFilePath(sessionId)
      if (!existsSync(path)) return { success: false, error: 'Session not found' }
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      const win = BrowserWindow.getFocusedWindow()
      const defaultName = `${(data.templateNameSnapshot || 'session').replace(/[^\w.-]+/g, '_')}-${new Date(data.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] })
        : await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (result.canceled || !result.filePath) return { success: false, canceled: true }
      writeFileSync(result.filePath, JSON.stringify(data, null, 2))
      return { success: true, path: result.filePath }
    } catch (e: any) { return { success: false, error: String(e) } }
  })

  ipcMain.handle('perf-export-all-active', async () => {
    try {
      const sessions = Array.from(active.values()).map(e => ({
        ...e.session,
        templateNameSnapshot: getLiveTemplateName(e.session.templateId) || e.session.templateNameSnapshot
      }))
      if (sessions.length === 0) return { success: false, error: 'No active sessions' }
      const win = BrowserWindow.getFocusedWindow()
      const defaultName = `active-sessions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      const result = win
        ? await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] })
        : await dialog.showSaveDialog({ defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (result.canceled || !result.filePath) return { success: false, canceled: true }
      writeFileSync(result.filePath, JSON.stringify({ sessions }, null, 2))
      return { success: true, path: result.filePath }
    } catch (e: any) { return { success: false, error: String(e) } }
  })

  ipcMain.handle('perf-import-session', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      const result = win
        ? await dialog.showOpenDialog(win, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
        : await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
      if (result.canceled || !result.filePaths[0]) return { success: false, canceled: true }
      const raw = JSON.parse(readFileSync(result.filePaths[0], 'utf-8'))
      const toImport: PerfSessionData[] = Array.isArray(raw?.sessions) ? raw.sessions : [raw]
      let imported = 0
      for (const s of toImport) {
        if (!s || !s.genPoints) continue
        const id = s.id || randomUUID()
        const sessionToSave: PerfSessionData = { ...s, id }
        saveSessionToDisk(sessionToSave)
        const index = loadIndex()
        if (!index.some(x => x.id === id)) {
          index.push({ id, templateId: s.templateId || 'imported', templateNameSnapshot: s.templateNameSnapshot || 'Imported session', startedAt: s.startedAt || Date.now(), endedAt: s.endedAt || Date.now() })
          saveIndex(index)
        }
        imported++
      }
      pruneHistory()
      return { success: true, imported }
    } catch (e: any) { return { success: false, error: String(e) } }
  })
}

// Called from ipc.ts when the app is quitting, to stop timers cleanly.
export function stopAllTracking() {
  for (const templateId of Array.from(active.keys())) stopTracking(templateId)
}

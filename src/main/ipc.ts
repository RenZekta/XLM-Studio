import { ipcMain, dialog, shell, BrowserWindow, nativeTheme } from 'electron'
import {
  existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync,
  unlinkSync, createWriteStream, statSync, rmdirSync, renameSync, promises as fsPromises
} from 'fs'
import { join, extname, basename, dirname, resolve } from 'path'
import { spawn, ChildProcess, exec } from 'child_process'
import https from 'https'
import http from 'http'
import { app } from 'electron'
import extract from 'extract-zip'
import net from 'net'
import type {
  ModelGroup, ModelEntry, MmprojFile, SpecDecodeSidecarFile, BackendVersion,
  CommandsSchema, TrackedBackend, TrackedBackendRelease,
  ThemePref, ReleaseInfo, BaseUrlOverride
} from '../shared/types'
import { initPerfMonitor, registerPerfHandlers, startTracking, stopTracking, stopAllTracking } from './perfMonitor'

const APP_ROOT = app.isPackaged ? join(app.getPath('userData')) : join(process.cwd())
const MODELS_DIR    = join(APP_ROOT, 'models')
const TEMPLATES_DIR = join(APP_ROOT, 'templates')
const BACKEND_DIR   = join(APP_ROOT, 'backend')
const SETTINGS_PATH = join(APP_ROOT, 'settings.json')
// Task 1: persisted GGUF metadata cache so metadata is available instantly
// whenever the user accesses a model (no re-extraction on every view).
const METADATA_CACHE_PATH = join(APP_ROOT, 'metadata-cache.json')
// Bug fix (Task 1.2 / KV overshoot): the cache is disk-persisted with NO
// schema check, so entries written before a metadata field was added (e.g.
// `fullAttentionInterval`, added for hybrid SSM/attention models like
// Qwen3.5/3.6/Next) get served forever as-is — the field is simply absent
// (undefined), every KV-cache formula's `|| 1` fallback silently kicks in,
// and the "divide by full_attention_interval" fix has no visible effect for
// any model that was already scanned before the fix shipped. Bump this
// whenever a field is added to the extracted metadata shape, and the cache
// read below will treat mismatched/missing-version entries as stale and
// transparently re-extract instead of serving the incomplete old object.
const METADATA_SCHEMA_VERSION = 5
for (const dir of [MODELS_DIR, TEMPLATES_DIR, BACKEND_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// --------------------------------------------------------------------------
// Task 1: GGUF metadata cache (load/save + in-memory mirror)
// --------------------------------------------------------------------------
// The cache is keyed by absolute model file path. On `list-models`, we diff the
// set of currently-detected model files against the cache: extract metadata for
// any new files (fire-and-forget), and delete entries for files that no longer
// exist. This way the metadata is always ready when the user opens a template.
let metadataCache: Record<string, any> = {}
function loadMetadataCache(): void {
  try {
    if (existsSync(METADATA_CACHE_PATH)) {
      metadataCache = JSON.parse(readFileSync(METADATA_CACHE_PATH, 'utf-8'))
      if (!metadataCache || typeof metadataCache !== 'object' || Array.isArray(metadataCache)) metadataCache = {}
    }
  } catch { metadataCache = {} }
}
function saveMetadataCache(): void {
  try { writeFileSync(METADATA_CACHE_PATH, JSON.stringify(metadataCache, null, 2)) } catch {}
}
loadMetadataCache()

// --------------------------------------------------------------------------
// Tracked backends — built-in defaults
// --------------------------------------------------------------------------
const DEFAULT_TRACKED: TrackedBackend[] = [
  {
    id: 'llama-cpp',
    repo: 'ggml-org/llama.cpp',
    name: 'llama.cpp',
    folderName: 'llama.cpp',
    isDefault: true
  },
  {
    id: 'atomic-llama-cpp-turboquant',
    repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
    name: 'atomic-llama-cpp-turboquant',
    folderName: 'atomic-llama-cpp-turboquant',
    isDefault: true,
    // TurboQuant fork exposes additional KV cache quantization types.
    defaultOptions: {
      '--cache-type-k': ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'turbo2', 'turbo3', 'turbo4'],
      '--cache-type-v': ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1', 'turbo2', 'turbo3', 'turbo4']
    }
  }
]

// --------------------------------------------------------------------------
// Settings persistence
// --------------------------------------------------------------------------
interface AppSettings {
  externalModelFolders: string[]
  externalBackendFolders: string[]
  mainModelFolder: string | null
  mainBackendFolder: string | null
  theme: ThemePref
  trackedBackends: TrackedBackend[]
  modelDefaults?: { autoFitEnabled: boolean; autoFitContextLength: number; guardrailMode: string; customMaxSizeGB: number; useCurrentMemState?: boolean; moeOffloadStrategy?: 'offload' | 'max'; autoFitUse2xIncrements?: boolean; autoFitYarnAutoScale?: boolean; autoEnableMmproj?: boolean; cpuThreadsOverrideEnabled?: boolean; cpuThreadsOverridePercent?: number; parallelOverrideEnabled?: boolean; parallelInferenceMode?: 'unified' | 'separate'; parallelOverrideValue?: number; parallelOverrideValueDense?: number; parallelOverrideValueMoe?: number; perfMaxSessions?: number }
  baseUrlOverride?: BaseUrlOverride
  samplingPresets?: any[]
  starredPresetId?: string
}

// Default Base URL Override: enabled by default, port 1234, no LAN, no API key.
// The override URL is always http://localhost:<port>/v1.
const DEFAULT_BASE_URL_OVERRIDE: BaseUrlOverride = {
  enabled: true,
  port: 1234,
  serveOnLocalNetwork: false,
  apiKeyEnabled: false,
  apiKey: ''
}

// Migrate a (possibly legacy) baseUrlOverride object to the new schema.
// Legacy format: { enabled: boolean, url: string }
// New format:     { enabled, port, serveOnLocalNetwork, apiKeyEnabled, apiKey }
//
// The override is now ON by default (the user requested this). Legacy users
// who had the old default (enabled=false) are migrated to enabled=true so they
// pick up the new default behaviour. Users on the new format keep their
// explicit enabled choice.
function migrateBaseUrlOverride(raw: any): BaseUrlOverride {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BASE_URL_OVERRIDE }
  // Legacy: had a `url` field instead of `port`.
  if (raw.port === undefined && raw.url !== undefined) {
    let port = DEFAULT_BASE_URL_OVERRIDE.port
    try {
      const u = new URL(raw.url)
      if (u.port) {
        const p = parseInt(u.port, 10)
        if (p > 0 && p < 65536) port = p
      }
    } catch {}
    return {
      enabled: true,  // new default: ON for legacy migrations
      port,
      serveOnLocalNetwork: raw.serveOnLocalNetwork ?? false,
      apiKeyEnabled: raw.apiKeyEnabled ?? false,
      apiKey: raw.apiKey ?? ''
    }
  }
  return {
    enabled: raw.enabled ?? DEFAULT_BASE_URL_OVERRIDE.enabled,
    port: Math.max(1, Math.min(65535, Number(raw.port) || DEFAULT_BASE_URL_OVERRIDE.port)),
    serveOnLocalNetwork: !!raw.serveOnLocalNetwork,
    apiKeyEnabled: !!raw.apiKeyEnabled,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : ''
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  externalModelFolders: [],
  externalBackendFolders: [],
  mainModelFolder: null,
  mainBackendFolder: null,
  theme: 'system',
  trackedBackends: DEFAULT_TRACKED,
  modelDefaults: { autoFitEnabled: true, autoFitContextLength: 60000, guardrailMode: 'strict', customMaxSizeGB: 0, useCurrentMemState: false, moeOffloadStrategy: 'max' /* item 6: default to MAX+ForceMoEtoCPU */, autoFitUse2xIncrements: false, autoFitYarnAutoScale: false, autoEnableMmproj: true, cpuThreadsOverrideEnabled: false, cpuThreadsOverridePercent: 100, parallelOverrideEnabled: false, parallelInferenceMode: 'unified', parallelOverrideValue: 4, parallelOverrideValueDense: 4, parallelOverrideValueMoe: 4, perfMaxSessions: 20 },
  baseUrlOverride: { ...DEFAULT_BASE_URL_OVERRIDE },
  samplingPresets: [],
  starredPresetId: 'lm-studio'
}

async function loadSettings(): Promise<AppSettings> {
  try {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS }
    const data = JSON.parse(await fsPromises.readFile(SETTINGS_PATH, 'utf-8'))
    // Merge with defaults so new fields are always present.
    const tracked = Array.isArray(data.trackedBackends) && data.trackedBackends.length > 0
      ? data.trackedBackends
      : DEFAULT_TRACKED
    // Ensure the two built-in tracked backends always exist (even if user removed others).
    for (const def of DEFAULT_TRACKED) {
      if (!tracked.find((t: TrackedBackend) => t.id === def.id)) tracked.push(def)
    }
    return {
      externalModelFolders: Array.isArray(data.externalModelFolders) ? data.externalModelFolders : [],
      externalBackendFolders: Array.isArray(data.externalBackendFolders) ? data.externalBackendFolders : [],
      mainModelFolder: typeof data.mainModelFolder === 'string' ? data.mainModelFolder : null,
      mainBackendFolder: typeof data.mainBackendFolder === 'string' ? data.mainBackendFolder : null,
      theme: (['system', 'dark', 'light'].includes(data.theme) ? data.theme : 'system') as ThemePref,
      trackedBackends: tracked,
      modelDefaults: {
        autoFitEnabled: data.modelDefaults?.autoFitEnabled ?? DEFAULT_SETTINGS.modelDefaults!.autoFitEnabled,
        autoFitContextLength: data.modelDefaults?.autoFitContextLength ?? DEFAULT_SETTINGS.modelDefaults!.autoFitContextLength,
        guardrailMode: data.modelDefaults?.guardrailMode ?? DEFAULT_SETTINGS.modelDefaults!.guardrailMode,
        customMaxSizeGB: data.modelDefaults?.customMaxSizeGB ?? DEFAULT_SETTINGS.modelDefaults!.customMaxSizeGB,
        useCurrentMemState: data.modelDefaults?.useCurrentMemState ?? false,
        // Item 6: fixed to match the same "respect saved value, else use the
        // CURRENT default" pattern as every other field here. It previously
        // hardcoded 'offload' as the fallback regardless of DEFAULT_SETTINGS,
        // so bumping the default above would never actually reach anyone with
        // an existing settings.json (i.e. everyone but a fresh install).
        moeOffloadStrategy: (data.modelDefaults?.moeOffloadStrategy === 'offload' || data.modelDefaults?.moeOffloadStrategy === 'max')
          ? data.modelDefaults.moeOffloadStrategy
          : DEFAULT_SETTINGS.modelDefaults!.moeOffloadStrategy,
        // Item 5/8: 2x-increment context-slider lock + YaRN auto-scaling override.
        autoFitUse2xIncrements: data.modelDefaults?.autoFitUse2xIncrements ?? false,
        autoFitYarnAutoScale: data.modelDefaults?.autoFitYarnAutoScale ?? false,
        // New Settings toggle: "Enable Multimodal Projector automatically in
        // new Template if mmproj was detected" — ON by default.
        autoEnableMmproj: data.modelDefaults?.autoEnableMmproj ?? true,
        // New: "Recommended CPU Threads override" — off by default (uses the
        // built-in 75%-of-physical-cores default), value 100% when enabled.
        cpuThreadsOverrideEnabled: data.modelDefaults?.cpuThreadsOverrideEnabled ?? false,
        cpuThreadsOverridePercent: data.modelDefaults?.cpuThreadsOverridePercent ?? 100,
        // New: Overrides tab → "Parallel Inference" block.
        parallelOverrideEnabled: data.modelDefaults?.parallelOverrideEnabled ?? false,
        parallelInferenceMode: (data.modelDefaults?.parallelInferenceMode === 'separate') ? 'separate' : 'unified',
        parallelOverrideValue: data.modelDefaults?.parallelOverrideValue ?? 4,
        parallelOverrideValueDense: data.modelDefaults?.parallelOverrideValueDense ?? 4,
        parallelOverrideValueMoe: data.modelDefaults?.parallelOverrideValueMoe ?? 4,
        perfMaxSessions: data.modelDefaults?.perfMaxSessions ?? 20
      },
      baseUrlOverride: migrateBaseUrlOverride(data.baseUrlOverride),
      samplingPresets: Array.isArray(data.samplingPresets) ? data.samplingPresets : [],
      starredPresetId: typeof data.starredPresetId === 'string' ? data.starredPresetId : 'lm-studio'
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}
async function saveSettings(s: AppSettings): Promise<void> {
  await fsPromises.writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2))
}

function isSafePath(base: string, target: string): boolean {
  return resolve(target).startsWith(resolve(base))
}

// Resolve the effective "main" model folder (starred external folder, else default).
async function resolveMainModelFolder(): Promise<string> {
  const s = await loadSettings()
  if (s.mainModelFolder && existsSync(s.mainModelFolder)) return s.mainModelFolder
  return MODELS_DIR
}
async function resolveMainBackendFolder(): Promise<string> {
  const s = await loadSettings()
  if (s.mainBackendFolder && existsSync(s.mainBackendFolder)) return s.mainBackendFolder
  return BACKEND_DIR
}

// All backend roots to scan: default BACKEND_DIR + external backend folders.
async function backendRoots(): Promise<{ dir: string; external: boolean }[]> {
  const s = await loadSettings()
  const roots: { dir: string; external: boolean }[] = [{ dir: BACKEND_DIR, external: false }]
  for (const f of s.externalBackendFolders) {
    if (existsSync(f)) roots.push({ dir: f, external: true })
  }
  return roots
}

const runningProcesses = new Map<string, { proc: ChildProcess; port: number }>
let sharedChatWindow: BrowserWindow | null = null

// Per-model flags so we only emit each "important" app-log event once per run.
const serverReadyFlags = new Map<string, boolean>()
const modelLoadingFlags = new Map<string, boolean>()

// Feature (logs): emit an app-level meta log into the same `server-log` stream
// consumed by the Logs view. These appear with a left blue bar + faint tint so
// the user can spot lifecycle / generation / chat / error events at a glance,
// on top of the raw llama-server stdout/stderr.
function emitAppLog(id: string, name: string, line: string): void {
  const ts = Date.now()
  BrowserWindow.getAllWindows().forEach(win => {
    if (!win.isDestroyed()) {
      win.webContents.send('server-log', { id, name, stream: 'app', line, ts })
    }
  })
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') resolve(false)
      else resolve(true)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

// ---------------------------------------------------------------------------
// Robust process termination (feature: stop/start race fix)
// ---------------------------------------------------------------------------
// Problem: `proc.kill()` (SIGTERM) returns immediately but the OS takes a
// moment to actually tear down the process and release its listening socket.
// On Windows, SIGTERM is not supported and Node falls back to TerminateProcess
// on the *parent* only — child processes spawned by llama-server keep the
// port alive, so a rapid Stop→Start hits "port already in use" and the only
// recovery is killing XLM Studio from Task Manager.
//
// Solution: terminate the whole process tree (Windows: `taskkill /F /T /PID`,
// POSIX: SIGKILL to the negative group id after detaching into its own group),
// then poll the port until it's free (or a timeout). This makes Stop→Start
// reliable without orphaned children.
function killProcessTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) {
      resolve()
      return
    }
    const pid = proc.pid
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      resolve()
    }
    // Resolve as soon as the process actually exits.
    proc.once('exit', done)

    if (process.platform === 'win32') {
      // /F = force, /T = kill the whole process tree (children included).
      exec(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }, () => {
        // taskkill returns non-zero if the process is already gone — ignore.
        // Give the OS a beat to release the socket.
        setTimeout(done, 200)
      })
    } else {
      try {
        // Try sending SIGKILL to the whole process group first (covers children).
        if (pid) {
          try { process.kill(-pid, 'SIGKILL') } catch { /* group may not exist */ }
          try { proc.kill('SIGKILL') } catch { /* already dead */ }
        }
      } catch {
        try { proc.kill('SIGKILL') } catch {}
      }
      setTimeout(done, 200)
    }
    // Hard safety net so we never hang the IPC handler.
    setTimeout(done, 6000)
  })
}

// Poll a port until it's free (or the timeout elapses). llama-server releases
// the listening socket shortly after the process exits, but not instantly —
// this is the key to making rapid Stop→Start work.
async function waitForPortFree(port: number, timeoutMs = 8000, intervalMs = 100): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortAvailable(port)) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

// --------------------------------------------------------------------------
// Model helpers — smart grouping (LM Studio style)
// --------------------------------------------------------------------------
const MODEL_EXTS = ['.gguf', '.bin', '.ggml']
const MMPROJ_REGEX = /mmproj/i

// Item 2 (Speculative Decoding rework): the full tier system, per the user's
// comparison table. Higher tier = better/newer method, and a higher tier
// always wins when multiple are detected (T5 > T1, T2 > T1, etc.) — see
// classifySpecTier's ordering below, which checks the highest tiers FIRST so
// a compound filename like "Qwen-DFlash2-mtp-draft.gguf" (containing both a
// T5 and a T2 signal) is correctly classified as T5, not accidentally
// matched by the more generic "draft"/"mtp" substring first.
export type SpecMethod = 'off' | 'native-mtp' | 'draft-model' | 'eagle3' | 'dspark2' | 'dflash2'
export interface SpecTierDef { tier: number; method: SpecMethod; label: string; flag: string | null; draftMax: number; draftMin: number; draftPMin: number }
export const SPEC_TIER_DEFS: SpecTierDef[] = [
  { tier: 0, method: 'off', label: 'Off', flag: null, draftMax: 0, draftMin: 0, draftPMin: 0 },
  { tier: 1, method: 'native-mtp', label: 'Native MTP', flag: 'draft-mtp', draftMax: 3, draftMin: 0, draftPMin: 0.75 },
  { tier: 2, method: 'draft-model', label: 'Draft Model', flag: 'draft-simple', draftMax: 5, draftMin: 0, draftPMin: 0.00 },
  { tier: 3, method: 'eagle3', label: 'EAGLE3', flag: 'draft-eagle3', draftMax: 4, draftMin: 0, draftPMin: 0.50 },
  { tier: 4, method: 'dspark2', label: 'DSpark2', flag: 'draft-dspark', draftMax: 6, draftMin: 0, draftPMin: 0.75 },
  { tier: 5, method: 'dflash2', label: 'DFlash2', flag: 'draft-dflash', draftMax: 5, draftMin: 0, draftPMin: 0.80 }
]

// Classify a SIDECAR filename by its highest-tier keyword match. Checked in
// descending tier order (5 down to 2) so a compound name matches its
// highest-tier signal first, per the user's explicit example.
function classifySidecarFilename(name: string): SpecTierDef | null {
  const lower = name.toLowerCase()
  if (/dflash2|dflash/.test(lower)) return SPEC_TIER_DEFS[5]
  if (/dspark2|dspark/.test(lower)) return SPEC_TIER_DEFS[4]
  if (/eagle/.test(lower)) return SPEC_TIER_DEFS[3]
  if (/draft|mtp/.test(lower)) return SPEC_TIER_DEFS[2]
  return null
}
// Bug fix (item 3): a filename keyword match alone isn't enough — a genuine
// full-size model can legitimately have "MTP" in its OWN name to advertise
// that it has a built-in Native MTP head (e.g. "Qwen3.6-35B-A3B-MTP.gguf"),
// and without a size check that model would get misclassified as a T2
// "Draft Model" SIDECAR for every other model in the same folder. Real
// sidecar draft/speculative heads are lightweight — a small fraction of a
// base model's size — so only trust the filename match when the file is
// also small enough to plausibly BE a sidecar, not a full model.
const SIDECAR_MAX_SIZE_MB = 4096  // 4 GB — generous upper bound for a draft/speculative head
function isSpecDecodeSidecarFile(name: string, sizeBytes: number): boolean {
  const lower = name.toLowerCase()
  if (!MODEL_EXTS.includes(extname(lower))) return false
  if (classifySidecarFilename(name) === null) return false
  return sizeBytes <= SIDECAR_MAX_SIZE_MB * 1024 * 1024
}

// Bug fix (item 3 — false-positive Native MTP detection): the original MTP
// scanner read a fixed N-MB window from the start of the file and searched
// it as raw latin1 text for substrings like "mtp". For any model whose
// metadata+tensor-name section is smaller than that window (the vast
// majority, especially smaller/heavily-quantized ones), most of that window
// is actually raw QUANTIZED TENSOR WEIGHT DATA — high-entropy binary noise,
// not text — and over enough megabytes of it, short substrings like "mtp"
// can and do appear by pure chance, exactly as happened here. The fix is to
// stop guessing a byte window entirely and instead properly parse the GGUF
// binary structure (magic/version/counts, then each metadata KV pair, then
// each tensor's name) — reusing the same well-tested parsing approach as
// the JS-fallback metadata extractor elsewhere in this file — so the search
// text is built ONLY from genuine structural strings (metadata keys,
// string-typed metadata values, and tensor names), and NEVER touches a
// single byte of actual tensor weight data. This can't produce a false
// positive from quantized noise, no matter how large the file is.
// Speculative decoding, Tier 1 (Native MTP): whether the model's own GGUF
// metadata declares an embedded Multi-Token-Prediction head. This is a
// STATIC fact of the model file (metadata doesn't change), so it's detected
// here — as part of the SAME metadata-KV walk get-gguf-metadata already does
// for every other field — and cached right alongside the rest of that
// metadata, rather than via a separate dedicated file scan. The canonical
// signal is the `{arch}.nextn_predict_layers` metadata key (llama.cpp's own
// convention for MTP-capable checkpoints); `multi_token_prediction` is kept
// as a secondary alias some converters use.
function detectHasNativeMtp(metaKv: Record<string, any>): boolean {
  for (const k of Object.keys(metaKv)) {
    if (k.includes('nextn_predict_layers') || k.includes('multi_token_prediction')) {
      const v = metaKv[k]
      if (typeof v === 'number') return v > 0
      if (typeof v === 'boolean') return v
      if (typeof v === 'string') return v !== '0' && v.toLowerCase() !== 'false'
      return true
    }
  }
  return false
}

// Feature 22: substring-based scan — detect "mmproj" ANYWHERE in the filename,
// not just at the beginning. Allows files like "modelname-mmproj-BF16.gguf".
function isMmprojFile(name: string): boolean {
  const lower = name.toLowerCase()
  return MMPROJ_REGEX.test(name) && MODEL_EXTS.includes(extname(lower))
}

function isModelFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tmp')) return false
  // Bug fix (item 3): no longer excludes spec-decode sidecars here — that
  // now needs the file's SIZE too (see isSpecDecodeSidecarFile above), which
  // isn't available from a filename alone. scanModelFolder below does the
  // full name+size classification itself.
  return MODEL_EXTS.includes(extname(lower)) && !isMmprojFile(lower)
}

// Scan a single folder (non-recursive): collect model files + mmproj file +
// speculative-decoding sidecar files.
async function scanModelFolder(folderPath: string, external: boolean): Promise<ModelGroup | null> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fsPromises.readdir(folderPath, { withFileTypes: true })
  } catch {
    return null
  }
  const models: ModelEntry[] = []
  let mmproj: MmprojFile | null = null
  // Item 2/3: sidecar speculative-decoding files — kept SEPARATE from
  // `models` (so the Template Model File dropdown never shows them, per
  // item 4) but still returned to the renderer (so the Models tab CAN show
  // them, non-interactively, inside their folder — same treatment as
  // mmproj, per item 2).
  const specDecodeSidecars: SpecDecodeSidecarFile[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (isMmprojFile(e.name)) {
      try {
        const st = await fsPromises.stat(join(folderPath, e.name))
        // If multiple mmproj files exist, keep the first one.
        if (!mmproj) mmproj = { name: e.name, path: join(folderPath, e.name), size: st.size }
      } catch {}
      continue
    }
    if (!isModelFile(e.name)) continue
    try {
      const st = await fsPromises.stat(join(folderPath, e.name))
      const tierDef = classifySidecarFilename(e.name)
      if (tierDef && isSpecDecodeSidecarFile(e.name, st.size)) {
        specDecodeSidecars.push({ name: e.name, path: join(folderPath, e.name), size: st.size, tier: tierDef.tier, method: tierDef.method, label: tierDef.label })
      } else {
        models.push({ name: e.name, path: join(folderPath, e.name), size: st.size })
      }
    } catch {}
  }
  if (models.length === 0 && !mmproj && specDecodeSidecars.length === 0) return null
  const modelSize = models.reduce((a, m) => a + m.size, 0)
  const mmprojSize = mmproj ? mmproj.size : 0
  return {
    folder: basename(folderPath),
    folderPath,
    external,
    models,
    mmproj,
    specDecodeSidecars,
    totalSize: modelSize + mmprojSize,
    modelSize
  }
}

// Scan a model root recursively: a root contains model folders, each folder is a group.
// Mirrors the LM-Studio layout described in the spec:
//   StorageFolder / ModelFolder / model.gguf (+ mmproj.gguf)
async function scanModelRoot(rootDir: string, rootExternal: boolean): Promise<ModelGroup[]> {
  const groups: ModelGroup[] = []
  let topEntries: import('fs').Dirent[]
  try {
    topEntries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return groups
  }
  for (const e of topEntries) {
    if (e.isDirectory()) {
      const subPath = join(rootDir, e.name)
      const g = await scanModelFolder(subPath, rootExternal)
      if (g) groups.push(g)
    } else if (isModelFile(e.name)) {
      // Loose model file at the root of the storage folder — wrap it as its own group
      // using the storage folder name, so it still appears in the list.
      try {
        const st = await fsPromises.stat(join(rootDir, e.name))
        const tierDef = classifySidecarFilename(e.name)
        const isSidecar = tierDef && isSpecDecodeSidecarFile(e.name, st.size)
        groups.push({
          folder: basename(rootDir),
          folderPath: rootDir,
          external: rootExternal,
          models: isSidecar ? [] : [{ name: e.name, path: join(rootDir, e.name), size: st.size }],
          mmproj: null,
          specDecodeSidecars: isSidecar && tierDef ? [{ name: e.name, path: join(rootDir, e.name), size: st.size, tier: tierDef.tier, method: tierDef.method, label: tierDef.label }] : [],
          totalSize: st.size,
          modelSize: isSidecar ? 0 : st.size
        })
      } catch {}
    }
  }
  return groups
}

// --------------------------------------------------------------------------
// Backend discovery — resilient deep `build/bin/` search
// --------------------------------------------------------------------------
const SERVER_NAMES = process.platform === 'win32'
  ? ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server']
  : ['llama-server', 'main', 'server']

// Sibling files that indicate a real backend directory (not a stray copy).
const SIBLING_HINTS = ['ggml.dll', 'llama.dll', 'ggml-metal.dll', 'llama-server.exe', 'llama-server', 'main.exe', 'main']

// llama-gguf binary names (for native metadata extraction).
const GGUF_TOOL_NAMES = process.platform === 'win32'
  ? ['llama-gguf.exe', 'llama-gguf', 'gguf.exe', 'gguf']
  : ['llama-gguf', 'gguf']

interface DiscoveredExe {
  exeAbs: string   // absolute path to the executable
  dir: string      // directory containing the exe (cwd)
  exeName: string  // just the filename
}

function discoverBackendExe(dir: string, depth = 0, maxDepth = 6): DiscoveredExe | null {
  if (depth > maxDepth) return null
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  // 1. Look for a target binary directly in this directory.
  for (const f of entries) {
    if (f.isFile() && SERVER_NAMES.includes(f.name.toLowerCase())) {
      // Validate: require at least one sibling hint (dll or another known binary).
      const hasSibling = entries.some(s => s.isFile() && s.name !== f.name && SIBLING_HINTS.includes(s.name.toLowerCase()))
      if (hasSibling || depth > 0) {
        return { exeAbs: join(dir, f.name), dir, exeName: f.name }
      }
      // Root-level lone binary still accepted as last resort.
      return { exeAbs: join(dir, f.name), dir, exeName: f.name }
    }
  }
  // 2. Depth-first recursion into subdirectories.
  for (const f of entries) {
    if (f.isDirectory()) {
      const sub = discoverBackendExe(join(dir, f.name), depth + 1, maxDepth)
      if (sub) return sub
    }
  }
  return null
}

// --------------------------------------------------------------------------
// Native GGUF metadata extraction via llama-gguf tool
// --------------------------------------------------------------------------
// Spawns the `llama-gguf` binary (shipped with llama.cpp backends) to dump
// model metadata. This uses the native gguf_init_from_file() C implementation,
// guaranteeing 100% correct parsing for any GGUF file, regardless of version
// or converter quirks.
//
// The tool may be invoked several ways depending on the llama.cpp version:
//   llama-gguf --model <path>              (bare; prints general info)
//   llama-gguf --model <path> --help-model (explicit metadata dump)
//   gguf <path>                             (legacy positional arg)
// We try each in turn and parse whichever produces useful key/value lines.

// Generic recursive search for a named tool binary inside a backend version dir.
// The gguf tool is often nested in build/bin/ (same as llama-server), so a
// flat top-level scan (as used previously) misses it. This walks up to 6 levels.
function discoverToolByName(dir: string, names: string[], depth = 0, maxDepth = 6): string | null {
  if (depth > maxDepth) return null
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const f of entries) {
    if (f.isFile() && names.includes(f.name.toLowerCase())) {
      return join(dir, f.name)
    }
  }
  for (const f of entries) {
    if (f.isDirectory()) {
      const sub = discoverToolByName(join(dir, f.name), names, depth + 1, maxDepth)
      if (sub) return sub
    }
  }
  return null
}

async function findGgufTool(): Promise<string | null> {
  const roots = await backendRoots()
  for (const root of roots) {
    try {
      const topDirs = readdirSync(root.dir, { withFileTypes: true })
      for (const forkDir of topDirs) {
        if (!forkDir.isDirectory()) continue
        let versions: import('fs').Dirent[]
        try {
          versions = readdirSync(join(root.dir, forkDir.name), { withFileTypes: true })
        } catch { continue }
        for (const verDir of versions) {
          if (!verDir.isDirectory()) continue
          const dir = join(root.dir, forkDir.name, verDir.name)
          // Recursive search — finds the tool even when nested in build/bin/.
          const found = discoverToolByName(dir, GGUF_TOOL_NAMES)
          if (found) return found
        }
      }
    } catch {}
  }
  return null
}

// Run the native gguf tool with a given argument set, returning combined stdout.
function runToolArgs(toolPath: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(toolPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: dirname(toolPath),
      windowsHide: true,
      timeout: 15000
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', () => resolve({ stdout: '', stderr: String('spawn error'), code: -1 }))
    child.on('exit', (code) => resolve({ stdout, stderr, code }))
  })
}

// Try several known invocations of the native gguf tool and return the first
// output that looks like metadata (contains a "general.architecture" or
// "llama." / "general." key). This is resilient across llama.cpp versions.
async function runGgufTool(ggufToolPath: string, modelPath: string): Promise<string> {
  const attempts: { label: string; args: string[] }[] = [
    { label: '--help-model', args: ['--model', modelPath, '--help-model'] },
    { label: 'bare',        args: ['--model', modelPath] },
    { label: 'positional',  args: [modelPath] },
    { label: 'info',        args: ['--model', modelPath, '--info'] }
  ]
  for (const a of attempts) {
    const res = await runToolArgs(ggufToolPath, a.args)
    if (!res.stdout) {
      console.log(`[GGUF] llama-gguf (${a.label}) produced no stdout | code=${res.code} stderr=${res.stderr.substring(0, 120)}`)
      continue
    }
    // Accept output if it contains metadata-like keys.
    const lower = res.stdout.toLowerCase()
    if (lower.includes('general.architecture') || lower.includes('general.name') ||
        lower.includes('llama.') || lower.includes('block_count') ||
        lower.includes('context_length') || lower.includes('chat_template')) {
      console.log(`[GGUF] llama-gguf (${a.label}) succeeded — ${res.stdout.length} bytes`)
      return res.stdout
    }
    console.log(`[GGUF] llama-gguf (${a.label}) output didn't look like metadata (${res.stdout.length} bytes)`)
  }
  return ''
}

// ---------------------------------------------------------------------------
// GGUF file_type enum → human-readable quant name (Task 3: BPW math).
// Source: ggml.h GGML_FTYPE values. Used to label the dominant quantization
// and (via the BPW table) to estimate weight bits-per-weight when the exact
// per-tensor census isn't available.
// ---------------------------------------------------------------------------
const GGUF_FTYPE_NAMES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 4: 'Q4_1_SOME_F16',
  7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1', 10: 'Q2_K', 11: 'Q3_K_S',
  12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS',
  20: 'IQ2_XS', 21: 'Q2_K_S', 22: 'IQ3_XS', 23: 'IQ3_XXS',
  24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M',
  32: 'BF16', 33: 'Q4_0_4_4', 34: 'Q4_0_4_8', 35: 'Q4_0_8_8',
  36: 'TQ1_0', 37: 'TQ2_0', 38: 'IQ2_XXS_NL'
}
// Bug fix (item 2, corrected): initial hypothesis was that Unsloth's Dynamic/
// UD-* quants have an internal general.file_type that disagrees with their
// own filename labeling, and that the filename was therefore the more useful
// thing to show. That was WRONG in the way that matters most: llama-server
// itself reads and reports the INTERNAL general.file_type when it loads the
// model — that's the actual ground truth for what's running, not the
// filename. Preferring the filename was actively counterproductive: it made
// our display disagree with llama-server's own logs, which is far more
// confusing than disagreeing with a marketing label on a download page.
// Reverted to prefer the internal metadata value; the filename-derived label
// (when different) is now shown as clearly-labeled supplementary info, not
// used to override the authoritative source.
const FILENAME_QUANT_PATTERN = /(?:^|[-_.])((?:IQ|TQ)[1-4]_[A-Z0-9]+|Q[2-8]_[A-Z0-9]+(?:_[A-Z0-9]+)?|Q[4-8]_[01]|BF16|F16|F32)(?:[-_.]|$)/i
export function parseQuantFromFilename(filePath: string): string | null {
  const base = filePath.split(/[\\/]/).pop() || filePath
  const m = base.match(FILENAME_QUANT_PATTERN)
  if (!m) return null
  // Normalize casing to match GGUF_FTYPE_NAMES convention (e.g. "q3_k_xl" -> "Q3_K_XL").
  return m[1].toUpperCase()
}

function ggufFileTypeName(ftype: number): string | null {
  return GGUF_FTYPE_NAMES[ftype] || null
}

// Approximate bits-per-weight for each GGUF ftype. Used as a fallback for the
// weight-memory (W) estimate when we can't do an exact per-tensor census.
// For KV-cache math we use the explicit KV-type bytes-per-element table in
// useVramBudget.ts. These are conservative (slightly high) averages.
const GGUF_FTYPE_BPW: Record<string, number> = {
  'F32': 32, 'BF16': 16, 'F16': 16,
  'Q8_0': 8.5,
  'Q4_0': 4.5, 'Q4_1': 5.0, 'Q4_1_SOME_F16': 5.5,
  'Q5_0': 5.5, 'Q5_1': 6.0,
  'Q2_K': 2.625, 'Q2_K_S': 2.625,
  'Q3_K_S': 3.0625, 'Q3_K_M': 3.4375, 'Q3_K_L': 3.8125,
  'Q4_K_S': 4.5, 'Q4_K_M': 4.8125,
  'Q5_K_S': 5.5, 'Q5_K_M': 5.6875,
  'Q6_K': 6.5625,
  'IQ2_XXS': 2.0625, 'IQ2_XS': 2.3125, 'IQ2_S': 2.5, 'IQ2_M': 2.6875, 'IQ2_XXS_NL': 2.0625,
  'IQ3_XS': 3.0625, 'IQ3_XXS': 3.0625, 'IQ3_S': 3.125, 'IQ3_M': 3.4375,
  'IQ4_NL': 4.5, 'IQ4_XS': 4.25,
  'IQ1_S': 1.5625, 'IQ1_M': 1.75,
  'TQ1_0': 1.6875, 'TQ2_0': 2.0625,
  'Q4_0_4_4': 4.5, 'Q4_0_4_8': 4.5, 'Q4_0_8_8': 4.5
}
export function ggufFileTypeBPW(name: string): number | null {
  return GGUF_FTYPE_BPW[name] ?? null
}

// Parse the output of `llama-gguf` into a key-value map.
// The tool prints lines in one of these forms (depending on version):
//   key: value
//   key = value
//   * key: value        (bullet prefix)
//   - key = value       (dash prefix)
// Some versions also print the value wrapped in quotes; we strip them.
function parseGgufToolOutput(output: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const line of output.split('\n')) {
    // Strip leading bullet/dash markers and whitespace.
    const trimmed = line.trim().replace(/^[-*•·]+\s*/, '')
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('=')) continue
    // Try "key: value" or "key = value" (whichever separator appears first).
    const colonIdx = trimmed.indexOf(':')
    const eqIdx = trimmed.indexOf('=')
    let sep = -1
    if (colonIdx > 0 && (eqIdx < 0 || colonIdx < eqIdx)) sep = colonIdx
    else if (eqIdx > 0) sep = eqIdx
    if (sep > 0) {
      const key = trimmed.substring(0, sep).trim().toLowerCase()
      let val = trimmed.substring(sep + 1).trim()
      // Strip surrounding quotes from string values.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      // Only keep printable, non-empty scalar values (skip array/struct dumps).
      if (key && val && !val.startsWith('[') && val.length < 100000) map[key] = val
    }
  }
  return map
}

// Scan a backend root for installed backend versions.
// A backend root contains <backendKey>/<version>/...exe (fork-aware layout),
// but we also tolerate the legacy flat layout <version>/...exe.
//
// FIX (version display): Previously the legacy check used
// `discoverBackendExe(forkDir, 0, 1)` (maxDepth=1) which would find an exe
// INSIDE a version subfolder and falsely treat the fork folder as a version.
// This produced displayName "llama.cpp (llama.cpp)" for the new layout.
// Now we scan version subdirectories FIRST (new layout). Only when NO version
// subdirectory contains an exe do we fall back to the legacy flat layout
// (exe directly in the fork folder, possibly nested in build/bin/).
async function scanBackendRoot(rootDir: string, rootExternal: boolean, rootIndex: number): Promise<BackendVersion[]> {
  const out: BackendVersion[] = []
  let topEntries: import('fs').Dirent[]
  try {
    topEntries = await fsPromises.readdir(rootDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of topEntries) {
    if (!e.isDirectory()) continue
    const forkDir = join(rootDir, e.name)
    // 1. NEW LAYOUT: forkDir contains version subdirectories, each with an exe.
    let versionEntries: import('fs').Dirent[]
    try {
      versionEntries = await fsPromises.readdir(forkDir, { withFileTypes: true })
    } catch {
      versionEntries = []
    }
    const versionSubdirs = versionEntries.filter(v => v.isDirectory())
    let foundNewLayout = false
    for (const v of versionSubdirs) {
      const versionDir = join(forkDir, v.name)
      const found = discoverBackendExe(versionDir)
      if (!found) continue
      foundNewLayout = true
      // Feature 20/21: version folder name IS the release tag (e.g. "b10448" or
      // "TurboQuant b10269-1.5.1"). Display as "forkName (versionTag)".
      out.push({
        id: `${rootIndex}::${e.name}::${v.name}`,
        name: v.name,
        displayName: `${e.name} (${v.name})`,
        backendKey: e.name,
        version: v.name,
        path: found.dir,
        exe: found.exeName,
        hasCommands: existsSync(join(BACKEND_DIR, e.name, 'commands.json')),
        rootDir,
        external: rootExternal
      })
    }
    if (foundNewLayout) continue
    // 2. LEGACY FLAT LAYOUT: forkDir itself contains the exe (no version subfolders).
    // The exe may be directly in forkDir or nested in build/bin/.
    const direct = discoverBackendExe(forkDir)
    if (direct) {
      // Legacy: the folder name is the version; assume the default "llama.cpp" fork.
      const version = e.name
      out.push({
        id: `${rootIndex}::llama.cpp::${version}`,
        name: version,
        displayName: `llama.cpp (${version})`,
        backendKey: 'llama.cpp',
        version,
        path: direct.dir,
        exe: direct.exeName,
        hasCommands: existsSync(join(BACKEND_DIR, 'llama.cpp', 'commands.json')),
        rootDir,
        external: rootExternal
      })
    }
  }
  return out
}

// --------------------------------------------------------------------------
// Default commands schema + tracked-backend default overrides
// --------------------------------------------------------------------------
function loadDefaultCommandsSchema(): CommandsSchema | null {
  const defaultPath = app.isPackaged
    ? join(process.resourcesPath, 'resources', 'commands.json')
    : join(process.cwd(), 'resources', 'commands.json')
  if (existsSync(defaultPath)) {
    try { return JSON.parse(readFileSync(defaultPath, 'utf-8')) as CommandsSchema } catch {}
  }
  return null
}

// Produce a commands.json for a tracked backend, applying defaultOptions overrides.
function buildTrackedCommandsSchema(tracked: TrackedBackend): CommandsSchema | null {
  const base = loadDefaultCommandsSchema()
  if (!base) return null
  if (!tracked.defaultOptions) return base
  for (const cat of base.categories) {
    for (const cmd of cat.commands) {
      const opts = tracked.defaultOptions[cmd.arg]
      if (opts) cmd.options = opts
    }
  }
  return base
}

// Migration: '--mmap'/'--mlock' (independent booleans) → '--load-mode'
// (single select matching llama.cpp's real spec: 'auto' | 'none' | 'mmap' |
// 'mlock' | 'mmap+mlock' | 'dio').
//
// This is a genuine llama.cpp deprecation (its own log output says so
// directly: "--mlock is deprecated. use --load-mode mlock instead" /
// "--mmap and --no-mmap are deprecated. use --load-mode mmap instead"), but
// it's also fixing a real bug in how this app used to build the CLI args in
// the first place. Boolean flags here follow a "true → push the bare flag,
// false → push nothing" convention (see the args-building loop in
// ModelCard.tsx) — fine for flags whose OFF state IS "absent" (like
// --verbose), but wrong for --mmap, whose off state needs an EXPLICIT
// negating flag (--no-mmap) because llama.cpp's own internal default is
// mmap-on ('auto'). So turning the Memory Map switch off in this app never
// actually disabled mmap — it just stopped passing anything, and llama.cpp
// quietly kept using its own default. That's exactly bug report #3: "when
// turn both of them off, llama.cpp says mmap is enabled anyway".
//
// It also explains bug report #1: with mmap OFF (→ no flag emitted at all)
// and mlock ON (→ bare --mlock emitted), llama.cpp's deprecated-flag
// compatibility shim apparently expects --mmap to have been explicitly
// resolved (true OR false) before it can safely fold --mlock into the new
// load-mode machinery; left implicit, the shim's internal mmap base pointer
// never gets set up, and locking un-mapped memory hits
// `GGML_ASSERT(addr) failed` in llama-mmap.cpp. Note this ISN'T actually an
// invalid combination in the real spec — 'mlock' by itself (mmap off,
// mlock on) is one of the six listed modes — it's specifically the
// deprecated-flag compat SHIM that mishandles it. Migrating straight to
// '--load-mode mlock' sidesteps the shim (and the bug) entirely rather than
// working around it.
//
// Migration mapping (applied once per template, honoring what each switch
// combination actually meant as UI intent — not the old broken runtime
// result, since fixing that misbehavior is the point of this migration):
//   --mlock: true,  --mmap: true         → 'mmap+mlock'
//   --mlock: true,  --mmap: false/unset  → 'mlock'   (now a real, valid mode
//                                                       on its own — see above)
//   --mlock: not true, --mmap: true      → 'mmap'
//   --mlock: not true, --mmap: false     → 'none'    (explicit "both off")
//   neither key ever set                 → leave '--load-mode' unset, so the
//                                           schema's own default ('auto')
//                                           applies — don't force an explicit
//                                           value onto a template that never
//                                           touched this setting.
function migrateLoadModeArgs(args: Record<string, unknown>): { args: Record<string, unknown>; changed: boolean } {
  if (args['--mmap'] === undefined && args['--mlock'] === undefined) return { args, changed: false }
  const next = { ...args }
  if (next['--mlock'] === true && next['--mmap'] === true) next['--load-mode'] = 'mmap+mlock'
  else if (next['--mlock'] === true) next['--load-mode'] = 'mlock'
  else if (next['--mmap'] === true) next['--load-mode'] = 'mmap'
  else if (next['--mmap'] === false) next['--load-mode'] = 'none'
  delete next['--mmap']
  delete next['--mlock']
  return { args: next, changed: true }
}

// --------------------------------------------------------------------------
// Download infrastructure (shared by model + backend downloads)
// --------------------------------------------------------------------------
interface DownloadTask {
  id: string
  url: string
  filename: string
  destPath: string
  receivedBytes: number
  totalBytes: number
  speed: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  repoId?: string
  cancelFn?: () => void
}
const downloadTasks = new Map<string, DownloadTask>()
const broadcastTimes = new Map<string, number>()
const BROADCAST_THROTTLE_MS = 200
function canBroadcast(id: string): boolean {
  const now = Date.now()
  const last = broadcastTimes.get(id) || 0
  if (now - last >= BROADCAST_THROTTLE_MS) { broadcastTimes.set(id, now); return true }
  return false
}
function fetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = { headers: { 'User-Agent': 'xlm-studio/2.0.0', Accept: 'application/json' } }
    const get = url.startsWith('https') ? https.get : http.get
    get(url, opts, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        fetchJson(res.headers.location).then(resolve).catch(reject)
        return
      }
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch (e) { reject(e) } })
    }).on('error', reject)
  })
}
function startDownload(
  url: string,
  destPath: string,
  startByte: number,
  onProgress: (received: number, total: number, speed: number) => void,
  onDone: () => void,
  onError: (err: Error) => void
): () => void {
  let destroyed = false
  let currentReq: ReturnType<typeof https.get> | null = null
  const flags = startByte > 0 ? 'a' : 'w'
  const file = createWriteStream(destPath, { flags })
  let speedBytes = 0
  let lastSpeedCheck = Date.now()
  let currentSpeed = 0
  const attempt = (currentUrl: string) => {
    const get = currentUrl.startsWith('https') ? https.get : http.get
    const headers: Record<string, string> = { 'User-Agent': 'xlm-studio/2.0' }
    if (startByte > 0) headers['Range'] = `bytes=${startByte}-`
    currentReq = get(currentUrl, { headers }, (res) => {
      if (destroyed) { res.destroy(); return }
      if (res.statusCode === 301 || res.statusCode === 302) {
        return attempt(res.headers.location!)
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        if (!destroyed) onError(new Error(`HTTP ${res.statusCode}`))
        return
      }
      const contentLength = parseInt(res.headers['content-length'] || '0', 10)
      const totalBytes = contentLength + startByte
      let receivedBytes = startByte
      res.on('data', (chunk: Buffer) => {
        if (destroyed) return
        file.write(chunk)
        receivedBytes += chunk.length
        speedBytes += chunk.length
        const now = Date.now()
        const elapsed = (now - lastSpeedCheck) / 1000
        if (elapsed >= 0.5) {
          currentSpeed = speedBytes / elapsed
          speedBytes = 0
          lastSpeedCheck = now
        }
        onProgress(receivedBytes, totalBytes, currentSpeed)
      })
      res.on('end', () => {
        if (destroyed) return
        file.end(() => { if (!destroyed) onDone() })
      })
      res.on('error', (err) => { if (!destroyed) { file.destroy(); onError(err) } })
    }).on('error', (err) => { if (!destroyed) { file.destroy(); onError(err) } })
  }
  attempt(url)
  return () => {
    if (destroyed) return
    destroyed = true
    currentReq?.destroy()
    file.end()
  }
}

// Smart backend extraction: ensures the extracted archive lands as a single
// version subfolder under <backendKey>/, matching the spec's nested layout.
// - If the archive contains exactly one top-level directory, that directory
//   becomes the version subfolder.
// - Otherwise, a version subfolder named after the asset is created and all
//   contents are placed inside it.
async function smartExtractBackend(opts: {
  archivePath: string
  backendKey: string
  versionHint: string
  isTarGz: boolean
}): Promise<{ extractPath: string; versionDir: string }> {
  const mainBackend = await resolveMainBackendFolder()
  const forkDir = join(mainBackend, opts.backendKey)
  if (!existsSync(forkDir)) mkdirSync(forkDir, { recursive: true })

  // Extract into a temporary staging folder first so we can normalise structure.
  const staging = join(forkDir, `.staging-${Date.now()}`)
  mkdirSync(staging, { recursive: true })
  try {
    if (opts.isTarGz) {
      await new Promise<void>((resolve, reject) => {
        const p = spawn('tar', ['-xzf', opts.archivePath, '-C', staging], { stdio: 'pipe' })
        p.on('error', reject)
        p.on('exit', code => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)))
      })
    } else {
      await extract(opts.archivePath, { dir: staging })
    }
  } catch (err) {
    // Cleanup staging on failure.
    try { rmrf(staging) } catch {}
    throw err
  }

  // Inspect the staging folder's top-level entries.
  const topEntries = readdirSync(staging, { withFileTypes: true })
  let versionDir: string
  // Feature 21: The version folder name MUST match the release tag so the
  // version scanner can match it against the tracker payload and flip the
  // UI state to "Up to date". We always use opts.versionHint (the release tag)
  // as the final folder name, regardless of what the archive's internal
  // structure named the root folder (e.g. "build", "bin", etc.).
  const finalVersionName = opts.versionHint || `version-${Date.now()}`
  const dst = join(forkDir, finalVersionName)
  if (existsSync(dst)) rmrf(dst)
  mkdirSync(dst, { recursive: true })
  if (topEntries.length === 1 && topEntries[0].isDirectory()) {
    // Single top-level folder — move its CONTENTS into the version dir (flattening
    // the generic "build"/"bin" wrapper into the version-named dir).
    const src = join(staging, topEntries[0].name)
    const innerEntries = readdirSync(src, { withFileTypes: true })
    for (const e of innerEntries) {
      const s = join(src, e.name)
      const d = join(dst, e.name)
      try { renameSync(s, d) } catch {}
    }
  } else {
    // Multiple entries at root — move all into the version dir.
    for (const e of topEntries) {
      const src = join(staging, e.name)
      const d = join(dst, e.name)
      try { renameSync(src, d) } catch {}
    }
  }
  versionDir = dst
  try { rmrf(staging) } catch {}
  return { extractPath: forkDir, versionDir }
}

function rmrf(dir: string): void {
  if (!existsSync(dir)) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) rmrf(p)
    else unlinkSync(p)
  }
  rmdirSync(dir)
}

// Auto-delete outdated backend versions in the same fork folder.
// After a new version is downloaded & extracted, any OLDER version (by numeric
// build number) in the same forkDir is removed to save disk space. The newly
// downloaded version is always kept. Versions without a parseable build number
// are left untouched (safety). This runs across ALL backend roots that contain
// the same fork folder name, so an update also cleans up copies in external
// backend folders.
async function cleanupOldBackendVersions(backendKey: string, newVersion: string): Promise<{ deleted: string[] }> {
  const deleted: string[] = []
  const newNum = parseInt((newVersion.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
  if (!newNum) return { deleted } // can't compare — skip
  const roots = await backendRoots()
  for (const root of roots) {
    const forkDir = join(root.dir, backendKey)
    if (!existsSync(forkDir)) continue
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(forkDir, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === newVersion) continue
      // Skip staging folders.
      if (e.name.startsWith('.staging-')) continue
      const verNum = parseInt((e.name.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
      if (verNum && verNum < newNum) {
        const oldDir = join(forkDir, e.name)
        try {
          rmrf(oldDir)
          deleted.push(e.name)
          console.log(`[Backend cleanup] Deleted outdated version "${e.name}" (older than "${newVersion}") in ${forkDir}`)
        } catch (err) {
          console.error(`[Backend cleanup] Failed to delete "${e.name}":`, String(err))
        }
      }
    }
  }
  return { deleted }
}

// ==========================================================================
// App-quit cleanup (feature: stop/start race fix)
// ==========================================================================
// On quit, kill every still-running llama-server process tree so no orphan
// survives after XLM Studio closes (the user reported having to kill XLM
// Studio from Task Manager because a child kept port 1234 alive). Called
// from main/index.ts on `before-quit`.
export async function cleanupAllProcesses(): Promise<void> {
  if (runningProcesses.size === 0) return
  const entries = Array.from(runningProcesses.entries())
  runningProcesses.clear()
  // Item 4 (Monitoring): stop polling timers + archive any still-active
  // perf sessions before the processes actually die, so their data gets
  // persisted to history instead of just vanishing.
  stopAllTracking()
  await Promise.all(entries.map(([_id, e]) => killProcessTree(e.proc).catch(() => {})))
}

// Peek at the running-process count so the quit handler can decide whether to
// defer the quit until cleanup finishes.
export function getRunningProcessCount(): number {
  return runningProcesses.size
}

// ==========================================================================
// IPC handlers
// ==========================================================================
export function registerIpcHandlers(): void {
  // Item 4 (Monitoring): read a template's CURRENT name directly from disk,
  // by id — used so session tracking always reflects live renames rather
  // than a name snapshotted at session-start (same pattern as the Logs
  // rename fix — see LogsView.tsx's liveName()).
  function getLiveTemplateName(templateId: string): string | undefined {
    try {
      const fp = join(TEMPLATES_DIR, `${templateId}.json`)
      if (!existsSync(fp)) return undefined
      const t = JSON.parse(readFileSync(fp, 'utf-8'))
      return t?.name
    } catch { return undefined }
  }
  initPerfMonitor(APP_ROOT, {
    getLiveTemplateName,
    getMaxSessions: () => {
      try {
        const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
        const n = Number(s?.modelDefaults?.perfMaxSessions)
        return isNaN(n) || n < 1 ? 20 : n
      } catch { return 20 }
    }
  })
  registerPerfHandlers()

  // ----- Models: smart grouped listing -----
  ipcMain.handle('list-models', async () => {
    const settings = await loadSettings()
    // Build the ordered list of model roots: main (starred) folder first if it
    // is an external folder, then default MODELS_DIR, then remaining external
    // folders. Deduplicate by resolved path.
    const seen = new Set<string>()
    const roots: { dir: string; external: boolean }[] = []
    const push = (dir: string, external: boolean) => {
      const r = resolve(dir)
      if (seen.has(r)) return
      seen.add(r)
      roots.push({ dir, external })
    }
    // Default models dir is always scanned.
    push(MODELS_DIR, false)
    // External folders.
    const sortedExt = sortExternalFolders(settings.externalModelFolders, settings.mainModelFolder)
    for (const f of sortedExt) if (existsSync(f)) push(f, true)

    const groups: ModelGroup[] = []
    const seenGroups = new Set<string>()
    for (const root of roots) {
      const gs = await scanModelRoot(root.dir, root.external)
      for (const g of gs) {
        const key = resolve(g.folderPath)
        if (seenGroups.has(key)) continue
        seenGroups.add(key)
        groups.push(g)
      }
    }
    // Task 1: prune the metadata cache — delete entries for model files that
    // are no longer detected (e.g. deleted / moved). mmproj files are never
    // cached (they're not models), so they're naturally absent.
    const detectedPaths = new Set<string>()
    for (const g of groups) for (const m of g.models) detectedPaths.add(m.path)
    let pruned = false
    for (const cachedPath of Object.keys(metadataCache)) {
      if (!detectedPaths.has(cachedPath) || !existsSync(cachedPath)) {
        delete metadataCache[cachedPath]
        pruned = true
      }
    }
    if (pruned) saveMetadataCache()
    return groups
  })

  // Task 1: return the full metadata cache so the renderer can bulk-load it
  // (instant access, no re-extraction on every view).
  ipcMain.handle('get-metadata-cache', async () => metadataCache)

  // Item 3: "Reextract model data" — wipe the ENTIRE persisted metadata
  // cache (every model, regardless of schema version) so the next
  // get-gguf-metadata call for each one is forced to re-run extraction from
  // scratch. This is the manual counterpart to the schema-version auto-
  // invalidation (see METADATA_SCHEMA_VERSION) — useful any time the user
  // suspects stale/incorrect cached data for a reason the schema bump
  // wouldn't catch (e.g. a model file was silently replaced in place with
  // the same path). Returns how many entries were cleared.
  ipcMain.handle('clear-metadata-cache', async () => {
    const count = Object.keys(metadataCache).length
    metadataCache = {}
    saveMetadataCache()
    return { success: true, cleared: count }
  })

  ipcMain.handle('list-external-model-folders', async () => {
    const s = await loadSettings()
    return sortExternalFolders(s.externalModelFolders, s.mainModelFolder)
  })
  ipcMain.handle('get-main-model-folder', async () => {
    const folder = await resolveMainModelFolder()
    return { folder, isDefault: folder === MODELS_DIR }
  })
  ipcMain.handle('set-main-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.mainModelFolder = s.externalModelFolders.includes(folder) ? folder : null
    await saveSettings(s)
    return { success: true, mainModelFolder: s.mainModelFolder }
  })
  ipcMain.handle('add-external-model-folder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Add External Model Folder', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.externalModelFolders.includes(folder)) {
      s.externalModelFolders.push(folder)
      await saveSettings(s)
    }
    return { success: true, folders: sortExternalFolders(s.externalModelFolders, s.mainModelFolder) }
  })
  ipcMain.handle('remove-external-model-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.externalModelFolders = s.externalModelFolders.filter(f => f !== folder)
    if (s.mainModelFolder === folder) s.mainModelFolder = null
    await saveSettings(s)
    return { success: true, folders: sortExternalFolders(s.externalModelFolders, s.mainModelFolder) }
  })

  // ----- Model file operations (operate on individual files) -----
  ipcMain.handle('delete-model', async (_e, filePath: string) => {
    try {
      // Allow deletion inside MODELS_DIR or any external model folder.
      const s = await loadSettings()
      const allowed = [MODELS_DIR, ...s.externalModelFolders]
      if (!allowed.some(b => isSafePath(b, filePath))) return { success: false, error: 'Access denied' }
      unlinkSync(filePath)
      // Task 1: remove the cached metadata for the deleted model file.
      if (metadataCache[filePath]) {
        delete metadataCache[filePath]
        saveMetadataCache()
      }
      const dir = dirname(filePath)
      // Remove the now-empty model folder (but never the storage roots themselves).
      const isRoot = [MODELS_DIR, ...s.externalModelFolders].some(b => resolve(dir) === resolve(b))
      if (!isRoot) {
        try { if (readdirSync(dir).length === 0) rmdirSync(dir) } catch {}
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('rename-model', async (_e, oldPath: string, newName: string) => {
    try {
      const s = await loadSettings()
      const allowed = [MODELS_DIR, ...s.externalModelFolders]
      if (!allowed.some(b => isSafePath(b, oldPath))) return { success: false, error: 'Access denied' }
      const dir = dirname(oldPath)
      const newPath = join(dir, newName + extname(oldPath))
      if (!allowed.some(b => isSafePath(b, newPath))) return { success: false, error: 'Access denied' }
      renameSync(oldPath, newPath)
      return { success: true, newPath }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ----- Model downloads (route to main folder, LM-Studio style) -----
  ipcMain.handle('start-model-download', async (_event, opts: {
    url: string
    filename: string
    repoId?: string
    modelFolder?: string
  }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const t = downloadTasks.get(id)!
      if (t.phase === 'downloading') return { success: false, error: 'Already downloading' }
    }
    // Determine destination subfolder: explicit override > repo page name > "downloads".
    const sub = (opts.modelFolder || opts.repoId?.split('/').pop() || 'downloads').trim() || 'downloads'
    const mainFolder = await resolveMainModelFolder()
    const targetDir = join(mainFolder, sub)
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
    const finalPath = join(targetDir, opts.filename)
    const tmpPath = finalPath + '.tmp'
    const task: DownloadTask = {
      id, url: opts.url, filename: opts.filename,
      destPath: finalPath, receivedBytes: 0, totalBytes: 0, speed: 0,
      phase: 'downloading', repoId: opts.repoId
    }
    const broadcastProgress = (t: DownloadTask, force = false) => {
      if (!force && !canBroadcast(t.id)) return
      const payload = {
        id: t.id, filename: t.filename,
        percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0,
        receivedBytes: t.receivedBytes, totalBytes: t.totalBytes,
        speed: t.speed, phase: t.phase, destPath: t.destPath,
        repoId: t.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('model-download-progress', payload)
      })
    }
    task.cancelFn = startDownload(
      opts.url, tmpPath, 0,
      (received, total, speed) => { task.receivedBytes = received; task.totalBytes = total; task.speed = speed; broadcastProgress(task) },
      () => {
        try { renameSync(tmpPath, finalPath) } catch {}
        task.phase = 'done'; task.speed = 0; broadcastProgress(task, true)
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id) }, 5000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('Download error:', err) }
    )
    downloadTasks.set(id, task)
    broadcastProgress(task, true)
    return { success: true, id }
  })
  ipcMain.handle('pause-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'downloading') return { success: false, error: 'Not downloading' }
    task.cancelFn?.()
    task.phase = 'paused'
    task.speed = 0
    broadcastTimes.delete(id)
    const payload = {
      id, filename: task.filename, phase: 'paused', speed: 0,
      percent: task.totalBytes > 0 ? Math.round((task.receivedBytes / task.totalBytes) * 100) : 0,
      receivedBytes: task.receivedBytes, totalBytes: task.totalBytes,
      destPath: task.destPath, repoId: task.repoId
    }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('model-download-progress', payload)
        if (task.repoId) win.webContents.send('hf-download-progress', payload)
      }
    })
    return { success: true }
  })
  ipcMain.handle('resume-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task || task.phase !== 'paused') return { success: false, error: 'Not paused' }
    task.phase = 'downloading'
    const tmpPath = task.destPath + '.tmp'
    try { task.receivedBytes = statSync(tmpPath).size } catch {}
    const broadcastProgress = (t: DownloadTask, force = false) => {
      if (!force && !canBroadcast(t.id)) return
      const payload = {
        id: t.id, filename: t.filename, phase: t.phase, speed: t.speed,
        percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0,
        receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, destPath: t.destPath,
        repoId: t.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('model-download-progress', payload)
          if (t.repoId) win.webContents.send('hf-download-progress', payload)
        }
      })
    }
    const startByte = task.receivedBytes
    task.cancelFn = startDownload(
      task.url, tmpPath, startByte,
      (received, total, speed) => { task.receivedBytes = received; task.totalBytes = total; task.speed = speed; broadcastProgress(task) },
      () => {
        try { renameSync(tmpPath, task.destPath) } catch {}
        task.phase = 'done'; task.speed = 0; broadcastProgress(task, true)
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id) }, 5000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcastProgress(task, true); console.error('Resume error:', err) }
    )
    broadcastProgress(task, true)
    return { success: true }
  })
  ipcMain.handle('cancel-model-download', (_e, id: string) => {
    const task = downloadTasks.get(id)
    if (!task) return { success: false, error: 'Not found' }
    task.cancelFn?.()
    task.phase = 'cancelled'
    try { unlinkSync(task.destPath + '.tmp') } catch {}
    try { unlinkSync(task.destPath) } catch {}
    const payload = { id, filename: task.filename, phase: 'cancelled', percent: 0, receivedBytes: 0, totalBytes: 0, speed: 0 }
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('model-download-progress', payload)
        if (task.repoId) win.webContents.send('hf-download-progress', payload)
      }
    })
    downloadTasks.delete(id)
    return { success: true }
  })
  ipcMain.handle('list-model-downloads', () => {
    return Array.from(downloadTasks.values()).map(t => ({
      id: t.id, url: t.url, filename: t.filename, destPath: t.destPath,
      receivedBytes: t.receivedBytes, totalBytes: t.totalBytes, phase: t.phase,
      percent: t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0
    }))
  })

  // ----- Backends: smart fork-aware listing -----
  ipcMain.handle('list-backends', async () => {
    const roots = await backendRoots()
    const all: BackendVersion[] = []
    for (let i = 0; i < roots.length; i++) {
      const versions = await scanBackendRoot(roots[i].dir, roots[i].external, i)
      all.push(...versions)
    }
    // Sort: by backendKey then version desc (numeric prefix if present).
    all.sort((a, b) => {
      if (a.backendKey !== b.backendKey) return a.backendKey.localeCompare(b.backendKey)
      const n = (s: string) => parseInt((s.match(/(\d{3,6})/) || ['0', '0'])[1], 10)
      return n(b.version) - n(a.version)
    })
    return all
  })
  ipcMain.handle('delete-backend', async (_e, backendId: string) => {
    try {
      // backendId = `${rootIndex}::${backendKey}::${version}`
      const parts = backendId.split('::')
      if (parts.length < 3) return { success: false, error: 'Invalid backend id' }
      const rootIndex = parseInt(parts[0], 10)
      const backendKey = parts[1]
      const version = parts.slice(2).join('::')
      const roots = await backendRoots()
      const root = roots[rootIndex]
      if (!root) return { success: false, error: 'Backend root not found' }
      const versionDir = join(root.dir, backendKey, version)
      // Safety: must stay within this root.
      if (!isSafePath(root.dir, versionDir)) return { success: false, error: 'Access denied' }
      if (existsSync(versionDir)) rmrf(versionDir)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ----- Backends: external folders (mirrors model folders mechanics) -----
  ipcMain.handle('list-external-backend-folders', async () => {
    const s = await loadSettings()
    return sortExternalFolders(s.externalBackendFolders, s.mainBackendFolder)
  })
  ipcMain.handle('get-main-backend-folder', async () => {
    const folder = await resolveMainBackendFolder()
    return { folder, isDefault: folder === BACKEND_DIR }
  })
  ipcMain.handle('set-main-backend-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.mainBackendFolder = s.externalBackendFolders.includes(folder) ? folder : null
    await saveSettings(s)
    return { success: true, mainBackendFolder: s.mainBackendFolder }
  })
  ipcMain.handle('add-external-backend-folder', async () => {
    const r = await dialog.showOpenDialog({ title: 'Add External Backend Folder', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return { success: false }
    const folder = r.filePaths[0]
    const s = await loadSettings()
    if (!s.externalBackendFolders.includes(folder)) {
      s.externalBackendFolders.push(folder)
      await saveSettings(s)
    }
    return { success: true, folders: sortExternalFolders(s.externalBackendFolders, s.mainBackendFolder) }
  })
  ipcMain.handle('remove-external-backend-folder', async (_e, folder: string) => {
    const s = await loadSettings()
    s.externalBackendFolders = s.externalBackendFolders.filter(f => f !== folder)
    if (s.mainBackendFolder === folder) s.mainBackendFolder = null
    await saveSettings(s)
    return { success: true, folders: sortExternalFolders(s.externalBackendFolders, s.mainBackendFolder) }
  })

  // ----- Backends: tracked repos (Backends Tracker) -----
  ipcMain.handle('list-tracked-backends', async () => {
    const s = await loadSettings()
    return s.trackedBackends
  })
  ipcMain.handle('add-tracked-backend', async (_e, link: string) => {
    const trimmed = (link || '').trim()
    if (!trimmed) return { success: false, error: 'Empty link' }
    // Accept either "owner/repo" or a full github URL.
    let repo: string
    const m = trimmed.match(/github\.com\/([^/]+\/[^/]+?)(?:\/|$)/)
    if (m) repo = m[1]
    else if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) repo = trimmed
    else return { success: false, error: 'Unrecognised GitHub link. Use https://github.com/owner/repo or owner/repo.' }
    const s = await loadSettings()
    if (s.trackedBackends.find(t => t.repo === repo)) return { success: false, error: 'Already tracked' }
    const folderName = repo.split('/').pop() || repo
    const id = folderName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36)
    const tracked: TrackedBackend = { id, repo, name: folderName, folderName, isDefault: false }
    s.trackedBackends.push(tracked)
    await saveSettings(s)
    return { success: true, tracked }
  })
  ipcMain.handle('remove-tracked-backend', async (_e, trackedId: string) => {
    const s = await loadSettings()
    const t = s.trackedBackends.find(x => x.id === trackedId)
    if (!t) return { success: false, error: 'Not found' }
    if (t.isDefault) return { success: false, error: 'Built-in backends cannot be removed' }
    s.trackedBackends = s.trackedBackends.filter(x => x.id !== trackedId)
    await saveSettings(s)
    return { success: true }
  })

  // ----- Backends: commands schema (per fork) -----
  // Rewritten (simplified, no back-compat concerns): the previous
  // "persist once, heal/version-sync on read" design kept reintroducing the
  // exact class of bug it was meant to fix — a backend's own option
  // overrides (TurboQuant's cache-type-k/v values) kept getting silently
  // reset back to the generic ones because the sync/heal logic compared
  // against the wrong baseline. Simplify entirely: every call recomputes the
  // built-in commands FRESH from the base schema + this backend's own
  // defaultOptions — always, unconditionally, no caching, no version flags,
  // no staleness possible. The only thing ever read from the persisted file
  // is genuinely CUSTOM commands the user added via the Commands Editor
  // (i.e. an arg that isn't a built-in one at all) — those are merged in on
  // top and preserved; anything matching a built-in arg is always overridden
  // by the fresh computation, full stop.
  ipcMain.handle('get-commands', async (_e, backendKey: string) => {
    if (!backendKey) return loadDefaultCommandsSchema()
    const s = await loadSettings()
    const tracked = s.trackedBackends.find(t => t.folderName === backendKey || t.id === backendKey)
    const fresh = tracked ? buildTrackedCommandsSchema(tracked) : loadDefaultCommandsSchema()
    if (!fresh) return null
    const knownArgs = new Set<string>()
    for (const cat of fresh.categories) for (const cmd of cat.commands) knownArgs.add(cmd.arg)
    const commandsPath = join(BACKEND_DIR, backendKey, 'commands.json')
    if (existsSync(commandsPath)) {
      try {
        const persisted = JSON.parse(readFileSync(commandsPath, 'utf-8')) as CommandsSchema
        for (const cat of persisted.categories) {
          for (const cmd of cat.commands) {
            if (knownArgs.has(cmd.arg)) continue  // built-in: always the fresh definition wins
            let targetCat = fresh.categories.find(c => c.name === cat.name)
            if (!targetCat) {
              targetCat = { name: cat.name, icon: cat.icon, commands: [] }
              fresh.categories.push(targetCat)
            }
            targetCat.commands.push(cmd)
          }
        }
      } catch {}
    }
    // Always write the resolved result back, so the Commands Editor (which
    // reads/writes this same file) is looking at exactly what get-commands
    // just returned, and any genuinely-custom commands survive being
    // round-tripped through this merge.
    try {
      mkdirSync(join(BACKEND_DIR, backendKey), { recursive: true })
      writeFileSync(commandsPath, JSON.stringify(fresh, null, 2))
    } catch {}
    return fresh
  })
  ipcMain.handle('save-backend-commands', async (_e, backendKey: string, schema: unknown) => {
    try {
      const dir = join(BACKEND_DIR, backendKey)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'commands.json'), JSON.stringify(schema, null, 2))
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  // ----- Templates -----
  ipcMain.handle('list-templates', () => {
    if (!existsSync(TEMPLATES_DIR)) return []
    return readdirSync(TEMPLATES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          const template = JSON.parse(readFileSync(join(TEMPLATES_DIR, f), 'utf-8')) as Record<string, any>
          // Heal-on-read migration (see migrateLoadModeArgs): only touches
          // templates that still have the old '--mmap'/'--mlock' keys, and
          // persists the result so this only has to run once per template.
          if (template.args && typeof template.args === 'object') {
            const { args, changed } = migrateLoadModeArgs(template.args)
            if (changed) {
              template.args = args
              try { writeFileSync(join(TEMPLATES_DIR, f), JSON.stringify(template, null, 2)) } catch {}
            }
          }
          return { ...template, _file: f }
        }
        catch { return null }
      })
      .filter(Boolean)
  })
  ipcMain.handle('save-template', (_e, template: Record<string, unknown>) => {
    const id = (template.id as string) || Date.now().toString()
    writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify({ ...template, id }, null, 2))
    return { success: true, id }
  })
  ipcMain.handle('delete-template', (_e, id: string) => {
    const fp = join(TEMPLATES_DIR, `${id}.json`)
    if (!isSafePath(TEMPLATES_DIR, fp)) return { success: false, error: 'Access denied' }
    if (existsSync(fp)) unlinkSync(fp)
    return { success: true }
  })
  ipcMain.handle('import-template', async () => {
    const r = await dialog.showOpenDialog({ title: 'Import Template', filters: [{ name: 'JSON Template', extensions: ['json'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    const data = JSON.parse(readFileSync(r.filePaths[0], 'utf-8'))
    const id = Date.now().toString(); data.id = id
    // Apply the same '--mmap'/'--mlock' → '--load-mode' migration as
    // list-templates, so an imported template (possibly exported from an
    // older version of the app) is normalized immediately rather than
    // waiting for the next list-templates read to heal it.
    if (data.args && typeof data.args === 'object') {
      data.args = migrateLoadModeArgs(data.args).args
    }
    writeFileSync(join(TEMPLATES_DIR, `${id}.json`), JSON.stringify(data, null, 2))
    return data
  })
  ipcMain.handle('export-template', async (_e, template: Record<string, unknown>) => {
    const r = await dialog.showSaveDialog({ title: 'Export Template', defaultPath: `${template.name ?? 'template'}.json`, filters: [{ name: 'JSON Template', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { success: false }
    writeFileSync(r.filePath, JSON.stringify(template, null, 2)); return { success: true }
  })

  // ----- File pickers -----
  ipcMain.handle('pick-model-file', async () => {
    const r = await dialog.showOpenDialog({ title: 'Select Model File', filters: [{ name: 'GGUF / GGML Models', extensions: ['gguf', 'bin', 'ggml'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    return { name: basename(r.filePaths[0]), path: r.filePaths[0] }
  })
  ipcMain.handle('pick-any-file', async () => {
    const r = await dialog.showOpenDialog({ title: 'Select File', properties: ['openFile'] })
    if (r.canceled || !r.filePaths.length) return null
    return r.filePaths[0]
  })

  // ----- Run model -----
  ipcMain.handle('run-model', async (_e, opts: { id: string; name: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number }) => {
    if (runningProcesses.has(opts.id)) return { success: false, error: 'Already running' }
    // Fix 4: If base URL override is enabled, use the override port, ignoring
    // the template's original Server Port completely.
    let port = opts.port || 8080
    const overridePort = await getOverridePort()
    if (overridePort !== null) {
      port = overridePort
    }
    let available = await isPortAvailable(port)
    let finalPort = port
    let finalArgs = [...opts.args]
    // Fix 4: ALWAYS update the --port argument in finalArgs to match the
    // resolved port (which may be the override port). Previously this only
    // happened inside the port-conflict block, so when the override port was
    // available, the server still started on the ORIGINAL port from the args.
    {
      const portIdx = finalArgs.indexOf('--port')
      if (portIdx !== -1 && portIdx + 1 < finalArgs.length) {
        finalArgs[portIdx + 1] = String(finalPort)
      } else {
        const shortPortIdx = finalArgs.indexOf('-p')
        if (shortPortIdx !== -1 && shortPortIdx + 1 < finalArgs.length) {
          finalArgs[shortPortIdx + 1] = String(finalPort)
        } else {
          finalArgs.push('--port', String(finalPort))
        }
      }
    }
    if (!available) {
      // Task 10: no more "run on a different port?" dialog or temp-port
      // reassignment — that "parallel processes" behavior was confusing. Just
      // return a clean error so the renderer alerts the user. The Stop button
      // already disables Start while the previous server is closing, so a busy
      // port here means another process (or another running model) genuinely
      // holds it.
      return { success: false, error: `Port ${port} is already in use. Stop the other model or change the port.` }
    }

    // Fix (context): ensure --ctx-size is passed so the server uses the model's
    // real context (not the 4096 default). The renderer (ModelCard) is now the
    // source of truth for the EFFECTIVE context — it computes it from the
    // per-preset "Ignore Context Length Override" flag + the global Minimum
    // AutoFit override + the preset's own --ctx-size, and forces --ctx-size to
    // that value. The main process therefore does NOT re-apply the global
    // override (doing so would break the per-preset ignore flag). It only
    // ensures --ctx-size is present (0 = native) when the renderer didn't set
    // one (e.g. MoE Auto mode passes --fit and leaves ctx to llama-server).
    {
      const hasFit = finalArgs.includes('--fit') || finalArgs.includes('-fit')
      if (!hasFit) {
        const idx = finalArgs.indexOf('--ctx-size')
        const sIdx = finalArgs.indexOf('-c')
        if (idx === -1 && sIdx === -1) finalArgs.push('--ctx-size', '0')
      }
    }
    // Item 4 (Monitoring tab): force-enable llama-server's --metrics endpoint
    // so performance data can be polled, regardless of whether the user has
    // it in their own template args. Doesn't change behavior other than
    // exposing the /metrics endpoint — safe to always add.
    if (!finalArgs.includes('--metrics')) finalArgs.push('--metrics')
    // Fix (override): Apply "Serve on local network" (--host 0.0.0.0) and
    // "API Key" (--api-key <key>) from the Base URL Override settings.
    {
      const s2 = await loadSettings()
      const ovr = s2.baseUrlOverride
      if (ovr?.enabled && ovr.serveOnLocalNetwork) {
        const hostIdx = finalArgs.indexOf('--host')
        if (hostIdx !== -1 && hostIdx + 1 < finalArgs.length) {
          finalArgs[hostIdx + 1] = '0.0.0.0'
        } else {
          const shortHostIdx = finalArgs.indexOf('-h')
          if (shortHostIdx !== -1 && shortHostIdx + 1 < finalArgs.length) {
            finalArgs[shortHostIdx + 1] = '0.0.0.0'
          } else {
            finalArgs.push('--host', '0.0.0.0')
          }
        }
      }
      if (ovr?.enabled && ovr.apiKeyEnabled && ovr.apiKey) {
        const keyIdx = finalArgs.indexOf('--api-key')
        if (keyIdx !== -1 && keyIdx + 1 < finalArgs.length) {
          finalArgs[keyIdx + 1] = ovr.apiKey
        } else {
          finalArgs.push('--api-key', ovr.apiKey)
        }
      }
    }

    const exePath = join(opts.backendPath, opts.exe)
    // Safety: exe must live inside BACKEND_DIR or an external backend folder.
    const s = await loadSettings()
    const allowedRoots = [BACKEND_DIR, ...s.externalBackendFolders]
    if (!allowedRoots.some(b => isSafePath(b, exePath))) return { success: false, error: 'Access denied' }
    if (!existsSync(exePath)) return { success: false, error: `Executable not found: ${exePath}` }
    try {
      // Feature (logs): emit a launch event with the effective runtime params so
      // the user can see exactly what is being passed to llama.cpp.
      serverReadyFlags.delete(opts.id)
      modelLoadingFlags.delete(opts.id)
      {
        const ctxArgIdx = finalArgs.indexOf('--ctx-size')
        const ctxArgShortIdx = finalArgs.indexOf('-c')
        const ctxArgPos = ctxArgIdx !== -1 ? ctxArgIdx : ctxArgShortIdx
        let ctxValStr = '0 (native)'
        if (ctxArgPos !== -1 && ctxArgPos + 1 < finalArgs.length) {
          const v = finalArgs[ctxArgPos + 1]
          ctxValStr = v === '0' ? '0 (native)' : String(v)
        }
        const nglIdx = finalArgs.indexOf('--gpu-layers')
        const nglShortIdx = finalArgs.indexOf('-ngl')
        const nglPos = nglIdx !== -1 ? nglIdx : nglShortIdx
        const nglVal = nglPos !== -1 && nglPos + 1 < finalArgs.length ? finalArgs[nglPos + 1] : 'auto'
        const overrideActive = overridePort !== null
        const parts = [
          `Launching "${opts.name}"`,
          `backend=${opts.exe}`,
          `port=${finalPort}${overrideActive ? ' (override)' : ''}`,
          `ctx-size=${ctxValStr}`,
          `gpu-layers=${nglVal}`
        ]
        if (s.modelDefaults?.autoFitEnabled) {
          parts.push(`min-ctx-override=${s.modelDefaults.autoFitContextLength}`)
        }
        emitAppLog(opts.id, opts.name, parts.join(' · '))
      }
      // detached:true on POSIX so we get a new process group we can SIGKILL
      // wholesale (covers llama-server's child threads). On Windows we rely on
      // `taskkill /F /T` instead, so detached doesn't matter there.
      const proc = spawn(exePath, finalArgs, { detached: process.platform !== 'win32', stdio: 'pipe', cwd: dirname(exePath), windowsHide: false })
      // Fix 4: Stream server logs to all renderer windows for the Logs tab.
      proc.stderr?.on('data', (d) => {
        const line = d.toString()
        console.error('[llama-server]', line)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('server-log', { id: opts.id, name: opts.name, stream: 'stderr', line, ts: Date.now() })
        })
        // Feature (logs): surface important stderr events (errors/fatals) as
        // highlighted app-level logs so they aren't lost in the raw stream.
        try {
          const lower = line.toLowerCase()
          if (lower.includes('error') || lower.includes('fatal') || lower.includes('failed') || lower.includes('cannot') || lower.includes('abort')) {
            const trimmed = line.replace(/\s+/g, ' ').trim().slice(0, 300)
            if (trimmed) emitAppLog(opts.id, opts.name, `⚠ ${trimmed}`)
          }
        } catch {}
      })
      proc.stdout?.on('data', (d) => {
        const line = d.toString()
        console.log('[llama-server]', line)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('server-log', { id: opts.id, name: opts.name, stream: 'stdout', line, ts: Date.now() })
        })
        // Feature (logs): detect lifecycle / generation / chat-request markers in
        // the llama-server output and emit enriched app-level logs for them.
        try {
          const lower = line.toLowerCase()
          // Model loaded / ready to serve.
          if (!modelLoadingFlags.get(opts.id) && (lower.includes('model loaded') || lower.includes('llama_model_loader') || lower.includes('load_tensors'))) {
            modelLoadingFlags.set(opts.id, true)
            emitAppLog(opts.id, opts.name, 'Model loaded — preparing server...')
          }
          // HTTP server listening (ready to accept requests).
          if (!serverReadyFlags.get(opts.id) && (lower.includes('server is listening') || lower.includes('http server listening') || lower.includes('listening on') || lower.includes('all slots are initialized') || lower.includes('main: server listening'))) {
            serverReadyFlags.set(opts.id, true)
            emitAppLog(opts.id, opts.name, `✓ Server ready — listening on port ${finalPort}`)
          }
          // Chat completion request (user message hitting the API).
          if (lower.includes('chat/completions') || lower.includes('/v1/chat/completions')) {
            if (lower.includes('post') || lower.includes('request') || lower.includes(' 200 ')) {
              emitAppLog(opts.id, opts.name, '💬 Chat completion request received (user message)')
            }
          }
          // Generation completion — llama-server prints "print_timings:" after each
          // generation with prompt/predicted token stats.
          if (lower.includes('print_timings')) {
            const m = line.match(/n_predict\s*=\s*(\d+)/i) || line.match(/predicted\s+(\d+)\s+tokens/i)
            const n = m ? m[1] : ''
            emitAppLog(opts.id, opts.name, n ? `✨ Generation completed — ${n} tokens predicted` : '✨ Generation completed')
          }
          // System prompt / slot events (indicates system message processing).
          if (lower.includes('slot') && (lower.includes('system') || lower.includes('prompt processing'))) {
            const trimmed = line.replace(/\s+/g, ' ').trim().slice(0, 160)
            if (trimmed) emitAppLog(opts.id, opts.name, `🔧 ${trimmed}`)
          }
        } catch {}
      })
      proc.on('error', (err: any) => {
        let msg = String(err)
        if (err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
          msg = 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.'
        }
        console.error('[llama-server] spawn error:', msg)
        runningProcesses.delete(opts.id)
        serverReadyFlags.delete(opts.id)
        modelLoadingFlags.delete(opts.id)
        emitAppLog(opts.id, opts.name, `✖ Spawn error: ${msg}`)
        _e.sender.send('model-error', { id: opts.id, error: msg })
      })
      runningProcesses.set(opts.id, { proc, port: finalPort })
      // Item 4 (Monitoring): begin polling this instance's /metrics endpoint.
      startTracking(opts.id, finalPort, opts.name)
      proc.on('exit', () => {
        runningProcesses.delete(opts.id)
        stopTracking(opts.id)
        const wasReady = serverReadyFlags.get(opts.id)
        serverReadyFlags.delete(opts.id)
        modelLoadingFlags.delete(opts.id)
        emitAppLog(opts.id, opts.name, wasReady ? '■ Model stopped' : '■ Process exited')
        BrowserWindow.getAllWindows().forEach(win => {
          win.webContents.send('model-exited', { id: opts.id })
        })
      })
      if (opts.openBrowser) {
        // Extract ctx-size from finalArgs (which now always has it) for the
        // chat window badge. A value of 0 means "native" — pass undefined so
        // the badge isn't shown with a misleading "0"; the built-in web UI
        // reads the real n_ctx from the server's /props endpoint.
        const ctxIdx2 = finalArgs.indexOf('--ctx-size')
        const shortCtxIdx2 = finalArgs.indexOf('-c')
        const cidx = ctxIdx2 !== -1 ? ctxIdx2 : shortCtxIdx2
        let ctxSize: number | undefined
        if (cidx !== -1 && cidx + 1 < finalArgs.length) {
          const v = parseInt(finalArgs[cidx + 1], 10)
          if (!isNaN(v) && v > 0) ctxSize = v
        }
        setTimeout(() => {
          if (runningProcesses.has(opts.id)) {
            openChatWindow(finalPort, opts.name, ctxSize)
          }
        }, 2500)
      }
      return { success: true, pid: proc.pid, port: finalPort }
    } catch (err: any) {
      if (err.code === 'UNKNOWN' && opts.backendPath.toLowerCase().includes('arm64') && process.arch !== 'arm64') {
        return { success: false, error: 'Architecture mismatch: You are trying to run an ARM64 backend on an x64 system. Please delete this backend in Settings and download the x64 version.' }
      }
      return { success: false, error: String(err) }
    }
  })

  // When base URL override is enabled, ALL port values are overridden.
  // The app ignores the template's original Server Port completely and uses
  // the override port. This applies to: run-model, open-chat-window, and
  // open-detached-chat-window.
  async function getOverridePort(): Promise<number | null> {
    try {
      const s = await loadSettings()
      if (s.baseUrlOverride?.enabled) {
        const p = s.baseUrlOverride.port || 1234
        if (p > 0 && p < 65536) return p
      }
    } catch {}
    return null
  }

  async function resolveChatUrl(port: number): Promise<string> {
    // If override is enabled, ALWAYS use the override port, ignoring
    // the card's original port completely.
    const overridePort = await getOverridePort()
    if (overridePort !== null) {
      return `http://127.0.0.1:${overridePort}`
    }
    return `http://127.0.0.1:${port}`
  }

  function openChatWindow(port: number, name?: string, ctxSize?: number) {
    const templateName = name || `Port ${port}`
    const ctxParam = ctxSize ? `&ctx=${ctxSize}` : ''
    resolveChatUrl(port).then(chatUrl => {
    if (sharedChatWindow && !sharedChatWindow.isDestroyed()) {
      if (sharedChatWindow.isMinimized()) sharedChatWindow.restore()
      sharedChatWindow.show()
      sharedChatWindow.focus()
      sharedChatWindow!.webContents.send('add-chat-tab', { url: chatUrl, name: templateName, ctxSize })
      return
    }
    {
    const candidates = [
      join(process.cwd(), 'assets', 'icon.png'),
      join(__dirname, '../../assets/icon.png'),
      join(app.getAppPath(), 'assets', 'icon.png')
    ]
    const icon = candidates.find(existsSync)
    let x: number | undefined
    let y: number | undefined
    const width = 1024
    const height = 768
    const mainWin = BrowserWindow.getAllWindows().find(w => {
      try { const url = w.webContents.getURL(); return !url.includes('chat_url') } catch { return false }
    })
    if (mainWin && !mainWin.isDestroyed()) {
      const bounds = mainWin.getBounds()
      x = Math.round(bounds.x + (bounds.width - width) / 2)
      y = Math.round(bounds.y + (bounds.height - height) / 2)
    }
    sharedChatWindow = new BrowserWindow({
      width, height, show: true, autoHideMenuBar: true,
      title: 'XLM Studio - Llama-UI',
      titleBarStyle: 'hiddenInset',
      backgroundColor: appShouldUseDarkBackground() ? '#0a0a0a' : '#ffffff',
      ...(icon ? { icon } : {}),
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    sharedChatWindow.on('closed', () => { sharedChatWindow = null })
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      sharedChatWindow.loadURL(`${rendererUrl}?chat_url=${encodeURIComponent(chatUrl)}&name=${encodeURIComponent(templateName)}${ctxParam}`)
    } else {
      const query: Record<string, string> = { chat_url: chatUrl, name: templateName }
      if (ctxSize) query.ctx = String(ctxSize)
      sharedChatWindow.loadFile(join(__dirname, '../renderer/index.html'), { query })
    }
    }  // close block
    })  // close resolveChatUrl().then()
  }

  ipcMain.handle('open-chat-window', (_e, port: number, name: string, ctxSize?: number) => openChatWindow(port, name, ctxSize))
  ipcMain.handle('open-detached-chat-window', async (_e, port: number, name: string) => {
    const chatUrl = await resolveChatUrl(port)
    const templateName = name || `Port ${port}`
    const candidates = [
      join(process.cwd(), 'assets', 'icon.png'),
      join(__dirname, '../../assets/icon.png'),
      join(app.getAppPath(), 'assets', 'icon.png')
    ]
    const icon = candidates.find(existsSync)
    let x: number | undefined
    let y: number | undefined
    const width = 1024
    const height = 768
    const mainWin = BrowserWindow.getAllWindows().find(w => {
      try { const url = w.webContents.getURL(); return !url.includes('chat_url') } catch { return false }
    })
    if (mainWin && !mainWin.isDestroyed()) {
      const bounds = mainWin.getBounds()
      x = Math.round(bounds.x + (bounds.width - width) / 2)
      y = Math.round(bounds.y + (bounds.height - height) / 2)
    }
    const detachedWin = new BrowserWindow({
      width, height, show: true, autoHideMenuBar: true,
      title: 'XLM Studio - Llama-UI',
      titleBarStyle: 'hiddenInset',
      backgroundColor: appShouldUseDarkBackground() ? '#0a0a0a' : '#ffffff',
      ...(icon ? { icon } : {}),
      ...(x !== undefined && y !== undefined ? { x, y } : {}),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl) {
      detachedWin.loadURL(`${rendererUrl}?chat_url=${encodeURIComponent(chatUrl)}&name=${encodeURIComponent(templateName)}&detached=true`)
    } else {
      detachedWin.loadFile(join(__dirname, '../renderer/index.html'), { query: { chat_url: chatUrl, name: templateName, detached: 'true' } })
    }
  })
  ipcMain.handle('notify-tab-moved', (_e, url: string) => {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send('tab-moved-elsewhere', { url })
    })
  })
  ipcMain.handle('stop-model', async (_e, id: string) => {
    const entry = runningProcesses.get(id)
    if (!entry) return { success: true, alreadyStopped: true }
    const { proc, port } = entry
    runningProcesses.delete(id)  // remove immediately so a concurrent Start doesn't see "Already running"
    serverReadyFlags.delete(id)
    modelLoadingFlags.delete(id)
    // Kill the whole process tree (children included) and wait for the process
    // to actually exit. This fixes the Stop→Start race where the port was still
    // bound when the user clicked Start again right after Stop.
    await killProcessTree(proc)
    // Now poll the port until the OS releases the listening socket. This is the
    // critical step: without it, a rapid restart reports "port already in use".
    await waitForPortFree(port, 8000, 100)
    return { success: true }
  })

  // ----- Backends: tracker (global check for updates across all tracked repos) -----
  let cancelBackendDl: (() => void) | null = null

  async function fetchTrackedRelease(tracked: TrackedBackend): Promise<TrackedBackendRelease> {
    const base: TrackedBackendRelease = {
      trackedId: tracked.id,
      folderName: tracked.folderName,
      tagName: '', name: tracked.name, url: '', publishedAt: '',
      isNewer: undefined, assets: []
    }
    try {
      const isMac = process.platform === 'darwin'
      const isLinux = process.platform === 'linux'
      const arch = process.arch
      function platformAssetsFor(rel: any): any[] {
        return (rel.assets || []).filter((a: any) => {
          const n = a.name.toLowerCase()
          if (n.startsWith('cudart-')) return false
          if (isMac) {
            if (!n.endsWith('.tar.gz') || !n.includes('macos')) return false
            if (arch === 'arm64' && !n.includes('arm64')) return false
            if (arch === 'x64' && !n.includes('x64')) return false
            return true
          }
          if (isLinux) {
            if (!n.endsWith('.tar.gz') || !n.includes('ubuntu')) return false
            if (arch === 'arm64' && !n.includes('arm64')) return false
            if (arch === 'x64' && n.includes('arm64')) return false
            return true
          }
          if (!n.endsWith('.zip')) return false
          if (!(n.includes('win') || n.includes('windows'))) return false
          if (arch === 'x64' && n.includes('arm64')) return false
          if (arch === 'arm64' && n.includes('x64')) return false
          return true
        })
      }
      // Bug fix: llama.cpp started publishing periodic semantic-version
      // milestone tags (e.g. "v0.3.0") ALONGSIDE the continuous per-commit
      // "bNNNNN" builds it's always used. The milestone tags are SOURCE-ONLY
      // (no built binaries attached at all) — but /releases/latest just
      // returns whichever release is chronologically newest, so the moment
      // a milestone tag lands, update-checking pointed at a release with
      // nothing to actually download. Worse, a tag like "v0.3.0" also never
      // numerically or exactly matches an installed "bNNNNN" folder name, so
      // it kept reporting "update available" permanently, with no way to
      // ever resolve it. Fetch the releases LIST instead and use the first
      // one (most recent first, GitHub's default ordering) that actually
      // has a real platform binary attached — this skips source-only tags
      // automatically, including any future ones, without hardcoding a
      // specific tag name/pattern to ignore.
      const releases = await fetchJson(`https://api.github.com/repos/${tracked.repo}/releases?per_page=10`) as any
      if (!Array.isArray(releases) || releases.length === 0) {
        return { ...base, error: 'Invalid response from GitHub' }
      }
      let release: any = null
      let platformAssets: any[] = []
      for (const rel of releases) {
        if (rel.draft || rel.prerelease) continue
        const assets = platformAssetsFor(rel)
        if (assets.length > 0) { release = rel; platformAssets = assets; break }
      }
      if (!release) {
        // Nothing in the recent history has a matching binary for this
        // platform at all — fall back to the newest release so we still
        // surface SOMETHING (with an empty asset list) rather than silently
        // reporting nothing at all.
        release = releases[0]
        platformAssets = platformAssetsFor(release)
      }
      const latestNum = parseInt((release.tag_name || '').replace(/^b/, ''), 10)
      let isNewer = true
      // Feature 20/21: Determine if a version of this tracked backend is already
      // installed. The version folder name now matches the release tag exactly,
      // so we check for an exact match OR a numeric build-number match.
      const roots = await backendRoots()
      for (const root of roots) {
        const forkDir = join(root.dir, tracked.folderName)
        if (!existsSync(forkDir)) continue
        for (const v of readdirSync(forkDir, { withFileTypes: true }).filter(d => d.isDirectory())) {
          // Exact tag match (e.g. "b10448" or "TurboQuant b10269-1.5.1").
          if (v.name === release.tag_name) { isNewer = false; break }
          // Substring match for fork-specific naming (e.g. "TurboQuant b10269-1.5.1" contains "b10269").
          if (release.tag_name && v.name.includes(release.tag_name)) { isNewer = false; break }
          // Numeric build-number match (extract first 3-6 digit group).
          const m = v.name.match(/(\d{3,6})/)
          if (m && latestNum && parseInt(m[1], 10) >= latestNum) { isNewer = false; break }
        }
        if (!isNewer) break
      }
      return {
        ...base,
        tagName: release.tag_name,
        name: release.name || release.tag_name,
        url: release.html_url,
        publishedAt: release.published_at,
        isNewer,
        assets: platformAssets.map((a: any) => ({ name: a.name, downloadUrl: a.browser_download_url, size: a.size }))
      }
    } catch (err) {
      return { ...base, error: String(err) }
    }
  }

  // Legacy single check (kept for backward compat with UpdateBanner / Titlebar).
  ipcMain.handle('check-updates', async () => {
    const s = await loadSettings()
    const llamaCpp = s.trackedBackends.find(t => t.id === 'llama-cpp') || s.trackedBackends[0]
    if (!llamaCpp) return { error: 'No tracked backends' }
    const r = await fetchTrackedRelease(llamaCpp)
    const { trackedId, folderName, ...rest } = r
    return rest as ReleaseInfo
  })

  // Global check across ALL tracked backends.
  ipcMain.handle('check-all-backends', async () => {
    const s = await loadSettings()
    const results = await Promise.all(s.trackedBackends.map(t => fetchTrackedRelease(t)))
    return { results }
  })

  // Download a specific tracked backend release into <mainBackendFolder>/<folderName>/<version>/.
  ipcMain.handle('download-release', async (event, opts: {
    url: string
    version: string
    assetName: string
    backendKey: string
  }) => {
    const archivePath = join(app.getPath('temp'), opts.assetName)
    const isTarGz = opts.assetName.toLowerCase().endsWith('.tar.gz')
    try {
      event.sender.send('download-progress', { percent: 0, phase: 'downloading' })
      await new Promise<void>((resolve, reject) => {
        cancelBackendDl = startDownload(opts.url, archivePath, 0,
          (r, t) => event.sender.send('download-progress', { percent: t > 0 ? Math.round(r / t * 100) : 0, phase: 'downloading' }),
          resolve, reject)
      })
      cancelBackendDl = null
      event.sender.send('download-progress', { percent: 100, phase: 'extracting' })
      const versionHint = opts.version || opts.assetName.replace(/\.(zip|tar\.gz)$/i, '')
      const { versionDir } = await smartExtractBackend({
        archivePath,
        backendKey: opts.backendKey,
        versionHint,
        isTarGz
      })
      // Auto-delete outdated backend versions in the same fork folder.
      // Runs immediately after extraction so old versions are cleaned up
      // before the frontend re-reads the installed backends list.
      const cleanup = await cleanupOldBackendVersions(opts.backendKey, versionHint)
      if (cleanup.deleted.length > 0) {
        // Broadcast so any open windows refresh their backend list.
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('backends-changed', { deleted: cleanup.deleted })
        })
      }
      try { unlinkSync(archivePath) } catch (e) { console.error('Failed to cleanup temp file', e) }
      return { success: true, path: versionDir, deletedOld: cleanup.deleted }
    } catch (err) {
      cancelBackendDl = null
      try { unlinkSync(archivePath) } catch (e) { console.error('Failed to cleanup temp file', e) }
      return { success: false, error: String(err) }
    }
  })
  ipcMain.handle('cancel-backend-download', () => {
    if (cancelBackendDl) { cancelBackendDl(); cancelBackendDl = null }
    return { success: true }
  })

  ipcMain.handle('open-folder', (_e, folderPath: string) => shell.openPath(folderPath))
  ipcMain.handle('get-paths', async () => ({
    models: MODELS_DIR,
    templates: TEMPLATES_DIR,
    backend: BACKEND_DIR,
    mainModelFolder: await resolveMainModelFolder(),
    mainBackendFolder: await resolveMainBackendFolder()
  }))
  ipcMain.handle('open-external', (_e, url: string) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url)
  })

  // ----- HuggingFace -----
  ipcMain.handle('hf-search', async (_e, query: string, sort = 'downloads', direction = -1) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=24&sort=${sort}&direction=${direction}`) as any
      if (!Array.isArray(data)) {
        if (data && data.error) return { error: data.error }
        return { error: 'Unknown response from Hugging Face' }
      }
      return data.map(m => ({ id: m.id, author: m.author || m.id.split('/')[0] || '', name: m.id.split('/').pop() || m.id, downloads: m.downloads || 0, likes: m.likes || 0, tags: m.tags || [], lastModified: m.createdAt || m.lastModified || '' }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-get-files', async (_e, repoId: string) => {
    try {
      const data = await fetchJson(`https://huggingface.co/api/models/${repoId}/tree/main`) as any[]
      return data.filter((f: any) => f.type === 'file' && f.path.endsWith('.gguf')).map((f: any) => ({
        name: f.path,
        size: f.size || 0,
        downloadUrl: `https://huggingface.co/${repoId}/resolve/main/${f.path}`
      }))
    } catch (err) { return { error: String(err) } }
  })
  ipcMain.handle('hf-download-model', async (_event, opts: { repoId: string; filename: string; downloadUrl: string }) => {
    const id = opts.filename
    if (downloadTasks.has(id)) {
      const existing = downloadTasks.get(id)!
      if (existing.phase === 'downloading') return { success: false, error: 'Already downloading' }
    }
    // Route to the main (starred) model folder, under a subfolder named after the repo page.
    const sub = (opts.repoId.split('/').pop() || 'downloads').trim() || 'downloads'
    const mainFolder = await resolveMainModelFolder()
    const destDir = join(mainFolder, sub)
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true })
    const finalPath = join(destDir, opts.filename)
    const tmpPath = finalPath + '.tmp'
    const task: DownloadTask = { id, url: opts.downloadUrl, filename: opts.filename, destPath: finalPath, receivedBytes: 0, totalBytes: 0, speed: 0, phase: 'downloading', repoId: opts.repoId }
    const broadcast = (force = false) => {
      if (!force && !canBroadcast(task.id)) return
      const percent = task.totalBytes > 0 ? Math.round(task.receivedBytes / task.totalBytes * 100) : 0
      const payload = {
        id: task.id, filename: task.filename, phase: task.phase,
        percent, speed: task.speed, destPath: task.destPath,
        receivedBytes: task.receivedBytes, totalBytes: task.totalBytes,
        repoId: task.repoId
      }
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('hf-download-progress', payload)
      })
    }
    task.cancelFn = startDownload(
      opts.downloadUrl, tmpPath, 0,
      (r, t, speed) => { task.receivedBytes = r; task.totalBytes = t; task.speed = speed; broadcast() },
      () => {
        try { renameSync(tmpPath, finalPath) } catch {}
        task.phase = 'done'; task.speed = 0; broadcast(true)
        setTimeout(() => { downloadTasks.delete(id); broadcastTimes.delete(id) }, 10000)
      },
      (err) => { task.phase = 'error'; task.speed = 0; broadcast(true); console.error('HF download error:', err) }
    )
    downloadTasks.set(id, task)
    return { success: true }
  })
  ipcMain.handle('hf-open-models-dir', async () => shell.openPath(await resolveMainModelFolder()))

  ipcMain.handle('onDownloadProgress', () => {})
  ipcMain.handle('removeDownloadListener', () => {})
  ipcMain.handle('get-version', () => app.getVersion())

  // ----- Theme -----
  ipcMain.handle('get-theme', async () => {
    const s = await loadSettings()
    return s.theme
  })
  ipcMain.handle('set-theme', async (_e, theme: ThemePref) => {
    const s = await loadSettings()
    s.theme = (['system', 'dark', 'light'].includes(theme) ? theme : 'system') as ThemePref
    await saveSettings(s)
    applyNativeTheme(s.theme)
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) win.webContents.send('theme-changed', s.theme)
    })
    return { success: true, theme: s.theme }
  })
  ipcMain.handle('get-system-theme', () => {
    try {
      // nativeTheme.shouldUseDarkColors is the most reliable signal.
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    } catch {
      return 'dark' // fallback per spec
    }
  })

  // ----- CPU info (for thread slider bounds + recommended defaults) -----
  ipcMain.handle('get-cpu-info', async () => {
    const os = await import('os')
    const cpus = os.cpus()
    let physicalCores = cpus.length
    let modelName = cpus[0]?.model || 'Unknown CPU'
    try {
      const si = (await import('systeminformation')).default
      const cpu = await si.cpu()
      if (cpu.physicalCores && cpu.physicalCores > 0) physicalCores = cpu.physicalCores
      else if (cpu.cores && cpu.cores > 0) physicalCores = cpu.cores
      if (cpu.brand) modelName = `${cpu.manufacturer || ''} ${cpu.brand}`.trim()
    } catch {
      // systeminformation unavailable — fall back to logical count.
    }
    return {
      physicalCores,
      logicalCores: cpus.length,
      modelName
    }
  })

  // ----- GGUF speculation auto-detection (Item 2: full tier rework) -----
  // Returns the HIGHEST-tier speculative decoding method detected for a
  // model, considering both:
  //  (a) internal metadata (Tier 1, Native MTP) — a static fact of the
  //      model's own GGUF metadata (see detectHasNativeMtp / get-gguf-metadata's
  //      hasNativeMtp field). Passed in by the caller (already known from the
  //      SAME cached, disk-persisted metadata the rest of the UI reads —
  //      extracted once per model, never re-scanned here).
  //  (b) sidecar files (Tiers 2-5 — separate .gguf files in the SAME folder
  //      as the base model, classified by filename keyword per the tier
  //      table), the same general pattern as mmproj sidecar detection. This
  //      part IS re-scanned every call — sidecars are just files, the user
  //      can add or remove them at any time, so this should always reflect
  //      the current folder contents rather than a cached-forever answer.
  // Also returns every OTHER candidate found (not just the winner), so the
  // UI can offer manual selection among them — e.g. switching to a lower-
  // tier Draft Model even when a higher-tier method was auto-selected, or
  // choosing between multiple same-tier sidecar files.
  //
  // Rewrite (this round): this used to ALSO do its own internal MTP scan via
  // readGgufStructuralText — a full sequential walk of every tensor's
  // name/dims/type/offset (thousands of small file reads for a model with a
  // large tensor count), independent of and redundant with the metadata
  // parser that get-gguf-metadata already runs and caches. That redundant
  // scan was slow enough on cold disk I/O to occasionally not complete
  // before something gave up on it, and any error anywhere in its very long
  // sequential read chain silently produced "nothing found" with no
  // indication why — which is exactly what "randomly doesn't detect
  // anything, but works if you leave it open a while / re-extract metadata
  // first (warms the OS page cache)" looks like. Since Tier 1 status is a
  // static fact of the model file that get-gguf-metadata already establishes
  // once and caches to disk, there's no reason to ever re-derive it here at
  // all — the caller just passes it in.
  ipcMain.handle('detect-speculation', async (_e, modelPath: string, hasNativeMtp?: boolean) => {
    try {
      if (!modelPath || !existsSync(modelPath)) return { tier: 0, method: 'off' as const, candidates: [] }

      const internalMtpFound = !!hasNativeMtp
      const internalReason = 'MTP (Multi-Token Prediction / nextn) declared in model metadata'

      // Sidecar scan — every OTHER .gguf-family file in the same folder,
      // classified by filename. Collect every match (not just the best) so
      // the UI can offer manual selection among all of them.
      const folder = dirname(modelPath)
      const baseName = basename(modelPath)
      const sidecarCandidates: { tier: number; method: SpecMethod; label: string; path: string; name: string }[] = []
      try {
        const entries = await fsPromises.readdir(folder, { withFileTypes: true })
        for (const e of entries) {
          if (!e.isFile() || e.name === baseName) continue
          const cls = classifySidecarFilename(e.name)
          if (!cls) continue
          try {
            const st = await fsPromises.stat(join(folder, e.name))
            if (!isSpecDecodeSidecarFile(e.name, st.size)) continue
            sidecarCandidates.push({ tier: cls.tier, method: cls.method, label: cls.label, path: join(folder, e.name), name: e.name })
          } catch {}
        }
      } catch {}
      sidecarCandidates.sort((a, b) => b.tier - a.tier)

      const candidates: { tier: number; method: SpecMethod; label: string; path: string | null; name: string | null; reason: string }[] = []
      if (internalMtpFound) {
        candidates.push({ tier: 1, method: 'native-mtp', label: 'Native MTP', path: null, name: null, reason: internalReason })
      }
      for (const c of sidecarCandidates) {
        candidates.push({ tier: c.tier, method: c.method, label: c.label, path: c.path, name: c.name, reason: `${c.label} sidecar detected: ${c.name}` })
      }

      if (candidates.length === 0) return { tier: 0, method: 'off' as const, candidates: [] }
      // Winner = highest tier (ties broken by whichever was found first —
      // internal MTP, if tied with a sidecar somehow, since tiers are
      // distinct integers this practically never ties in normal use).
      const winner = [...candidates].sort((a, b) => b.tier - a.tier)[0]
      return { tier: winner.tier, method: winner.method, path: winner.path, reason: winner.reason, candidates }
    } catch (err) {
      return { tier: 0, method: 'off' as const, candidates: [], error: String(err) }
    }
  })

  // ----- GGUF metadata parser (features 12/13/14/16/29) -----
  // Parses the GGUF binary header to extract block_count, context_length,
  // expert_count, chat_template, hidden_size, kv_heads, AND the full attention
  // geometry needed for BPW-accurate KV-cache VRAM math (head_count,
  // key_length, value_length, sliding_window, MLA kv_lora_rank/qk_rope_head_dim,
  // file_type). Uses a typed reader that walks the metadata KV array and tensor
  // info array.
  ipcMain.handle('get-gguf-metadata', async (_e, modelPath: string) => {
    // Task 1: check the persistent cache first — metadata is stable for a given
    // file (it's read from the GGUF header), so caching avoids re-parsing on
    // every view. The cache is pruned in `list-models` when files disappear.
    // Bug fix: only trust a cached entry if it was written by the CURRENT
    // metadata schema. Older entries (missing e.g. fullAttentionInterval,
    // or any other field added since) fall through and get re-extracted —
    // otherwise a stale cache silently masks any fix to the extraction logic.
    if (modelPath && metadataCache[modelPath] && metadataCache[modelPath].schemaVersion === METADATA_SCHEMA_VERSION) {
      return metadataCache[modelPath]
    }
    // Broadcast that extraction is starting (for the renderer notification).
    if (modelPath) {
      const fn = basename(modelPath)
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('metadata-extracting', { modelPath, name: fn, status: 'extracting' })
      })
    }
    const result: any = {
      blockCount: null, contextLength: null, expertCount: null,
      chatTemplate: null, hiddenSize: null, kvHeads: null,
      modelName: null, architecture: null, isMoe: false, fileSizeMB: 0,
      // BPW-accurate VRAM math (Task 3):
      headCount: null, headCountKv: null, keyLength: null, valueLength: null,
      slidingWindow: null, kvLoraRank: null, qkRopeHeadDim: null,
      expertUsedCount: null, expertSharedCount: null,
      fileType: null, fileTypeValue: null, fileTypeInternal: null, fileTypeFilenameHint: null, vocabSize: null, fullAttentionInterval: null,
      // Speculative decoding Tier 1 — see detectHasNativeMtp above. Extracted
      // once here (same pass as everything else) and cached with the rest of
      // this metadata, instead of a separate re-scan every time the
      // Speculative Decoding widget wants to know.
      hasNativeMtp: false
    }
    try {
      if (!modelPath || !existsSync(modelPath)) return { ...result, error: 'File not found' }
      const st = await fsPromises.stat(modelPath)
      result.fileSizeMB = Math.round(st.size / (1024 * 1024))

      // ====== PRIORITY 1: Use native llama-gguf tool if available ======
      // This uses the C gguf_init_from_file() implementation, guaranteeing
      // 100% correct parsing for ANY GGUF file, regardless of version or
      // converter quirks (Unsloth, official, etc.)
      const ggufTool = await findGgufTool()
      if (ggufTool) {
        console.log('[GGUF] Using native llama-gguf tool:', ggufTool)
        const toolOutput = await runGgufTool(ggufTool, modelPath)
        if (toolOutput && toolOutput.length > 50) {
          console.log('[GGUF] llama-gguf output length:', toolOutput.length)
          const kv = parseGgufToolOutput(toolOutput)
          console.log('[GGUF] llama-gguf parsed keys:', Object.keys(kv).join(', '))
          // Extract values from the native tool output.
          // The tool prints keys like "llama.block_count", "llama.context_length", etc.
          const arch = (kv['general.architecture'] || kv['architecture'] || '').toLowerCase()
          result.architecture = arch || null
          result.modelName = kv['general.name'] || kv['name'] || null
          result.chatTemplate = kv['tokenizer.chat_template'] || kv['chat_template'] || null
          // Resolve architecture-specific keys.
          const resolve = (suffix: string): number | null => {
            const patterns = [`${arch}.${suffix}`, suffix]
            for (const p of patterns) {
              if (kv[p] !== undefined) {
                const n = parseInt(kv[p], 10)
                if (!isNaN(n)) return n
              }
            }
            for (const k of Object.keys(kv)) {
              if (k.endsWith(`.${suffix}`)) {
                const n = parseInt(kv[k], 10)
                if (!isNaN(n)) return n
              }
            }
            return null
          }
          result.blockCount = resolve('block_count')
          result.contextLength = resolve('context_length')
          result.expertCount = resolve('expert_count')
          result.hiddenSize = resolve('embedding_length')
          result.kvHeads = resolve('attention.head_count_kv')
          // BPW math (Task 3): full attention geometry.
          result.headCount = resolve('attention.head_count')
          result.headCountKv = result.kvHeads
          result.keyLength = resolve('attention.key_length')
          result.valueLength = resolve('attention.value_length')
          result.slidingWindow = resolve('attention.sliding_window')
          result.kvLoraRank = resolve('attention.kv_lora_rank')
          result.qkRopeHeadDim = resolve('attention.qk_rope_head_dim')
          result.expertUsedCount = resolve('expert_used_count')
          result.expertSharedCount = resolve('expert_shared_count')
          // Task 6: hybrid SSM/attention — only every Nth layer carries KV.
          result.fullAttentionInterval = resolve('full_attention_interval') || resolve('attention.full_attention_interval')
          // file_type: numeric enum → human-readable name for the BPW table.
          const ftVal = resolve('file_type')
          result.fileTypeValue = ftVal
          result.fileTypeInternal = ftVal !== null ? ggufFileTypeName(ftVal) : null
          result.fileTypeFilenameHint = parseQuantFromFilename(modelPath)
          // Bug fix (item 2, corrected): fileType now PRIMARILY reflects the
          // internal metadata (matches what llama-server itself reports when
          // loading the model) — see parseQuantFromFilename comment above.
          // The filename-derived label is only used as a fallback when the
          // internal field is missing entirely.
          result.fileType = result.fileTypeInternal || result.fileTypeFilenameHint
          // vocab size: count of tokenizer.ggml.tokens array (if present).
          const vocabArrLen = (() => {
            // The native tool may print "tokenizer.ggml.tokens" as a count or array.
            const v = kv['tokenizer.ggml.tokens']
            if (v !== undefined) {
              const n = parseInt(v, 10)
              if (!isNaN(n) && n > 0) return n
            }
            return null
          })()
          result.vocabSize = vocabArrLen
          result.isMoe = (result.expertCount || 0) > 0
          result.hasNativeMtp = detectHasNativeMtp(kv)
          // If we got the essential fields, return immediately — no need for JS fallback.
          if (result.blockCount && result.contextLength) {
            console.log('[GGUF] Native tool succeeded: blockCount=' + result.blockCount + ' contextLength=' + result.contextLength + ' chatTemplate=' + (result.chatTemplate ? 'yes' : 'no'))
            // Bug fix: the native-tool path previously returned WITHOUT ever
            // writing to metadataCache/disk — every single call for a model
            // whose metadata only the native tool could resolve was forced to
            // re-run the tool from scratch (this branch), defeating the whole
            // point of the persisted cache. Stamp + persist it like the JS
            // fallback path does below.
            result.schemaVersion = METADATA_SCHEMA_VERSION
            if (modelPath) {
              metadataCache[modelPath] = result
              saveMetadataCache()
              const fn = basename(modelPath)
              BrowserWindow.getAllWindows().forEach(win => {
                if (!win.isDestroyed()) {
                  win.webContents.send('gguf-metadata-updated', { modelPath, meta: result })
                  win.webContents.send('metadata-extracting', { modelPath, name: fn, status: 'done' })
                }
              })
            }
            return result
          }
          // If chatTemplate is missing but everything else is found, try the JS fallback for just that.
          if (!result.chatTemplate) {
            console.log('[GGUF] Native tool missing chat_template — trying JS fallback for that field')
          }
        } else {
          console.log('[GGUF] llama-gguf produced no output — falling back to JS parser')
        }
      } else {
        console.log('[GGUF] No llama-gguf tool found — using JS parser only')
      }

      // ====== FALLBACK: JS parser (if native tool not available or failed) ======
      const fd = await fsPromises.open(modelPath, 'r')
      // Read header: magic(4) + version(4) + tensor_count(8) + metadata_kv_count(8)
      const header = Buffer.alloc(24)
      await fd.read(header, 0, 24, 0)
      const magic = header.toString('ascii', 0, 4)
      if (magic !== 'GGUF') { await fd.close(); return { ...result, error: 'Not a valid GGUF file' } }
      const version = header.readUInt32LE(4)
      let offset = 8
      let tensorCount: number
      let kvCount: number
      if (version >= 3) {
        // GGUF v3+: tensor_count (u64) and metadata_kv_count (u64)
        tensorCount = Number(readU64(header, offset)); offset += 8
        kvCount = Number(readU64(header, offset)); offset += 8
      } else {
        // GGUF v1/v2: tensor_count (u32) and metadata_kv_count (u32)
        tensorCount = header.readUInt32LE(offset); offset += 4
        kvCount = header.readUInt32LE(offset); offset += 4
      }
      console.log('[GGUF] version:', version, '| tensorCount:', tensorCount, '| kvCount:', kvCount)

      // We'll read metadata KV pairs sequentially from the file. Each KV is:
      // key(gguf_string) + value_type(u32) + value(varies by type)
      // gguf_string = u64 length + bytes (no null terminator) [v3+] or u32 [v1/v2]
      const chunkSize = 512 * 1024 // 512 KB read window
      // v3: header = 4(magic) + 4(version) + 8(tensor_count) + 8(kv_count) = 24
      // v1/v2: header = 4(magic) + 4(version) + 4(tensor_count) + 4(kv_count) = 16
      let fileOffset = version >= 3 ? 24 : 16
      const readBuf = Buffer.alloc(chunkSize)
      async function readBytes(n: number): Promise<Buffer> {
        const out = Buffer.alloc(n)
        let read = 0
        while (read < n) {
          const start = Math.floor(fileOffset / chunkSize) * chunkSize
          const offInChunk = fileOffset % chunkSize
          const avail = Math.min(chunkSize - offInChunk, n - read)
          await fd.read(readBuf, 0, chunkSize, start)
          readBuf.copy(out, read, offInChunk, offInChunk + avail)
          fileOffset += avail
          read += avail
        }
        return out
      }
      async function readString(): Promise<string> {
        // GGUF v3+: string length is u64. v1/v2: u32.
        const lenBytes = version >= 3 ? 8 : 4
        const lenBuf = await readBytes(lenBytes)
        const len = version >= 3 ? Number(readU64(lenBuf, 0)) : lenBuf.readUInt32LE(0)
        if (len > 10 * 1024 * 1024) return '' // sanity cap at 10 MB
        const strBuf = await readBytes(len)
        return strBuf.toString('utf-8')
      }
      async function readValue(type: number): Promise<any> {
        // GGUF metadata value types (from the official spec):
        // https://github.com/ggerganov/ggml/blob/master/docs/gguf.md
        switch (type) {
          case 0: { const b = await readBytes(1); return b.readUInt8(0) }         // UINT8
          case 1: { const b = await readBytes(1); return b.readInt8(0) }          // INT8
          case 2: { const b = await readBytes(2); return b.readUInt16LE(0) }      // UINT16
          case 3: { const b = await readBytes(2); return b.readInt16LE(0) }       // INT16
          case 4: { const b = await readBytes(4); return b.readUInt32LE(0) }      // UINT32
          case 5: { const b = await readBytes(4); return b.readInt32LE(0) }       // INT32
          case 6: { const b = await readBytes(4); return b.readFloatLE(0) }       // FLOAT32
          case 7: { const b = await readBytes(1); return b[0] !== 0 }             // BOOL
          case 8: { return await readString() }                                    // STRING
          case 9: { // ARRAY
            const tBuf = await readBytes(4)
            const arrType = tBuf.readUInt32LE(0)
            // GGUF v3+: array length is u64. v1/v2: u32.
            const arrLenBytes = version >= 3 ? 8 : 4
            const lBuf = await readBytes(arrLenBytes)
            const arrLen = version >= 3 ? Number(readU64(lBuf, 0)) : lBuf.readUInt32LE(0)
            const arr: any[] = []
            for (let i = 0; i < arrLen && i < 100000; i++) arr.push(await readValue(arrType))
            return arr
          }
          case 10: { const b = await readBytes(8); return Number(b.readBigUInt64LE(0)) } // UINT64
          case 11: { const b = await readBytes(8); return Number(b.readBigInt64LE(0)) }  // INT64
          case 12: { const b = await readBytes(8); return b.readDoubleLE(0) }            // FLOAT64
          default: return null
        }
      }

      // Walk metadata KV pairs — with per-KV error recovery so a single bad
      // value doesn't kill the entire parse.
      let architecture = ''
      const allMeta: Record<string, any> = {}  // store all keys for robust resolution
      for (let i = 0; i < kvCount && i < 500; i++) {
        try {
          const key = await readString()
          const typeBuf = await readBytes(4)
          const valueType = typeBuf.readUInt32LE(0)
          // Skip arrays entirely (they can be huge and we don't need them).
          // Read just enough to advance the file offset.
          if (valueType === 9) {
            // ARRAY: read array type + length, then skip all elements
            const arrTypeBuf = await readBytes(4)
            const arrType = arrTypeBuf.readUInt32LE(0)
            const arrLenBytes = version >= 3 ? 8 : 4
            const lBuf = await readBytes(arrLenBytes)
            const arrLen = version >= 3 ? Number(readU64(lBuf, 0)) : lBuf.readUInt32LE(0)
            // Skip array elements by reading and discarding
            for (let j = 0; j < Math.min(arrLen, 1000000); j++) {
              await readValue(arrType)
            }
            allMeta[key.toLowerCase()] = []
            continue
          }
          const value = await readValue(valueType)
          const lk = key.toLowerCase()
          allMeta[lk] = value
          if (lk === 'general.architecture' && !result.architecture) { architecture = String(value); result.architecture = architecture }
          if (lk === 'general.name' && !result.modelName) result.modelName = String(value)
          if (lk === 'tokenizer.chat_template' && !result.chatTemplate) result.chatTemplate = String(value)
        } catch (kvErr) {
          // If we hit an error on this KV pair, log it and stop parsing further
          // (we can't reliably continue since fileOffset may be wrong).
          console.log('[GGUF] Parse error at KV pair', i, ':', String(kvErr))
          break
        }
      }
      // Debug: log all metadata keys to help diagnose missing fields.
      console.log('[GGUF] architecture:', architecture, '| metadata keys found:', Object.keys(allMeta).length, '| keys:', Object.keys(allMeta).join(', '))
      // Resolve architecture-specific keys AFTER the full walk (architecture
      // might be set late in the metadata). Check arch-prefixed, then any key
      // ending with the suffix.
      const arch = architecture.toLowerCase()
      const resolve = (suffix: string): number | null => {
        // 1. Exact arch-prefixed match (e.g. "llama.block_count")
        if (arch && allMeta[`${arch}.${suffix}`] !== undefined) return Number(allMeta[`${arch}.${suffix}`])
        // 2. Unprefixed match (e.g. "block_count")
        if (allMeta[suffix] !== undefined) return Number(allMeta[suffix])
        // 3. Any key ending with the suffix (e.g. "llama.block_count" when arch is unknown)
        for (const k of Object.keys(allMeta)) {
          if (k.endsWith(`.${suffix}`) && allMeta[k] !== undefined) return Number(allMeta[k])
        }
        return null
      }
      // Fix 3: For MoE models, block_count might be stored as "llama.block_count"
      // but some converters store it differently. Try multiple variants.
      // Only set if the native tool didn't already find it.
      if (!result.blockCount) result.blockCount = resolve('block_count')
      if (!result.blockCount) result.blockCount = resolve('n_layers') || resolve('n_blocks')
      if (!result.contextLength) result.contextLength = resolve('context_length')
      if (!result.contextLength) result.contextLength = resolve('n_ctx') || resolve('max_context_length')
      if (!result.expertCount) result.expertCount = resolve('expert_count')
      if (!result.expertCount) result.expertCount = resolve('n_experts')
      // expert_used_count: the number of active experts used for generation.
      if (!(result as any).expertUsedCount) {
        (result as any).expertUsedCount = resolve('expert_used_count') || resolve('n_experts_used')
      }
      if (!result.hiddenSize) result.hiddenSize = resolve('embedding_length')
      if (!result.hiddenSize) result.hiddenSize = resolve('n_embd')
      if (!result.kvHeads) {
        const kvHeadsVal = (() => {
          if (arch && allMeta[`${arch}.attention.head_count_kv`] !== undefined) return Number(allMeta[`${arch}.attention.head_count_kv`])
          if (allMeta['attention.head_count_kv'] !== undefined) return Number(allMeta['attention.head_count_kv'])
          for (const k of Object.keys(allMeta)) {
            if (k.endsWith('.attention.head_count_kv')) return Number(allMeta[k])
          }
          return null
        })()
        result.kvHeads = kvHeadsVal
      }
      // BPW math (Task 3): full attention geometry from the JS fallback too.
      if (!result.headCount) result.headCount = resolve('attention.head_count')
      if (!result.headCountKv) result.headCountKv = result.kvHeads
      if (!result.keyLength) result.keyLength = resolve('attention.key_length')
      if (!result.valueLength) result.valueLength = resolve('attention.value_length')
      if (!result.slidingWindow) result.slidingWindow = resolve('attention.sliding_window')
      if (!result.kvLoraRank) result.kvLoraRank = resolve('attention.kv_lora_rank')
      if (!result.qkRopeHeadDim) result.qkRopeHeadDim = resolve('attention.qk_rope_head_dim')
      if (!result.expertSharedCount) result.expertSharedCount = resolve('expert_shared_count')
      // Task 6: hybrid SSM/attention — JS fallback extraction too.
      if (!(result as any).fullAttentionInterval) {
        (result as any).fullAttentionInterval = resolve('full_attention_interval') || resolve('attention.full_attention_interval')
      }
      if (!result.fileTypeValue) {
        const ftv = resolve('file_type')
        result.fileTypeValue = ftv
        if (ftv !== null) (result as any).fileTypeInternal = ggufFileTypeName(ftv)
      }
      // Bug fix (item 2, corrected): prefer internal metadata (matches
      // llama-server's own reporting) — see native-tool path above.
      if (!(result as any).fileTypeFilenameHint) {
        (result as any).fileTypeFilenameHint = parseQuantFromFilename(modelPath)
      }
      if (!result.fileType) {
        result.fileType = (result as any).fileTypeInternal || (result as any).fileTypeFilenameHint || null
      }
      // vocab size: count of tokenizer.ggml.tokens array (the JS parser stores
      // arrays as [] so we can't get the length here; best-effort via vocab_size key).
      if (!result.vocabSize) result.vocabSize = resolve('tokenizer.ggml.tokens.count') || resolve('vocab_size')
      if (!result.hasNativeMtp) result.hasNativeMtp = detectHasNativeMtp(allMeta)

      // Fix 1/2: Fallback byte-scan — if the structured parse failed to find
      // block_count, context_length, or chat_template, do a raw byte search
      // in the first 8 MB of the file. This catches cases where the structured
      // parse broke partway through due to a large array or parse error.
      if (!result.blockCount || !result.contextLength || !result.chatTemplate) {
        try {
          // Re-open from the beginning and read the first 8 MB
          const scanFd = await fsPromises.open(modelPath, 'r')
          const scanBuf = Buffer.alloc(16 * 1024 * 1024) // 16 MB scan window (increased for large tokenizers)
          const { bytesRead } = await scanFd.read(scanBuf, 0, scanBuf.length, 0)
          await scanFd.close()
          const scanStr = scanBuf.subarray(0, bytesRead).toString('latin1')
          const lowerScan = scanStr.toLowerCase()
          // Cheap safety net: if the structured KV walk broke early (or the
          // model has enough metadata that nextn_predict_layers falls outside
          // this parser's 500-KV cap) and hasNativeMtp is still unset, a raw
          // substring check over this same already-read 16 MB prefix is
          // free — no extra I/O, no full tensor-list walk like the old
          // dedicated scan used to require.
          if (!result.hasNativeMtp && (lowerScan.includes('nextn_predict_layers') || lowerScan.includes('multi_token_prediction'))) {
            result.hasNativeMtp = true
          }

          // Helper: find a metadata key in the byte stream and read the value
          // that follows it. In GGUF, after a string key comes a u32 value type,
          // then the value. We search for the key bytes, then parse forward.
          function findUint32AfterKey(keyName: string): number | null {
            // The key is stored as: u64 length + UTF-8 bytes + u32 type + value
            const keyBytes = Buffer.from(keyName, 'utf-8')
            const keyIdx = scanBuf.indexOf(keyBytes, 0, 'latin1')
            if (keyIdx === -1) return null
            // After the key bytes, there should be a u32 value type at offset keyIdx + keyBytes.length
            // But the key is preceded by a u64 length. We need to find the START of the length.
            // Actually, since we found the key bytes, the u32 type is right after:
            const afterKey = keyIdx + keyBytes.length
            if (afterKey + 4 > bytesRead) return null
            const valueType = scanBuf.readUInt32LE(afterKey)
            // For UINT32 (type 4), the value is the next 4 bytes.
            if (valueType === 4 || valueType === 5) {
              const valOffset = afterKey + 4
              if (valOffset + 4 > bytesRead) return null
              return scanBuf.readUInt32LE(valOffset)
            }
            return null
          }

          function findStringAfterKey(keyName: string): string | null {
            const keyBytes = Buffer.from(keyName, 'utf-8')
            const keyIdx = scanBuf.indexOf(keyBytes, 0, 'latin1')
            if (keyIdx === -1) return null
            const afterKey = keyIdx + keyBytes.length
            if (afterKey + 4 > bytesRead) return null
            const valueType = scanBuf.readUInt32LE(afterKey)
            // For STRING (type 8), the value is u64 length + UTF-8 bytes.
            if (valueType === 8) {
              const lenOffset = afterKey + 4
              if (lenOffset + 8 > bytesRead) return null
              const strLen = Number(scanBuf.readBigUInt64LE(lenOffset))
              if (strLen <= 0 || strLen > 1024 * 1024) return null
              const strStart = lenOffset + 8
              if (strStart + strLen > bytesRead) return null
              return scanBuf.subarray(strStart, strStart + strLen).toString('utf-8')
            }
            return null
          }

          // Try various key patterns for block_count
          if (!result.blockCount) {
            const patterns = [
              `${arch}.block_count`, 'llama.block_count', 'block_count',
              'qwen2moe.block_count', 'qwen2.block_count', 'gpt2.block_count',
              'llm.block_count', 'n_layers', 'qwen3.block_count',
              'qwen3moe.block_count', 'deepseek.block_count',
              'stablelm.block_count', 'falcon.block_count',
              'mpt.block_count', 'refact.block_count'
            ]
            for (const p of patterns) {
              const v = findUint32AfterKey(p)
              if (v !== null && v > 0 && v < 100000) {
                result.blockCount = v
                console.log('[GGUF] Fallback found block_count via key:', p, '=', v)
                break
              }
            }
          }

          // Try various key patterns for context_length
          if (!result.contextLength) {
            const patterns = [
              `${arch}.context_length`, 'llama.context_length', 'context_length',
              'qwen2moe.context_length', 'qwen2.context_length', 'n_ctx',
              'llm.context_length', 'max_context_length', 'max_sequence_length',
              'qwen3.context_length', 'qwen3moe.context_length',
              'deepseek.context_length', 'max_position_embeddings'
            ]
            for (const p of patterns) {
              const v = findUint32AfterKey(p)
              if (v !== null && v > 0 && v < 10000000) {
                result.contextLength = v
                console.log('[GGUF] Fallback found context_length via key:', p, '=', v)
                break
              }
            }
          }

          // Try various key patterns for chat_template
          if (!result.chatTemplate) {
            const patterns = [
              'tokenizer.chat_template', 'chat_template', 'general.chat_template',
              'tokenizer.chat_template_jinja', 'general.chat_template_jinja'
            ]
            for (const p of patterns) {
              const v = findStringAfterKey(p)
              if (v !== null && v.length > 0) {
                result.chatTemplate = v
                console.log('[GGUF] Fallback found chat_template via key:', p, '(len:', v.length, ')')
                break
              }
            }
          }

          // Try expert_count
          if (!result.expertCount) {
            const patterns = [`${arch}.expert_count`, 'llama.expert_count', 'expert_count', 'qwen2moe.expert_count', 'n_experts']
            for (const p of patterns) {
              const v = findUint32AfterKey(p)
              if (v !== null && v > 0 && v < 10000) {
                result.expertCount = v
                console.log('[GGUF] Fallback found expert_count via key:', p, '=', v)
                break
              }
            }
          }

          // Try expert_used_count
          if (!(result as any).expertUsedCount) {
            const patterns = [`${arch}.expert_used_count`, 'llama.expert_used_count', 'expert_used_count', 'qwen2moe.expert_used_count', 'n_experts_used']
            for (const p of patterns) {
              const v = findUint32AfterKey(p)
              if (v !== null && v > 0 && v < 10000) {
                (result as any).expertUsedCount = v
                console.log('[GGUF] Fallback found expert_used_count via key:', p, '=', v)
                break
              }
            }
          }

          // If still no expert_count, check for MoE tensor names in the byte stream
          if (!result.expertCount) {
            if (lowerScan.includes('ffn_gate_ex') || lowerScan.includes('ffn_exp') || lowerScan.includes('expert')) {
              result.isMoe = true
              console.log('[GGUF] Fallback: MoE tensor names detected in byte scan')
            }
          }
        } catch (scanErr) {
          console.log('[GGUF] Fallback byte scan error:', String(scanErr))
        }
      }

      // If expert_count metadata wasn't found, scan tensor names for expert indicators.
      if (result.expertCount === null) {
        // Read tensor info: each is name(gguf_string) + n_dims(u32) + dims(u64*n) + dtype(u32) + offset(u64)
        let expertTensorsFound = 0
        for (let i = 0; i < Math.min(tensorCount, 2000); i++) {
          const tname = await readString()
          if (tname.includes('ffn_gate_ex') || tname.includes('ffn_exp')) expertTensorsFound++
          if (expertTensorsFound > 0) break // one is enough to know it's MoE
          // Skip dims + dtype + offset to advance
          const ndBuf = await readBytes(4)
          const ndims = ndBuf.readUInt32LE(0)
          if (ndims > 0 && ndims < 10) await readBytes(8 * ndims) // dims
          await readBytes(4 + 8) // dtype + offset
        }
        if (expertTensorsFound > 0) {
          result.isMoe = true
          // Can't determine exact count from name scan alone; leave expertCount null
          // but mark isMoe so the UI shows the MoE block with a fallback max.
        }
      } else {
        result.isMoe = result.expertCount > 0
      }
      await fd.close()
      // Task 1: cache the extracted metadata + broadcast so the renderer updates
      // its store (and any open CmdParamsEditor) without a second fetch.
      if (modelPath && !result.error) {
        result.schemaVersion = METADATA_SCHEMA_VERSION
        metadataCache[modelPath] = result
        saveMetadataCache()
        const fn = basename(modelPath)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) {
            win.webContents.send('gguf-metadata-updated', { modelPath, meta: result })
            win.webContents.send('metadata-extracting', { modelPath, name: fn, status: 'done' })
          }
        })
      }
      return result
    } catch (err) {
      // Broadcast the error so the renderer can clear the notification.
      if (modelPath) {
        const fn = basename(modelPath)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed()) win.webContents.send('metadata-extracting', { modelPath, name: fn, status: 'error' })
        })
      }
      return { ...result, error: String(err) }
    }
  })

  // ----- VRAM telemetry (feature 14) -----
  // GPU detection strategy (in priority order):
  //   1. nvidia-smi            → NVIDIA GPUs (free + total + name, accurate).
  //   2. systeminformation     → AMD / Intel GPUs (name + total VRAM via WMI/PCI).
  //   3. Linux amdgpu sysfs    → accurate free VRAM for AMD on Linux.
  // Previously this only ever tried nvidia-smi, so a machine with an AMD GPU
  // (e.g. RX 9070 XT) was reported as "NVIDIA GPU (0 MB VRAM)". The fallbacks
  // below detect the real vendor + name and report a best-effort free VRAM.
  ipcMain.handle('get-vram-info', async () => {
    try {
      const isWin = process.platform === 'win32'
      const isLinux = process.platform === 'linux'
      if (!isWin && !isLinux) {
        return { freeVRAMMB: 0, totalVRAMMB: 0, hasNvidia: false, gpuName: null, vendor: null, gpuType: null }
      }

      // --- 1. nvidia-smi (NVIDIA) ---
      const queryNvidiaSmi = async (): Promise<string | null> => {
        return new Promise((resolve) => {
          const cmd = 'nvidia-smi --query-gpu=memory.free,memory.total,name --format=csv,noheader,nounits'
          exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err) return resolve(null)
            resolve(stdout.trim())
          })
        })
      }
      const nvidiaOut = await queryNvidiaSmi()
      if (nvidiaOut) {
        const firstLine = nvidiaOut.split('\n')[0].trim()
        const parts = firstLine.split(',').map(s => s.trim())
        if (parts.length >= 3) {
          const free = parseInt(parts[0], 10) || 0
          const total = parseInt(parts[1], 10) || 0
          const name = parts.slice(2).join(',').trim()
          return { freeVRAMMB: free, totalVRAMMB: total, hasNvidia: true, gpuName: name, vendor: 'NVIDIA', gpuType: 'discrete' }
        }
      }

      // --- 2. No NVIDIA GPU — detect AMD / Intel via systeminformation ---
      let si: any = null
      try { si = (await import('systeminformation')).default } catch { si = null }
      if (si) {
        let controllers: any[] = []
        try { const g = await si.graphics(); controllers = g.controllers || [] } catch {}
        // Pick the "best" controller: prefer discrete (NVIDIA/AMD/ATI) over Intel
        // integrated, then the one with the highest reported VRAM.
        let best: any = null
        const isDiscrete = (vendor: string) => {
          const v = (vendor || '').toLowerCase()
          return v.includes('nvidia') || v.includes('amd') || v.includes('advanced micro') || v.includes('ati') || v.includes('radeon')
        }
        for (const c of controllers) {
          if (!best) { best = c; continue }
          const cDiscrete = isDiscrete(c.vendor || '') || isDiscrete(c.model || '')
          const bDiscrete = isDiscrete(best.vendor || '') || isDiscrete(best.model || '')
          if (cDiscrete && !bDiscrete) { best = c; continue }
          if (cDiscrete === bDiscrete && (c.vram || 0) > (best.vram || 0)) { best = c; continue }
        }
        if (best) {
          const vendorStr = `${best.vendor || ''} ${best.model || ''}`.toLowerCase()
          let vendor = 'Other'
          let gpuType: string | null = 'discrete'
          if (vendorStr.includes('nvidia')) vendor = 'NVIDIA'
          else if (vendorStr.includes('amd') || vendorStr.includes('advanced micro') || vendorStr.includes('ati') || vendorStr.includes('radeon')) vendor = 'AMD'
          else if (vendorStr.includes('intel')) { vendor = 'Intel'; gpuType = 'integrated' }

          let totalVRAMMB = Math.round(Number(best.vram) || 0)  // systeminformation reports vram in MB
          let freeVRAMMB = 0

          // --- 3. Linux amdgpu sysfs: accurate free VRAM for AMD ---
          if (isLinux && vendor === 'AMD') {
            try {
              const drmEntries = readdirSync('/sys/class/drm').filter(d => /^card\d+$/.test(d))
              let foundSys = false
              for (const d of drmEntries) {
                const totalPath = `/sys/class/drm/${d}/device/mem_info_vram_total`
                const usedPath = `/sys/class/drm/${d}/device/mem_info_vram_used`
                if (existsSync(totalPath) && existsSync(usedPath)) {
                  const t = parseInt(readFileSync(totalPath, 'utf8').trim(), 10)
                  const u = parseInt(readFileSync(usedPath, 'utf8').trim(), 10)
                  if (!isNaN(t) && t > 0) {
                    totalVRAMMB = Math.round(t / (1024 * 1024))
                    freeVRAMMB = Math.max(0, Math.round((t - (isNaN(u) ? 0 : u)) / (1024 * 1024)))
                    foundSys = true
                    break
                  }
                }
              }
              if (!foundSys) console.log('[VRAM] amdgpu sysfs not found, using systeminformation vram')
            } catch (e) { console.log('[VRAM] sysfs read error:', String(e)) }
          }

          // Best-effort free estimate when the platform can't report free VRAM
          // directly (e.g. Windows + AMD). Keeps VRAM budgeting functional.
          if (freeVRAMMB === 0 && totalVRAMMB > 0) {
            freeVRAMMB = Math.round(totalVRAMMB * 0.85)
          }

          return { freeVRAMMB, totalVRAMMB, hasNvidia: vendor === 'NVIDIA', gpuName: best.model || best.vendor || null, vendor, gpuType }
        }
      }

      return { freeVRAMMB: 0, totalVRAMMB: 0, hasNvidia: false, gpuName: null, vendor: null, gpuType: null }
    } catch (err) {
      return { freeVRAMMB: 0, totalVRAMMB: 0, hasNvidia: false, gpuName: null, vendor: null, gpuType: null, error: String(err) }
    }
  })

  // ----- System RAM info (feature 19) -----
  ipcMain.handle('get-system-ram', async () => {
    const os = await import('os')
    const total = os.totalmem()
    const free = os.freemem()
    return { totalRAMMB: Math.round(total / (1024 * 1024)), freeRAMMB: Math.round(free / (1024 * 1024)) }
  })

  // ----- Model Defaults settings (features 18/19) -----
  ipcMain.handle('get-model-defaults', async () => {
    const s = await loadSettings()
    return s.modelDefaults || {
      autoFitEnabled: true,
      autoFitContextLength: 60000,
      guardrailMode: 'strict' as const,
      customMaxSizeGB: 0
    }
  })
  ipcMain.handle('set-model-defaults', async (_e, defaults: any) => {
    const s = await loadSettings()
    s.modelDefaults = {
      autoFitEnabled: !!defaults.autoFitEnabled,
      // Item 5: bumped ceiling from 200 000 → 2 097 152 (2M context era models).
      // Item: allow 0 (no minimum — defers entirely to the template's own
      // context). Use isNaN, not `|| 60000`, for the fallback — `0 || 60000`
      // would silently discard a deliberately-set 0 (falsy in JS).
      autoFitContextLength: (() => {
        const n = Number(defaults.autoFitContextLength)
        return Math.max(0, Math.min(2097152, isNaN(n) ? 60000 : n))
      })(),
      guardrailMode: (['off','relaxed','balanced','strict','custom'].includes(defaults.guardrailMode) ? defaults.guardrailMode : 'strict'),
      customMaxSizeGB: Math.max(0, Number(defaults.customMaxSizeGB) || 0),
      useCurrentMemState: !!defaults.useCurrentMemState,
      moeOffloadStrategy: (defaults.moeOffloadStrategy === 'max' ? 'max' : 'offload'),
      autoFitUse2xIncrements: !!defaults.autoFitUse2xIncrements,
      autoFitYarnAutoScale: !!defaults.autoFitYarnAutoScale,
      autoEnableMmproj: defaults.autoEnableMmproj !== undefined ? !!defaults.autoEnableMmproj : true,
      cpuThreadsOverrideEnabled: !!defaults.cpuThreadsOverrideEnabled,
      // Clamp 0-100, and snap to a whole-core-equivalent isn't possible here
      // (this handler doesn't know physicalCores) — the renderer already
      // snaps before calling this, so just clamp defensively.
      cpuThreadsOverridePercent: Math.max(0, Math.min(100, Number(defaults.cpuThreadsOverridePercent) || 100)),
      parallelOverrideEnabled: !!defaults.parallelOverrideEnabled,
      parallelInferenceMode: (defaults.parallelInferenceMode === 'separate') ? 'separate' : 'unified',
      parallelOverrideValue: Math.max(1, Math.min(256, Number(defaults.parallelOverrideValue) || 4)),
      parallelOverrideValueDense: Math.max(1, Math.min(256, Number(defaults.parallelOverrideValueDense) || 4)),
      parallelOverrideValueMoe: Math.max(1, Math.min(256, Number(defaults.parallelOverrideValueMoe) || 4)),
      perfMaxSessions: Math.max(1, Math.min(500, Number(defaults.perfMaxSessions) || 20))
    }
    await saveSettings(s)
    return { success: true }
  })

  // ----- Base URL Override (feature 24) -----
  ipcMain.handle('get-base-url-override', async () => {
    const s = await loadSettings()
    return s.baseUrlOverride || { ...DEFAULT_BASE_URL_OVERRIDE }
  })
  ipcMain.handle('set-base-url-override', async (_e, opts: any) => {
    const s = await loadSettings()
    s.baseUrlOverride = migrateBaseUrlOverride({
      enabled: !!opts?.enabled,
      port: Number(opts?.port) || 1234,
      serveOnLocalNetwork: !!opts?.serveOnLocalNetwork,
      apiKeyEnabled: !!opts?.apiKeyEnabled,
      apiKey: typeof opts?.apiKey === 'string' ? opts.apiKey : ''
    })
    await saveSettings(s)
    return { success: true }
  })

  // ----- Sampling presets (feature 28) -----
  ipcMain.handle('list-sampling-presets', async () => {
    const s = await loadSettings()
    // Always include the 3 hardcoded presets; merge any user-added ones.
    const hardcoded = getHardcodedPresets()
    const userPresets = (s.samplingPresets || []).filter(p => !hardcoded.find(h => h.id === p.id))
    const all = [...hardcoded, ...userPresets]
    // Determine the starred preset from the persisted starredPresetId.
    // Default to 'lm-studio' only if no star has ever been set.
    const starredId = s.starredPresetId || 'lm-studio'
    let foundStarred = false
    for (const p of all) {
      const isStar = p.id === starredId
      p.isStarred = isStar
      if (isStar) foundStarred = true
    }
    // If the saved starredId no longer exists (e.g. a user preset was deleted),
    // fall back to the first preset so exactly one is always starred.
    if (!foundStarred && all.length > 0) all[0].isStarred = true
    return all
  })
  ipcMain.handle('add-sampling-preset', async (_e, name: string, values: any) => {
    const s = await loadSettings()
    const presets = [...(s.samplingPresets || [])]
    const id = `user-${Date.now()}`
    presets.push({ id, name, isDefault: false, isStarred: false, values })
    s.samplingPresets = presets
    await saveSettings(s)
    return { success: true, preset: { id, name, isDefault: false, isStarred: false, values } }
  })
  ipcMain.handle('delete-sampling-preset', async (_e, id: string) => {
    const s = await loadSettings()
    s.samplingPresets = (s.samplingPresets || []).filter(p => p.id !== id)
    await saveSettings(s)
    return { success: true }
  })
  ipcMain.handle('star-sampling-preset', async (_e, id: string) => {
    const s = await loadSettings()
    // Star in both user presets and hardcoded (hardcoded stored as override flags).
    const userPresets = (s.samplingPresets || []).map(p => ({ ...p, isStarred: p.id === id }))
    s.samplingPresets = userPresets
    s.starredPresetId = id
    await saveSettings(s)
    return { success: true }
  })

  // ----- Model loading guardrail check (feature 19) -----
  // Pre-flight check before spawning llama-server. Returns { allowed, reason }.
  ipcMain.handle('check-model-loading-guardrail', async (_e, opts: {
    modelSizeMB: number
    vramKVMB: number
    vramMMMB: number
  }) => {
    const s = await loadSettings()
    const mode = s.modelDefaults?.guardrailMode || 'strict'
    if (mode === 'off') return { allowed: true, reason: 'Guardrails disabled' }
    const os = await import('os')
    const totalRAMMB = Math.round(os.totalmem() / (1024 * 1024))
    const totalBudget = totalRAMMB // simplified: RAM + VRAM
    const required = opts.modelSizeMB + opts.vramKVMB + opts.vramMMMB
    // Thresholds per mode (fraction of total system RAM).
    const thresholds: Record<string, number> = { relaxed: 0.95, balanced: 0.85, strict: 0.75, custom: 0.75 }
    const threshold = thresholds[mode] || 0.75
    if (mode === 'custom') {
      const maxGB = s.modelDefaults?.customMaxSizeGB || 0
      if (maxGB > 0 && opts.modelSizeMB / 1024 > maxGB) {
        return { allowed: false, reason: `Model size (${(opts.modelSizeMB/1024).toFixed(1)} GB) exceeds custom limit (${maxGB} GB)` }
      }
    }
    if (required > totalBudget * threshold) {
      return { allowed: false, reason: `Model + KV cache + mmproj (${Math.round(required)} MB) exceeds the ${mode} guardrail threshold of ${Math.round(totalBudget * threshold)} MB. Reduce context size or GPU layers.` }
    }
    return { allowed: true, reason: 'Within guardrail budget' }
  })

  // Apply the persisted theme on startup.
  loadSettings().then(s => applyNativeTheme(s.theme))

  // ----- Silent automated multi-backend check on startup (feature 33) -----
  // Runs check-all-backends in the background without spawning UI; results are
  // broadcast to all windows so the UpdateBanner / tracker cards can react.
  loadSettings().then(async (s) => {
    if (!s.trackedBackends || s.trackedBackends.length === 0) return
    try {
      const results = await Promise.all(s.trackedBackends.map(t => fetchTrackedRelease(t)))
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) {
          win.webContents.send('backends-checked-silent', { results })
        }
      })
    } catch {}
  })
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
// Read a 64-bit little-endian unsigned integer from a Buffer at the given offset.
// Returns a BigInt-safe number (may lose precision above 2^53, which is fine for
// GGUF counts).
function readU64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset)
}

// The 3 hardcoded, immutable sampling presets (feature 28).
function getHardcodedPresets(): any[] {
  // NOTE: isStarred is always false here on purpose. The starred preset is
  // determined by the persisted `starredPresetId` in settings.json, applied
  // at list time. Previously LM Studio was baked-in as isStarred:true, which
  // overrode the saved star on every relaunch (bug: the dropdown always
  // reset to "LM Studio ★" even after the user starred a different preset).
  return [
    {
      id: 'lm-studio',
      name: 'LM Studio',
      isDefault: true,
      isStarred: false,
      values: { topK: 40, topP: 0.95, minP: 0.05, repeatPenalty: 1.1, presencePenalty: 0.0 }
    },
    {
      id: 'qwen-thinking',
      name: 'Qwen Thinking',
      isDefault: true,
      isStarred: false,
      values: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0 }
    },
    {
      id: 'qwen-instruct',
      name: 'Qwen Instruct (Non-Thinking)',
      isDefault: true,
      isStarred: false,
      values: { temperature: 0.7, topP: 0.80, topK: 20, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0 }
    }
  ]
}

function sortExternalFolders(folders: string[], mainFolder: string | null): string[] {
  // Main (starred) folder first, then the rest sorted alphabetically by basename.
  const main = mainFolder && folders.includes(mainFolder) ? mainFolder : null
  const rest = folders.filter(f => f !== main).sort((a, b) => {
    const na = basename(a).toLowerCase()
    const nb = basename(b).toLowerCase()
    return na.localeCompare(nb)
  })
  return main ? [main, ...rest] : rest
}

function appShouldUseDarkBackground(): boolean {
  try {
    const s = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8')) : null
    const theme = s?.theme
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors
  } catch {
    return true // fallback to dark
  }
}

function applyNativeTheme(theme: ThemePref): void {
  try {
    if (theme === 'dark') nativeTheme.themeSource = 'dark'
    else if (theme === 'light') nativeTheme.themeSource = 'light'
    else nativeTheme.themeSource = 'system'
  } catch {}
}

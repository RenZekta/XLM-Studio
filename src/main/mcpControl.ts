// The "control layer": one implementation per MCP tool, called identically
// whether the caller is an MCP client (mcpServer.ts's protocol transport) or
// a skill script (mcpServer.ts's plain HTTP control API, see skillGenerator.ts).
//
// Every function here is pure business logic — it never touches ipcMain,
// BrowserWindow, or any renderer-facing concern. All access to the rest of
// the app goes through the ControlDeps object injected via initControlLayer,
// mirroring the dependency-injection pattern perfMonitor.ts already uses for
// startTracking/stopTracking.
import { buildQuickEngineBaseline, SAMPLING_KEYS, seedSamplingArgsFromPreset } from '../shared/presetBaselines'
import { COMMON_PARAM_FLAGS } from '../shared/commonParams'
import { applyNgramModifierToggle, getNgramModifierState, NGRAM_MAP_K4V_FLAGS, NGRAM_MOD_FLAGS } from '../shared/specToggles'
import type { Template } from '../shared/types'

export interface ControlDeps {
  loadSettings: () => Promise<any>
  saveSettings: (s: any) => Promise<void>
  listTemplates: () => any[]
  saveTemplate: (t: Record<string, unknown>) => Promise<{ success: true; id: string }>
  deleteTemplate: (id: string) => { success: boolean; error?: string }
  listModels: () => Promise<any[]>
  listBackends: () => Promise<any[]>
  listTrackedBackends: () => Promise<any[]>
  getCpuInfo: () => Promise<{ physicalCores: number; logicalCores: number; modelName: string }>
  getVramInfo: () => Promise<any>
  getSystemRam: () => Promise<{ totalRAMMB: number; freeRAMMB: number }>
  getGgufMetadata: (modelPath: string) => Promise<any>
  // Read-only lookup into the already-populated metadata cache — does NOT
  // trigger a fresh GGUF parse for uncached paths (use getGgufMetadata for
  // that). Used by info-models so listing models stays cheap.
  getCachedMetadata: (modelPath: string) => any | null
  getCommands: (backendKey: string) => Promise<any>
  runModel: (opts: { id: string; name: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number; ignoreBaseUrlOverride?: boolean; skipCheckpoint?: boolean }) => Promise<{ success: boolean; pid?: number; error?: string; port?: number }>
  stopModel: (id: string, opts?: { skipCheckpoint?: boolean }) => Promise<{ success: boolean; error?: string }>
  isRunning: (templateId: string) => { running: boolean; port?: number }
  getOverridePort: () => Promise<number | null>
  getSessionSpeeds: (templateId: string) => { firstTps: number | null; avgTps: number | null }
}

let deps: ControlDeps | null = null
export function initControlLayer(d: ControlDeps) {
  deps = d
}
function D(): ControlDeps {
  if (!deps) throw new Error('mcpControl: initControlLayer() was not called yet')
  return deps
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

class ToolError extends Error {}

function findTemplate(name: string): Template {
  const t = D().listTemplates().find(t => t.name === name)
  if (!t) throw new ToolError(`No template named "${name}". Use info-templates to list existing templates.`)
  return t
}

function findTemplates(names: string[]): Template[] {
  return names.map(findTemplate)
}

function isMcpMade(t: Template): boolean {
  return Array.isArray(t.tags) && t.tags.includes('MCP-made')
}

function tagAsMcpMade(t: Record<string, any>) {
  const tags: string[] = Array.isArray(t.tags) ? [...t.tags] : []
  if (!tags.includes('MCP-made')) tags.push('MCP-made')
  t.tags = tags
}

// Enforced on every template-edit call (and nowhere else — creating or
// duplicating via MCP always tags the result "MCP-made", so this only ever
// blocks edits to templates the user built or hand-edited themselves).
async function assertEditAllowed(t: Template) {
  const s = await D().loadSettings()
  if (s.mcp?.restrictEditToMcpMade && !isMcpMade(t)) {
    throw new ToolError(
      `"${t.name}" was not created by an MCP tool (missing the "MCP-made" tag), and ` +
      `Settings → MCP Server → "Only allow Template edits via MCP for MCP-made Templates" is ON. ` +
      `Refusing to edit it. Turn that switch off, or use template-duplicate to make an MCP-made copy.`
    )
  }
}

// Picks the "Global" default backend when a template/create call doesn't name
// one: the persisted Global Backend from Settings/Sidebar/App startup
// (settings.globalBackend, kept in sync with the renderer's own activeBackend
// — see App.tsx), falling back to just the first backend found if nothing is
// persisted yet (fresh install with no window ever opened) or the persisted
// one is no longer installed. Deliberately no longer special-cases
// backendKey === 'llama.cpp' here — that silently overrode a different fork
// (e.g. a TurboQuant build) whenever globalBackend hadn't been persisted yet,
// which is exactly the bug that made an MCP-triggered start pick the wrong
// backend even though the template's Template Args looked identical to a
// manual, working start.
async function resolveBackend(template: Template): Promise<any> {
  const backends = await D().listBackends()
  if (backends.length === 0) throw new ToolError('No backends installed — install a backend in the Backends tab first.')
  const settings = await D().loadSettings()
  const globalBackend = settings.globalBackend
  if (template.backendKey) {
    // backendKey+version alone stopped being unique once multi-backend-type
    // support shipped (the same fork+version can exist under several type
    // folders at once, e.g. a vulkan and a rocm build of the same release),
    // so match backendType too whenever the template actually recorded one.
    // Templates saved before that field existed (backendType undefined)
    // fall back to the old key+version match, which stays ambiguous only
    // for those.
    if ((template as any).backendType !== undefined) {
      const exact = backends.find((b: any) =>
        b.backendKey === template.backendKey &&
        b.name === template.backendVersion &&
        (b.backendType ?? null) === ((template as any).backendType ?? null)
      )
      if (exact) return exact
    }
    // Ambiguous pin: a fork+version with no (or no matching) recorded type.
    // Before grabbing whichever installed variant happens to sort first,
    // prefer whichever matches the Global Backend's own type IF the Global
    // Backend is ALSO this same fork+version -- the template is very likely
    // just tracking "whatever's active" and lost its type somewhere (e.g.
    // template-edit changing backendVersion without a type, or a template
    // saved by an older version of this preset/create logic that pinned
    // key+version but not type). If the Global Backend points at a
    // different fork+version entirely, this can't help and falls through.
    if (globalBackend?.backendKey === template.backendKey && globalBackend?.backendVersion === template.backendVersion) {
      const globalTyped = backends.find((b: any) =>
        b.backendKey === template.backendKey &&
        b.name === template.backendVersion &&
        (b.backendType ?? null) === (globalBackend.backendType ?? null)
      )
      if (globalTyped) return globalTyped
    }
    const byKeyAndVersion = backends.find((b: any) => b.backendKey === template.backendKey && b.name === template.backendVersion)
    if (byKeyAndVersion) return byKeyAndVersion
    const byKey = backends.find((b: any) => b.backendKey === template.backendKey)
    if (byKey) return byKey
  }
  if (globalBackend?.backendKey) {
    if (globalBackend.backendType !== undefined) {
      const exact = backends.find((b: any) =>
        b.backendKey === globalBackend.backendKey &&
        b.name === globalBackend.backendVersion &&
        (b.backendType ?? null) === (globalBackend.backendType ?? null)
      )
      if (exact) return exact
    }
    const match = backends.find((b: any) => b.backendKey === globalBackend.backendKey && b.name === globalBackend.backendVersion)
    if (match) return match
  }
  return backends[0]
}

// Matches a caller-given backend identifier (id, backendKey, version name,
// or displayName) against installed backends. More than one candidate can
// share an identifier once multi-backend-type support shipped (e.g. two
// installs both named "b10269-1.6.0", one vulkan and one rocm) -- when that
// happens, an explicit `type` wins if given, else whichever candidate
// matches the Global Backend's own type (same reasoning as resolveBackend's
// ambiguous-pin fallback above), else just the first candidate as a last
// resort matching the old, pre-multi-type behavior.
function matchExplicitBackend(
  backends: any[],
  nameOrKeyOrId: string,
  type: string | null | undefined,
  globalBackend: { backendKey: string; backendVersion: string; backendType?: string | null } | null
): any {
  const candidates = backends.filter((b: any) =>
    b.id === nameOrKeyOrId || b.backendKey === nameOrKeyOrId || b.name === nameOrKeyOrId || b.displayName === nameOrKeyOrId
  )
  if (candidates.length <= 1) return candidates[0] || null
  if (type !== undefined) {
    const exact = candidates.find((b: any) => (b.backendType ?? null) === (type ?? null))
    if (exact) return exact
  }
  if (globalBackend) {
    const globalMatch = candidates.find((b: any) =>
      b.backendKey === globalBackend.backendKey && b.name === globalBackend.backendVersion && (b.backendType ?? null) === (globalBackend.backendType ?? null)
    )
    if (globalMatch) return globalMatch
  }
  return candidates[0]
}

// Converts template.args into the same CLI flag list ModelCard.tsx builds
// for a normal launch: the AutoFit ctx-size floor, and the "Auto" Context
// Fill mode's --fit flag (strip --ctx-size, pass "--fit on" so llama-server
// decides offload+context itself) — both ported faithfully, neither needs
// live VRAM state.
async function buildLaunchArgs(template: Template): Promise<{ args: string[]; ctxAutoFitApplied: boolean; fitMode: 'off' | 'auto' }> {
  const settings = await D().loadSettings()
  const md = settings.modelDefaults || {}
  const raw = { ...(template.args || {}) }
  const ignoreCtxOverride = raw['__ignoreCtxOverride'] === true
  const autoCtxFill = (raw['__autoCtxFill'] as 'off' | 'auto') || 'off'
  const fitMode: 'off' | 'auto' = ignoreCtxOverride ? autoCtxFill : 'off'
  let ctxAutoFitApplied = false
  if (fitMode === 'auto') {
    // Defer to llama-server's own --fit — do not pass --ctx-size at all.
    delete raw['--ctx-size']
    delete raw['-c']
    raw['--fit'] = 'on'
  } else if (!ignoreCtxOverride && md.autoFitEnabled && md.autoFitContextLength) {
    const current = Number(raw['--ctx-size'] ?? raw['-c'] ?? 0)
    if (md.autoFitContextLength > current) {
      raw['--ctx-size'] = md.autoFitContextLength
      delete raw['-c']
      ctxAutoFitApplied = true
    }
  }
  // Parallel Inference override — a hard override (not a floor, unlike the
  // AutoFit ctx-size logic above), applied at EVERY launch regardless of
  // what the Template itself has stored, exactly matching ModelCard.tsx's
  // handleRunToggle, so an MCP/skill-triggered start applies it exactly like
  // a manual Start click does.
  if (md.parallelOverrideEnabled) {
    let isMoeModel = false
    if (md.parallelInferenceMode === 'separate' && template.modelPath) {
      try {
        const meta = await D().getGgufMetadata(template.modelPath)
        isMoeModel = !!meta?.isMoe || (meta?.expertCount || 0) > 0
      } catch {}
    }
    const effectiveParallel = md.parallelInferenceMode === 'separate'
      ? Math.max(1, Number(isMoeModel ? md.parallelOverrideValueMoe : md.parallelOverrideValueDense) || 4)
      : Math.max(1, Number(md.parallelOverrideValue) || 4)
    raw['--parallel'] = effectiveParallel
    delete raw['-np']
  }
  const flags: string[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('__')) continue  // synthetic UI-only keys (ignoreCtxOverride, autoCtxFill, ...)
    if (value === false || value === null || value === undefined || value === '') continue
    flags.push(key)
    if (value !== true) flags.push(String(value))
  }
  if (template.modelPath) flags.push('--model', template.modelPath)
  // Base URL Override — port substitution, "Serve on local network"
  // (--host 0.0.0.0), and API key, mirroring runModelImpl's own application
  // of these in ipc.ts EXACTLY (including the ignoreBaseUrlOverride escape
  // hatch), so display-preview's reconstructed command always matches what
  // actually ends up listening rather than showing the Template's own raw
  // --port.
  const ignoreBaseUrlOverride = raw['__ignoreBaseUrlOverride'] === true
  const ovr = ignoreBaseUrlOverride ? null : settings.baseUrlOverride
  const effectivePort = (ovr?.enabled) ? ovr.port : (template.serverPort || 8080)
  if (!flags.includes('--port')) flags.push('--port', String(effectivePort))
  else flags[flags.indexOf('--port') + 1] = String(effectivePort)
  if (ovr?.enabled && ovr.serveOnLocalNetwork) {
    const hostIdx = flags.indexOf('--host')
    if (hostIdx !== -1 && hostIdx + 1 < flags.length) flags[hostIdx + 1] = '0.0.0.0'
    else {
      const shortHostIdx = flags.indexOf('-h')
      if (shortHostIdx !== -1 && shortHostIdx + 1 < flags.length) flags[shortHostIdx + 1] = '0.0.0.0'
      else flags.push('--host', '0.0.0.0')
    }
  }
  if (ovr?.enabled && ovr.apiKeyEnabled && ovr.apiKey) {
    const keyIdx = flags.indexOf('--api-key')
    if (keyIdx !== -1 && keyIdx + 1 < flags.length) flags[keyIdx + 1] = ovr.apiKey
    else flags.push('--api-key', ovr.apiKey)
  }
  return { args: flags, ctxAutoFitApplied, fitMode }
}

function newId(): string {
  return Date.now().toString() + Math.floor(Math.random() * 1000)
}

// Polls llama-server's standard /health endpoint (503 "loading model" while
// weights are still loading, 200 {"status":"ok"} once ready to serve) until
// it reports ready or the timeout elapses. Used after every MCP-triggered
// start so the tool call itself doesn't return — and so an MCP client
// doesn't send its first prompt — before the model can actually answer.
// Large models can legitimately take minutes to load, hence the generous
// default timeout; this only prolongs the tool call, it never blocks the
// rest of the app.
async function waitForServerReady(port: number, timeoutMs = 10 * 60 * 1000, pollMs = 500): Promise<{ ready: boolean; waitedMs: number }> {
  const http = await import('http')
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>(resolve => {
      const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 2000 }, res => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
    })
    if (ok) return { ready: true, waitedMs: Date.now() - started }
    await new Promise(r => setTimeout(r, pollMs))
  }
  return { ready: false, waitedMs: Date.now() - started }
}

// Builds the same "Quick" engine baseline the renderer's Quick button and
// CreateModal use: buildQuickEngineBaseline() for the static (CPU/backend
// derived) fields, plus --ctx-size and --gpu-layers set the same way
// handleQuickPreset() sets them (see CmdParamsEditor.tsx). --ctx-size uses
// the flat `min(model max, 32768)` cap for BOTH Dense and MoE — the
// renderer additionally VRAM-fits MoE's context via estimateMoeDefaultContext(),
// which needs live vramBudget/mmproj UI state not reproduced here; see the
// leftover-plan doc.
async function buildQuickBaseline(meta: any, isMoe: boolean, gpuLayersMax: number, backend: { backendKey?: string; name?: string; displayName?: string; exe?: string; path?: string } | undefined): Promise<Record<string, any>> {
  const settings = await D().loadSettings()
  const cpu = await D().getCpuInfo()
  const cpuThreadsOverridePercent = settings.modelDefaults?.cpuThreadsOverrideEnabled ? settings.modelDefaults.cpuThreadsOverridePercent : null
  const baseline = buildQuickEngineBaseline({ cpuInfo: { physicalCores: cpu.physicalCores }, backendKey: backend?.backendKey, backendInfo: backend, cpuThreadsOverridePercent })
  if (meta?.contextLength && meta.contextLength > 0) {
    baseline['--ctx-size'] = Math.min(meta.contextLength, 32768)
  }
  if (!isMoe && gpuLayersMax > 0) {
    baseline['--gpu-layers'] = gpuLayersMax
  }
  return baseline
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function toolTemplateAction(args: { template: string; action: 'start' | 'stop' }) {
  const t = findTemplate(args.template)
  if (args.action === 'stop') {
    const res = await D().stopModel(t.id)
    return { template: t.name, action: 'stop', ...res }
  }
  const running = D().isRunning(t.id)
  if (running.running) {
    return { template: t.name, action: 'start', success: false, error: 'Already running', port: running.port }
  }
  const backend = await resolveBackend(t)
  const { args: launchArgs, ctxAutoFitApplied } = await buildLaunchArgs(t)
  const res = await D().runModel({
    id: t.id,
    name: t.name,
    backendPath: backend.path,
    exe: backend.exe,
    args: launchArgs,
    openBrowser: false,  // MCP/skill-triggered starts are headless — the human can still open the chat window manually from the UI.
    port: t.serverPort || 8080,
    ignoreBaseUrlOverride: (t.args || {})['__ignoreBaseUrlOverride'] === true
  })
  if (!res.success || !res.port) return { template: t.name, action: 'start', ctxAutoFitApplied, ...res }
  // Don't return until the model can actually serve a request — otherwise
  // a caller that immediately sends a prompt right after this tool call
  // returns can hit llama-server's 503 "Loading model" while it's still
  // reading weights in.
  const readiness = await waitForServerReady(res.port)
  return { template: t.name, action: 'start', ctxAutoFitApplied, ...res, ready: readiness.ready, loadWaitMs: readiness.waitedMs }
}

export async function toolInfoTemplates() {
  const templates = D().listTemplates()
  const overridePort = await D().getOverridePort()
  return {
    baseUrlOverrideActive: overridePort !== null,
    templates: templates.map(t => {
      const running = D().isRunning(t.id)
      const ignoresOverride = (t.args || {})['__ignoreBaseUrlOverride'] === true
      const effectivePort = running.port ?? (overridePort !== null && !ignoresOverride ? overridePort : t.serverPort)
      return {
        name: t.name,
        id: t.id,
        active: running.running,
        port: effectivePort,
        modelPath: t.modelPath || null,
        backendKey: t.backendKey || null,
        backendVersion: t.backendVersion || null,
        tags: t.tags || [],
        mcpMade: isMcpMade(t)
      }
    })
  }
}

export async function toolInfoModels() {
  const groups = await D().listModels()
  return {
    groups: groups.map((g: any) => ({
      folder: g.folder,
      external: g.external,
      models: g.models.map((m: any) => {
        // Already-cached metadata (populated the first time the model was
        // opened/used anywhere in the app) is surfaced for free; models
        // never yet scanned report null rather than triggering a fresh
        // GGUF parse on every info-models call.
        const cached = D().getCachedMetadata(m.path)
        return {
          name: m.name, path: m.path, sizeBytes: m.size,
          isMoe: cached?.isMoe ?? null,
          hasNativeMtp: cached?.hasNativeMtp ?? null,
          contextLength: cached?.contextLength ?? null
        }
      }),
      mmproj: g.mmproj ? { name: g.mmproj.name, path: g.mmproj.path, sizeBytes: g.mmproj.size } : null,
      specDecodeSidecars: (g.specDecodeSidecars || []).map((s: any) => ({ name: s.name, path: s.path, sizeBytes: s.size }))
    }))
  }
}

export async function toolInfoBackends() {
  const backends = await D().listBackends()
  return {
    backends: backends.map((b: any) => ({
      backendKey: b.backendKey,
      version: b.version,
      displayName: b.displayName,
      path: b.path,
      exe: b.exe,
      external: b.external
    }))
  }
}

export async function toolInfoTrackedBackends() {
  const tracked = await D().listTrackedBackends()
  return {
    tracked: tracked.map((t: any) => ({
      id: t.id,
      repo: t.repo,
      // "whether there are updates detected/up to date/failed to fetch" —
      // trackedBackends already carries the last-checked release info; a
      // live "check now" is a separate write action (check-all-backends)
      // deliberately not triggered here (network calls shouldn't be a side
      // effect of a read-only info tool).
      status: t.lastCheckError ? 'failed to fetch' : (t.latestKnownVersion && t.latestKnownVersion !== t.installedVersion ? 'update detected' : 'up to date'),
      installedVersion: t.installedVersion ?? null,
      latestKnownVersion: t.latestKnownVersion ?? null,
      lastCheckError: t.lastCheckError ?? null
    }))
  }
}

export async function toolTemplateDuplicate(args: { template: string; copies: number }) {
  const t = findTemplate(args.template)
  const n = Math.max(1, Math.min(50, Math.floor(args.copies || 1)))
  const created: string[] = []
  for (let i = 1; i <= n; i++) {
    const copy: Record<string, any> = {
      ...t,
      id: newId(),
      name: `${t.name} (${i})`,
      serverPort: (t.serverPort || 8080) + i,  // avoid an immediate port clash between copies
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSessionFirstTps: null,
      lastSessionAvgTps: null,
      lastSessionAt: null
    }
    tagAsMcpMade(copy)
    delete copy._file
    await D().saveTemplate(copy)
    created.push(copy.name)
  }
  return { template: t.name, copiesCreated: created }
}

export async function toolTemplateCreate(args: { name: string; model: string; backend?: string; backendType?: string | null }) {
  const models = await D().listModels()
  const allModels = models.flatMap((g: any) => g.models.map((m: any) => ({ ...m, folder: g.folder })))
  const model = allModels.find((m: any) => m.name === args.model || m.path === args.model)
  if (!model) throw new ToolError(`No model file matching "${args.model}". Use info-models to list detected model files.`)

  let explicitBackend: any = null
  if (args.backend) {
    const backends = await D().listBackends()
    const settings = await D().loadSettings()
    explicitBackend = matchExplicitBackend(backends, args.backend, args.backendType, settings.globalBackend)
    if (!explicitBackend) throw new ToolError(`No backend matching "${args.backend}". Use info-backends to list installed backends.`)
  }
  // Resolve the EFFECTIVE backend now (explicit arg, else the persisted
  // Global Backend, else newest-installed) and pin it directly onto the
  // template — MCP-created templates always pin a concrete backend (unlike
  // the renderer's own CreateModal, which now defaults new templates to
  // "Default (Active)"/unpinned), since Quick baseline's backend-specific
  // defaults (e.g. TurboQuant's KV cache quant types) need a concrete
  // backend to compute against, not an unresolved/undefined backendKey
  // falling back to generic q8_0.
  const backend = explicitBackend || await resolveBackend({} as Template)
  // "Creates the template the same way as user does - with Quick preset by
  // default and everything else" — build the Quick baseline from GGUF
  // metadata, same call the renderer's CreateModal makes, AND seed the
  // starred Sampling Preset's values the same way CreateModal's lazy
  // initializer does — these are a separate axis from the engine baseline
  // and Quick/FullAuto/Clean never touch them once set, so this is the
  // ONLY place a fresh Template gets them at all; skipping this step is
  // what would leave an MCP-created Template with empty sampling parameters.
  const meta = await D().getGgufMetadata(model.path)
  const blockCount = meta?.blockCount || 0
  const gpuLayersMax = blockCount > 0 ? blockCount : 120
  const isMoe = !!meta?.isMoe || (meta?.expertCount || 0) > 0
  const settings = await D().loadSettings()
  const baseline: Record<string, any> = { ...seedSamplingArgsFromPreset(settings.samplingPresets) }
  Object.assign(baseline, await buildQuickBaseline(meta, isMoe, gpuLayersMax, backend))

  baseline['__lastPreset'] = 'quick'
  const usedPorts = new Set(D().listTemplates().map(t => t.serverPort))
  let port = 8080
  while (usedPorts.has(port)) port++

  const template: Record<string, any> = {
    id: newId(),
    name: args.name,
    modelPath: model.path,
    backendKey: backend.backendKey,
    backendVersion: backend.name,
    backendType: backend.backendType ?? null,
    serverPort: port,
    args: baseline,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSessionFirstTps: null,
    lastSessionAvgTps: null,
    lastSessionAt: null
  }
  tagAsMcpMade(template)
  const res = await D().saveTemplate(template)
  return { name: template.name, id: res.id, port, backendKey: backend.backendKey, backendVersion: backend.name, backendType: backend.backendType ?? null, resolvedVia: args.backend ? 'explicit' : 'global-default', tags: template.tags }
}

// Every changeable field EXCEPT model/backend of a currently-serving
// template (would corrupt the live session) — see the guard below.
export async function toolTemplateEdit(args: { templates: string[]; changes: Record<string, any> }) {
  const targets = findTemplates(args.templates)
  const results: { template: string; success: boolean; error?: string }[] = []
  for (const t of targets) {
    try {
      await assertEditAllowed(t)
      const running = D().isRunning(t.id)
      const changingModelOrBackend = (
        'model' in args.changes || 'modelPath' in args.changes ||
        'backend' in args.changes || 'backendKey' in args.changes ||
        'backendVersion' in args.changes || 'backendType' in args.changes || 'type' in args.changes
      )
      if (running.running && changingModelOrBackend) {
        throw new ToolError(`"${t.name}" is currently serving — refusing to change its model/backend (would corrupt the live session). Stop it first.`)
      }
      const patch: Record<string, any> = { ...t, updatedAt: new Date().toISOString() }
      let newArgs: Record<string, any> = { ...(t.args || {}) }
      const { labelToFlag, shortToFlag } = await getSchemaLookup(t)
      // Whether this call explicitly set a type alongside a backend/version
      // change -- if not, it gets auto-resolved once every change has been
      // applied (see below), rather than unconditionally discarded.
      let backendTypeExplicit = false
      let backendKeyOrVersionChanged = false
      for (const [k, v] of Object.entries(args.changes)) {
        if (k === 'model' || k === 'modelPath') { patch.modelPath = v; continue }
        if (k === 'backend' || k === 'backendKey') { patch.backendKey = v; backendKeyOrVersionChanged = true; continue }
        if (k === 'backendVersion') { patch.backendVersion = v; backendKeyOrVersionChanged = true; continue }
        // Lets a caller pin the EXACT variant (e.g. "vulkan" vs "rocm")
        // alongside backend/backendVersion in the same call, straight from
        // info-backends' own backendType field. An empty string or null
        // clears it back to "no specific type" (ambiguous/legacy match).
        if (k === 'backendType' || k === 'type') {
          patch.backendType = (v === '' || v === null || v === undefined) ? null : String(v)
          backendTypeExplicit = true
          continue
        }
        if (k === 'serverPort' || k === 'port') { patch.serverPort = Number(v); continue }
        if (k === 'name') { patch.name = String(v); continue }
        if (k === 'launchMode') continue  // vestigial field, no longer meaningful — Chat UI/API Only per-Template switch was removed; see settings.modelDefaults.autoOpenChatUI
        // The three composite toggles from display-parameters-*'s "toggles"
        // array — each accepts a plain boolean under either its label or
        // its short key, and (for the N-gram ones) applies the exact same
        // --spec-type rebuild + default-seeding/cleanup of the underlying
        // flags the UI's own switch does, so a caller can "just turn N-grams
        // on" without hand-constructing --spec-type or knowing its defaults.
        const kLower = k.toLowerCase()
        if (kLower === 'n-gram map (k4v)' || kLower === 'ngram-map-k4v') { newArgs = applyNgramModifierToggle(newArgs, 'map-k4v', !!v); continue }
        if (kLower === 'n-gram modifier' || kLower === 'ngram-mod') { newArgs = applyNgramModifierToggle(newArgs, 'mod', !!v); continue }
        if (kLower === 'automatic yarn scaling control' || kLower === 'yarn-auto-scale') { newArgs['__yarnAutoScale'] = !!v; continue }
        // Every other parameter (model, backend, multimodal projector,
        // speculative decoding, and every other UI parameter) is stored as
        // an args key. Accept the raw flag ("ctx-size"/"--ctx-size"), its
        // short alias ("-c", with or without the dash), OR the same label
        // display-parameters-*/the app's own interface shows for it
        // ("Context Size") — all resolved via the same CommandsSchema
        // lookup — auto-filling a leading "--" for a bare flag name that
        // didn't match any of those. Short-flag lookup is checked before
        // the bare-flag fallback: a single-dash short flag like "-lm" would
        // otherwise fail the "--" prefix check and get mangled into
        // "---lm" by the auto-fill instead of resolving to "--load-mode".
        const byLabel = labelToFlag.get(kLower)
        const byShort = byLabel ? undefined : shortToFlag.get(kLower.replace(/^-+/, ''))
        const flag = byLabel || byShort || (k.startsWith('--') || k.startsWith('__') ? k : `--${k}`)
        newArgs[flag] = v
      }
      if (backendKeyOrVersionChanged && !backendTypeExplicit) {
        // backend/backendVersion changed but this call didn't also say
        // which type -- carrying over the OLD type would be wrong (it
        // belonged to whatever backend was pinned before), so resolve it
        // fresh: if the new key+version unambiguously matches exactly one
        // installed backend, adopt its type (no guessing needed); else, if
        // the Global Backend happens to be this same fork+version, adopt
        // ITS type (the template is very likely meant to just track
        // "whatever's active"); otherwise there's genuine ambiguity (two+
        // installed types share this key+version and neither signal picks
        // one), so fall back to null -- ambiguous, but at least explicit
        // rather than silently wrong, and resolveBackend's own fallback
        // chain still has a shot at it via the Global Backend check.
        const backends = await D().listBackends()
        const settings = await D().loadSettings()
        const candidates = backends.filter((b: any) => b.backendKey === patch.backendKey && b.name === patch.backendVersion)
        if (candidates.length === 1) {
          patch.backendType = candidates[0].backendType ?? null
        } else {
          const globalBackend = settings.globalBackend
          const globalMatch = candidates.find((b: any) =>
            globalBackend?.backendKey === patch.backendKey && globalBackend?.backendVersion === patch.backendVersion &&
            (b.backendType ?? null) === (globalBackend.backendType ?? null)
          )
          patch.backendType = globalMatch ? (globalMatch.backendType ?? null) : null
        }
      }
      patch.args = newArgs
      delete patch._file
      await D().saveTemplate(patch)
      results.push({ template: t.name, success: true })
    } catch (err: any) {
      results.push({ template: t.name, success: false, error: err?.message || String(err) })
    }
  }
  return { results }
}

export async function toolTotalRam() {
  const [ram, vram] = await Promise.all([D().getSystemRam(), D().getVramInfo()])
  return {
    totalRAMMB: ram.totalRAMMB,
    totalVRAMMB: vram.totalVRAMMB || 0,
    totalCombinedMB: ram.totalRAMMB + (vram.totalVRAMMB || 0)
  }
}

export async function toolFreeRam() {
  const [ram, vram] = await Promise.all([D().getSystemRam(), D().getVramInfo()])
  return {
    freeRAMMB: ram.freeRAMMB,
    freeVRAMMB: vram.freeVRAMMB || 0,
    freeCombinedMB: ram.freeRAMMB + (vram.freeVRAMMB || 0)
  }
}

function normalizePreset(preset: string | number): 'clear' | 'quick' | 'full-auto' {
  const s = String(preset).trim().toLowerCase()
  if (s === '0' || s === 'clean' || s === 'clear') return 'clear'
  if (s === '1' || s === 'quick') return 'quick'
  if (s === '2' || s === 'full auto' || s === 'full-auto' || s === 'fullauto') return 'full-auto'
  throw new ToolError(`Unknown preset "${preset}" — use "Clean"/0, "Quick"/1, or "FULL AUTO"/2.`)
}

// Quick and Clear are ported faithfully from CmdParamsEditor.tsx's own
// preset application (buildQuickEngineBaseline is the exact same shared
// function the renderer calls). FULL AUTO's context value is a SIMPLIFIED
// approximation — see the leftover-plan doc: the renderer's live
// VRAM-optimized MoE context estimate is not replicated here, this uses the
// same `Math.min(meta.contextLength, 32768)` fallback the renderer itself
// falls back to when a live VRAM estimate isn't available.
export async function toolApplyParametersPreset(args: { preset: string | number; template: string }) {
  const t = findTemplate(args.template)
  await assertEditAllowed(t)
  const preset = normalizePreset(args.preset)
  if (preset === 'clear') {
    // Clean wipes the ENGINE args only — it explicitly PRESERVES --mmproj
    // and every sampling value (temperature/top-p/top-k/min-p/repeat-
    // penalty/presence-penalty), matching handleClearPreset() in
    // CmdParamsEditor.tsx exactly. Replacing args wholesale with {} would
    // wipe sampling values too, which the real Clean never does.
    const preserved: Record<string, any> = {}
    const curArgs = t.args || {}
    if (curArgs['--mmproj'] !== undefined) preserved['--mmproj'] = curArgs['--mmproj']
    for (const k of SAMPLING_KEYS) {
      if (curArgs[k] !== undefined) preserved[k] = curArgs[k]
    }
    preserved['__ignoreCtxOverride'] = false
    preserved['__autoCtxFill'] = 'off'
    preserved['__vramOverheadEnabled'] = false
    preserved['__ramOverheadEnabled'] = false
    preserved['__lastPreset'] = 'clear'
    const patch = { ...t, args: preserved, updatedAt: new Date().toISOString() }
    delete (patch as any)._file
    await D().saveTemplate(patch)
    return { template: t.name, preset: 'Clean', applied: true }
  }
  if (!t.modelPath) throw new ToolError(`"${t.name}" has no model assigned yet — set one with template-edit first.`)
  const meta = await D().getGgufMetadata(t.modelPath)
  const blockCount = meta?.blockCount || 0
  const gpuLayersMax = blockCount > 0 ? blockCount : 120
  const isMoe = !!meta?.isMoe || (meta?.expertCount || 0) > 0
  // Resolve the effective backend (falls through to the persisted Global
  // Backend when the template doesn't pin one) rather than using t.backendKey
  // raw — same bug/fix as template-create: an unresolved backendKey here
  // silently produced generic q8_0 KV-quant defaults instead of the actual
  // backend's own recommendation (e.g. TurboQuant). `backend` is used only
  // to compute the baseline below -- it is NOT written back onto the
  // template. The renderer's own Quick/FullAuto buttons never touch
  // backendKey/backendVersion/backendType either (see handleQuickPreset in
  // CmdParamsEditor.tsx); a Template left on "Default (Active)" must stay
  // that way after a preset is applied. Persisting backend/backendVersion
  // here previously did NOT also persist backendType, which pinned the
  // template to a specific fork+version with an unset type -- ambiguous
  // the moment more than one backend TYPE (e.g. vulkan and rocm) is
  // installed for that same fork+version, since resolveBackend then had no
  // way to tell them apart and could silently pick either one.
  const backend = await resolveBackend(t)
  const baseline = await buildQuickBaseline(meta, isMoe, gpuLayersMax, backend)
  // MERGE the baseline onto the existing args — matching
  // handleQuickPreset()/handleFullAutoPreset() exactly, which spread the
  // engine baseline onto the CURRENT args rather than replacing them
  // wholesale. This preserves sampling values, --mmproj, and anything else
  // Quick/FullAuto don't touch — replacing args entirely (the previous
  // behavior here) silently wiped all of that on every preset application.
  const mergedArgs: Record<string, any> = { ...(t.args || {}), ...baseline }
  // --ctx-size specifically uses setIfAbsent semantics in the real Quick
  // button (only filled in if not already set) — restore an existing value
  // baseline would otherwise have overwritten.
  const existingCtx = (t.args || {})['--ctx-size']
  if (existingCtx !== undefined && existingCtx !== '') mergedArgs['--ctx-size'] = existingCtx
  if (preset === 'quick') {
    mergedArgs['__lastPreset'] = 'quick'
    const patch = { ...t, args: mergedArgs, updatedAt: new Date().toISOString() }
    delete (patch as any)._file
    await D().saveTemplate(patch)
    return { template: t.name, preset: 'Quick', applied: true }
  }
  // full-auto: same merged baseline, then the same two overrides
  // handleFullAutoPreset() applies — GPU layers to maximum for Dense (unset,
  // i.e. "auto", for MoE), and Context Fill set to "auto" so --fit at launch
  // time (see buildLaunchArgs) handles both offload and context itself.
  if (isMoe) delete mergedArgs['--gpu-layers']
  else mergedArgs['--gpu-layers'] = gpuLayersMax
  mergedArgs['__ignoreCtxOverride'] = true
  mergedArgs['__autoCtxFill'] = 'auto'
  mergedArgs['__lastPreset'] = 'fullauto'
  const patch = { ...t, args: mergedArgs, updatedAt: new Date().toISOString() }
  delete (patch as any)._file
  await D().saveTemplate(patch)
  return { template: t.name, preset: 'FULL AUTO', applied: true }
}

// Builds a flag<->label lookup from the effective backend's CommandsSchema
// (the same schema CmdParamsEditor.tsx renders from), so display-parameters-*
// can show the UI's own labels/types instead of bare "--flag" keys, and
// template-edit can accept either a flag or its label. Falls back to an
// empty schema (label defaults to the flag itself) if no schema is available
// for some reason — callers degrade gracefully rather than failing.
async function getSchemaLookup(t: Template): Promise<{ flagToParam: Map<string, any>; labelToFlag: Map<string, string>; shortToFlag: Map<string, string> }> {
  const flagToParam = new Map<string, any>()
  const labelToFlag = new Map<string, string>()
  const shortToFlag = new Map<string, string>()
  try {
    const backend = await resolveBackend(t)
    const schema = await D().getCommands(backend.backendKey)
    for (const cat of schema?.categories || []) {
      for (const cmd of cat.commands || []) {
        flagToParam.set(cmd.arg, cmd)
        labelToFlag.set(cmd.label.toLowerCase(), cmd.arg)
        // e.g. "-lm" -> "--load-mode", so template-edit accepts the short
        // flag (with or without its leading "-") the same way the UI's own
        // Parameters list shows it ("-lm, --load-mode").
        if (cmd.short) shortToFlag.set(cmd.short.toLowerCase().replace(/^-+/, ''), cmd.arg)
      }
    }
  } catch {}
  return { flagToParam, labelToFlag, shortToFlag }
}

// Shows the Template's parameters the same way the app's own interface
// does: each SET flag paired with its schema label/type (from
// CommandsSchema — the same lookup CmdParamsEditor.tsx renders from), i.e.
// "the affecting llama.cpp value" (the raw --flag and its stored value)
// alongside the UI-facing name. This is deliberately NOT the resolved
// launch command — AutoFit/"--fit" expansion, YaRN, and any other
// launch-time-only transformation are display-preview's job exclusively;
// here every value is exactly what's stored on the Template (and thus
// exactly what template-edit would be changing).
async function paramsView(t: Template, view: 'common' | 'full') {
  const args = t.args || {}
  let entries = Object.entries(args).filter(([k]) => !k.startsWith('__'))
  // "Common" returns the same curated flag subset the UI's Common
  // Parameters view shows (COMMON_PARAM_FLAGS, shared with
  // CmdParamsEditor.tsx) — only flags actually SET on the template AND in
  // that curated set. "Full" returns every parameter that's actually set,
  // with nothing filtered out.
  if (view === 'common') entries = entries.filter(([k]) => COMMON_PARAM_FLAGS.has(k))
  const { flagToParam } = await getSchemaLookup(t)
  const parameters = entries.map(([flag, value]) => {
    const cmd = flagToParam.get(flag)
    return {
      flag,                                   // the raw llama.cpp value this affects, e.g. "--ctx-size"
      label: cmd?.label || flag,              // the same name the app's interface shows for it
      value,                                  // exactly what's stored on the Template (what template-edit changes)
      type: cmd?.type || null,
      options: cmd?.options || undefined      // for select-type params, the UI's own valid choices
    }
  })
  // Composite UI toggles that don't map to a single flag — the app's
  // interface shows each as a switch, not a tunable value. N-gram Map/
  // Modifier are derived from --spec-type (a comma-separated segment list);
  // Automatic YaRN scaling control is the synthetic __yarnAutoScale key.
  // Included in BOTH views (common and full) since an agent needs to see a
  // toggle's state before deciding whether to flip it via template-edit,
  // regardless of parameter-view filtering. template-edit accepts each
  // toggle's own label/key as a plain boolean — see toolTemplateEdit.
  const { mapK4vOn, modOn } = getNgramModifierState(args)
  const toggles = [
    {
      label: 'N-gram Map (K4V)', key: 'ngram-map-k4v', enabled: mapK4vOn,
      subParameters: mapK4vOn ? Object.fromEntries(NGRAM_MAP_K4V_FLAGS.filter(f => args[f] !== undefined).map(f => [f, args[f]])) : undefined
    },
    {
      label: 'N-gram Modifier', key: 'ngram-mod', enabled: modOn,
      subParameters: modOn ? Object.fromEntries(NGRAM_MOD_FLAGS.filter(f => args[f] !== undefined).map(f => [f, args[f]])) : undefined
    },
    {
      label: 'Automatic YaRN scaling control', key: 'yarn-auto-scale', enabled: args['__yarnAutoScale'] === true,
      note: 'While on, RoPE Scaling / RoPE Scale / YaRN Original Context are managed automatically and should not be set directly.'
    }
  ]
  return {
    template: t.name,
    view,
    parameters,
    toggles,
    overrides: {
      ignoreCtxOverride: args['__ignoreCtxOverride'] === true,
      autoCtxFill: args['__autoCtxFill'] ?? 'off',
      ignoreBaseUrlOverride: args['__ignoreBaseUrlOverride'] === true
    },
    backend: { backendKey: t.backendKey || null, backendVersion: t.backendVersion || null },
    note: 'These are the Template\'s stored values, shown the same way the app\'s interface shows them — not the resolved launch command (AutoFit/--fit/etc. only apply at launch time). Use display-preview for the reconstructed launch command.'
  }
}
export async function toolDisplayParametersCommon(args: { template: string }) {
  return paramsView(findTemplate(args.template), 'common')
}
export async function toolDisplayParametersFull(args: { template: string }) {
  return paramsView(findTemplate(args.template), 'full')
}

// Best-effort reconstruction of the final launch command — see
// buildLaunchArgs()'s doc comment for exactly what this does and doesn't
// replicate compared to the renderer's live Command Preview.
export async function toolDisplayPreview(args: { template: string }) {
  const t = findTemplate(args.template)
  const backend = await resolveBackend(t)
  const { args: launchArgs, ctxAutoFitApplied, fitMode } = await buildLaunchArgs(t)
  return {
    template: t.name,
    command: [backend.exe, ...launchArgs].join(' '),
    ctxAutoFitApplied,
    fitMode
  }
}

export async function toolDisplayTs(args: { template: string }) {
  const t = findTemplate(args.template)
  if (t.lastSessionFirstTps == null && t.lastSessionAvgTps == null) {
    return { template: t.name, status: 'no session data yet' }
  }
  return {
    template: t.name,
    firstTokensPerSec: t.lastSessionFirstTps,
    averageTokensPerSec: t.lastSessionAvgTps,
    lastSessionEndedAt: t.lastSessionAt ?? null
  }
}

// ---------------------------------------------------------------------------
// benchmark
// ---------------------------------------------------------------------------

const DEFAULT_BENCHMARK_PROMPTS = [
  'Hi',
  'Describe the most beautiful scenery you can imagine',
  'Create an svg painting that matches your description'
]

// Streams the completion (stream: true) and times the FIRST chunk that
// actually carries generated content — not just the first HTTP byte, which
// under stream:false (the previous implementation) arrives only once the
// ENTIRE completion is already buffered server-side, making ttftMs equal
// totalMs for every single prompt. llama-server's own per-request `timings`
// (present on the final SSE chunk) are preferred for tokensPredicted/genTps
// when available, since they're measured server-side rather than reconstructed
// from our own chunk-arrival timestamps; we fall back to counting content
// chunks and using our own elapsed time only when a server/fork doesn't
// include them.
async function postChatPrompt(port: number, prompt: string, timeoutMs = 120000): Promise<{ ttftMs: number; totalMs: number; tokensPredicted: number; genTps: number }> {
  const http = await import('http')
  // llama-server tears down the TCP connection once a streamed (SSE)
  // response finishes. Node's default agent keeps connections alive (Node
  // >= 19), so without a dedicated agent the next prompt would reuse that
  // dead pooled socket and fail with "read ECONNRESET". A no-keep-alive
  // agent gives each request its own fresh socket.
  const noKeepAliveAgent = new http.Agent({ keepAlive: false })
  const started = Date.now()
  let firstTokenAt: number | null = null
  let contentChunkCount = 0
  let lastTimings: any = null
  let lastUsage: any = null
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ messages: [{ role: 'user', content: prompt }], stream: true, stream_options: { include_usage: true } })
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      agent: noKeepAliveAgent
    }, res => {
      res.setEncoding('utf8')
      let buffer = ''
      res.on('data', chunk => {
        buffer += chunk
        // SSE events are separated by a blank line; each event's payload is
        // one or more "data: ..." lines. llama-server sends one JSON object
        // per "data:" line, terminated by a literal "data: [DONE]".
        let sepIdx: number
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx)
          buffer = buffer.slice(sepIdx + 2)
          for (const line of rawEvent.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const dataStr = trimmed.slice(5).trim()
            if (!dataStr || dataStr === '[DONE]') continue
            try {
              const json = JSON.parse(dataStr)
              if (json.timings) lastTimings = json.timings
              if (json.usage) lastUsage = json.usage
              const delta = json.choices?.[0]?.delta
              if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
                if (firstTokenAt === null) firstTokenAt = Date.now()
                contentChunkCount++
              }
            } catch {
              // Ignore malformed/partial SSE lines rather than failing the
              // whole benchmark over one unparsable event.
            }
          }
        }
      })
      res.on('end', () => {
        const totalMs = Date.now() - started
        const ttftMs = firstTokenAt !== null ? firstTokenAt - started : totalMs
        const tokensPredicted = lastTimings?.predicted_n ?? lastUsage?.completion_tokens ?? contentChunkCount
        const predictedMs = lastTimings?.predicted_ms ?? Math.max(1, totalMs - ttftMs)
        const genTps = predictedMs > 0 ? Math.round((tokensPredicted / (predictedMs / 1000)) * 100) / 100 : 0
        resolve({ ttftMs, totalMs, tokensPredicted, genTps })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Prompt timed out')) })
    req.write(body)
    req.end()
  })
}

// Stops the target, starts it, runs the prompts, stops it, restarts the
// caller. The caller always comes home on every exit path — see the
// try/finally below.
export async function toolBenchmark(args: { template: string; prompts?: string[]; callerTemplateId?: string | null }) {
  const target = findTemplate(args.template)
  const prompts = (args.prompts && args.prompts.length > 0) ? args.prompts : DEFAULT_BENCHMARK_PROMPTS
  const callerId = args.callerTemplateId || null
  const callerTemplate = callerId ? D().listTemplates().find(t => t.id === callerId) : null
  // The target itself already being the thing that's running IS the
  // self-benchmark case (whether or not the caller could tell us its own
  // id) — that's what actually needs restoring afterward, not a "blocker".
  const targetWasRunning = D().isRunning(target.id).running
  const selfBenchmark = targetWasRunning || (!!callerTemplate && callerTemplate.id === target.id)

  // The target's actual effective port — respecting Base URL Override, the
  // same way info-templates computes it — is what we actually need free,
  // NOT specifically "whatever template the caller claims to be". A model
  // calling this tool essentially never knows its own template/port (see
  // info-templates' description), so relying on callerTemplateId alone to
  // free up the port left this tool failing with "port already in use"
  // whenever a caller couldn't self-identify — which is the common case.
  // Instead, find whichever OTHER Template is ACTUALLY occupying the port
  // the target needs (observable directly from runningProcesses, unlike the
  // caller's identity) and treat that as the thing to stop and restore.
  const overridePort = await D().getOverridePort()
  const targetIgnoresOverride = (target.args || {})['__ignoreBaseUrlOverride'] === true
  const targetEffectivePort = (overridePort !== null && !targetIgnoresOverride) ? overridePort : (target.serverPort || 8080)
  const allTemplates = D().listTemplates()
  let blocker: Template | null = (callerTemplate && callerTemplate.id !== target.id) ? callerTemplate : null
  if (!targetWasRunning) {
    for (const t of allTemplates) {
      if (t.id === target.id) continue
      const running = D().isRunning(t.id)
      if (running.running && running.port === targetEffectivePort) { blocker = t; break }
    }
  }
  const blockerWasRunning = blocker ? D().isRunning(blocker.id) : null
  const results: { prompt: string; kind: 'cold' | 'warm'; ttftMs: number; totalMs: number; tokensPredicted: number; genTps: number }[] = []
  let error: string | null = null

  try {
    // Stop whatever's occupying the target's port (frees it — needed
    // whenever the caller happens to be running on it, including the
    // caller === target case) and the target itself if it's already
    // running some other way, then start the target fresh.
    if (blocker && blockerWasRunning?.running) await D().stopModel(blocker.id, { skipCheckpoint: true })
    if (targetWasRunning) await D().stopModel(target.id, { skipCheckpoint: true })
    const backend = await resolveBackend(target)
    const { args: launchArgs } = await buildLaunchArgs(target)
    const started = await D().runModel({
      id: target.id, name: target.name, backendPath: backend.path, exe: backend.exe,
      args: launchArgs, openBrowser: false, port: target.serverPort || 8080,
      ignoreBaseUrlOverride: targetIgnoresOverride, skipCheckpoint: true
    })
    if (!started.success || !started.port) throw new Error(started.error || 'Target failed to start')
    // Wait for the target to actually finish loading before the first
    // prompt — a fixed delay isn't enough for larger models, and sending a
    // prompt too early just hits llama-server's 503 "Loading model".
    const readiness = await waitForServerReady(started.port)
    if (!readiness.ready) throw new Error(`Target did not become ready within the timeout (waited ${Math.round(readiness.waitedMs / 1000)}s)`)
    for (let i = 0; i < prompts.length; i++) {
      const r = await postChatPrompt(started.port, prompts[i])
      results.push({ prompt: prompts[i], kind: i === 0 ? 'cold' : 'warm', ...r })
    }
  } catch (err: any) {
    error = err?.message || String(err)
  } finally {
    try { await D().stopModel(target.id, { skipCheckpoint: true }) } catch {}
    // Restore exactly whichever thing was actually running before this
    // call started — the target itself for a self-benchmark (without this,
    // a self-benchmark would leave the caller's own server stopped with
    // nothing to bring it back, requiring a second, manual restart — which
    // could also lose to a stale exit event from the just-stopped process,
    // see the runModelImpl exit handler's staleness guard), or the blocker
    // if a DIFFERENT Template had to be stopped to free the port.
    if (targetWasRunning) {
      try {
        const backend = await resolveBackend(target)
        const { args: launchArgs } = await buildLaunchArgs(target)
        const res = await D().runModel({
          id: target.id, name: target.name, backendPath: backend.path, exe: backend.exe,
          args: launchArgs, openBrowser: false, port: target.serverPort || 8080,
          ignoreBaseUrlOverride: targetIgnoresOverride, skipCheckpoint: true
        })
        if (res.success && res.port) await waitForServerReady(res.port)
      } catch {}
    } else if (blocker && blockerWasRunning?.running) {
      try {
        const blockerIgnoresOverride = (blocker.args || {})['__ignoreBaseUrlOverride'] === true
        const backend = await resolveBackend(blocker)
        const { args: launchArgs } = await buildLaunchArgs(blocker)
        const res = await D().runModel({
          id: blocker.id, name: blocker.name, backendPath: backend.path, exe: backend.exe,
          args: launchArgs, openBrowser: false, port: blocker.serverPort || 8080,
          ignoreBaseUrlOverride: blockerIgnoresOverride, skipCheckpoint: true
        })
        if (res.success && res.port) await waitForServerReady(res.port)
      } catch {}
    }
  }

  // Save this run into the Template's benchmark history (newest first,
  // trimmed to settings.mcp.maxBenchmarkHistory) — even on a partial/failed
  // run, so a caller can see what went wrong later via display-benchmark.
  // The tag is the run's own ISO timestamp: sortable, unique in practice,
  // and directly usable as a lookup key by display-benchmark's `tag` param.
  try {
    const settings = await D().loadSettings()
    const maxHistory = settings.mcp?.maxBenchmarkHistory ?? 5
    const freshTarget = D().listTemplates().find(x => x.id === target.id)
    if (freshTarget) {
      const record: any = {
        tag: new Date().toISOString(),
        ranAt: Date.now(),
        results,
        measurementConditions: 'Fresh empty slot, no prompt cache — real-load speeds under a populated KV cache will be lower.',
        error,
        paramsSnapshot: { ...(target.args || {}) }
      }
      const history = [record, ...(freshTarget.benchmarkHistory || [])].slice(0, maxHistory)
      const patch = { ...freshTarget, benchmarkHistory: history }
      delete (patch as any)._file
      await D().saveTemplate(patch)
    }
  } catch {}

  return {
    template: target.name,
    selfBenchmark,
    measurementConditions: 'Fresh empty slot, no prompt cache — real-load speeds under a populated KV cache will be lower.',
    callerRestartNote: selfBenchmark ? "Caller and target were the same template — the restart wiped the caller's own KV cache; its next request will re-encode the prompt from scratch." : undefined,
    results,
    error
  }
}

// Deep-ish equality for a Template's args dict: every key present on either
// side must exist on both with the same value. Used by display-benchmark to
// decide "same launch parameters" vs listing what changed.
function argsEqual(a: Record<string, any>, b: Record<string, any>): boolean {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})])
  for (const k of keys) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) return false
  }
  return true
}

export async function toolDisplayBenchmark(args: { template: string; mode: 'diff' | 'full'; amount?: number; tag?: string | string[] }) {
  const t = findTemplate(args.template)
  const history = t.benchmarkHistory || []
  if (history.length === 0) return { template: t.name, benchmarks: [], note: 'No benchmark history yet — run benchmark first.' }

  let selected: typeof history
  if (args.tag) {
    const tags = Array.isArray(args.tag) ? args.tag : [args.tag]
    selected = history.filter(r => tags.includes(r.tag))
  } else {
    // "If amount of last benchmarks to display isn't stated in request,
    // output only the last one." History is already stored newest-first.
    const amount = (typeof args.amount === 'number' && args.amount > 0) ? Math.floor(args.amount) : 1
    selected = history.slice(0, amount)
  }
  // Newest to oldest whenever more than one is returned (history is already
  // stored newest-first, but tag lookups can come back out of that order).
  selected = [...selected].sort((a, b) => b.ranAt - a.ranAt)

  const currentArgs = t.args || {}
  const entries = selected.map(record => {
    const same = argsEqual(record.paramsSnapshot || {}, currentArgs)
    let parameters: string | Record<string, any>
    if (same) {
      parameters = 'same launch parameters'
    } else if (args.mode === 'full') {
      parameters = record.paramsSnapshot || {}
    } else {
      // diff: only the keys that differ, showing the SNAPSHOT's value (what
      // the Template was actually launched with for this benchmark) —
      // present-on-one-side-only counts as a difference too.
      const diff: Record<string, any> = {}
      const keys = new Set([...Object.keys(record.paramsSnapshot || {}), ...Object.keys(currentArgs)])
      for (const k of keys) {
        if (JSON.stringify(record.paramsSnapshot?.[k]) !== JSON.stringify(currentArgs?.[k])) {
          diff[k] = record.paramsSnapshot?.[k]
        }
      }
      parameters = diff
    }
    return {
      tag: record.tag,
      ranAt: record.ranAt,
      results: record.results,
      measurementConditions: record.measurementConditions,
      error: record.error,
      parameters
    }
  })

  return { template: t.name, mode: args.mode, benchmarks: entries }
}

// ---------------------------------------------------------------------------
// switch-template (formerly rotate-model) — LIFECYCLE ONLY. See the
// leftover-plan doc for what this deliberately does not do (task/
// oneshot-task assignment, turn counters, reminder injection, silent
// auto-switch, compaction): those require an in-app chat surface XLM Studio
// doesn't have. This tool only performs the start/stop lifecycle steps and
// reports the resulting ports, for an EXTERNAL MCP client (or the skill
// scripts) to drive directly.
// ---------------------------------------------------------------------------
export async function toolSwitchTemplate(args: { steps: { action: 'start' | 'stop'; template: string }[] }) {
  if (!Array.isArray(args.steps) || args.steps.length === 0) throw new ToolError('steps must be a non-empty array of { action, template }')
  // Validate the whole chain up front — all template names must resolve —
  // before executing the first step.
  const resolved = args.steps.map(s => ({ action: s.action, template: findTemplate(s.template) }))
  const results: { template: string; action: string; success: boolean; port?: number; error?: string; ready?: boolean; loadWaitMs?: number }[] = []
  for (const step of resolved) {
    if (step.action === 'stop') {
      const res = await D().stopModel(step.template.id)
      results.push({ template: step.template.name, action: 'stop', success: res.success, error: res.error })
    } else {
      const running = D().isRunning(step.template.id)
      if (running.running) {
        results.push({ template: step.template.name, action: 'start', success: false, error: 'Already running', port: running.port })
        continue
      }
      const backend = await resolveBackend(step.template)
      const { args: launchArgs } = await buildLaunchArgs(step.template)
      const res = await D().runModel({
        id: step.template.id, name: step.template.name, backendPath: backend.path, exe: backend.exe,
        args: launchArgs, openBrowser: false, port: step.template.serverPort || 8080,
        ignoreBaseUrlOverride: (step.template.args || {})['__ignoreBaseUrlOverride'] === true
      })
      if (res.success && res.port) {
        // Same reasoning as template-action: block this step (and therefore
        // the whole tool call) until the model is actually ready, so a
        // caller chaining "start" then immediately sending a prompt doesn't
        // race llama-server's own load time.
        const readiness = await waitForServerReady(res.port)
        results.push({ template: step.template.name, action: 'start', success: res.success, port: res.port, error: res.error, ready: readiness.ready, loadWaitMs: readiness.waitedMs })
      } else {
        results.push({ template: step.template.name, action: 'start', success: res.success, port: res.port, error: res.error })
      }
    }
  }
  return { results }
}

// ---------------------------------------------------------------------------
// Tool table — descriptions doubled-up for both the MCP schema and the
// generated SKILL.md, so the two are always in sync.
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string
  description: string
  // JSON-schema-ish parameter description, used both to build the zod
  // schema for the MCP SDK and the usage text in SKILL.md.
  params: { name: string; type: string; required: boolean; description: string }[]
  handler: (args: any) => Promise<any>
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'template-action', handler: toolTemplateAction,
    description: 'Start or stop a Template by name. A "start" call does not return until the model has actually finished loading and is ready to serve a request (polls llama-server\'s health endpoint, up to 10 minutes for large models) — safe to send a prompt immediately after this call returns. Mainly useful for managing setups with MULTIPLE Templates (starting one while another stays up, or switching which one is active) — stopping the Template you are yourself running on with no plan to bring it back will disconnect you.',
    params: [
      { name: 'template', type: 'string', required: true, description: 'Template name' },
      { name: 'action', type: '"start" | "stop"', required: true, description: 'What to do' }
    ]
  },
  {
    name: 'info-templates', handler: toolInfoTemplates,
    description: 'List all Templates, whether each is active, and on which port (Base URL Override taken into account). If more than one Template is active, and you are yourself a model that might be running inside one of these Templates, ask the user which one you are before using switch-template — there is no reliable way to detect this automatically.',
    params: []
  },
  {
    name: 'info-models', handler: toolInfoModels,
    description: 'List all detected model files grouped by folder, with their multimodal projector and speculative-decoding sidecar files. isMoe/hasNativeMtp/contextLength are included when already cached (null if the model hasn\'t been opened/used anywhere yet).',
    params: []
  },
  {
    name: 'info-backends', handler: toolInfoBackends,
    description: 'List all detected installed backends.',
    params: []
  },
  {
    name: 'info-tracked-backends', handler: toolInfoTrackedBackends,
    description: 'List all tracked backend repos and whether each has an update detected, is up to date, or last failed to fetch.',
    params: []
  },
  {
    name: 'template-duplicate', handler: toolTemplateDuplicate,
    description: 'Duplicate a Template one or more times. Copies are tagged "MCP-made".',
    params: [
      { name: 'template', type: 'string', required: true, description: 'Template to duplicate' },
      { name: 'copies', type: 'number', required: true, description: 'How many copies to create' }
    ]
  },
  {
    name: 'template-create', handler: toolTemplateCreate,
    description: 'Create a new Template the same way the UI does (Quick preset applied automatically). Tagged "MCP-made".',
    params: [
      { name: 'name', type: 'string', required: true, description: 'New template name' },
      { name: 'model', type: 'string', required: true, description: 'Model file name or path, from info-models' },
      { name: 'backend', type: 'string', required: false, description: 'Backend key/version/display name, from info-backends. Falls back to the persisted Global Backend (Settings/Sidebar\'s "Set Active" backend) if omitted, then the newest installed llama.cpp build. If this matches more than one installed backend (the same fork+version can exist under several GPU-runtime types at once, e.g. a vulkan and a rocm build of the same release), pass backendType too to pick the exact one -- otherwise it prefers whichever matches the Global Backend\'s own type, then just the first match.' },
      { name: 'backendType', type: 'string', required: false, description: 'Disambiguates `backend` when it matches more than one installed variant (e.g. "vulkan", "rocm", "cuda-12.4" -- see info-backends\' backendType field). Ignored if `backend` alone is already unambiguous.' }
    ]
  },
  {
    name: 'template-edit', handler: toolTemplateEdit,
    description: 'Edit one or more Templates: model, backend, multimodal projector, speculative decoding, or any other parameter. Each parameter key accepts its display-parameters label ("Context Size"), its raw flag ("ctx-size"/"--ctx-size"), or its short flag ("-c"). Also accepts the three composite toggles from display-parameters-* as plain booleans: "N-gram Map (K4V)"/"ngram-map-k4v", "N-gram Modifier"/"ngram-mod" (each auto-applies/removes its own default sub-parameters), and "Automatic YaRN scaling control"/"yarn-auto-scale". Changing "backend"/"backendKey" or "backendVersion" without also setting "backendType" in the same call auto-resolves the type (adopts the installed match\'s type if the new key+version is unambiguous, else the Global Backend\'s type if it happens to be that same fork+version, else clears it back to ambiguous) -- pass "backendType" explicitly (from info-backends) to pin an exact GPU-runtime variant when more than one is installed for that fork+version. Refuses to change model/backend/backendVersion/backendType of a currently-serving Template. If "Only allow Template edits via MCP for MCP-made Templates" is on, only "MCP-made"-tagged Templates can be edited.',
    params: [
      { name: 'templates', type: 'string[]', required: true, description: 'One or more Template names' },
      { name: 'changes', type: 'object', required: true, description: 'Key/value map of parameters to change, e.g. {"ctx-size": 8192, "model": "...", "backendType": "vulkan"}. Set "backend"/"backendKey" to "" (empty string) to unpin and go back to following the Global Backend.' }
    ]
  },
  {
    name: 'total-ram', handler: toolTotalRam,
    description: 'Total RAM, total VRAM, and total RAM+VRAM.',
    params: []
  },
  {
    name: 'free-ram', handler: toolFreeRam,
    description: 'Currently free RAM, free VRAM, and free RAM+VRAM.',
    params: []
  },
  {
    name: 'apply-parameters-preset', handler: toolApplyParametersPreset,
    description: 'Apply the Clean (0), Quick (1), or FULL AUTO (2) parameter preset to a Template.',
    params: [
      { name: 'preset', type: '"Clean"|"Quick"|"FULL AUTO"|0|1|2', required: true, description: 'Which preset to apply' },
      { name: 'template', type: 'string', required: true, description: 'Target template name' }
    ]
  },
  {
    name: 'display-parameters-common', handler: toolDisplayParametersCommon,
    description: 'Show a Template\'s parameters the same way the app\'s interface shows them (label + raw flag + stored value + type), filtered to the curated "Common Parameters" set (ctx-size, threads, gpu-layers, batch/ubatch size, parallel, flash-attn, sampling, KV cache type/offload, load-mode, keep, seed) — only those actually set on the Template. Also includes a "toggles" array (N-gram Map (K4V), N-gram Modifier, Automatic YaRN scaling control) showing each toggle\'s on/off state and any active sub-parameters — pass a toggle\'s label straight to template-edit to flip it with defaults auto-applied. These are the Template\'s stored values, not the resolved launch command — use display-preview for that. Prefer this over display-parameters-full.',
    params: [{ name: 'template', type: 'string', required: true, description: 'Template name' }]
  },
  {
    name: 'display-parameters-full', handler: toolDisplayParametersFull,
    description: 'Show every parameter actually set on a Template, unfiltered, the same way the app\'s interface shows them (label + raw flag + stored value + type). Also includes the same "toggles" array as display-parameters-common (N-gram Map (K4V), N-gram Modifier, Automatic YaRN scaling control). These are the Template\'s stored values, not the resolved launch command — use display-preview for that.',
    params: [{ name: 'template', type: 'string', required: true, description: 'Template name' }]
  },
  {
    name: 'display-preview', handler: toolDisplayPreview,
    description: 'Show a best-effort reconstruction of the ACTUAL final llama-server launch command for a Template — the only tool that shows resolved, launch-time llama.cpp values (AutoFit/--fit expansion included). display-parameters-common/full show the Template\'s own stored values instead; use this one when you need what will actually run.',
    params: [{ name: 'template', type: 'string', required: true, description: 'Template name' }]
  },
  {
    name: 'display-ts', handler: toolDisplayTs,
    description: 'Show the first-detected and average tokens/sec from a Template\'s LAST COMPLETED session — i.e. this only has data once the Template has been stopped at least once after generating something; a currently-running session\'s live speed isn\'t included. Returns "no session data yet" until then (never 0).',
    params: [{ name: 'template', type: 'string', required: true, description: 'Template name' }]
  },
  {
    name: 'benchmark', handler: toolBenchmark,
    description: 'Benchmark a Template with 3 default prompts (or custom ones): frees the target\'s port (stopping whichever Template is actually occupying it — detected automatically, you do not need to know your own identity), starts the target fresh, sends each prompt to a fresh slot, reports time-to-first-token and tokens/sec per prompt, then restores whichever Template was actually running before the call. The run (results + the Template\'s launch parameters at the time) is saved into that Template\'s benchmark history — see display-benchmark. Benchmarks are more representative run one at a time, sequentially, rather than in parallel — that better reflects a model\'s actual peak throughput unless you specifically intend to measure a multi-model-at-once setup.',
    params: [
      { name: 'template', type: 'string', required: true, description: 'Template to benchmark' },
      { name: 'prompts', type: 'string[]', required: false, description: 'Custom prompts. Omit to use the default 3-prompt test.' }
    ]
  },
  {
    name: 'display-benchmark', handler: toolDisplayBenchmark,
    description: 'Show past benchmark run(s) for a Template, each tagged with the ISO timestamp it ran at. Only the LAST benchmark is shown if neither "amount" nor "tag" is given. In "diff" mode: if that run\'s launch parameters match the Template\'s CURRENT ones exactly, returns "same launch parameters"; otherwise returns just the parameters that differed (showing the value they had AT THAT RUN). In "full" mode: same "same launch parameters" check, but on a difference returns the ENTIRE parameter snapshot from that run instead of just the diff. Multiple results are sorted newest to oldest.',
    params: [
      { name: 'template', type: 'string', required: true, description: 'Template name' },
      { name: 'mode', type: '"diff" | "full"', required: true, description: 'How to report parameter changes since that run' },
      { name: 'amount', type: 'number', required: false, description: 'How many of the most recent runs to show. Defaults to 1 (just the last one). Ignored if "tag" is given.' },
      { name: 'tag', type: 'string | string[]', required: false, description: 'Specific run(s) by their ISO-timestamp tag, from a previous benchmark/display-benchmark result.' }
    ]
  },
  {
    name: 'switch-template', handler: toolSwitchTemplate,
    description: 'Run a chain of start/stop lifecycle steps across Templates and report the resulting ports. Each "start" step blocks until that model has actually finished loading and is ready to serve (see template-action) before moving to the next step, so it\'s safe to send a prompt to the newly-started model as soon as this call returns. If you are yourself a model running inside one of these Templates and you want to hand off to another one, call THIS tool (stop yourself, start the other) — do not stop, then start in separate tool calls. There is no reliable way to detect which Template you yourself are running on; if info-templates shows more than one Template active, ask the user which one you are before switching. LIFECYCLE ONLY: this does not hand a live chat conversation between models — see the leftover-plan doc for why, and drive the actual conversation from this MCP client.',
    params: [{ name: 'steps', type: '{action:"start"|"stop", template:string}[]', required: true, description: 'Ordered list of lifecycle steps, validated before any of them run.' }]
  }
]

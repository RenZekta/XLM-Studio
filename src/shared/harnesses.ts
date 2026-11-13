import type { BaseUrlOverride, Template } from './types'
import { STRATA_NATIVE_CONTEXT } from './strata'

// Coding-agent harnesses XLM Studio can write a provider into. The pure parts
// (which templates become which provider, and how each harness's config file
// is edited) live here so they can be verified without Electron.

export type HarnessId = 'dsh' | 'pi' | 'pithagoras' | 'opencode'

export interface HarnessDef {
  id: HarnessId
  label: string
  url: string
  // npm package that carries the version (and the update, where it is npm-installed).
  npmPackage?: string
  // Earlier package names an existing install may still carry.
  legacyNpmPackages?: string[]
  binaries: string[]
}

export const HARNESSES: Record<HarnessId, HarnessDef> = {
  dsh: {
    id: 'dsh',
    label: 'DeepSeek Harness',
    url: 'https://github.com/deepseek-ai/deepseek-harness',
    npmPackage: '@deepseek-ai/dsh',
    binaries: ['dsh']
  },
  pithagoras: {
    id: 'pithagoras',
    label: 'Pithagoras',
    url: 'https://github.com/thecodacus/pithagoras',
    binaries: []
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    url: 'https://opencode.ai',
    npmPackage: 'opencode-ai',
    binaries: ['opencode']
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    url: 'https://pi.dev',
    npmPackage: '@earendil-works/pi-coding-agent',
    legacyNpmPackages: ['@mariozechner/pi-coding-agent'],
    binaries: ['pi']
  }
}

// Shown order: the harnesses XLM Studio supports best come first.
export const HARNESS_ORDER: HarnessId[] = ['dsh', 'opencode', 'pi', 'pithagoras']

export function isHarnessId(v: unknown): v is HarnessId {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HARNESSES, v)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface HarnessSettings {
  // Harnesses that keep an "XLM Studio" provider.
  syncOn: HarnessId[]
  autoUpdate: boolean
  // Config folder overrides (DSH_HOME, the pi agent folder, the opencode config folder).
  configDirs: Partial<Record<HarnessId, string>>
  // Pithagoras runs in a container built from a git clone: the folder of that
  // clone (found from the container when empty), where the portal listens, and
  // the portal password the provider API needs.
  pithagorasDir: string
  pithagorasUrl: string
  pithagorasPassword: string
  // The folder of repositories its container may edit (WORKSPACES_DIR in its .env); optional.
  pithagorasWorkspacesDir: string
}

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  syncOn: [],
  autoUpdate: false,
  configDirs: {},
  pithagorasDir: '',
  pithagorasUrl: '',
  pithagorasPassword: '',
  pithagorasWorkspacesDir: ''
}

export function migrateHarnessSettings(raw: any): HarnessSettings {
  const configDirs: Partial<Record<HarnessId, string>> = {}
  if (raw?.configDirs && typeof raw.configDirs === 'object') {
    for (const [k, v] of Object.entries(raw.configDirs)) {
      if (isHarnessId(k) && typeof v === 'string' && v.trim()) configDirs[k] = v.trim()
    }
  }
  let syncOn: HarnessId[] = []
  if (Array.isArray(raw?.syncOn)) syncOn = raw.syncOn.filter(isHarnessId)
  else if (raw?.syncEnabled) {
    // The master switch this replaced: on meant every harness except the ones turned off.
    const off: unknown[] = Array.isArray(raw.syncOff) ? raw.syncOff : []
    syncOn = HARNESS_ORDER.filter(id => !off.includes(id))
  }
  return {
    syncOn: HARNESS_ORDER.filter(id => syncOn.includes(id)),
    autoUpdate: !!raw?.autoUpdate,
    configDirs,
    pithagorasDir: typeof raw?.pithagorasDir === 'string' ? raw.pithagorasDir.trim() : '',
    pithagorasUrl: typeof raw?.pithagorasUrl === 'string' ? raw.pithagorasUrl.trim().replace(/\/+$/, '') : '',
    pithagorasPassword: typeof raw?.pithagorasPassword === 'string' ? raw.pithagorasPassword : '',
    pithagorasWorkspacesDir: typeof raw?.pithagorasWorkspacesDir === 'string' ? raw.pithagorasWorkspacesDir.trim() : ''
  }
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

// Pulls a version like 1.19.5 or 0.2.1-rc.2 out of a command's output.
export function extractVersion(text: string): string | null {
  const m = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(text)
  return m ? m[1] : null
}

// Semver order with pre-releases below their release (0.2.1-rc.2 < 0.2.1).
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, '').split('-', 2)
    return { nums: core.split('.').map(n => parseInt(n, 10) || 0), pre: pre ? pre.split('.') : [] }
  }
  const x = split(a)
  const y = split(b)
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  if (!x.pre.length && !y.pre.length) return 0
  if (!x.pre.length) return 1
  if (!y.pre.length) return -1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const d = Number(p) - Number(q)
      if (d) return d < 0 ? -1 : 1
    } else if (pn !== qn) {
      return pn ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// Templates -> providers
// ---------------------------------------------------------------------------

// Provider ids XLM Studio owns in a harness: this one and "xlm-studio-<port>".
export const XLM_PROVIDER_PREFIX = 'xlm-studio'

// Harnesses insist on a key even when the server has none (llama-server then
// ignores whatever arrives), so an endpoint without one gets this.
export const PLACEHOLDER_API_KEY = 'xlm-studio'

export interface HarnessModel {
  // What the server reports and the harness sends: the template's name.
  id: string
  name: string
  // 0 when it can't be told; the harness default applies then.
  contextWindow: number
  maxTokens: number
  vision: boolean
}

export interface HarnessProvider {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  models: HarnessModel[]
}

export interface ProviderBuildInput {
  override: BaseUrlOverride | undefined
  autoFit: { enabled: boolean; contextLength: number }
  // The model's trained context from its GGUF header, when known.
  nativeContext: (modelPath: string) => number | null
}

export interface SkippedTemplate {
  name: string
  reason: 'duplicate-name' | 'no-name'
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function templatePort(t: Template, override: BaseUrlOverride | undefined): { port: number; followsOverride: boolean } {
  const follows = t.args?.['__ignoreBaseUrlOverride'] !== true && !!override?.enabled
  return follows
    ? { port: override!.port || 1234, followsOverride: true }
    : { port: Number(t.serverPort) || 8080, followsOverride: false }
}

// The id the server answers to: an explicit --alias, else the template's name
// (which XLM Studio passes as --alias at launch).
export function templateModelId(t: Pick<Template, 'name' | 'args'>): string {
  return str(t.args?.['--alias']) || str(t.args?.['-a']) || str(t.name)
}

// The context the template will run with. Mirrors the launch: the AutoFit
// floor lifts it unless the template opts out, and when llama-server fits it
// by itself (or the size is 0) the model's trained context is the best answer.
export function templateContext(t: Pick<Template, 'modelPath' | 'args' | 'engine'>, autoFit: ProviderBuildInput['autoFit'], native: (p: string) => number | null): number {
  const args = t.args || {}
  if (t.engine && t.engine !== 'llama.cpp') {
    // Strata has no AutoFit; without --context it picks a size from the hardware,
    // so the model's own context is the one number that never cuts it short.
    const own = Number(args['--context'] ?? 0) || 0
    if (own > 0) return Math.floor(own)
    return (t.modelPath && native(t.modelPath)) || STRATA_NATIVE_CONTEXT
  }
  const own = Number(args['--ctx-size'] ?? args['-c'] ?? 0) || 0
  const ignore = args['__ignoreCtxOverride'] === true
  let ctx = own
  if (ignore && args['__autoCtxFill'] === 'auto') ctx = 0
  else if (!ignore && autoFit.enabled && autoFit.contextLength > own) ctx = autoFit.contextLength
  if (ctx <= 0 && t.modelPath) ctx = native(t.modelPath) || 0
  return ctx > 0 ? Math.floor(ctx) : 0
}

export function hasVision(t: Pick<Template, 'args' | 'engine'>): boolean {
  // Strata loads the image encoder unless told "no"; its models all take images.
  if (t.engine && t.engine !== 'llama.cpp') return !['no', 'none'].includes(str(t.args?.['--vision']).toLowerCase())
  return !!(str(t.args?.['--mmproj']) || str(t.args?.['-mm']))
}

// Templates that follow the Base URL Override share one provider; every other
// endpoint (own port or key) gets a provider of its own.
export function buildHarnessProviders(templates: Template[], input: ProviderBuildInput): { providers: HarnessProvider[]; skipped: SkippedTemplate[] } {
  const skipped: SkippedTemplate[] = []
  const seen = new Set<string>()
  const groups = new Map<string, { main: boolean; port: number; apiKey: string; models: HarnessModel[] }>()
  const ovr = input.override
  const mainKey = ovr?.enabled && ovr.apiKeyEnabled ? str(ovr.apiKey) : ''

  for (const t of templates) {
    if (!t.modelPath) continue
    const id = templateModelId(t)
    if (!id) { skipped.push({ name: str(t.name), reason: 'no-name' }); continue }
    if (seen.has(id.toLowerCase())) { skipped.push({ name: id, reason: 'duplicate-name' }); continue }
    seen.add(id.toLowerCase())

    const { port, followsOverride } = templatePort(t, ovr)
    const apiKey = followsOverride ? mainKey : str(t.args?.['--api-key'])
    const key = followsOverride ? 'main' : `${port}|${apiKey}`
    let g = groups.get(key)
    if (!g) { g = { main: followsOverride, port, apiKey, models: [] }; groups.set(key, g) }
    const ctx = templateContext(t, input.autoFit, input.nativeContext)
    g.models.push({ id, name: str(t.name) || id, contextWindow: ctx, maxTokens: ctx, vision: hasVision(t) })
  }

  const providers: HarnessProvider[] = []
  const used = new Set<string>()
  const ordered = [...groups.values()].sort((a, b) => (a.main === b.main ? a.port - b.port : a.main ? -1 : 1))
  for (const g of ordered) {
    let id = g.main ? XLM_PROVIDER_PREFIX : `${XLM_PROVIDER_PREFIX}-${g.port}`
    for (let n = 2; used.has(id); n++) id = `${XLM_PROVIDER_PREFIX}-${g.port}-${n}`
    used.add(id)
    providers.push({
      id,
      label: g.main ? 'XLM Studio' : `XLM Studio :${g.port}`,
      baseUrl: `http://localhost:${g.port}/v1`,
      apiKey: g.apiKey || PLACEHOLDER_API_KEY,
      models: g.models
    })
  }
  return { providers, skipped }
}

// ---------------------------------------------------------------------------
// State shown in Settings
// ---------------------------------------------------------------------------

export interface HarnessSyncInfo {
  at: number
  changed: boolean
  error: string | null
}

export interface HarnessStatus {
  id: HarnessId
  installed: boolean
  version: string | null
  // The newest version found upstream; null until a check has run.
  latest: string | null
  updateAvailable: boolean
  // How it was installed, as far as it can be told ("npm global", "docker container").
  source: string | null
  // The install folder (for Pithagoras, its clone).
  binPath: string | null
  // The files XLM Studio writes its provider to (none where it goes through an API).
  configFiles: string[]
  // The API the provider is written through, when there is one.
  api: string | null
  // Whether this harness keeps the provider.
  syncOn: boolean
  sync: HarnessSyncInfo | null
  canUpdate: boolean
  // Pithagoras only: there is a clone and a container runtime to build it with.
  canRebuild: boolean
  // Its install, update or build wrote to the Logs tab.
  hasLog: boolean
  // What XLM Studio is doing to it right now.
  busy: 'install' | 'update' | 'remove' | 'rebuild' | null
  note: string | null
}

export interface HarnessState {
  settings: HarnessSettings
  statuses: HarnessStatus[]
  providers: Array<{ id: string; label: string; baseUrl: string; models: number }>
  skipped: SkippedTemplate[]
  checkedAt: number | null
}

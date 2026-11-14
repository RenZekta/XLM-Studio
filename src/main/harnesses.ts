import { execFile } from 'child_process'
import { watch, promises as fsp } from 'fs'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { delimiter, dirname, isAbsolute, join } from 'path'
import net from 'net'
import { run as runLogged } from './runLogged'
import { buildLogId } from '../shared/sourceBuild'
import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  HARNESS_ORDER, HARNESSES, PLACEHOLDER_API_KEY, XLM_PROVIDER_PREFIX, buildHarnessProviders, templateContext, templateReasoning, compareVersions, extractVersion, hasMcpClient, isHarnessId, migrateHarnessSettings,
  type HarnessId, type HarnessMcp, type HarnessProvider, type HarnessSettings, type HarnessState, type HarnessStatus, type HarnessSyncInfo, type SkippedTemplate
} from '../shared/harnesses'
import {
  envHasValue, planGooseProviders, setEnvKey, syncCrushConfig, syncDshPatch, syncGooseConfig, syncKimiConfig, syncKimiMcp, syncOpencodeConfig, syncPiModels, syncQwenSettings,
  type SyncResult
} from '../shared/harnessConfig'
import type { BaseUrlOverride, Template } from '../shared/types'
import { ensureToolEnv } from './toolEnv'
import { getGithubToken } from './githubToken'

// Detects the coding-agent harnesses on this machine, keeps an "XLM Studio"
// provider in their config in step with the templates, and updates them.

interface SettingsLike {
  harnesses?: HarnessSettings
  mcp?: { enabled?: boolean; skillMode?: boolean; port?: number; token?: string }
  baseUrlOverride?: BaseUrlOverride
  modelDefaults?: { autoFitEnabled?: boolean; autoFitContextLength?: number }
}

export interface HarnessDeps {
  loadSettings: () => Promise<SettingsLike & Record<string, any>>
  saveSettings: (s: any) => Promise<void>
  listTemplates: () => Record<string, any>[]
  // What the model's GGUF header says (cached by the caller): the trained context and the chat template.
  modelInfo: (modelPath: string) => Promise<{ context: number | null; chatTemplate: string | null }>
  templatesDir: string
  // One line for the Logs tab: id and name pick the entry in its source list.
  log: (entry: { id: string; name: string; line: string; app: boolean }) => void
}

const DSH_WEB_PORT = 3080
const PITHAGORAS_URL = 'http://localhost:4100'
// Goose has no package: its installer script fetches a release build.
const GOOSE_INSTALL_SH = 'https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh'
const GOOSE_INSTALL_PS1 = 'https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1'

// ---------------------------------------------------------------------------
// Process and path helpers
// ---------------------------------------------------------------------------

interface ExecResult { code: number; stdout: string; stderr: string }

// Windows runs the .cmd shims npm creates only through a shell; real programs
// (docker, podman) pass shell: false. Every argument is a fixed string, never
// user input.
function exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; shell?: boolean } = {}): Promise<ExecResult> {
  return new Promise(resolve => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 20000,
      windowsHide: true,
      shell: opts.shell ?? process.platform === 'win32',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', CI: '1' }
    }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

// Where a long action writes what it prints: the Logs tab.
type Log = (line: string, app?: boolean) => void

// Like exec, for the actions that take minutes (npm, git clone, a container
// build): every output line goes to the log as it arrives, and the last ones
// come back for an error message.
async function execLogged(log: Log, cmd: string, args: string[], opts: { cwd?: string; shell?: boolean; env?: Record<string, string> } = {}): Promise<ExecResult> {
  const lines: string[] = []
  try {
    const code = await runLogged(cmd, args, { log, killTree: async () => undefined, signal: new AbortController().signal }, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: { CI: '1', ...opts.env },
      onLine: line => { lines.push(line); if (lines.length > 100) lines.shift() }
    })
    return { code: code ?? 1, stdout: lines.join('\n'), stderr: '' }
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message }
  }
}

// The .cmd shims npm, pi and opencode have on Windows start only through a shell.
const WIN_SHELL = process.platform === 'win32'

function lastLines(r: ExecResult, n = 4): string {
  return (r.stderr.trim() || r.stdout.trim()).split(/\r?\n/).filter(Boolean).slice(-n).join(' | ')
}

function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(800, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// Everything that touches the disk here is async: the main process also serves
// the window, and a long run of synchronous checks (a Windows PATH is dozens
// of folders) would freeze it.
async function exists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

async function isFile(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isFile() } catch { return false }
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch { return [] }
}

// Where a harness's command can be: the PATH, plus the folders npm and the
// installers use, which a GUI-launched app often doesn't have on its PATH.
let npmBinDir: string | null | undefined
async function searchDirs(): Promise<string[]> {
  await ensureToolEnv()
  if (npmBinDir === undefined) {
    const r = await exec('npm', ['prefix', '-g'], { timeout: 15000 })
    const prefix = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop() || '' : ''
    npmBinDir = prefix ? (process.platform === 'win32' ? prefix : join(prefix, 'bin')) : null
  }
  const home = homedir()
  const extra = [npmBinDir, join(home, '.local', 'bin'), join(home, '.opencode', 'bin'), join(home, '.bun', 'bin'), join(home, '.npm-global', 'bin')]
  return [...(process.env.PATH || '').split(delimiter), ...extra].filter((d): d is string => !!d)
}

const commandCache = new Map<string, { at: number; value: Promise<string | null> }>()

// The first match in PATH order. All candidates are checked at once and the
// earliest hit wins; results are kept for a short while.
function findCommand(name: string): Promise<string | null> {
  const hit = commandCache.get(name)
  if (hit && Date.now() - hit.at < 30000) return hit.value
  const value = (async () => {
    const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
    const candidates = (await searchDirs()).flatMap(dir => exts.map(ext => join(dir, name + ext)))
    const found = await Promise.all(candidates.map(isFile))
    const i = found.indexOf(true)
    return i >= 0 ? candidates[i] : null
  })()
  commandCache.set(name, { at: Date.now(), value })
  return value
}

async function commandVersion(bin: string): Promise<string | null> {
  const r = await exec(bin, ['--version'], { timeout: 20000 })
  return r.code === 0 ? extractVersion(r.stdout || r.stderr) : null
}

// Every package installed with `npm -g`, with its version. `npm ls` takes
// seconds, so one run is shared by everyone asking at the same time.
let globalCache: { at: number; value: Promise<Record<string, string>> } | null = null
function npmGlobals(): Promise<Record<string, string>> {
  if (globalCache && Date.now() - globalCache.at < 60000) return globalCache.value
  const value = (async () => {
    await ensureToolEnv()
    const r = await exec('npm', ['ls', '-g', '--depth=0', '--json'], { timeout: 30000 })
    const out: Record<string, string> = {}
    try {
      const deps = JSON.parse(r.stdout)?.dependencies ?? {}
      for (const [name, info] of Object.entries<any>(deps)) if (typeof info?.version === 'string') out[name] = info.version
    } catch { /* npm missing or no packages */ }
    return out
  })()
  globalCache = { at: Date.now(), value }
  return value
}

async function fetchJson(url: string): Promise<any> {
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'XLM-Studio' }
  const token = new URL(url).hostname === 'api.github.com' ? getGithubToken() : null
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return res.json()
}

async function npmLatest(pkg: string): Promise<string | null> {
  try {
    const j = await fetchJson(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}/latest`)
    return typeof j?.version === 'string' ? j.version : null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Locating each harness
// ---------------------------------------------------------------------------

// How a config file is edited: each kind has its own writer.
type ConfigKind = 'dsh' | 'pi' | 'opencode' | 'kimi' | 'kimi-mcp' | 'qwen' | 'crush' | 'goose' | 'goose-providers'

// A goose-providers entry is a folder with one file per provider.
interface ConfigFile { path: string; kind: ConfigKind }

interface Located {
  installed: boolean
  binPath: string | null
  // Files the provider is written to.
  files: ConfigFile[]
  // The API it is written through instead (Pithagoras).
  api?: string
  note: string | null
}

function piAgentDir(s: HarnessSettings, key: HarnessId = 'pi'): string {
  return s.configDirs[key] || s.configDirs.pi || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent')
}

function dshHome(s: HarnessSettings): string {
  return s.configDirs.dsh || process.env.DSH_HOME || join(homedir(), '.dsh')
}

// opencode reports its own config folder; remembered after the first ask.
let opencodeDirCache: { bin: string; dir: string } | null = null
async function opencodeConfigDir(s: HarnessSettings, bin: string): Promise<string> {
  if (s.configDirs.opencode) return s.configDirs.opencode
  if (opencodeDirCache?.bin === bin) return opencodeDirCache.dir
  let dir = join(homedir(), '.config', 'opencode')
  const r = await exec(bin, ['debug', 'paths', 'config'], { timeout: 20000 })
  const out = r.code === 0 ? r.stdout.trim().split(/\r?\n/).pop()?.trim() || '' : ''
  if (out) dir = /\.jsonc?$/i.test(out) ? dirname(out) : out
  opencodeDirCache = { bin, dir }
  return dir
}

async function opencodeFile(dir: string): Promise<string> {
  const jsonc = join(dir, 'opencode.jsonc')
  return (await exists(jsonc)) ? jsonc : join(dir, 'opencode.json')
}

async function pithagorasRoot(dir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await fsp.readFile(join(dir, 'package.json'), 'utf-8'))
    return String(pkg?.name || '').toLowerCase() === 'pithagoras' && await exists(join(dir, 'core', 'server', 'package.json'))
  } catch { return false }
}

// The clone its container was built from: the folder from Settings, else the
// one compose recorded on the container, else the usual spots for a clone.
async function findPithagoras(s: HarnessSettings, hint: string | null): Promise<string | null> {
  if (s.pithagorasDir) return (await pithagorasRoot(s.pithagorasDir)) ? s.pithagorasDir : null
  if (hint && await pithagorasRoot(hint)) return hint
  const home = homedir()
  const roots = [home, join(home, 'repos'), join(home, 'src'), join(home, 'code'), join(home, 'projects'), join(home, 'dev'), join(home, 'Documents'), join(home, 'GitHub'), '/srv', '/opt']
  const candidates = roots.flatMap(root => ['Pithagoras', 'pithagoras'].map(name => join(root, name)))
  const found = await Promise.all(candidates.map(pithagorasRoot))
  const i = found.indexOf(true)
  return i >= 0 ? candidates[i] : null
}

function pithagorasUrl(s: HarnessSettings): string {
  return s.pithagorasUrl || PITHAGORAS_URL
}

interface PithRuntime {
  kind: 'docker' | 'podman'
  bin: string
  // The container named like pithagoras, when there is one.
  container: string | null
  running: boolean
  // The folder compose started it from.
  workdir: string | null
}

// Pithagoras is meant to run in a container (docker or podman). Looks for it
// in each runtime; a runtime without the container is still what an update uses.
async function pithRuntime(): Promise<PithRuntime | null> {
  let fallback: PithRuntime | null = null
  for (const kind of ['docker', 'podman'] as const) {
    const bin = await findCommand(kind)
    if (!bin) continue
    fallback ??= { kind, bin, container: null, running: false, workdir: null }
    const ps = await exec(bin, ['ps', '-a', '--format', '{{.Names}},{{.State}}'], { timeout: 15000, shell: false })
    if (ps.code !== 0) continue
    for (const line of ps.stdout.split(/\r?\n/)) {
      const [name, state] = line.trim().split(',')
      if (!name || !/pithagoras/i.test(name)) continue
      const label = await exec(bin, ['inspect', '--format', '{{index .Config.Labels "com.docker.compose.project.working_dir"}}', name], { timeout: 15000, shell: false })
      const dir = label.code === 0 ? label.stdout.trim() : ''
      return { kind, bin, container: name, running: /^running$/i.test(state || ''), workdir: dir && dir !== '<no value>' ? dir : null }
    }
  }
  return fallback
}

async function composeCommand(rt: PithRuntime): Promise<{ cmd: string; args: string[] } | null> {
  const plugin = await exec(rt.bin, ['compose', 'version'], { timeout: 15000, shell: false })
  if (plugin.code === 0) return { cmd: rt.bin, args: ['compose'] }
  const standalone = await findCommand(rt.kind === 'docker' ? 'docker-compose' : 'podman-compose')
  return standalone ? { cmd: standalone, args: [] } : null
}

// --- Pithagoras portal API ---

interface PithReply { status: number; json: any; cookie: string }

async function pithRequest(base: string, method: string, path: string, opts: { cookie?: string; body?: unknown } = {}): Promise<PithReply> {
  const headers: Record<string, string> = { Accept: 'application/json', Origin: base }
  if (opts.cookie) headers.Cookie = opts.cookie
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(10000)
  })
  let json: any = null
  try { json = await res.json() } catch { /* empty or not JSON */ }
  const cookie = res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return { status: res.status, json, cookie }
}

// Whether a Pithagoras portal answers at this address, and whether it wants a login.
async function pithProbe(base: string): Promise<{ present: boolean; needsLogin: boolean }> {
  try {
    const r = await pithRequest(base, 'GET', '/providers')
    if (r.status === 401 && r.json?.error === 'Unauthorized') return { present: true, needsLogin: true }
    return { present: r.status === 200 && !!r.json && typeof r.json === 'object', needsLogin: false }
  } catch { return { present: false, needsLogin: false } }
}

const pithCookies = new Map<string, string>()

// A request that logs in once with the stored password when the portal asks.
async function pithCall(s: HarnessSettings, method: string, path: string, body?: unknown): Promise<PithReply> {
  const base = pithagorasUrl(s)
  const key = `${base}|${s.pithagorasPassword}`
  const r = await pithRequest(base, method, path, { cookie: pithCookies.get(key), body })
  if (r.status !== 401) return r
  if (!s.pithagorasPassword) throw new Error('Pithagoras asks for its password. Enter it above.')
  const login = await pithRequest(base, 'POST', '/auth/login', { body: { password: s.pithagorasPassword } })
  if (login.status !== 200 || !login.cookie) throw new Error(login.status === 401 || login.status === 403 ? 'Pithagoras rejected the password.' : `Pithagoras login answered ${login.status}.`)
  pithCookies.set(key, login.cookie)
  return pithRequest(base, method, path, { cookie: login.cookie, body })
}

// Provider ids the portal lists, wherever its answer keeps them.
function pithProviderIds(json: any): string[] {
  const ids = new Set<string>()
  const take = (v: unknown) => {
    if (Array.isArray(v)) for (const x of v) { const id = typeof x === 'string' ? x : x?.id ?? x?.name; if (typeof id === 'string') ids.add(id) }
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) ids.add(k)
  }
  for (const k of ['providers', 'configured', 'servers', 'configuredProviders']) take(json?.[k])
  return [...ids]
}

// Writes the providers through the portal API and removes XLM Studio ones that
// are no longer wanted. Throws a short message when the portal can't be reached.
async function syncPithagoras(s: HarnessSettings, providers: HarnessProvider[]): Promise<void> {
  let list: PithReply
  try { list = await pithCall(s, 'GET', '/providers') } catch (err) {
    if (err instanceof Error && /password|rejected|login/i.test(err.message)) throw err
    throw new PithDown()
  }
  if (list.status !== 200) throw new Error(`Pithagoras answered ${list.status}.`)
  const wanted = new Set(providers.map(p => p.id))
  for (const p of providers) {
    // Kind "custom" keeps the base URL as written (the llama.cpp preset may append /v1).
    const body = {
      kind: 'custom',
      adding: false,
      baseUrl: p.baseUrl,
      api: 'openai-completions',
      apiKey: p.apiKey || PLACEHOLDER_API_KEY,
      models: p.models.map(m => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.vision ? ['text', 'image'] : ['text'],
        // false makes the portal drop the field again.
        reasoning: m.reasoning
      }))
    }
    const r = await pithCall(s, 'PUT', `/providers/${encodeURIComponent(p.id)}`, body)
    if (r.status !== 200) throw new Error(`Pithagoras refused ${p.id}: ${r.json?.error ?? r.status}`)
  }
  for (const id of pithProviderIds(list.json)) {
    if (wanted.has(id) || !(id === XLM_PROVIDER_PREFIX || id.startsWith(`${XLM_PROVIDER_PREFIX}-`))) continue
    const r = await pithCall(s, 'DELETE', `/providers/${encodeURIComponent(id)}`)
    if (r.status !== 200 && r.status !== 404) throw new Error(`Pithagoras would not remove ${id}: ${r.json?.error ?? r.status}`)
  }
}

class PithDown extends Error {
  constructor() { super('Pithagoras is not running.') }
}

let opencodeMajor: number | null = null
let kimiMajor: number | null = null

// --- Kimi Code, Qwen Code, Crush, Goose: where each keeps its config ---

function kimiDir(s: HarnessSettings): string {
  return s.configDirs.kimi || process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
}

function qwenDir(s: HarnessSettings): string {
  return s.configDirs.qwen || process.env.QWEN_HOME || join(homedir(), '.qwen')
}

function crushDir(s: HarnessSettings): string {
  return s.configDirs.crush || process.env.CRUSH_GLOBAL_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'crush')
}

function gooseDir(s: HarnessSettings): string {
  if (s.configDirs.goose) return s.configDirs.goose
  const root = process.env.GOOSE_PATH_ROOT
  if (root && isAbsolute(root)) return join(root, 'config')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Block', 'goose', 'config')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'goose')
}

async function locate(id: HarnessId, s: HarnessSettings): Promise<Located> {
  if (id === 'dsh') {
    const bin = await findCommand('dsh')
    const profiles = join(dshHome(s), 'profiles')
    // The desktop profile belongs to the Electron app while it runs.
    const names = (await listDirs(profiles)).filter(n => n !== 'desktop')
    return {
      installed: !!bin || names.length > 0,
      binPath: bin,
      files: names.map(n => ({ path: join(profiles, n, 'cordis.patch.yml'), kind: 'dsh' as const })),
      note: !names.length && bin ? 'No profile yet. Start dsh once to create one.' : null
    }
  }
  if (id === 'pi') {
    const bin = await findCommand('pi')
    return { installed: !!bin, binPath: bin, files: bin ? [{ path: join(piAgentDir(s), 'models.json'), kind: 'pi' }] : [], note: null }
  }
  if (id === 'pithagoras') {
    const rt = await pithRuntime()
    const dir = await findPithagoras(s, rt?.workdir ?? null)
    const base = pithagorasUrl(s)
    const probe = await pithProbe(base)
    const installed = !!rt?.container || !!dir || probe.present
    let note: string | null = null
    if (installed && !probe.present) note = 'Pithagoras is not running. The provider is added once it starts.'
    else if (probe.needsLogin && !s.pithagorasPassword) note = 'Enter the Pithagoras password so XLM Studio can add its provider.'
    return { installed, binPath: dir, files: [], api: installed ? base : undefined, note }
  }
  if (id === 'kimi') {
    const bin = await findCommand('kimi')
    if (!bin) return { installed: false, binPath: null, files: [], note: null }
    // Kimi CLI 1 kept its config elsewhere and in another layout.
    if (kimiMajor !== null && kimiMajor < 2) {
      return { installed: true, binPath: bin, files: [], note: 'An old Kimi CLI is installed. Update to Kimi Code 2 to use the XLM Studio provider.' }
    }
    const dir = kimiDir(s)
    return { installed: true, binPath: bin, files: [{ path: join(dir, 'config.toml'), kind: 'kimi' }, { path: join(dir, 'mcp.json'), kind: 'kimi-mcp' }], note: null }
  }
  if (id === 'qwen') {
    const bin = await findCommand('qwen')
    return { installed: !!bin, binPath: bin, files: bin ? [{ path: join(qwenDir(s), 'settings.json'), kind: 'qwen' }] : [], note: null }
  }
  if (id === 'crush') {
    const bin = await findCommand('crush')
    return { installed: !!bin, binPath: bin, files: bin ? [{ path: join(crushDir(s), 'crush.json'), kind: 'crush' }] : [], note: null }
  }
  if (id === 'goose') {
    const bin = await findCommand('goose')
    const dir = gooseDir(s)
    const yaml = join(dir, 'config.yaml')
    const installed = !!bin || await exists(yaml)
    return {
      installed,
      binPath: bin,
      files: installed ? [{ path: join(dir, 'custom_providers'), kind: 'goose-providers' }, { path: yaml, kind: 'goose' }] : [],
      note: null
    }
  }
  const bin = await findCommand('opencode')
  if (!bin) return { installed: false, binPath: null, files: [], note: null }
  if (opencodeMajor !== null && opencodeMajor < 2) {
    return { installed: true, binPath: bin, files: [], note: 'OpenCode 1 is installed. Update to OpenCode 2 to use the XLM Studio provider.' }
  }
  return { installed: true, binPath: bin, files: [{ path: await opencodeFile(await opencodeConfigDir(s, bin)), kind: 'opencode' }], note: null }
}

// ---------------------------------------------------------------------------
// Versions and updates
// ---------------------------------------------------------------------------

interface Detected extends Located {
  version: string | null
  source: string | null
  canUpdate: boolean
  // Pithagoras: a clone and a container runtime to build it with.
  canRebuild: boolean
}

async function detect(id: HarnessId, s: HarnessSettings): Promise<Detected> {
  const def = HARNESSES[id]
  if (id === 'pithagoras') {
    const loc = await locate(id, s)
    let version: string | null = null
    if (loc.binPath) {
      try { version = JSON.parse(await fsp.readFile(join(loc.binPath, 'package.json'), 'utf-8'))?.version ?? null } catch { /* unreadable */ }
    }
    const rt = loc.installed ? await pithRuntime() : null
    const git = !!loc.binPath && await exists(join(loc.binPath, '.git'))
    const canUpdate = git && !!rt
    const source = !loc.installed ? null : rt?.container ? `${rt.kind} container` : loc.binPath ? 'git clone' : 'running portal'
    let note = loc.note
    if (!note && loc.installed && !loc.binPath) note = 'Set the folder of its git clone to update it.'
    else if (!note && loc.installed && loc.binPath && !git) note = 'The folder is not a git clone: update it yourself.'
    else if (!note && git && !rt) note = 'Neither docker nor podman was found, so it cannot be rebuilt from here.'
    // A clone with no container was never built (or its container was removed).
    if (loc.binPath && rt && !rt.container && loc.note?.startsWith('Pithagoras is not running')) note = 'Cloned but not built yet. Press Build.'
    return { ...loc, version, source, canUpdate, canRebuild: !!loc.binPath && !!rt, note }
  }

  if (id === 'opencode') {
    const bin = await findCommand('opencode')
    const version = bin ? await commandVersion(bin) : null
    opencodeMajor = version ? parseInt(version.split('.')[0], 10) : null
    const loc = await locate(id, s)
    return { ...loc, version, source: loc.installed ? 'command' : null, canUpdate: loc.installed, canRebuild: false }
  }

  // Kimi's config layout depends on its version, which is needed before locating it.
  let cmdVersion: string | null | undefined
  if (id === 'kimi') {
    const bin = await findCommand('kimi')
    cmdVersion = bin ? await commandVersion(bin) : null
    kimiMajor = cmdVersion ? parseInt(cmdVersion.split('.')[0], 10) : null
  }
  const loc = await locate(id, s)
  const globals = await npmGlobals()
  const names = [def.npmPackage, ...(def.legacyNpmPackages ?? [])].filter((n): n is string => !!n)
  const npmName = names.find(n => globals[n])
  let version = npmName ? globals[npmName] : null
  if (!version && loc.binPath) version = cmdVersion !== undefined ? cmdVersion : await commandVersion(loc.binPath)
  // pi, Kimi Code and Goose update themselves whatever installed them; the rest go through npm.
  const selfUpdating = id === 'pi' || id === 'kimi' || id === 'goose'
  const canUpdate = selfUpdating ? loc.installed && (id !== 'goose' || !!loc.binPath) : !!npmName
  const source = npmName ? 'npm global' : loc.binPath ? 'command' : null
  let note = loc.note
  if (!note && !selfUpdating && loc.binPath && !npmName) note = 'Not installed with npm: update it yourself.'
  else if (!note && id === 'goose' && loc.installed && !loc.binPath) note = 'Only its app was found: update it yourself.'
  return { ...loc, version, source, canUpdate, canRebuild: false, note }
}

interface Latest { version: string | null; available: boolean }
const latestCache = new Map<HarnessId, Latest>()
let checkedAt: number | null = null

// The newest stable release of a GitHub project. The API is rate limited
// without a token, so the "latest release" redirect is the fallback.
async function githubLatest(repo: string): Promise<string | null> {
  try {
    const releases = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=20`)
    const versions = (Array.isArray(releases) ? releases : [])
      .filter((r: any) => !r.prerelease && !r.draft && typeof r.tag_name === 'string' && !r.tag_name.includes('-'))
      .map((r: any) => extractVersion(r.tag_name))
      .filter((v: string | null): v is string => !!v)
    const best = versions.sort((a: string, b: string) => compareVersions(b, a))[0]
    if (best) return best
  } catch { /* fall through */ }
  try {
    const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', headers: { 'User-Agent': 'XLM-Studio' }, signal: AbortSignal.timeout(15000) })
    const tag = (res.headers.get('location') || '').split('/tag/')[1] || ''
    return tag.includes('-') ? null : extractVersion(tag)
  } catch { return null }
}

async function pithagorasLatest(dir: string): Promise<Latest> {
  const fetched = await exec('git', ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: dir, timeout: 60000 })
  if (fetched.code !== 0) return { version: null, available: false }
  const behind = await exec('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: dir })
  const n = behind.code === 0 ? parseInt(behind.stdout.trim(), 10) || 0 : 0
  const remote = await exec('git', ['show', 'origin/main:package.json'], { cwd: dir })
  let version: string | null = null
  try { version = JSON.parse(remote.stdout)?.version ?? null } catch { /* no package.json upstream */ }
  return { version: version && n > 0 ? `${version} (${n} new commit${n === 1 ? '' : 's'})` : version, available: n > 0 }
}

async function fetchLatest(id: HarnessId, d: Detected): Promise<Latest> {
  if (!d.installed) return { version: null, available: false }
  if (id === 'pithagoras') return d.binPath && d.canUpdate ? pithagorasLatest(d.binPath) : { version: null, available: false }
  const def = HARNESSES[id]
  const version = id === 'opencode' ? await githubLatest('anomalyco/opencode') : def.githubRepo ? await githubLatest(def.githubRepo) : await npmLatest(def.npmPackage!)
  return { version, available: !!(version && d.version && compareVersions(version, d.version) > 0) }
}

// What a Pithagoras build reports back besides success.
interface PithBuildOut {
  // A portal password made for a fresh .env; Settings keeps it for the API.
  password: string | null
}

// Its compose file refuses to start without a .env that names the folder of
// repositories, so every build makes sure one exists. A fresh .env is copied
// from .env.example with a portal password and secret filled in; an existing
// one is only touched for the workspaces folder.
export async function preparePithagorasEnv(dir: string, s: HarnessSettings, out: PithBuildOut): Promise<void> {
  const envPath = join(dir, '.env')
  const fresh = !(await exists(envPath))
  const original = fresh
    ? ((await exists(join(dir, '.env.example'))) ? await fsp.readFile(join(dir, '.env.example'), 'utf-8') : '')
    : await fsp.readFile(envPath, 'utf-8')
  let text = original
  const chosen = s.pithagorasWorkspacesDir.replace(/\\/g, '/')
  if (chosen) {
    text = setEnvKey(text, 'WORKSPACES_DIR', chosen)
    await fsp.mkdir(s.pithagorasWorkspacesDir, { recursive: true }).catch(() => undefined)
  } else if (!envHasValue(text, 'WORKSPACES_DIR')) {
    // Nothing chosen: an empty folder of its own, so the container can start.
    const own = join(dir, 'workspaces')
    await fsp.mkdir(own, { recursive: true })
    text = setEnvKey(text, 'WORKSPACES_DIR', own.replace(/\\/g, '/'))
  }
  if (fresh) {
    const password = s.pithagorasPassword || randomBytes(12).toString('base64url')
    text = setEnvKey(text, 'PORTAL_PASSWORD', password)
    if (!envHasValue(text, 'PORTAL_SECRET')) text = setEnvKey(text, 'PORTAL_SECRET', randomBytes(32).toString('hex'))
    out.password = s.pithagorasPassword ? null : password
  }
  if (text !== original || fresh) await fsp.writeFile(envPath, text, 'utf-8')
}

// Builds the image and (re)starts the container from the clone.
async function pithagorasUp(dir: string, s: HarnessSettings, out: PithBuildOut, log: Log): Promise<string | null> {
  const rt = await pithRuntime()
  if (!rt) return 'Neither docker nor podman was found.'
  const compose = await composeCommand(rt)
  if (!compose) return `${rt.kind} has no compose command.`
  log(`Writing ${join(dir, '.env')}`, true)
  try { await preparePithagorasEnv(dir, s, out) } catch (err) { return `Could not write .env: ${(err as Error).message}` }
  const up = await execLogged(log, compose.cmd, [...compose.args, 'up', '-d', '--build'], { cwd: dir })
  return up.code === 0 ? null : `${rt.kind} compose failed: ${lastLines(up)}`
}

// Returns an error message, or null once the harness is updated.
async function runUpdate(id: HarnessId, d: Detected, s: HarnessSettings, out: PithBuildOut, log: Log): Promise<string | null> {
  if (!d.canUpdate) return 'It cannot be updated from here.'
  if (id === 'dsh') {
    if (await isListening(DSH_WEB_PORT)) return 'dsh web is running. Stop it first.'
    const r = await execLogged(log, 'npm', ['install', '-g', '@deepseek-ai/dsh@latest'], { shell: WIN_SHELL })
    return r.code === 0 ? null : `npm failed: ${lastLines(r)}`
  }
  if (id === 'pi') {
    const r = await execLogged(log, d.binPath!, ['update', '--self'], { shell: WIN_SHELL })
    return r.code === 0 ? null : `pi update failed: ${lastLines(r)}`
  }
  if (id === 'kimi') {
    const r = await execLogged(log, d.binPath!, ['upgrade', '-y'], { shell: WIN_SHELL })
    return r.code === 0 ? null : `kimi upgrade failed: ${lastLines(r)}`
  }
  if (id === 'goose') {
    const r = await execLogged(log, d.binPath!, ['update'], { shell: WIN_SHELL })
    return r.code === 0 ? null : `goose update failed: ${lastLines(r)}`
  }
  if (id === 'qwen' || id === 'crush') {
    const r = await execLogged(log, 'npm', ['install', '-g', `${HARNESSES[id].npmPackage}@latest`], { shell: WIN_SHELL })
    return r.code === 0 ? null : `npm failed: ${lastLines(r)}`
  }
  if (id === 'opencode') {
    // OpenCode 1 only leaves through --major, which removes it.
    const args = opencodeMajor !== null && opencodeMajor < 2 ? ['upgrade', '--major'] : ['upgrade']
    const r = await execLogged(log, d.binPath!, args, { shell: WIN_SHELL })
    return r.code === 0 ? null : `opencode upgrade failed: ${lastLines(r)}`
  }
  // Pithagoras: pull the clone, then rebuild and restart its container.
  const dir = d.binPath!
  const status = await exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: dir })
  if (status.code !== 0 || status.stdout.trim()) return 'The clone has local changes, so it was left alone.'
  const fetched = await execLogged(log, 'git', ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: dir })
  if (fetched.code !== 0) return `git fetch failed: ${lastLines(fetched)}`
  const merged = await execLogged(log, 'git', ['merge', '--ff-only', 'refs/remotes/origin/main'], { cwd: dir })
  if (merged.code !== 0) return `git merge failed: ${lastLines(merged)}`
  return pithagorasUp(dir, s, out, log)
}

// Goose's own installer script; CONFIGURE=false skips its interactive setup.
async function installGoose(log: Log): Promise<string | null> {
  const env = { CONFIGURE: 'false' }
  if (process.platform === 'win32') {
    const script = `$f = Join-Path $env:TEMP 'goose_download_cli.ps1'; Invoke-WebRequest -Uri '${GOOSE_INSTALL_PS1}' -OutFile $f; & $f`
    const r = await execLogged(log, 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { env })
    return r.code === 0 ? null : `The Goose installer failed: ${lastLines(r)}`
  }
  if (!(await findCommand('curl')) || !(await findCommand('bash'))) return 'curl and bash are needed to install Goose.'
  const r = await execLogged(log, 'bash', ['-c', `set -o pipefail; curl -fsSL '${GOOSE_INSTALL_SH}' | bash`], { env })
  return r.code === 0 ? null : `The Goose installer failed: ${lastLines(r)}`
}

// Returns an error message, or null once the harness is installed.
async function runInstall(id: HarnessId, s: HarnessSettings, out: PithBuildOut, log: Log): Promise<string | null> {
  if (id === 'goose') return installGoose(log)
  if (id !== 'pithagoras') {
    const pkg = id === 'dsh' ? '@deepseek-ai/dsh@latest' : id === 'opencode' ? 'opencode-ai@latest' : `${HARNESSES[id].npmPackage}@latest`
    if (!(await findCommand('npm'))) return 'npm was not found. Install Node.js first.'
    const r = await execLogged(log, 'npm', ['install', '-g', pkg], { shell: WIN_SHELL })
    return r.code === 0 ? null : `npm failed: ${lastLines(r)}`
  }
  if (!(await pithRuntime())) return 'Neither docker nor podman was found.'
  if (!(await findCommand('git'))) return 'git was not found.'
  const dir = s.pithagorasDir || join(homedir(), 'Pithagoras')
  if (!(await pithagorasRoot(dir))) {
    if ((await exists(dir)) && (await fsp.readdir(dir)).length) return `${dir} is not empty and is not a Pithagoras clone.`
    const cloned = await execLogged(log, 'git', ['clone', '--progress', HARNESSES.pithagoras.url, dir])
    if (cloned.code !== 0) return `git clone failed: ${lastLines(cloned)}`
  }
  return pithagorasUp(dir, s, out, log)
}

// Returns an error message, or null once it is gone. Config folders, the
// Pithagoras clone and its data volume are left alone.
async function runRemove(id: HarnessId, d: Detected, log: Log): Promise<string | null> {
  if (id === 'pithagoras') {
    const rt = await pithRuntime()
    if (!rt?.container && !d.binPath) return 'Nothing to stop: no container was found.'
    if (rt?.container && d.binPath && await exists(join(d.binPath, 'docker-compose.yml'))) {
      const compose = await composeCommand(rt)
      if (compose) {
        const down = await execLogged(log, compose.cmd, [...compose.args, 'down'], { cwd: d.binPath })
        return down.code === 0 ? null : `${rt.kind} compose failed: ${lastLines(down)}`
      }
    }
    if (rt?.container) {
      const rm = await execLogged(log, rt.bin, ['rm', '-f', rt.container])
      return rm.code === 0 ? null : `${rt.kind} rm failed: ${lastLines(rm)}`
    }
    return null
  }
  if (id === 'goose') return 'Goose has no uninstall command here. Delete its goose command or app yourself.'
  const def = HARNESSES[id]
  const globals = await npmGlobals()
  const names = [def.npmPackage, ...(def.legacyNpmPackages ?? [])].filter((n): n is string => !!n && !!globals[n])
  if (!names.length) return 'It was not installed with npm. Remove it with the tool that installed it.'
  if (id === 'dsh' && await isListening(DSH_WEB_PORT)) return 'dsh web is running. Stop it first.'
  const r = await execLogged(log, 'npm', ['uninstall', '-g', ...names], { shell: WIN_SHELL })
  return r.code === 0 ? null : `npm failed: ${lastLines(r)}`
}

// ---------------------------------------------------------------------------
// Writing the provider
// ---------------------------------------------------------------------------

const WRITERS: Record<Exclude<ConfigKind, 'goose-providers'>, (text: string | null, providers: HarnessProvider[], mcp: HarnessMcp | null) => SyncResult> = {
  dsh: syncDshPatch,
  pi: (text, providers) => syncPiModels(text, providers),
  opencode: syncOpencodeConfig,
  kimi: (text, providers) => syncKimiConfig(text, providers),
  'kimi-mcp': (text, _providers, mcp) => syncKimiMcp(text, mcp),
  qwen: syncQwenSettings,
  crush: syncCrushConfig,
  goose: (text, _providers, mcp) => syncGooseConfig(text, mcp)
}

// A config kept in a dotfiles repo is often a symlink: write to its target so
// the link survives. The first change to a file keeps the original beside it.
async function writeConfig(file: string, text: string, hadFile: boolean): Promise<void> {
  let target = file
  try { target = await fsp.realpath(file) } catch { /* new file */ }
  await fsp.mkdir(dirname(target), { recursive: true })
  if (hadFile) {
    const bak = `${target}.xlm-studio.bak`
    if (!(await exists(bak))) await fsp.copyFile(target, bak)
  }
  const tmp = `${target}.xlm-studio.tmp`
  await fsp.writeFile(tmp, text, 'utf-8')
  try {
    await fsp.rename(tmp, target)
  } catch (err) {
    // Windows refuses to replace a file another program holds open; writing in
    // place still works there.
    await fsp.rm(tmp, { force: true })
    if (!['EPERM', 'EBUSY', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err
    await fsp.writeFile(target, text, 'utf-8')
  }
}

// Goose keeps one JSON file per custom provider. Files of ours that are no
// longer wanted are deleted; every other file in the folder is left alone.
async function syncGooseProviders(dir: string, providers: HarnessProvider[]): Promise<boolean> {
  const files: Record<string, string> = {}
  let names: string[] = []
  try { names = await fsp.readdir(dir) } catch { /* no folder yet */ }
  for (const name of names) {
    if (!/^xlm-studio(-.+)?\.json$/.test(name)) continue
    try { files[name] = await fsp.readFile(join(dir, name), 'utf-8') } catch { /* vanished */ }
  }
  const plan = planGooseProviders(files, providers)
  for (const f of plan.write) await writeConfig(join(dir, f.name), f.text, false)
  for (const name of plan.remove) await fsp.rm(join(dir, name), { force: true })
  return plan.write.length > 0 || plan.remove.length > 0
}

async function syncFile(file: ConfigFile, providers: HarnessProvider[], mcp: HarnessMcp | null, createMissing: boolean): Promise<boolean> {
  if (file.kind === 'goose-providers') return syncGooseProviders(file.path, providers)
  let text: string | null = null
  try { text = await fsp.readFile(file.path, 'utf-8') } catch { text = null }
  // Switching off must not create a file just to hold nothing.
  if (text === null && !createMissing) return false
  const result = WRITERS[file.kind](text, providers, mcp)
  if (!result.changed) return false
  await writeConfig(file.path, result.text, text !== null)
  return true
}

// XLM Studio's MCP server, for the harnesses that run a live MCP client. Skill
// mode, or the server turned off, means none: the entry is taken out again.
function mcpFor(all: SettingsLike, id: HarnessId): HarnessMcp | null {
  const m = all.mcp
  if (!hasMcpClient(id)) return null
  if (!m?.enabled || m.skillMode || !m.port || !m.token) return null
  return { url: `http://127.0.0.1:${m.port}/mcp`, token: m.token }
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

let broadcastTimer: ReturnType<typeof setTimeout> | null = null
// Coalesced: a change often fires several of these at once, and each one makes
// the Settings page ask for the whole state again.
function broadcast(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('harnesses-changed')
  }, 120)
}

// What detect found, kept for a short while: it runs commands and queries
// docker, which is far too slow to repeat for every switch and refresh.
const detectCache = new Map<HarnessId, { at: number; key: string; value: Promise<Detected> }>()
function detectCached(id: HarnessId, s: HarnessSettings): Promise<Detected> {
  const key = JSON.stringify([s.configDirs, s.pithagorasDir, s.pithagorasUrl])
  const hit = detectCache.get(id)
  if (hit && hit.key === key && Date.now() - hit.at < 30000) return hit.value
  const value = detect(id, s)
  detectCache.set(id, { at: Date.now(), key, value })
  value.catch(() => { if (detectCache.get(id)?.value === value) detectCache.delete(id) })
  return value
}
function forgetDetected(): void {
  detectCache.clear()
  commandCache.clear()
  globalCache = null
  opencodeDirCache = null
}

export function initHarnessManager(deps: HarnessDeps) {
  const syncInfo = new Map<HarnessId, HarnessSyncInfo>()
  const busy = new Map<HarnessId, NonNullable<HarnessStatus['busy']>>()
  // Harnesses with something in the Logs tab.
  const hasLog = new Set<HarnessId>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<unknown> = Promise.resolve()
  // What was last written to each harness; an unchanged harness is not touched again.
  const written = new Map<HarnessId, string>()
  // A harness was not reachable at the last pass; the timer tries again.
  let pending = false

  async function settings(): Promise<{ all: SettingsLike & Record<string, any>; h: HarnessSettings }> {
    const all = await deps.loadSettings()
    return { all, h: all.harnesses ?? migrateHarnessSettings(null) }
  }

  async function providersNow(all: SettingsLike): Promise<{ providers: HarnessProvider[]; skipped: SkippedTemplate[] }> {
    const templates = deps.listTemplates() as unknown as Template[]
    // The builder is synchronous, so the trained contexts are looked up first.
    const autoFit = { enabled: !!all.modelDefaults?.autoFitEnabled, contextLength: Number(all.modelDefaults?.autoFitContextLength) || 0 }
    // Only a template whose size or thinking the launch flags don't settle needs its model's header read.
    const wanted = new Set<string>()
    const note = (p: string) => { wanted.add(p); return null }
    for (const t of templates) { templateContext(t, autoFit, note); templateReasoning(t, note) }
    const native = new Map<string, number>()
    const chat = new Map<string, string>()
    await Promise.all([...wanted].map(async p => {
      try {
        const info = await deps.modelInfo(p)
        if (info.context) native.set(p, info.context)
        if (info.chatTemplate) chat.set(p, info.chatTemplate)
      } catch { /* unreadable model */ }
    }))
    return buildHarnessProviders(templates, {
      override: all.baseUrlOverride,
      autoFit,
      nativeContext: p => native.get(p) ?? null,
      chatTemplate: p => chat.get(p) ?? null
    })
  }

  function syncOn(h: HarnessSettings, id: HarnessId): boolean {
    return h.syncOn.includes(id)
  }

  // One pass over every located harness. `force` ignores the check that
  // nothing relevant changed since the last pass.
  async function applySync(force: boolean): Promise<void> {
    const { all, h } = await settings()
    if (!h.syncOn.length) return
    const { providers } = await providersNow(all)
    const jobs: Array<{ id: HarnessId; files: ConfigFile[]; api?: string }> = []
    for (const id of HARNESS_ORDER) {
      if (!syncOn(h, id)) continue
      const loc = await detectCached(id, h)
      if (loc.installed && (loc.files.length || loc.api)) jobs.push({ id, files: loc.files, api: loc.api })
    }
    pending = false
    for (const { id, files, api } of jobs) {
      const mcp = mcpFor(all, id)
      const signature = JSON.stringify({ providers, mcp, files, api, pith: api ? [h.pithagorasUrl, h.pithagorasPassword] : null })
      if (!force && written.get(id) === signature) continue
      written.set(id, signature)
      let changed = false
      let error: string | null = null
      if (api) {
        try { await syncPithagoras(h, providers); changed = true } catch (err) {
          // A portal that is not up yet is retried by the timer, not shown as a failure.
          if (err instanceof PithDown) pending = true
          else error = (err as Error).message
          written.delete(id)
        }
      }
      for (const file of files) {
        try { changed = (await syncFile(file, providers, mcp, true)) || changed } catch (err) {
          error = `${file.path}: ${(err as Error).message}`
          written.delete(id)
        }
      }
      syncInfo.set(id, { at: Date.now(), changed, error })
    }
    broadcast()
  }

  // Removes the provider from one harness's config, without creating files.
  // A failure is shown on its card instead of leaving the provider behind unseen.
  async function removeFrom(id: HarnessId, h: HarnessSettings): Promise<void> {
    const loc = await detectCached(id, h)
    let error: string | null = null
    for (const file of loc.files) {
      try { await syncFile(file, [], null, false) } catch (err) { error = `${file.path}: ${(err as Error).message}` }
    }
    if (loc.api) {
      try { await syncPithagoras(h, []) } catch (err) { if (!(err instanceof PithDown)) error = (err as Error).message }
    }
    written.delete(id)
    if (error) syncInfo.set(id, { at: Date.now(), changed: false, error })
    else syncInfo.delete(id)
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  function scheduleSync(delayMs = 1500): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void run(() => applySync(false)).catch(() => undefined) }, delayMs)
  }

  async function status(id: HarnessId, h: HarnessSettings, all: SettingsLike): Promise<HarnessStatus> {
    const d = await detectCached(id, h)
    const latest = latestCache.get(id)
    return {
      id,
      installed: d.installed,
      version: d.version,
      latest: latest?.version ?? null,
      updateAvailable: !!latest?.available && d.installed,
      source: d.source,
      binPath: d.binPath,
      configFiles: d.files.map(f => f.path),
      api: d.api ?? null,
      syncOn: syncOn(h, id),
      sync: syncInfo.get(id) ?? null,
      canUpdate: d.canUpdate,
      canRebuild: d.canRebuild,
      hasLog: hasLog.has(id),
      mcp: hasMcpClient(id) ? syncOn(h, id) && !!mcpFor(all, id) : null,
      busy: busy.get(id) ?? null,
      note: d.note
    }
  }

  async function getState(): Promise<HarnessState> {
    const { all, h } = await settings()
    const { providers, skipped } = await providersNow(all)
    const statuses = await Promise.all(HARNESS_ORDER.map(id => status(id, h, all)))
    return {
      settings: h,
      statuses,
      providers: providers.map(p => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, models: p.models.length })),
      skipped,
      checkedAt
    }
  }

  async function checkUpdates(): Promise<void> {
    const { h } = await settings()
    await Promise.all(HARNESS_ORDER.map(async id => {
      const d = await detectCached(id, h)
      latestCache.set(id, await fetchLatest(id, d))
    }))
    checkedAt = Date.now()
    broadcast()
  }

  // Runs an install, update or removal with the card shown as busy, then
  // refreshes what is known about the harness.
  async function change(id: HarnessId, kind: NonNullable<HarnessStatus['busy']>): Promise<{ success: boolean; error?: string }> {
    if (busy.has(id)) return { success: false, error: 'Already working on it.' }
    const { h } = await settings()
    const d = await detectCached(id, h)
    if (kind === 'install' && d.installed) return { success: false, error: 'Already installed.' }
    if (kind !== 'install' && !d.installed) return { success: false, error: 'Not installed.' }
    if (kind === 'rebuild' && id !== 'pithagoras') return { success: false, error: 'Nothing to build.' }
    busy.set(id, kind)
    broadcast()
    try {
      if (kind === 'remove') await removeFrom(id, h)
      const out: PithBuildOut = { password: null }
      const logId = buildLogId(id, 'harness')
      const log: Log = (line, app) => deps.log({ id: logId, name: `Harness: ${HARNESSES[id].label}`, line, app: !!app })
      hasLog.add(id)
      log(`${{ install: 'Install', update: 'Update', rebuild: 'Build', remove: 'Removal' }[kind]} started: ${HARNESSES[id].label}`, true)
      const error = kind === 'install' ? await runInstall(id, h, out, log)
        : kind === 'update' ? await runUpdate(id, d, h, out, log)
        : kind === 'rebuild' ? (d.binPath ? await pithagorasUp(d.binPath, h, out, log) : 'Set the folder of its git clone first.')
        : await runRemove(id, d, log)
      log(error ? `Failed: ${error}` : 'Finished.', true)
      forgetDetected()
      // The portal password made for a fresh .env is kept even when the build
      // failed, since a retry reuses that .env.
      if (out.password) {
        const { all, h: current } = await settings()
        await deps.saveSettings({ ...all, harnesses: { ...current, pithagorasPassword: out.password } })
      }
      if (error) return { success: false, error }
      if (kind === 'install' && id === 'pithagoras' && !h.pithagorasDir) {
        const { all } = await settings()
        const dir = join(homedir(), 'Pithagoras')
        if (await pithagorasRoot(dir)) await deps.saveSettings({ ...all, harnesses: { ...h, pithagorasDir: dir } })
      }
      latestCache.delete(id)
      latestCache.set(id, await fetchLatest(id, await detectCached(id, (await settings()).h)))
      // A fresh or restarted harness has no provider yet; write it again.
      written.clear()
      scheduleSync(kind === 'remove' ? 0 : 3000)
      return { success: true }
    } finally {
      busy.delete(id)
      broadcast()
    }
  }

  const updateOne = (id: HarnessId) => change(id, 'update')

  async function updateAll(): Promise<void> {
    const { h } = await settings()
    for (const id of HARNESS_ORDER) {
      if (!latestCache.get(id)?.available) continue
      const d = await detectCached(id, h)
      if (d.installed && d.canUpdate) await updateOne(id)
    }
    // A new version may keep its config elsewhere.
    scheduleSync(0)
  }

  // After the app starts: sync once, check upstream, and update when asked to.
  async function startup(): Promise<void> {
    await run(() => applySync(true))
    await checkUpdates()
    const { h } = await settings()
    if (h.autoUpdate) await updateAll()
  }

  try {
    watch(deps.templatesDir, { persistent: false }, () => scheduleSync())
  } catch { /* no templates folder yet */ }
  setInterval(() => { if (pending) { forgetDetected(); void run(() => applySync(true)).catch(() => undefined) } }, 60000).unref()

  ipcMain.handle('harness-get-state', () => getState())
  ipcMain.handle('harness-set-settings', async (_e, patch: Partial<HarnessSettings>) => {
    const { all, h } = await settings()
    const next = migrateHarnessSettings({ ...h, ...patch })
    await deps.saveSettings({ ...all, harnesses: next })
    broadcast()
    // The files are written behind the switch, not before it answers.
    void run(async () => {
      for (const id of h.syncOn.filter(x => !next.syncOn.includes(x))) await removeFrom(id, next)
      // Another folder, address or password can change what a harness is and where it lives.
      if (JSON.stringify([h.configDirs, h.pithagorasDir, h.pithagorasUrl, h.pithagorasPassword]) !== JSON.stringify([next.configDirs, next.pithagorasDir, next.pithagorasUrl, next.pithagorasPassword])) {
        forgetDetected()
        written.clear()
      }
      await applySync(false)
    }).catch(() => undefined).then(() => broadcast())
    return { success: true }
  })
  ipcMain.handle('harness-sync-now', async () => { forgetDetected(); await run(() => applySync(true)); return getState() })
  ipcMain.handle('harness-check-updates', async () => { forgetDetected(); await checkUpdates(); return getState() })
  ipcMain.handle('harness-install', async (_e, id: string) => (isHarnessId(id) ? change(id, 'install') : { success: false, error: 'Unknown harness.' }))
  ipcMain.handle('harness-rebuild', async (_e, id: string) => (isHarnessId(id) ? change(id, 'rebuild') : { success: false, error: 'Unknown harness.' }))
  ipcMain.handle('harness-remove', async (_e, id: string) => (isHarnessId(id) ? change(id, 'remove') : { success: false, error: 'Unknown harness.' }))
  ipcMain.handle('harness-update', async (_e, id: string) => (isHarnessId(id) ? updateOne(id) : { success: false, error: 'Unknown harness.' }))
  ipcMain.handle('harness-update-all', async () => { await updateAll(); return getState() })
  ipcMain.handle('harness-open-config', async (_e, id: string) => {
    if (!isHarnessId(id)) return
    const { h } = await settings()
    const loc = await detectCached(id, h)
    const present = await Promise.all(loc.files.map(f => exists(f.path)))
    const i = present.indexOf(true)
    const file = (i >= 0 ? loc.files[i] : loc.files[0])?.path
    if (file) await shell.openPath(i >= 0 ? dirname(file) : dirname(dirname(file)))
    else if (loc.binPath && await exists(loc.binPath)) await shell.openPath(loc.binPath)
  })

  return { scheduleSync, startup }
}

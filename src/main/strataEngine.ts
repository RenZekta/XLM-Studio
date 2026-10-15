import { execFile, type SpawnOptions } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import https from 'https'
import type { EngineId, InstallKind } from '../shared/engines'
import type { StrataDataSettings } from '../shared/types'
import { cleanPathArg } from '../shared/strata'

export { cleanPathArg }

// Strata is installed as a git clone and driven through its own launcher
// scripts (START-HERE.bat / setup.sh), which find or install Python, create
// the venv and run setup.py. Everything here is plain Node so it can be
// exercised without Electron.

export const STRATA_DATA_DIRNAME = 'Strata-data'

export function strataLauncherName(): string {
  return process.platform === 'win32' ? 'START-HERE.bat' : 'setup.sh'
}

// The same structural markers local discovery and the add-by-link probe use.
export const GIT_ENGINE_MARKERS = ['setup.py', 'serve/server.py']

export function looksLikeStrataClone(dir: string): boolean {
  return GIT_ENGINE_MARKERS.every(m => existsSync(join(dir, ...m.split('/'))))
}

// --------------------------------------------------------------------------
// git
// --------------------------------------------------------------------------

interface GitResult { ok: boolean; stdout: string; stderr: string }

function git(args: string[], cwd?: string, opts: { timeoutMs?: number; httpsOnly?: boolean } = {}): Promise<GitResult> {
  return new Promise(resolve => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    if (opts.httpsOnly) env.GIT_ALLOW_PROTOCOL = 'https'
    execFile('git', args, { cwd, env, timeout: opts.timeoutMs ?? 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() || (err ? String(err.message) : '') }))
  })
}

export async function gitAvailable(): Promise<boolean> {
  return (await git(['--version'], undefined, { timeoutMs: 8000 })).ok
}

// The commit HEAD points at, read from .git directly so listing installs
// does not spawn git.
function readHeadCommit(dir: string): string | null {
  try {
    const head = readFileSync(join(dir, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref: ')) return head || null
    const ref = head.slice(5)
    const loose = join(dir, '.git', ...ref.split('/'))
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim() || null
    const packed = readFileSync(join(dir, '.git', 'packed-refs'), 'utf8')
    const line = packed.split('\n').find(l => l.endsWith(' ' + ref))
    return line ? line.split(' ')[0] : null
  } catch {
    return null
  }
}

const describeCache = new Map<string, string>()

// "v0.1.41", "v0.1.41-12-gabc1234" or a short hash when the clone has no tags.
export async function gitVersionLabel(dir: string): Promise<string> {
  const commit = readHeadCommit(dir)
  const key = commit ? `${dir}|${commit}` : null
  if (key && describeCache.has(key)) return describeCache.get(key)!
  const r = await git(['describe', '--tags', '--always'], dir, { timeoutMs: 15000 })
  const label = r.ok && r.stdout ? r.stdout : (commit ? commit.slice(0, 7) : 'unknown')
  if (key) describeCache.set(key, label)
  return label
}

function versionParts(tag: string): number[] | null {
  const m = tag.match(/^v?(\d+(?:\.\d+)*)/)
  return m ? m[1].split('.').map(n => parseInt(n, 10)) : null
}

export function compareTags(a: string, b: string): number {
  const pa = versionParts(a), pb = versionParts(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// The release tag a describe label is based on ("v0.1.41-12-gabc" -> "v0.1.41").
export function baseTagOf(label: string): string | null {
  const m = label.match(/^(.*?)(?:-\d+-g[0-9a-f]+)?$/)
  const tag = m ? m[1] : label
  return versionParts(tag) ? tag : null
}

export async function latestRemoteTag(remote: string): Promise<string | null> {
  const r = await git(['ls-remote', '--tags', '--refs', remote], undefined, { timeoutMs: 30000 })
  if (!r.ok) throw new Error(r.stderr || 'git ls-remote failed')
  let best: string | null = null
  for (const line of r.stdout.split('\n')) {
    const tag = line.split('refs/tags/')[1]?.trim()
    if (tag && versionParts(tag) && (best === null || compareTags(tag, best) > 0)) best = tag
  }
  return best
}

export interface GitUpdateResult {
  updated: boolean
  skipped?: string
  error?: string
  before: string | null
  after: string | null
}

// Fast-forward to the upstream when possible, otherwise reset to it. Only a
// clone sitting on a branch that tracks an upstream is touched, so a checkout
// of some other branch or a detached HEAD is left exactly as it is.
export async function updateGitEngine(dir: string): Promise<GitUpdateResult> {
  const before = readHeadCommit(dir)
  const branch = await git(['symbolic-ref', '--short', '-q', 'HEAD'], dir, { timeoutMs: 10000 })
  if (!branch.ok || !branch.stdout) return { updated: false, skipped: 'detached HEAD', before, after: before }
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], dir, { timeoutMs: 10000 })
  if (!upstream.ok || !upstream.stdout) return { updated: false, skipped: `branch ${branch.stdout} has no upstream`, before, after: before }
  const fetched = await git(['fetch', '--tags', '--prune'], dir)
  if (!fetched.ok) return { updated: false, error: fetched.stderr, before, after: before }
  const merged = await git(['merge', '--ff-only', '@{u}'], dir)
  if (!merged.ok) {
    const reset = await git(['reset', '--hard', '@{u}'], dir)
    if (!reset.ok) return { updated: false, error: reset.stderr, before, after: before }
  }
  const after = readHeadCommit(dir)
  return { updated: before !== after, before, after }
}

// Only GitHub https remotes are accepted. The URL goes after "--" and the
// transport is restricted to https, so a crafted value cannot smuggle in a
// git option or an ext:: transport.
export function githubCloneUrl(slug: string): string | null {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug) ? `https://github.com/${slug}.git` : null
}

export async function cloneGitEngine(slug: string, destDir: string, branch?: string): Promise<{ ok: boolean; error?: string }> {
  const url = githubCloneUrl(slug)
  if (!url) return { ok: false, error: `Not a GitHub repository: ${slug}` }
  if (existsSync(destDir)) return { ok: false, error: `${destDir} already exists` }
  const args = ['clone']
  if (branch) args.push('--branch', branch)
  args.push('--', url, destDir)
  const r = await git(args, undefined, { timeoutMs: 10 * 60 * 1000, httpsOnly: true })
  return r.ok ? { ok: true } : { ok: false, error: r.stderr }
}

// --------------------------------------------------------------------------
// Probing a repository for its engine
// --------------------------------------------------------------------------

function urlExists(url: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = https.request(url, { method: 'HEAD', timeout: 10000, headers: { 'User-Agent': 'xlm-studio' } }, res => {
      res.resume()
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

// Clone-installed engines are recognised by their files, not their names, so
// forks that rename the project are still found. Anything else is left to the
// release-asset detection the caller already has.
export async function probeGitEngine(slug: string, branch = 'HEAD'): Promise<{ engine: EngineId; kind: InstallKind } | null> {
  if (!githubCloneUrl(slug)) return null
  const checks = await Promise.all(GIT_ENGINE_MARKERS.map(m => urlExists(`https://raw.githubusercontent.com/${slug}/${branch}/${m}`)))
  return checks.every(Boolean) ? { engine: 'strata', kind: 'git' } : null
}

// --------------------------------------------------------------------------
// Data folder
// --------------------------------------------------------------------------

export const DEFAULT_STRATA_DATA: StrataDataSettings = { mode: 'global', dataDir: null, isolatedDir: null }

// Strata keeps a user-global settings.json that remembers its data folder
// and the installs it has seen; isolated mode points the config directory at
// a private folder so none of that is shared.
function strataSettingsFile(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Strata', 'settings.json')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'strata', 'settings.json')
}

export function readRememberedDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const raw = JSON.parse(readFileSync(strataSettingsFile(env), 'utf8'))
    return typeof raw.data_dir === 'string' && raw.data_dir ? raw.data_dir : null
  } catch {
    return null
  }
}

export function resolveStrataData(s: StrataDataSettings, backendRoot: string): { dataDir: string; env: NodeJS.ProcessEnv } {
  if (s.mode === 'isolated') {
    const dir = s.isolatedDir || join(backendRoot, `${STRATA_DATA_DIRNAME}-isolated`)
    const env: NodeJS.ProcessEnv = process.platform === 'win32'
      ? { APPDATA: join(dir, '.appdata') }
      : { XDG_CONFIG_HOME: join(dir, '.config') }
    return { dataDir: dir, env }
  }
  return { dataDir: s.dataDir || join(backendRoot, STRATA_DATA_DIRNAME), env: {} }
}

// --------------------------------------------------------------------------
// Launching
// --------------------------------------------------------------------------

export interface StrataSpawnSpec { command: string; args: string[]; options: SpawnOptions }

// Output is read from pipes and stdin is closed, so a launcher that would
// wait for a keypress (the .bat pauses after a failure) returns instead.
export function buildStrataSpawn(cloneDir: string, argv: string[], extraEnv: NodeJS.ProcessEnv): StrataSpawnSpec | { error: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extraEnv }
  const stdio: SpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe']
  if (process.platform === 'win32') {
    const bad = argv.find(a => /["%]/.test(a))
    if (bad) return { error: `Strata's launcher cannot take "${bad}" safely because it contains a quote or percent sign. Rename the folder or file.` }
    const line = [join(cloneDir, strataLauncherName()), ...argv].map(a => `"${a}"`).join(' ')
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { cwd: cloneDir, env, stdio, windowsVerbatimArguments: true, windowsHide: true }
    }
  }
  return {
    command: 'bash',
    args: [join(cloneDir, strataLauncherName()), ...argv],
    options: { cwd: cloneDir, env, stdio, detached: true }
  }
}


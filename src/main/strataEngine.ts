import { execFile, type SpawnOptions } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync, promises as fsPromises } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { NATIVE_PLATFORM } from './buildPlatform'
import { cloneOsOf } from './workDirs'
import type { BuildPlatform } from '../shared/assetPlatform'
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
// One instance per OS
// --------------------------------------------------------------------------
// The launcher makes a Python environment (.venv) and builds inside the clone,
// and both are specific to an OS. In an engines folder shared by several systems
// (dual boot) one clone would be rebuilt by each system after the other used it,
// and the two environments would be made on top of each other. So every OS has a
// clone of its own, beside the others in <engines>/<repo>/. Which OS a clone
// belongs to is read from its git config (see cloneOsOf), so a copy made by git
// on the new system is recognised as that system's with no marker to keep.

export interface GitEngineInstance { path: string; os: BuildPlatform | null }

// Every clone of a git engine in a repo folder, with the OS that made it.
export function gitEngineInstances(forkDir: string): GitEngineInstance[] {
  let subs: import('fs').Dirent[]
  try { subs = readdirSync(forkDir, { withFileTypes: true }) } catch { return [] }
  return subs
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => join(forkDir, d.name))
    .filter(looksLikeStrataClone)
    .map(path => ({ path, os: cloneOsOf(path) }))
}

// The instance of an OS (this one by default): one made on it, else one whose
// system cannot be told, which is taken to be the asker's.
export function instanceForOs(instances: GitEngineInstance[], os: BuildPlatform = NATIVE_PLATFORM): GitEngineInstance | undefined {
  return instances.find(i => i.os === os) ?? instances.find(i => i.os === null)
}

// An instance of another OS to make this one's from, the most recently used first.
export function instanceToCopy(instances: GitEngineInstance[], os: BuildPlatform = NATIVE_PLATFORM): GitEngineInstance | undefined {
  const others = instances.filter(i => i.os !== null && i.os !== os)
  const stamp = (i: GitEngineInstance) => { try { return statSync(join(i.path, '.git', 'HEAD')).mtimeMs } catch { return 0 } }
  return others.sort((a, b) => stamp(b) - stamp(a))[0]
}

// The name for this OS's instance next to the original ("Strata" -> "Strata-linux").
export function instanceNameFor(forkDir: string, repoName: string, os: BuildPlatform = NATIVE_PLATFORM): string {
  let name = `${repoName}-${os}`
  for (let n = 2; existsSync(join(forkDir, name)); n++) name = `${repoName}-${os}-${n}`
  return name
}

// --------------------------------------------------------------------------
// git
// --------------------------------------------------------------------------

export interface GitResult { ok: boolean; stdout: string; stderr: string }

export function git(args: string[], cwd?: string, opts: { timeoutMs?: number; httpsOnly?: boolean } = {}): Promise<GitResult> {
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
export function readHeadCommit(dir: string): string | null {
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

// A fetch can add a release tag to the commit the clone is already on, which
// changes its label without changing its commit, so labels are forgotten then.
function forgetDescribed(dir: string): void {
  for (const key of describeCache.keys()) if (key.startsWith(`${dir}|`)) describeCache.delete(key)
}

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

// What a git engine (Strata) is called: its release tag alone ("v0.2.10"), with
// nothing added for commits past it (git describe gives "v0.2.10-3-g1a2b3c4").
// The engine is a clone of the repository's branch, so being a few commits past
// the last release is the normal state, and the tag is what the update check
// compares anyway. A clone with no release tag is called by its short hash.
export async function gitEngineVersionLabel(dir: string): Promise<string> {
  const label = await gitVersionLabel(dir)
  return baseTagOf(label) ?? label
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
  forgetDescribed(dir)
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

// A GitHub https remote, the only kind a copy is given as its origin.
const GITHUB_REMOTE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(?:\.git)?\/?$/

// Makes an instance from a clone made on another OS, without fetching it again:
// git clones it locally, so only what git tracks comes over, checked out the way
// this system does it (its line endings, its file modes) and at the commit the
// other one is on. Nothing the launcher made there (the environment, build
// output) is carried across; the first start on this OS makes that once. The
// copy's origin is set back to the real remote, so updating works as for any
// clone. `slug` is the fallback when the source's remote is not a GitHub one.
export async function cloneGitEngineFrom(source: string, destDir: string, slug?: string): Promise<{ ok: boolean; error?: string }> {
  if (existsSync(destDir)) return { ok: false, error: `${destDir} already exists` }
  const remote = (await git(['config', '--get', 'remote.origin.url'], source, { timeoutMs: 10000 })).stdout
  const url = GITHUB_REMOTE.test(remote) ? remote : slug ? githubCloneUrl(slug) : null
  // safe.directory: the source may be on a drive owned by another account.
  const r = await git(['-c', `safe.directory=${source}`, 'clone', '--local', '--', source, destDir], undefined, { timeoutMs: 10 * 60 * 1000 })
  if (!r.ok) {
    await fsPromises.rm(destDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: r.stderr }
  }
  if (url) {
    const set = await git(['remote', 'set-url', 'origin', url], destDir, { timeoutMs: 10000 })
    if (!set.ok) {
      await fsPromises.rm(destDir, { recursive: true, force: true }).catch(() => {})
      return { ok: false, error: set.stderr }
    }
  }
  return { ok: true }
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


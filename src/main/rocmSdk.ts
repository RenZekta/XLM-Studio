import https from 'https'
import http from 'http'
import { execFile } from 'child_process'
import { createWriteStream, existsSync, readdirSync, readFileSync, promises as fsPromises } from 'fs'
import { delimiter, dirname, join } from 'path'
import { run, fail, type RunHooks } from './runLogged'
import {
  pickRocmTarball, rocmOsFor, rocmTarballCandidates, parseS3Listing, parseHtmlListing, compareRocmVersions,
  ROCM_PIP_INDEX, rocmPipExtras, parsePipIndexVersions,
  type RocmOs, type RocmTarball, type RocmSdkSource
} from '../shared/rocm'

// Downloads and manages the ROCm/HIP SDK inside the app's own engines folder,
// from AMD's TheRock tarballs or from AMD's Python wheels:
//   <engines>/.sdk/rocm/<version>-<family>-<os>/       the extracted tarball
//   <engines>/.sdk/rocm/<version>-<family>-pip-<os>/   a virtual environment with the wheels
// An engines folder can be shared by several systems, so each SDK records the OS
// it is for and every lookup and cleanup only deals with the current one's
// (folders made before that was recorded are told by their contents).
// It needs no administrator rights and does not touch the system PATH: the
// build gets the SDK through its own environment (see rocmToolchain).

export type RocmChannel = 'stable' | 'nightly'

interface RocmSource {
  // "s3": an S3 bucket answering ListObjectsV2. "html": a page that lists the
  // tarball names.
  kind: 's3' | 'html'
  base: string
  // For a host whose listing cannot be read: releases to look for by name.
  probeVersions?: string[]
}

export const ROCM_SOURCES: Record<RocmChannel, RocmSource[]> = {
  stable: [{ kind: 'html', base: 'https://stable.repo.amd.com/rocm/core/tarball/', probeVersions: ['10.1.0'] }],
  nightly: [
    { kind: 's3', base: 'https://therock-nightly-tarball.s3.amazonaws.com/' },
    { kind: 'html', base: 'https://nightly.repo.amd.com/rocm/core/tarball/' }
  ]
}

export const ROCM_MARKER = '.xlm-rocm.json'

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

interface HttpResult { status: number; body: string }
export interface RocmHttp {
  getText: (url: string) => Promise<HttpResult>
  // Whether the file exists, and its size when the server says.
  probe: (url: string) => Promise<{ ok: boolean; size?: number }>
}

export function open(url: string, method: 'GET' | 'HEAD', headers: Record<string, string>, redirects = 5): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.request : http.request
    const req = get(url, { method, headers: { 'User-Agent': 'xlm-studio', ...headers }, timeout: 30000 }, res => {
      const status = res.statusCode || 0
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume()
        if (redirects <= 0) return reject(new Error('Too many redirects'))
        return open(new URL(res.headers.location, url).toString(), method, headers, redirects - 1).then(resolve, reject)
      }
      resolve(res)
    })
    req.on('timeout', () => req.destroy(new Error('Timed out')))
    req.on('error', reject)
    req.end()
  })
}

export const defaultHttp: RocmHttp = {
  async getText(url) {
    const res = await open(url, 'GET', {})
    const chunks: Buffer[] = []
    let size = 0
    for await (const c of res) {
      size += (c as Buffer).length
      if (size > 20 * 1024 * 1024) { res.destroy(); break }
      chunks.push(c as Buffer)
    }
    return { status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }
  },
  async probe(url) {
    let res = await open(url, 'HEAD', {})
    res.resume()
    // Some hosts refuse HEAD; a one-byte ranged GET answers the same question.
    if ([403, 405, 501].includes(res.statusCode || 0)) {
      res = await open(url, 'GET', { Range: 'bytes=0-0' })
      res.destroy()
    }
    const status = res.statusCode || 0
    const range = /\/(\d+)$/.exec(String(res.headers['content-range'] || ''))
    const size = range ? +range[1] : res.headers['content-length'] ? +res.headers['content-length'] : undefined
    return { ok: status === 200 || status === 206, size }
  }
}

// --------------------------------------------------------------------------
// Finding the newest tarball
// --------------------------------------------------------------------------

export interface ResolvedRocm {
  tarball: RocmTarball
  url: string
  channel: RocmChannel
  size?: number
}

async function resolveFromSource(src: RocmSource, os: RocmOs, family: string, net: RocmHttp): Promise<{ tarball: RocmTarball; url: string } | null> {
  const names: string[] = []
  if (src.kind === 's3') {
    let token: string | null = null
    for (let page = 0; page < 10; page++) {
      const url: string = `${src.base}?list-type=2&prefix=${encodeURIComponent(`therock-dist-${os}-${family}`)}${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`
      const r = await net.getText(url)
      if (r.status !== 200) break
      const listing = parseS3Listing(r.body)
      names.push(...listing.keys)
      token = listing.nextToken
      if (!token) break
    }
  } else {
    const r = await net.getText(src.base)
    if (r.status === 200) names.push(...parseHtmlListing(r.body))
  }
  const hit = pickRocmTarball(names, os, family)
  if (hit) return { tarball: hit, url: src.base + hit.name }
  // No readable listing, or none of the names fit: ask for known releases by name.
  for (const version of src.probeVersions ?? []) {
    for (const name of rocmTarballCandidates(os, family, version)) {
      const p = await net.probe(src.base + name).catch(() => ({ ok: false }))
      if (p.ok) {
        const tarball = pickRocmTarball([name], os, family)
        if (tarball) return { tarball, url: src.base + name }
      }
    }
  }
  return null
}

// The newest tarball for this family. The stable channel falls back to the
// nightlies when AMD has no stable build for the family, and says so.
export async function resolveRocmTarball(
  channel: RocmChannel, os: RocmOs, family: string,
  opts: { net?: RocmHttp; sources?: Record<RocmChannel, RocmSource[]>; note?: (line: string) => void } = {}
): Promise<ResolvedRocm | null> {
  const net = opts.net ?? defaultHttp
  const sources = opts.sources ?? ROCM_SOURCES
  const order: RocmChannel[] = channel === 'stable' ? ['stable', 'nightly'] : ['nightly']
  for (const ch of order) {
    if (ch !== channel) opts.note?.(`No stable ROCm SDK was found for ${family}; looking at the nightly builds.`)
    for (const src of sources[ch]) {
      try {
        const found = await resolveFromSource(src, os, family, net)
        if (found) {
          const size = (await net.probe(found.url).catch(() => ({ ok: false, size: undefined as number | undefined }))).size
          return { ...found, channel: ch, size }
        }
      } catch { /* try the next source */ }
    }
  }
  return null
}

// --------------------------------------------------------------------------
// Installed SDKs
// --------------------------------------------------------------------------

export interface InstalledRocm {
  // The folder that holds bin/, lib/ and include/.
  root: string
  version: string
  family: string
  dir: string
  source: RocmSdkSource
  os: RocmOs
}

export function rocmSdkDir(rootDir: string): string {
  return join(rootDir, '.sdk', 'rocm')
}

// The OS an SDK folder is for. Installs record it; ones from before that did not,
// and Windows ones have .exe tools (a pip one a Scripts folder in its venv).
function sdkOsOf(dir: string, root: string, recorded?: RocmOs): RocmOs {
  if (recorded) return recorded
  const windowsTools = ['bin/hipcc.exe', 'bin/hipconfig.exe', 'bin/clang.exe', 'lib/llvm/bin/clang.exe', 'lib/llvm/bin/clang++.exe']
  return existsSync(join(dir, 'Scripts')) || windowsTools.some(t => existsSync(join(root, ...t.split('/')))) ? 'windows' : 'linux'
}

// The newest installed SDK for an OS (this one by default), of this family and
// this source when given. There is none on an OS ROCm does not exist for.
export function findInstalledRocm(rootDir: string, family?: string, source?: RocmSdkSource, os: RocmOs | null = rocmOsFor(process.platform)): InstalledRocm | null {
  if (!os) return null
  let best: InstalledRocm | null = null
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(rocmSdkDir(rootDir), { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(rocmSdkDir(rootDir), e.name)
    try {
      const m = JSON.parse(readFileSync(join(dir, ROCM_MARKER), 'utf8')) as { version: string; family: string; rootRel: string; source?: RocmSdkSource; os?: RocmOs }
      if (family && m.family.toLowerCase() !== family.toLowerCase()) continue
      const src: RocmSdkSource = m.source ?? 'tarball'
      if (source && src !== source) continue
      const root = join(dir, m.rootRel)
      if (!existsSync(root)) continue
      if (sdkOsOf(dir, root, m.os) !== os) continue
      if (!best || compareRocmVersions(m.version, best.version) > 0) best = { root, version: m.version, family: m.family, dir, source: src, os }
    } catch { /* not a finished install */ }
  }
  return best
}

// Where the SDK actually starts inside an extracted tarball (they may or may
// not have a top folder).
function locateSdkRoot(dir: string, depth = 3): string | null {
  const exe = (n: string) => process.platform === 'win32' ? [`${n}.exe`, `${n}.cmd`, n] : [n]
  const has = (base: string, sub: string[], names: string[]) => names.some(n => existsSync(join(base, ...sub, n)))
  if (has(dir, ['bin'], [...exe('hipcc'), ...exe('hipconfig')]) || has(dir, ['lib', 'llvm', 'bin'], exe('clang++'))) return dir
  if (depth === 0) return null
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const hit = locateSdkRoot(join(dir, e.name), depth - 1)
    if (hit) return hit
  }
  return null
}

// --------------------------------------------------------------------------
// Installing
// --------------------------------------------------------------------------

export interface RocmHooks extends RunHooks {
  progress?: (percent: number) => void
}

function download(url: string, dest: string, hooks: RocmHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hooks.signal.aborted) return reject(new Error('Cancelled'))
    open(url, 'GET', {}).then(res => {
      if ((res.statusCode || 0) !== 200) { res.resume(); return reject(new Error(`The download failed (HTTP ${res.statusCode}).`)) }
      const total = +(res.headers['content-length'] || 0)
      let got = 0
      let lastPct = -1
      const out = createWriteStream(dest)
      const onAbort = () => { res.destroy(new Error('Cancelled')); out.destroy() }
      hooks.signal.addEventListener('abort', onAbort, { once: true })
      res.on('data', (c: Buffer) => {
        got += c.length
        if (total) {
          const pct = Math.floor(got / total * 100)
          if (pct !== lastPct) {
            lastPct = pct
            hooks.progress?.(pct)
            if (pct % 10 === 0) hooks.log(`Downloading: ${pct}% (${(got / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB)`, true)
          }
        }
      })
      res.on('error', reject)
      out.on('error', reject)
      out.on('finish', () => { hooks.signal.removeEventListener('abort', onAbort); resolve() })
      res.pipe(out)
    }, reject)
  })
}

export type RocmInstallResult =
  | { ok: true; installed: InstalledRocm; changed: boolean }
  | { ok: false; error: string }

// Installs the newest SDK for the family, or reports it is current. An older
// install of the same family is removed once the new one is in place.
export interface RocmInstallOptions {
  rootDir: string
  family: string
  channel: RocmChannel
  os: RocmOs
  // Tarball (default) or AMD's Python wheels.
  source?: RocmSdkSource
  // The GPU target, for the pip route's per-GPU extra.
  gfx?: string
  net?: RocmHttp
  sources?: Record<RocmChannel, RocmSource[]>
  // The pip route's index and Python, replaceable for tests.
  pipIndex?: string
  python?: PythonCmd
}

export async function installRocmSdk(opts: RocmInstallOptions, hooks: RocmHooks): Promise<RocmInstallResult> {
  if (opts.source === 'pip') return installRocmPip(opts, hooks)
  const note = (l: string) => hooks.log(l, true)
  try {
    note(`Looking for the ${opts.channel} ROCm SDK for ${opts.family} (${opts.os})...`)
    const latest = await resolveRocmTarball(opts.channel, opts.os, opts.family, { net: opts.net, sources: opts.sources, note })
    if (!latest) {
      fail(`No ROCm SDK for ${opts.family} on ${opts.os} could be found. AMD's download site may be unreachable, or it has no build for this GPU family.`)
    }
    const current = findInstalledRocm(opts.rootDir, opts.family, 'tarball', opts.os)
    if (current && compareRocmVersions(current.version, latest.tarball.version) >= 0) {
      note(`The ROCm SDK ${current.version} is already the newest.`)
      return { ok: true, installed: current, changed: false }
    }
    note(`Installing ROCm SDK ${latest.tarball.version} (${latest.channel})${latest.size ? `, a ${(latest.size / 1e9).toFixed(1)} GB download` : ''}`)

    const sdkDir = rocmSdkDir(opts.rootDir)
    const downloads = join(sdkDir, '.download')
    await fsPromises.mkdir(downloads, { recursive: true })
    if (latest.size) {
      // Download, then extract: roughly three times the archive at the peak.
      const stats = await fsPromises.statfs(downloads).catch(() => null)
      if (stats && stats.bavail * stats.bsize < latest.size * 3) {
        fail(`Not enough free disk space: about ${(latest.size * 3 / 1e9).toFixed(0)} GB are needed to download and unpack the ROCm SDK.`)
      }
    }
    const archive = join(downloads, latest.tarball.name)
    hooks.progress?.(0)
    await download(latest.url, archive, hooks)
    if (hooks.signal.aborted) fail('Cancelled')

    note('Unpacking...')
    const staging = join(sdkDir, `.staging-${Date.now()}`)
    await fsPromises.mkdir(staging, { recursive: true })
    try {
      const code = await run('tar', ['-xzf', archive, '-C', staging], hooks)
      if (code === null) fail('Cancelled')
      if (code !== 0) fail(`Unpacking the archive failed (exit code ${code}).`)
      const root = locateSdkRoot(staging)
      if (!root) fail('The archive was unpacked but contains no ROCm SDK (no bin/hipcc or lib/llvm/bin/clang++).')
      const dest = join(sdkDir, `${latest.tarball.version}-${opts.family}-${opts.os}`)
      await fsPromises.rm(dest, { recursive: true, force: true })
      await fsPromises.rename(staging, dest)
      const rootRel = root === staging ? '.' : root.slice(staging.length + 1)
      await fsPromises.writeFile(join(dest, ROCM_MARKER), JSON.stringify({
        version: latest.tarball.version, family: opts.family, source: 'tarball', os: opts.os, channel: latest.channel, rootRel, installedAt: Date.now()
      }, null, 2))
    } finally {
      await fsPromises.rm(staging, { recursive: true, force: true })
      await fsPromises.rm(archive, { force: true })
    }

    const installed = findInstalledRocm(opts.rootDir, opts.family, 'tarball', opts.os)
    if (!installed) fail('The ROCm SDK was unpacked but could not be found afterwards.')
    await pruneRocmInstalls(opts.rootDir, installed, note)
    note(`The ROCm SDK ${installed.version} is installed.`)
    return { ok: true, installed, changed: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: hooks.signal.aborted ? 'Cancelled' : message }
  }
}

// Whether a newer SDK than the installed one exists for the family.
export async function rocmUpdateAvailable(
  rootDir: string, family: string, channel: RocmChannel, os: RocmOs,
  opts: { net?: RocmHttp; sources?: Record<RocmChannel, RocmSource[]>; source?: RocmSdkSource; pipIndex?: string } = {}
): Promise<boolean> {
  const current = findInstalledRocm(rootDir, family, opts.source ?? 'tarball', os)
  if (!current) return false
  if (opts.source === 'pip') {
    const latest = await latestPipVersion(opts.net ?? defaultHttp, opts.pipIndex ?? ROCM_PIP_INDEX).catch(() => null)
    return !!latest && compareRocmVersions(latest, current.version) > 0
  }
  const latest = await resolveRocmTarball(channel, os, family, opts).catch(() => null)
  return !!latest && compareRocmVersions(latest.tarball.version, current.version) > 0
}

// A new SDK has been installed: everything else for the family goes, older
// versions of the same source and the other source's install alike. (A
// switch of source is made to replace the old one, and an SDK is several GB.)
async function pruneRocmInstalls(rootDir: string, keep: InstalledRocm, note: (l: string) => void): Promise<void> {
  const sdkDir = rocmSdkDir(rootDir)
  for (const e of readdirSync(sdkDir, { withFileTypes: true })) {
    const dir = join(sdkDir, e.name)
    if (!e.isDirectory() || e.name.startsWith('.') || dir === keep.dir) continue
    try {
      const m = JSON.parse(readFileSync(join(dir, ROCM_MARKER), 'utf8')) as { family: string; version: string; source?: RocmSdkSource; os?: RocmOs; rootRel?: string }
      if (m.family.toLowerCase() !== keep.family.toLowerCase()) continue
      // Another system's SDK in a shared engines folder is not this install's to remove.
      if (sdkOsOf(dir, join(dir, m.rootRel ?? '.'), m.os) !== keep.os) continue
      const otherSource = (m.source ?? 'tarball') !== keep.source
      if (otherSource || compareRocmVersions(m.version, keep.version) < 0) {
        await fsPromises.rm(dir, { recursive: true, force: true })
        note(`Removed the superseded ROCm SDK ${m.version}${otherSource ? ` (${m.source ?? 'tarball'})` : ''}.`)
      }
    } catch { /* not ours */ }
  }
}

// --------------------------------------------------------------------------
// The pip route
// --------------------------------------------------------------------------

export interface PythonCmd {
  cmd: string
  args: string[]
  version: string
}

function capture(cmd: string, args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout || stderr || '') })
    })
  })
}

// A Python the ROCm wheels support (3.11 to 3.14).
export async function findPython(): Promise<PythonCmd | null> {
  const candidates: [string, string[]][] = process.platform === 'win32'
    ? [['py', ['-3.14']], ['py', ['-3.13']], ['py', ['-3.12']], ['py', ['-3.11']], ['python', []]]
    : [['python3.14', []], ['python3.13', []], ['python3.12', []], ['python3.11', []], ['python3', []], ['python', []]]
  for (const [cmd, args] of candidates) {
    const r = await capture(cmd, [...args, '--version'], 8000)
    const m = /Python 3\.(\d+)/.exec(r.stdout)
    if (r.code === 0 && m && +m[1] >= 11 && +m[1] <= 14) return { cmd, args, version: `3.${m[1]}` }
  }
  return null
}

// The newest release of the rocm package on the index.
export async function latestPipVersion(net: RocmHttp, index: string): Promise<string | null> {
  const r = await net.getText(`${index.replace(/\/?$/, '/')}rocm/`)
  return r.status === 200 ? parsePipIndexVersions(r.body)[0] ?? null : null
}

function venvBin(venv: string, name: string): string {
  return process.platform === 'win32' ? join(venv, 'Scripts', `${name}.exe`) : join(venv, 'bin', name)
}

function findDirNamed(dir: string, name: string, depth: number): string | null {
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name === name) return join(dir, e.name)
    if (depth > 0) {
      const hit = findDirNamed(join(dir, e.name), name, depth - 1)
      if (hit) return hit
    }
  }
  return null
}

// Where the SDK is inside an environment the wheels were installed into: as
// the rocm-sdk command reports it, else by looking for its core package.
async function locatePipSdkRoot(venv: string, hooks: RocmHooks): Promise<string | null> {
  const cli = venvBin(venv, 'rocm-sdk')
  if (existsSync(cli)) {
    // Expands the development files into the SDK on first use; harmless when
    // there is nothing to do.
    await capture(cli, ['init'], 10 * 60 * 1000)
    const r = await capture(cli, ['path', '--root'])
    const printed = r.stdout.trim().split('\n').pop()?.trim()
    if (r.code === 0 && printed && existsSync(printed)) {
      const root = locateSdkRoot(printed, 1)
      if (root) return root
    }
    hooks.log('rocm-sdk did not report a usable SDK folder; searching the environment.', true)
  }
  const core = findDirNamed(venv, '_rocm_sdk_core', 6)
  return core ? locateSdkRoot(core, 1) : null
}

async function installRocmPip(opts: RocmInstallOptions, hooks: RocmHooks): Promise<RocmInstallResult> {
  const note = (l: string) => hooks.log(l, true)
  const net = opts.net ?? defaultHttp
  const index = opts.pipIndex ?? ROCM_PIP_INDEX
  let dest: string | null = null
  try {
    if (!opts.gfx) fail('Choose your GPU first: the ROCm SDK is installed with the device files for it.')
    note(`Looking for the ROCm SDK on AMD's Python index...`)
    const latest = await latestPipVersion(net, index).catch(() => null)
    if (!latest) fail(`The ROCm package list at ${index} could not be read. AMD's site may be unreachable.`)
    const current = findInstalledRocm(opts.rootDir, opts.family, 'pip', opts.os)
    if (current && compareRocmVersions(current.version, latest) >= 0) {
      note(`The ROCm SDK ${current.version} is already the newest.`)
      return { ok: true, installed: current, changed: false }
    }
    const python = opts.python ?? await findPython()
    if (!python) fail('Python 3.11 to 3.14 was not found. Install it, or switch the ROCm SDK source to the tarball.')

    const sdkDir = rocmSdkDir(opts.rootDir)
    await fsPromises.mkdir(sdkDir, { recursive: true })
    dest = join(sdkDir, `${latest}-${opts.family}-pip-${opts.os}`)
    await fsPromises.rm(dest, { recursive: true, force: true })
    note(`Installing ROCm SDK ${latest} with pip (a multi-GB download) into a virtual environment...`)
    hooks.progress?.(0)
    let code = await run(python.cmd, [...python.args, '-m', 'venv', dest], hooks)
    if (code === null) fail('Cancelled')
    if (code !== 0) fail(`Creating the virtual environment failed (exit code ${code}). On Debian and Ubuntu this needs the python3-venv package.`)
    code = await run(venvBin(dest, 'python'), [
      '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--progress-bar', 'off',
      '--index-url', index, `rocm[${rocmPipExtras(opts.gfx)}]==${latest}`
    ], hooks)
    if (code === null) fail('Cancelled')
    if (code !== 0) fail(`pip failed (exit code ${code}). See the log for details.`)

    const root = await locatePipSdkRoot(dest, hooks)
    if (!root) fail('pip installed the packages but no ROCm SDK with compilers (rocm[devel]) was found in them. Try the tarball source instead.')
    await fsPromises.writeFile(join(dest, ROCM_MARKER), JSON.stringify({
      version: latest, family: opts.family, source: 'pip', os: opts.os, channel: 'stable', rootRel: root.slice(dest.length + 1) || '.', installedAt: Date.now()
    }, null, 2))
    const installed = findInstalledRocm(opts.rootDir, opts.family, 'pip', opts.os)
    if (!installed) fail('The ROCm SDK was installed but could not be found afterwards.')
    await pruneRocmInstalls(opts.rootDir, installed, note)
    note(`The ROCm SDK ${installed.version} is installed.`)
    return { ok: true, installed, changed: true }
  } catch (err) {
    // A half-made environment is of no use and cannot be resumed.
    if (dest) await fsPromises.rm(dest, { recursive: true, force: true }).catch(() => {})
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: hooks.signal.aborted ? 'Cancelled' : message }
  }
}

// --------------------------------------------------------------------------
// An SDK that is already on the machine
// --------------------------------------------------------------------------

// Where an SDK keeps its clang: TheRock builds under lib/llvm/bin, older
// layouts under llvm/bin, and AMD's classic Windows HIP SDK beside hipcc in bin.
function clangDirOf(root: string, platform: string = process.platform): string | null {
  const exe = platform === 'win32' ? 'clang.exe' : 'clang'
  return [join(root, 'lib', 'llvm', 'bin'), join(root, 'llvm', 'bin'), join(root, 'bin')].find(d => existsSync(join(d, exe))) ?? null
}

// What a build needs from an SDK: HIP's CMake package (ggml's find_package(hip))
// and a compiler. hipcc alone, or HIP_PATH pointing at a runtime-only install,
// is not enough: configuring fails with "Could not find a package configuration
// file provided by hip".
export function isUsableSdkRoot(root: string): boolean {
  const hasCmake = ['hip-config.cmake', 'hipConfig.cmake'].some(n => existsSync(join(root, 'lib', 'cmake', 'hip', n)))
  return hasCmake && clangDirOf(root) !== null
}

// A usable ROCm/HIP SDK that was installed outside the app (HIP_PATH, ROCM_PATH,
// the folder above a hipcc on the PATH, or /opt/rocm), or null.
export function systemHipRoot(): string | null {
  const candidates: (string | undefined)[] = [process.env.HIP_PATH, process.env.ROCM_PATH]
  const exes = process.platform === 'win32' ? ['hipcc.exe', 'hipcc.bat', 'hipcc.cmd'] : ['hipcc']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && exes.some(n => existsSync(join(dir, n)))) candidates.push(dirname(dir))
  }
  if (process.platform === 'linux') candidates.push('/opt/rocm')
  for (const c of candidates) {
    const root = c?.trim().replace(/[\\/]+$/, '')
    if (root && isUsableSdkRoot(root)) return root
  }
  return null
}

// --------------------------------------------------------------------------
// Using an installed SDK for a build
// --------------------------------------------------------------------------

// What a program built against this SDK needs when it runs: the folders its
// shared libraries are in. (A release build of llama.cpp ships these next to
// the executable; a build from source does not.)
export function rocmRuntimeEnv(root: string, platform: string): Record<string, string> {
  if (platform === 'win32') {
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    return { [pathKey]: [join(root, 'bin'), process.env[pathKey] || ''].filter(Boolean).join(delimiter), HIP_PATH: root, ROCM_PATH: root }
  }
  const libs = [join(root, 'lib'), join(root, 'lib', 'rocm_sysdeps', 'lib')].filter(d => existsSync(d))
  return {
    LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(delimiter),
    HIP_PATH: root,
    ROCM_PATH: root
  }
}

export interface RocmToolchain {
  env: Record<string, string>
  // The folders put in front of the PATH (already part of env's PATH).
  pathDirs: string[]
  cmakeArgs: string[]
  // The folder with the device libraries (ocml.bc and the other bitcode every
  // HIP compile links), null when the SDK has none.
  deviceLibDir: string | null
}

// Where an SDK keeps the device libraries. clang looks for them next to itself
// in a few fixed places and gives up with "cannot find ROCm device library" when
// the SDK's layout is another, so they are searched for instead.
export function findDeviceLibDir(root: string, maxDepth = 8): string | null {
  const walk = (dir: string, depth: number): string | null => {
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    if (entries.some(e => e.isFile() && e.name === 'ocml.bc')) return dir
    if (depth === 0) return null
    // Where they are likely to be are tried before the rest.
    const likely = entries.filter(e => e.isDirectory() && /^(lib|llvm|amdgcn|bitcode|clang|\d+)$/.test(e.name))
    const others = entries.filter(e => e.isDirectory() && !likely.includes(e) && !['include', 'share', 'bin', '.git'].includes(e.name))
    for (const e of [...likely, ...others]) {
      const hit = walk(join(dir, e.name), depth - 1)
      if (hit) return hit
    }
    return null
  }
  return walk(root, maxDepth)
}

// The environment and CMake arguments that make a build use this SDK instead
// of whatever is (or is not) installed system-wide.
export function rocmToolchain(root: string, platform: string): RocmToolchain {
  const clangDir = clangDirOf(root, platform)
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const pathDirs = [join(root, 'bin'), ...(clangDir ? [clangDir] : [])]
  const dirs = [...pathDirs, process.env[pathKey] || '']
  const env: Record<string, string> = {
    HIP_PATH: root,
    ROCM_PATH: root,
    [pathKey]: dirs.filter(Boolean).join(delimiter)
  }
  const cmakeArgs = [`-DCMAKE_PREFIX_PATH=${root}`]
  if (clangDir) {
    env.HIP_CLANG_PATH = clangDir
    if (platform === 'win32') {
      // HIP builds on Windows need Ninja and the SDK's clang as the compiler.
      cmakeArgs.push('-G', 'Ninja', `-DCMAKE_C_COMPILER=${join(clangDir, 'clang.exe')}`, `-DCMAKE_CXX_COMPILER=${join(clangDir, 'clang++.exe')}`)
    } else {
      env.HIPCXX = join(clangDir, 'clang')
    }
  }
  const deviceLibDir = findDeviceLibDir(root)
  if (deviceLibDir) {
    // The environment variable is read by clang on every compile; the flag is
    // there for a clang that does not look at it. A build folder remembers
    // CMAKE_CXX_FLAGS, so it is set explicitly rather than through CXXFLAGS.
    env.HIP_DEVICE_LIB_PATH = deviceLibDir
    cmakeArgs.push(`-DCMAKE_CXX_FLAGS=--rocm-device-lib-path=${deviceLibDir} -Wno-unused-command-line-argument`)
    cmakeArgs.push(`-DCMAKE_HIP_FLAGS=--rocm-device-lib-path=${deviceLibDir}`)
  }
  return { env, pathDirs, cmakeArgs, deviceLibDir }
}

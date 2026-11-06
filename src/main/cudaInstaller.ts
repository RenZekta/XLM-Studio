import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync, readdirSync, promises as fsPromises, statSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { run, fail, type RunHooks } from './runLogged'
import { open as httpOpen } from './rocmSdk'
import { findCudaRoot, missingCudaParts } from './cudaSdk'
import { ensureToolEnv } from './toolEnv'

// Installs the CUDA Toolkit on Windows without winget doing the download: winget
// can stall for good on a 4 GB installer, and it shows no progress. winget is
// only asked for its manifest (the installer's URL and SHA-256); the app fetches
// the file itself, resumably and with a progress figure, checks it, and runs it.

export interface WingetInstaller {
  url: string
  sha256: string
  version: string
}

// The installer URL, its SHA-256 and the version out of `winget show`. The field
// names are in the user's language, so the values are recognised by their shape.
export function parseWingetShow(text: string): { url?: string; sha256?: string; version?: string } {
  return {
    url: /https?:\/\/\S+?\.exe\b/i.exec(text)?.[0],
    sha256: /\b[0-9a-fA-F]{64}\b/.exec(text)?.[0].toLowerCase(),
    version: /^\s*(?:Version|Versi[oó]n|Version)\s*:\s*(\d+(?:\.\d+)+)\s*$/im.exec(text)?.[1]
  }
}

// The version strings of `winget show --versions`, newest first as listed.
export function parseWingetVersions(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+(?:\.\d+)+$/.test(l))
}

type Capture = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string }>

function defaultCapture(cmd: string, args: string[], timeoutMs = 60000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout || stderr || '') })
    })
  })
}

// The installer winget has for this toolkit series ("12.4"), or the newest one.
export async function resolveCudaInstaller(
  series: string | undefined, opts: { winget?: string; capture?: Capture } = {}
): Promise<WingetInstaller | null> {
  const winget = opts.winget ?? 'winget'
  const capture = opts.capture ?? defaultCapture
  const base = ['show', '--id', 'Nvidia.CUDA', '-e', '--accept-source-agreements', '--disable-interactivity']
  let version: string | undefined
  if (series) {
    const list = parseWingetVersions((await capture(winget, [...base, '--versions'])).stdout)
    // Newest of the series: "12.4.1" before "12.4".
    version = list.filter(v => v === series || v.startsWith(`${series}.`)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    if (!version) return null
  }
  const shown = await capture(winget, [...base, ...(version ? ['--version', version] : [])])
  if (shown.code !== 0) return null
  const parsed = parseWingetShow(shown.stdout)
  if (!parsed.url || !parsed.sha256) return null
  return { url: parsed.url, sha256: parsed.sha256, version: version ?? parsed.version ?? series ?? 'latest' }
}

export function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('data', c => hash.update(c))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export interface DownloadHooks extends RunHooks {
  progress?: (percent: number) => void
}

// Downloads to `dest`, continuing a partial file from an earlier try, and checks
// the SHA-256. A file that is already complete and correct is kept as it is.
export async function downloadVerified(url: string, dest: string, sha256: string, hooks: DownloadHooks): Promise<void> {
  if (existsSync(dest) && (await sha256Of(dest)) === sha256) {
    hooks.log('The installer is already downloaded and checked.', true)
    return
  }
  const part = `${dest}.part`
  for (let attempt = 0; attempt < 3; attempt++) {
    if (hooks.signal.aborted) fail('Cancelled')
    const have = existsSync(part) ? statSync(part).size : 0
    const res = await httpOpen(url, 'GET', have > 0 ? { Range: `bytes=${have}-` } : {})
    const status = res.statusCode || 0
    if (status === 416) { res.resume(); break } // the partial file is already everything
    if (status !== 200 && status !== 206) { res.resume(); fail(`The download failed (HTTP ${status}).`) }
    // 200 means the server ignored the range and sends the whole file again.
    const resumed = status === 206
    const length = +(res.headers['content-length'] || 0)
    const total = resumed ? have + length : length
    let got = resumed ? have : 0
    let lastPct = -1
    hooks.log(resumed ? `Continuing the download at ${(have / 1e9).toFixed(2)} GB.` : 'Downloading the installer.', true)
    const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
    let broken: string | null = null
    await new Promise<void>(resolve => {
      const onAbort = () => { res.destroy(); out.end() }
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
      // A dropped connection ends the data but must still be written out before
      // the next try reads the size of the file to continue from.
      res.on('error', err => { broken = err.message; out.end() })
      res.on('aborted', () => { broken = broken ?? 'the connection was closed early'; out.end() })
      out.on('error', err => { broken = err.message; resolve() })
      out.on('finish', () => { hooks.signal.removeEventListener('abort', onAbort); resolve() })
      res.pipe(out)
    })
    if (hooks.signal.aborted) fail('Cancelled')
    const finished = !broken && (!total || got >= total)
    if (broken) hooks.log(`The connection broke (${broken}); continuing where it stopped.`, true)
    if (finished) break
  }
  hooks.log('Checking the download...', true)
  if ((await sha256Of(part)) !== sha256) {
    await fsPromises.rm(part, { force: true })
    fail('The downloaded installer does not match the checksum in winget\'s manifest, so it was deleted. Try again.')
  }
  await fsPromises.rename(part, dest)
}

// The installer's silent arguments. A short list of components (what llama.cpp
// needs; no Visual Studio integration, which is not used and is the part that
// hangs) is tried first, and everything if that does not leave a whole toolkit.
// From CUDA 13 the CRT headers and the NVVM compiler are components of their own
// (crt is confirmed to be named so; nvvm is the same pattern); if a name here is
// not one the installer knows, the toolkit comes out incomplete and the full
// install that follows covers it.
export function cudaSilentArgs(series: string, subset: boolean): string[] {
  if (!subset) return ['-s', '-n']
  const major = parseInt(series, 10)
  const parts = ['nvcc', ...(major >= 13 ? ['crt', 'nvvm'] : []), 'cudart', 'cublas', 'cublas_dev', 'thrust']
  return ['-s', '-n', ...parts.map(c => `${c}_${series}`)]
}

// Starts the installer with administrator rights (asking for them if the app
// does not have them) and waits for it.
export function runElevated(file: string, args: string[], hooks: RunHooks): Promise<number | null> {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`
  const script = `$p = Start-Process -FilePath ${q(file)} -ArgumentList ${args.map(q).join(',')} -Verb RunAs -Wait -PassThru; exit $p.ExitCode`
  return run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], hooks, { heartbeat: { everyMs: 30_000 } })
}

export type CudaInstallResult = { ok: true; root: string; changed: boolean } | { ok: false; error: string }

export interface CudaInstallDeps {
  resolve?: typeof resolveCudaInstaller
  download?: typeof downloadVerified
  runInstaller?: (file: string, args: string[], hooks: RunHooks) => Promise<number | null>
  platform?: string
}

// Installs the toolkit of the series (or the newest) unless a whole one at least
// that new is there already. A toolkit that lacks parts a build needs is
// repaired by running the installer over it.
export async function installCudaToolkit(
  opts: { rootDir: string; series?: string; winget?: string },
  hooks: DownloadHooks, deps: CudaInstallDeps = {}
): Promise<CudaInstallResult> {
  const note = (l: string) => hooks.log(l, true)
  const platform = deps.platform ?? process.platform
  try {
    const installer = await (deps.resolve ?? resolveCudaInstaller)(opts.series, { winget: opts.winget })
    if (!installer) fail(`winget has no CUDA ${opts.series ?? ''} installer to read the download address from. Install the CUDA Toolkit from developer.nvidia.com/cuda-toolkit-archive and build again.`)
    const current = findCudaRoot(opts.series)
    const want = installer.version
    if (current?.version && compareDotted(current.version, want) >= 0) {
      const lacking = missingCudaParts(current.root, platform)
      if (lacking.length === 0) {
        note(`CUDA ${current.version} is already installed.`)
        return { ok: true, root: current.root, changed: false }
      }
      note(`CUDA ${current.version} at ${current.root} is incomplete (missing ${lacking.join(', ')}); the installer will be run to repair it.`)
    }
    const series = opts.series ?? want.split('.').slice(0, 2).join('.')
    const dir = join(opts.rootDir, '.sdk', 'cuda')
    await fsPromises.mkdir(dir, { recursive: true })
    const file = join(dir, `cuda_${want}_windows_x86_64.exe`)
    note(`Installing CUDA ${want}: downloading ${installer.url}`)
    hooks.progress?.(0)
    await (deps.download ?? downloadVerified)(installer.url, file, installer.sha256, hooks)
    hooks.progress?.(100)

    const exec = deps.runInstaller ?? runElevated
    // Runs the installer and says what, if anything, the toolkit still lacks.
    const attempt = async (subset: boolean): Promise<{ found: boolean; lacking: string[] }> => {
      note(subset ? `Running the installer with the components a build needs (${series}).` : 'Running the installer for everything. This includes NVIDIA\'s Visual Studio integration and can take a long time.')
      const code = await exec(file, cudaSilentArgs(series, subset), hooks)
      if (code === null) fail('Cancelled')
      if (code !== 0) note(`The installer exited with code ${code}.`)
      await ensureToolEnv(true)
      const toolkit = findCudaRoot(series)
      return { found: !!toolkit, lacking: toolkit ? missingCudaParts(toolkit.root, platform) : [] }
    }
    let result = await attempt(true)
    if (!result.found || result.lacking.length > 0) {
      note(result.found
        ? `The short list of components left the toolkit incomplete (missing ${result.lacking.join(', ')}); trying the full install.`
        : 'No toolkit was installed with the short list of components; trying the full install.')
      result = await attempt(false)
    }
    if (!result.found) fail('The CUDA installer finished but no toolkit was found afterwards. Try the installer by hand: ' + file)
    const installed = findCudaRoot(series)
    if (!installed) fail('The CUDA Toolkit was installed but could not be found afterwards.')
    if (result.lacking.length > 0) {
      // Keep the installer: it is the way to repair this by hand.
      note(`Warning: CUDA ${installed.version ?? want} at ${installed.root} still lacks ${result.lacking.join(', ')}. The build will probably fail. The installer was kept at ${file}.`)
      return { ok: true, root: installed.root, changed: true }
    }
    // The installer stays until a build with this toolkit has succeeded, so that
    // a repair after a build that still fails does not download 4 GB again.
    note(`CUDA ${installed.version ?? want} is installed at ${installed.root}`)
    return { ok: true, root: installed.root, changed: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: hooks.signal.aborted ? 'Cancelled' : message }
  }
}

// Removes the downloaded installers (and half-downloaded ones) once a build has
// shown the toolkit works. They are several GB each.
export async function removeCudaInstallers(rootDir: string): Promise<void> {
  const dir = join(rootDir, '.sdk', 'cuda')
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) if (/^cuda_.*_windows_x86_64\.exe(\.part)?$/.test(n)) await fsPromises.rm(join(dir, n), { force: true }).catch(() => {})
}

function compareDotted(a: string, b: string): number {
  const x = a.split('.').map(n => parseInt(n, 10) || 0)
  const y = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

// Whether winget offers a newer toolkit of the newest series than the one installed.
export async function cudaUpdateAvailable(wingetBin: string): Promise<boolean> {
  const current = findCudaRoot()
  if (!current?.version) return false
  const latest = await resolveCudaInstaller(undefined, { winget: wingetBin }).catch(() => null)
  return !!latest && compareDotted(latest.version, current.version) > 0
}

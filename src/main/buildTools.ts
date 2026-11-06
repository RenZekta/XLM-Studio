import { execFile } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { readdirSync, statSync } from 'fs'
import { run, fail } from './runLogged'
import { ensureToolEnv, onPath } from './toolEnv'
import { detectToolchain, invalidateToolchain, type BuildToolchain } from './sourceBuild'
import { installRocmSdk, findInstalledRocm, rocmUpdateAvailable, resolveRocmTarball, latestPipVersion, defaultHttp, type RocmChannel, type RocmHooks } from './rocmSdk'
import { rocmGpu, rocmOsFor, ROCM_PIP_INDEX, type RocmSdkSource } from '../shared/rocm'
import { findCudaRoot, missingCudaParts } from './cudaSdk'
import { installCudaToolkit, resolveCudaInstaller, cudaUpdateAvailable } from './cudaInstaller'
import {
  planTools, requiredToolsFor, isManagedTool, packageNames, describeCommand, TOOL_LABELS, WINGET_NOTHING_TO_DO,
  type ToolId, type PackageManager, type PlannedCommand
} from '../shared/buildTools'

// What the tools of a build depend on besides the machine: where the app keeps
// the SDKs it downloads, the GPU being built for, and which channel AMD's SDK
// comes from.
export interface ToolsContext {
  rootDir: string
  gpuTarget?: string
  rocmChannel: RocmChannel
  // How the ROCm SDK is obtained.
  rocmSource: RocmSdkSource
  // The CUDA Toolkit series a CUDA build needs ("12.4"); absent for the newest.
  cudaSeries?: string
}

// Installs and updates what a source build needs (git, CMake, a compiler and
// the GPU SDK) through the platform's package manager. The commands come from
// shared/buildTools.ts; this runs them, asks for elevation where Linux needs
// it, and makes the new tools visible to the running app.

// winget is an app execution alias on Windows, a placeholder file that Node
// cannot see with fs.existsSync even when `winget` runs in a terminal. So it is
// found by running it, in the PATH and then in the folder the aliases live in.
let wingetBin = 'winget'

export async function findWinget(fallbacks: string[] = defaultWingetFallbacks()): Promise<string | null> {
  for (const bin of ['winget', ...fallbacks]) {
    const r = await capture(bin, ['--version'], 10000)
    if (r.code === 0 && /\d/.test(r.stdout)) return bin
  }
  return null
}

function defaultWingetFallbacks(): string[] {
  const base = process.env.LOCALAPPDATA
  return base ? [join(base, 'Microsoft', 'WindowsApps', 'winget.exe')] : []
}

// App Installer (which provides winget) comes with Windows, and its registration
// for the user can go missing; registering the installed package again repairs it.
export const WINGET_REPAIR_COMMAND = 'Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'

export async function repairWinget(exec: typeof capture = capture): Promise<string> {
  const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINGET_REPAIR_COMMAND], 120000)
  return r.code === 0 ? 'App Installer was registered again.' : `Registering App Installer again failed (exit code ${r.code}). ${r.stdout.trim().slice(0, 300)}`.trim()
}

export interface WingetDeps {
  find: () => Promise<string | null>
  repair: () => Promise<string>
  refreshEnv: () => Promise<void>
}

// What was tried for winget this run, so it is attempted once and can be reported.
export const wingetState = { repairAttempted: false, note: '' }

// Finds winget; when it cannot be found even with a fresh environment, tries
// the repair (once) and looks again.
export async function resolveWinget(deps: WingetDeps, state = wingetState): Promise<string | null> {
  let bin = await deps.find()
  if (bin) return bin
  // The environment the app started with may predate a repair of PATH.
  await deps.refreshEnv()
  bin = await deps.find()
  if (bin) return bin
  if (state.repairAttempted) return null
  state.repairAttempted = true
  state.note = await deps.repair()
  await deps.refreshEnv()
  bin = await deps.find()
  return bin
}

let managerCache: { at: number; value: Promise<PackageManager | null> } | null = null

// Forget what was learned about the machine, after something was installed.
export function invalidateBuildToolsCaches(): void {
  managerCache = null
  outdatedCache.clear()
  invalidateToolchain()
}

export function detectPackageManager(): Promise<PackageManager | null> {
  // A negative answer is not kept for long: winget may have just been repaired.
  if (!managerCache || Date.now() - managerCache.at > 60_000) {
    const value = probePackageManager()
    managerCache = { at: Date.now(), value }
    void value.then(v => { if (!v && managerCache?.value === value) managerCache.at = Date.now() - 55_000 })
  }
  return managerCache.value
}

async function probePackageManager(): Promise<PackageManager | null> {
  await ensureToolEnv()
  if (process.platform === 'win32') {
    const bin = await resolveWinget({ find: () => findWinget(), repair: () => repairWinget(), refreshEnv: () => ensureToolEnv(true) })
    if (!bin) return null
    wingetBin = bin
    return 'winget'
  }
  if (process.platform === 'darwin') return onPath('brew') ? 'brew' : null
  if (onPath('apt-get')) return 'apt'
  if (onPath('dnf')) return 'dnf'
  if (onPath('pacman')) return 'pacman'
  if (onPath('zypper')) return 'zypper'
  return null
}

export function toolPresent(tc: BuildToolchain, tool: ToolId, ctx?: ToolsContext): boolean {
  switch (tool) {
    case 'git': return tc.git
    case 'cmake': return !!tc.cmake
    case 'compiler': return !!tc.compiler
    case 'ninja': return tc.ninja
    case 'python': return tc.python
    // A toolkit missing headers or libraries (a lean install) counts as absent,
    // so that installing the tools repairs it.
    case 'cuda': {
      if (!ctx) return tc.cuda
      const toolkit = findCudaRoot(ctx.cudaSeries)
      return !!toolkit && missingCudaParts(toolkit.root).length === 0
    }
    case 'vulkan': return tc.vulkan
    // Installed system-wide, or downloaded by the app for this GPU's family.
    case 'hip': {
      const family = ctx?.gpuTarget ? rocmGpu(ctx.gpuTarget)?.family : undefined
      return tc.hip || (!!ctx && !!findInstalledRocm(ctx.rootDir, family, ctx.rocmSource))
    }
  }
}

function capture(cmd: string, args: string[], timeoutMs = 60000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout || '') })
    })
  })
}

// Which of the installed tools have a newer version waiting in the package
// manager. Read-only and without elevation, so it is cheap to ask on every
// open of the Tracker; it sees what the package manager's own lists say, which
// is as fresh as its last refresh.
// The package manager's own lists can take seconds to read (winget especially),
// and the answer changes rarely, so it is kept for a while and shared by
// everyone asking at once.
const outdatedCache = new Map<string, { at: number; value: Promise<boolean> }>()

// Tools an update was already run for in this session. A package manager can
// list a tool as outdated and still have nothing it is able to install for it
// (pinned, installed some other way, or a newer version that needs another
// installer); offering the update again after it ran would only repeat it, and
// ask for administrator rights every time.
const updateAttempted = new Set<string>()

function attemptKey(tool: ToolId, pm: PackageManager | null, ctx: ToolsContext): string {
  if (tool === 'cuda') return `cuda|${ctx.cudaSeries ?? 'newest'}`
  if (isManagedTool(tool, process.platform)) {
    return `${tool}|${ctx.rootDir}|${ctx.gpuTarget ? rocmGpu(ctx.gpuTarget)?.family : ''}|${ctx.rocmSource}`
  }
  return `${tool}|${pm}`
}

function cachedCheck(key: string, check: () => Promise<boolean>): Promise<boolean> {
  const hit = outdatedCache.get(key)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.value
  const value = check().catch(() => false)
  outdatedCache.set(key, { at: Date.now(), value })
  return value
}

async function packageOutdated(pm: PackageManager, pkgs: string[]): Promise<boolean> {
  if (pm === 'winget') {
    const r = await capture(wingetBin, ['list', '--id', pkgs[0], '-e', '--upgrade-available', '--accept-source-agreements'])
    return r.code === 0 && r.stdout.toLowerCase().includes(pkgs[0].toLowerCase())
  }
  if (pm === 'apt') {
    // A simulated upgrade lists every package that would be replaced.
    const r = await capture('apt-get', ['-s', 'install', '--only-upgrade', ...pkgs])
    return /^Inst /m.test(r.stdout)
  }
  if (pm === 'dnf') return (await capture('dnf', ['check-update', '-q', ...pkgs])).code === 100
  if (pm === 'zypper') {
    const r = await capture('zypper', ['--non-interactive', 'list-updates'])
    return pkgs.some(p => new RegExp(`\\|\\s*${p}\\s*\\|`).test(r.stdout))
  }
  return (await capture('brew', ['outdated', '--quiet', ...pkgs])).stdout.trim().length > 0
}

export async function outdatedTools(tools: ToolId[], ctx: ToolsContext): Promise<ToolId[]> {
  const pm = await detectPackageManager()
  const result: ToolId[] = []
  for (const tool of tools) {
    if (tool === 'cuda' && isManagedTool(tool, process.platform)) {
      // A pinned series (12.4) is not moved to another one; the newest is
      // compared with what winget lists.
      if (ctx.cudaSeries || updateAttempted.has(attemptKey(tool, pm, ctx))) continue
      if (await cachedCheck('cuda|newest', () => cudaUpdateAvailable(wingetBin))) result.push(tool)
      continue
    }
    if (isManagedTool(tool, process.platform)) {
      const family = ctx.gpuTarget ? rocmGpu(ctx.gpuTarget)?.family : undefined
      const os = rocmOsFor(process.platform)
      if (!family || !os) continue
      if (updateAttempted.has(attemptKey(tool, pm, ctx))) continue
      const key = `${tool}|${ctx.rootDir}|${family}|${ctx.rocmSource}|${ctx.rocmChannel}`
      if (await cachedCheck(key, () => rocmUpdateAvailable(ctx.rootDir, family, ctx.rocmChannel, os, { source: ctx.rocmSource }))) result.push(tool)
      continue
    }
    if (!pm || pm === 'pacman') continue
    if (updateAttempted.has(attemptKey(tool, pm, ctx))) continue
    const pkgs = packageNames(tool, pm)
    if (!pkgs?.length) continue
    if (await cachedCheck(`${tool}|${pm}`, () => packageOutdated(pm, pkgs))) result.push(tool)
  }
  return result
}

// What a command needs to be run as: Linux package managers need root, which
// is asked for through polkit (a password dialog) or sudo without a prompt.
function withElevation(c: PlannedCommand): { cmd: string; args: string[] } | null {
  if (!c.elevate || process.platform === 'win32' || process.platform === 'darwin') return { cmd: c.cmd, args: c.args }
  if (process.getuid?.() === 0) return { cmd: c.cmd, args: c.args }
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
  if (hasDisplay && onPath('pkexec')) return { cmd: 'pkexec', args: [c.cmd, ...c.args] }
  if (onPath('sudo')) return { cmd: 'sudo', args: ['-n', c.cmd, ...c.args] }
  return null
}

// winget prints no progress when it is run from the app, and an installer can
// work for many minutes without printing anything. What shows which of the two
// is happening is the installer file winget downloads into the temp folder:
// growing means still downloading, finished means the installer is running.
export function wingetActivityReporter(tempDir: string = process.env.TEMP || tmpdir()): () => string | null {
  let lastSize = -1
  const newestFile = (dir: string, depth: number): { size: number } | null => {
    let best: { size: number; mtime: number } | null = null
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth > 0) {
          const inner = newestFile(p, depth - 1) as { size: number; mtime: number } | null
          if (inner && (!best || inner.mtime > best.mtime)) best = inner
        }
      } else {
        try {
          const st = statSync(p)
          if (Date.now() - st.mtimeMs < 6 * 3600_000 && (!best || st.mtimeMs > best.mtime)) best = { size: st.size, mtime: st.mtimeMs }
        } catch { /* gone already */ }
      }
    }
    return best
  }
  const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`
  return () => {
    const file = newestFile(join(tempDir, 'WinGet'), 3)
    if (!file) return null
    const grew = lastSize >= 0 && file.size > lastSize
    const text = lastSize < 0
      ? `winget's installer file is ${gb(file.size)} so far`
      : grew
        ? `winget's download is at ${gb(file.size)} (${((file.size - lastSize) / 1e6).toFixed(0)} MB more than at the last check)`
        : `winget's installer file is ${gb(file.size)} and no longer growing: the download is finished, so the installer itself is running or waiting for you (look for an administrator prompt in the taskbar)`
    lastSize = file.size
    return text
  }
}

export interface InstallOutcome {
  ok: boolean
  error?: string
  // Needs something no package manager here can install.
  manual: { tool: ToolId; reason: string }[]
}

// Installs missing tools, or updates installed ones, and refreshes the
// environment so the build sees them without restarting the app.
export async function installBuildTools(tools: ToolId[], mode: 'install' | 'update', hooks: RocmHooks, ctx: ToolsContext): Promise<InstallOutcome> {
  const pm = await detectPackageManager()
  if (!pm && process.platform === 'win32' && wingetState.note) hooks.log(`winget was not found. ${wingetState.note}`, true)
  const plan = planTools(tools, mode, process.platform, pm)
  for (const s of plan.skipped) hooks.log(`${TOOL_LABELS[s.tool]}: ${s.reason}`, true)
  if (mode === 'install' && plan.manual.length) {
    for (const m of plan.manual) hooks.log(`${TOOL_LABELS[m.tool]} must be installed by hand. ${m.reason}`, true)
    return { ok: false, error: `${plan.manual.map(m => TOOL_LABELS[m.tool]).join(', ')} cannot be installed automatically.`, manual: plan.manual }
  }
  try {
    for (const c of plan.commands) {
      const elevated = withElevation(c)
      const real = elevated && elevated.cmd === 'winget' ? { ...elevated, cmd: wingetBin } : elevated
      if (!real) {
        fail(`Administrator rights are needed and no way to ask for them was found. Run this yourself, then build again:\n${describeCommand(c)}`)
      }
      hooks.log(`${mode === 'install' ? 'Installing' : 'Updating'} with ${c.cmd === 'sh' ? pm : c.cmd}. This can take several minutes.`, true)
      const viaWinget = c.cmd === 'winget'
      if (viaWinget) hooks.log('winget shows no progress when it runs from the app; this log says what it is doing every 30 seconds while it is quiet.', true)
      const code = await run(real.cmd, real.args, hooks, { heartbeat: { everyMs: 30_000, describe: viaWinget ? wingetActivityReporter() : undefined } })
      if (code === null) fail('Cancelled')
      const nothingToDo = process.platform === 'win32' && WINGET_NOTHING_TO_DO.has(code)
      if (code !== 0 && !nothingToDo) {
        const hint = real.cmd === 'pkexec' && (code === 126 || code === 127) ? ' The password dialog was dismissed or refused.' : ''
        fail(`The package manager failed (exit code ${code}).${hint} Run this yourself to see why:\n${describeCommand(c)}`)
      }
    }
    if (plan.managed.includes('cuda')) {
      const res = await installCudaToolkit({ rootDir: ctx.rootDir, series: ctx.cudaSeries, winget: wingetBin }, hooks)
      if (!res.ok) fail(res.error)
    }
    if (plan.managed.includes('hip')) {
      if (process.env.HIP_PATH) {
        hooks.log(`HIP_PATH (${process.env.HIP_PATH}) has no HIP CMake package and compiler a build could use, so the ROCm SDK is installed separately.`, true)
      }
      const gpu = ctx.gpuTarget ? rocmGpu(ctx.gpuTarget) : undefined
      const os = rocmOsFor(process.platform)
      if (!gpu || !os) fail('Choose your GPU first: the ROCm SDK is downloaded for a specific GPU family.')
      const res = await installRocmSdk({ rootDir: ctx.rootDir, family: gpu.family, channel: ctx.rocmChannel, os, source: ctx.rocmSource, gfx: gpu.gfx }, hooks)
      if (!res.ok) fail(res.error)
    }
    await ensureToolEnv(true)
    invalidateBuildToolsCaches()
    if (mode === 'update') for (const tool of tools) updateAttempted.add(attemptKey(tool, pm, ctx))
    return { ok: true, manual: plan.manual }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), manual: plan.manual }
  }
}

export interface ToolStatus {
  id: ToolId
  label: string
  present: boolean
  // The app can install it: a package manager here has it, or the app
  // downloads it itself.
  installable: boolean
  reason?: string
  outdated: boolean
  // What installing involves, for the confirmation (a download size).
  detail?: string
  // Cannot be installed until a GPU is chosen.
  needsGpu?: boolean
}

export interface ToolsPlanStatus {
  manager: PackageManager | null
  tools: ToolStatus[]
}

// State of every tool a build of this type needs.
export async function buildToolsStatus(type: string, ctx: ToolsContext): Promise<ToolsPlanStatus> {
  const [tc, manager] = await Promise.all([detectToolchain(), detectPackageManager()])
  const required = requiredToolsFor(type, process.platform, ctx.rocmSource)
  const present = (t: ToolId) => toolPresent(tc, t, ctx)
  const missing = required.filter(t => !present(t))
  const wingetNote = !manager && process.platform === 'win32' && wingetState.note ? ` ${wingetState.note}` : ''
  const manual = new Map(planTools(missing, 'install', process.platform, manager).manual.map(m => [m.tool, `${m.reason}${wingetNote}`]))
  const outdated = new Set(await outdatedTools(required.filter(present), ctx))
  const status: ToolStatus[] = []
  for (const id of required) {
    const entry: ToolStatus = { id, label: TOOL_LABELS[id], present: present(id), installable: !manual.has(id), reason: manual.get(id), outdated: outdated.has(id) }
    if (!entry.present && id === 'cuda' && process.platform !== 'win32' && ctx.cudaSeries) {
      // The distribution's package is whatever version it ships; a specific one comes from NVIDIA.
      entry.installable = false
      entry.reason = `CUDA ${ctx.cudaSeries} is not in your distribution's packages. Install it from https://developer.nvidia.com/cuda-toolkit-archive (a runfile or NVIDIA's repository) and build again.`
    } else if (!entry.present && id === 'cuda' && isManagedTool(id, process.platform)) {
      const found = await resolveCudaInstaller(ctx.cudaSeries, { winget: wingetBin }).catch(() => null)
      entry.detail = found ? `NVIDIA CUDA Toolkit ${found.version}, a download of several GB` : 'winget could not be asked for the CUDA installer just now'
      const installed = findCudaRoot(ctx.cudaSeries)
      const lacking = installed ? missingCudaParts(installed.root) : []
      if (installed && lacking.length > 0) entry.detail = `${entry.detail}. The toolkit at ${installed.root} is incomplete (missing ${lacking.join(', ')}) and would be repaired`
    } else if (!entry.present && isManagedTool(id, process.platform)) {
      const gpu = ctx.gpuTarget ? rocmGpu(ctx.gpuTarget) : undefined
      const os = rocmOsFor(process.platform)
      if (!gpu || !os) {
        entry.needsGpu = true
      } else {
        if (ctx.rocmSource === 'pip') {
          const version = await latestPipVersion(defaultHttp, ROCM_PIP_INDEX).catch(() => null)
          entry.detail = version ? `AMD ROCm SDK ${version} (pip, stable), a multi-GB download` : 'AMD\'s Python index could not be reached just now'
        } else {
          const found = await resolveRocmTarball(ctx.rocmChannel, os, gpu.family).catch(() => null)
          entry.detail = found
            ? `AMD ROCm SDK ${found.tarball.version} (${found.channel})${found.size ? `, a ${(found.size / 1e9).toFixed(1)} GB download` : ''}`
            : 'AMD\'s download site could not be reached just now'
        }
      }
    }
    status.push(entry)
  }
  return { manager, tools: status }
}

// Before a build: installs what is missing (when allowed) and updates what has
// a newer version (when allowed). Resolves to an error message when the build
// cannot go on.
export async function prepareBuildTools(
  type: string, opts: { install: boolean; update: boolean }, hooks: RocmHooks, ctx: ToolsContext
): Promise<string | null> {
  const status = await buildToolsStatus(type, ctx)
  const missing = status.tools.filter(t => !t.present)
  if (missing.length && opts.install) {
    const res = await installBuildTools(missing.map(t => t.id), 'install', hooks, ctx)
    if (!res.ok) return res.error ?? 'Installing the build tools failed.'
  }
  if (opts.update) {
    const stale = status.tools.filter(t => t.present && t.outdated).map(t => t.id)
    if (stale.length) {
      hooks.log(`Newer versions are available for: ${stale.map(t => TOOL_LABELS[t]).join(', ')}`, true)
      const res = await installBuildTools(stale, 'update', hooks, ctx)
      // A failed update does not stop a build the installed tools can do.
      if (!res.ok) hooks.log(`Updating the build tools failed, building with what is installed. ${res.error ?? ''}`, true)
    }
  }
  return null
}

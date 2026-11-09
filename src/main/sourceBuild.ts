import { execFile, type ChildProcess } from 'child_process'
import { delimiter } from 'path'
import { existsSync, readFileSync, readdirSync, promises as fsPromises } from 'fs'
import { cpus } from 'os'
import { join } from 'path'
import { git, githubCloneUrl, gitVersionLabel, readHeadCommit, updateGitEngine } from './strataEngine'
import { run, runOrFail, fail } from './runLogged'
import { ensureToolEnv } from './toolEnv'
import { rocmToolchain, rocmRuntimeEnv, findInstalledRocm, findPython, systemHipRoot, type RocmToolchain } from './rocmSdk'
import { rocmGpu } from '../shared/rocm'
import { isCudaType, cudaTypeVersion } from '../shared/sourceBuild'
import { systemCudaRoot, findCudaRoot, missingCudaParts, describeCudaToolkit, cudaToolchain, cudaGeneratorArgs, cudaRuntimeEnv } from './cudaSdk'
import { removeCudaInstallers } from './cudaInstaller'
import { workDirs } from './workDirs'
import { dirname, relative } from 'path'
import { NATIVE_PLATFORM, BACKEND_TYPE_MARKER, platformOfBuildDir, installVersionName } from './buildPlatform'
import { parseLsRemote, parseBuildProgress, sourceBuildType, sourceVersionName, isReleaseTag, releaseBaseOf } from '../shared/sourceBuild'
import { compareBackendVersions } from '../shared/backendVersion'
import type { SourceBuild, InstalledBuildKinds } from '../shared/types'

// Compiles an engine repository on this machine. Everything here is plain Node
// so it can run without Electron: the caller supplies logging, progress and
// the means to kill a process tree.
//
// Layout, per tracked repo folder:
//   <repo>/.work/<os>/source/        the clone
//   <repo>/.work/<os>/build/<type>/  CMake build tree (kept so a rebuild is incremental)
//   <repo>/<type>/<version>/         the installed build, same shape as a release
// The clone and the build trees are kept per OS (see workDirs.ts, which also
// says where folders from before that live). Dot folders are ignored when
// installed engines are listed.

export { SOURCE_DIRNAME, BUILD_DIRNAME, WORK_DIRNAME, workDirs, cloneOsOf } from './workDirs'
// Written into an installed build's folder. It tells a compiled build from a
// downloaded one in the same type folder and records what it was built from.
export const SOURCE_MARKER = '.xlm-source.json'

export interface SourceMarker {
  repo: string
  branch: string | null
  commit: string
  type: string
  extraArgs: string[]
  gpuTarget?: string
  // The ROCm SDK the build was compiled against, whose libraries it needs to run.
  rocmRoot?: string
  // The CUDA Toolkit a CUDA build was compiled against.
  cudaRoot?: string
  builtAt: number
}

export function readSourceMarker(versionDir: string): SourceMarker | null {
  try {
    const raw = JSON.parse(readFileSync(join(versionDir, SOURCE_MARKER), 'utf8'))
    return raw && typeof raw.commit === 'string' ? raw as SourceMarker : null
  } catch {
    return null
  }
}

// The environment a compiled engine needs to start: for a ROCm build made with
// an SDK the app downloaded, that SDK's libraries. undefined when it needs
// nothing beyond the ordinary environment. `versionDir` is the folder with
// the executable, <engines>/<repo>/<type>/<version>.
export function engineRuntimeEnv(versionDir: string): NodeJS.ProcessEnv | undefined {
  const marker = readSourceMarker(versionDir)
  if (marker && isCudaType(marker.type)) {
    const cuda = [marker.cudaRoot, findCudaRoot(cudaTypeVersion(marker.type))?.root, systemCudaRoot()].find(r => !!r && existsSync(r))
    return cuda ? { ...process.env, ...cudaRuntimeEnv(cuda, process.platform) } : undefined
  }
  if (marker?.type !== 'rocm') return undefined
  const family = marker.gpuTarget ? rocmGpu(marker.gpuTarget)?.family : undefined
  // The SDK it was built against, if that folder is still there; else the one
  // the app downloaded for the GPU's family; else one installed outside the app
  // (also for a build made before the SDK was recorded). Without any of these
  // a system ROCm is assumed to be on the PATH already.
  const root = [
    marker.rocmRoot,
    family ? findInstalledRocm(dirname(dirname(dirname(versionDir))), family)?.root : undefined,
    systemHipRoot()
  ].find(r => !!r && existsSync(r))
  return root ? { ...process.env, ...rocmRuntimeEnv(root, process.platform) } : undefined
}

export function isSourceBuildDir(dir: string): boolean {
  return existsSync(join(dir, SOURCE_MARKER))
}

// --------------------------------------------------------------------------
// Remote state
// --------------------------------------------------------------------------

export async function repoBranches(slug: string): Promise<{ defaultBranch: string | null; heads: string[] } | null> {
  const url = githubCloneUrl(slug)
  if (!url) return null
  const r = await git(['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*'], undefined, { timeoutMs: 30000, httpsOnly: true })
  if (!r.ok) return null
  const parsed = parseLsRemote(r.stdout)
  return { defaultBranch: parsed.defaultBranch, heads: parsed.heads }
}

// The commit the followed branch (or the default branch) points at on GitHub,
// and the name of that branch.
export async function remoteBranchCommit(slug: string, branch?: string): Promise<{ commit: string | null; branch: string | null; error?: string }> {
  const url = githubCloneUrl(slug)
  if (!url) return { commit: null, branch: null, error: `Not a GitHub repository: ${slug}` }
  const args = branch ? ['ls-remote', url, `refs/heads/${branch}`] : ['ls-remote', '--symref', url, 'HEAD']
  const r = await git(args, undefined, { timeoutMs: 30000, httpsOnly: true })
  if (!r.ok) return { commit: null, branch: branch ?? null, error: r.stderr || 'git ls-remote failed' }
  if (branch) {
    const commit = r.stdout.split('\n')[0]?.split(/\s+/)[0]
    return commit ? { commit, branch } : { commit: null, branch, error: `Branch "${branch}" was not found.` }
  }
  const parsed = parseLsRemote(r.stdout)
  return parsed.headCommit
    ? { commit: parsed.headCommit, branch: parsed.defaultBranch }
    : { commit: null, branch: null, error: 'The repository has no commits.' }
}

// Compiled builds of one repo folder for this OS, newest per type.
export function scanSourceBuilds(rootDirs: string[], folderName: string, remoteCommit: string | null): SourceBuild[] {
  const newest = new Map<string, { build: SourceBuild; builtAt: number }>()
  for (const root of rootDirs) {
    const forkDir = join(root, folderName)
    let types: import('fs').Dirent[]
    try { types = readdirSync(forkDir, { withFileTypes: true }) } catch { continue }
    for (const t of types) {
      const typeDir = join(forkDir, t.name)
      if (!t.isDirectory() || t.name.startsWith('.') || !existsSync(join(typeDir, BACKEND_TYPE_MARKER))) continue
      let versions: import('fs').Dirent[]
      try { versions = readdirSync(typeDir, { withFileTypes: true }) } catch { continue }
      for (const v of versions) {
        const versionDir = join(typeDir, v.name)
        if (!v.isDirectory() || v.name.startsWith('.')) continue
        const marker = readSourceMarker(versionDir)
        if (!marker || platformOfBuildDir(versionDir) !== NATIVE_PLATFORM) continue
        const prev = newest.get(t.name)
        if (prev && prev.builtAt >= marker.builtAt) continue
        newest.set(t.name, {
          builtAt: marker.builtAt,
          build: { type: t.name, version: v.name, commit: marker.commit, args: marker.extraArgs ?? [], gpuTarget: marker.gpuTarget, outdated: !!remoteCommit && marker.commit !== remoteCommit }
        })
      }
    }
  }
  return [...newest.values()].map(e => e.build)
}

// Which kinds of build of one repo folder are installed for this OS: compiled
// ones and downloaded releases.
export function installedBuildKinds(rootDirs: string[], folderName: string): InstalledBuildKinds {
  const kinds: InstalledBuildKinds = { binary: false, source: false }
  for (const root of rootDirs) {
    const forkDir = join(root, folderName)
    let types: import('fs').Dirent[]
    try { types = readdirSync(forkDir, { withFileTypes: true }) } catch { continue }
    for (const t of types) {
      const typeDir = join(forkDir, t.name)
      if (!t.isDirectory() || t.name.startsWith('.') || !existsSync(join(typeDir, BACKEND_TYPE_MARKER))) continue
      let versions: import('fs').Dirent[]
      try { versions = readdirSync(typeDir, { withFileTypes: true }) } catch { continue }
      for (const v of versions) {
        const versionDir = join(typeDir, v.name)
        if (!v.isDirectory() || v.name.startsWith('.') || platformOfBuildDir(versionDir) !== NATIVE_PLATFORM) continue
        if (isSourceBuildDir(versionDir)) kinds.source = true
        else kinds.binary = true
      }
    }
  }
  return kinds
}

// What a compiled build supersedes, per backend type folder: older compiled
// builds, and downloaded releases that are not newer than the release the build
// is made from. Runs after every build and whenever the tracker checks the
// engine, so a download that was already there (or arrived from an older version
// of the app) does not linger beside a build that replaces it.
//
// Which release a build stands for is worked out from its commit, as well as
// from its folder name: builds made by older versions of the app can carry a
// name that does not read as a version ("dev-latest-src", a bare hash) or names
// an older tag than the build really is. Whichever of the two says newer counts.
// `explain` also reports what is kept and why, for the build log; removals and
// failures to remove are always reported.
export async function pruneSupersededBuilds(rootDirs: string[], folderName: string, note?: (line: string) => void, explain = false): Promise<void> {
  for (const root of rootDirs) {
    const forkDir = join(root, folderName)
    const srcDir = workDirs(forkDir).source
    let types: import('fs').Dirent[]
    try { types = readdirSync(forkDir, { withFileTypes: true }) } catch { continue }
    for (const t of types) {
      const typeDir = join(forkDir, t.name)
      if (!t.isDirectory() || t.name.startsWith('.') || !existsSync(join(typeDir, BACKEND_TYPE_MARKER))) continue
      let versions: import('fs').Dirent[]
      try { versions = readdirSync(typeDir, { withFileTypes: true }) } catch { continue }
      const native = versions.filter(v => v.isDirectory() && !v.name.startsWith('.') && platformOfBuildDir(join(typeDir, v.name)) === NATIVE_PLATFORM)
      const built = native.flatMap(v => { const m = readSourceMarker(join(typeDir, v.name)); return m ? [{ name: v.name, builtAt: m.builtAt, commit: m.commit }] : [] })
      if (!built.length) continue
      const newest = built.reduce((a, b) => (b.builtAt > a.builtAt ? b : a))

      let effective: string | null | undefined
      const effectiveRelease = async (): Promise<string | null> => {
        if (effective !== undefined) return effective
        const found = [releaseBaseOf(newest.name)]
        if (existsSync(srcDir)) found.push(releaseBaseOf(await sourceVersionLabel(srcDir, newest.commit)))
        effective = found.filter((x): x is string => !!x).sort((a, b) => compareBackendVersions(b, a))[0] ?? null
        return effective
      }

      for (const v of native) {
        if (v.name === newest.name) continue
        const compiled = built.some(b => b.name === v.name)
        let reason: string | null = null
        if (compiled) {
          reason = 'an older build'
        } else {
          const release = releaseBaseOf(v.name)
          if (!release) { if (explain) note?.(`Kept ${t.name}/${v.name}: its name does not read as a version.`); continue }
          const made = await effectiveRelease()
          if (!made) { if (explain) note?.(`Kept the download ${t.name}/${v.name}: the release this build stands for could not be worked out.`); continue }
          if (compareBackendVersions(release, made) > 0) { if (explain) note?.(`Kept the download ${t.name}/${v.name}: it is newer than this build (${made}).`); continue }
          reason = `the download of ${release}, which this build (${made}) replaces`
        }
        try {
          await fsPromises.rm(join(typeDir, v.name), { recursive: true, force: true })
          note?.(`Removed ${t.name}/${v.name}: ${reason}.`)
        } catch (err) {
          note?.(`Could not remove ${t.name}/${v.name} (${String((err as Error).message || err).split('\n')[0]}). Stop anything running from it and delete the folder by hand.`)
        }
      }
    }
  }
}

// --------------------------------------------------------------------------
// Toolchain
// --------------------------------------------------------------------------

export interface BuildToolchain {
  git: boolean
  cmake: string | null
  compiler: string | null
  ninja: boolean
  python: boolean
  cuda: boolean
  vulkan: boolean
  // What a Linux machine still lacks for the Vulkan backend beyond glslc (see linuxVulkanGaps).
  vulkanGaps: string[]
  // A ROCm/HIP SDK installed outside the app that a build can use (it has
  // HIP's CMake package and a compiler), and where it is.
  hip: boolean
  hipRoot: string | null
}

// What a Linux machine lacks to build the Vulkan backend. Besides the shader
// compiler (glslc) the build wants the Vulkan headers and the CMake package of
// the SPIR-V headers (ggml-vulkan calls find_package(SPIRV-Headers CONFIG)),
// which distributions ship in packages of their own (spirv-headers-devel on
// Fedora, spirv-headers on Debian, Ubuntu, Arch and openSUSE). The LunarG SDK
// (VULKAN_SDK) brings all of it. `exists` is replaceable for tests.
export function linuxVulkanGaps(hasGlslc: boolean, exists: (path: string) => boolean = existsSync, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.VULKAN_SDK) return []
  const prefixes = ['/usr', '/usr/local', ...(env.CMAKE_PREFIX_PATH ?? '').split(delimiter).filter(Boolean)]
  const libs = ['share/cmake', 'lib/cmake', 'lib64/cmake', 'lib/x86_64-linux-gnu/cmake', 'lib/aarch64-linux-gnu/cmake']
  const configs = ['SPIRV-Headers/SPIRV-HeadersConfig.cmake', 'spirv-headers/spirv-headers-config.cmake']
  const gaps: string[] = []
  if (!hasGlslc) gaps.push('the shader compiler (glslc)')
  if (!prefixes.some(p => exists(join(p, 'include', 'vulkan', 'vulkan.h')))) gaps.push('the Vulkan headers')
  if (!prefixes.some(p => libs.some(l => configs.some(c => exists(join(p, l, c)))))) gaps.push('the SPIR-V headers')
  return gaps
}

// The line of advice for a configure failure that names a missing package.
export function configureHint(line: string): string | null {
  if (/provided by "SPIRV-Headers"/.test(line)) return 'The SPIR-V headers are missing. Install spirv-headers-devel (Fedora) or spirv-headers (Debian, Ubuntu, Arch, openSUSE), then build again.'
  if (/Could NOT find Vulkan|Could not find a package configuration file provided by "Vulkan"/i.test(line)) return 'The Vulkan development files are missing. Install libvulkan-dev (Debian, Ubuntu) or vulkan-loader-devel (Fedora), then build again.'
  return null
}

function probe(cmd: string, args: string[]): Promise<string | null> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve(null)
      resolve(String(stdout || stderr || '').split('\n')[0].trim() || cmd)
    })
  })
}

async function detectCompiler(): Promise<string | null> {
  if (process.platform === 'win32') {
    // CMake finds Visual Studio on its own, so ask the installer for it
    // instead of requiring cl.exe on PATH (a Developer Prompt).
    const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    if (existsSync(vswhere)) {
      const vs = await probe(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'displayName'])
      if (vs) return vs
    }
    return (await probe('clang', ['--version'])) ?? (await probe('g++', ['--version']))
  }
  for (const cc of ['c++', 'g++', 'clang++']) {
    const v = await probe(cc, ['--version'])
    if (v) return v
  }
  return null
}

// Looking for the tools starts a dozen programs, which on Windows is slow
// enough to stall the app when several cards ask at once. So the answer is
// shared by everyone asking at the same time and reused briefly.
let toolchainCache: { at: number; value: Promise<BuildToolchain> } | null = null

export function invalidateToolchain(): void {
  toolchainCache = null
  // Visual Studio may have just been installed.
  vsEnvCache = null
}

export function detectToolchain(): Promise<BuildToolchain> {
  if (!toolchainCache || Date.now() - toolchainCache.at > 30_000) toolchainCache = { at: Date.now(), value: probeToolchain() }
  return toolchainCache.value
}

async function probeToolchain(): Promise<BuildToolchain> {
  await ensureToolEnv()
  const [gitOk, cmake, compiler, ninja, python, nvcc, glslc] = await Promise.all([
    git(['--version'], undefined, { timeoutMs: 8000 }).then(r => r.ok),
    probe('cmake', ['--version']),
    detectCompiler(),
    probe('ninja', ['--version']),
    findPython(),
    probe('nvcc', ['--version']),
    probe('glslc', ['--version'])
  ])
  const hipRoot = systemHipRoot()
  const vulkanGaps = process.platform === 'linux' ? linuxVulkanGaps(!!glslc) : []
  return {
    git: gitOk,
    cmake,
    compiler,
    ninja: !!ninja,
    python: !!python,
    cuda: !!nvcc || !!systemCudaRoot(),
    vulkan: process.platform === 'linux' ? vulkanGaps.length === 0 : !!glslc || !!process.env.VULKAN_SDK,
    vulkanGaps,
    hip: !!hipRoot,
    hipRoot
  }
}

// --------------------------------------------------------------------------
// Building
// --------------------------------------------------------------------------

export type BuildPhase = 'tools' | 'cloning' | 'updating' | 'configuring' | 'building' | 'installing'

export interface SourceBuildJob {
  repo: string
  // Absent means the repo's default branch.
  branch?: string
  folderName: string
  type: string
  extraArgs: string[]
  // ROCm builds: the GPU target to compile for (e.g. gfx1100) and, when the
  // app downloaded the SDK, where it is. Without a root the system's ROCm is used.
  gpuTarget?: string
  rocmRoot?: string
  // CUDA builds: the toolkit to compile with (one of several can be installed).
  cudaRoot?: string
  // Pull the branch before building (the default). False builds the source as
  // it is checked out, for a rebuild after changing options or the SDK.
  pull?: boolean
  // The main engines folder the build is installed into.
  rootDir: string
}

export interface SourceBuildHooks {
  // app: a message of the build itself rather than output of a tool.
  log: (line: string, app?: boolean) => void
  progress: (phase: BuildPhase, percent: number) => void
  killTree: (proc: ChildProcess) => Promise<void>
  signal: AbortSignal
}

export type SourceBuildResult =
  | { ok: true; versionDir: string; version: string; commit: string }
  | { ok: false; error: string; cancelled?: boolean }

// Where the compiled binaries ended up: a single-config generator writes to
// bin/, Visual Studio to bin/Release/.
function findBinDir(buildDir: string): string | null {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  for (const c of [join(buildDir, 'bin', 'Release'), join(buildDir, 'bin')]) {
    if (existsSync(join(c, exe))) return c
  }
  const walk = (dir: string, depth: number): string | null => {
    let entries: import('fs').Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
    if (entries.some(e => e.isFile() && e.name === exe)) return dir
    if (depth === 0) return null
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'CMakeFiles') continue
      const hit = walk(join(dir, e.name), depth - 1)
      if (hit) return hit
    }
    return null
  }
  return walk(buildDir, 4)
}

// --------------------------------------------------------------------------
// The Visual Studio environment
// --------------------------------------------------------------------------

// KEY=VALUE lines of `set`, as a map. Lines such as "=C:=C:\\" are drive state
// of the command prompt, not variables.
export function parseSetOutput(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^=\s][^=]*)=(.*)$/.exec(line)
    if (m) env[m[1]] = m[2]
  }
  return env
}

// What a build that is not generated by Visual Studio itself (Ninja with clang)
// is run in: the Visual Studio environment, which provides the Windows SDK
// tools (rc.exe), headers and import libraries, with the SDK's own folders in
// front of its PATH.
export function mergeBuildEnv(vs: Record<string, string>, toolchain: RocmToolchain): Record<string, string> {
  const pathKeyOf = (o: Record<string, string | undefined>) => Object.keys(o).find(k => k.toLowerCase() === 'path')
  const out: Record<string, string> = { ...vs }
  for (const [k, v] of Object.entries(toolchain.env)) if (k.toLowerCase() !== 'path') out[k] = v
  const key = pathKeyOf(vs) ?? 'PATH'
  out[key] = [...toolchain.pathDirs, vs[key] ?? ''].filter(Boolean).join(delimiter)
  return out
}

let vsEnvCache: Promise<Record<string, string> | null> | null = null

// The environment of a Visual Studio developer prompt (vcvars64.bat), read once
// per run of the app; null when Visual Studio with the C++ tools is not there.
export function windowsBuildEnv(): Promise<Record<string, string> | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  if (!vsEnvCache) vsEnvCache = loadVisualStudioEnv().catch(() => null)
  return vsEnvCache
}

async function loadVisualStudioEnv(): Promise<Record<string, string> | null> {
  const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  const dir = await probe(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'])
  const bat = dir ? join(dir, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat') : null
  if (!bat || !existsSync(bat)) return null
  return new Promise(resolve => {
    // cmd needs the whole command line quoted once more when the path has spaces.
    execFile('cmd.exe', ['/d', '/s', '/c', `""${bat}" >nul 2>&1 && set"`], { windowsVerbatimArguments: true, timeout: 60000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const env = err ? {} : parseSetOutput(String(stdout))
      resolve(Object.keys(env).some(k => k.toLowerCase() === 'include') ? env : null)
    })
  })
}

// The generator a build folder was first configured with, if it has been.
export function cachedGenerator(buildDir: string): string | null {
  try {
    return /^CMAKE_GENERATOR:INTERNAL=(.+)$/m.exec(readFileSync(join(buildDir, 'CMakeCache.txt'), 'utf8'))?.[1].trim() ?? null
  } catch {
    return null
  }
}

// --------------------------------------------------------------------------
// CMake sub-builds that outlive the CMake that made them
// --------------------------------------------------------------------------
// Some projects build a helper with ExternalProject (llama.cpp's Vulkan backend
// builds "vulkan-shaders-gen" this way). The helper has a build folder of its
// own, <build>/.../<name>-prefix/src/<name>-build, with its own CMakeCache.txt
// that records where CMake lived. When CMake is updated and the old version
// removed, that folder points at modules that are gone: "File C:/Program
// Files/CMake/share/cmake-4.3/Modules/CMakeSystem.cmake.in does not exist".
// The main build folder copes, so only those sub-builds are thrown away (they
// are small and rebuild in seconds), not the whole tree, which is the slow part.

// ExternalProject folders (<name>-prefix with a src folder) under a build tree.
function externalProjectPrefixes(dir: string, depth = 0, found: string[] = []): string[] {
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return found }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === 'CMakeFiles' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.name.endsWith('-prefix') && existsSync(join(p, 'src'))) found.push(p)
    else if (depth < 6) externalProjectPrefixes(p, depth + 1, found)
  }
  return found
}

function cacheValue(text: string, key: string): string | null {
  return new RegExp(`^${key}:[A-Z]+=(.*)$`, 'm').exec(text)?.[1].trim() ?? null
}

// The caches of the sub-builds in one ExternalProject folder.
function subbuildCaches(prefix: string): string[] {
  const out: string[] = []
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(join(prefix, 'src'), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const cache = join(prefix, 'src', e.name, 'CMakeCache.txt')
    if (e.isDirectory() && existsSync(cache)) out.push(cache)
  }
  return out
}

// "cmake version 4.4.0" -> "4.4".
export function cmakeMajorMinor(versionLine: string | null | undefined): string | null {
  const m = versionLine ? /(\d+)\.(\d+)/.exec(versionLine) : null
  return m ? `${m[1]}.${m[2]}` : null
}

// ExternalProject folders under a build tree whose cache was made by a CMake
// that is no longer there (its modules or executable are gone) or by another
// major.minor version than `cmakeVersion` (the one about to run), if known.
export function findStaleCmakeSubbuilds(buildDir: string, cmakeVersion: string | null): string[] {
  return externalProjectPrefixes(buildDir).filter(prefix => subbuildCaches(prefix).some(cache => {
    let text: string
    try { text = readFileSync(cache, 'utf8') } catch { return false }
    const root = cacheValue(text, 'CMAKE_ROOT')
    const command = cacheValue(text, 'CMAKE_COMMAND')
    if ((root && !existsSync(root)) || (command && !existsSync(command))) return true
    const major = cacheValue(text, 'CMAKE_CACHE_MAJOR_VERSION')
    const minor = cacheValue(text, 'CMAKE_CACHE_MINOR_VERSION')
    return !!cmakeVersion && !!major && !!minor && `${major}.${minor}` !== cmakeVersion
  }))
}

// Removes the given ExternalProject folders, or every one under the tree.
// Returns what was removed.
export async function removeCmakeSubbuilds(buildDir: string, which?: string[]): Promise<string[]> {
  const removed: string[] = []
  for (const prefix of which ?? externalProjectPrefixes(buildDir)) {
    try { await fsPromises.rm(prefix, { recursive: true, force: true }); removed.push(prefix) } catch { /* in use; left */ }
  }
  return removed
}

// Output that means CMake's remembered state, not the code, is what is wrong:
// it cannot regenerate the build files, or reads modules from a place that no
// longer exists. Compile errors never read like this.
export function isStaleCmakeLine(line: string): boolean {
  return /Build files cannot be regenerated correctly/i.test(line)
    || /CMake Error\b.*Modules[\\/].*\.cmake(?:\.in)?\b.*does not exist/i.test(line)
    || /include could not find requested file/i.test(line)
    || /CMakeCache\.txt directory .* is different than the directory/i.test(line)
    || /does not match the generator used previously/i.test(line)
}

// The generator the arguments ask for (-G name or -Gname), if any.
export function requestedGenerator(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-G') return args[i + 1] ?? null
    if (args[i].startsWith('-G')) return args[i].slice(2)
  }
  return null
}

// The version a build is called: the release tag of the commit built. A repo can
// carry moving tags ("dev-latest", "nightly") or CI tags on its newest commit;
// those say nothing about the version, so only tags that read as a release
// count (see isReleaseTag).
//
// Failing a release tag on the commit itself, the nearest release is named with
// the commit's short hash ("b9584-g3e52abdda"; the number of commits since the
// release is left out, nobody tracks it). Nearest is not what `git describe`
// finds: it only looks at the commit's ancestors, and a fork that cuts
// its releases on a side branch (TurboQuant: "b10298-2.1.0" is not in the
// history of its dev branch) would be called after an old ancestor tag hundreds
// of commits back. So every recent release tag is measured by the commits the
// build has that the tag does not (only to choose between them), the smallest
// wins, and the newest release wins a tie. A tag with nothing to add is skipped: the build is older than it.
// `commit` is the commit to name (HEAD by default).
export async function sourceVersionLabel(dir: string, commit = 'HEAD'): Promise<string> {
  const g = (args: string[]) => git(args, dir, { timeoutMs: 15000 })
  const full = await g(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
  if (!full.ok || !full.stdout) return commit === 'HEAD' ? gitVersionLabel(dir) : commit.slice(0, 7)
  const sha = full.stdout
  const newestFirst = (a: string, b: string) => compareBackendVersions(b, a)
  const lines = (r: { ok: boolean; stdout: string }) => (r.ok ? r.stdout.split(/\r?\n/).map(t => t.trim()).filter(Boolean) : []).filter(isReleaseTag)

  const here = lines(await g(['tag', '--points-at', sha]))
  let label: string | null = here.length ? here.sort(newestFirst)[0] : null
  if (!label) {
    const candidates = lines(await g(['tag', '--list'])).sort(newestFirst).slice(0, 12)
    const ancestor = await g(['describe', '--tags', '--abbrev=0', '--match', 'b[0-9]*', '--match', 'v[0-9]*', '--match', '[0-9]*', sha])
    for (const t of lines(ancestor)) if (!candidates.includes(t)) candidates.push(t)
    let best: { tag: string; count: number } | null = null
    for (const tag of candidates) {
      const r = await g(['rev-list', '--count', `${tag}..${sha}`])
      const count = r.ok ? parseInt(r.stdout, 10) : NaN
      if (!(count > 0)) continue
      if (!best || count < best.count || (count === best.count && compareBackendVersions(tag, best.tag) > 0)) best = { tag, count }
    }
    if (best) {
      const short = await g(['rev-parse', '--short', sha])
      label = `${best.tag}-g${short.ok && short.stdout ? short.stdout : sha.slice(0, 8)}`
    }
  }
  if (!label && commit === 'HEAD') label = await gitVersionLabel(dir)
  if (!label) {
    const short = await g(['rev-parse', '--short', sha])
    label = short.ok && short.stdout ? short.stdout : sha.slice(0, 7)
  }
  return label
}

export async function buildFromSource(job: SourceBuildJob, hooks: SourceBuildHooks): Promise<SourceBuildResult> {
  const note = (line: string) => hooks.log(line, true)
  try {
    const def = sourceBuildType(job.type)
    if (!def) fail(`Unknown build type "${job.type}".`)
    const url = githubCloneUrl(job.repo)
    if (!url) fail(`Not a GitHub repository: ${job.repo}`)

    const tc = await detectToolchain()
    if (!tc.git) fail('git was not found. Install git and make sure it is on PATH.')
    if (!tc.cmake) fail('CMake was not found. Install CMake and make sure it is on PATH.')
    if (!tc.compiler) {
      fail(process.platform === 'win32'
        ? 'No C++ compiler was found. Install Visual Studio Build Tools with the "Desktop development with C++" workload.'
        : 'No C++ compiler was found. Install one (for example build-essential or Xcode Command Line Tools).')
    }
    note(`Toolchain: ${tc.cmake}, ${tc.compiler}`)
    if (isCudaType(job.type) && !tc.cuda && !job.cudaRoot) note('Warning: no CUDA toolkit was detected (nvcc / CUDA_PATH). The configure step will probably fail.')
    if (job.type === 'vulkan' && !tc.vulkan) {
      note(tc.vulkanGaps.length > 0
        ? `Warning: this system lacks ${tc.vulkanGaps.join(', ')} for the Vulkan backend. The configure step will probably fail; installing the build tools adds them.`
        : 'Warning: no Vulkan SDK was detected (glslc / VULKAN_SDK). The configure step will probably fail.')
    }
    if (job.type === 'rocm' && !tc.hip && !job.rocmRoot) note('Warning: no ROCm/HIP SDK with the HIP CMake package and a compiler was found. The configure step will probably fail.')

    const forkDir = join(job.rootDir, job.folderName)
    // This OS's own clone and build tree; another system's are never touched.
    const work = workDirs(forkDir)
    const srcDir = work.source
    const buildDir = work.build(job.type)
    await fsPromises.mkdir(dirname(srcDir), { recursive: true })

    if (existsSync(join(srcDir, '.git')) && job.pull === false) {
      note('Building the source as it is checked out; the branch is not pulled.')
    } else if (existsSync(join(srcDir, '.git'))) {
      hooks.progress('updating', 0)
      note(`Updating the source of ${job.repo}${job.branch ? ` (${job.branch})` : ''}`)
      const up = await updateGitEngine(srcDir)
      if (hooks.signal.aborted) fail('Cancelled')
      if (up.error) fail(`Updating the source failed: ${up.error.split('\n')[0]}`)
      note(up.skipped ? `Source update skipped (${up.skipped}); building what is checked out.` : up.updated ? 'Source updated.' : 'Source is already up to date.')
    } else {
      hooks.progress('cloning', 0)
      note(`Cloning ${job.repo}${job.branch ? ` (${job.branch})` : ''}`)
      // A blobless clone keeps the full history (tags and the commit count
      // the build number is derived from) without downloading every file
      // version ever committed.
      const args = ['clone', '--filter=blob:none', '--progress']
      if (job.branch) args.push(`--branch=${job.branch}`)
      args.push('--', url, srcDir)
      try {
        await runOrFail('git', args, hooks, 'Cloning', { env: { GIT_ALLOW_PROTOCOL: 'https' } })
      } catch (err) {
        await fsPromises.rm(srcDir, { recursive: true, force: true })
        throw err
      }
    }
    if (existsSync(join(srcDir, '.gitmodules'))) {
      await runOrFail('git', ['submodule', 'update', '--init', '--recursive', '--depth', '1'], hooks, 'Fetching submodules', { cwd: srcDir })
    }

    const commit = readHeadCommit(srcDir)
    if (!commit) fail('Could not read the checked-out commit.')
    const version = sourceVersionName(await sourceVersionLabel(srcDir))
    note(`Building ${version} (${commit.slice(0, 10)})`)

    hooks.progress('configuring', 0)
    // $ORIGIN / @loader_path make the binary find its shared libraries next to
    // itself, which is where the installed copy keeps them. LLAMA_CURL is off
    // because the curl development files are rarely present; it only affects
    // llama-server downloading models by itself, which the app never uses.
    const rpath = process.platform === 'darwin' ? '@loader_path' : '$ORIGIN'
    const rocm = job.type === 'rocm' && job.rocmRoot ? rocmToolchain(job.rocmRoot, process.platform) : null
    if (rocm) {
      note(`Using the ROCm SDK at ${job.rocmRoot}`)
      note(rocm.deviceLibDir
        ? `ROCm device libraries: ${rocm.deviceLibDir}`
        : 'Warning: no ROCm device library (ocml.bc) was found anywhere in this SDK. clang will stop with "cannot find ROCm device library" on every GPU file. Use an SDK that includes the device libraries, such as the other source in Settings.')
    }
    const cudaHome = isCudaType(job.type) ? job.cudaRoot ?? findCudaRoot(cudaTypeVersion(job.type))?.root ?? null : null
    if (cudaHome) note(`Using the CUDA Toolkit at ${cudaHome}`)
    const cudaLacking = cudaHome ? missingCudaParts(cudaHome) : []
    if (cudaLacking.length > 0) note(`Warning: this CUDA Toolkit is incomplete (missing ${cudaLacking.join(', ')}). The configure step will probably fail; installing the build tools repairs it.`)
    const cudaTc = cudaHome ? cudaToolchain(cudaHome, process.platform) : null
    const generatorArgs = isCudaType(job.type) ? cudaGeneratorArgs(process.platform, job.extraArgs) : []
    const gpuArgs = job.type === 'rocm' && job.gpuTarget ? [`-DAMDGPU_TARGETS=${job.gpuTarget}`, `-DGPU_TARGETS=${job.gpuTarget}`] : []
    const configure = [
      '-S', srcDir, '-B', buildDir,
      '-DCMAKE_BUILD_TYPE=Release', '-DLLAMA_CURL=OFF',
      ...def.cmakeArgs,
      ...(rocm?.cmakeArgs ?? []),
      ...(cudaTc?.cmakeArgs ?? []),
      ...gpuArgs,
      ...generatorArgs,
      ...(process.platform === 'win32' ? [] : ['-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON', `-DCMAKE_INSTALL_RPATH=${rpath}`]),
      ...job.extraArgs
    ]
    // CMake will not reconfigure a folder with another generator than it was
    // made with (an earlier attempt without Ninja, say); that folder only holds
    // build products, so it is started again.
    const wanted = requestedGenerator(configure)
    const had = cachedGenerator(buildDir)
    if (wanted && had && wanted !== had) {
      note(`The build folder was configured with "${had}"; starting it again for "${wanted}".`)
      await fsPromises.rm(buildDir, { recursive: true, force: true })
    }
    // Ninja, unlike the Visual Studio generator, does not set up the Windows SDK
    // that clang needs (rc.exe, headers, import libraries); the Visual Studio
    // environment provides it.
    const toolkit = rocm ?? cudaTc
    let buildEnv: Record<string, string> | undefined = toolkit?.env
    if ((rocm && rocm.cmakeArgs.includes('Ninja')) || generatorArgs.includes('Ninja')) {
      const vs = await windowsBuildEnv()
      if (vs) {
        buildEnv = toolkit ? mergeBuildEnv(vs, toolkit) : vs
        note('Using the Visual Studio build environment (Windows SDK and linker).')
      } else {
        note('Warning: the Visual Studio build environment could not be loaded, so the build may not find the C++ compiler or the Windows SDK. Install Visual Studio Build Tools with the "Desktop development with C++" workload.')
      }
    }
    // Helper sub-builds made by a CMake that has since been updated or removed
    // would fail the build; they are small, so they are simply made again.
    const staleSubbuilds = findStaleCmakeSubbuilds(buildDir, cmakeMajorMinor(tc.cmake))
    if (staleSubbuilds.length > 0) {
      const gone = await removeCmakeSubbuilds(buildDir, staleSubbuilds)
      for (const p of gone) note(`Removed ${relative(buildDir, p)}, made by a CMake that is no longer there; it is built again.`)
    }

    const parallel = String(Math.max(1, cpus().length - 1))
    // When CMake's remembered state (rather than the code) is what fails, the
    // cheapest repair is tried first: throw away the sub-builds, then, if that
    // does not help or there are none, the whole build folder. Compile errors
    // are never retried.
    let sawStaleState = false
    const hints = new Set<string>()
    const watch = (line: string) => {
      if (isStaleCmakeLine(line)) sawStaleState = true
      const hint = configureHint(line)
      if (hint) hints.add(hint)
    }
    let repairs = 0
    for (;;) {
      sawStaleState = false
      try {
        try {
          await runOrFail('cmake', configure, hooks, 'Configuring', { env: buildEnv, onLine: watch })
        } catch (err) {
          // nvcc's failures name a missing file only indirectly, so show what the toolkit holds.
          if (cudaHome && !hooks.signal.aborted && !sawStaleState) {
            note(`The CUDA Toolkit at ${cudaHome} holds:`)
            for (const l of describeCudaToolkit(cudaHome)) note(l)
          }
          for (const h of hints) note(h)
          throw err
        }

        hooks.progress('building', 0)
        let lastPercent = -1
        await runOrFail('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'llama-server', '--parallel', parallel], hooks, 'Building', {
          env: buildEnv,
          onLine: line => {
            watch(line)
            const pct = parseBuildProgress(line)
            if (pct !== null && pct !== lastPercent) { lastPercent = pct; hooks.progress('building', pct) }
          }
        })
        break
      } catch (err) {
        if (hooks.signal.aborted || !sawStaleState || repairs >= 2) throw err
        if (repairs === 0) {
          repairs = 1
          const gone = await removeCmakeSubbuilds(buildDir)
          if (gone.length > 0) {
            note(`CMake's remembered state in this build folder is out of date. Removed ${gone.map(p => relative(buildDir, p)).join(', ')} and trying again; the rest of the build is kept.`)
            continue
          }
        }
        repairs = 2
        note("CMake's remembered state in this build folder is out of date. Starting the build folder again from scratch.")
        await fsPromises.rm(buildDir, { recursive: true, force: true })
      }
    }
    // The GGUF inspector is used for model metadata when present. Not every
    // fork has the target, so a failure here is not a failed build.
    const gguf = await run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'llama-gguf', '--parallel', parallel], hooks, { quiet: true, env: buildEnv })
    note(gguf === 0 ? 'Built llama-gguf.' : 'llama-gguf is not part of this build; skipped.')

    const binDir = findBinDir(buildDir)
    if (!binDir) fail('The build finished but llama-server was not found in the build folder.')

    hooks.progress('installing', 100)
    const typeDir = join(forkDir, job.type)
    await fsPromises.mkdir(typeDir, { recursive: true })
    await fsPromises.writeFile(join(typeDir, BACKEND_TYPE_MARKER), '')
    const finalVersion = installVersionName(typeDir, version)
    const staging = join(typeDir, `.staging-${Date.now()}`)
    const dst = join(typeDir, finalVersion)
    try {
      await fsPromises.cp(binDir, staging, { recursive: true, verbatimSymlinks: true })
      await fsPromises.rm(dst, { recursive: true, force: true })
      await fsPromises.rename(staging, dst)
    } catch (err) {
      await fsPromises.rm(staging, { recursive: true, force: true })
      fail(`Could not install the build into ${dst}. Is a model running from it? (${String((err as Error).message || err)})`)
    }
    const marker: SourceMarker = { repo: job.repo, branch: job.branch ?? null, commit, type: job.type, extraArgs: job.extraArgs, gpuTarget: job.gpuTarget, rocmRoot: job.type === 'rocm' ? job.rocmRoot : undefined, cudaRoot: cudaHome ?? undefined, builtAt: Date.now() }
    await fsPromises.writeFile(join(dst, SOURCE_MARKER), JSON.stringify(marker, null, 2))

    await pruneSupersededBuilds([job.rootDir], job.folderName, note, true)
    // The build worked with this toolkit, so its installer is no longer needed.
    if (isCudaType(job.type)) await removeCudaInstallers(job.rootDir)
    note(`Installed ${finalVersion} to ${dst}`)
    return { ok: true, versionDir: dst, version: finalVersion, commit }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (hooks.signal.aborted || message === 'Cancelled') return { ok: false, error: 'Cancelled', cancelled: true }
    return { ok: false, error: message }
  }
}

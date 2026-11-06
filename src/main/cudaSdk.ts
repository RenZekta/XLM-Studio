import { existsSync, readFileSync, readdirSync } from 'fs'
import { delimiter, dirname, join } from 'path'

// The CUDA Toolkit on this machine: where each installed one is, which version
// it is, what a build must do on Windows, and what a program built against it
// needs at launch. Toolkits install side by side (v12.4 and v13.4 together), so
// a build asks for a series, not just "CUDA".

function nvccName(): string {
  return process.platform === 'win32' ? 'nvcc.exe' : 'nvcc'
}

function cleanRoot(path: string | undefined): string | null {
  const root = path?.trim().replace(/[\\/]+$/, '')
  return root && existsSync(join(root, 'bin', nvccName())) ? root : null
}

// "12.4.131" from version.json (CUDA 11 and newer) or version.txt, else from a
// folder name like v12.4 or cuda-12.4.
export function cudaVersionOf(root: string): string | null {
  try {
    const json = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')) as { cuda?: { version?: string } }
    if (json.cuda?.version) return json.cuda.version
  } catch { /* try the next place */ }
  try {
    const m = /CUDA Version (\d+(?:\.\d+)+)/.exec(readFileSync(join(root, 'version.txt'), 'utf8'))
    if (m) return m[1]
  } catch { /* try the next place */ }
  return /(?:^|[\\/])(?:v|cuda-)(\d+\.\d+)(?:[\\/]|$)/.exec(root)?.[1] ?? null
}

// Every toolkit with an nvcc: those named by the environment, the one nvcc on
// the PATH belongs to, and the folders the installers use.
export function allCudaRoots(): string[] {
  const candidates: (string | undefined)[] = [process.env.CUDA_PATH, process.env.CUDA_HOME]
  for (const [k, v] of Object.entries(process.env)) if (/^CUDA_PATH_V\d+_\d+$/i.test(k)) candidates.push(v)
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (dir && existsSync(join(dir, nvccName()))) candidates.push(dirname(dir))
  }
  if (process.platform === 'win32') {
    const base = join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA GPU Computing Toolkit', 'CUDA')
    try { for (const e of readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) candidates.push(join(base, e.name)) } catch { /* none installed */ }
  } else {
    candidates.push('/usr/local/cuda')
    try { for (const e of readdirSync('/usr/local', { withFileTypes: true })) if (e.name.startsWith('cuda-')) candidates.push(join('/usr/local', e.name)) } catch { /* none */ }
  }
  return [...new Set(candidates.map(cleanRoot).filter((r): r is string => !!r))]
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(n => parseInt(n, 10) || 0)
  const y = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

export interface CudaToolkit {
  root: string
  version: string | null
}

// The toolkit of a series ("12.4"), or the newest installed one when none is given.
export function findCudaRoot(series?: string): CudaToolkit | null {
  const found = allCudaRoots().map(root => ({ root, version: cudaVersionOf(root) }))
  const fits = series ? found.filter(t => t.version === series || t.version?.startsWith(`${series}.`)) : found
  fits.sort((a, b) => compareVersions(b.version ?? '0', a.version ?? '0'))
  return fits[0] ?? null
}

// The pieces of a Windows toolkit that a llama.cpp build compiles and links
// against, as the names a person would recognise. The installer can be asked for
// a short list of components, and a list that leaves one of these out still
// produces a folder with an nvcc in it that cannot compile anything.
// CUDA 13 moved thrust and cub under include/cccl and made the crt headers and
// nvvm components of their own.
const WINDOWS_CUDA_PARTS: { label: string; anyOf: string[] }[] = [
  { label: 'the CRT headers (include/crt/host_config.h)', anyOf: ['include/crt/host_config.h'] },
  { label: 'the runtime headers (include/cuda_runtime.h)', anyOf: ['include/cuda_runtime.h'] },
  { label: 'the cuBLAS headers (include/cublas_v2.h)', anyOf: ['include/cublas_v2.h'] },
  // nvcc runs cicc from here for every device file. CUDA 13 made NVVM a component of its own, like the CRT.
  { label: 'the NVVM compiler (nvvm/bin/cicc.exe)', anyOf: ['nvvm/bin/cicc.exe'] },
  { label: 'the CUDA runtime library (lib/x64/cudart.lib)', anyOf: ['lib/x64/cudart.lib'] },
  { label: 'the cuBLAS library (lib/x64/cublas.lib)', anyOf: ['lib/x64/cublas.lib'] },
  { label: 'thrust and cub (include/thrust or include/cccl/thrust)', anyOf: ['include/thrust/version.h', 'include/cccl/thrust/version.h'] }
]

// What a toolkit lacks to build llama.cpp, empty when it is whole. Only Windows
// toolkits are judged: there the app picks the installer's components itself.
// Elsewhere the distribution's packages or NVIDIA's runfile are laid out in
// ways that differ too much to tell a lean install from a complete one.
export function missingCudaParts(root: string, platform: string = process.platform): string[] {
  if (platform !== 'win32') return []
  return WINDOWS_CUDA_PARTS.filter(p => !p.anyOf.some(rel => existsSync(join(root, ...rel.split('/'))))).map(p => p.label)
}

// A few lines on what is in a toolkit's folders, for the log when nvcc fails in
// a way that is not obvious: which of the folders nvcc depends on exist and what
// the compiler's own folder holds.
export function describeCudaToolkit(root: string): string[] {
  const list = (rel: string): string => {
    const dir = join(root, ...rel.split('/'))
    if (!existsSync(dir)) return '(missing)'
    try {
      const names = readdirSync(dir)
      return names.length === 0 ? '(empty)' : names.slice(0, 12).join(', ') + (names.length > 12 ? `, ... (${names.length} entries)` : '')
    } catch { return '(unreadable)' }
  }
  return ['bin', 'nvvm', 'nvvm/bin', 'nvvm/libdevice', 'include/crt', 'lib/x64'].map(rel => `  ${rel}/ ${list(rel)}`)
}

// Whether a toolkit can compile a build as it stands.
export function isCompleteCudaToolkit(root: string, platform: string = process.platform): boolean {
  return missingCudaParts(root, platform).length === 0
}

// Kept for the places that only need to know where some toolkit is.
export function systemCudaRoot(): string | null {
  return findCudaRoot()?.root ?? null
}

// On Windows a CUDA build is generated with Ninja inside the Visual Studio
// environment, as llama.cpp's own CUDA builds are. The Visual Studio generator
// would need NVIDIA's "Visual Studio Integration" component, which a lean install
// leaves out.
export function cudaGeneratorArgs(platform: string, extraArgs: string[]): string[] {
  const userChose = extraArgs.some(a => a === '-G' || a.startsWith('-G'))
  return platform === 'win32' && !userChose ? ['-G', 'Ninja'] : []
}

// What a build needs to use exactly this toolkit and no other one installed
// beside it: the compiler, the toolkit root for CMake, and its bin on the PATH.
export function cudaToolchain(root: string, platform: string): { env: Record<string, string>; pathDirs: string[]; cmakeArgs: string[]; deviceLibDir: null } {
  const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const pathDirs = [join(root, 'bin')]
  return {
    env: { CUDA_PATH: root, CUDA_HOME: root, [pathKey]: [...pathDirs, process.env[pathKey] || ''].filter(Boolean).join(delimiter) },
    pathDirs,
    cmakeArgs: [`-DCUDAToolkit_ROOT=${root}`, `-DCMAKE_CUDA_COMPILER=${join(root, 'bin', platform === 'win32' ? 'nvcc.exe' : 'nvcc')}`],
    deviceLibDir: null
  }
}

// What a program built against this toolkit needs when it runs. CUDA 13 on
// Windows keeps its DLLs in bin\x64, older ones in bin.
export function cudaRuntimeEnv(root: string, platform: string): Record<string, string> {
  if (platform === 'win32') {
    const pathKey = Object.keys(process.env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    const dirs = [join(root, 'bin', 'x64'), join(root, 'bin')].filter(d => existsSync(d))
    return { [pathKey]: [...dirs, process.env[pathKey] || ''].filter(Boolean).join(delimiter), CUDA_PATH: root }
  }
  const libs = [join(root, 'lib64'), join(root, 'lib')].filter(d => existsSync(d))
  return { LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(delimiter), CUDA_PATH: root }
}

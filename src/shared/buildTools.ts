// What it takes to install or update the tools a source build needs, per
// platform and package manager. Pure: it only decides which commands to run;
// src/main/buildTools.ts runs them.

export type ToolId = 'git' | 'cmake' | 'compiler' | 'ninja' | 'python' | 'cuda' | 'vulkan' | 'hip'
export type PackageManager = 'winget' | 'brew' | 'apt' | 'dnf' | 'pacman' | 'zypper'

export const TOOL_LABELS: Record<ToolId, string> = {
  git: 'git',
  cmake: 'CMake',
  compiler: 'a C++ compiler',
  ninja: 'Ninja',
  python: 'Python 3.11 to 3.14',
  cuda: 'the CUDA Toolkit',
  vulkan: 'the Vulkan SDK',
  hip: 'the ROCm/HIP SDK'
}

// Tools a build of this type (see SOURCE_BUILD_TYPES) cannot do without.
// CUDA and HIP builds on Windows are generated with Ninja, and the pip route to the
// ROCm SDK needs Python.
export function requiredToolsFor(type: string, platform: string = 'linux', rocmSource: 'tarball' | 'pip' = 'tarball'): ToolId[] {
  const tools: ToolId[] = ['git', 'cmake', 'compiler']
  if (type === 'cuda' || type.startsWith('cuda-')) tools.push(...(platform === 'win32' ? ['ninja' as const] : []), 'cuda')
  else if (type === 'vulkan') tools.push('vulkan')
  else if (type === 'rocm') tools.push(...(platform === 'win32' ? ['ninja' as const] : []), ...(rocmSource === 'pip' ? ['python' as const] : []), 'hip')
  return tools
}

// Tools the app fetches and installs itself instead of asking a package
// manager: the ROCm SDK (see main/rocmSdk.ts) and, on Windows, the CUDA
// Toolkit (main/cudaInstaller.ts).
export function isManagedTool(tool: ToolId, platform: string): boolean {
  // The CUDA Toolkit is managed on Windows only: there its installer is fetched
  // and run by the app; on Linux the package manager has it.
  return (tool === 'hip' && (platform === 'win32' || platform === 'linux')) || (tool === 'cuda' && platform === 'win32')
}

interface WingetPackage { id: string; override?: string }

const WINGET: Partial<Record<ToolId, WingetPackage>> = {
  git: { id: 'Git.Git' },
  cmake: { id: 'Kitware.CMake' },
  ninja: { id: 'Ninja-build.Ninja' },
  python: { id: 'Python.Python.3.12' },
  // The installer is told which workload to add, otherwise it opens its
  // interactive picker and installs no compiler.
  compiler: { id: 'Microsoft.VisualStudio.2022.BuildTools', override: '--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' },
  cuda: { id: 'Nvidia.CUDA' },
  vulkan: { id: 'KhronosGroup.VulkanSDK' }
}

// Package names for the managers that install by name.
const PACKAGES: Record<Exclude<PackageManager, 'winget'>, Partial<Record<ToolId, string[]>>> = {
  brew: { git: ['git'], cmake: ['cmake'], ninja: ['ninja'], python: ['python@3.12'] },
  apt: { git: ['git'], cmake: ['cmake'], ninja: ['ninja-build'], python: ['python3', 'python3-venv'], compiler: ['build-essential'], vulkan: ['libvulkan-dev', 'glslc', 'spirv-headers'], cuda: ['nvidia-cuda-toolkit'] },
  dnf: { git: ['git'], cmake: ['cmake'], ninja: ['ninja-build'], python: ['python3'], compiler: ['gcc-c++', 'make'], vulkan: ['vulkan-loader-devel', 'glslc', 'spirv-headers-devel'] },
  pacman: { git: ['git'], cmake: ['cmake'], ninja: ['ninja'], python: ['python'], compiler: ['base-devel'], vulkan: ['vulkan-headers', 'vulkan-icd-loader', 'shaderc', 'spirv-headers'], cuda: ['cuda'] },
  zypper: { git: ['git'], cmake: ['cmake'], ninja: ['ninja'], python: ['python3'], compiler: ['gcc-c++', 'make'], vulkan: ['vulkan-devel', 'shaderc', 'spirv-headers'] }
}

// The package a tool is installed as, for asking the package manager about it.
export function packageNames(tool: ToolId, pm: PackageManager): string[] | undefined {
  return pm === 'winget' ? (WINGET[tool] ? [WINGET[tool]!.id] : undefined) : PACKAGES[pm][tool]
}

// What cannot be installed by a package manager, and what to do instead.
function manualReason(tool: ToolId, platform: string, pm: PackageManager | null): string {
  if (platform === 'darwin' && tool === 'compiler') return 'Run "xcode-select --install" in Terminal and accept the dialog.'
  if (platform === 'linux' && tool === 'cuda') return 'Add NVIDIA\'s CUDA repository for your distribution and install the toolkit (https://developer.nvidia.com/cuda-downloads).'
  if (platform === 'darwin') return `${TOOL_LABELS[tool]} is not available on macOS through Homebrew.`
  if (!pm) {
    return platform === 'win32'
      ? 'winget was not found. Install "App Installer" from the Microsoft Store.'
      : platform === 'darwin'
        ? 'Homebrew was not found. Install it from https://brew.sh and try again.'
        : `No supported package manager (apt, dnf, pacman, zypper) was found, so install ${TOOL_LABELS[tool]} yourself.`
  }
  return `${TOOL_LABELS[tool]} cannot be installed automatically with ${pm}.`
}

export interface PlannedCommand {
  cmd: string
  args: string[]
  // Needs root on Linux (the caller adds pkexec/sudo unless already root).
  elevate: boolean
}

export interface ToolPlan {
  commands: PlannedCommand[]
  // Tools the app installs itself (downloaded and unpacked), see isManagedTool.
  managed: ToolId[]
  // Tools no command here covers, with what to do instead.
  manual: { tool: ToolId; reason: string }[]
  // Tools an update is not attempted for, and why.
  skipped: { tool: ToolId; reason: string }[]
}

// Commands that bring `tools` in: 'install' puts missing ones in, 'update'
// moves installed ones to the newest version the package manager offers. The
// package manager one-liners are merged into a single command per manager so
// the user is asked for a password once.
export function planTools(tools: ToolId[], mode: 'install' | 'update', platform: string, pm: PackageManager | null): ToolPlan {
  const plan: ToolPlan = { commands: [], managed: [], manual: [], skipped: [] }
  const names: string[] = []

  for (const tool of tools) {
    if (isManagedTool(tool, platform)) { plan.managed.push(tool); continue }
    if (platform === 'win32') {
      const pkg = pm === 'winget' ? WINGET[tool] : undefined
      if (!pkg) { plan.manual.push({ tool, reason: manualReason(tool, platform, pm) }); continue }
      plan.commands.push({
        cmd: 'winget',
        args: [mode === 'install' ? 'install' : 'upgrade', '--id', pkg.id, '-e', '--silent', '--accept-package-agreements', '--accept-source-agreements',
          ...(mode === 'install' && pkg.override ? ['--override', pkg.override] : [])],
        elevate: false
      })
      continue
    }
    if (!pm || pm === 'winget') { plan.manual.push({ tool, reason: manualReason(tool, platform, null) }); continue }
    const pkgs = PACKAGES[pm][tool]
    if (!pkgs) { plan.manual.push({ tool, reason: manualReason(tool, platform, pm) }); continue }
    // Arch has no partial upgrades: updating one package without the rest of
    // the system can break the others, so that is left to the user's own sync.
    if (mode === 'update' && pm === 'pacman') {
      plan.skipped.push({ tool, reason: 'pacman does not support updating a single package safely; run "pacman -Syu" yourself.' })
      continue
    }
    names.push(...pkgs)
  }

  if (names.length && pm && pm !== 'winget') {
    const unique = [...new Set(names)]
    const sh = (script: string): PlannedCommand => ({ cmd: 'sh', args: ['-c', script], elevate: true })
    if (pm === 'brew') {
      plan.commands.push({ cmd: 'brew', args: [mode === 'install' ? 'install' : 'upgrade', ...unique], elevate: false })
    } else if (pm === 'apt') {
      const apt = mode === 'install' ? `apt-get install -y ${unique.join(' ')}` : `apt-get install -y --only-upgrade ${unique.join(' ')}`
      plan.commands.push(sh(`DEBIAN_FRONTEND=noninteractive; export DEBIAN_FRONTEND; apt-get update && ${apt}`))
    } else if (pm === 'dnf') {
      plan.commands.push(sh(`dnf ${mode === 'install' ? 'install' : 'upgrade'} -y ${unique.join(' ')}`))
    } else if (pm === 'zypper') {
      plan.commands.push(sh(`zypper --non-interactive ${mode === 'install' ? 'install' : 'update'} ${unique.join(' ')}`))
    } else if (pm === 'pacman') {
      plan.commands.push(sh(`pacman -S --needed --noconfirm ${unique.join(' ')}`))
    }
  }
  return plan
}

// winget exit codes that mean "nothing to do", not a failure: no newer
// version exists, or the package is already installed.
export const WINGET_NOTHING_TO_DO = new Set([-1978335189, -1978335135, 2316632107, 2316632161])

// One line a person can run themselves, for when elevation is not possible.
export function describeCommand(c: PlannedCommand): string {
  return c.cmd === 'sh' ? c.args[1] : [c.cmd, ...c.args.map(a => /\s/.test(a) ? `"${a}"` : a)].join(' ')
}

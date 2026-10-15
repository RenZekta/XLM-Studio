// Which operating system a release asset or an installed build is for.
// Names are matched token by token, so "darwin" is never read as "win" and a
// fork that says "linux" instead of "ubuntu" is still recognised.

export type BuildPlatform = 'windows' | 'linux' | 'macos'

function tokens(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

export function assetPlatform(name: string): BuildPlatform | null {
  const t = tokens(name)
  if (t.some(x => x === 'win' || x === 'windows' || x === 'win32' || x === 'win64')) return 'windows'
  if (t.some(x => x === 'macos' || x === 'darwin' || x === 'osx' || x === 'mac')) return 'macos'
  if (t.some(x => x === 'ubuntu' || x === 'linux')) return 'linux'
  return null
}

// `host` is process.platform.
export function buildPlatformOfHost(host: string): BuildPlatform {
  return host === 'win32' ? 'windows' : host === 'darwin' ? 'macos' : 'linux'
}

// Whether a release asset is the right download for this machine. `arch` is
// process.arch.
export function assetMatchesHost(name: string, host: string, arch: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('cudart-')) return false
  const platform = buildPlatformOfHost(host)
  if (assetPlatform(n) !== platform) return false
  const isTar = n.endsWith('.tar.gz')
  const isZip = n.endsWith('.zip')
  if (platform === 'windows' ? !isZip : !(isTar || isZip)) return false
  const t = tokens(n)
  const arm = t.includes('arm64') || t.includes('aarch64')
  const x64 = t.includes('x64') || t.includes('x86_64') || t.includes('amd64')
  if (platform === 'macos') return arch === 'arm64' ? arm : arch === 'x64' ? x64 : true
  if (platform === 'linux') return arch === 'arm64' ? arm : !arm
  return arch === 'arm64' ? !x64 : !arm
}

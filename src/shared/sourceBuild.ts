// Pure helpers for building engines from source and for repositories that are
// followed on a branch other than their default one. Shared by the main
// process (the build itself) and the renderer (type picker, labels).

export interface SourceBuildType {
  // Also the install folder name: <repo>/<id>/<version>/. These match what
  // extractBackendTypeFromAssetName produces for release builds, so a compiled
  // build lands under the same sidebar filter and VRAM overhead category.
  id: string
  label: string
  cmakeArgs: string[]
  // Only offered on these platforms (process.platform values).
  platforms?: string[]
}

export const SOURCE_BUILD_TYPES: SourceBuildType[] = [
  { id: 'cuda', label: 'CUDA (newest)', cmakeArgs: ['-DGGML_CUDA=ON'], platforms: ['win32', 'linux'] },
  // CUDA 13 dropped Maxwell, Pascal and Volta (V100, GTX 10 series); 12.4 still builds for them.
  { id: 'cuda-12.4', label: 'CUDA 12.4 (older GPUs)', cmakeArgs: ['-DGGML_CUDA=ON'], platforms: ['win32', 'linux'] },
  { id: 'vulkan', label: 'Vulkan', cmakeArgs: ['-DGGML_VULKAN=ON'], platforms: ['win32', 'linux'] },
  { id: 'rocm', label: 'ROCm (HIP)', cmakeArgs: ['-DGGML_HIP=ON'], platforms: ['win32', 'linux'] },
  { id: 'metal', label: 'Metal', cmakeArgs: ['-DGGML_METAL=ON'], platforms: ['darwin'] },
  { id: 'cpu', label: 'CPU only', cmakeArgs: [] }
]

export function isCudaType(type: string): boolean {
  return type === 'cuda' || type.startsWith('cuda-')
}

// The toolkit series a CUDA type needs ("12.4"), or undefined for the newest one.
export function cudaTypeVersion(type: string): string | undefined {
  return /^cuda-(\d+\.\d+)$/.exec(type)?.[1]
}

export function sourceBuildTypesFor(platform: string): SourceBuildType[] {
  return SOURCE_BUILD_TYPES.filter(t => !t.platforms || t.platforms.includes(platform))
}

export function sourceBuildType(id: string): SourceBuildType | undefined {
  return SOURCE_BUILD_TYPES.find(t => t.id === id)
}

// --------------------------------------------------------------------------
// Repository links
// --------------------------------------------------------------------------

export interface ParsedRepoLink {
  repo: string
  // Everything after /tree/ in a GitHub URL, or after "@" in "owner/repo@x".
  // Branch names may contain slashes, so it can only be resolved against the
  // repository's real branches (see pickBranch).
  branchPath?: string
}

export function parseRepoLink(link: string): ParsedRepoLink | null {
  const trimmed = link.trim().replace(/[?#].*$/, '')
  const url = trimmed.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(.*))?$/i)
  if (url) {
    const tree = url[3]?.match(/^tree\/(.+?)\/*$/)
    return { repo: `${url[1]}/${url[2]}`, ...(tree ? { branchPath: tree[1] } : {}) }
  }
  const short = trimmed.match(/^([^/\s@]+)\/([^/\s@]+?)(?:\.git)?(?:@(.+))?$/)
  if (short) return { repo: `${short[1]}/${short[2]}`, ...(short[3] ? { branchPath: short[3] } : {}) }
  return null
}

// The branch a link names, given the repository's branches. The longest branch
// that the path starts with wins, so "feature/x" is not read as "feature".
// null when the path names no branch of this repository.
export function pickBranch(branchPath: string, heads: string[]): string | null {
  let best: string | null = null
  for (const h of heads) {
    if ((branchPath === h || branchPath.startsWith(h + '/')) && (best === null || h.length > best.length)) best = h
  }
  return best
}

// `git ls-remote --symref <url> HEAD 'refs/heads/*'` output.
export function parseLsRemote(stdout: string): { defaultBranch: string | null; heads: string[]; headCommit: string | null } {
  let defaultBranch: string | null = null
  let headCommit: string | null = null
  const heads: string[] = []
  for (const line of stdout.split('\n')) {
    const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/)
    if (sym) { defaultBranch = sym[1]; continue }
    const m = line.match(/^([0-9a-f]{40,64})\s+(\S+)$/)
    if (!m) continue
    if (m[2] === 'HEAD') headCommit = m[1]
    else if (m[2].startsWith('refs/heads/')) heads.push(m[2].slice('refs/heads/'.length))
  }
  return { defaultBranch, heads, headCommit }
}

// Folder-name fragment for a branch: lowercase, filesystem-safe, and stable.
export function branchSlug(branch: string): string {
  return branch.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'branch'
}

// "name" for the Tracker row. The folder name (which the sidebar, Template
// editor and Installed Engines show as the repo) carries the same branch.
export function trackedDisplayName(repoName: string, branch?: string): string {
  return branch ? `${repoName} (${branch})` : repoName
}

// --------------------------------------------------------------------------
// Build arguments and output
// --------------------------------------------------------------------------

// Splits a line of extra CMake arguments like a shell would for quoting only
// (no expansion). Every argument must be an option, so a stray word cannot
// turn into a different CMake invocation.
export function splitBuildArgs(text: string): { args: string[] } | { error: string } {
  const args: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) { args.push(cur); cur = ''; has = false }
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) return { error: 'Unclosed quote in the extra CMake arguments.' }
  if (has || cur) args.push(cur)
  const bad = args.find(a => !a.startsWith('-'))
  if (bad !== undefined) return { error: `Extra CMake arguments must be options (like -DNAME=VALUE), got "${bad}".` }
  return { args }
}

// Percent done of the compile step from one line of build output. Makefile
// generators print "[ 42%]", Ninja prints "[12/345]"; MSBuild prints neither.
export function parseBuildProgress(line: string): number | null {
  const pct = line.match(/^\[\s*(\d{1,3})%\]/)
  if (pct) return Math.min(100, parseInt(pct[1], 10))
  const frac = line.match(/^\[(\d+)\/(\d+)\]/)
  if (frac && parseInt(frac[2], 10) > 0) return Math.min(100, Math.round(parseInt(frac[1], 10) / parseInt(frac[2], 10) * 100))
  return null
}

// The version folder of a compiled build. The suffix keeps it from colliding
// with a downloaded release of the same tag in the same type folder.
export const SOURCE_VERSION_SUFFIX = '-src'

// A tag that names a release: "b10298-2.1.0" (upstream build number plus the
// fork's own version), "b9584", "v0.4.9", "2.1.0", with an optional pre-release
// part ("v1.2.0-rc1"). CI tags such as "turboquant-windows-x64-cuda-12.4-066cc29"
// and moving ones such as "dev-latest" are not releases, though digits in them
// would pass for a version number.
export function isReleaseTag(tag: string): boolean {
  return /^(?:b\d{3,6}(?:-\d+(?:\.\d+)+)?|[vV]?\d+(?:\.\d+)+)(?:-[A-Za-z][A-Za-z0-9.]*)?$/.test(tag)
}

// The release a build or a downloaded binary folder stands for, or null when it
// does not read as one. "b10298-2.1.0-g8d935078-src" (a build past the release),
// "b10298-2.1.0-4-g8d935078-src" (the older form of that name, with a commit
// count) and "b10298-2.1.0-windows" all give "b10298-2.1.0". The hash and count
// are dropped because they are not part of the version: left in, "-450-" in
// "v0.4.8-450-gabc" would be read as a build number.
export function releaseBaseOf(folderName: string): string | null {
  const base = folderName
    .replace(new RegExp(`${SOURCE_VERSION_SUFFIX}$`), '')
    .replace(/-(?:windows|linux|macos)$/, '')
    .replace(/(?:-\d+)?-g[0-9a-f]{4,}$/, '')
  return isReleaseTag(base) ? base : null
}

// `git describe` can yield a tag with a slash in it, which is not a folder name.
export function sourceVersionName(describeLabel: string): string {
  return `${describeLabel.replace(/[^A-Za-z0-9._-]+/g, '-')}${SOURCE_VERSION_SUFFIX}`
}

// Log id/name for a build, so the Logs view can show it beside model output.
export function buildLogId(trackedId: string, type: string): string {
  return `build:${trackedId}:${type}`
}

export function isBuildLogId(id: string): boolean {
  return id.startsWith('build:')
}

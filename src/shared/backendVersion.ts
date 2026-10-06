// Parses a backend version/tag string into a comparable shape. Most tracked
// forks version themselves as "bNNNNN" (the upstream llama.cpp build number
// alone), but some forks bump their own release independently of upstream
// and encode that as a suffix, e.g. TurboQuant's "b10269-1.6.0" (upstream
// base b10269, fork semver 1.6.0). The base build number is NOT sufficient
// to order these: two fork releases can share the same upstream base while
// one is strictly newer, so the fork semver (when present) is compared as
// a tiebreaker after the base build number. Forks with plain semver tags
// (e.g. "v0.4.0") have no build number at all; those compare by semver alone.
export function parseBackendVersion(name: string): { build: number; fork: number[] } {
  // A digit run touching a dot belongs to a semver, not to a build number.
  const buildMatch = name.match(/(?<![\d.])(\d{3,6})(?![\d.])/)
  const build = buildMatch ? parseInt(buildMatch[1], 10) : 0
  const forkMatch = name.match(/(\d+(?:\.\d+)+)/)
  const fork = forkMatch ? forkMatch[1].split('.').map(n => parseInt(n, 10)) : []
  return { build, fork }
}

// A version is comparable when either part was parsed.
export function isComparableBackendVersion(name: string): boolean {
  const v = parseBackendVersion(name)
  return v.build > 0 || v.fork.length > 0
}

// Returns negative if a < b, 0 if equal, positive if a > b.
export function compareBackendVersions(a: string, b: string): number {
  const pa = parseBackendVersion(a)
  const pb = parseBackendVersion(b)
  if (pa.build !== pb.build) return pa.build - pb.build
  const len = Math.max(pa.fork.length, pb.fork.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa.fork[i] || 0) - (pb.fork[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

export interface ReleaseLike {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
}

// Picks the release an update check should offer from a newest-first list.
//
// Only releases that carry a binary for this platform are candidates: a
// release can exist before its CI uploads finish, and some tags are source-
// only. Among candidates, build-numbered tags (bNNNNN, bNNNNN-1.6.0) win over
// plain semver ones whenever any exist, matching compareBackendVersions where
// the build number dominates. llama.cpp relies on this: its continuous
// bNNNNN builds are the ones to track, while its vX.Y.Z milestone releases
// are marked "Latest" on GitHub. Within the chosen group a stable release is
// preferred, but a pre-release is accepted when there is no stable one, since
// llama.cpp flags every bNNNNN build as a pre-release while a semver-only
// fork like BeeLlama uses the flag for genuine previews.
//
// With no candidate at all (builds still uploading), the newest build-numbered
// release is returned so the row shows the right tag with an empty asset list.
export function selectLatestRelease<T extends ReleaseLike>(
  releases: T[],
  hasPlatformAsset: (rel: T) => boolean
): T | null {
  const live = releases.filter(r => !r.draft)
  const isBuildNumbered = (r: T) => parseBackendVersion(r.tag_name || '').build > 0
  const candidates = live.filter(hasPlatformAsset)
  const group = candidates.some(isBuildNumbered) ? candidates.filter(isBuildNumbered) : candidates
  const picked = group.find(r => !r.prerelease) ?? group[0]
  if (picked) return picked
  return live.find(isBuildNumbered) ?? live[0] ?? null
}

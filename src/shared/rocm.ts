// The ROCm/HIP SDK as AMD publishes it from TheRock: one tarball per GPU
// family per OS, named therock-dist-<windows|linux>-<family>[-all]-<version>.tar.gz.
// Pure helpers shared by the main process (download, install) and the
// renderer (GPU picker).

export interface RocmGpu {
  // The LLVM target a build is compiled for (the value of AMDGPU_TARGETS).
  gfx: string
  label: string
  // The tarball family this target is in, as it appears in the file name
  // ("gfx110X" covers gfx1100 to gfx1103).
  family: string
}

export const ROCM_GPUS: RocmGpu[] = [
  { gfx: 'gfx1201', label: 'Radeon RX 9070 / 9070 XT, AI PRO R9700 (gfx1201)', family: 'gfx120X' },
  { gfx: 'gfx1200', label: 'Radeon RX 9060 / 9060 XT (gfx1200)', family: 'gfx120X' },
  { gfx: 'gfx1100', label: 'Radeon RX 7900 XTX / XT / GRE, PRO W7900 (gfx1100)', family: 'gfx110X' },
  { gfx: 'gfx1101', label: 'Radeon RX 7800 XT / 7700 XT (gfx1101)', family: 'gfx110X' },
  { gfx: 'gfx1102', label: 'Radeon RX 7600 (gfx1102)', family: 'gfx110X' },
  { gfx: 'gfx1103', label: 'Radeon 780M / 760M / 740M (gfx1103)', family: 'gfx110X' },
  { gfx: 'gfx1150', label: 'Radeon 890M / 880M (gfx1150)', family: 'gfx1150' },
  { gfx: 'gfx1151', label: 'Radeon 8060S / 8050S / 8040S, Ryzen AI Max (gfx1151)', family: 'gfx1151' },
  { gfx: 'gfx1152', label: 'Radeon 860M / 840M (gfx1152)', family: 'gfx1152' },
  { gfx: 'gfx1153', label: 'Radeon 840M (gfx1153)', family: 'gfx1153' },
  { gfx: 'gfx1030', label: 'Radeon RX 6800 / 6900 (gfx1030)', family: 'gfx103X' },
  { gfx: 'gfx1031', label: 'Radeon RX 6700 XT (gfx1031)', family: 'gfx103X' },
  { gfx: 'gfx1032', label: 'Radeon RX 6600 / 6650 XT (gfx1032)', family: 'gfx103X' },
  { gfx: 'gfx1010', label: 'Radeon RX 5700 / 5600 (gfx1010)', family: 'gfx101X' },
  { gfx: 'gfx1012', label: 'Radeon RX 5500 (gfx1012)', family: 'gfx101X' },
  { gfx: 'gfx906', label: 'Radeon VII, Instinct MI50 / MI60 (gfx906)', family: 'gfx906' },
  { gfx: 'gfx900', label: 'Radeon RX Vega 56 / 64 (gfx900)', family: 'gfx900' },
  { gfx: 'gfx908', label: 'Instinct MI100 (gfx908)', family: 'gfx908' },
  { gfx: 'gfx90a', label: 'Instinct MI210 / MI250 (gfx90a)', family: 'gfx90a' },
  { gfx: 'gfx942', label: 'Instinct MI300 (gfx942)', family: 'gfx94X' },
  { gfx: 'gfx950', label: 'Instinct MI350 (gfx950)', family: 'gfx950' }
]

export function rocmGpu(gfx: string): RocmGpu | undefined {
  return ROCM_GPUS.find(g => g.gfx === gfx)
}

// The target of a GPU, from the name the OS reports for it. First match wins,
// so the more specific patterns come first. null when it is not recognised.
const GPU_NAME_PATTERNS: [RegExp, string][] = [
  [/\b(rx\s*)?9070|r9700|r9600/i, 'gfx1201'],
  [/\b(rx\s*)?906\d|\b(rx\s*)?905\d/i, 'gfx1200'],
  [/\b(rx\s*)?79\d0|w7900|w7800/i, 'gfx1100'],
  [/\b(rx\s*)?77\d0|\b(rx\s*)?78\d0|w7700|v710/i, 'gfx1101'],
  [/\b(rx\s*)?76\d0/i, 'gfx1102'],
  [/\b7[468]0m\b/i, 'gfx1103'],
  [/\b89\dm\b|\b88\dm\b/i, 'gfx1150'],
  [/\b80[456]0s\b/i, 'gfx1151'],
  [/\b8[46]0m\b/i, 'gfx1152'],
  [/\b(rx\s*)?6[89]\d0|w6800|v620/i, 'gfx1030'],
  [/\b(rx\s*)?67\d0/i, 'gfx1031'],
  [/\b(rx\s*)?66\d0/i, 'gfx1032'],
  [/\b(rx\s*)?5[67]\d0/i, 'gfx1010'],
  [/\b(rx\s*)?55\d0/i, 'gfx1012'],
  [/mi3[05]\d/i, 'gfx942'],
  [/mi35\d/i, 'gfx950'],
  [/mi2[15]0/i, 'gfx90a'],
  [/mi100/i, 'gfx908'],
  [/radeon\s*vii|mi50|mi60/i, 'gfx906'],
  [/vega\s*(56|64)/i, 'gfx900']
]

export function gfxForGpuName(name: string): string | null {
  // MI350/MI355 must not be read as MI300-series.
  if (/mi35\d/i.test(name)) return 'gfx950'
  for (const [re, gfx] of GPU_NAME_PATTERNS) if (re.test(name)) return gfx
  return null
}

// --------------------------------------------------------------------------
// The pip route
// --------------------------------------------------------------------------

// How the SDK is obtained: AMD's tarball unpacked into the engines folder, or
// AMD's Python wheels installed into a virtual environment there.
export type RocmSdkSource = 'tarball' | 'pip'

// AMD's index of ROCm wheels (stable releases).
export const ROCM_PIP_INDEX = 'https://stable.repo.amd.com/rocm/whl-next/'

// GPU targets that have their own device-<gfx> extra; the rest use device-all.
const PIP_DEVICE_TARGETS = ['gfx950', 'gfx942', 'gfx90a', 'gfx908', 'gfx1201', 'gfx1200', 'gfx1100', 'gfx1101', 'gfx1102', 'gfx1103', 'gfx1030', 'gfx1151', 'gfx1150', 'gfx1152']

// The extras of the rocm package for building for this target: compilers and
// headers, the math libraries a llama.cpp build links, and the GPU kernels.
export function rocmPipExtras(gfx: string): string {
  return `devel,libraries,${PIP_DEVICE_TARGETS.includes(gfx) ? `device-${gfx}` : 'device-all'}`
}

// Release versions of the rocm package listed on a PEP 503 index page.
export function parsePipIndexVersions(html: string): string[] {
  const versions = new Set<string>()
  for (const m of html.matchAll(/rocm-(\d+\.\d+\.\d+)(?:-py[^"'#<>\s]*\.whl|\.tar\.gz)/g)) versions.add(m[1])
  return [...versions].sort(compareRocmVersions).reverse()
}

// --------------------------------------------------------------------------
// Tarball names
// --------------------------------------------------------------------------

export type RocmOs = 'windows' | 'linux'

export function rocmOsFor(platform: string): RocmOs | null {
  return platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : null
}

export interface RocmTarball {
  name: string
  os: RocmOs
  family: string
  // "all", "dgpu", "dcgpu" or "" as the name has it.
  suffix: string
  version: string
}

const TARBALL_RE = /^therock-dist-(windows|linux)-(gfx[0-9a-fA-FX]+)(?:-([a-z]+))?-(\d+\.\d+\.\d+(?:a\d+)?)\.tar\.gz$/

export function parseRocmTarball(name: string): RocmTarball | null {
  const m = TARBALL_RE.exec(name)
  return m ? { name, os: m[1] as RocmOs, family: m[2], suffix: m[3] ?? '', version: m[4] } : null
}

// Orders versions like 10.1.0 and 7.14.0a20260612: numerically, and a nightly
// ("a" and a date) is older than the release it leads up to.
export function compareRocmVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:a(\d+))?$/.exec(v)
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] === undefined ? Infinity : +m[4] } : { n: [0, 0, 0], pre: -1 }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i]
  return x.pre === y.pre ? 0 : x.pre < y.pre ? -1 : 1
}

// Which of the family's tarballs to take when there are several flavors: the
// "all" package covers every variant of the family.
const SUFFIX_RANK: Record<string, number> = { all: 0, '': 1, dgpu: 2, dcgpu: 3 }

// The newest tarball for this OS and family among the given file names.
export function pickRocmTarball(names: string[], os: RocmOs, family: string): RocmTarball | null {
  let best: RocmTarball | null = null
  for (const name of names) {
    const t = parseRocmTarball(name)
    if (!t || t.os !== os || t.family.toLowerCase() !== family.toLowerCase()) continue
    if (!best) { best = t; continue }
    const byVersion = compareRocmVersions(t.version, best.version)
    if (byVersion > 0 || (byVersion === 0 && (SUFFIX_RANK[t.suffix] ?? 9) < (SUFFIX_RANK[best.suffix] ?? 9))) best = t
  }
  return best
}

// File names to try when a host has no readable listing, for a release version
// that is known.
export function rocmTarballCandidates(os: RocmOs, family: string, version: string): string[] {
  return ['-all', '', '-dgpu', '-dcgpu'].map(s => `therock-dist-${os}-${family}${s}-${version}.tar.gz`)
}

// --------------------------------------------------------------------------
// Listings
// --------------------------------------------------------------------------

// Keys of an S3 ListObjectsV2 answer.
export function parseS3Listing(xml: string): { keys: string[]; nextToken: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1])
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
  const token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)
  return { keys, nextToken: truncated && token ? token[1] : null }
}

// Tarball names found anywhere in a page that lists them (an index page with
// links, or plain text).
export function parseHtmlListing(html: string): string[] {
  return [...new Set([...html.matchAll(/therock-dist-[A-Za-z0-9._-]+?\.tar\.gz/g)].map(m => m[0]))]
}

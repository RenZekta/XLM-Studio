// Strata-specific knowledge: model validation against setup's GGUF
// fingerprints, the launch argument builder, the Quick preset baseline and the
// memory estimator. Constants marked "mirrors setup.py" duplicate Strata's own
// numbers; scripts/strata-verify.js compares them with a cloned Strata.

// ---------------------------------------------------------------------------
// Model validation
// ---------------------------------------------------------------------------

// What an installed engine says about a model file. No architecture is
// assumed here: every GGUF is read, and each installed engine (Strata and its
// forks) answers from the data its own clone ships.
//   known       a file the engine installs, under any name
//   layout      the same routed experts as one of them (a fine-tune)
//   untested    only quantizations the engine runs, but not a file it installs
//   no          the engine's data shows it cannot run the file
//   unverified  the engine has nothing to compare this file with (an
//               architecture its table does not list, or no table at all):
//               it checks the file itself when it starts
export type StrataVerdictKind = 'known' | 'layout' | 'untested' | 'unverified' | 'no'

export interface StrataFingerprint {
  arch: string | null
  tensors: number
  bytes: number
  expertBytes: Record<string, number>
}

export interface StrataVerdict {
  kind: StrataVerdictKind
  // Set for 'known' (exact match) and suggested for 'layout' (same routed
  // experts as that file).
  family?: string
  model?: string
  detail: string
}

// One entry of data/gguf_fingerprints.json, keyed "<family>/<model>".
export interface StrataTableEntry {
  // The GGUF architecture of the files this entry was made from.
  arch?: string
  tensors: number
  bytes: number
  expert_bytes: Record<string, number>
}
export type StrataTable = Record<string, StrataTableEntry | Record<string, string[]>>

// GGML tensor type ids, as quantscope names them. Id 42 (Q2_0) is a type
// only Strata's llama.cpp fork defines.
const GGML_TYPE_NAMES: Record<number, string> = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 6: 'Q5_0', 7: 'Q5_1', 8: 'Q8_0', 9: 'Q8_1',
  10: 'Q2_K', 11: 'Q3_K', 12: 'Q4_K', 13: 'Q5_K', 14: 'Q6_K', 15: 'Q8_K', 16: 'IQ2_XXS',
  17: 'IQ2_XS', 18: 'IQ3_XXS', 19: 'IQ1_S', 20: 'IQ4_NL', 21: 'IQ3_S', 22: 'IQ2_S',
  23: 'IQ4_XS', 24: 'I8', 25: 'I16', 26: 'I32', 27: 'I64', 28: 'F64', 29: 'IQ1_M',
  30: 'BF16', 34: 'TQ1_0', 35: 'TQ2_0', 39: 'MXFP4', 42: 'Q2_0'
}

export function ggmlTypeName(id: number): string {
  return GGML_TYPE_NAMES[id] ?? `type#${id}`
}

// quantscope.category() returns "routed experts" only when no earlier
// category (norms, hyper-connections) matches, so those two are checked first.
export function isRoutedExpert(name: string): boolean {
  const n = name.toLowerCase().replace(/\//g, '.')
  if (/norm/.test(n)) return false
  if (/(hc_|_hc\.|hyper_connection)/.test(n)) return false
  return /(_exps\b|\.experts\.|experts\.\d+|block_sparse_moe\.experts)/.test(n)
}

export interface StrataTensor { name: string; type: string; bytes: number }

export function summarizeStrataTensors(arch: string | null, tensors: StrataTensor[]): StrataFingerprint {
  let bytes = 0
  const expertBytes: Record<string, number> = {}
  for (const t of tensors) {
    bytes += t.bytes
    if (isRoutedExpert(t.name)) expertBytes[t.type] = (expertBytes[t.type] ?? 0) + t.bytes
  }
  return { arch, tensors: tensors.length, bytes, expertBytes }
}

function sameBytes(a: Record<string, number>, b: Record<string, number>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every(k => a[k] === b[k])
}

function knownEntries(table: StrataTable): Array<[string, StrataTableEntry]> {
  return Object.entries(table).filter(([k]) => !k.startsWith('_')) as Array<[string, StrataTableEntry]>
}

// The architectures an engine's table has entries for.
export function strataTableArchs(table: StrataTable): string[] {
  const archs = new Set<string>()
  for (const [, v] of knownEntries(table)) if (v.arch) archs.add(v.arch)
  return [...archs].sort()
}

// Same decision as tools/strata_inspect.py, taken over the entries of the
// file's own architecture: 'known' is a file setup installs (under any name),
// 'layout' has the same routed experts as one, 'untested' uses only expert
// quantizations the engine runs, 'no' cannot run. An architecture with no
// entry is not refused: the table says nothing about it ('unverified').
export function strataVerdict(fp: StrataFingerprint, table: StrataTable): StrataVerdict {
  const known = knownEntries(table).filter(([, v]) => !!fp.arch && v.arch === fp.arch)
  if (known.length === 0) {
    const archs = strataTableArchs(table)
    return {
      kind: 'unverified',
      detail: `This engine's file table has no ${fp.arch ?? 'unknown'} model${archs.length ? ` (it lists ${archs.join(', ')})` : ''}, so it checks the file itself when it starts.`
    }
  }
  const exact = known.find(([, v]) => sameBytes(v.expert_bytes, fp.expertBytes) && v.bytes === fp.bytes && v.tensors === fp.tensors)
  if (exact) {
    const [family, model] = exact[0].split('/')
    return { kind: 'known', family, model, detail: `A file the engine installs: ${family} / ${model}.` }
  }
  const same = known.filter(([, v]) => sameBytes(v.expert_bytes, fp.expertBytes)).map(([k]) => k)
  if (same.length) {
    const [family, model] = same[0].split('/')
    return {
      kind: 'layout', family, model,
      detail: `Routed experts stored exactly as in ${same.join(' / ')}; a fine-tune with the same recipe, not tested.`
    }
  }
  const runs = new Set<string>()
  for (const [, v] of known) for (const t of Object.keys(v.expert_bytes)) runs.add(t)
  const other = Object.keys(fp.expertBytes).filter(t => !runs.has(t)).sort()
  if (other.length) {
    return { kind: 'no', detail: `Routed experts use ${other.join(', ')}, which no file this engine runs uses.` }
  }
  return { kind: 'untested', detail: 'Routed experts use only quantizations the engine runs, but the file is not one setup installs.' }
}

// The verdict of an engine that ships no file table.
export const STRATA_NO_TABLE: StrataVerdict = {
  kind: 'unverified',
  detail: 'This engine ships no file table to compare with, so it checks the file itself when it starts.'
}

// Best answer first: what the model list and the engine suggestion show when
// several installed engines each have their own verdict.
const KIND_RANK: Record<StrataVerdictKind, number> = { known: 4, layout: 3, untested: 2, unverified: 1, no: 0 }

export function bestStrataInfo<T extends { kind: StrataVerdictKind }>(byEngine: Record<string, T>): { key: string; info: T } | null {
  let best: { key: string; info: T } | null = null
  for (const [key, info] of Object.entries(byEngine)) {
    if (!best || KIND_RANK[info.kind] > KIND_RANK[best.info.kind]) best = { key, info }
  }
  return best
}

// The verdict that applies to one engine (a repo's backend key) when the
// Template names it, else the best one.
export interface StrataInfoLike extends StrataVerdict { tableHash?: string; engineKey?: string }

export function strataInfoFor(
  meta: { strata?: StrataInfoLike; strataEngines?: Record<string, StrataInfoLike> } | null | undefined,
  backendKey?: string | null
): StrataInfoLike | undefined {
  if (!meta) return undefined
  if (backendKey && meta.strataEngines?.[backendKey]) return meta.strataEngines[backendKey]
  return meta.strata
}

// Cheap content hash of the known entries, used to notice when a newer
// Strata ships a different table so cached verdicts can be recomputed.
export function strataTableHash(table: StrataTable): string {
  const s = JSON.stringify(knownEntries(table).map(([k, v]) => [k, v.arch, v.tensors, v.bytes, v.expert_bytes]))
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

// ---------------------------------------------------------------------------
// Variants (mirrors setup.py MODELS): experts size and RAM guidance in GB.
// ---------------------------------------------------------------------------

export interface StrataVariant { arenaGb: number; ramGb: number; nvidiaOnly: boolean }

export const STRATA_VARIANTS: Record<string, StrataVariant> = {
  'Q2_0': { arenaGb: 34.0, ramGb: 48, nvidiaOnly: false },
  'IQ2_XS': { arenaGb: 35.5, ramGb: 48, nvidiaOnly: false },
  'IQ3_XXS': { arenaGb: 42.9, ramGb: 60, nvidiaOnly: false },
  'IQ3_S': { arenaGb: 50.3, ramGb: 62, nvidiaOnly: false },
  'IQ1_M': { arenaGb: 23.4, ramGb: 32, nvidiaOnly: false },
  'UD-IQ4_XS': { arenaGb: 59.5, ramGb: 48, nvidiaOnly: false },
  'UD-Q4_K_XL': { arenaGb: 77.0, ramGb: 48, nvidiaOnly: true }
}

// ---------------------------------------------------------------------------
// Defaults (what setup picks for a flag that is left out)
// ---------------------------------------------------------------------------

// The menu steps of setup's context question; any integer is accepted.
export const STRATA_CONTEXTS = [8192, 32768, 65536, 131072, 204800, 262144, 393216, 524288]
// The model's trained context. Past it setup scales RoPE with yarn.
export const STRATA_NATIVE_CONTEXT = 262144

// Flags shown in the editor's Common view; everything else is Full only.
export const STRATA_COMMON_FLAGS = new Set([
  '--vision', '--context', '--kv', '--kv-streaming', '--rope-scaling', '--rope-scale', '--parallel', '--low-ram'
])

export interface StrataDefaultsInput {
  variant?: string | null
  family?: string | null
  // Installed (not free) memory: setup sizes its recommendation on the cards
  // and RAM the PC has, whatever else is running.
  vramTotalGb: number
  ramTotalGb: number
  // The context to derive the RoPE defaults from (the chosen one, else the
  // recommendation).
  context?: number | null
  vision?: string | null
}

// Mirrors setup.py's recommended context: 32K, 64K or 128K by the smallest
// GPU's VRAM (8K or 32K for the Unsloth variants, whose experts need the
// room), capped by the longest context the RAM rule allows (setup.py
// rec_ctx and ram_ctx).
export function strataRecommendedContext(i: StrataDefaultsInput): number {
  const unsloth = !!i.variant && i.variant.startsWith('UD-')
  const vram = i.vramTotalGb
  let rec = unsloth
    ? (vram < 14 ? 8192 : 32768)
    : (vram < 14 ? 32768 : vram < 20 ? 65536 : 131072)
  const variant = i.variant ? STRATA_VARIANTS[i.variant] : undefined
  if (variant && i.ramTotalGb > 0) {
    const iq3 = i.variant === 'IQ3_XXS' || i.variant === 'IQ3_S'
    const lowRam = i.ramTotalGb < variant.arenaGb + STRATA_LOW_RAM_HEADROOM_GB
    const ramCap = Math.max(...STRATA_CONTEXTS.filter(c => {
      if (c <= 131072) return true
      if (c === 204800) return false
      const need = iq3 && !lowRam ? variant.arenaGb + c * STRATA_KV_CELLS_PER_TOKEN * STRATA_KV_CELL_BYTES.int8 / 1e9 + STRATA_IQ3_RAM_HEADROOM_GB : 0
      return need <= i.ramTotalGb
    }))
    rec = Math.min(rec, ramCap)
  }
  return rec
}

// The value each flag takes when it is not passed, so the editor can show it.
// Flags with no fixed default (GPU choice, split, API key) are left out.
export function strataDefaults(i: StrataDefaultsInput): Record<string, string | number> {
  const context = i.context && i.context > 0 ? i.context : strataRecommendedContext(i)
  const beyond = context > STRATA_NATIVE_CONTEXT
  const out: Record<string, string | number> = {
    // No '--vision': Automatic is the empty choice, and sends nothing.
    '--vision-tokens': i.vision === 'cpu' ? 300 : 1024,
    '--context': strataRecommendedContext(i),
    '--kv': 'int8',
    '--kv-streaming': 'auto',
    '--rope-scaling': beyond ? 'yarn' : 'none',
    '--rope-scale': beyond ? Math.round(context / STRATA_NATIVE_CONTEXT * 100) / 100 : 1,
    '--backend': 'cuda',
    '--vram-reserve-mib': STRATA_DEFAULT_RESERVE_MIB,
    '--parallel': 1,
    '--low-ram': 'auto',
    '--draft-vocab': 'cjk',
    '--experimental-speed-projection': 'off',
    '--host': '127.0.0.1'
  }
  if (i.family) out['--family'] = i.family
  if (i.variant) out['--model'] = i.variant
  if (i.variant && i.variant.startsWith('UD-') && i.ramTotalGb > 0) out['--resident-budget-gib'] = Math.max(1, Math.floor(i.ramTotalGb - 24))
  return out
}

// ---------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------

export type StrataArgValue = string | number | boolean | null | undefined

export interface StrataLaunchInput {
  // Folder holding every shard of the model (setup picks the set by name).
  ggufDir: string
  family?: string | null
  model?: string | null
  port: number
  args: Record<string, StrataArgValue>
  // Global overrides win over the template's own values.
  host?: string | null
  apiKey?: string | null
  dataDir?: string | null
}

// Flags the builder writes itself.
const OWN_FLAGS = new Set(['--family', '--model', '--host', '--api-key', '--port', '--gguf-dir', '--data-dir', '--yes', '--no-browser'])

// Settings setup keeps from an earlier run of the same model when a flag is
// left out, so a template that leaves one on Auto must send its default to
// avoid inheriting another template's value. --vision is not here on
// purpose: Automatic sends nothing, which is setup's own default (images on
// where the model can read them).
const STICKY_DEFAULTS: Array<[string, string]> = [
  ['--parallel', '1'],
  ['--draft-vocab', 'cjk']
]

function textOf(v: StrataArgValue): string {
  return v === null || v === undefined ? '' : String(v).trim()
}

// A trailing backslash before the closing quote is read as an escaped quote
// by the program the Windows launcher hands its arguments to.
export function cleanPathArg(p: string): string {
  if (p.length > 3 && /[\\/]$/.test(p)) return p.replace(/[\\/]+$/, '')
  return /[\\/]$/.test(p) ? p + '.' : p
}

// The folder holding a model's shards, as setup's --gguf-dir wants it.
export function strataGgufDir(modelPath: string): string {
  const i = Math.max(modelPath.lastIndexOf('/'), modelPath.lastIndexOf('\\'))
  return cleanPathArg(i < 0 ? '.' : modelPath.slice(0, i + 1))
}

// Arguments for START-HERE.bat / setup.sh. --yes answers any prompt a flag
// does not, and --no-browser keeps setup from opening the system browser.
export function buildStrataArgv(input: StrataLaunchInput): { argv: string[] } | { error: string } {
  const family = textOf(input.args['--family']) || textOf(input.family)
  const model = textOf(input.args['--model']) || textOf(input.model)
  if (!family || !model) {
    return { error: 'Strata needs to know which model family and variant this GGUF is. Pick them in the Template.' }
  }
  const argv = ['--yes', '--no-browser', '--family', family, '--model', model, '--gguf-dir', input.ggufDir, '--port', String(input.port)]
  if (input.dataDir) argv.push('--data-dir', input.dataDir)

  const host = textOf(input.host) || textOf(input.args['--host'])
  if (host) argv.push('--host', host)
  const apiKey = textOf(input.apiKey) || textOf(input.args['--api-key'])
  if (apiKey) argv.push('--api-key', apiKey)

  const sent = new Set<string>()
  for (const [key, value] of Object.entries(input.args)) {
    if (!key.startsWith('--') || OWN_FLAGS.has(key)) continue
    if (value === false || value === null || value === undefined) continue
    if (value === true) { argv.push(key); sent.add(key); continue }
    const text = String(value).trim()
    if (!text) continue
    argv.push(key, text)
    sent.add(key)
  }
  for (const [flag, def] of STICKY_DEFAULTS) {
    if (!sent.has(flag)) argv.push(flag, def)
  }
  return { argv }
}

// ---------------------------------------------------------------------------
// Quick preset
// ---------------------------------------------------------------------------

// The llama.cpp Quick baseline restricted to what Strata has an equivalent
// for: context size, KV precision (q8_0 maps to int8) and image input.
export function buildStrataQuickBaseline(opts: { contextLength?: number | null; hasVision?: boolean }): Record<string, string | number | boolean | null> {
  const ctx = opts.contextLength && opts.contextLength > 0 ? Math.min(opts.contextLength, 32768) : 32768
  const out: Record<string, string | number | boolean | null> = { '--context': ctx, '--kv': 'int8' }
  if (opts.hasVision) out['--vision'] = 'yes'
  return out
}

// ---------------------------------------------------------------------------
// Memory estimate (mirrors setup.py low_ram_gpu_gb / ctx_ram_need)
// ---------------------------------------------------------------------------

export const STRATA_KV_CELL_BYTES: Record<string, number> = { int8: 1056, q4_0: 576, k8v4: 816 }
// 12 attention layers plus the draft layer keep KV.
export const STRATA_KV_CELLS_PER_TOKEN = 13
// Dense weights, buffers and a 32K context's KV cache.
export const STRATA_BASE_VRAM_GB = 5
export const STRATA_BASE_CONTEXT = 32768
export const STRATA_VISION_VRAM_GB = 1.4

// Setup's rule for the image encoder when it is not told which (the same one
// for "yes" and for nothing at all): the CPU under 24 GB of VRAM, the GPU
// from 24 GB. 'none' is text only.
export const STRATA_IMAGES_GPU_MIN_VRAM_GB = 23.5
export function strataVisionReader(choice: string | number | boolean | null | undefined, vramGb: number): 'none' | 'cpu' | 'gpu' {
  const c = String(choice ?? '').trim()
  if (c === 'no' || c === 'none') return 'none'
  if (c === 'cpu' || c === 'gpu') return c
  return vramGb <= 0 || vramGb >= STRATA_IMAGES_GPU_MIN_VRAM_GB ? 'gpu' : 'cpu'
}
export const STRATA_DEFAULT_RESERVE_MIB = 700
export const STRATA_LOW_RAM_HEADROOM_GB = 10
export const STRATA_IQ3_RAM_HEADROOM_GB = 24
// KV streaming (auto) starts from this context.
const KV_STREAMING_FROM = 65536

export interface StrataMemoryInput {
  variant: string
  context: number
  kv?: string | null
  vision?: boolean
  kvStreaming?: string | null
  lowRam?: string | null
  reserveMib?: number | null
  vramGb: number
  ramGb: number
}

export interface StrataMemoryEstimate {
  kvBytesPerToken: number
  kvGb: number
  // True when the KV cache beyond the base context lives in RAM.
  kvInRam: boolean
  arenaGb: number
  // The experts' share held by the GPU cache, in GB and as a fraction.
  expertCacheGb: number
  gpuShare: number
  lowRam: boolean
  // RAM estimate for the experts plus context, and the RAM that is enough.
  ramNeedGb: number
  fitsRam: boolean
}

export function estimateStrataMemory(i: StrataMemoryInput): StrataMemoryEstimate | null {
  const variant = STRATA_VARIANTS[i.variant]
  if (!variant) return null
  const cell = STRATA_KV_CELL_BYTES[i.kv ?? 'int8'] ?? STRATA_KV_CELL_BYTES.int8
  const kvBytesPerToken = STRATA_KV_CELLS_PER_TOKEN * cell
  const lowRam = i.lowRam === 'on' || i.lowRam === 'mmap' || i.lowRam === 'resident'
    ? true
    : i.lowRam === 'off' ? false : i.ramGb < variant.arenaGb + STRATA_LOW_RAM_HEADROOM_GB
  const streaming = i.kvStreaming ?? 'auto'
  const kvInRam = streaming === 'on' || (streaming === 'auto' && !lowRam && i.context >= KV_STREAMING_FROM)
  const longerKvGb = kvInRam ? 0 : Math.max(0, i.context - STRATA_BASE_CONTEXT) * kvBytesPerToken / 1e9
  const reserveGb = (i.reserveMib ?? STRATA_DEFAULT_RESERVE_MIB) / 1024
  const fixedGb = STRATA_BASE_VRAM_GB + longerKvGb + (i.vision ? STRATA_VISION_VRAM_GB : 0) + reserveGb
  const expertCacheGb = Math.max(0, Math.min(variant.arenaGb, i.vramGb - fixedGb))
  const iq3 = i.variant === 'IQ3_XXS' || i.variant === 'IQ3_S'
  const kvRamGb = kvInRam ? i.context * kvBytesPerToken / 1e9 : 0
  const ramNeedGb = lowRam
    ? variant.arenaGb - expertCacheGb + STRATA_LOW_RAM_HEADROOM_GB
    : variant.arenaGb + kvRamGb + (iq3 ? STRATA_IQ3_RAM_HEADROOM_GB : STRATA_LOW_RAM_HEADROOM_GB)
  return {
    kvBytesPerToken,
    kvGb: i.context * kvBytesPerToken / 1e9,
    kvInRam,
    arenaGb: variant.arenaGb,
    expertCacheGb,
    gpuShare: variant.arenaGb > 0 ? expertCacheGb / variant.arenaGb : 0,
    lowRam,
    ramNeedGb,
    fitsRam: i.ramGb >= ramNeedGb
  }
}

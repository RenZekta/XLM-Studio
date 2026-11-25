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

export interface StrataVariant {
  arenaGb: number
  ramGb: number
  // Unsloth-style file: no low-RAM mode; part of the experts is read from the file within a RAM budget.
  budget: boolean
  nvidiaOnly: boolean
}

export const STRATA_VARIANTS: Record<string, StrataVariant> = {
  'Q2_0': { arenaGb: 34.0, ramGb: 48, budget: false, nvidiaOnly: false },
  'IQ2_XS': { arenaGb: 35.5, ramGb: 48, budget: false, nvidiaOnly: false },
  'IQ3_XXS': { arenaGb: 42.9, ramGb: 60, budget: false, nvidiaOnly: false },
  'IQ3_S': { arenaGb: 50.3, ramGb: 62, budget: false, nvidiaOnly: false },
  'IQ1_M': { arenaGb: 23.4, ramGb: 32, budget: false, nvidiaOnly: false },
  'UD-IQ4_XS': { arenaGb: 59.5, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-Q4_K_XL': { arenaGb: 77.0, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-Q5_K_XL': { arenaGb: 98.4, ramGb: 108, budget: true, nvidiaOnly: false },
  'UD-Q6_K_XL': { arenaGb: 109.2, ramGb: 118, budget: true, nvidiaOnly: false },
  'Q8_0': { arenaGb: 128.3, ramGb: 136, budget: true, nvidiaOnly: false },
  'UD-IQ1_M': { arenaGb: 34.8, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-Q2_0': { arenaGb: 37.4, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-IQ2_XS': { arenaGb: 42.3, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-Q2_K_XL': { arenaGb: 46.0, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-IQ3_XXS': { arenaGb: 50.3, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-Q3_K_XL': { arenaGb: 56.2, ramGb: 48, budget: true, nvidiaOnly: false },
  'UD-IQ4_XS-v31': { arenaGb: 60.4, ramGb: 48, budget: true, nvidiaOnly: false },
  'Gyro-S': { arenaGb: 25.8, ramGb: 27.6, budget: false, nvidiaOnly: false },
  'Gyro-M': { arenaGb: 32.1, ramGb: 35.0, budget: false, nvidiaOnly: false },
  'NVFP4': { arenaGb: 68.0, ramGb: 80, budget: false, nvidiaOnly: true },
  'NVFP4-NVIDIA': { arenaGb: 68.0, ramGb: 80, budget: false, nvidiaOnly: true },
  'NVFP4-QAD': { arenaGb: 68.0, ramGb: 80, budget: false, nvidiaOnly: true }
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

// Categories shown whole in the Common view.
export const STRATA_COMMON_CATEGORIES = new Set(['Speculative Decoding'])

export function strataIsCommon(flag: string, category: string): boolean {
  return STRATA_COMMON_FLAGS.has(flag) || STRATA_COMMON_CATEGORIES.has(category)
}

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
  const unsloth = !!i.variant && (STRATA_VARIANTS[i.variant]?.budget ?? i.variant.startsWith('UD-'))
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

// setup.py UNSLOTH_BUDGET_LEFT_GB, UNSLOTH_RESIDENT_BESIDE_GB, NOMINAL_RAM_GB and NOMINAL_RAM_MARGIN.
const UNSLOTH_BUDGET_LEFT_GB = 17
const UNSLOTH_RESIDENT_BESIDE_GB = 16
const NOMINAL_RAM_GB = [16, 24, 32, 48, 64, 96, 128, 192, 256]
const NOMINAL_RAM_MARGIN = 0.03

// A reading just under the size a PC is sold with (a "64 GB" Windows PC reads 63.1) counts as that size.
function nominalRamGb(ram: number): number {
  const size = NOMINAL_RAM_GB.find(s => ram <= s) ?? Math.ceil(ram / 8) * 8
  return size * (1 - NOMINAL_RAM_MARGIN) <= ram && ram <= size ? size : ram
}

// Python's round() takes a half to the even neighbour.
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

// Mirrors setup.py resident_budget_gib and unsloth_budget; null when setup writes no budget.
// A unified-memory GPU keeps 24 GiB beside the budget instead of 17 but cannot be detected here.
export function strataResidentBudgetGib(variant: string, ramGb: number, kvRamGb = 0): number | null {
  const v = STRATA_VARIANTS[variant]
  if (!v?.budget || !(ramGb > 0)) return null
  const arenaGib = v.arenaGb / 1.073741824
  if (ramGb >= arenaGib + UNSLOTH_RESIDENT_BESIDE_GB) return null
  const gib = roundHalfEven(nominalRamGb(ramGb)) - UNSLOTH_BUDGET_LEFT_GB - Math.ceil(kvRamGb)
  return Math.max(8, Math.min(gib, Math.floor(arenaGib)))
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
    '--mtp': 'on',
    '--cuda': 'auto',
    '--source': 'auto',
    '--image-gpu-policy': 'auto',
    '--image-native': 'off',
    '--image-noise': 'off',
    '--image-vae': 'off',
    '--drafter': 'auto',
    '--draft-vocab': 'cjk',
    '--experimental-speed-projection': 'off',
    '--host': '127.0.0.1'
  }
  if (i.family) out['--family'] = i.family
  if (i.variant) out['--model'] = i.variant
  const shape = shapeOf(i.family)
  if (shape) {
    // Settings of the Flash-Next path that these families do not have.
    for (const flag of ['--kv', '--kv-streaming', '--rope-scaling', '--rope-scale', '--low-ram', '--mtp', '--draft-vocab']) delete out[flag]
    out['--context'] = shape.context
    return out
  }
  const budget = i.variant ? strataResidentBudgetGib(i.variant, i.ramTotalGb) : null
  if (budget !== null) out['--resident-budget-gib'] = budget
  return out
}

// ---------------------------------------------------------------------------
// Drafter
// ---------------------------------------------------------------------------

// strata_control/drafting.py SUPPORTED_FAMILIES.
export const STRATA_DFLASH2_FAMILIES = ['qwen', 'gyro', 'unsloth']

// The families with their own installer and engine (setup.py HY4_FAMILIES and
// INKLING_FAMILIES). Each ships one drafter (strata_control/hy4_family.py and
// inkling_family.py DEFAULT_DRAFTER, DRAFTERS) and has its own default context
// (hy4_fit.py and inkling_fit.py DEFAULT_CONTEXT). They have no MTP layer, no
// draft vocabulary, no resident budget and no Flash-Next KV or RoPE settings.
export const STRATA_SHAPE_FAMILIES: Record<string, { title: string; drafter: string; drafterLabel: string; context: number }> = {
  'hy4-flash': { title: 'Hy4-Flash', drafter: 'dfly2', drafterLabel: 'DFly2', context: 131072 },
  'inkling-2-mini': { title: 'Inkling-2-Mini', drafter: 'dspark', drafterLabel: 'DSpark', context: 32768 }
}

// KV modes setup.py passes to the Inkling engine (the rest are ignored there).
export const STRATA_INKLING_KV = ['fp16', 'fp8', 'k8v8', 'k8v4']
// Settings Hy4-Flash does not use (setup.py install_hy4_flash warns about them).
const HY4_UNUSED_FLAGS = ['--rope-scaling', '--rope-scale', '--kv', '--resident-budget-gib', '--low-ram']

function shapeOf(family: string | null | undefined) {
  return STRATA_SHAPE_FAMILIES[textOf(family).toLowerCase()]
}

export function strataDrafterWarning(
  drafter: string | number | boolean | null | undefined,
  family: string | null | undefined
): string {
  const d = textOf(drafter)
  const fam = textOf(family).toLowerCase()
  const shape = shapeOf(family)
  if (d === 'dfly2' || d === 'dspark') {
    const owner = Object.values(STRATA_SHAPE_FAMILIES).find(s => s.drafter === d)
    if (owner && fam && shape?.drafter !== d) return `${owner.drafterLabel} is the drafter of ${owner.title} only; other families ignore it.`
    return ''
  }
  if (shape && (d === 'mtp' || d === 'dflash2')) {
    return `${shape.title} drafts with ${shape.drafterLabel}; ${d === 'mtp' ? 'MTP' : 'DFlash2'} is read as Auto there.`
  }
  if (d !== 'dflash2') return ''
  if (fam && !STRATA_DFLASH2_FAMILIES.includes(fam)) {
    return `DFlash2 supports only the ${STRATA_DFLASH2_FAMILIES.join(', ')} families. Other families fall back to the MTP, which is not downloaded when DFlash2 is selected.`
  }
  return ''
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
export const STRATA_OWN_FLAGS = new Set(['--family', '--model', '--host', '--api-key', '--port', '--gguf-dir', '--data-dir', '--yes', '--no-browser'])

// setup.py flags a Template never sends: actions that stop short of serving, --browser (undoes the
// --no-browser every launch sends), the data folder rewriters (XLM owns that setting) and --output
// (jsonl replaces the log lines the Logs view and the ready check read).
export const STRATA_ACTION_FLAGS = new Set([
  '--setup', '--no-start', '--check', '--update', '--rollback-engine', '--inspect', '--prepare-pack',
  '--browser', '--move-data', '--set-default-data-dir', '--output'
])

// Settings setup keeps from an earlier run of the same model when a flag is
// left out, so a template that leaves one on Auto must send its default to
// avoid inheriting another template's value. --vision is not here on
// purpose: Automatic sends nothing, which is setup's own default (images on
// where the model can read them).
const STICKY_DEFAULTS: Array<[string, string]> = [
  ['--parallel', '1'],
  ['--draft-vocab', 'cjk'],
  ['--mtp', 'on']
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
    if (!key.startsWith('--') || STRATA_OWN_FLAGS.has(key) || STRATA_ACTION_FLAGS.has(key)) continue
    if (value === false || value === null || value === undefined) continue
    if (value === true) { argv.push(key); sent.add(key); continue }
    if (Array.isArray(value)) {
      for (const item of value) if (String(item).trim() !== '') argv.push(key, String(item).trim())
      if (value.length > 0) sent.add(key)
      continue
    }
    const text = String(value).trim()
    if (!text) continue
    argv.push(key, text)
    sent.add(key)
  }
  // Hy4-Flash and Inkling-2-Mini keep none of these between runs.
  if (!shapeOf(family)) {
    for (const [flag, def] of STICKY_DEFAULTS) {
      if (!sent.has(flag)) argv.push(flag, def)
    }
  }
  return { argv }
}

// ---------------------------------------------------------------------------
// Quick preset
// ---------------------------------------------------------------------------

// The llama.cpp Quick baseline restricted to what Strata has an equivalent
// for: context size and KV precision (q8_0 maps to int8). Image input is not in
// it: Automatic (nothing sent) is what Quick and Full Auto both use, so Strata
// picks the reader itself, with the encoder on the CPU, instead of Quick taking
// the GPU reader ("yes") for every model that has a projector.
// Hy4-Flash and Inkling-2-Mini have no int8 KV cache, so with their family known it is context only.
export function buildStrataQuickBaseline(opts: { contextLength?: number | null; family?: string | null }): Record<string, string | number | boolean | null> {
  const ctx = opts.contextLength && opts.contextLength > 0 ? Math.min(opts.contextLength, 32768) : 32768
  return shapeOf(opts.family) ? { '--context': ctx } : { '--context': ctx, '--kv': 'int8' }
}

// ---------------------------------------------------------------------------
// Memory estimate (mirrors setup.py low_ram_gpu_gb / ctx_ram_need)
// ---------------------------------------------------------------------------

// Bytes per token and attention layer (setup.py UD_FIT_KV_BYTES).
export const STRATA_KV_CELL_BYTES: Record<string, number> = { int8: 1056, q4_0: 576, k8v4: 816, fp16: 2112 }
// 12 attention layers plus the draft layer keep KV.
export const STRATA_KV_CELLS_PER_TOKEN = 13
// Dense weights, buffers and a 32K context's KV cache.
export const STRATA_BASE_VRAM_GB = 5
// Template combinations that setup refuses or ignores, one sentence each.
export function strataLaunchWarnings(
  args: Record<string, StrataArgValue>,
  family: string | null | undefined
): string[] {
  const out: string[] = []
  const set = (flag: string) => textOf(args[flag]) !== ''
  const drafter = strataDrafterWarning(args['--drafter'], family)
  if (drafter) out.push(drafter)
  if (textOf(args['--drafter']) === 'mtp' && textOf(args['--mtp']) === 'off') {
    out.push('MTP Draft Layer Off is ignored when the Drafter is MTP.')
  }
  const fam = textOf(family).toLowerCase()
  const kv = textOf(args['--kv'])
  if (fam === 'hy4-flash') {
    const unused = HY4_UNUSED_FLAGS.filter(f => set(f) && !(f === '--low-ram' && textOf(args[f]) === 'auto'))
    if (unused.length) out.push('Hy4-Flash does not use KV Cache Precision, RoPE scaling, Resident Budget or Low RAM; they are ignored.')
  } else if (fam === 'inkling-2-mini') {
    if (kv && !STRATA_INKLING_KV.includes(kv)) {
      out.push(`Inkling-2-Mini takes KV Cache Precision ${STRATA_INKLING_KV.join(', ')}; ${kv} is ignored.`)
    }
  } else if (fam && (kv === 'fp8' || kv === 'k8v8')) {
    out.push('KV Cache Precision fp8 and k8v8 are for Inkling-2-Mini; other families do not use them.')
  }
  // setup.py rejects --gpu-roles together with --gpu or --gpus.
  if (set('--gpu-roles') && (set('--gpus') || set('--gpu'))) {
    out.push('GPU Roles cannot be combined with GPUs or Single GPU; the launch fails.')
  }
  const split = textOf(args['--layer-split']).toLowerCase()
  const manualSplit = split !== '' && split !== 'auto'
  const replicas = Number(textOf(args['--replicas']))
  if (replicas >= 2 && manualSplit) {
    out.push('A manual Layer Split would apply to every replica; leave it on auto.')
  }
  if (args['--replica-profile'] === true && (replicas >= 2 || manualSplit)) {
    out.push('Replicas or a manual Layer Split override Replica Profile.')
  }
  if (textOf(args['--images']) !== 'qwen-image') {
    const sub = ['--image-quant', '--image-backend', '--image-gpu-policy', '--image-native', '--image-noise', '--image-vae'].filter(set)
    if (sub.length) out.push('Image options have no effect unless Image Generation is set to Qwen-Image.')
  }
  return out
}

// VRAM of the draft layer, taken from the expert cache (setup.py MTP_VRAM_GB).
export const STRATA_MTP_VRAM_GB = 1
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
  const fixedGb = STRATA_BASE_VRAM_GB + STRATA_MTP_VRAM_GB + longerKvGb + (i.vision ? STRATA_VISION_VRAM_GB : 0) + reserveGb
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

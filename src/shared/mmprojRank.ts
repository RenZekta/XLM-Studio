// A model folder can hold several multimodal projector files of the same
// model in different precisions (mmproj-BF16.gguf, mmproj-F16.gguf, mmproj-Q8_0.gguf).
// They are ranked so the most accurate one is used unless one is chosen.

interface QuantTag {
  label: string
  rank: number
  re: RegExp
}

// Whole tokens of the file name: "mmproj-F16.gguf" and "model_mmproj_bf16" both
// count, "bf16" is not read as "f16". More specific quantizations come first.
const tok = (name: string) => new RegExp(`(?:^|[^a-z0-9])${name}(?=[^a-z0-9]|$)`, 'i')

// bf16 > f16 > q8 > q4_K_M > q4_0; the precisions the order leaves out (f32,
// q6, q5, the other q4 kinds) sit where their size and accuracy put them.
const QUANTS: QuantTag[] = [
  { label: 'BF16', rank: 0, re: tok('bf16') },
  { label: 'F16', rank: 1, re: tok('f16') },
  { label: 'F32', rank: 2, re: tok('f32') },
  { label: 'Q8_0', rank: 3, re: tok('q8') },
  { label: 'Q6_K', rank: 4, re: tok('q6') },
  { label: 'Q5_K_M', rank: 5, re: tok('q5') },
  { label: 'Q4_K_M', rank: 6, re: /(?:^|[^a-z0-9])q4_k_m(?=[^a-z0-9]|$)/i },
  { label: 'Q4_K_S', rank: 7, re: /(?:^|[^a-z0-9])q4_k(?:_s)?(?=[^a-z0-9]|$)/i },
  { label: 'Q4_1', rank: 8, re: /(?:^|[^a-z0-9])q4_1(?=[^a-z0-9]|$)/i },
  { label: 'Q4_0', rank: 9, re: /(?:^|[^a-z0-9])q4_0(?=[^a-z0-9]|$)/i },
  { label: 'Q4', rank: 8.5, re: tok('q4') }
]

const UNKNOWN_RANK = 20

function tagOf(fileName: string): QuantTag | null {
  const name = fileName.replace(/\.(gguf|bin)$/i, '')
  return QUANTS.find(q => q.re.test(name)) ?? null
}

export function mmprojQuant(fileName: string): string | null {
  return tagOf(fileName)?.label ?? null
}

export function mmprojRank(fileName: string): number {
  return tagOf(fileName)?.rank ?? UNKNOWN_RANK
}

// Best first: by precision rank, then the larger file, then by name, so the
// order never depends on the order the folder was read in.
export function sortMmprojs<T extends { name: string; size: number }>(files: T[]): T[] {
  return [...files].sort((a, b) => mmprojRank(a.name) - mmprojRank(b.name) || b.size - a.size || a.name.localeCompare(b.name))
}

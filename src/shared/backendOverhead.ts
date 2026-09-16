// Best-effort detection of which GPU runtime a backend build uses, purely
// from its own naming (folder/version/display name) — there's no dedicated
// structured field for this today, but llama.cpp release names conventionally
// embed it (e.g. "...-cuda-cu12.4-x64", "...-vulkan-x64", "...-hip-x64").
// Used only to pick a sensible DEFAULT VRAM overhead per backend the first
// time a Template is created — never overrides a value the user has already
// set, and the user can always override the detected default manually.
export type BackendRuntimeType = 'cuda' | 'rocm' | 'vulkan' | 'cpu' | 'unknown'

export function detectBackendRuntimeType(backend: { name?: string; displayName?: string; backendKey?: string; exe?: string; path?: string } | null | undefined): BackendRuntimeType {
  if (!backend) return 'unknown'
  const haystack = [backend.name, backend.displayName, backend.backendKey, backend.exe, backend.path]
    .filter(Boolean).join(' ').toLowerCase()
  if (/\bcuda\b|\bcu\d/.test(haystack)) return 'cuda'
  if (/\brocm\b|\bhip\b/.test(haystack)) return 'rocm'
  if (/\bvulkan\b|\bvk\b/.test(haystack)) return 'vulkan'
  if (/\bcpu\b|\bavx/.test(haystack)) return 'cpu'
  return 'unknown'
}

// Midpoint of each range the user measured/reported:
//   CUDA:   500 MB – 1 GB   -> 750 MB
//   ROCm:   400 – 750 MB    -> 575 MB
//   Vulkan: 50 – 150 MB     -> 100 MB
//   CPU-only / unknown: no discrete GPU runtime context to reserve for.
export function defaultVramOverheadForBackend(type: BackendRuntimeType): number {
  switch (type) {
    case 'cuda': return 750
    case 'rocm': return 575
    case 'vulkan': return 100
    default: return 0
  }
}

// RAM-side overhead (mmap page-cache pressure, tokenizer/vocab tables) is
// far less backend-dependent than the VRAM-side driver/runtime context is —
// it's dominated by the OS and model vocab size, not which GPU API is in
// use. A flat, modest default.
export const DEFAULT_RAM_OVERHEAD_MB = 512

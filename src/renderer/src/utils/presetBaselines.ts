// The Quick-preset engine baseline is computed synchronously, with no effect
// and no race window, directly in CreateModal's lazy useState(() => ...)
// initializer for `args`. A lazy initializer runs exactly once, during the
// very first render, before anything can possibly commit and get clobbered.
// This function is the single source of truth for that baseline, shared by:
//   - CreateModal.tsx's lazy args initializer (new template creation)
//   - CmdParamsEditor.tsx's handleQuickPreset() (the Quick button, and
//     re-deriving --ctx-size/--gpu-layers once model metadata becomes
//     available, which isn't known synchronously at template-creation time)
//
// Deliberately excluded from this baseline: sampling values (temperature/
// top-p/etc — never touched by engine presets, see SAMPLING_KEYS in
// CmdParamsEditor.tsx) and --ctx-size/--gpu-layers (need GGUF metadata +
// VRAM budget, unavailable synchronously before a model is even picked —
// CmdParamsEditor's own effects fill these in once that data exists).

export interface CpuInfoLike {
  physicalCores?: number
}

export function computeRecommendedThreads(
  cpuInfo: CpuInfoLike | null | undefined,
  // "Recommended CPU Threads override" (Settings) — when provided, replaces
  // the built-in 75% default with a user-chosen percentage of physical
  // cores, always rounded to a whole core count (never "1.5 cores").
  overridePercent?: number | null
): number {
  const physicalCores = cpuInfo?.physicalCores || 8
  if (overridePercent !== undefined && overridePercent !== null) {
    const pct = Math.max(0, Math.min(100, overridePercent))
    return Math.max(1, Math.round((pct / 100) * physicalCores))
  }
  return Math.max(1, Math.floor(physicalCores * 0.75))
}

export function defaultKvQuantFor(backendKey: string | undefined | null): string {
  // See the identical note in CmdParamsEditor.tsx —
  // turbo3 was silently getting K upgraded to q8_0 by llama.cpp's own
  // asymmetry safety fallback; turbo4 avoids that and is the better default.
  return backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo4' : 'q8_0'
}

// K and V are allowed to (and, for the atomic/TurboQuant backend, should)
// differ: Keys are more sensitive to quantization than Values, so the
// atomic backend's own recommendation is K=turbo4 / V=turbo3 — turbo4 keeps
// the K cache safely above llama.cpp's asymmetry-fallback threshold (see the
// note above) while turbo3 on V gets the extra context/VRAM headroom
// TurboQuant is there for. Other backends keep a single q8_0 for both.
export function defaultKvQuantVFor(backendKey: string | undefined | null): string {
  return backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo3' : 'q8_0'
}

// The engine-only baseline (no sampling, no ctx-size/gpu-layers — see notes
// above). Returns a plain object safe to spread directly into `args`.
export function buildQuickEngineBaseline(opts: {
  cpuInfo?: CpuInfoLike | null
  backendKey?: string | null
  cpuThreadsOverridePercent?: number | null
}): Record<string, any> {
  const recommendedThreads = computeRecommendedThreads(opts.cpuInfo, opts.cpuThreadsOverridePercent)
  const kvQuantK = defaultKvQuantFor(opts.backendKey)
  const kvQuantV = defaultKvQuantVFor(opts.backendKey)
  return {
    '--threads': recommendedThreads,
    '--batch-size': 2048,
    '--ubatch-size': 512,
    // --parallel: 4 (llama.cpp's own default) is safe here because
    // --kv-unified defaults to true below — a single unified KV buffer
    // shared across all slots instead of splitting the context window
    // between them, so a single-user chat tab still gets the full
    // --ctx-size regardless of the slot count.
    '--parallel': 4,
    '--flash-attn': 'on',
    // llama.cpp deprecated the independent '--mmap'/'--mlock' booleans in
    // favor of a single '--load-mode' select (see the migration note in
    // ipc.ts). 'mmap+mlock' is its own explicit mode there, not just
    // 'mlock' — that's the one that memory-maps AND locks pages in RAM.
    '--load-mode': 'mmap+mlock',
    '--kv-offload': true,
    // Unified KV cache, on by default. An unset boolean always displays as
    // OFF regardless of the schema's own `default`, so flags meant to
    // default ON for a new template must be explicitly set true here.
    '--kv-unified': true,
    '--cache-type-k': kvQuantK,
    '--cache-type-v': kvQuantV,
    '--keep': 32,
    '--spec-draft-n-max': 3,
    '--spec-draft-n-min': 0,
    '--spec-draft-p-min': 0.75,
    '__ignoreCtxOverride': false,
    '__autoCtxFill': 'off',
    '__memOverheadEnabled': false
  }
}

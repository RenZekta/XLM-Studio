// Item 1.1 refactor: the Quick-preset engine baseline used to only get
// applied via a useEffect that ran once when CmdParamsEditor mounted. That
// turned out to be fragile in ways we kept re-discovering across many fix
// attempts — effect-ordering (parent effects clobbering child effects' work),
// components not mounting at all unless a collapsible section was expanded,
// dependency arrays causing destructive re-runs, etc.
//
// The actual fix: compute the baseline SYNCHRONOUSLY, with no effect and no
// race window at all, directly in CreateModal's lazy useState(() => ...)
// initializer for `args`. A lazy initializer runs exactly once, during the
// very first render, before anything can possibly commit and get clobbered.
// This function is the single source of truth for that baseline, shared by:
//   - CreateModal.tsx's lazy args initializer (new template creation)
//   - CmdParamsEditor.tsx's handleQuickPreset() (the Quick button, and
//     re-deriving --ctx-size/--gpu-layers once model metadata becomes
//     available, which isn't known synchronously at template-creation time)
//
// Deliberately excluded from this baseline (per item 1.2 + the architecture
// above): sampling values (temperature/top-p/etc — never touched by engine
// presets, see SAMPLING_KEYS in CmdParamsEditor.tsx) and --ctx-size/
// --gpu-layers (need GGUF metadata + VRAM budget, unavailable synchronously
// before a model is even picked — CmdParamsEditor's own effects fill these
// in once that data exists).

export interface CpuInfoLike {
  physicalCores?: number
}

export function computeRecommendedThreads(
  cpuInfo: CpuInfoLike | null | undefined,
  // New: "Recommended CPU Threads override" (Settings) — when provided,
  // replaces the built-in 75% default with a user-chosen percentage of
  // physical cores, always rounded to a whole core count (never "1.5 cores").
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
  // Bug fix (item 4): see the identical note in CmdParamsEditor.tsx —
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
    // Bug fix history: this used to default to 4, which silently quartered
    // the context a single-user desktop chat tab actually got (llama-
    // server's --ctx-size is the TOTAL KV pool split evenly across
    // --parallel slots). Was changed to 1 to fix that. Now reverted back to
    // 4 — with --kv-unified ON by default (below), a single unified KV
    // buffer is shared across all slots instead of splitting the context
    // window between them, so the original problem this "fix" addressed no
    // longer applies, and 4 parallel slots (llama.cpp's own default) is
    // safe again.
    '--parallel': 4,
    '--flash-attn': 'on',
    // Migrated from the old independent '--mmap'/'--mlock' booleans to the
    // single '--load-mode' select (llama.cpp deprecated the two flags in
    // favor of this — see the migration note in ipc.ts for the full story).
    // llama.cpp supports mmap and mlock together as their own explicit mode
    // ('mmap+mlock', not just 'mlock') — that's the one that preserves this
    // baseline's original intent (both memory-mapping and locking pages in
    // RAM by default).
    '--load-mode': 'mmap+mlock',
    '--kv-offload': true,
    // New: "Unified KV Cache" — ON by default (matches the established
    // pattern for boolean flags here: an unset boolean always displays as
    // OFF regardless of the schema's own `default`, so flags meant to
    // default ON for a new template must be explicitly set true here).
    // With unified KV, --parallel no longer splits the context window across
    // slots, so the single-user-app rationale for defaulting --parallel to 1
    // (see above) no longer applies — safe to leave llama.cpp's own default
    // of 4 parallel sequences.
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

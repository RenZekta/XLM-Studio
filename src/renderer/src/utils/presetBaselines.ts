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

export function computeRecommendedThreads(cpuInfo: CpuInfoLike | null | undefined): number {
  const physicalCores = cpuInfo?.physicalCores || 8
  return Math.max(1, Math.floor(physicalCores * 0.75))
}

export function defaultKvQuantFor(backendKey: string | undefined | null): string {
  return backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo3' : 'q8_0'
}

// The engine-only baseline (no sampling, no ctx-size/gpu-layers — see notes
// above). Returns a plain object safe to spread directly into `args`.
export function buildQuickEngineBaseline(opts: {
  cpuInfo?: CpuInfoLike | null
  backendKey?: string | null
}): Record<string, any> {
  const recommendedThreads = computeRecommendedThreads(opts.cpuInfo)
  const kvQuant = defaultKvQuantFor(opts.backendKey)
  return {
    '--threads': recommendedThreads,
    '--batch-size': 2048,
    '--ubatch-size': 512,
    // Single-user desktop app: --parallel only pays off serving multiple
    // simultaneous API clients. --ctx-size is llama-server's TOTAL KV pool
    // split evenly across --parallel slots, so leaving this at >1 silently
    // divides the context the user actually gets in their one chat tab.
    '--parallel': 1,
    '--flash-attn': 'on',
    '--mmap': true,
    '--mlock': true,
    '--kv-offload': true,
    '--cache-type-k': kvQuant,
    '--cache-type-v': kvQuant,
    '--keep': 32,
    '--spec-draft-n-max': 3,
    '--spec-draft-n-min': 0,
    '--spec-draft-p-min': 0.75,
    '__ignoreCtxOverride': false,
    '__autoCtxFill': 'off',
    '__memOverheadEnabled': false
  }
}

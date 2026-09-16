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

import { detectBackendRuntimeType, defaultVramOverheadForBackend, DEFAULT_RAM_OVERHEAD_MB } from './backendOverhead'

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
  // Full backend descriptor (name/displayName/exe/path), used ONLY to guess
  // a sensible default VRAM overhead for the detected GPU runtime (CUDA/
  // ROCm/Vulkan) — see backendOverhead.ts. backendKey alone (just the fork
  // name, e.g. "llama.cpp") doesn't carry that; it's usually in the
  // version/display name instead.
  backendInfo?: { name?: string; displayName?: string; backendKey?: string; exe?: string; path?: string } | null
}): Record<string, any> {
  const recommendedThreads = computeRecommendedThreads(opts.cpuInfo, opts.cpuThreadsOverridePercent)
  const kvQuantK = defaultKvQuantFor(opts.backendKey)
  const kvQuantV = defaultKvQuantVFor(opts.backendKey)
  const runtimeType = detectBackendRuntimeType(opts.backendInfo || (opts.backendKey ? { backendKey: opts.backendKey } : null))
  const defaultVramOverhead = defaultVramOverheadForBackend(runtimeType)
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
    // VRAM overhead defaults to a backend-runtime-aware estimate (CUDA/ROCm/
    // Vulkan have measurably different driver/context footprints — see
    // backendOverhead.ts); RAM overhead defaults to a flat, backend-
    // independent estimate. Both on by default; the user can retune or
    // disable either independently once they've compared against their own
    // real launches (e.g. via --fit).
    '__vramOverheadEnabled': true,
    '__vramOverheadMB': defaultVramOverhead,
    '__ramOverheadEnabled': true,
    '__ramOverheadMB': DEFAULT_RAM_OVERHEAD_MB
  }
}

// The sampling-related CLI flags (temperature/top-p/top-k/min-p/repeat-
// penalty/presence-penalty). These are a deliberately separate axis from
// the engine baseline above — set once at Template creation from the
// starred Sampling Preset, then only ever touched by the user directly or
// by re-applying a Sampling Preset. Quick/FullAuto/Clean must never modify
// them (Clean explicitly PRESERVES them — see handleClearPreset in
// CmdParamsEditor.tsx and toolApplyParametersPreset in mcpControl.ts, which
// mirrors it).
export const SAMPLING_KEYS = ['--temperature', '--top-p', '--top-k', '--min-p', '--repeat-penalty', '--presence-penalty']

// Builds the sampling args a brand-new Template should start with, from
// whichever Sampling Preset is currently starred (falling back to the first
// one if none is starred) — the exact same mapping CreateModal.tsx's lazy
// initializer uses. Returns {} if there are no sampling presets configured
// at all. Shared so template-create (mcpControl.ts) can't drift from what
// creating a Template through the UI actually seeds.
export function seedSamplingArgsFromPreset(samplingPresets: any[] | undefined): Record<string, any> {
  const seeded: Record<string, any> = {}
  const starred = samplingPresets?.find((p: any) => p.isStarred) || samplingPresets?.[0]
  const values = starred?.values
  if (!values) return seeded
  if (values.temperature !== undefined) seeded['--temperature'] = values.temperature
  if (values.topK !== undefined) seeded['--top-k'] = values.topK
  if (values.topP !== undefined) seeded['--top-p'] = values.topP
  if (values.minP !== undefined) seeded['--min-p'] = values.minP
  if (values.repeatPenalty !== undefined) seeded['--repeat-penalty'] = values.repeatPenalty
  if (values.presencePenalty !== undefined) seeded['--presence-penalty'] = values.presencePenalty
  return seeded
}

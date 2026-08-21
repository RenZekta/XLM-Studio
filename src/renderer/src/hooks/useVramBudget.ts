import { useMemo } from 'react'
import { useStore } from '../store/useStore'
import { formatWithSpaces } from '../utils/contextFormat'

// ===========================================================================
// BPW-accurate VRAM budget (Task 3).
// ---------------------------------------------------------------------------
// Implements the formula from the Kimi K3 guide:
//   TOTAL = W + KV + B + O
//   W  = weight memory        (≈ model file size — mmap upper bound)
//   KV = KV-cache memory       (ctx × layers × per-token bytes, BPW-accurate,
//                              with MLA + sliding-window handling)
//   B  = compute/batch buffer (10% of W+KV, min 512 MB — conservative placeholder
//                              until the server log reports the exact figure)
//   O  = runtime overhead      (1 GB flat + 0.5 GB per active GPU)
//
// Previously the KV estimate used the heuristic
//   VRAM_KV = model_size_MB * (0.12 * (target_context / 32768))
// which is wildly inaccurate (off by 2–4× on common models). The new formula
// uses the model's real attention geometry extracted from the GGUF header
// (head_count_kv, key_length, value_length) and the bytes-per-element of the
// SELECTED --cache-type-k/v (f16, q8_0, q4_0, turbo3, …), which is the whole
// point of "use the bits-per-weight value for a specific model".
// ===========================================================================

export interface VramBudget {
  vramAvailable: number      // free VRAM in MB
  vramBudget: number         // VRAM_Available - safety buffer (1024 MB)
  vramKV: number             // KV cache cost in MB (BPW-accurate)
  vramMM: number             // mmproj cost in MB
  vramForWeights: number     // budget - KV - MM - B - O
  recommendedLayers: number  // computed safe layers (0..maxLayers)
  maxLayers: number          // model block_count (or 120 fallback)
  modelFitsFully: boolean    // whether all layers fit
  autoFitContext: number     // effective target context (AutoFit override or preset)
  // Breakdown for the UI (so the user can SEE why a number is what it is):
  weightMB: number           // W
  computeBufferMB: number    // B
  overheadMB: number          // O
  bytesPerKvElement: number  // BPE of the active cache type (for display)
  kvArchitecture: 'gqa' | 'mha' | 'mla' | 'unknown'
  // Task 2.2/2.3: exposed for the AutoFill + Memory Overhead UI:
  freeVRAMMB: number          // free VRAM after overhead reduction
  freeRAMMB: number           // free RAM after overhead reduction
  totalVRAMMB: number         // total VRAM (for the Memory Overhead slider max)
  totalRAMMB: number          // total RAM (for the Memory Overhead slider max)
  warning?: string           // guardrail warning if applicable
}

// Bytes-per-element for each llama.cpp --cache-type-k/v value.
// Source: GGML block layouts (see the BPW reference table). For block-quantized
// types, BPE = (block_payload_bytes) / (values_per_block).
//   q8_0  = 34 bytes / 32 values = 1.0625
//   q4_0  = 18 bytes / 32 values = 0.5625
//   q4_1  = 20 bytes / 32 values = 0.625
//   q5_0  = 22 bytes / 32 values = 0.6875
//   q5_1  = 24 bytes / 32 values = 0.75
//   iq4_nl = 18 bytes / 32 values = 0.5625
// TurboQuant (fork-only KV types): 128 values + 1 fp16/fp32 stored norm.
//   turbo2 = (128*2/8 + 2) / 128 = 34/128  ≈ 0.2656  (fp16 norm)
//   turbo3 = (128*3/8 + 2) / 128 = 50/128  ≈ 0.3906  (fp16 norm) — conservative
//   turbo4 = (128*4/8 + 2) / 128 = 66/128  ≈ 0.5156  (fp16 norm) — conservative
const KV_BPE: Record<string, number> = {
  f32: 4.0,
  f16: 2.0,
  bf16: 2.0,
  q8_0: 34 / 32,        // 1.0625
  q4_0: 18 / 32,        // 0.5625
  q4_1: 20 / 32,        // 0.625
  q5_0: 22 / 32,        // 0.6875
  q5_1: 24 / 32,        // 0.75
  iq4_nl: 18 / 32,      // 0.5625
  // TurboQuant KV-cache types (require a TurboQuant fork + flash attention).
  // Conservative figures (fp32 norm) so we never underestimate RAM.
  turbo2: 34 / 128,     // ≈ 0.2656
  turbo3: 52 / 128,     // ≈ 0.4063 (3-bit + fp32 norm, conservative)
  turbo4: 68 / 128      // ≈ 0.5313 (4-bit + fp32 norm, conservative)
}

function kvBpe(type: string): number {
  const t = (type || 'f16').toLowerCase()
  // Match variants like "Q8_0", "q8_0", "Q4_K_M" (map quant name → KV BPE).
  if (KV_BPE[t] !== undefined) return KV_BPE[t]
  if (t.startsWith('q4_k')) return 0.59375   // Q4_K ≈ 4.75 bpv → /8
  if (t.startsWith('q5_k')) return 0.6875
  if (t.startsWith('q6_k')) return 0.8125
  if (t.startsWith('q3_k')) return 0.4375
  if (t.startsWith('q2_k')) return 0.34375
  if (t.startsWith('iq3')) return 0.40625
  if (t.startsWith('iq4')) return 0.53125
  if (t.startsWith('iq2')) return 0.28125
  if (t.startsWith('iq1')) return 0.21875
  // Unknown → safest default is f16 (2.0) — overestimate is safe.
  return 2.0
}

export function useVramBudget(opts: {
  modelPath?: string
  modelSizeMB: number
  maxLayers: number          // block_count from GGUF metadata
  contextSize: number        // current ctx-size input value (or default)
  mmprojEnabled: boolean
  mmprojSizeMB: number
  kvQuantType: string        // '--cache-type-k' value (q8_0, f16, turbo3, …)
  kvQuantTypeV?: string      // '--cache-type-v' value (defaults to kvQuantType)
  memOverheadMB?: number     // Task 2.3: user-set memory overhead (reduces free VRAM then RAM)
  autoFillAuto?: boolean     // Task 2: dense AutoFill "Auto" — ignore ctx, fit model by speed priority
  // Bug fix (KV-preview/launch mismatch report): whether this preset's
  // "Ignore Context Length Override" toggle is ON. Needed so the VRAM/KV
  // preview computes `targetContext` with EXACTLY the same floor logic
  // ModelCard.tsx uses to build the real launch --ctx-size — previously this
  // hook always used the raw contextSize (or, when unset, a hardcoded 32768),
  // completely ignoring the global Minimum AutoFit override regardless of the
  // toggle. That meant the KV number shown in Advanced Parameters could
  // silently diverge from what would actually be launched.
  ignoreCtxOverride?: boolean
  // Bug fix (item 7): the "native context below Minimum AutoFit override"
  // guardrail warning must not fire for a model whose EFFECTIVE max context
  // has been raised past its raw GGUF native context via RoPE/YaRN scaling
  // (--rope-scaling yarn + --rope-scale). Pass the scaled ceiling (native ×
  // rope-scale when yarn is active, else undefined) so the warning compares
  // against the right number.
  ropeScaledMaxContext?: number
}): VramBudget | null {
  const { vramInfo, modelDefaults, activeBackend, systemRam } = useStore()

  return useMemo(() => {
    // Task 4: "Current Memory State use" — when OFF (default), use the static
    // maximum VRAM/RAM totals (conservative, stable). When ON, use the currently-
    // available free values (polled every 10s).
    const useCurrent = !!modelDefaults.useCurrentMemState
    // Task 2.3: Memory Overhead reduces the chosen memory pool (VRAM first, then RAM).
    const overheadMB = Math.max(0, Number(opts.memOverheadMB) || 0)
    const totalVRAM = vramInfo?.totalVRAMMB || 0
    let freeVRAM = useCurrent ? (vramInfo?.freeVRAMMB || 0) : totalVRAM
    let freeRAM = useCurrent ? (systemRam?.freeRAMMB || 0) : (systemRam?.totalRAMMB || 0)
    if (overheadMB > 0) {
      const vramReduction = Math.min(overheadMB, freeVRAM)
      freeVRAM = Math.max(0, freeVRAM - vramReduction)
      const ramReduction = overheadMB - vramReduction
      if (ramReduction > 0) freeRAM = Math.max(0, freeRAM - ramReduction)
    }
    // If there's no VRAM at all (unified memory / CPU-only), we can't compute a
    // GPU-offload budget — but the caller may still want KV math. Return null
    // only when BOTH VRAM and RAM are unavailable.
    if (freeVRAM <= 0 && freeRAM <= 0) return null

    const maxLayers = opts.maxLayers > 0 ? opts.maxLayers : 120
    // Safety buffer: 1024 MB for desktop rendering + compute scratchpads.
    const vramBudget = Math.max(0, freeVRAM - 1024)

    // Determine target context — mirrors ModelCard.tsx's `effectiveCtx` (the
    // value that actually gets launched) exactly:
    //   1. Base = the preset's own --ctx-size if set, else 32768.
    //   2. If the global Minimum AutoFit override is enabled AND this preset
    //      is NOT ignoring it, the override acts as a FLOOR: target = max(base, override).
    //   3. If ignoring the override (or it's disabled), target = base, unmodified.
    const baseContext = opts.contextSize > 0 ? opts.contextSize : 32768
    let targetContext = baseContext
    if (!opts.ignoreCtxOverride && modelDefaults.autoFitEnabled) {
      targetContext = Math.max(baseContext, modelDefaults.autoFitContextLength)
    }

    // ----- W: weight memory -----
    // The file size is the mmap upper bound (weights + metadata, usually within
    // 1%). This is exact for the purpose of "will it fit".
    const weightMB = opts.modelSizeMB

    // ----- KV: KV-cache memory (BPW-accurate) -----
    const meta = opts.modelPath ? useStore.getState().ggufMetadata[opts.modelPath] : null
    const bpeK = kvBpe(opts.kvQuantType)
    const bpeV = kvBpe(opts.kvQuantTypeV || opts.kvQuantType)

    let vramKV: number
    let kvArchitecture: 'gqa' | 'mha' | 'mla' | 'unknown' = 'unknown'

    if (meta?.kvLoraRank && meta.kvLoraRank > 0) {
      // MLA (DeepSeek-V2/V3, Kimi K2): one compressed latent per token per
      // layer. KV = ctx × layers × (kv_lora_rank + qk_rope_head_dim) × BPE(ctk)
      kvArchitecture = 'mla'
      // Task 6: hybrid SSM — only every Nth layer carries KV.
      const interval = (meta as any)?.fullAttentionInterval || 1
      const layers = Math.ceil((meta.blockCount || 0) / Math.max(1, interval))
      const rank = meta.kvLoraRank
      const rope = meta.qkRopeHeadDim || 0
      vramKV = (targetContext * layers * (rank + rope) * bpeK) / (1024 * 1024)
    } else if (meta?.headCountKv && meta?.blockCount && (meta?.hiddenSize || meta?.keyLength)) {
      // GQA / MHA: per-token, per-layer K+V bytes.
      //   head_dim_k = key_length  || (embedding_length / head_count)
      //   head_dim_v = value_length|| head_dim_k
      //   per_token  = head_count_kv × (head_dim_k × BPE(ctk) + head_dim_v × BPE(ctv))
      //   KV         = layers × ctx × per_token
      kvArchitecture = (meta.headCountKv === meta.headCount) ? 'mha' : 'gqa'
      // Task 6: hybrid SSM — only every Nth layer carries KV (Qwen3.5/3.8 etc.).
      const interval = (meta as any)?.fullAttentionInterval || 1
      const layers = Math.ceil(meta.blockCount / Math.max(1, interval))
      const hkv = meta.headCountKv
      const hdimK = meta.keyLength || (meta.hiddenSize! / (meta.headCount || 1))
      const hdimV = meta.valueLength || hdimK
      const perTokenBytes = hkv * (hdimK * bpeK + hdimV * bpeV)
      // Sliding-window layers only hold min(ctx, S) tokens. Without a per-layer
      // pattern key we conservatively cap ALL layers at min(ctx, S) when SWA is
      // present (gemma3-style). This slightly underestimates KV for hybrid
      // models that mix SWA + full-attention layers, but is far better than the
      // old heuristic and matches the Kimi K3 guide's conservative recommendation.
      let effectiveCtx = targetContext
      if (meta.slidingWindow && meta.slidingWindow > 0 && meta.slidingWindow < targetContext) {
        effectiveCtx = meta.slidingWindow
      }
      vramKV = (layers * effectiveCtx * perTokenBytes) / (1024 * 1024)
    } else if (meta?.hiddenSize && meta?.kvHeads && meta?.blockCount) {
      // Legacy precise fallback (old formula) — kept for models where only the
      // basic geometry was extracted. Uses head_dim = hidden / head_count and
      // assumes K and V share the same dim + same cache type.
      kvArchitecture = 'gqa'
      // Task 6: hybrid SSM — divide layers by interval.
      const interval = (meta as any)?.fullAttentionInterval || 1
      const layers = Math.ceil(meta.blockCount / Math.max(1, interval))
      const hdim = meta.hiddenSize / (meta.headCount || meta.kvHeads || 1)
      const perTokenBytes = meta.kvHeads * hdim * (bpeK + bpeV)
      vramKV = (layers * targetContext * perTokenBytes) / (1024 * 1024)
    } else {
      // Last-resort heuristic (metadata unavailable). Old formula, kept as a
      // graceful degradation path — but the GGUF parser now extracts the full
      // geometry so this should rarely trigger.
      vramKV = opts.modelSizeMB * (0.12 * (targetContext / 32768))
      kvArchitecture = 'unknown'
    }

    // ----- B: compute & batch buffers -----
    // Conservative placeholder: 10% of (W + KV), min 512 MB. The exact figure
    // depends on n_batch/n_ubatch + backend and can't be derived from metadata
    // alone — the llama-server log prints it on first launch
    // ("llama_context: compute buffer total = X MiB").
    const computeBufferMB = Math.max(512, Math.round(0.10 * (weightMB + vramKV)))

    // ----- O: runtime overhead -----
    // mmap page-cache pressure, CUDA context (~300–600 MB per GPU), tokenizer,
    // runtime. 1 GB flat (CPU-only) + 0.5 GB per active GPU.
    const gpuCount = (vramInfo?.hasNvidia || vramInfo?.vendor === 'NVIDIA' || vramInfo?.vendor === 'AMD') ? 1 : 0
    const runtimeOverheadMB = 1024 + (gpuCount > 0 ? 512 : 0)

    // ----- mmproj overhead -----
    const vramMM = opts.mmprojEnabled ? opts.mmprojSizeMB : 0

    // ----- Remaining budget for weights (what can be GPU-offloaded) -----
    // Task 2: when AutoFill "Auto" is active for a dense model, llama-server
    // --fit decides the context — so the VRAM calculation should IGNORE the
    // user-selected ctx value and instead check if the MODEL FITS FULLY by
    // speed priority (VRAM > RAM > Storage). We use a small default ctx
    // (8192) only for the visual KV/buffer estimate; the real ctx comes from
    // llama-server. The recommendedLayers then prioritizes a full fit.
    const isMoeModel = !!(meta && (meta.isMoe || (meta.expertCount || 0) > 0))
    const moeStrategy = modelDefaults.moeOffloadStrategy || 'offload'
    const denseAutoFill = !!opts.autoFillAuto && !isMoeModel
    const effectiveCtxForCalc = denseAutoFill ? 8192 : targetContext
    // Recompute KV + buffers with the effective ctx (only differs in dense-auto).
    let vramKVEffective = vramKV
    let computeBufferEffective = computeBufferMB
    if (denseAutoFill) {
      // Recompute KV with the small default ctx for the visual estimate.
      const interval = (meta as any)?.fullAttentionInterval || 1
      if (meta?.kvLoraRank && meta.kvLoraRank > 0) {
        const layers = Math.ceil((meta.blockCount || 0) / Math.max(1, interval))
        vramKVEffective = (effectiveCtxForCalc * layers * (meta.kvLoraRank + (meta.qkRopeHeadDim || 0)) * bpeK) / (1024 * 1024)
      } else if (meta?.headCountKv && meta?.blockCount && (meta?.hiddenSize || meta?.keyLength)) {
        const hkv = meta.headCountKv
        const hdimK = meta.keyLength || (meta.hiddenSize! / (meta.headCount || 1))
        const hdimV = meta.valueLength || hdimK
        const perTokenBytes = hkv * (hdimK * bpeK + hdimV * bpeV)
        let effCtx = effectiveCtxForCalc
        if (meta.slidingWindow && meta.slidingWindow > 0 && meta.slidingWindow < effectiveCtxForCalc) effCtx = meta.slidingWindow
        const layers = Math.ceil(meta.blockCount / Math.max(1, interval))
        vramKVEffective = (layers * effCtx * perTokenBytes) / (1024 * 1024)
      }
      computeBufferEffective = Math.max(512, Math.round(0.10 * (weightMB + vramKVEffective)))
    }
    const vramForWeights = vramBudget - vramKVEffective - vramMM - computeBufferEffective - runtimeOverheadMB
    // RAM budget for CPU inference (no CUDA context → smaller overhead).
    const ramOverheadMB = 1024
    const ramForWeights = freeRAM - vramKVEffective - vramMM - computeBufferEffective - ramOverheadMB

    let recommendedLayers: number
    let modelFitsFully = false
    if (denseAutoFill) {
      // Task 2: dense + AutoFill Auto — prioritize FULL FIT by speed priority.
      // VRAM full → maxLayers; else RAM full → 0 GPU (pure CPU); else partial.
      // (llama-server --fit will handle the actual split + ctx.)
      if (vramForWeights >= weightMB) {
        recommendedLayers = maxLayers
        modelFitsFully = true
      } else if (freeVRAM <= 0 && ramForWeights >= weightMB) {
        recommendedLayers = 0
        modelFitsFully = true
      } else {
        recommendedLayers = Math.max(0, Math.floor((vramForWeights / weightMB) * maxLayers))
      }
    } else if (vramForWeights >= weightMB) {
      // Case A: model fits fully in VRAM → full GPU offload.
      recommendedLayers = maxLayers
      modelFitsFully = true
    } else if (freeVRAM <= 0 && !isMoeModel && ramForWeights >= weightMB) {
      // Task 2/6 fix: ONLY force 0 GPU layers when there is literally no VRAM
      // (no GPU / unified memory) AND the dense model fits fully in RAM — pure
      // CPU inference is the only option. When VRAM IS available, even a big
      // dense model (e.g. Qwen 27B) should partially offload to GPU (partial
      // GPU offload is much faster than pure CPU), so we fall through to the
      // proportional partial-offload branch below.
      recommendedLayers = 0
      modelFitsFully = true  // fits fully in RAM, just not on GPU
    } else if (isMoeModel && moeStrategy === 'max') {
      // Bug fix (Task 4): "MAX GPU Layers and Force MoE Weights onto CPU" keeps
      // ALL non-expert layers resident on GPU always (that's the "MAX GPU
      // Layers" part) and only pushes SOME layers' MoE/expert weight tensors to
      // CPU RAM via --moe-cpu-layers to make room for the desired context.
      // Previously `recommendedLayers` here reused the "how many layers fit on
      // GPU" formula from the plain offload strategy, which is the OPPOSITE
      // number from what the UI needs — the "MAX GPU" strategy already assumes
      // ~all layers stay resident, and this widget is asking "how many of THEM
      // need their MoE weights evicted to CPU RAM to fit?" — reusing the fits-
      // on-GPU count meant a model that fit fully in VRAM showed "all layers
      // recommended for CPU" (maxLayers/maxLayers) instead of the correct
      // answer of 0 layers needing eviction.
      //
      // Model: each layer's MoE (expert) weight is estimated as an equal share
      // of the "expert-dominated" fraction of the file (expertParamFrac, same
      // 0.8 estimate used elsewhere for this architecture family) spread across
      // all layers. Forcing N layers' MoE weights to CPU frees N × that share
      // from VRAM. Solve for the smallest N that makes the remaining
      // GPU-resident weight (full weight − N × per-layer MoE share) fit inside
      // vramForWeights (the budget already left over after KV/compute/overhead
      // for the CURRENTLY SELECTED context — so this recalculates live as the
      // user changes --ctx-size, exactly like "how many layers to move from
      // VRAM to RAM to fit the desired context" was asked for).
      const totalExp = meta?.expertCount || 0
      const activeExp = meta?.expertUsedCount || totalExp || 0
      const expertParamFrac = 0.8  // typical for large MoE (Qwen3, DeepSeek, etc.)
      const perLayerMoeMB = maxLayers > 0 ? (weightMB * expertParamFrac) / maxLayers : 0
      if (vramForWeights >= weightMB || perLayerMoeMB <= 0) {
        // Already fits fully with nothing forced to CPU.
        recommendedLayers = 0
        modelFitsFully = true
      } else {
        const deficitMB = weightMB - vramForWeights
        const layersToForceToCpu = Math.ceil(deficitMB / perLayerMoeMB)
        recommendedLayers = Math.max(0, Math.min(maxLayers, layersToForceToCpu))
        modelFitsFully = recommendedLayers === 0
      }
      // activeExp intentionally unused beyond documenting the active-expert
      // count considered typical for this architecture family (kept for parity
      // with the moeWeightFraction estimate used elsewhere; the eviction count
      // itself only depends on total weight/layers, not which experts are hot).
      void activeExp
    } else {
      // Case B: partial offload — proportional to the weight fraction that fits.
      recommendedLayers = Math.max(0, Math.floor((vramForWeights / weightMB) * maxLayers))
    }

    // AutoFit guardrail warning.
    // Only warn when the MODEL LITERALLY CANNOT support the requested override
    // context — i.e. its native max context_length (from the GGUF header) is
    // known and is below the override value. Previously this compared the
    // *input* ctx to the override, which fired permanently for any model whose
    // slider sat below 60000 (the default override) even when it fit fine.
    // Bug fix (item 7): (a) `.toLocaleString` was missing its call parens, so
    // the warning literally printed the function's source ("function
    // toLocaleString() { [native code] }") instead of a formatted number.
    // (b) the check now also considers `ropeScaledMaxContext` — a model using
    // YaRN (or other RoPE) scaling to extend its usable context past the raw
    // GGUF native value must not be flagged just because its UN-scaled native
    // context looks small.
    let warning: string | undefined
    const effectiveMaxContext = (opts.ropeScaledMaxContext && opts.ropeScaledMaxContext > 0)
      ? Math.max(opts.ropeScaledMaxContext, meta?.contextLength || 0)
      : meta?.contextLength
    if (modelDefaults.autoFitEnabled && effectiveMaxContext && effectiveMaxContext > 0 &&
        effectiveMaxContext < modelDefaults.autoFitContextLength) {
      // Bug fix: the message used to unconditionally claim the context "will be
      // capped at the model's maximum" — but ModelCard's actual launch-time
      // effectiveCtx computation NEVER caps; the override is a floor, so it
      // would actually pass a --ctx-size ABOVE the model's native/trained
      // context. Without RoPE/YaRN scaling configured, that's not a safe cap,
      // it's a likely startup failure or garbage output. Reflect the two real
      // outcomes accurately depending on whether YaRN auto-scaling (item 5's
      // global "upscale to AutoFit" switch, or this preset's own item-8
      // switch) is actually going to handle it.
      warning = (opts.ropeScaledMaxContext && opts.ropeScaledMaxContext >= modelDefaults.autoFitContextLength)
        ? `Model's native context (${formatWithSpaces(meta?.contextLength || 0)}) is below the Minimum AutoFit override (${formatWithSpaces(modelDefaults.autoFitContextLength)}) — YaRN scaling is active and will extend it to reach the override.`
        : `Model's native context (${formatWithSpaces(effectiveMaxContext)}) is below the Minimum AutoFit override (${formatWithSpaces(modelDefaults.autoFitContextLength)}). Enable "Automatic YaRN scaling control" (per-preset, or globally in Settings) to actually reach the override — otherwise the launch context will exceed the model's trained maximum and may fail to start.`
    }
    if (vramForWeights < 0) {
      warning = 'KV cache + buffers exceed free VRAM — the model will not fit on GPU.'
    }

    return {
      vramAvailable: freeVRAM,
      vramBudget,
      vramKV,
      vramMM,
      vramForWeights,
      recommendedLayers,
      maxLayers,
      modelFitsFully,
      autoFitContext: targetContext,
      weightMB,
      computeBufferMB,
      overheadMB: runtimeOverheadMB,
      bytesPerKvElement: bpeK,
      kvArchitecture,
      freeVRAMMB: freeVRAM,
      freeRAMMB: freeRAM,
      totalVRAMMB: totalVRAM,
      totalRAMMB: systemRam?.totalRAMMB || 0,
      warning
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.modelPath, opts.modelSizeMB, opts.maxLayers, opts.contextSize, opts.mmprojEnabled, opts.mmprojSizeMB, opts.kvQuantType, opts.kvQuantTypeV, opts.memOverheadMB, opts.autoFillAuto, opts.ignoreCtxOverride, opts.ropeScaledMaxContext, vramInfo, modelDefaults, activeBackend, systemRam])
}

// ===========================================================================
// Task 2.2: Automatic Context Fill calculator.
// Computes the MAX context window that fits into the available memory
// (VRAM first, then RAM) given the model weights + KV cache + buffers.
// Used by:
//   - Dense models with "Use Automatic Context Fill" ON → fit model fully,
//     then fill remaining memory with context up to the model's max context.
//   - MoE models with "Maximum available" → same fill logic.
//   - MoE "Auto" → NOT used (llama-server --fit handles it).
//
// For MoE, the compute buffer B is scaled by the active-expert ratio per the
// user's request ("make the MoE side of calculations scale with Active Experts
// amount"). All experts are still resident in weights (W is the full file).
// ===========================================================================

// Per-token KV bytes for a given metadata + cache type (used by the fill search).
function perTokenKvBytes(meta: any, bpeK: number, bpeV: number): number | null {
  if (!meta) return null
  if (meta.kvLoraRank && meta.kvLoraRank > 0) {
    // MLA: one latent per token per layer.
    return (meta.kvLoraRank + (meta.qkRopeHeadDim || 0)) * bpeK
  }
  if (meta.headCountKv && meta.blockCount && (meta.hiddenSize || meta.keyLength)) {
    const hkv = meta.headCountKv
    const hdimK = meta.keyLength || (meta.hiddenSize / (meta.headCount || 1))
    const hdimV = meta.valueLength || hdimK
    return hkv * (hdimK * bpeK + hdimV * bpeV)
  }
  if (meta.hiddenSize && meta.kvHeads && meta.blockCount) {
    const hdim = meta.hiddenSize / (meta.headCount || meta.kvHeads || 1)
    return meta.kvHeads * hdim * (bpeK + bpeV)
  }
  return null
}

export interface AutoFillResult {
  context: number          // the max context that fits (>= minContext)
  fitsFully: boolean       // whether the model fit fully in the fastest memory
  usedVRAM: boolean        // whether VRAM was used at all
  overflowedToRAM: boolean // whether the model spilled into RAM (dense warning)
  layers: number           // recommended GPU layers (maxLayers if fits fully)
  maxLayers: number
  warning?: string
}

// Item 3: MoE default-context estimation for Quick preset. MoE models
// tolerate offloading layers to RAM far better than Dense (that's the whole
// premise of items 2/3 from an earlier round — llama.cpp's own "auto" MoE
// split already does this well), so unlike Dense (which gets a flat capped
// default), Quick's MoE default context should reflect the COMBINED
// (VRAM + RAM) pool minus the model's own weight, rather than assuming
// VRAM-only residency. This is intentionally a simple, direct estimate (NOT
// the layer-aware binary search computeAutoFillContext does) — it's a
// baseline default for a brand-new template, not a "maximize everything"
// optimizer; the user can always switch to "Maximum available" AutoFill for
// the more precise search.
export function estimateMoeDefaultContext(params: {
  meta: any
  modelSizeMB: number
  kvQuantType: string
  kvQuantTypeV: string
  freeVRAMMB: number
  freeRAMMB: number
  mmprojSizeMB?: number
  fallback?: number   // used if computation isn't possible at all
  cap?: number        // native context length ceiling, if known
}): number {
  const fallback = params.fallback ?? 32768
  if (!params.meta) return fallback
  const bpeK = kvBpe(params.kvQuantType)
  const bpeV = kvBpe(params.kvQuantTypeV || params.kvQuantType)
  const interval = params.meta.fullAttentionInterval || 1
  const kvLayers = Math.ceil((params.meta.blockCount || 0) / Math.max(1, interval))
  const perTok = perTokenKvBytes(params.meta, bpeK, bpeV)
  if (kvLayers <= 0 || perTok === null) return fallback
  const totalPoolMB = params.freeVRAMMB + params.freeRAMMB
  const overheadMB = 1024 + 512  // rough runtime overhead estimate (O)
  const leftoverMB = totalPoolMB - params.modelSizeMB - (params.mmprojSizeMB || 0) - overheadMB
  if (leftoverMB <= 0) return Math.min(fallback, 2048)  // model barely/doesn't fit at all — small floor
  // Reserve ~10% of the leftover for the compute/batch buffer (which itself
  // scales a bit with context) — a simple safety margin rather than solving
  // the interdependency exactly, consistent with this being a fast default
  // estimate rather than the precise binary search.
  const kvBudgetMB = leftoverMB * 0.9
  const estContext = Math.floor((kvBudgetMB * 1024 * 1024) / (kvLayers * perTok))
  let result = Math.max(2048, estContext)
  if (params.cap && params.cap > 0) result = Math.min(result, params.cap)
  return result
}

export function computeAutoFillContext(params: {
  meta: any
  modelSizeMB: number
  maxLayers: number
  maxContext: number       // model's native max context (or rope-scaled higher)
  kvQuantType: string
  kvQuantTypeV?: string
  freeVRAMMB: number
  freeRAMMB: number
  mmprojSizeMB?: number
  isMoe?: boolean
  activeExperts?: number   // for MoE compute-buffer scaling
  totalExperts?: number
  minContext?: number      // floor (e.g. 2048)
}): AutoFillResult | null {
  const { meta, modelSizeMB, maxLayers, maxContext, kvQuantType, kvQuantTypeV,
    freeVRAMMB, freeRAMMB, mmprojSizeMB = 0, isMoe = false, activeExperts, totalExperts, minContext = 2048 } = params
  if (!meta) return null
  const bpeK = kvBpe(kvQuantType)
  const bpeV = kvBpe(kvQuantTypeV || kvQuantType)
  // Task 6: hybrid SSM — only every Nth layer carries KV.
  const interval = meta.fullAttentionInterval || 1
  const layers = Math.ceil((meta.blockCount || 0) / Math.max(1, interval))
  if (layers <= 0) return null
  const perTok = perTokenKvBytes(meta, bpeK, bpeV)
  if (perTok === null) return null
  const perTokSafe = perTok  // non-null alias for use inside closures
  const mmprojMB = mmprojSizeMB
  // MoE: scale the compute buffer by active/total ratio (per user request).
  const moeScale = (isMoe && totalExperts && activeExperts && totalExperts > 0)
    ? Math.max(0.25, activeExperts / totalExperts) : 1.0
  const afOverheadMB = 1024 + (freeVRAMMB > 0 ? 512 : 0) // O
  // Bug fix (item 8): the previous version computed a PARTIAL layer count
  // that fits in VRAM at minContext (layersAtVramFit), decided "VRAM usable"
  // if that was >=50% of the model — but then ran its context binary search
  // using totalAt(), which required the ENTIRE model's weight (modelSizeMB,
  // ALL layers) to fit alongside KV+compute+overhead, regardless of how many
  // layers the partial-fit branch had just determined were actually going to
  // be GPU-resident. That mismatch (claiming e.g. 63/65 layers fit, but then
  // testing as if all 65 needed to fit) meant the search almost always
  // bottomed out at the minimum context — which is exactly the "63/65 layers
  // → only 2048 tokens" report, when the model could actually support ~4096+
  // once the weight requirement correctly reflected only 63 layers.
  //
  // Fixed with a single, internally-consistent model: layersAt(ctx) is the
  // number of layers whose weight fits in the pool alongside THAT context's
  // KV/compute/overhead — nothing else in this function ever assumes a
  // layer count that disagrees with what layersAt() actually computed for
  // the chosen context.
  function layersAt(ctx: number, poolMB: number): number {
    const kvMB = (layers * ctx * perTokSafe) / (1024 * 1024)
    // Compute-buffer estimate intentionally still uses modelSizeMB as a
    // reference scale (it's a ~10% correction term, not the dominant
    // weight-vs-budget constraint that caused the original bug, so a rough
    // estimate here doesn't reintroduce the same class of error).
    const computeMB = Math.max(512, 0.10 * (modelSizeMB + kvMB)) * moeScale
    const remainingForWeights = poolMB - kvMB - computeMB - afOverheadMB - mmprojMB
    if (remainingForWeights <= 0) return 0
    return Math.max(0, Math.min(maxLayers, Math.floor((remainingForWeights / Math.max(1, modelSizeMB)) * maxLayers)))
  }
  const vramLayersAtMin = freeVRAMMB > 0 ? layersAt(minContext, freeVRAMMB) : 0
  // Require the large majority of layers to fit before we call this a
  // VRAM-hosted answer — below that, RAM genuinely is the better/only option.
  const vramUsable = vramLayersAtMin >= Math.ceil(maxLayers * 0.5)

  if (!vramUsable) {
    // VRAM can't usefully host the model even at minimum context → RAM.
    // Here we DO want the full-model assumption: if we're hosting from RAM
    // at all, the whole model (all layers) is expected to run from there.
    function totalAtFullModel(ctx: number): number {
      const kvMB = (layers * ctx * perTokSafe) / (1024 * 1024)
      const computeMB = Math.max(512, 0.10 * (modelSizeMB + kvMB)) * moeScale
      return modelSizeMB + kvMB + computeMB + mmprojMB + afOverheadMB
    }
    if (totalAtFullModel(minContext) > freeRAMMB) {
      return { context: minContext, fitsFully: false, usedVRAM: false, overflowedToRAM: true, layers: 0, maxLayers, warning: 'Model does not fit in available memory even at minimum context.' }
    }
    let lo = minContext, hi = maxContext, best = minContext
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (totalAtFullModel(mid) <= freeRAMMB) { best = mid; lo = mid + 1 }
      else hi = mid - 1
    }
    const fitsFully = totalAtFullModel(maxContext) <= freeRAMMB
    return {
      context: best, fitsFully, usedVRAM: false, overflowedToRAM: true, layers: maxLayers, maxLayers,
      warning: `Model is too big for VRAM — overflowing to RAM. Context filled to ${best.toLocaleString()} tokens.`
    }
  }

  // VRAM-hosted: binary search for the LARGEST context that still keeps ALL
  // layers resident (layersAt(ctx, freeVRAMMB) === maxLayers) — this is
  // monotonic (layersAt only ever decreases as context grows, since KV eats
  // more of the budget), so a binary search on that boolean condition is
  // valid and, critically, self-consistent: whatever context we land on, the
  // layer count reported alongside it is always the exact number that
  // computation assumed.
  let lo = minContext, hi = maxContext, bestFullFit = -1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (layersAt(mid, freeVRAMMB) >= maxLayers) { bestFullFit = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  if (bestFullFit >= minContext) {
    // Full model fits at this context — the ideal outcome.
    return { context: bestFullFit, fitsFully: true, usedVRAM: true, overflowedToRAM: false, layers: maxLayers, maxLayers }
  }
  // Full fit isn't possible even at minContext — report the partial-layer
  // answer AT minContext (maximize layers on the fast tier over maximizing
  // context, per the user's stated priority — see the item 4/8 notes above).
  const partialLayers = layersAt(minContext, freeVRAMMB)
  return {
    context: minContext, fitsFully: false, usedVRAM: true, overflowedToRAM: false, layers: partialLayers, maxLayers,
    warning: `Model doesn't fully fit in VRAM — ${partialLayers}/${maxLayers} layers offloaded, rest on CPU. Context filled to ${minContext.toLocaleString()} tokens to keep the KV cache in VRAM.`
  }
}

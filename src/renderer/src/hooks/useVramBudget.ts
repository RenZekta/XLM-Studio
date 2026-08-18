import { useMemo } from 'react'
import { useStore } from '../store/useStore'

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

    // Determine target context: AutoFit override takes priority if enabled,
    // else the passed-in contextSize, else 32768.
    const autoFitContext = modelDefaults.autoFitEnabled
      ? modelDefaults.autoFitContextLength
      : 32768
    const targetContext = opts.contextSize > 0 ? opts.contextSize : autoFitContext

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
      // Task 8/4 fix: "MAX GPU Layers and Force MoE Weights onto CPU" — all
      // expert weights go to CPU (--moe-cpu-layers), so the GPU only needs to
      // hold the NON-EXPERT (shared/dense) layers + the ACTIVE experts' compute
      // path. The non-expert fraction is derived from active/total ratio: GPU
      // holds shared + active experts, the rest of the experts are on CPU.
      // activeFrac = active/total; nonExpertFrac ≈ 1 - (expertParamFrac).
      // We don't know expertParamFrac exactly, so estimate it from the MoE
      // structure: expert weights are the bulk. A typical large MoE has ~80%
      // expert params. GPU-resident expert fraction = activeFrac × 0.8.
      // So GPU weight = shared (0.2) + activeFrac × 0.8 of total.
      const totalExp = meta?.expertCount || 0
      const activeExp = meta?.expertUsedCount || totalExp || 0
      const activeFrac = totalExp > 0 ? (activeExp / totalExp) : 0.5
      const expertParamFrac = 0.8  // typical for large MoE (Qwen3, DeepSeek, etc.)
      const gpuWeightFraction = (1 - expertParamFrac) + (activeFrac * expertParamFrac)
      const gpuWeightMB = weightMB * gpuWeightFraction
      if (vramForWeights >= gpuWeightMB) {
        recommendedLayers = maxLayers
        modelFitsFully = true
      } else {
        recommendedLayers = Math.max(0, Math.floor((vramForWeights / gpuWeightMB) * maxLayers))
      }
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
    let warning: string | undefined
    if (modelDefaults.autoFitEnabled && meta?.contextLength && meta.contextLength > 0 &&
        meta.contextLength < modelDefaults.autoFitContextLength) {
      warning = `Model's native context (${meta.contextLength.toLocaleString()}) is below the Minimum AutoFit override (${modelDefaults.autoFitContextLength.toLocaleString}). Context will be capped at the model's maximum.`
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
  }, [opts.modelPath, opts.modelSizeMB, opts.maxLayers, opts.contextSize, opts.mmprojEnabled, opts.mmprojSizeMB, opts.kvQuantType, opts.kvQuantTypeV, opts.memOverheadMB, opts.autoFillAuto, vramInfo, modelDefaults, activeBackend, systemRam])
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
  // Binary search the largest context that fits in VRAM (then RAM).
  const afOverheadMB = 1024 + (freeVRAMMB > 0 ? 512 : 0) // O
  function totalAt(ctx: number): number {
    const kvMB = (layers * ctx * perTokSafe) / (1024 * 1024)
    const computeMB = Math.max(512, 0.10 * (modelSizeMB + kvMB)) * moeScale
    return modelSizeMB + kvMB + computeMB + mmprojMB + afOverheadMB
  }
  // Try VRAM first.
  let poolMB = freeVRAMMB
  let usedVRAM = freeVRAMMB > 0
  let lo = minContext, hi = maxContext, best = minContext
  // Check if even minContext fits; if not, fall back to RAM.
  if (totalAt(minContext) > poolMB) {
    // Doesn't fit in VRAM → try RAM.
    poolMB = freeRAMMB
    usedVRAM = false
    if (totalAt(minContext) > poolMB) {
      return { context: minContext, fitsFully: false, usedVRAM: false, overflowedToRAM: true, layers: 0, maxLayers, warning: 'Model does not fit in available memory even at minimum context.' }
    }
  }
  // Binary search for the max context that fits.
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (totalAt(mid) <= poolMB) { best = mid; lo = mid + 1 }
    else hi = mid - 1
  }
  const fitsFully = totalAt(maxContext) <= poolMB
  const overflowedToRAM = !usedVRAM && freeVRAMMB > 0
  // Layers: if model fits fully in VRAM, all layers; else proportional.
  const kvAtBest = (layers * best * perTokSafe) / (1024 * 1024)
  const computeAtBest = Math.max(512, 0.10 * (modelSizeMB + kvAtBest)) * moeScale
  const usedByModel = modelSizeMB + mmprojMB
  const remainingForWeights = poolMB - kvAtBest - computeAtBest - afOverheadMB
  const recLayers = remainingForWeights >= usedByModel ? maxLayers : Math.max(0, Math.floor((remainingForWeights / usedByModel) * maxLayers))
  let warning: string | undefined
  if (overflowedToRAM) {
    warning = `Model is too big for VRAM — overflowing to RAM. Context filled to ${best.toLocaleString()} tokens.`
  }
  return { context: best, fitsFully, usedVRAM, overflowedToRAM, layers: recLayers, maxLayers, warning }
}

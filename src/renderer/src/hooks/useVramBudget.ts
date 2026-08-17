import { useMemo } from 'react'
import { useStore } from '../store/useStore'

// Feature 14: VRAM-based GPU layer splitting algorithm.
// Calculates the recommended GPU offload layers based on:
// - Free VRAM (from nvidia-smi)
// - Model file size
// - KV cache cost for the target context
// - mmproj overhead (if enabled)
// - Safety buffer (1024 MB for desktop rendering)
export interface VramBudget {
  vramAvailable: number      // free VRAM in MB
  vramBudget: number         // VRAM_Available - 1024 (safety buffer)
  vramKV: number             // KV cache cost in MB
  vramMM: number             // mmproj cost in MB
  vramForWeights: number     // budget - KV - MM
  recommendedLayers: number  // computed safe layers (0..maxLayers)
  maxLayers: number          // model block_count (or 120 fallback)
  modelFitsFully: boolean    // whether all layers fit
  autoFitContext: number     // effective target context (AutoFit override or 32768)
  warning?: string           // guardrail warning if applicable
}

export function useVramBudget(opts: {
  modelPath?: string
  modelSizeMB: number
  maxLayers: number          // block_count from GGUF metadata
  contextSize: number        // current ctx-size input value (or default)
  mmprojEnabled: boolean
  mmprojSizeMB: number
  kvQuantType: string        // 'q8_0' | 'f16' | 'turbo3' etc.
}): VramBudget | null {
  const { vramInfo, modelDefaults, activeBackend } = useStore()

  return useMemo(() => {
    const freeVRAM = vramInfo?.freeVRAMMB || 0
    if (freeVRAM <= 0) return null // can't calculate without VRAM data

    const maxLayers = opts.maxLayers > 0 ? opts.maxLayers : 120
    // Safety buffer: 1024 MB for desktop rendering + compute scratchpads.
    const vramBudget = Math.max(0, freeVRAM - 1024)

    // Determine target context: AutoFit override takes priority if enabled.
    const autoFitContext = modelDefaults.autoFitEnabled
      ? modelDefaults.autoFitContextLength
      : 32768
    const targetContext = opts.contextSize > 0 ? opts.contextSize : autoFitContext

    // KV cache cost estimation.
    // If we have hidden_size + kv_heads + layers, use the precise formula:
    //   VRAM_KV = (layers * hidden_size * kv_heads * 2 * target_context) / (1024*1024) MB
    // Otherwise, use the resilient heuristic:
    //   VRAM_KV = model_size_MB * (0.12 * (target_context / 32768))
    let vramKV: number
    const meta = opts.modelPath ? useStore.getState().ggufMetadata[opts.modelPath] : null
    if (meta?.hiddenSize && meta?.kvHeads && meta?.blockCount) {
      // Precise formula (q8_0 ≈ 1 byte per element, f16 ≈ 2 bytes).
      const bytesPerElement = opts.kvQuantType === 'f16' || opts.kvQuantType === 'f32' ? 2 : 1
      vramKV = (meta.blockCount * meta.hiddenSize * meta.kvHeads * 2 * targetContext * bytesPerElement) / (1024 * 1024)
    } else {
      // Heuristic fallback.
      vramKV = opts.modelSizeMB * (0.12 * (targetContext / 32768))
    }

    // Multimodal overhead: 100% of mmproj file size if enabled.
    const vramMM = opts.mmprojEnabled ? opts.mmprojSizeMB : 0

    // Remaining for weights.
    const vramForWeights = vramBudget - vramKV - vramMM

    let recommendedLayers: number
    let modelFitsFully = false
    if (vramForWeights >= opts.modelSizeMB) {
      // Case A: model fits fully.
      recommendedLayers = maxLayers
      modelFitsFully = true
    } else {
      // Case B: partial offload.
      recommendedLayers = Math.max(0, Math.floor((vramForWeights / opts.modelSizeMB) * maxLayers))
    }

    // AutoFit guardrail warning.
    let warning: string | undefined
    if (modelDefaults.autoFitEnabled && targetContext < modelDefaults.autoFitContextLength) {
      warning = 'Model cannot meet the minimum AutoFit context requirement.'
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
      warning
    }
  }, [opts.modelPath, opts.modelSizeMB, opts.maxLayers, opts.contextSize, opts.mmprojEnabled, opts.mmprojSizeMB, opts.kvQuantType, vramInfo, modelDefaults, activeBackend])
}

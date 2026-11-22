// The app's global Parallel Inference and CPU Threads overrides as values a
// card can map onto its own parameters (see CardOverrides.global).

import { computeRecommendedThreads } from './presetBaselines'

interface GlobalDefaults {
  parallelOverrideEnabled?: boolean
  parallelInferenceMode?: 'unified' | 'separate'
  parallelOverrideValue?: number
  parallelOverrideValueDense?: number
  parallelOverrideValueMoe?: number
  cpuThreadsOverrideEnabled?: boolean
  cpuThreadsOverridePercent?: number
}

export function globalOverrideValues(
  md: GlobalDefaults | null | undefined,
  isMoe: boolean,
  cpu: { physicalCores: number } | null | undefined
): { parallel?: number; threads?: number } {
  const out: { parallel?: number; threads?: number } = {}
  if (md?.parallelOverrideEnabled) {
    out.parallel = md.parallelInferenceMode === 'separate'
      ? Math.max(1, Number(isMoe ? md.parallelOverrideValueMoe : md.parallelOverrideValueDense) || 4)
      : Math.max(1, Number(md.parallelOverrideValue) || 4)
  }
  if (md?.cpuThreadsOverrideEnabled) out.threads = computeRecommendedThreads(cpu, md.cpuThreadsOverridePercent)
  return out
}

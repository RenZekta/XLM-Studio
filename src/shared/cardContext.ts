// What a card's expressions can see. The renderer builds it from live data for
// the editor; the main process builds it from the same sources for a launch,
// so a preview and a launch resolve a card the same way.

import type { CpuInfo, GgufMetadata, SystemRamInfo, VramInfo } from './types'

export type CardOs = 'windows' | 'macos' | 'linux'

export interface CardGpu { name: string; totalMB: number; freeMB: number }

export interface CardSystem {
  os: CardOs
  ram: { totalMB: number; freeMB: number }
  vram: { totalMB: number; freeMB: number; gpus: CardGpu[] }
  cpu: { physicalCores: number; logicalCores: number; name: string }
}

export interface CardModel {
  path: string
  fileName: string
  sizeMB: number
  arch: string | null
  contextLength: number | null
  layers: number | null
  expertCount: number | null
  hiddenSize: number | null
  headCount: number | null
  kvHeads: number | null
  isMoe: boolean
}

export interface CardContext {
  args: Record<string, unknown>
  system: CardSystem
  model: CardModel | null
  overrides: { port: number | null; host: string | null; apiKeySet: boolean; engine: Record<string, unknown> }
  template: { name: string; port: number }
}

export const PLATFORM_OS: Record<string, CardOs> = { win32: 'windows', darwin: 'macos', linux: 'linux' }

export function emptySystem(platform: string = 'linux'): CardSystem {
  return {
    os: PLATFORM_OS[platform] ?? 'linux',
    ram: { totalMB: 0, freeMB: 0 },
    vram: { totalMB: 0, freeMB: 0, gpus: [] },
    cpu: { physicalCores: 0, logicalCores: 0, name: '' }
  }
}

export function emptyCardContext(platform: string = 'linux'): CardContext {
  return {
    args: {},
    system: emptySystem(platform),
    model: null,
    overrides: { port: null, host: null, apiKeySet: false, engine: {} },
    template: { name: '', port: 0 }
  }
}

export function buildSystemContext(
  platform: string,
  ram: SystemRamInfo | null | undefined,
  vram: VramInfo | null | undefined,
  cpu: CpuInfo | null | undefined
): CardSystem {
  const sys = emptySystem(platform)
  if (ram) sys.ram = { totalMB: ram.totalRAMMB || 0, freeMB: ram.freeRAMMB || 0 }
  if (vram && vram.totalVRAMMB > 0) {
    // The app reads one memory pool; a card sees it as a single GPU.
    sys.vram = {
      totalMB: vram.totalVRAMMB, freeMB: vram.freeVRAMMB,
      gpus: [{ name: vram.gpuName ?? 'GPU', totalMB: vram.totalVRAMMB, freeMB: vram.freeVRAMMB }]
    }
  }
  if (cpu) sys.cpu = { physicalCores: cpu.physicalCores, logicalCores: cpu.logicalCores, name: cpu.modelName }
  return sys
}

function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}

export function buildModelContext(modelPath: string, meta: Partial<GgufMetadata> | null | undefined): CardModel | null {
  if (!modelPath) return null
  return {
    path: modelPath,
    fileName: baseName(modelPath),
    sizeMB: meta?.fileSizeMB ?? 0,
    arch: meta?.architecture ?? null,
    contextLength: meta?.contextLength ?? null,
    layers: meta?.blockCount ?? null,
    expertCount: meta?.expertCount ?? null,
    hiddenSize: meta?.hiddenSize ?? null,
    headCount: meta?.headCount ?? null,
    kvHeads: meta?.kvHeads ?? null,
    isMoe: !!meta?.isMoe
  }
}

import type { MmprojOffloadMode } from './types'

// Template arg holding the per-Template choice. It is an internal "__" key:
// it never reaches llama-server itself, the resolved --no-mmproj-offload flag
// does.
export const MMPROJ_OFFLOAD_MODE_KEY = '__mmprojOffloadMode'

export function getMmprojOffloadMode(args: Record<string, any> | undefined): MmprojOffloadMode {
  const v = args?.[MMPROJ_OFFLOAD_MODE_KEY]
  return v === 'disabled' || v === 'enabled' ? v : 'follow'
}

// Whether the projector should live in RAM for this Template: its own pin
// wins, otherwise the global switch (on unless explicitly turned off).
export function resolveMmprojOffloadToRam(mode: MmprojOffloadMode, globalToRam: boolean | undefined): boolean {
  if (mode === 'enabled') return true
  if (mode === 'disabled') return false
  return globalToRam !== false
}

// Appends --no-mmproj-offload to a flat CLI flag list when the resolved
// setting is "RAM" and a projector is actually in use. --mmproj-offload is
// never emitted: GPU offload is llama-server's default, so "off" means no
// flag at all. Idempotent and a no-op without an mmproj flag.
export function applyMmprojOffloadFlag(
  flags: string[],
  args: Record<string, any> | undefined,
  globalToRam: boolean | undefined
): void {
  const hasMmproj = flags.includes('--mmproj') || flags.includes('-mm')
  if (!hasMmproj) return
  const toRam = resolveMmprojOffloadToRam(getMmprojOffloadMode(args), globalToRam)
  if (toRam && !flags.includes('--no-mmproj-offload')) flags.push('--no-mmproj-offload')
}

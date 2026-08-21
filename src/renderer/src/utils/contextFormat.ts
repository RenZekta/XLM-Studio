// Items 5 & 8: shared helpers for context-length number inputs/sliders —
// space-grouped display formatting ("2 097 152") and "Use 2x increments"
// power-of-two step snapping (2k, 4k, 8k, 16k, ... 2M), used by both the
// global Minimum AutoFit override slider (Settings) and the per-template
// Context Size slider (Context and Performance block).

// Format an integer with a plain space as the thousands separator, e.g.
// 2097152 -> "2 097 152". Deliberately NOT using toLocaleString(), which
// (a) uses commas or locale-dependent separators, and (b) was the source of
// a real bug elsewhere when its function reference was interpolated without
// being called — see the fix in useVramBudget.ts.
export function formatWithSpaces(n: number): string {
  const rounded = Math.round(n)
  const sign = rounded < 0 ? '-' : ''
  const digits = Math.abs(rounded).toString()
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

// Parse a space-formatted (or comma-formatted, or plain) number string back
// into an integer, ignoring any grouping characters the user typed/pasted.
export function parseSpacedNumber(s: string): number {
  const cleaned = s.replace(/[^\d-]/g, '')
  const n = parseInt(cleaned, 10)
  return isNaN(n) ? 0 : n
}

// The fixed 2x-increment ladder: 2k, 4k, 8k, ... up to 2 097 152 (2M).
export const CONTEXT_POWER_OF_TWO_STEPS: number[] = (() => {
  const steps: number[] = []
  for (let v = 2048; v <= 2097152; v *= 2) steps.push(v)
  return steps
})()

// Snap an arbitrary context value to the nearest step on the 2x ladder.
export function snapToNearestPowerOfTwo(value: number, steps: number[] = CONTEXT_POWER_OF_TWO_STEPS): number {
  let closest = steps[0]
  let minDiff = Math.abs(value - closest)
  for (const s of steps) {
    const diff = Math.abs(value - s)
    if (diff < minDiff) { minDiff = diff; closest = s }
  }
  return closest
}

// Index of a value on the ladder (for driving an index-based <input type=range>
// when 2x-increments is enabled). Falls back to the nearest index if the
// value isn't exactly on the ladder (e.g. a custom value typed before the
// checkbox was turned on).
export function indexOnLadder(value: number, steps: number[] = CONTEXT_POWER_OF_TWO_STEPS): number {
  const exact = steps.indexOf(value)
  if (exact !== -1) return exact
  const snapped = snapToNearestPowerOfTwo(value, steps)
  return steps.indexOf(snapped)
}

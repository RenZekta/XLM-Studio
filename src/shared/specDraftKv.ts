import { defaultKvQuantFor, defaultKvQuantVFor } from './presetBaselines'
import { getNgramModifierState } from './specToggles'

// KV cache types for the speculative-decoding draft model. They mirror the
// target model's --cache-type-k/-v: same option list per backend (schema
// defaultOptions) and the same per-fork default (turbo4/turbo3, kvarn4/
// kvarn3, q8_0), so a draft context is never left on a heavier f16 cache by
// accident.
export const SPEC_DRAFT_K_ARG = '--spec-draft-type-k'
export const SPEC_DRAFT_V_ARG = '--spec-draft-type-v'
export const SPEC_DRAFT_KV_ARGS = [SPEC_DRAFT_K_ARG, SPEC_DRAFT_V_ARG]

// True when a PRIMARY draft method (MTP, draft model, EAGLE3, DSpark2,
// DFlash2) is selected. N-gram-only speculation has no draft context, so it
// counts as "off" here, matching the Method dropdown.
export function isSpecDraftActive(args: Record<string, any>): boolean {
  return getNgramModifierState(args).primaryFlag !== null
}

// Decides what a KV-type arg should become when its backend (and so its
// default) may have changed. Returns the value to store, or undefined when
// the current value should stay. A value is replaced when it is unset, is
// not a valid option for the current backend, or is exactly the PREVIOUS
// backend's default (so it was only ever tracking "whatever this backend
// recommends"). Anything else is a deliberate choice and survives.
export function resolveKvBackfill(
  current: unknown,
  options: string[] | undefined,
  prevDefault: string,
  newDefault: string
): string | undefined {
  const unset = current === undefined || current === null || current === ''
  const invalid = !unset && !!options && !options.includes(String(current))
  const onPriorDefault = !unset && String(current) === String(prevDefault)
  if (!(unset || invalid || onPriorDefault)) return undefined
  return String(current) === String(newDefault) ? undefined : newDefault
}

// Brings the draft KV args in line with the speculative-decoding state:
// removed while speculation is off (they only mean something with a draft
// context, and an unknown draft flag has no effect worth keeping), and set to
// the backend's KV defaults while it is on. `force` overwrites existing
// values too, for preset application, which resets to the baseline. Returns
// a new object; the input is not modified.
export function applySpecDraftKvDefaults(
  args: Record<string, any>,
  backendKey: string | undefined | null,
  opts?: { force?: boolean }
): Record<string, any> {
  const out = { ...args }
  if (!isSpecDraftActive(out)) {
    for (const k of SPEC_DRAFT_KV_ARGS) delete out[k]
    return out
  }
  const defaults: [string, string][] = [
    [SPEC_DRAFT_K_ARG, defaultKvQuantFor(backendKey)],
    [SPEC_DRAFT_V_ARG, defaultKvQuantVFor(backendKey)]
  ]
  for (const [arg, def] of defaults) {
    const cur = out[arg]
    if (opts?.force || cur === undefined || cur === null || cur === '') out[arg] = def
  }
  return out
}

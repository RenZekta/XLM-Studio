// Automatic YaRN scaling control: the flags it owns while it is on, and their removal when it is
// off or the context is back at the native size.

// Set while the control is managing the flags, so that turning it off clears only what it wrote.
export const YARN_MANAGED_KEY = '__yarnAutoManaged'

export interface YarnAutoInput {
  // The control is in effect (the template's switch, or the global upscale).
  active: boolean
  // The context the template is going to run at, and the model's native context (0 while unknown).
  target: number
  native: number
  // llama.cpp also gets --yarn-orig-ctx; Strata has no such flag.
  origCtxFlag: boolean
}

// The args as the control wants them, or null when they already are (so an effect that commits
// the result cannot loop).
export function syncYarnAuto<T extends Record<string, unknown>>(args: T, o: YarnAutoInput): T | null {
  const flags = ['--rope-scaling', '--rope-scale', ...(o.origCtxFlag ? ['--yarn-orig-ctx'] : [])]
  const next: Record<string, unknown> = { ...args }
  if (o.active) {
    if (!(o.native > 0)) return null
    const scale = Math.round((o.target / o.native) * 100) / 100
    if (scale > 1) {
      next['--rope-scaling'] = 'yarn'
      next['--rope-scale'] = scale
      if (o.origCtxFlag) next['--yarn-orig-ctx'] = o.native
    } else {
      for (const f of flags) delete next[f]
    }
    next[YARN_MANAGED_KEY] = true
  } else {
    if (!(YARN_MANAGED_KEY in args)) return null
    for (const f of flags) delete next[f]
    delete next[YARN_MANAGED_KEY]
  }
  const keys = new Set([...Object.keys(args), ...Object.keys(next)])
  for (const k of keys) {
    if (String(args[k]) !== String(next[k]) || (k in args) !== (k in next)) return next as T
  }
  return null
}

// "N-gram Map (K4V)" and "N-gram Modifier" are UI toggles over a composite
// llama.cpp representation: --spec-type is a comma-separated list (one
// mutually-exclusive PRIMARY draft method segment, plus these two additive,
// stackable modifier segments), and each modifier has its own 3 underlying
// flags that only make sense while its segment is present. Ported verbatim
// from CmdParamsEditor.tsx's setNgramModifier() so the MCP layer can offer
// the same simple on/off toggle (with defaults auto-applied) instead of
// requiring a caller to hand-construct the --spec-type string.
export type NgramModifier = 'map-k4v' | 'mod'

function setIfAbsent(obj: Record<string, any>, key: string, val: any) {
  if (obj[key] === undefined || obj[key] === null || obj[key] === '') obj[key] = val
}

export function buildSpecTypeValue(primaryFlag: string | null, mapK4v: boolean, mod: boolean): string {
  const parts: string[] = []
  if (primaryFlag) parts.push(primaryFlag)
  if (mapK4v) parts.push('ngram-map-k4v')
  if (mod) parts.push('ngram-mod')
  return parts.join(',')
}

// The mutually-exclusive PRIMARY draft-method flags (see SPEC_TIER_DEFS in
// CmdParamsEditor.tsx) — used only to find which segment of --spec-type (if
// any) is the primary method, so it's preserved when toggling a modifier.
const PRIMARY_SPEC_FLAGS = ['draft-mtp', 'draft-simple', 'draft-eagle3', 'draft-dspark', 'draft-dflash']

export function getNgramModifierState(args: Record<string, any>): { mapK4vOn: boolean; modOn: boolean; primaryFlag: string | null } {
  const raw = args['--spec-type']
  const segments = typeof raw === 'string' && raw.length > 0 ? raw.split(',').map(s => s.trim()).filter(Boolean) : []
  return {
    mapK4vOn: segments.includes('ngram-map-k4v'),
    modOn: segments.includes('ngram-mod'),
    primaryFlag: segments.find(s => PRIMARY_SPEC_FLAGS.includes(s)) || null
  }
}

// Returns a NEW args object with the given modifier toggled — same
// --spec-type rebuild + default-seeding/cleanup of its 3 underlying flags
// as the UI's own toggle switch.
export function applyNgramModifierToggle(args: Record<string, any>, which: NgramModifier, on: boolean): Record<string, any> {
  const newArgs = { ...args }
  const { mapK4vOn, modOn, primaryFlag } = getNgramModifierState(args)
  const nextMapK4v = which === 'map-k4v' ? on : mapK4vOn
  const nextMod = which === 'mod' ? on : modOn
  const value = buildSpecTypeValue(primaryFlag, nextMapK4v, nextMod)
  if (value) newArgs['--spec-type'] = value
  else delete newArgs['--spec-type']
  if (which === 'map-k4v') {
    if (on) {
      setIfAbsent(newArgs, '--spec-ngram-map-k4v-size-n', 12)
      setIfAbsent(newArgs, '--spec-ngram-map-k4v-size-m', 48)
      setIfAbsent(newArgs, '--spec-ngram-map-k4v-min-hits', 1)
    } else {
      delete newArgs['--spec-ngram-map-k4v-size-n']
      delete newArgs['--spec-ngram-map-k4v-size-m']
      delete newArgs['--spec-ngram-map-k4v-min-hits']
    }
  }
  if (which === 'mod') {
    if (on) {
      setIfAbsent(newArgs, '--spec-ngram-mod-n-match', 24)
      setIfAbsent(newArgs, '--spec-ngram-mod-n-min', 48)
      setIfAbsent(newArgs, '--spec-ngram-mod-n-max', 64)
    } else {
      delete newArgs['--spec-ngram-mod-n-match']
      delete newArgs['--spec-ngram-mod-n-min']
      delete newArgs['--spec-ngram-mod-n-max']
    }
  }
  return newArgs
}

export const NGRAM_MAP_K4V_FLAGS = ['--spec-ngram-map-k4v-size-n', '--spec-ngram-map-k4v-size-m', '--spec-ngram-map-k4v-min-hits']
export const NGRAM_MOD_FLAGS = ['--spec-ngram-mod-n-match', '--spec-ngram-mod-n-min', '--spec-ngram-mod-n-max']

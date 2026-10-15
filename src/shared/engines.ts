// Engine registry. An engine is a whole inference program (llama.cpp,
// Strata). A repo is one source of an engine (a fork), and a backend is the
// GPU runtime of one build (cuda, vulkan, rocm, ...). Everything that differs
// between engines is described here so call sites branch on capabilities, not
// on engine names.

export type EngineId = 'llama.cpp' | 'strata'

// 'generic' engines run any compatible model. 'model-specific' engines run a
// fixed set of models and are only auto-selected for those.
export type EngineKind = 'generic' | 'model-specific'

// How an engine is installed and updated: 'release' downloads a GitHub
// release asset into <repo>/<backend>/<version>/, 'git' clones the repo into
// <repo>/<clone>/ and updates it with git.
export type InstallKind = 'release' | 'git'

export interface EngineCapabilities {
  gpuLayers: boolean
  // 'builds': the backend is a filter over installed builds.
  // 'flag': one install, the backend is a launch flag.
  backendSelection: 'builds' | 'flag'
  // Common/Full parameter view toggle (only worth having for large schemas).
  paramViewModes: boolean
  slotCheckpoints: boolean
  autoFit: boolean
  // Sampling defaults are passed as launch flags.
  samplingFlags: boolean
  vramEstimator: 'llama' | 'strata'
}

export interface EngineDef {
  id: EngineId
  label: string
  kind: EngineKind
  install: InstallKind
  caps: EngineCapabilities
  // Label of the Template control that picks a build of this engine.
  buildLabel: string
  followLabel: string
}

export const DEFAULT_ENGINE: EngineId = 'llama.cpp'

export const ENGINES: Record<EngineId, EngineDef> = {
  'llama.cpp': {
    id: 'llama.cpp',
    label: 'llama.cpp',
    kind: 'generic',
    install: 'release',
    caps: {
      gpuLayers: true,
      backendSelection: 'builds',
      paramViewModes: true,
      slotCheckpoints: true,
      autoFit: true,
      samplingFlags: true,
      vramEstimator: 'llama'
    },
    buildLabel: 'Backend version',
    followLabel: 'Follow global backend'
  },
  strata: {
    id: 'strata',
    label: 'Strata',
    kind: 'model-specific',
    install: 'git',
    caps: {
      gpuLayers: false,
      backendSelection: 'flag',
      paramViewModes: false,
      slotCheckpoints: false,
      autoFit: false,
      samplingFlags: false,
      vramEstimator: 'strata'
    },
    buildLabel: 'Engine version',
    followLabel: 'Follow global repo'
  }
}

export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[]

export function isEngineId(x: unknown): x is EngineId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ENGINES, x)
}

// Templates and installs saved before engines existed carry no engine field.
export function engineOf(x?: { engine?: string | null } | string | null): EngineId {
  const raw = typeof x === 'string' ? x : x?.engine
  return isEngineId(raw) ? raw : DEFAULT_ENGINE
}

export function engineDef(x?: { engine?: string | null } | string | null): EngineDef {
  return ENGINES[engineOf(x)]
}

export function modelSpecificEngines(): EngineDef[] {
  return ENGINE_IDS.map(id => ENGINES[id]).filter(e => e.kind === 'model-specific')
}

// What a model-specific engine needs to know about a model to take it:
// Strata runs files it recognises exactly or by layout. Generic engines take
// any model.
export function engineAcceptsModel(engine: EngineId, meta: { strata?: { kind?: string } } | null | undefined): boolean {
  if (ENGINES[engine].kind === 'generic') return true
  if (engine === 'strata') return meta?.strata?.kind === 'known' || meta?.strata?.kind === 'layout'
  return false
}

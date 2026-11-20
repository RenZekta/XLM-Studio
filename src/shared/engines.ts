// Engine registry. An engine is a whole inference program (llama.cpp,
// Strata). A repo is one source of an engine (a fork), and a backend is the
// GPU runtime of one build (cuda, vulkan, rocm, ...). Everything that differs
// between engines is described here so call sites branch on capabilities, not
// on engine names.

import type { EngineCard } from './engineCard'

// Built-in engines have ids of their own; any other id belongs to an engine
// card (see engineCard.ts) and exists only while its card is loaded.
export type BuiltinEngineId = 'llama.cpp' | 'strata'
export type EngineId = string

// 'generic' engines run any compatible model. 'model-specific' engines run a
// fixed set of models and are only auto-selected for those.
export type EngineKind = 'generic' | 'model-specific'

// How an engine is installed and updated: 'release' downloads a GitHub
// release asset into <repo>/<backend>/<version>/, 'git' clones the repo into
// <repo>/<clone>/ and updates it with git, 'local' is a folder the user placed
// in the engines folder and is never touched.
export type InstallKind = 'release' | 'git' | 'local'

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
  vramEstimator: 'llama' | 'strata' | 'none'
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
  // Set for engines defined by a card.
  card?: EngineCard
  // The Template names an engine whose card is not loaded.
  missing?: boolean
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

const BUILTIN_IDS: BuiltinEngineId[] = ['llama.cpp', 'strata']

// Kept in place so every importer sees engines added or removed by cards.
export const ENGINE_IDS: EngineId[] = [...BUILTIN_IDS]

export function isBuiltinEngine(id: unknown): id is BuiltinEngineId {
  return id === 'llama.cpp' || id === 'strata'
}

export function isEngineId(x: unknown): x is EngineId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(ENGINES, x)
}

// Replaces the engines that come from cards. Built-in ids are never taken.
export function registerCardEngines(defs: EngineDef[]): void {
  for (const id of Object.keys(ENGINES)) if (!isBuiltinEngine(id)) delete ENGINES[id]
  ENGINE_IDS.length = 0
  ENGINE_IDS.push(...BUILTIN_IDS)
  for (const def of defs) {
    if (isBuiltinEngine(def.id) || ENGINES[def.id]) continue
    ENGINES[def.id] = def
    ENGINE_IDS.push(def.id)
  }
}

// Templates and installs saved before engines existed carry no engine field.
// An id with no loaded card is kept as it is, so the Template reads as missing
// its engine instead of silently becoming a llama.cpp one.
export function engineOf(x?: { engine?: string | null } | string | null): EngineId {
  const raw = typeof x === 'string' ? x : x?.engine
  return typeof raw === 'string' && raw ? raw : DEFAULT_ENGINE
}

export function engineDef(x?: { engine?: string | null } | string | null): EngineDef {
  const id = engineOf(x)
  return ENGINES[id] ?? {
    id,
    label: `${id} (card missing)`,
    kind: 'generic',
    install: 'local',
    caps: { gpuLayers: false, backendSelection: 'flag', paramViewModes: false, slotCheckpoints: false, autoFit: false, samplingFlags: false, vramEstimator: 'none' },
    buildLabel: 'Engine version',
    followLabel: 'Follow global repo',
    missing: true
  }
}

export function modelSpecificEngines(): EngineDef[] {
  return ENGINE_IDS.map(id => ENGINES[id]).filter(e => e.kind === 'model-specific')
}

// What a model-specific engine needs to know about a model to take it:
// Strata runs files it recognises exactly or by layout. Generic engines take
// any model.
export function engineAcceptsModel(engine: EngineId, meta: { strata?: { kind?: string } } | null | undefined): boolean {
  if (engineDef(engine).kind === 'generic') return true
  if (engine === 'strata') return meta?.strata?.kind === 'known' || meta?.strata?.kind === 'layout'
  return false
}

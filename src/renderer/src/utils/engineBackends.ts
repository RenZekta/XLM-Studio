import type { BackendVersion } from '../../../shared/types'
import { engineOf, engineAcceptsModel, modelSpecificEngines, DEFAULT_ENGINE, type EngineId } from '../../../shared/engines'

// Which installed build a Template of a given engine runs on. One resolver
// for every consumer (launch, parameter editor, Template form) so a pinned
// choice and "follow the global selection" can never be read two ways.

export interface BackendPin {
  backendKey?: string | null
  backendType?: string | null
  backendVersion?: string | null
}

export function backendsOfEngine(backends: BackendVersion[], engine: EngineId): BackendVersion[] {
  return backends.filter(b => engineOf(b) === engine)
}

// The global selection of an engine: llama.cpp's is the sidebar's active
// backend, every other engine's is one repo from the per-engine map.
export function globalBackendOf(
  engine: EngineId,
  backends: BackendVersion[],
  activeBackend: BackendVersion | null,
  engineGlobals: Partial<Record<EngineId, { backendKey: string }>>
): BackendVersion | undefined {
  const mine = backendsOfEngine(backends, engine)
  if (engine === 'llama.cpp') return activeBackend && engineOf(activeBackend) === 'llama.cpp' ? activeBackend : mine[0]
  const key = engineGlobals[engine]?.backendKey
  return (key ? mine.find(b => b.backendKey === key) : undefined) ?? mine[0]
}

// A pin names a repo and (for engines with several builds per repo) a
// backend. Legacy pins also carry a version name, which is only used to
// tell apart builds that no longer share one folder.
export function resolveEngineBackend(
  engine: EngineId,
  pin: BackendPin | null | undefined,
  backends: BackendVersion[],
  activeBackend: BackendVersion | null,
  engineGlobals: Partial<Record<EngineId, { backendKey: string }>>
): BackendVersion | undefined {
  const mine = backendsOfEngine(backends, engine)
  if (pin?.backendKey) {
    const sameRepo = mine.filter(b => b.backendKey === pin.backendKey)
    const typed = pin.backendType !== undefined
      ? sameRepo.filter(b => (b.backendType ?? null) === (pin.backendType ?? null))
      : sameRepo
    const exact = pin.backendVersion ? typed.find(b => b.name === pin.backendVersion) : undefined
    const found = exact ?? typed[0] ?? sameRepo[0]
    if (found) return found
  }
  return globalBackendOf(engine, backends, activeBackend, engineGlobals)
}

// Backends of one engine grouped by GPU backend type, in first-seen order.
export function groupByBackendType(list: BackendVersion[], label: (type: string | null | undefined) => string): Array<{ label: string; items: BackendVersion[] }> {
  const groups: Array<{ label: string; items: BackendVersion[] }> = []
  for (const b of list) {
    const l = label(b.backendType)
    const g = groups.find(x => x.label === l)
    if (g) g.items.push(b)
    else groups.push({ label: l, items: [b] })
  }
  return groups
}

// The engine a new Template should start with for a model: the first
// model-specific engine that is installed and accepts it, else the default
// generic engine. Used once, when the Template form opens.
export function autoEngineFor(meta: any, backends: BackendVersion[]): EngineId {
  for (const e of modelSpecificEngines()) {
    if (backendsOfEngine(backends, e.id).length > 0 && engineAcceptsModel(e.id, meta)) return e.id
  }
  return DEFAULT_ENGINE
}

// A model-specific engine that accepts the model but is not installed, so the
// form can point at the tracker instead of silently using another engine.
export function missingEngineFor(meta: any, backends: BackendVersion[]): EngineId | null {
  for (const e of modelSpecificEngines()) {
    if (backendsOfEngine(backends, e.id).length === 0 && engineAcceptsModel(e.id, meta)) return e.id
  }
  return null
}

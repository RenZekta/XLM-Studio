import type { BackendVersion } from '../../../shared/types'
import { engineAcceptsModel, modelSpecificEngines, DEFAULT_ENGINE, type EngineId } from '../../../shared/engines'

// Which installed build a Template of a given engine runs on. One resolver
// for every consumer (launch, parameter editor, Template form) so a pinned
// choice and "follow the global selection" can never be read two ways.

export { backendsOfEngine, globalBackendOf, resolveEngineBackend, resolvePinned, resolveLlamaTarget, type BackendPin } from '../../../shared/backendPin'
import { backendsOfEngine } from '../../../shared/backendPin'

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

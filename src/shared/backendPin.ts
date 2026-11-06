import type { BackendVersion } from './types'
import { engineOf, type EngineId } from './engines'

// Which installed build a Template runs on. One resolver for the launch, the
// parameter editor, the Template form and the MCP tools, so a pinned choice
// and "follow the global selection" are read one way everywhere.

// Old folder names of engines that were merged into another folder (see
// TrackedBackend.legacyFolders): a Template pinned to one still means that repo.
let keyAliases: Record<string, string> = {}

export function setBackendKeyAliases(tracked: { folderName: string; legacyFolders?: string[] }[]): void {
  keyAliases = {}
  for (const t of tracked) for (const old of t.legacyFolders ?? []) keyAliases[old.toLowerCase()] = t.folderName
}

function canonicalKey(key: string): string {
  return keyAliases[key.toLowerCase()] ?? key
}

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

// A pin names a repo, a backend type and a version. The repo and type are what
// the Template means; the version only picks among builds of them, because a
// version folder is replaced when the engine is updated or rebuilt. A pin that
// cannot be met is reported, never answered with some other engine or backend.
export function resolvePinned(
  engine: EngineId, pin: BackendPin | null | undefined, backends: BackendVersion[]
): { build?: BackendVersion; missing?: string } {
  if (!pin?.backendKey) return {}
  const key = canonicalKey(pin.backendKey)
  const sameRepo = backendsOfEngine(backends, engine).filter(b => b.backendKey === key)
  if (sameRepo.length === 0) return { missing: `${key} is not installed` }
  // A pin saved before backend types existed names no type: any build of the repo.
  const typed = pin.backendType !== undefined
    ? sameRepo.filter(b => (b.backendType ?? null) === (pin.backendType ?? null))
    : sameRepo
  if (typed.length === 0) return { missing: `${key} has no ${pin.backendType} build installed` }
  const exact = pin.backendVersion ? typed.find(b => b.name === pin.backendVersion) : undefined
  // Builds are listed newest first.
  return { build: exact ?? typed[0] }
}

// What a llama.cpp Template launches on: its pin when it has one, else a
// version-only pin from an old Template, else the global selection.
export function resolveLlamaTarget(
  pin: BackendPin | null | undefined,
  backends: BackendVersion[],
  activeBackend: BackendVersion | null,
  engineGlobals: Partial<Record<EngineId, { backendKey: string }>>
): { build?: BackendVersion; missing?: string } {
  if (pin?.backendKey) return resolvePinned('llama.cpp', pin, backends)
  const mine = backendsOfEngine(backends, 'llama.cpp')
  if (pin?.backendVersion) {
    const byVersion = mine.find(b => b.name === pin.backendVersion || b.version === pin.backendVersion || b.id === pin.backendVersion)
    if (byVersion) return { build: byVersion }
  }
  return { build: globalBackendOf('llama.cpp', backends, activeBackend, engineGlobals) }
}

// For showing a pin: the build it names, or the nearest one when the exact
// backend is gone, or the global selection. Never used to launch.
export function resolveEngineBackend(
  engine: EngineId,
  pin: BackendPin | null | undefined,
  backends: BackendVersion[],
  activeBackend: BackendVersion | null,
  engineGlobals: Partial<Record<EngineId, { backendKey: string }>>
): BackendVersion | undefined {
  const exact = resolvePinned(engine, pin, backends).build
  if (exact) return exact
  if (pin?.backendKey) {
    const sameRepo = backendsOfEngine(backends, engine).filter(b => b.backendKey === canonicalKey(pin.backendKey!))
    if (sameRepo[0]) return sameRepo[0]
  }
  return globalBackendOf(engine, backends, activeBackend, engineGlobals)
}

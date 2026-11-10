// The order of an engine's parameter groups, and which group each block and parameter row sits in.
// Kept free of React so the arrangement can be checked on its own (scripts/param-layout-verify.js).
//
// A saved layout only records what the user placed. The editor's own placement (what it can show
// right now) is passed in as `defaults`: ids the layout does not know yet follow the ones it does,
// and ids it knows but the editor no longer shows are dropped.

import { ENGINES, type EngineId } from './engines'

export interface ParamLayout {
  // Group keys in display order.
  sections: string[]
  // Block ids per group key, in display order.
  blocks: Record<string, string[]>
  // Parameter flags per group key, in display order.
  rows: Record<string, string[]>
}

export const EMPTY_LAYOUT: ParamLayout = { sections: [], blocks: {}, rows: {} }

export function isEmptyLayout(layout: ParamLayout): boolean {
  return layout.sections.length === 0 &&
    Object.values(layout.blocks).every(l => l.length === 0) &&
    Object.values(layout.rows).every(l => l.length === 0)
}

export function arrangeOrder(defaults: string[], saved: string[] | undefined): string[] {
  const known = new Set(defaults)
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of saved ?? []) {
    if (known.has(key) && !seen.has(key)) { seen.add(key); out.push(key) }
  }
  for (const key of defaults) if (!seen.has(key)) out.push(key)
  return out
}

// Every id of `defaults` ends up in exactly one list. A saved id goes where it was saved when that
// group still exists; the rest return to the group the editor puts them in.
export function arrangePlacement(defaults: Record<string, string[]>, saved: Record<string, string[]> | undefined): Record<string, string[]> {
  const known = new Set(Object.values(defaults).flat())
  const placed = new Set<string>()
  const out: Record<string, string[]> = {}
  for (const key of Object.keys(defaults)) {
    out[key] = []
    for (const id of saved?.[key] ?? []) {
      if (known.has(id) && !placed.has(id)) { placed.add(id); out[key].push(id) }
    }
  }
  for (const [key, ids] of Object.entries(defaults)) {
    for (const id of ids) if (!placed.has(id)) { placed.add(id); out[key].push(id) }
  }
  return out
}

// Moves `id` into list `toKey` at slot `at`, counted in that list as it is shown, with `id` still in it.
export function movePlacement(placement: Record<string, string[]>, id: string, toKey: string, at: number): Record<string, string[]> {
  const insertAt = (placement[toKey] ?? []).slice(0, at).filter(x => x !== id).length
  const out: Record<string, string[]> = {}
  for (const [key, ids] of Object.entries(placement)) out[key] = ids.filter(x => x !== id)
  const target = out[toKey] ?? []
  out[toKey] = [...target.slice(0, insertAt), id, ...target.slice(insertAt)]
  return out
}

export function moveOrder(order: string[], id: string, at: number): string[] {
  return movePlacement({ order }, id, 'order', at).order
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')
const isListMap = (v: unknown): v is Record<string, string[]> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every(isStringList)

// A stored layout that is not shaped like one (hand-edited, from another version) is ignored.
export function parseParamLayout(raw: string | null): ParamLayout | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    if (!v || !isStringList(v.sections) || !isListMap(v.blocks) || !isListMap(v.rows)) return null
    const layout: ParamLayout = { sections: v.sections, blocks: v.blocks, rows: v.rows }
    return isEmptyLayout(layout) ? null : layout
  } catch {
    return null
  }
}

// ----- Layout presets -----
// A preset is a named layout of one engine's parameter list: engines differ in what they offer, so a
// layout is never shared between them. The Default of each engine is built in (the editor's own
// order) and is not stored, so it cannot be changed or deleted.

export interface LayoutPreset {
  id: string
  name: string
  engine: EngineId
  layout: ParamLayout
}

export interface LayoutLibrary {
  // User-made presets only.
  presets: LayoutPreset[]
  // The preset in use per engine; an engine without an entry uses its Default.
  active: Partial<Record<EngineId, string>>
}

export const EMPTY_LIBRARY: LayoutLibrary = { presets: [], active: {} }

export const defaultLayoutId = (engine: EngineId): string => `default:${engine}`
export const isDefaultLayoutId = (id: string): boolean => id.startsWith('default:')

export function defaultLayoutPreset(engine: EngineId): LayoutPreset {
  return { id: defaultLayoutId(engine), name: 'Default', engine, layout: EMPTY_LAYOUT }
}

// The engine's Default first, then its own presets in the order they were made.
export function layoutPresetsOf(lib: LayoutLibrary, engine: EngineId): LayoutPreset[] {
  return [defaultLayoutPreset(engine), ...lib.presets.filter(p => p.engine === engine)]
}

export function findLayoutPreset(lib: LayoutLibrary, engine: EngineId, id: string | undefined): LayoutPreset {
  return layoutPresetsOf(lib, engine).find(p => p.id === id) ?? defaultLayoutPreset(engine)
}

export function activeLayoutPreset(lib: LayoutLibrary, engine: EngineId): LayoutPreset {
  return findLayoutPreset(lib, engine, lib.active[engine])
}

// What the list shows: the layout being edited (the draft, else the preset it started from), or
// the engine's active preset when nothing is being edited.
export function shownLayout(lib: LayoutLibrary, engine: EngineId, edit: { presetId: string; draft: ParamLayout | null } | null): ParamLayout {
  if (!edit) return activeLayoutPreset(lib, engine).layout
  return edit.draft ?? findLayoutPreset(lib, engine, edit.presetId).layout
}

export function newLayoutPresetId(): string {
  return `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function addLayoutPreset(lib: LayoutLibrary, preset: LayoutPreset): LayoutLibrary {
  return { ...lib, presets: [...lib.presets, preset] }
}

export function updateLayoutPreset(lib: LayoutLibrary, id: string, patch: Partial<Pick<LayoutPreset, 'name' | 'layout'>>): LayoutLibrary {
  if (isDefaultLayoutId(id)) return lib
  return { ...lib, presets: lib.presets.map(p => p.id === id ? { ...p, ...patch } : p) }
}

// An engine that was using the deleted preset goes back to its Default.
export function deleteLayoutPreset(lib: LayoutLibrary, id: string): LayoutLibrary {
  if (isDefaultLayoutId(id)) return lib
  const active = { ...lib.active }
  for (const engine of Object.keys(active) as EngineId[]) if (active[engine] === id) delete active[engine]
  return { presets: lib.presets.filter(p => p.id !== id), active }
}

export function setActiveLayout(lib: LayoutLibrary, engine: EngineId, id: string): LayoutLibrary {
  const active = { ...lib.active }
  if (isDefaultLayoutId(id)) delete active[engine]
  else active[engine] = id
  return { ...lib, active }
}

function isPreset(v: any): v is LayoutPreset {
  return !!v && typeof v.id === 'string' && !isDefaultLayoutId(v.id) && typeof v.name === 'string' && v.name.trim() !== '' &&
    typeof v.engine === 'string' && v.engine in ENGINES &&
    !!v.layout && isStringList(v.layout.sections) && isListMap(v.layout.blocks) && isListMap(v.layout.rows)
}

// Reads the stored library. A single layout stored by an earlier version (shared by every Template,
// so it belonged to llama.cpp) becomes a preset of that engine and stays in use.
export function parseLayoutLibrary(raw: string | null, legacyRaw: string | null): LayoutLibrary {
  try {
    const v = raw ? JSON.parse(raw) : null
    if (v && Array.isArray(v.presets)) {
      const seen = new Set<string>()
      const presets = v.presets.filter((p: unknown): p is LayoutPreset => isPreset(p) && !seen.has(p.id) && !!seen.add(p.id))
      const active: LayoutLibrary['active'] = {}
      for (const [engine, id] of Object.entries(v.active ?? {})) {
        if (engine in ENGINES && typeof id === 'string' && presets.some((p: LayoutPreset) => p.id === id && p.engine === engine)) active[engine as EngineId] = id
      }
      return { presets, active }
    }
  } catch {}
  const legacy = parseParamLayout(legacyRaw)
  if (!legacy) return EMPTY_LIBRARY
  const preset: LayoutPreset = { id: newLayoutPresetId(), name: 'My layout', engine: 'llama.cpp', layout: legacy }
  return { presets: [preset], active: { 'llama.cpp': preset.id } }
}

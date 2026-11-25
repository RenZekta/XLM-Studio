import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { strataSourceDir } from './strataLayout'
import { engineOf } from '../shared/engines'
import type { Template, EngineValues } from '../shared/types'

// setup.py writes run-<family tag><model>.sh (.bat on Windows) next to setup.py for every
// model it starts. Nothing reads it back, so it is removed with the Template it was made for.

export interface StrataRef {
  family: string
  model: string
  backendKey?: string
  backendVersion?: string
  backendType?: string | null
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// The Strata choice a Template holds: its own while Strata is its engine, else the values
// parked in engineValues. Null when no family and model are chosen.
export function strataRefOf(t: Partial<Template>): StrataRef | null {
  const parked: EngineValues | undefined = t.engineValues?.strata
  const own = engineOf(t) === 'strata'
  const src = own ? { args: t.args, backendKey: t.backendKey, backendVersion: t.backendVersion, backendType: t.backendType } : parked
  if (!src?.args) return null
  const family = text(src.args['--family'])
  const model = text(src.args['--model'])
  if (!family || !model) return null
  return { family, model, backendKey: src.backendKey, backendVersion: src.backendVersion, backendType: src.backendType }
}

export function runScriptPaths(cloneDir: string, tags: Record<string, string>, family: string, model: string): string[] {
  if (!(family in tags) || !model) return []
  const src = strataSourceDir(cloneDir)
  const base = `run-${(tags[family] + model).toLowerCase()}`
  return [join(src, `${base}.sh`), join(src, `${base}.bat`)]
}

export interface CleanupInput {
  deleted: Partial<Template>
  remaining: Partial<Template>[]
  // The clone a Template's choice launches on, or null when there is none.
  resolve: (ref: StrataRef) => string | null
  tagsOf: (cloneDir: string) => Record<string, string>
  remove?: (path: string) => void
}

// Never throws. Returns the files removed. A script another Template still uses, with the same
// family and model on the same clone, stays.
export function removeStrataRunScripts(i: CleanupInput): string[] {
  const removed: string[] = []
  try {
    const ref = strataRefOf(i.deleted)
    if (!ref) return removed
    const clone = i.resolve(ref)
    if (!clone) return removed
    const key = (r: StrataRef) => `${r.family}\n${r.model}`.toLowerCase()
    const shared = i.remaining.some(t => {
      const r = strataRefOf(t)
      return !!r && key(r) === key(ref) && i.resolve(r) === clone
    })
    if (shared) return removed
    const drop = i.remove ?? ((p: string) => unlinkSync(p))
    for (const p of runScriptPaths(clone, i.tagsOf(clone), ref.family, ref.model)) {
      try {
        if (!existsSync(p)) continue
        drop(p)
        removed.push(p)
      } catch { /* a locked or read-only script stays */ }
    }
  } catch { /* the Template is deleted either way */ }
  return removed
}

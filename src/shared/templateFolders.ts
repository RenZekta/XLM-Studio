import type { Template, TemplateFolder } from './types'

const lower = (s: string) => s.trim().toLowerCase()

// Lowest free name in the sequence Folder, Folder 1, Folder 2, ... among the
// folders that share a parent, like a new folder in a file explorer.
export function nextFolderName(siblingNames: string[], base = 'Folder'): string {
  const taken = new Set(siblingNames.map(lower))
  if (!taken.has(lower(base))) return base
  for (let n = 1; ; n++) {
    const candidate = `${base} ${n}`
    if (!taken.has(lower(candidate))) return candidate
  }
}

// `name (Copy)`, then `name (Copy 2)`, ... until the name is free.
export function copyName(name: string, takenNames: Iterable<string>): string {
  const taken = new Set([...takenNames].map(lower))
  const stem = name.replace(/ \(Copy(?: \d+)?\)$/, '')
  let candidate = `${stem} (Copy)`
  for (let n = 2; taken.has(lower(candidate)); n++) candidate = `${stem} (Copy ${n})`
  return candidate
}

export function siblingFolders(folders: TemplateFolder[], parentId: string | null): TemplateFolder[] {
  return folders.filter(f => (f.parentId ?? null) === parentId)
}

// Where a Template shows up. A folder id that no longer exists reads as the
// top level, so a stale reference never hides a Template.
export function folderOfTemplate(t: Pick<Template, 'folderId'>, folderIds: Set<string>): string | null {
  return t.folderId && folderIds.has(t.folderId) ? t.folderId : null
}

// Folders from the top level down to `id`.
export function folderPath(folders: TemplateFolder[], id: string | null): TemplateFolder[] {
  const byId = new Map(folders.map(f => [f.id, f]))
  const path: TemplateFolder[] = []
  const seen = new Set<string>()
  let cur = id ? byId.get(id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return path
}

// `id` and every folder below it.
export function folderSubtree(folders: TemplateFolder[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true }
    }
  }
  return out
}

// Ids from the first to the last of `ordered`, in either direction.
export function idRange(ordered: string[], from: string, to: string): string[] {
  const a = ordered.indexOf(from)
  const b = ordered.indexOf(to)
  if (a === -1 || b === -1) return b === -1 ? [] : [to]
  return ordered.slice(Math.min(a, b), Math.max(a, b) + 1)
}

export function newFolderId(): string {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

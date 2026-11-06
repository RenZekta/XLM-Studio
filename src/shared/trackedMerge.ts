import type { TrackedBackend } from './types'

// Brings the saved tracker entries and the built-in ones together. Built-in
// entries always exist and always carry their current schema overrides (stored
// copies from older versions would otherwise go stale).
//
// A custom entry for the same repo, added by hand before it became built-in, is
// promoted in place and keeps its folder, so installed binaries and pinned
// templates still resolve. When the repo is tracked twice (the custom entry and
// the built-in one), they become one entry with the built-in folder, and the
// other folders are listed as legacyFolders for their contents to be moved in.
export function mergeDefaultTracked(saved: TrackedBackend[], defaults: TrackedBackend[]): TrackedBackend[] {
  const tracked = [...saved]
  for (const def of defaults) {
    const sameRepo = (t: TrackedBackend) => !t.branch && t.repo.toLowerCase() === def.repo.toLowerCase()
    const matches = tracked.filter(t => t.id === def.id || sameRepo(t))
    if (matches.length > 1) {
      const first = tracked.indexOf(matches[0])
      const legacy = new Set<string>()
      for (const m of matches) {
        for (const f of [m.folderName, ...(m.legacyFolders ?? [])]) if (f.toLowerCase() !== def.folderName.toLowerCase()) legacy.add(f)
      }
      for (const m of matches) tracked.splice(tracked.indexOf(m), 1)
      tracked.splice(Math.min(first, tracked.length), 0, { ...def, legacyFolders: [...legacy] })
      continue
    }
    const idx = tracked.findIndex(t => t.id === def.id || sameRepo(t))
    if (idx === -1) { tracked.push(def); continue }
    const existing = tracked[idx]
    tracked[idx] = existing.id === def.id
      ? { ...existing, ...def }
      : { ...def, id: existing.id, folderName: existing.folderName }
  }
  return tracked
}

import type { TrackedBackend } from './types'
import type { ForkCard } from './engineCard'

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

// Brings the tracker entries that fork cards define into the saved list. An
// entry made from a card follows the card (name, branch, parameters) and goes
// away with it. A hand-made entry for the same repo and branch is taken over in
// place, keeping its folder so installed builds and pinned Templates still
// resolve. A built-in entry for the same repo and branch has parameters of its
// own, so a card for it is left out.
export function mergeCardForks(
  saved: TrackedBackend[],
  forks: ForkCard[],
  folderFor: (repo: string, taken: Set<string>, branch?: string) => string
): TrackedBackend[] {
  const ids = new Set(forks.map(f => f.id))
  const tracked = saved.filter(t => !t.fromCard || ids.has(t.fromCard))
  for (const fork of forks) {
    const repo = fork.source.repo
    const branch = fork.source.branch || undefined
    const same = (t: TrackedBackend) => t.repo.toLowerCase() === repo.toLowerCase() && (t.branch ?? '') === (branch ?? '')
    const own = tracked.findIndex(t => t.fromCard === fork.id)
    const at = own !== -1 ? own : tracked.findIndex(t => !t.isDefault && !t.fromCard && same(t))
    if (at === -1 && tracked.some(t => t.isDefault && same(t))) continue
    const base = at !== -1 ? tracked[at] : null
    const taken = new Set(tracked.map(t => t.folderName.toLowerCase()))
    const entry: TrackedBackend = {
      ...(base ?? {}),
      id: base?.id ?? `card-${fork.id}`,
      repo,
      name: fork.label,
      folderName: base?.folderName ?? folderFor(repo, taken, branch),
      isDefault: false,
      fromCard: fork.id
    }
    if (branch) entry.branch = branch; else delete entry.branch
    if (fork.params) entry.extraCommands = fork.params.categories; else delete entry.extraCommands
    if (fork.defaultOptions) entry.defaultOptions = fork.defaultOptions; else delete entry.defaultOptions
    if (at !== -1) tracked[at] = entry; else tracked.push(entry)
  }
  return tracked
}

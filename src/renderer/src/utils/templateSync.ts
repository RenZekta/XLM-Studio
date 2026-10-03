import { useStore } from '../store/useStore'
import type { Template } from '../../../shared/types'

// Every expanded or collapsed card mounts its own CmdParamsEditor, and each
// one saves its template to disk debounced and independently. Every save
// makes the main process broadcast 'templates-changed', after which the
// renderer re-reads ALL templates from disk. If a card's own save hasn't
// landed yet, that read still holds its previous args, so applying it would
// revert the card in memory (and then flip it forward again once its save
// lands). A template with an edit that hasn't reached disk is therefore
// tracked here, and the disk copy never overwrites its in-memory args.
const pendingSaves = new Map<string, number>()

// A read of the template files is applied some time after it was taken, and a
// save can settle in between, which makes that snapshot stale for the
// template even though nothing is pending anymore. Settles are therefore
// stamped from a counter, and a read carries the counter value from when it
// started.
let clock = 0
const lastSettled = new Map<string, number>()

export function markTemplateSavePending(id: string): void {
  pendingSaves.set(id, (pendingSaves.get(id) || 0) + 1)
}

export function markTemplateSaveDone(id: string): void {
  const n = (pendingSaves.get(id) || 0) - 1
  if (n > 0) pendingSaves.set(id, n)
  else pendingSaves.delete(id)
  lastSettled.set(id, ++clock)
}

// Call immediately before listing the templates from disk.
export function templateReadToken(): number {
  return clock
}

function diskCopyIsStale(id: string, readToken: number): boolean {
  return pendingSaves.has(id) || (lastSettled.get(id) ?? 0) > readToken
}

// Merges the on-disk template list into the store by id, so a running card's
// live status/expanded/tempPort survive, and a card whose own edit is newer
// than the disk read keeps its in-memory args.
export function reconcileTemplatesFromDisk(templates: Template[], readToken: number): void {
  const { cards, addCard, updateCard, removeCard } = useStore.getState()
  const onDiskIds = new Set(templates.map(t => t.id))
  for (const c of cards) {
    if (!onDiskIds.has(c.template.id)) removeCard(c.template.id)
  }
  const cardIds = new Set(useStore.getState().cards.map(c => c.template.id))
  for (const t of templates) {
    if (!cardIds.has(t.id)) { addCard(t); continue }
    if (diskCopyIsStale(t.id, readToken)) {
      const { args: _staleArgs, ...rest } = t
      updateCard(t.id, rest)
    } else {
      updateCard(t.id, t)
    }
  }
}

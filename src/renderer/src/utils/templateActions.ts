import { useStore } from '../store/useStore'
import type { Template, TemplateFolder } from '../../../shared/types'
import { copyName, folderOfTemplate, folderSubtree, newFolderId, nextFolderName, siblingFolders } from '../../../shared/templateFolders'

// Everything here works on ids that name either a Template or a folder, since
// the Templates page selects both the same way.

const state = () => useStore.getState()

let uidCounter = 0
const newTemplateId = () => `${Date.now()}${(uidCounter++ % 100).toString().padStart(2, '0')}${Math.floor(Math.random() * 10)}`

export function isFolderId(id: string): boolean {
  return state().templateFolders.some(f => f.id === id)
}

export function persistFolders(folders: TemplateFolder[]): void {
  state().setTemplateFolders(folders)
  window.api.saveTemplateFolders(folders).catch(() => {})
}

function folderIdSet(): Set<string> {
  return new Set(state().templateFolders.map(f => f.id))
}

// Templates whose effective folder is `folderId`.
function templatesIn(folderId: string): Template[] {
  const ids = folderIdSet()
  return state().cards.map(c => c.template).filter(t => folderOfTemplate(t, ids) === folderId)
}

export async function moveItems(ids: string[], target: string | null): Promise<void> {
  const { templateFolders, updateCard } = state()
  const folderIds = ids.filter(isFolderId)
  const templateIds = ids.filter(id => !folderIds.includes(id))
  // A folder cannot move into itself or anything below it.
  const movable = folderIds.filter(id => target === null || !folderSubtree(templateFolders, id).has(target))
  if (movable.length) {
    persistFolders(templateFolders.map(f => movable.includes(f.id) ? { ...f, parentId: target } : f))
  }
  if (templateIds.length) {
    for (const id of templateIds) updateCard(id, { folderId: target })
    await window.api.moveTemplates(templateIds, target)
  }
}

export function createFolder(parentId: string | null): TemplateFolder {
  const { templateFolders } = state()
  const folder: TemplateFolder = {
    id: newFolderId(),
    name: nextFolderName(siblingFolders(templateFolders, parentId).map(f => f.name)),
    parentId
  }
  persistFolders([...templateFolders, folder])
  return folder
}

export async function groupIntoNewFolder(ids: string[], parentId: string | null): Promise<TemplateFolder> {
  const folder = createFolder(parentId)
  await moveItems(ids, folder.id)
  return folder
}

// false when the name is empty or another folder next to it already has it.
export function renameFolder(id: string, name: string): boolean {
  const { templateFolders } = state()
  const folder = templateFolders.find(f => f.id === id)
  const clean = name.trim()
  if (!folder || !clean) return false
  const clash = siblingFolders(templateFolders, folder.parentId).some(f => f.id !== id && f.name.toLowerCase() === clean.toLowerCase())
  if (clash) return false
  persistFolders(templateFolders.map(f => f.id === id ? { ...f, name: clean } : f))
  return true
}

async function cloneTemplate(t: Template, folderId: string | null, taken: Set<string>): Promise<string> {
  const { mainForPort: _m, mainStarredAt: _s, _file: _f, order: _o, ...rest } = t as Template & { _file?: string; order?: number }
  const name = copyName(t.name, taken)
  taken.add(name)
  const now = new Date().toISOString()
  const clone = { ...rest, id: newTemplateId(), name, folderId, createdAt: now, updatedAt: now } as Template
  const res = await window.api.saveTemplate(clone)
  if (res.success) state().addCard(clone)
  return clone.id
}

async function cloneFolder(folder: TemplateFolder, parentId: string | null, taken: Set<string>): Promise<string> {
  const siblings = siblingFolders(state().templateFolders, parentId).map(f => f.name)
  const name = siblings.some(n => n.toLowerCase() === folder.name.toLowerCase()) ? copyName(folder.name, siblings) : folder.name
  const copy: TemplateFolder = { id: newFolderId(), name, parentId }
  persistFolders([...state().templateFolders, copy])
  for (const t of templatesIn(folder.id)) await cloneTemplate(t, copy.id, taken)
  for (const child of siblingFolders(state().templateFolders, folder.id)) await cloneFolder(child, copy.id, taken)
  return copy.id
}

// Copies items into `target`; 'same' puts each copy beside its original.
// Returns the ids of the new items.
export async function copyItems(ids: string[], target: string | null | 'same'): Promise<string[]> {
  const taken = new Set(state().cards.map(c => c.template.name))
  const folderIds = folderIdSet()
  const out: string[] = []
  for (const id of ids) {
    const folder = state().templateFolders.find(f => f.id === id)
    if (folder) {
      out.push(await cloneFolder(folder, target === 'same' ? folder.parentId : target, taken))
      continue
    }
    const t = state().cards.find(c => c.template.id === id)?.template
    if (t) out.push(await cloneTemplate(t, target === 'same' ? folderOfTemplate(t, folderIds) : target, taken))
  }
  return out
}

// Every Template that deleting these items would remove.
function templatesUnder(ids: string[]): Template[] {
  const { templateFolders, cards } = state()
  const folderIds = folderIdSet()
  const doomedFolders = new Set<string>()
  for (const id of ids.filter(isFolderId)) folderSubtree(templateFolders, id).forEach(f => doomedFolders.add(f))
  return cards.map(c => c.template).filter(t => ids.includes(t.id) || doomedFolders.has(folderOfTemplate(t, folderIds) ?? ''))
}

export async function deleteItems(ids: string[]): Promise<boolean> {
  const { templateFolders, cards, removeCard } = state()
  const doomed = templatesUnder(ids)
  if (doomed.some(t => cards.find(c => c.template.id === t.id)?.status === 'running')) {
    alert('Please stop the running model before deleting.')
    return false
  }
  const folderCount = ids.filter(isFolderId).length
  const what = [
    doomed.length ? `${doomed.length} template${doomed.length === 1 ? '' : 's'}` : '',
    folderCount ? `${folderCount} folder${folderCount === 1 ? '' : 's'} with everything inside` : ''
  ].filter(Boolean).join(' and ')
  if (!confirm(`Delete ${what}?`)) return false
  for (const t of doomed) {
    await window.api.deleteTemplate(t.id)
    removeCard(t.id)
  }
  const gone = new Set<string>()
  for (const id of ids.filter(isFolderId)) folderSubtree(templateFolders, id).forEach(f => gone.add(f))
  if (gone.size) persistFolders(templateFolders.filter(f => !gone.has(f.id)))
  return true
}

// Removes the folders and puts what was inside one level up.
export async function ungroupFolders(ids: string[]): Promise<void> {
  for (const id of ids.filter(isFolderId)) {
    const folder = state().templateFolders.find(f => f.id === id)
    if (!folder) continue
    const childTemplates = templatesIn(id).map(t => t.id)
    const childFolders = siblingFolders(state().templateFolders, id).map(f => f.id)
    await moveItems([...childTemplates, ...childFolders], folder.parentId)
    persistFolders(state().templateFolders.filter(f => f.id !== id))
  }
}

export async function toggleMain(t: Template): Promise<void> {
  const nowMain = t.mainForPort !== true
  const patch: Partial<Template> = nowMain
    ? { mainForPort: true, mainStarredAt: Date.now() }
    : { mainForPort: false, mainStarredAt: undefined }
  state().updateCard(t.id, patch)
  // The main process owns the one-Main-Template-per-port rule and may unstar
  // another Template; its 'templates-changed' broadcast reconciles the cards.
  await window.api.saveTemplate({ ...t, ...patch })
}

export async function exportTemplate(t: Template): Promise<void> {
  await window.api.exportTemplate({ ...t, folderId: undefined })
}

export async function copyLaunchCommand(id: string): Promise<void> {
  const res = await window.api.getLaunchCommand(id)
  if (res.command) await navigator.clipboard.writeText(res.command)
  else alert(`Could not build the launch command: ${res.error || 'unknown error'}`)
}

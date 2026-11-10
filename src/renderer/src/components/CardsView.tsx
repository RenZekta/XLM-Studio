import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/useStore'
import ModelCard from './ModelCard'
import FolderCard from './FolderCard'
import ContextMenu, { MenuEntry } from './ContextMenu'
import {
  Plus, Download, Search, ArrowUp, Settings, Star, Copy, Upload, Terminal, FolderPlus, FolderOpen,
  FolderMinus, Scissors, ClipboardPaste, Trash, Pencil, CopyPlus, LayoutList, X
} from 'lucide-react'
import type { CardState, Template } from '../../../shared/types'
import { engineOf } from '../../../shared/engines'
import { folderOfTemplate, folderPath, idRange, siblingFolders } from '../../../shared/templateFolders'
import { effectiveTemplatePort } from '../utils/templatePort'
import {
  copyItems, copyLaunchCommand, createFolder, deleteItems, exportTemplate, groupIntoNewFolder, isFolderId,
  moveItems, persistFolders, renameFolder, toggleMain, ungroupFolders
} from '../utils/templateActions'

const TEMPLATE_SEARCH_KEY = 'hexllama_template_search'
const DRAG_THRESHOLD_PX = 5
const EDGE_SCROLL_PX = 60
// Clicks this soon after a drag ends belong to the drag, not to a card.
const POST_DRAG_CLICK_MS = 120
// A folder stretched beside tall Templates stops growing here, so a folder
// next to an expanded card doesn't become a huge tile.
const FOLDER_MAX_STRETCH_PX = 240
// A folder's middle drops things inside it; its outer quarters on each side
// reorder folders instead.
const FOLDER_EDGE_FRACTION = 0.25
// data-drop-folder value of the top-level crumb in the path bar.
const ROOT_DROP = '__root__'

// Clicks, presses and right-clicks on these keep their own behavior.
const INTERACTIVE = 'button, input, textarea, select, a, label, [contenteditable="true"]'

type Clip = { ids: string[]; mode: 'copy' | 'cut' }

// A stretched folder's own height: measured on a copy without the stretch, since the stretched
// height depends on the row it sits in and not on what the folder is.
function naturalFolderHeight(card: HTMLElement): number {
  const probe = card.cloneNode(true) as HTMLElement
  probe.classList.remove('folder-stretch')
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${card.getBoundingClientRect().width}px`
  card.parentElement?.appendChild(probe)
  const height = probe.getBoundingClientRect().height
  probe.remove()
  return height
}

export default function CardsView() {
  const {
    cards, setCards, setShowCreateModal, addCard, templateSearch, setTemplateSearch,
    templateFolders, currentFolderId, setCurrentFolderId, view, showCreateModal, baseUrlOverride,
    toggleCardExpanded, layoutEdit, startLayoutEdit, cancelLayoutEdit
  } = useStore()
  useEffect(() => {
    const saved = localStorage.getItem(TEMPLATE_SEARCH_KEY)
    if (saved) setTemplateSearch(saved)
  }, [setTemplateSearch])
  useEffect(() => {
    localStorage.setItem(TEMPLATE_SEARCH_KEY, templateSearch)
  }, [templateSearch])

  const folderIdSet = useMemo(() => new Set(templateFolders.map(f => f.id)), [templateFolders])
  // An open folder that no longer exists (deleted, or removed on disk) falls
  // back to the top level.
  useEffect(() => {
    if (currentFolderId && !folderIdSet.has(currentFolderId)) setCurrentFolderId(null)
  }, [currentFolderId, folderIdSet, setCurrentFolderId])

  async function handleImport() {
    const template = await window.api.importTemplate()
    if (template) {
      addCard(template as Template)
      if (currentFolderId) await moveItems([(template as Template).id], currentFolderId)
    }
  }

  // ---- What the current level shows -------------------------------------
  const query = templateSearch.trim().toLowerCase()
  // Searching looks through every folder and lists matches flat; otherwise
  // only the open folder's own folders and Templates are shown.
  const levelFolders = query
    ? templateFolders.filter(f => f.name.toLowerCase().includes(query))
    : siblingFolders(templateFolders, currentFolderId)
  const levelCards = cards.filter(c => {
    if (!query) return folderOfTemplate(c.template, folderIdSet) === currentFolderId
    return c.template.name.toLowerCase().includes(query) ||
      (c.template.description || '').toLowerCase().includes(query) ||
      c.template.tags?.some(t => t.toLowerCase().includes(query))
  })
  const orderedIds = [...levelFolders.map(f => f.id), ...levelCards.map(c => c.template.id)]
  const path = folderPath(templateFolders, currentFolderId)

  // Folders holding a running Template, at any depth, get the green outline.
  const runningFolderIds = useMemo(() => {
    const out = new Set<string>()
    const parentOf = new Map(templateFolders.map(f => [f.id, f.parentId]))
    for (const c of cards) {
      if (c.status !== 'running') continue
      let id = folderOfTemplate(c.template, folderIdSet)
      while (id && !out.has(id)) { out.add(id); id = parentOf.get(id) ?? null }
    }
    return out
  }, [cards, templateFolders, folderIdSet])

  // The grid's column count depends on the window width. Folders on the last,
  // partly filled row (with Templates continuing beside them) stretch to the
  // row's height instead of leaving a gap under them.
  const gridRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(1)
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = () => setColumns(Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(grid)
    return () => ro.disconnect()
  })
  const leftoverFolders = levelCards.length > 0 ? levelFolders.length % columns : 0

  // ---- Selection ---------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const [clip, setClip] = useState<Clip | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; ids: string[] } | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // Drop selected ids that left the view (search changed, item deleted).
  const orderedKey = orderedIds.join('|')
  useEffect(() => {
    setSelected(prev => {
      const visible = new Set(orderedIds)
      const next = new Set([...prev].filter(id => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [orderedKey])

  // Edit Layout belongs to one open Template: it ends when that Template leaves the view or the page.
  useEffect(() => {
    if (layoutEdit && !orderedIds.includes(layoutEdit.templateId)) cancelLayoutEdit()
  }, [orderedKey, layoutEdit?.templateId])
  useEffect(() => () => cancelLayoutEdit(), [])

  function openFolder(id: string | null) {
    setCurrentFolderId(id)
    setSelected(new Set())
    anchorRef.current = null
    setTemplateSearch('')
    setRenamingId(null)
  }
  function goUp() {
    if (path.length === 0) return
    openFolder(path.length > 1 ? path[path.length - 2].id : null)
  }

  function handleItemClick(id: string, e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return
    if (!(e.target as HTMLElement).closest('.card-drag-region')) return
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id); else next.add(id)
        return next
      })
      anchorRef.current = id
    } else if (e.shiftKey) {
      const from = anchorRef.current && orderedIds.includes(anchorRef.current) ? anchorRef.current : id
      const range = idRange(orderedIds, from, id)
      setSelected(prev => new Set([...prev, ...range]))
      if (!anchorRef.current) anchorRef.current = id
    } else {
      setSelected(new Set([id]))
      anchorRef.current = id
    }
  }

  // ---- Clipboard-style actions ------------------------------------------
  const selectedList = () => orderedIds.filter(id => selected.has(id))

  function doCopy(ids: string[]) { if (ids.length) setClip({ ids, mode: 'copy' }) }
  function doCut(ids: string[]) { if (ids.length) setClip({ ids, mode: 'cut' }) }
  async function doPaste() {
    if (!clip) return
    const live = clip.ids.filter(id => isFolderId(id) || cards.some(c => c.template.id === id))
    if (clip.mode === 'copy') {
      const made = await copyItems(live, currentFolderId)
      setSelected(new Set(made))
    } else {
      await moveItems(live, currentFolderId)
      setSelected(new Set(live))
      setClip(null)
    }
  }
  async function doGroup(ids: string[]) {
    if (!ids.length) return
    setTemplateSearch('')
    const folder = await groupIntoNewFolder(ids, currentFolderId)
    setSelected(new Set([folder.id]))
    setRenamingId(folder.id)
  }
  function doNewFolder() {
    setTemplateSearch('')
    const folder = createFolder(currentFolderId)
    setSelected(new Set([folder.id]))
    setRenamingId(folder.id)
  }
  async function doDelete(ids: string[]) {
    if (!ids.length) return
    if (await deleteItems(ids)) setSelected(new Set())
  }

  // ---- Keyboard ----------------------------------------------------------
  const latest = useRef({ orderedIds, selected, clip, path })
  latest.current = { orderedIds, selected, clip, path }
  const actionsRef = useRef({ doCopy, doCut, doPaste, doDelete, goUp, openFolder })
  actionsRef.current = { doCopy, doCut, doPaste, doDelete, goUp, openFolder }
  useEffect(() => {
    if (view !== 'cards' || showCreateModal) return
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]')) return
      const { orderedIds: ids, selected: sel, clip: cl } = latest.current
      const A = actionsRef.current
      const picked = ids.filter(id => sel.has(id))
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'a') {
        e.preventDefault()
        setSelected(new Set(ids))
      } else if (mod && (key === 'c' || key === 'x')) {
        // Leave a text selection (copying a path out of a card) alone.
        if (window.getSelection()?.toString() || picked.length === 0) return
        e.preventDefault()
        if (key === 'c') A.doCopy(picked); else A.doCut(picked)
      } else if (mod && key === 'v') {
        if (!cl) return
        e.preventDefault()
        A.doPaste()
      } else if (e.key === 'Delete' && picked.length) {
        e.preventDefault()
        A.doDelete(picked)
      } else if (e.key === 'F2' && picked.length === 1 && isFolderId(picked[0])) {
        e.preventDefault()
        setRenamingId(picked[0])
      } else if (e.key === 'Enter' && picked.length === 1 && isFolderId(picked[0])) {
        A.openFolder(picked[0])
      } else if (e.key === 'Backspace' && latest.current.path.length > 0) {
        e.preventDefault()
        A.goUp()
      } else if (e.key === 'Escape') {
        // The context menu uses this Escape to close itself.
        if (document.querySelector('.context-menu')) return
        setSelected(new Set())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, showCreateModal])

  // ---- Context menu and click-away, on the page-wide scroll container ----
  // so a right-click in the empty margins counts as "anywhere" too.
  const rootRef = useRef<HTMLDivElement>(null)
  const contextRef = useRef<(e: MouseEvent) => void>(() => {})
  contextRef.current = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select, [contenteditable="true"], .context-menu')) return
    e.preventDefault()
    const hit = target.closest('[data-item-id]')?.getAttribute('data-item-id') || null
    const ids = selected.size > 0 ? selectedList() : hit ? [hit] : []
    setMenu({ x: e.clientX, y: e.clientY, ids })
  }
  const dragEndRef = useRef(0)
  useEffect(() => {
    if (view !== 'cards') return
    const scroller = rootRef.current?.closest('.content') as HTMLElement | null
    if (!scroller) return
    const onContext = (e: MouseEvent) => contextRef.current(e)
    const onClick = (e: MouseEvent) => {
      if (Date.now() - dragEndRef.current < POST_DRAG_CLICK_MS) return
      const t = e.target as HTMLElement
      if (t.closest('[data-item-id], button, input, textarea, select, a, .context-menu, .page-header, .template-search-bar, .folder-bar')) return
      setSelected(new Set())
    }
    scroller.addEventListener('contextmenu', onContext)
    scroller.addEventListener('click', onClick)
    return () => {
      scroller.removeEventListener('contextmenu', onContext)
      scroller.removeEventListener('click', onClick)
    }
  }, [view])

  function buildMenu(ids: string[]): MenuEntry[] {
    const layoutItems: MenuEntry[] = layoutEdit
      ? [{ key: 'quit-layout', label: 'Quit Edit Layout', icon: <X size={14} />, onClick: cancelLayoutEdit }, null]
      : []
    return [...layoutItems, ...buildBaseMenu(ids)]
  }

  function buildBaseMenu(ids: string[]): MenuEntry[] {
    if (ids.length === 0) {
      return [
        { key: 'new-template', label: 'New Template', icon: <Plus size={14} />, onClick: () => setShowCreateModal(true) },
        { key: 'new-folder', label: 'New Folder', icon: <FolderPlus size={14} />, onClick: doNewFolder },
        ...(clip ? [{ key: 'paste', label: 'Paste', icon: <ClipboardPaste size={14} />, hint: 'Ctrl+V', onClick: doPaste }] : [])
      ]
    }
    const folders = ids.filter(isFolderId)
    const templates = ids.filter(id => !folders.includes(id))
    const single = ids.length === 1
    const items: MenuEntry[] = []
    if (single && folders.length === 1) {
      items.push({ key: 'open', label: 'Open Folder', icon: <FolderOpen size={14} />, onClick: () => openFolder(ids[0]) })
      items.push({ key: 'rename', label: 'Rename', icon: <Pencil size={14} />, hint: 'F2', onClick: () => setRenamingId(ids[0]) })
    }
    if (single && templates.length === 1) {
      const t = cards.find(c => c.template.id === ids[0])?.template
      if (t) {
        const isMain = t.mainForPort === true
        items.push({ key: 'edit', label: 'Edit Template', icon: <Settings size={14} />, onClick: () => setShowCreateModal(true, t) })
        if (layoutEdit?.templateId !== t.id) {
          items.push({
            key: 'edit-layout', label: 'Edit Layout', icon: <LayoutList size={14} />,
            onClick: () => {
              if (!cards.find(c => c.template.id === t.id)?.expanded) toggleCardExpanded(t.id)
              startLayoutEdit(t.id, engineOf(t))
            }
          })
        }
        items.push({
          key: 'star', icon: <Star size={14} />, onClick: () => toggleMain(t),
          label: isMain ? 'Unstar Main Template' : `Star as Main Template (port ${effectiveTemplatePort(t, baseUrlOverride)})`
        })
        items.push({ key: 'launch-cmd', label: 'Copy the launch command to clipboard', icon: <Terminal size={14} />, onClick: () => copyLaunchCommand(t.id) })
        items.push({ key: 'export', label: 'Export', icon: <Upload size={14} />, onClick: () => exportTemplate(t) })
      }
    }
    items.push({ key: 'duplicate', label: 'Duplicate', icon: <CopyPlus size={14} />, onClick: async () => setSelected(new Set(await copyItems(ids, 'same'))) })
    items.push(null)
    items.push({ key: 'copy', label: 'Copy', icon: <Copy size={14} />, hint: 'Ctrl+C', onClick: () => doCopy(ids) })
    items.push({ key: 'cut', label: 'Cut', icon: <Scissors size={14} />, hint: 'Ctrl+X', onClick: () => doCut(ids) })
    items.push({ key: 'group', label: 'Group into folder', icon: <FolderPlus size={14} />, onClick: () => doGroup(ids) })
    if (folders.length === ids.length) {
      items.push({ key: 'ungroup', label: 'Ungroup', icon: <FolderMinus size={14} />, onClick: () => ungroupFolders(ids) })
    }
    items.push(null)
    items.push({ key: 'delete', label: 'Delete', icon: <Trash size={14} />, hint: 'Del', danger: true, onClick: () => doDelete(ids) })
    return items
  }

  // ---- Pointer-driven drag -----------------------------------------------
  // Not the browser's native drag-and-drop: during a native drag the OS owns
  // the cursor (an arrow with a dotted box), so a grabbing hand can't be
  // shown. Here the page keeps the cursor and a floating copy of the card
  // follows the pointer.
  const [dragIds, setDragIds] = useState<string[] | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [dropFolderAt, setDropFolderAt] = useState<number | null>(null)
  // Folder (or path-bar crumb, ROOT_DROP) the drop would move things into.
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const wrapRefs = useRef(new Map<string, HTMLDivElement>())
  const pressRef = useRef<{ id: string; x: number; y: number } | null>(null)
  const dragRef = useRef<{
    ids: string[]
    ghost: HTMLElement
    offX: number
    offY: number
    templateRects: { id: string; rect: DOMRect }[]
    folderRects: { id: string; rect: DOMRect }[]
    startScroll: number
    scroller: HTMLElement | null
    last: { x: number; y: number }
    timer: number
    templateHeight: number
    folderHeight: number
    dropAt: number | null
    dropFolderAt: number | null
    dropFolder: string | null
  } | null>(null)

  // Window listeners must keep one identity across renders to be removable,
  // so they forward to whichever render's handlers are newest.
  const fnsRef = useRef({ move: onPointerMove, up: onPointerUp, key: onDragKey })
  fnsRef.current = { move: onPointerMove, up: onPointerUp, key: onDragKey }
  const stable = useRef({
    move: (e: MouseEvent) => fnsRef.current.move(e),
    up: () => fnsRef.current.up(),
    key: (e: KeyboardEvent) => fnsRef.current.key(e)
  }).current

  function handleItemMouseDown(id: string, e: React.MouseEvent) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest(INTERACTIVE) || !target.closest('.card-drag-region')) return
    // Keeps a press-and-drag from selecting text, and shift-click from
    // extending a text selection. A focused field loses focus by hand.
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    pressRef.current = { id, x: e.clientX, y: e.clientY }
    window.addEventListener('mousemove', stable.move)
    window.addEventListener('mouseup', stable.up)
  }

  function onPointerMove(e: MouseEvent) {
    const press = pressRef.current
    if (!press) return
    if (!dragRef.current) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return
      startDrag(press, e)
    }
    if (dragRef.current) { dragRef.current.last = { x: e.clientX, y: e.clientY }; updateDrag() }
  }

  function startDrag(press: { id: string; x: number; y: number }, e: MouseEvent) {
    const { orderedIds: ids, selected: sel } = latest.current
    const grabbedSelected = sel.has(press.id)
    // Dragging a selected item takes the whole selection, folders included.
    const dragged = grabbedSelected ? ids.filter(id => sel.has(id)) : [press.id]
    if (!grabbedSelected) { setSelected(new Set([press.id])); anchorRef.current = press.id }
    const wrap = wrapRefs.current.get(press.id)
    const cardEl = wrap?.querySelector('.model-card, .folder-card') as HTMLElement | null
    if (!wrap || !cardEl) return
    const rect = cardEl.getBoundingClientRect()
    const ghost = cardEl.cloneNode(true) as HTMLElement
    ghost.querySelector('.card-expanded')?.remove()
    ghost.classList.remove('selected', 'folder-stretch', 'folder-drop-target')
    ghost.classList.add('drag-ghost')
    ghost.style.width = `${rect.width}px`
    if (dragged.length > 1) {
      const badge = document.createElement('div')
      badge.className = 'drag-ghost-count'
      badge.textContent = String(dragged.length)
      ghost.appendChild(badge)
    }
    document.body.appendChild(ghost)
    document.body.classList.add('card-dragging')
    // A stretched folder's ghost is its natural height, so the grab point keeps its relative place in it.
    const ghostHeight = ghost.getBoundingClientRect().height || rect.height
    const grabY = press.y - rect.top
    const offY = cardEl.classList.contains('folder-card') ? grabY * (ghostHeight / rect.height) : grabY
    const measure = (list: string[]) => list
      .map(id => { const el = wrapRefs.current.get(id); return el ? { id, rect: el.getBoundingClientRect() } : null })
      .filter((r): r is { id: string; rect: DOMRect } => r !== null)
    const heightOf = (id: string | undefined, selector: string) =>
      (id && wrapRefs.current.get(id)?.querySelector(selector)?.getBoundingClientRect().height) || 0
    const scroller = rootRef.current?.closest('.content') as HTMLElement | null
    dragRef.current = {
      ids: dragged, ghost,
      offX: press.x - rect.left, offY,
      templateRects: measure(ids.filter(id => !isFolderId(id))),
      folderRects: measure(ids.filter(isFolderId)),
      startScroll: scroller?.scrollTop ?? 0,
      scroller, last: { x: e.clientX, y: e.clientY },
      timer: window.setInterval(autoScroll, 16),
      templateHeight: heightOf(dragged.find(id => !isFolderId(id)), '.model-card'),
      folderHeight: (() => {
        const folderEl = wrapRefs.current.get(dragged.find(isFolderId) ?? '')?.querySelector('.folder-card') as HTMLElement | null
        return folderEl ? naturalFolderHeight(folderEl) : 0
      })(),
      dropAt: null, dropFolderAt: null, dropFolder: null
    }
    setDragIds(dragged)
    window.addEventListener('keydown', stable.key, true)
  }

  function autoScroll() {
    const d = dragRef.current
    if (!d?.scroller) return
    const box = d.scroller.getBoundingClientRect()
    const y = d.last.y
    const step = y < box.top + EDGE_SCROLL_PX ? -Math.ceil((box.top + EDGE_SCROLL_PX - y) / 4)
      : y > box.bottom - EDGE_SCROLL_PX ? Math.ceil((y - (box.bottom - EDGE_SCROLL_PX)) / 4) : 0
    if (step !== 0) { d.scroller.scrollTop += step; updateDrag() }
  }

  // Decides what a drop would do from the pointer position:
  //  - over a path-bar crumb or the middle of a folder: move inside it
  //  - near a folder's left/right edge: reorder among folders (folders dragged)
  //  - nearest a Template: reorder among Templates (Templates dragged)
  function updateDrag() {
    const d = dragRef.current
    if (!d) return
    d.ghost.style.transform = `translate(${d.last.x - d.offX}px, ${d.last.y - d.offY}px)`
    // The rects were measured at the scroll position the drag started at.
    const x = d.last.x
    const y = d.last.y + ((d.scroller?.scrollTop ?? 0) - d.startScroll)
    const draggedSet = new Set(d.ids)
    const hasTemplates = d.ids.some(id => !isFolderId(id))
    const hasFolders = d.ids.some(isFolderId)

    let into: string | null = null
    let templateSlot: number | null = null
    let folderSlot: number | null = null

    const crumb = (document.elementFromPoint(d.last.x, d.last.y) as HTMLElement | null)?.closest('[data-drop-folder]')
    if (crumb) {
      const target = crumb.getAttribute('data-drop-folder')
      if (target && !draggedSet.has(target)) into = target
    } else {
      const distance = (r: DOMRect) => {
        const dx = Math.max(r.left - x, 0, x - r.right)
        const dy = Math.max(r.top - y, 0, y - r.bottom)
        return dx * dx + dy * dy
      }
      let nearest: { kind: 'folder' | 'template'; index: number; rect: DOMRect; id: string } | null = null
      let best = Infinity
      d.folderRects.forEach(({ id, rect }, index) => { const dist = distance(rect); if (dist < best) { best = dist; nearest = { kind: 'folder', index, rect, id } } })
      d.templateRects.forEach(({ id, rect }, index) => { const dist = distance(rect); if (dist < best) { best = dist; nearest = { kind: 'template', index, rect, id } } })
      const hit = nearest as { kind: 'folder' | 'template'; index: number; rect: DOMRect; id: string } | null
      if (hit?.kind === 'folder') {
        const inside = x >= hit.rect.left && x <= hit.rect.right && y >= hit.rect.top && y <= hit.rect.bottom
        const edge = hit.rect.width * FOLDER_EDGE_FRACTION
        const middle = x >= hit.rect.left + edge && x <= hit.rect.right - edge
        if (inside && middle && !draggedSet.has(hit.id)) into = hit.id
        else if (hasFolders) folderSlot = x - hit.rect.left < hit.rect.width / 2 ? hit.index : hit.index + 1
      } else if (hit?.kind === 'template' && hasTemplates) {
        templateSlot = x - hit.rect.left < hit.rect.width / 2 ? hit.index : hit.index + 1
      }
    }
    if (templateSlot !== d.dropAt) { d.dropAt = templateSlot; setDropAt(templateSlot) }
    if (folderSlot !== d.dropFolderAt) { d.dropFolderAt = folderSlot; setDropFolderAt(folderSlot) }
    if (into !== d.dropFolder) { d.dropFolder = into; setDropFolder(into) }
  }

  function endDrag() {
    const d = dragRef.current
    window.removeEventListener('mousemove', stable.move)
    window.removeEventListener('mouseup', stable.up)
    window.removeEventListener('keydown', stable.key, true)
    pressRef.current = null
    if (d) {
      window.clearInterval(d.timer)
      d.ghost.remove()
      document.body.classList.remove('card-dragging')
      dragEndRef.current = Date.now()
    }
    dragRef.current = null
    setDragIds(null)
    setDropAt(null)
    setDropFolderAt(null)
    setDropFolder(null)
  }

  function onDragKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); endDrag() }
  }

  function onPointerUp() {
    const d = dragRef.current
    const drop = d ? { ids: d.ids, at: d.dropAt, folderAt: d.dropFolderAt, into: d.dropFolder } : null
    endDrag()
    if (!drop) return
    if (drop.into) {
      moveItems(drop.ids, drop.into === ROOT_DROP ? null : drop.into)
      setSelected(new Set())
    } else if (drop.folderAt !== null) {
      applyFolderReorder(drop.ids.filter(isFolderId), drop.folderAt)
    } else if (drop.at !== null) {
      applyReorder(drop.ids.filter(id => !isFolderId(id)), drop.at)
    }
  }

  // The visible Templates' new relative order with `moved` inserted as one
  // block at slot `at` of the visible list.
  function reordered(visible: string[], moved: string[], at: number): string[] {
    const set = new Set(moved)
    const rest = visible.filter(id => !set.has(id))
    const insertAt = visible.slice(0, at).filter(id => !set.has(id)).length
    return [...rest.slice(0, insertAt), ...visible.filter(id => set.has(id)), ...rest.slice(insertAt)]
  }

  // Folders keep one global order; the visible folders' new order goes back
  // into the slots they already held, leaving other levels untouched.
  function applyFolderReorder(moved: string[], at: number) {
    const visible = levelFolders.map(f => f.id)
    const next = reordered(visible, moved, at)
    if (next.join() === visible.join()) return
    const visibleSet = new Set(visible)
    const byId = new Map(templateFolders.map(f => [f.id, f]))
    let cursor = 0
    persistFolders(templateFolders.map(f => visibleSet.has(f.id) ? byId.get(next[cursor++])! : f))
  }

  function applyReorder(moved: string[], at: number) {
    const visible = levelCards.map(c => c.template.id)
    const next = reordered(visible, moved, at)
    if (next.join() === visible.join()) return
    // Put the visible subset's new order back into its original absolute
    // slots, leaving Templates hidden by the folder or search untouched.
    const visibleSet = new Set(visible)
    const byId = new Map(cards.map(c => [c.template.id, c]))
    let cursor = 0
    const newCards: CardState[] = cards.map(c => visibleSet.has(c.template.id) ? byId.get(next[cursor++])! : c)
    setCards(newCards)
    window.api.reorderTemplates(newCards.map(c => c.template.id))
  }

  useEffect(() => () => {
    window.removeEventListener('mousemove', stable.move)
    window.removeEventListener('mouseup', stable.up)
    if (dragRef.current) { dragRef.current.ghost.remove(); window.clearInterval(dragRef.current.timer) }
    document.body.classList.remove('card-dragging')
  }, [])

  const visibleIds = levelCards.map(c => c.template.id)
  const visibleFolderIds = levelFolders.map(f => f.id)
  const draggedTemplates = dragIds?.filter(id => !isFolderId(id)) ?? []
  const draggedFolders = dragIds?.filter(isFolderId) ?? []
  const showPlaceholderAt = (index: number) =>
    dropFolder === null && dropAt === index && draggedTemplates.length > 0 &&
    reordered(visibleIds, draggedTemplates, index).join() !== visibleIds.join()
  const showFolderPlaceholderAt = (index: number) =>
    dropFolder === null && dropFolderAt === index && draggedFolders.length > 0 &&
    reordered(visibleFolderIds, draggedFolders, index).join() !== visibleFolderIds.join()
  const placeholderHeight = dragRef.current?.templateHeight
  const folderPlaceholderHeight = dragRef.current?.folderHeight
  // A folder that would land on the partly filled last row stretches like the folders there; elsewhere it keeps its own height.
  const folderPlaceholderStyle = (landsAt: number): React.CSSProperties =>
    leftoverFolders > 0 && landsAt >= levelFolders.length - leftoverFolders
      ? { alignSelf: 'stretch', maxHeight: FOLDER_MAX_STRETCH_PX, minHeight: folderPlaceholderHeight }
      : { height: folderPlaceholderHeight, minHeight: 0 }
  const cutIds = clip?.mode === 'cut' ? new Set(clip.ids) : null
  const nothingAtAll = cards.length === 0 && templateFolders.length === 0
  const levelEmpty = levelCards.length === 0 && levelFolders.length === 0

  let subtitle: string
  if (nothingAtAll) subtitle = 'Create your first template to get started'
  else if (query) subtitle = `${levelCards.length} of ${cards.length} template${cards.length !== 1 ? 's' : ''}`
  else if (currentFolderId) subtitle = `${levelCards.length} template${levelCards.length !== 1 ? 's' : ''}${levelFolders.length ? `, ${levelFolders.length} folder${levelFolders.length !== 1 ? 's' : ''}` : ''} in this folder`
  else subtitle = `${cards.length} template${cards.length !== 1 ? 's' : ''}${templateFolders.length ? `, ${templateFolders.length} folder${templateFolders.length !== 1 ? 's' : ''}` : ''}`

  return (
    <div ref={rootRef}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Templates</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={handleImport}>
            <Download size={15} />
            Import
          </button>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} />
            New Template
          </button>
        </div>
      </div>
      {path.length > 0 && !query && (
        <div className="folder-bar">
          <button
            className={`btn btn-ghost btn-icon ${dropFolder === (path.length > 1 ? path[path.length - 2].id : ROOT_DROP) ? 'drop-target' : ''}`}
            data-drop-folder={path.length > 1 ? path[path.length - 2].id : ROOT_DROP}
            onClick={goUp} title="Up one level (Backspace)">
            <ArrowUp size={16} />
          </button>
          <div className="folder-path">
            <button
              className={`folder-path-seg ${dropFolder === ROOT_DROP ? 'drop-target' : ''}`}
              data-drop-folder={ROOT_DROP}
              onClick={() => openFolder(null)}
            >Templates</button>
            {path.map((f, i) => (
              <React.Fragment key={f.id}>
                <span className="folder-path-sep">/</span>
                <button
                  className={`folder-path-seg ${i === path.length - 1 ? 'current' : ''} ${dropFolder === f.id ? 'drop-target' : ''}`}
                  data-drop-folder={f.id}
                  onClick={() => openFolder(f.id)}
                >{f.name}</button>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
      {!nothingAtAll && (
        <div className="template-search-bar">
          <Search size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <input
            type="text"
            className="template-search-input"
            placeholder="Search templates..."
            value={templateSearch}
            onChange={e => setTemplateSearch(e.target.value)}
          />
          {templateSearch && (
            <button
              className="template-search-clear"
              onClick={() => setTemplateSearch('')}
              title="Clear"
            >×</button>
          )}
        </div>
      )}
      {nothingAtAll ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="4" />
              <path d="M12 8v8M8 12h8" />
            </svg>
          </div>
          <h3>No templates yet</h3>
          <p>Create a template to configure and launch a llama.cpp model with one click.</p>
          <button className="btn btn-primary" onClick={() => setShowCreateModal(true)}>
            <Plus size={15} />
            Create Template
          </button>
        </div>
      ) : query && levelEmpty ? (
        <div className="empty-state" style={{ padding: '40px 24px' }}>
          <h3 style={{ fontSize: 15 }}>No matches</h3>
          <p>No templates found for "{templateSearch}".</p>
          <button className="btn btn-ghost" onClick={() => setTemplateSearch('')}>Clear search</button>
        </div>
      ) : (
        <>
          {levelEmpty && currentFolderId && <p className="folder-empty">This folder is empty. Cut and paste Templates here, or drag them onto it.</p>}
          <div className="cards-grid" ref={gridRef} onClickCapture={e => {
            if (Date.now() - dragEndRef.current < POST_DRAG_CLICK_MS) { e.stopPropagation(); e.preventDefault() }
          }}>
            {levelFolders.map((folder, folderIndex) => {
              const stretch = folderIndex >= levelFolders.length - leftoverFolders
              const inside = cards.filter(c => folderOfTemplate(c.template, folderIdSet) === folder.id).length
              const sub = templateFolders.filter(f => f.parentId === folder.id).length
              return (
                <React.Fragment key={folder.id}>
                {showFolderPlaceholderAt(folderIndex) && (
                  <div className="card-drop-placeholder" style={folderPlaceholderStyle(folderIndex)} />
                )}
                <div
                  data-item-id={folder.id}
                  className={dragIds?.includes(folder.id) ? 'card-drag-source' : undefined}
                  ref={el => { if (el) wrapRefs.current.set(folder.id, el); else wrapRefs.current.delete(folder.id) }}
                  style={stretch ? { alignSelf: 'stretch', maxHeight: FOLDER_MAX_STRETCH_PX } : undefined}
                  onMouseDown={e => handleItemMouseDown(folder.id, e)}
                  onClick={e => handleItemClick(folder.id, e)}
                  onDoubleClick={e => { if (!(e.target as HTMLElement).closest(INTERACTIVE)) openFolder(folder.id) }}
                >
                  <FolderCard
                    name={folder.name}
                    templateCount={inside}
                    folderCount={sub}
                    selected={selected.has(folder.id)}
                    cut={!!cutIds?.has(folder.id)}
                    dropTarget={dropFolder === folder.id}
                    stretch={stretch}
                    hasRunning={runningFolderIds.has(folder.id)}
                    renaming={renamingId === folder.id}
                    onRename={name => {
                      setRenamingId(null)
                      if (name !== null) renameFolder(folder.id, name)
                    }}
                  />
                </div>
                </React.Fragment>
              )
            })}
            {showFolderPlaceholderAt(levelFolders.length) && (
              <div className="card-drop-placeholder" style={folderPlaceholderStyle(levelFolders.length)} />
            )}
            {levelCards.map((card, index) => (
              <React.Fragment key={card.template.id}>
                {showPlaceholderAt(index) && (
                  <div className="card-drop-placeholder" style={{ height: placeholderHeight }} />
                )}
                <div
                  data-item-id={card.template.id}
                  ref={el => { if (el) wrapRefs.current.set(card.template.id, el); else wrapRefs.current.delete(card.template.id) }}
                  className={dragIds?.includes(card.template.id) ? 'card-drag-source' : undefined}
                  onMouseDown={e => handleItemMouseDown(card.template.id, e)}
                  onClick={e => handleItemClick(card.template.id, e)}
                >
                  <ModelCard card={card} selected={selected.has(card.template.id)} cut={!!cutIds?.has(card.template.id)} />
                </div>
              </React.Fragment>
            ))}
            {showPlaceholderAt(levelCards.length) && (
              <div className="card-drop-placeholder" style={{ height: placeholderHeight }} />
            )}
            <button className="add-card" onClick={() => setShowCreateModal(true)}>
              <Plus size={28} />
              <span>Add Template</span>
            </button>
          </div>
        </>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.ids)} onClose={() => setMenu(null)} />}
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'
import { GripVertical, Shapes, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { EngineId } from '../../../shared/engines'
import {
  arrangeOrder, arrangePlacement, insertGroup, isCustomGroupKey, moveHeaders, moveOrder, movePlacement, newGroupKey,
  removeGroup, setGroupMeta, shownLayout, type ParamLayout
} from '../../../shared/paramLayout'
import { idRange } from '../../../shared/templateFolders'
import { useLayoutDrag, type LayoutDragSpec, type LayoutKind, type PressKind } from '../hooks/useLayoutDrag'
import GroupIconMenu from './GroupIconMenu'
import { groupIcon } from './groupIcons'

// An engine's parameter list as groups holding blocks (custom widgets) and rows (single parameters),
// laid out by the engine's active layout preset, or by the draft while Edit Layout is on. Each
// engine's editor describes its groups in its own default order; this places and renders them.

export interface LayoutRow { arg: string; label: string }
export interface LayoutBlock { id: string; title: string; node: React.ReactNode }
export interface LayoutSection<R extends LayoutRow> {
  key: string
  title: string
  icon?: React.ReactNode
  // A group whose block brings its own title shows none, except while the layout is edited.
  hideTitle?: boolean
  blocks: LayoutBlock[]
  rows: R[]
}

interface Props<R extends LayoutRow> {
  engine: EngineId
  sections: LayoutSection<R>[]
  editing: boolean
  dimmed?: boolean
  // Rows the current Common/Full view leaves out. They stay in their groups and move with them,
  // but are not shown or selectable.
  hiddenRows?: ReadonlySet<string>
  renderRow: (row: R) => React.ReactNode
  className?: string
  emptyText?: string
}

const DIM: React.CSSProperties = { opacity: 0.55, pointerEvents: 'none', userSelect: 'none' }
const INTERACTIVE = 'input, textarea, select, button, a'
const POST_DRAG_CLICK_MS = 300
const END = Number.MAX_SAFE_INTEGER

// Selection and drag work on keys of the form `kind:id`.
const keyOf = (kind: string, id: string) => `${kind}:${id}`
const idsOf = (keys: string[], kind: string) => keys.filter(k => k.startsWith(`${kind}:`)).map(k => k.slice(kind.length + 1))

function GroupName({ value, fallback, onCommit, autoFocus }: {
  value: string
  // The editor's own title, which an emptied name goes back to. Custom groups have none.
  fallback: string
  onCommit: (title: string) => void
  autoFocus: boolean
}) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => setText(value), [value])
  useEffect(() => {
    if (autoFocus) { ref.current?.focus(); ref.current?.select() }
  }, [autoFocus])

  function commit() {
    const next = cancelled.current ? value : (text.trim() || fallback)
    cancelled.current = false
    setText(next || value)
    if (next && next !== value) onCommit(next === fallback ? '' : next)
  }

  return (
    <span className="layout-group-name-wrap" data-value={text}>
      <input
        ref={ref}
        className="layout-group-name"
        value={text}
        maxLength={60}
        spellCheck={false}
        title="Rename group"
        onChange={e => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
        }}
      />
    </span>
  )
}

export default function LayoutSections<R extends LayoutRow>({ engine, sections, editing, dimmed, hiddenRows, renderRow, className, emptyText }: Props<R>) {
  const { layoutLibrary, layoutEdit, setLayoutDraft, layoutGroupRequest, clearLayoutGroupRequest } = useStore()
  const rootRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const anchorRef = useRef<string | null>(null)
  const [iconMenu, setIconMenu] = useState<{ key: string; rect: DOMRect } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)

  const layout = shownLayout(layoutLibrary, engine, editing ? layoutEdit : null)
  const groupMeta = layout.groups ?? {}
  const editorKeys = new Set(sections.map(s => s.key))
  const allSections: LayoutSection<R>[] = [
    ...sections,
    ...Object.keys(groupMeta).filter(k => isCustomGroupKey(k) && !editorKeys.has(k))
      .map(key => ({ key, title: groupMeta[key].title ?? 'New Group', blocks: [], rows: [] }))
  ]
  const visibleRow = (arg: string) => !hiddenRows?.has(arg)
  const sectionOrder = arrangeOrder(allSections.map(s => s.key), layout.sections)
  const blockPlace = arrangePlacement(Object.fromEntries(allSections.map(s => [s.key, s.blocks.map(b => b.id)] as const)), layout.blocks)
  const rowPlace = arrangePlacement(Object.fromEntries(allSections.map(s => [s.key, s.rows.map(r => r.arg)] as const)), layout.rows)
  const blockById = new Map(allSections.flatMap(s => s.blocks).map(b => [b.id, b] as const))
  const rowByArg = new Map(allSections.flatMap(s => s.rows).map(r => [r.arg, r] as const))
  const editorCount = new Map(sections.map(s => [s.key, s.blocks.length + s.rows.length] as const))
  // While editing, a group with nothing to show stays listed when it is one the user made or one
  // the user emptied; a group that only has rows the current view leaves out is not.
  const shown = sectionOrder
    .map(key => {
      const base = allSections.find(s => s.key === key)!
      return { ...base, blocks: blockPlace[key].map(id => blockById.get(id)!), rows: rowPlace[key].map(arg => rowByArg.get(arg)!) }
    })
    .filter(sec => {
      if (sec.blocks.length + sec.rows.filter(r => visibleRow(r.arg)).length > 0) return true
      return editing && (isCustomGroupKey(sec.key) || (sec.blocks.length + sec.rows.length === 0 && (editorCount.get(sec.key) ?? 0) > 0))
    })
  const shownKeys = shown.map(sec => sec.key)
  const current: ParamLayout = {
    sections: sectionOrder, blocks: blockPlace, rows: rowPlace, ...(layout.groups ? { groups: layout.groups } : {})
  }

  // Every selectable entry in display order.
  const entryOrder = shown.flatMap(sec => [
    keyOf('header', sec.key),
    ...sec.blocks.map(b => keyOf('block', b.id)),
    ...sec.rows.filter(r => visibleRow(r.arg)).map(r => keyOf('row', r.arg))
  ])
  const groupKeys = (sec: (typeof shown)[number]) => [
    keyOf('header', sec.key),
    ...sec.blocks.map(b => keyOf('block', b.id)),
    ...sec.rows.filter(r => visibleRow(r.arg)).map(r => keyOf('row', r.arg))
  ]
  const wholeGroup = (key: string, sel: Set<string>) => {
    const sec = shown.find(s => s.key === key)
    return !!sec && groupKeys(sec).every(k => sel.has(k))
  }

  useEffect(() => {
    if (!editing) {
      if (selected.size > 0) setSelected(new Set())
      anchorRef.current = null
      return
    }
    const live = new Set(entryOrder)
    if ([...selected].some(k => !live.has(k))) setSelected(new Set([...selected].filter(k => live.has(k))))
  })

  useEffect(() => {
    if (!editing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).closest?.('input, textarea, select')) return
      if (document.querySelector('.context-menu, .layout-icon-menu')) return
      setSelected(prev => prev.size ? new Set() : prev)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  // The page's context menu asks for a new group at the pointer's height.
  useEffect(() => {
    if (!editing || !layoutGroupRequest) return
    clearLayoutGroupRequest()
    const y = layoutGroupRequest.y
    const at = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-layout-section]') ?? [])
      .filter(el => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 < y }).length
    const key = newGroupKey()
    setLayoutDraft(insertGroup(current, key, { title: 'New Group', icon: 'Layers' }, shownKeys[at] ?? null))
    setRenaming(key)
  }, [layoutGroupRequest])

  // A press on a selected item drags the whole selection, otherwise just that item. A header
  // whose group is fully selected carries the group; any other header moves alone.
  const resolveDrag = (kind: PressKind, id: string): LayoutDragSpec => {
    const key = keyOf(kind, id)
    let sel = selected
    if (!sel.has(key)) {
      sel = new Set([key])
      setSelected(sel)
      anchorRef.current = key
    }
    if (kind !== 'header') return { kind, keys: entryOrder.filter(k => sel.has(k) && !k.startsWith('header:')) }
    const heads = shown.filter(sec => sel.has(keyOf('header', sec.key)))
    const asGroup = wholeGroup(id, sel)
    const keys = heads.filter(sec => wholeGroup(sec.key, sel) === asGroup).map(sec => keyOf('header', sec.key))
    return { kind: asGroup ? 'group' : 'header', keys }
  }

  // Slots count the items as they are shown without the dragged ones. A group's new order goes back
  // into the places the shown groups already held among the hidden ones.
  const applyDrop = (kind: LayoutKind, keys: string[], container: string, at: number) => {
    const next: ParamLayout = { ...current }
    const reorderShown = (order: string[]) => {
      let cursor = 0
      return sectionOrder.map(key => shownKeys.includes(key) ? order[cursor++] : key)
    }
    if (kind === 'group') {
      next.sections = reorderShown(moveOrder(shownKeys, idsOf(keys, 'header'), at))
    } else if (kind === 'header') {
      const res = moveHeaders(shownKeys, blockPlace, rowPlace, idsOf(keys, 'header'), at, e => e.kind !== 'row' || visibleRow(e.id))
      next.sections = reorderShown(res.sections)
      next.blocks = { ...blockPlace, ...res.blocks }
      next.rows = { ...rowPlace, ...res.rows }
    } else {
      // Entries of the other kind in the selection follow at the end of their list in that group.
      next.blocks = movePlacement(blockPlace, idsOf(keys, 'block'), container, kind === 'block' ? at : END)
      next.rows = movePlacement(rowPlace, idsOf(keys, 'row'), container, kind === 'row' ? at : END, visibleRow)
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) setLayoutDraft(next)
  }
  const applyDropRef = useRef(applyDrop)
  applyDropRef.current = applyDrop

  const { dragging, drop, onMouseDown, endedAt } = useLayoutDrag({
    rootRef,
    enabled: editing,
    resolveDrag,
    onDrop: (kind, keys, container, at) => applyDropRef.current(kind, keys, container, at)
  })

  // A click anywhere on the page that is not on an entry or a control ends the selection.
  const deselectRef = useRef<(e: MouseEvent) => void>(() => {})
  deselectRef.current = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (Date.now() - endedAt.current < POST_DRAG_CLICK_MS || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (target.closest(`${INTERACTIVE}, [data-layout-kind], .context-menu, .layout-icon-menu, .layout-toolbar`)) return
    setSelected(prev => prev.size ? new Set() : prev)
  }
  useEffect(() => {
    if (!editing) return
    const onClickAnywhere = (e: MouseEvent) => deselectRef.current(e)
    document.addEventListener('click', onClickAnywhere, true)
    return () => document.removeEventListener('click', onClickAnywhere, true)
  }, [editing])

  function onClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (!editing || !rootRef.current?.contains(target) || Date.now() - endedAt.current < POST_DRAG_CLICK_MS) return
    if (target.closest(INTERACTIVE)) return
    const el = target.closest<HTMLElement>('[data-layout-kind]')
    if (!el) return
    const key = keyOf(el.dataset.layoutKind as string, el.dataset.layoutId as string)
    if (e.ctrlKey || e.metaKey) {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key); else next.add(key)
        return next
      })
      anchorRef.current = key
    } else if (e.shiftKey) {
      const from = anchorRef.current && entryOrder.includes(anchorRef.current) ? anchorRef.current : key
      const range = idRange(entryOrder, from, key)
      setSelected(prev => new Set([...prev, ...range]))
      if (!anchorRef.current) anchorRef.current = key
    } else {
      setSelected(new Set([key]))
      anchorRef.current = key
    }
  }

  function onDoubleClick(e: React.MouseEvent) {
    const target = e.target as HTMLElement
    if (!editing || !rootRef.current?.contains(target) || target.closest(INTERACTIVE)) return
    const sec = shown.find(s => s.key === target.closest<HTMLElement>('[data-layout-kind="header"]')?.dataset.layoutId)
    if (!sec) return
    setSelected(prev => new Set(e.ctrlKey || e.metaKey ? [...prev, ...groupKeys(sec)] : groupKeys(sec)))
    anchorRef.current = keyOf('header', sec.key)
  }

  const compact = editing && !!layoutEdit?.compact
  const dragKind = dragging?.kind
  const goneKeys = new Set(dragging?.keys)
  const gone = (kind: string, id: string) => goneKeys.has(keyOf(kind, id))
  const dim = editing || !dimmed ? undefined : DIM
  const placeholder = (margin?: number) =>
    <div className="layout-drop-placeholder" style={{ height: dragging?.height, marginBottom: margin }} />
  const dropSlot = (kind: LayoutKind, container: string, index: number) =>
    dragging && drop && dragKind === kind && drop.container === container && drop.at === index
      ? placeholder(kind === 'group' ? 20 : undefined)
      : null

  // A header drag has one list: every header, block and row still in place, in display order. When
  // the first header is among the dragged ones, the items ahead of the remaining first header
  // would join it again wherever the header went among them, so those slots show as the top.
  const headerMode = dragKind === 'header'
  let flatSlot = -1
  if (headerMode && drop) {
    const left = shown.flatMap(sec => [
      ...(gone('header', sec.key) ? [] : ['header']),
      ...sec.blocks.filter(b => !gone('block', b.id)).map(() => 'block'),
      ...sec.rows.filter(r => visibleRow(r.arg) && !gone('row', r.arg)).map(() => 'row')
    ])
    const lead = left.indexOf('header')
    flatSlot = drop.at <= (lead === -1 ? left.length : lead) ? 0 : drop.at
  }
  let flat = 0
  const takeFlat = (margin?: number) => {
    const el = flatSlot === flat ? placeholder(margin) : null
    flat++
    return el
  }
  let groupIndex = 0

  const pickIcon = (key: string, icon: string | null) => {
    setLayoutDraft(setGroupMeta(current, key, { icon: icon ?? '' }))
    setIconMenu(null)
  }

  return (
    <div
      ref={rootRef}
      className={[className, editing ? 'layout-editing' : '', compact ? 'layout-compact' : ''].filter(Boolean).join(' ')}
      onMouseDown={onMouseDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      {shown.length === 0 && emptyText ? (
        <div className="text-center py-6 text-sm text-muted">{emptyText}</div>
      ) : (
        shown.map(sec => {
          const headerKey = keyOf('header', sec.key)
          const sectionGone = dragKind === 'group' && gone('header', sec.key)
          const headerGone = headerMode && gone('header', sec.key)
          const rows = sec.rows.filter(r => visibleRow(r.arg))
          const meta = groupMeta[sec.key]
          const title = meta?.title || sec.title
          const icon = meta?.icon === 'none' ? null : meta?.icon ? groupIcon(meta.icon) : sec.icon
          let nb = 0
          let nr = 0
          const sectionSlot = sectionGone ? null : dropSlot('group', '', groupIndex++)
          const headerSlot = headerMode && !headerGone ? takeFlat(20) : null
          const rowDrop = dragKind === 'row' && drop?.container === sec.key
          return (
            <React.Fragment key={sec.key}>
              {sectionSlot}
              {headerSlot}
              <div className={`cmd-section${sectionGone ? ' layout-source-hidden' : ''}`} data-layout-section={sec.key}>
                {(!sec.hideTitle || editing || !!meta?.title) && (
                  <div
                    className={`cmd-section-header${selected.has(headerKey) ? ' selected' : ''}${headerGone ? ' layout-source-hidden' : ''}`}
                    data-layout-kind="header"
                    data-layout-id={sec.key}
                    style={dim}
                  >
                    {editing ? (
                      <>
                        <GripVertical size={14} />
                        <button
                          type="button"
                          className="layout-icon-btn"
                          title="Change icon"
                          onClick={e => {
                            const rect = e.currentTarget.getBoundingClientRect()
                            setIconMenu(m => m?.key === sec.key ? null : { key: sec.key, rect })
                          }}
                        >
                          {icon ?? <Shapes size={14} />}
                        </button>
                        <GroupName
                          value={title}
                          fallback={isCustomGroupKey(sec.key) ? '' : sec.title}
                          autoFocus={renaming === sec.key}
                          onCommit={t => { setRenaming(null); setLayoutDraft(setGroupMeta(current, sec.key, { title: t })) }}
                        />
                        {isCustomGroupKey(sec.key) && (
                          <button
                            type="button"
                            className="layout-group-remove"
                            title="Remove group"
                            onClick={() => setLayoutDraft(removeGroup(current, sec.key))}
                          >
                            <X size={13} />
                          </button>
                        )}
                      </>
                    ) : (
                      <>{icon} {title}</>
                    )}
                  </div>
                )}
                {sec.blocks.map(b => {
                  const isGone = gone('block', b.id)
                  const slot = isGone ? null : headerMode ? takeFlat() : dropSlot('block', sec.key, nb++)
                  return (
                    <React.Fragment key={b.id}>
                      {slot}
                      <div
                        className={`layout-item${selected.has(keyOf('block', b.id)) ? ' selected' : ''}${isGone ? ' layout-source-hidden' : ''}`}
                        data-layout-kind="block"
                        data-layout-id={b.id}
                        data-layout-container={sec.key}
                      >
                        {compact ? <div className="layout-chip">{b.title}</div> : b.node}
                      </div>
                    </React.Fragment>
                  )
                })}
                {headerMode ? null : dropSlot('block', sec.key, nb)}
                {(rows.length > 0 || rowDrop) && (
                  <div style={dim}>
                    <div className="cmd-grid">
                      {rows.map(row => {
                        const isGone = gone('row', row.arg)
                        const slot = isGone ? null : headerMode ? takeFlat() : dropSlot('row', sec.key, nr++)
                        return (
                          <React.Fragment key={row.arg}>
                            {slot}
                            <div
                              className={`layout-item${selected.has(keyOf('row', row.arg)) ? ' selected' : ''}${isGone ? ' layout-source-hidden' : ''}`}
                              data-layout-kind="row"
                              data-layout-id={row.arg}
                              data-layout-container={sec.key}
                            >
                              {compact
                                ? <div className="layout-chip">{row.label}<span className="layout-chip-arg">{row.arg}</span></div>
                                : renderRow(row)}
                            </div>
                          </React.Fragment>
                        )
                      })}
                      {headerMode ? null : dropSlot('row', sec.key, nr)}
                    </div>
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })
      )}
      {dragKind === 'group' ? dropSlot('group', '', groupIndex) : headerMode && flatSlot === flat ? placeholder(20) : null}
      {iconMenu && (
        <GroupIconMenu
          anchor={iconMenu.rect}
          canReset={!isCustomGroupKey(iconMenu.key)}
          onPick={icon => pickIcon(iconMenu.key, icon)}
          onClose={() => setIconMenu(null)}
        />
      )}
    </div>
  )
}

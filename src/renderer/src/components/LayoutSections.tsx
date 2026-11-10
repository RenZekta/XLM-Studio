import React, { useRef } from 'react'
import { GripVertical } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { EngineId } from '../../../shared/engines'
import { arrangeOrder, arrangePlacement, moveOrder, movePlacement, shownLayout, type ParamLayout } from '../../../shared/paramLayout'
import { useLayoutDrag, type LayoutKind } from '../hooks/useLayoutDrag'

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
  renderRow: (row: R) => React.ReactNode
  className?: string
  emptyText?: string
}

const DIM: React.CSSProperties = { opacity: 0.55, pointerEvents: 'none', userSelect: 'none' }

export default function LayoutSections<R extends LayoutRow>({ engine, sections, editing, dimmed, renderRow, className, emptyText }: Props<R>) {
  const { layoutLibrary, layoutEdit, setLayoutDraft } = useStore()
  const rootRef = useRef<HTMLDivElement>(null)
  const applyDropRef = useRef<(kind: LayoutKind, id: string, container: string, at: number) => void>(() => {})
  const { dragging, drop, onMouseDown } = useLayoutDrag({
    rootRef,
    enabled: editing,
    onDrop: (kind, id, container, at) => applyDropRef.current(kind, id, container, at)
  })

  const layout = shownLayout(layoutLibrary, engine, editing ? layoutEdit : null)
  const sectionOrder = arrangeOrder(sections.map(s => s.key), layout.sections)
  const blockPlace = arrangePlacement(Object.fromEntries(sections.map(s => [s.key, s.blocks.map(b => b.id)] as const)), layout.blocks)
  const rowPlace = arrangePlacement(Object.fromEntries(sections.map(s => [s.key, s.rows.map(r => r.arg)] as const)), layout.rows)
  const blockById = new Map(sections.flatMap(s => s.blocks).map(b => [b.id, b] as const))
  const rowByArg = new Map(sections.flatMap(s => s.rows).map(r => [r.arg, r] as const))
  const shown = sectionOrder
    .map(key => {
      const base = sections.find(s => s.key === key)!
      return { ...base, blocks: blockPlace[key].map(id => blockById.get(id)!), rows: rowPlace[key].map(arg => rowByArg.get(arg)!) }
    })
    .filter(sec => sec.rows.length > 0 || sec.blocks.length > 0)
  const shownKeys = shown.map(sec => sec.key)
  const current: ParamLayout = { sections: sectionOrder, blocks: blockPlace, rows: rowPlace }

  // A drop slot counts the items as shown, so a group's new order goes back into the places the
  // shown groups already held among the hidden (empty) ones.
  applyDropRef.current = (kind, id, container, at) => {
    const next: ParamLayout = { ...current }
    if (kind === 'section') {
      const moved = moveOrder(shownKeys, id, at)
      let cursor = 0
      next.sections = sectionOrder.map(key => shownKeys.includes(key) ? moved[cursor++] : key)
    } else if (kind === 'block') next.blocks = movePlacement(blockPlace, id, container, at)
    else next.rows = movePlacement(rowPlace, id, container, at)
    if (JSON.stringify(next) !== JSON.stringify(current)) setLayoutDraft(next)
  }

  const compact = editing && !!layoutEdit?.compact
  const wouldMove = (kind: LayoutKind, id: string, container: string, at: number) => {
    if (kind === 'section') return moveOrder(shownKeys, id, at).join() !== shownKeys.join()
    const place = kind === 'block' ? blockPlace : rowPlace
    return JSON.stringify(movePlacement(place, id, container, at)) !== JSON.stringify(place)
  }
  const dropSlot = (kind: LayoutKind, container: string, index: number) =>
    dragging && drop && dragging.kind === kind && drop.container === container && drop.at === index && wouldMove(kind, dragging.id, container, index)
      ? <div className="layout-drop-placeholder" style={{ height: dragging.height, marginBottom: kind === 'section' ? 20 : undefined }} />
      : null
  const dragSource = (kind: LayoutKind, id: string) => dragging?.kind === kind && dragging.id === id ? ' card-drag-source' : ''
  const dim = editing || !dimmed ? undefined : DIM

  return (
    <div
      ref={rootRef}
      className={[className, editing ? 'layout-editing' : '', compact ? 'layout-compact' : ''].filter(Boolean).join(' ')}
      onMouseDown={onMouseDown}
    >
      {shown.length === 0 && emptyText ? (
        <div className="text-center py-6 text-sm text-muted">{emptyText}</div>
      ) : (
        shown.map((sec, secIndex) => {
          const emptyRowSlot = sec.rows.length === 0 ? dropSlot('row', sec.key, 0) : null
          return (
            <React.Fragment key={sec.key}>
              {dropSlot('section', '', secIndex)}
              <div className={`cmd-section${dragSource('section', sec.key)}`} data-layout-kind="section" data-layout-id={sec.key}>
                {(!sec.hideTitle || editing) && (
                  <div className="cmd-section-header" style={dim}>
                    {editing && <GripVertical size={14} />}
                    {sec.icon} {sec.title}
                  </div>
                )}
                {sec.blocks.map((b, i) => (
                  <React.Fragment key={b.id}>
                    {dropSlot('block', sec.key, i)}
                    <div className={`layout-item${dragSource('block', b.id)}`} data-layout-kind="block" data-layout-id={b.id} data-layout-container={sec.key}>
                      {compact ? <div className="layout-chip">{b.title}</div> : b.node}
                    </div>
                  </React.Fragment>
                ))}
                {dropSlot('block', sec.key, sec.blocks.length)}
                {(sec.rows.length > 0 || emptyRowSlot) && (
                  <div style={dim}>
                    <div className="cmd-grid">
                      {sec.rows.map((row, i) => (
                        <React.Fragment key={row.arg}>
                          {dropSlot('row', sec.key, i)}
                          <div className={`layout-item${dragSource('row', row.arg)}`} data-layout-kind="row" data-layout-id={row.arg} data-layout-container={sec.key}>
                            {compact
                              ? <div className="layout-chip">{row.label}<span className="layout-chip-arg">{row.arg}</span></div>
                              : renderRow(row)}
                          </div>
                        </React.Fragment>
                      ))}
                      {sec.rows.length > 0 ? dropSlot('row', sec.key, sec.rows.length) : emptyRowSlot}
                    </div>
                  </div>
                )}
              </div>
            </React.Fragment>
          )
        })
      )}
      {dropSlot('section', '', shown.length)}
    </div>
  )
}

import React, { useEffect, useRef, useState } from 'react'

// Pointer-driven drag for the parameter editors' Edit Layout mode, built like the Templates page
// drag (CardsView): the page keeps the cursor, and a floating copy of the item follows it.
//
// Draggable elements carry data-layout-kind ('section' | 'block' | 'row'), data-layout-id and, for
// blocks and rows, data-layout-container (the group they sit in). Everything is a vertical stack,
// so a drop slot is decided from the pointer's height alone.

export type LayoutKind = 'section' | 'block' | 'row'
export interface LayoutDrop { kind: LayoutKind; container: string; at: number }
export interface LayoutDragging { kind: LayoutKind; id: string; height: number }

const DRAG_THRESHOLD_PX = 5
const EDGE_SCROLL_PX = 50

interface Measured { id: string; container: string; top: number; bottom: number }

// Elements are measured once when the drag starts, in document space, so a scroll (of the page or
// of the card's own list) afterwards does not invalidate them.
function scrollOffset(el: HTMLElement | null): number {
  let sum = 0
  for (let n: HTMLElement | null = el; n; n = n.parentElement) sum += n.scrollTop
  return sum
}

function scrollers(el: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const overflowY = getComputedStyle(n).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) out.push(n)
  }
  return out
}

interface Options {
  rootRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  onDrop: (kind: LayoutKind, id: string, container: string, at: number) => void
}

export function useLayoutDrag({ rootRef, enabled, onDrop }: Options) {
  const [dragging, setDragging] = useState<LayoutDragging | null>(null)
  const [drop, setDrop] = useState<LayoutDrop | null>(null)
  const pressRef = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  const dragRef = useRef<{
    kind: LayoutKind
    id: string
    ghost: HTMLElement
    offX: number
    offY: number
    items: Measured[]
    lists: Map<string, Measured[]>
    sections: Measured[]
    last: { x: number; y: number }
    timer: number
    drop: LayoutDrop | null
  } | null>(null)

  // Window listeners keep one identity across renders so they can be removed, and forward to the
  // newest handlers.
  const latest = useRef({ enabled, onDrop })
  latest.current = { enabled, onDrop }
  const fnsRef = useRef({ move: onMove, up: onUp, key: onKey })
  fnsRef.current = { move: onMove, up: onUp, key: onKey }
  const stable = useRef({
    move: (e: MouseEvent) => fnsRef.current.move(e),
    up: () => fnsRef.current.up(),
    key: (e: KeyboardEvent) => fnsRef.current.key(e)
  }).current

  function onMouseDown(e: React.MouseEvent) {
    if (!latest.current.enabled || e.button !== 0) return
    const target = e.target as HTMLElement
    const el = target.closest('[data-layout-kind]') as HTMLElement | null
    if (!el) return
    // A group drags by its header; its blocks and rows drag themselves.
    if (el.dataset.layoutKind === 'section' && !target.closest('.cmd-section-header')) return
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    pressRef.current = { x: e.clientX, y: e.clientY, el }
    window.addEventListener('mousemove', stable.move)
    window.addEventListener('mouseup', stable.up)
  }

  function onMove(e: MouseEvent) {
    const press = pressRef.current
    if (!press) return
    if (!dragRef.current) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return
      startDrag(press, e)
    }
    if (dragRef.current) { dragRef.current.last = { x: e.clientX, y: e.clientY }; update() }
  }

  function startDrag(press: { x: number; y: number; el: HTMLElement }, e: MouseEvent) {
    const root = rootRef.current
    if (!root) return
    const kind = press.el.dataset.layoutKind as LayoutKind
    const id = press.el.dataset.layoutId as string
    const rect = press.el.getBoundingClientRect()
    const ghost = press.el.cloneNode(true) as HTMLElement
    ghost.classList.remove('card-drag-source')
    ghost.classList.add('drag-ghost', 'layout-ghost')
    ghost.style.width = `${rect.width}px`
    document.body.appendChild(ghost)
    document.body.classList.add('card-dragging')
    // The ghost is capped in height; keep the grab point at the same relative spot in it.
    const ghostHeight = ghost.getBoundingClientRect().height || rect.height
    const base = scrollOffset(root)
    const measure = (n: HTMLElement): Measured => {
      const r = n.getBoundingClientRect()
      return { id: n.dataset.layoutId ?? '', container: n.dataset.layoutContainer ?? '', top: r.top + base, bottom: r.bottom + base }
    }
    const items = Array.from(root.querySelectorAll<HTMLElement>(`[data-layout-kind="${kind}"]`)).map(measure)
    const lists = new Map<string, Measured[]>()
    for (const item of items) lists.set(item.container, [...(lists.get(item.container) ?? []), item])
    const sections = kind === 'section' ? [] : Array.from(root.querySelectorAll<HTMLElement>('[data-layout-kind="section"]')).map(measure)
    dragRef.current = {
      kind, id, ghost,
      offX: press.x - rect.left,
      offY: (press.y - rect.top) * (ghostHeight / rect.height),
      items, lists, sections,
      last: { x: e.clientX, y: e.clientY },
      timer: window.setInterval(autoScroll, 16),
      drop: null
    }
    setDragging({ kind, id, height: rect.height })
    window.addEventListener('keydown', stable.key, true)
  }

  function autoScroll() {
    const d = dragRef.current
    if (!d) return
    // Innermost scroller first, limited to the part of it that is on screen.
    const y = d.last.y
    for (const s of scrollers(rootRef.current)) {
      const r = s.getBoundingClientRect()
      const top = Math.max(r.top, 0)
      const bottom = Math.min(r.bottom, window.innerHeight)
      if (y < top || y > bottom) continue
      const step = y < top + EDGE_SCROLL_PX ? -Math.ceil((top + EDGE_SCROLL_PX - y) / 4)
        : y > bottom - EDGE_SCROLL_PX ? Math.ceil((y - (bottom - EDGE_SCROLL_PX)) / 4) : 0
      if (step === 0) continue
      const before = s.scrollTop
      s.scrollTop += step
      if (s.scrollTop !== before) { update(); return }
    }
  }

  // The nearest item's far or near half decides the slot. A group with nothing of the dragged kind
  // yet takes the drop for itself, since there is no item in it to be nearest to.
  function update() {
    const d = dragRef.current
    if (!d) return
    d.ghost.style.transform = `translate(${d.last.x - d.offX}px, ${d.last.y - d.offY}px)`
    const y = d.last.y + scrollOffset(rootRef.current)
    let next: LayoutDrop | null = null
    if (d.kind !== 'section') {
      const empty = d.sections.find(s => y >= s.top && y <= s.bottom && !d.lists.get(s.id)?.length)
      if (empty) next = { kind: d.kind, container: empty.id, at: 0 }
    }
    if (!next) {
      let best: Measured | null = null
      let bestDist = Infinity
      for (const item of d.items) {
        const dist = Math.max(item.top - y, 0, y - item.bottom)
        if (dist < bestDist) { bestDist = dist; best = item }
      }
      if (best) {
        const index = (d.lists.get(best.container) ?? []).indexOf(best)
        next = { kind: d.kind, container: best.container, at: y < (best.top + best.bottom) / 2 ? index : index + 1 }
      }
    }
    const cur = d.drop
    if (next?.container !== cur?.container || next?.at !== cur?.at) { d.drop = next; setDrop(next) }
  }

  function end() {
    const d = dragRef.current
    window.removeEventListener('mousemove', stable.move)
    window.removeEventListener('mouseup', stable.up)
    window.removeEventListener('keydown', stable.key, true)
    pressRef.current = null
    if (d) {
      window.clearInterval(d.timer)
      d.ghost.remove()
      document.body.classList.remove('card-dragging')
    }
    dragRef.current = null
    setDragging(null)
    setDrop(null)
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); end() }
  }

  function onUp() {
    const d = dragRef.current
    const result = d && d.drop ? { kind: d.kind, id: d.id, drop: d.drop } : null
    end()
    if (result) latest.current.onDrop(result.kind, result.id, result.drop.container, result.drop.at)
  }

  useEffect(() => { if (!enabled) end() }, [enabled])
  useEffect(() => () => end(), [])

  return { dragging, drop, onMouseDown }
}

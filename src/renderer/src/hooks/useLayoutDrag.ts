import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Pointer-driven drag for the parameter editors' Edit Layout mode, built like the Templates page
// drag (CardsView): the page keeps the cursor, and a floating copy of the item follows it.
//
// Pressable elements carry data-layout-kind ('header' | 'block' | 'row') and data-layout-id; blocks
// and rows also data-layout-container (the group they sit in). Groups carry data-layout-section.
// Everything is a vertical stack, so a drop slot is decided from the pointer's height alone.
//
// What is dragged is hidden from the list while it moves, and the slots are measured on that
// layout, so the preview shows wherever the pointer is, including where the item came from.

export type PressKind = 'header' | 'block' | 'row'
// A 'group' drag carries whole groups (header and everything in them); a 'header' drag moves
// headers alone.
export type LayoutKind = PressKind | 'group'
// `at` counts the items of that list left once the dragged ones are out. Headers have one list
// (container ''): every header, block and row in display order.
export interface LayoutDrop { kind: LayoutKind; container: string; at: number }
export interface LayoutDragging { kind: LayoutKind; keys: string[]; height: number }
export interface LayoutDragSpec { kind: LayoutKind; keys: string[] }

const DRAG_THRESHOLD_PX = 5
const EDGE_SCROLL_PX = 50
const HIDDEN = '.layout-source-hidden'

interface Measured { kind: string; id: string; container: string; top: number; bottom: number }

// Elements are measured once per drag, in document space, so a scroll (of the page or of the
// card's own list) afterwards does not invalidate them.
function scrollOffset(el: HTMLElement | null): number {
  let sum = 0
  for (let n: HTMLElement | null = el; n; n = n.parentElement) sum += n.scrollTop
  return sum
}

// Slot i is the edge in front of item i; the last slot is the edge after the last item.
function nearestSlot(items: Measured[], y: number): number {
  let best = 0
  let bestDist = Infinity
  for (let i = 0; i <= items.length; i++) {
    const edge = i < items.length ? items[i].top : (items[i - 1]?.bottom ?? y)
    if (Math.abs(edge - y) < bestDist) { bestDist = Math.abs(edge - y); best = i }
  }
  return best
}

function scrollers(el: HTMLElement | null): HTMLElement[] {
  const out: HTMLElement[] = []
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const overflowY = getComputedStyle(n).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && n.scrollHeight > n.clientHeight) out.push(n)
  }
  return out
}

// An input's text is a property, not an attribute, so a copy of it would come out empty.
function freezeNames(el: HTMLElement) {
  el.querySelectorAll('.layout-group-name-wrap').forEach(wrap => {
    const text = document.createElement('span')
    text.textContent = wrap.querySelector('input')?.value ?? ''
    wrap.replaceWith(text)
  })
}

interface Options {
  rootRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  // Decides what a press on this item drags: the selection it belongs to, or just the item.
  resolveDrag: (kind: PressKind, id: string) => LayoutDragSpec
  onDrop: (kind: LayoutKind, keys: string[], container: string, at: number) => void
}

export function useLayoutDrag({ rootRef, enabled, resolveDrag, onDrop }: Options) {
  const [dragging, setDragging] = useState<LayoutDragging | null>(null)
  const [drop, setDrop] = useState<LayoutDrop | null>(null)
  const endedAt = useRef(0)
  const pressRef = useRef<{ x: number; y: number; el: HTMLElement } | null>(null)
  const dragRef = useRef<{
    kind: LayoutKind
    keys: string[]
    ghost: HTMLElement
    offX: number
    offY: number
    sections: Measured[]
    flat: Measured[]
    measured: boolean
    last: { x: number; y: number }
    timer: number
    drop: LayoutDrop | null
  } | null>(null)

  // Window listeners keep one identity across renders so they can be removed, and forward to the
  // newest handlers.
  const latest = useRef({ enabled, resolveDrag, onDrop })
  latest.current = { enabled, resolveDrag, onDrop }
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
    if (!rootRef.current?.contains(target) || target.closest('input, textarea, select, button')) return
    const el = target.closest('[data-layout-kind]') as HTMLElement | null
    if (!el) return
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
    if (!rootRef.current) return
    const pressKind = press.el.dataset.layoutKind as PressKind
    const spec = latest.current.resolveDrag(pressKind, press.el.dataset.layoutId as string)
    const rect = press.el.getBoundingClientRect()
    const copy = press.el.cloneNode(true) as HTMLElement
    copy.classList.remove('selected')
    freezeNames(copy)
    let ghost = copy
    if (spec.kind === 'group') {
      ghost = document.createElement('div')
      ghost.className = 'layout-group-ghost'
      const dots = document.createElement('div')
      dots.className = 'layout-group-dots'
      dots.textContent = '. . .'
      ghost.append(copy, dots)
    }
    ghost.classList.add('drag-ghost', 'layout-ghost')
    ghost.style.width = `${rect.width}px`
    if (spec.keys.length > 1) {
      const badge = document.createElement('div')
      badge.className = 'drag-ghost-count'
      badge.textContent = String(spec.keys.length)
      ghost.appendChild(badge)
    }
    document.body.appendChild(ghost)
    document.body.classList.add('card-dragging')
    // An item's ghost is capped in height; keep the grab point at the same relative spot in it.
    const ghostHeight = ghost.getBoundingClientRect().height || rect.height
    dragRef.current = {
      kind: spec.kind, keys: spec.keys, ghost,
      offX: press.x - rect.left,
      offY: spec.kind === 'group' ? press.y - rect.top : (press.y - rect.top) * (ghostHeight / rect.height),
      sections: [], flat: [], measured: false,
      last: { x: e.clientX, y: e.clientY },
      timer: window.setInterval(autoScroll, 16),
      drop: null
    }
    setDragging({ kind: spec.kind, keys: spec.keys, height: spec.kind === 'group' ? ghostHeight : rect.height })
    window.addEventListener('keydown', stable.key, true)
  }

  // Runs once the dragged items are hidden and before the first preview is shown, so the slots
  // come from the list as it will look without them and do not move with the preview.
  useLayoutEffect(() => {
    const d = dragRef.current
    const root = rootRef.current
    if (!dragging || !d || !root) return
    const base = scrollOffset(root)
    const measure = (n: HTMLElement, kind: string, id: string): Measured => {
      const r = n.getBoundingClientRect()
      return { kind, id, container: n.dataset.layoutContainer ?? '', top: r.top + base, bottom: r.bottom + base }
    }
    d.sections = Array.from(root.querySelectorAll<HTMLElement>('[data-layout-section]'))
      .filter(n => !n.closest(HIDDEN))
      .map(n => measure(n, 'section', n.dataset.layoutSection ?? ''))
    d.flat = Array.from(root.querySelectorAll<HTMLElement>('[data-layout-kind]'))
      .filter(n => !n.closest(HIDDEN))
      .map(n => measure(n, n.dataset.layoutKind ?? '', n.dataset.layoutId ?? ''))
    d.measured = true
    update()
  }, [dragging])

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

  // The slot is the boundary nearest the top of the floating copy, so the preview lines up with it
  // wherever it was grabbed. Blocks and rows go into the group that boundary falls in (the nearest
  // one between groups).
  function slotAt(d: NonNullable<typeof dragRef.current>): LayoutDrop | null {
    const y = d.last.y - d.offY + scrollOffset(rootRef.current)
    if (d.kind === 'group') return d.sections.length ? { kind: d.kind, container: '', at: nearestSlot(d.sections, y) } : null
    if (d.kind === 'header') return { kind: d.kind, container: '', at: nearestSlot(d.flat, y) }
    let group: Measured | null = null
    let groupDist = Infinity
    for (const s of d.sections) {
      const dist = Math.max(s.top - y, 0, y - s.bottom)
      if (dist < groupDist) { groupDist = dist; group = s }
    }
    if (!group) return null
    const id = group.id
    return { kind: d.kind, container: id, at: nearestSlot(d.flat.filter(m => m.kind === d.kind && m.container === id), y) }
  }

  function update() {
    const d = dragRef.current
    if (!d) return
    d.ghost.style.transform = `translate(${d.last.x - d.offX}px, ${d.last.y - d.offY}px)`
    if (!d.measured) return
    const next = slotAt(d)
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
      endedAt.current = Date.now()
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
    const result = d && d.drop ? { kind: d.kind, keys: d.keys, drop: d.drop } : null
    end()
    if (result) latest.current.onDrop(result.kind, result.keys, result.drop.container, result.drop.at)
  }

  useEffect(() => { if (!enabled) end() }, [enabled])
  useEffect(() => () => end(), [])

  return { dragging, drop, onMouseDown, endedAt }
}

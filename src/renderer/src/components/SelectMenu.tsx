import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp } from 'lucide-react'

// A compact dropdown whose arrow flips while the list is open, styled like the
// session menus in Monitoring. Used where a native <select> would not show the
// open state. 'sidebar' is the narrow menu of the sidebar sections; 'field'
// fills a form column and looks like the inputs around it; 'compact' is the
// same for parameter rows and filter bars, its list as wide as its longest
// label; 'bare' has no border, for a menu inside a toolbar.
// This is the one dropdown of the app: no native <select> is used.
// The list is not part of the page layout: it floats above the window,
// placed from the button's position, so it can extend past the block that
// holds the button (never widening or scrolling it), opens upward when there
// is no room below, and slides left to stay on screen.

export interface SelectOption {
  value: string
  label: string
  // Options with the same group are listed under one heading.
  group?: string
}

interface Props {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  title?: string
  variant?: 'sidebar' | 'field' | 'compact' | 'bare'
  disabled?: boolean
  // Sizes the menu inside its row (a width, or flex: 1 beside a button).
  style?: React.CSSProperties
  mono?: boolean
}

export default function SelectMenu({ options, value, onChange, placeholder = 'Select', title, variant = 'sidebar', disabled, style, mono }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const current = options.find(o => o.value === value)

  // Where the list goes: under the button, as wide as the button at least,
  // moved left when it would pass the right edge of the window, above the
  // button when the room below is smaller than the room above.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    const btn = ref.current?.getBoundingClientRect()
    const panel = panelRef.current
    if (!btn || !panel) return
    const margin = 8
    const vw = window.innerWidth
    const vh = window.innerHeight
    const below = vh - btn.bottom - margin - 4
    const above = btn.top - margin - 4
    const natural = Math.min(panel.scrollHeight, 280)
    const up = natural > below && above > below
    const maxHeight = Math.max(80, Math.min(280, up ? above : below))
    const height = Math.min(natural, maxHeight)
    const left = Math.max(margin, Math.min(btn.left, vw - margin - panel.offsetWidth))
    setPos({ left, top: up ? btn.top - 4 - height : btn.bottom + 4, maxHeight })
  }, [open, options.length])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    // A click outside the button and the list closes it; the list is not
    // inside the button's element, so both are checked.
    const onPointerDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) close()
    }
    // The list does not move with the page, so scrolling the page (but not
    // the list itself) or resizing the window closes it, as a native menu does.
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) close() }
    document.addEventListener('mousedown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    // The collapsed sidebar shrinks as soon as the pointer leaves it, which
    // would leave the open list pointing at a narrow rail.
    const rail = ref.current?.closest('.sidebar-compact')
    rail?.addEventListener('mouseleave', close)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      rail?.removeEventListener('mouseleave', close)
    }
  }, [open])

  // A long list opens on the chosen option.
  useEffect(() => {
    const panel = panelRef.current
    const chosen = panel?.querySelector<HTMLElement>('.select-menu-option.selected')
    if (open && pos && panel && chosen && chosen.offsetTop + chosen.offsetHeight > panel.clientHeight) {
      panel.scrollTop = chosen.offsetTop - (panel.clientHeight - chosen.offsetHeight) / 2
    }
    // Only when the list first appears at its place.
  }, [open, pos === null])

  const trigger = ref.current?.getBoundingClientRect()
  const sized = variant === 'compact' || variant === 'bare'
  const panelStyle: React.CSSProperties = {
    left: pos?.left ?? 0,
    top: pos?.top ?? 0,
    maxHeight: pos?.maxHeight ?? 280,
    visibility: pos ? 'visible' : 'hidden',
    // The list is as wide as the button, or as its longest label when that
    // is wider (compact and bare), within the window.
    ...(sized
      ? { minWidth: Math.max(trigger?.width ?? 0, variant === 'bare' ? 160 : 0), width: 'max-content', maxWidth: Math.min(420, window.innerWidth - 16) }
      : { width: trigger?.width ?? undefined })
  }

  return (
    <div
      ref={ref}
      className={`select-menu select-menu-${variant}${open ? ' open' : ''}${mono ? ' select-menu-mono' : ''}`}
      style={style}
      // Closes the list without also closing a modal that listens for Escape.
      onKeyDown={e => { if (open && e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }}
    >
      <button
        type="button"
        className="btn btn-secondary select-menu-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(v => !v)}
        title={title ?? current?.label}
      >
        <span className="select-menu-label">{current?.label ?? placeholder}</span>
        {open ? <ChevronUp size={13} style={{ flexShrink: 0 }} /> : <ChevronDown size={13} style={{ flexShrink: 0 }} />}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={`select-menu-panel select-menu-panel-${variant}${mono ? ' select-menu-mono' : ''}`}
          role="listbox"
          style={panelStyle}
        >
          {options.map((o, i) => (
            <React.Fragment key={o.value}>
              {o.group && o.group !== options[i - 1]?.group && <div className="select-menu-group" title={o.group}>{o.group}</div>}
              <div
                role="option"
                aria-selected={o.value === value}
                className={`select-menu-option${o.value === value ? ' selected' : ''}`}
                onClick={() => { setOpen(false); onChange(o.value) }}
                title={o.label}
              >
                {o.label}
              </div>
            </React.Fragment>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

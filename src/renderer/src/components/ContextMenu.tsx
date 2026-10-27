import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface MenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  hint?: string
  danger?: boolean
  onClick: () => void
}

// A null entry draws a divider.
export type MenuEntry = MenuItem | null

interface Props {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}

// Opens at the cursor and is nudged back inside the window when it would run
// off the right or bottom edge. Portaled to <body> so it is positioned
// against the window, not against a scrolled or transformed ancestor.
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4))
    const top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    setPos(prev => prev.left === left && prev.top === top ? prev : { left, top })
  }, [x, y, items])

  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('wheel', onClose, { passive: true })
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('wheel', onClose)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="dropdown-menu context-menu"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) => item === null
        ? <div key={`d${i}`} className="dropdown-divider" />
        : (
          <button
            key={item.key}
            className={`dropdown-item ${item.danger ? 'danger' : ''}`}
            onClick={() => { onClose(); item.onClick() }}
          >
            {item.icon}
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.hint && <span className="context-menu-hint">{item.hint}</span>}
          </button>
        ))}
    </div>,
    document.body
  )
}

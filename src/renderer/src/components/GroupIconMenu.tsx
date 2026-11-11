import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Ban, RotateCcw } from 'lucide-react'
import { GROUP_ICON_NAMES, groupIcon } from './groupIcons'

interface Props {
  anchor: DOMRect
  // Offers the editor's own icon for groups that have one.
  canReset: boolean
  // An icon name, 'none', or null for the editor's own icon.
  onPick: (icon: string | null) => void
  onClose: () => void
}

// Floating icon picker under a group header's icon. A pick or a click anywhere else closes it.
export default function GroupIconMenu({ anchor, canReset, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.max(4, Math.min(anchor.left, window.innerWidth - r.width - 4))
    const top = anchor.bottom + 4 + r.height > window.innerHeight - 4 ? Math.max(4, anchor.top - r.height - 4) : anchor.bottom + 4
    setPos(prev => prev.left === left && prev.top === top ? prev : { left, top })
  }, [anchor])

  useEffect(() => {
    // The icon button toggles the menu itself, so a press on it is not "outside".
    const away = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current && !ref.current.contains(t) && !t.closest('.layout-icon-btn')) onClose()
    }
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
    <div ref={ref} className="layout-icon-menu" style={{ left: pos.left, top: pos.top }} onContextMenu={e => e.preventDefault()}>
      {canReset && (
        <button type="button" className="layout-icon-option" title="Default icon" onClick={() => onPick(null)}>
          <RotateCcw size={14} />
        </button>
      )}
      <button type="button" className="layout-icon-option" title="No icon" onClick={() => onPick('none')}>
        <Ban size={14} />
      </button>
      {GROUP_ICON_NAMES.map(name => (
        <button key={name} type="button" className="layout-icon-option" title={name} onClick={() => onPick(name)}>
          {groupIcon(name)}
        </button>
      ))}
    </div>,
    document.body
  )
}

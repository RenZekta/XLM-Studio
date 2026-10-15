import React, { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useOutsideClick } from '../hooks/useOutsideClick'

// A compact dropdown whose arrow flips while the list is open, styled like the
// session menus in Monitoring. Used where a native <select> would not show the
// open state. 'sidebar' is the narrow menu of the sidebar sections; 'field'
// fills a form column and looks like the inputs around it.

export interface SelectOption {
  value: string
  label: string
}

interface Props {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  title?: string
  variant?: 'sidebar' | 'field'
  disabled?: boolean
}

export default function SelectMenu({ options, value, onChange, placeholder = 'Select', title, variant = 'sidebar', disabled }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOutsideClick(ref, open, () => setOpen(false))
  const current = options.find(o => o.value === value)

  // The collapsed sidebar shrinks as soon as the pointer leaves it, which
  // would leave the open list clipped to the narrow rail.
  useEffect(() => {
    if (!open) return
    const rail = ref.current?.closest('.sidebar-compact')
    if (!rail) return
    const close = () => setOpen(false)
    rail.addEventListener('mouseleave', close)
    return () => rail.removeEventListener('mouseleave', close)
  }, [open])

  return (
    <div
      ref={ref}
      className={`select-menu select-menu-${variant}${open ? ' open' : ''}`}
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
      {open && (
        <div className="select-menu-panel" role="listbox">
          {options.map(o => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`select-menu-option${o.value === value ? ' selected' : ''}`}
              onClick={() => { setOpen(false); onChange(o.value) }}
              title={o.label}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

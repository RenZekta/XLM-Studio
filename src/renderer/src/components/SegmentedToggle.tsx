import React from 'react'

interface Props<T extends string> {
  label?: string
  options: { value: T; label: string; icon?: React.ReactNode }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

// A reusable segmented toggle switch. Like the theme selector, the active
// button carries the blue background itself, so the highlight is always
// exactly the size of the active position.
// Multi-line labels (containing "\n") are stacked vertically inside the button
// so a wide label like "FULL AUTO" fits without taking extra horizontal space.
export default function SegmentedToggle<T extends string>({ label, options, value, onChange, disabled }: Props<T>) {
  return (
    <div className="segmented-toggle-row">
      {label && <span className="segmented-toggle-label">{label}</span>}
      <div className="segmented-toggle">
        {options.map(o => {
          const lines = o.label.split('\n')
          const stacked = lines.length > 1
          return (
            <button
              key={o.value}
              type="button"
              className={`segmented-toggle-btn ${value === o.value ? 'active' : ''} ${stacked ? 'stacked-label' : ''}`}
              onClick={() => onChange(o.value)}
              disabled={disabled}
            >
              {o.icon}
              {stacked ? (
                <span className="stacked-label-inner">
                  {lines.map((ln, i) => <span key={i} className="stacked-label-line">{ln}</span>)}
                </span>
              ) : o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

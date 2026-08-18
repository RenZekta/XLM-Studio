import React from 'react'

interface Props<T extends string> {
  label?: string
  options: { value: T; label: string; icon?: React.ReactNode }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

// A reusable segmented toggle switch with a sliding blue accent highlight.
// Used for "Settings: FULL AUTO / Quick / Clear" (feature 15/Task 5) and
// "Parameters: Common / Full" (feature 30).
// Multi-line labels (containing "\n") are stacked vertically inside the button
// so a wide label like "FULL AUTO" fits without taking extra horizontal space.
export default function SegmentedToggle<T extends string>({ label, options, value, onChange, disabled }: Props<T>) {
  const activeIndex = Math.max(0, options.findIndex(o => o.value === value))
  return (
    <div className="segmented-toggle-row">
      {label && <span className="segmented-toggle-label">{label}</span>}
      <div className="segmented-toggle" data-active-index={activeIndex} style={{ '--total': options.length } as React.CSSProperties}>
        <div
          className="segmented-toggle-highlight"
          style={{
            width: `calc(100% / ${options.length})`,
            transform: `translateX(${activeIndex * 100}%)`
          }}
        />
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

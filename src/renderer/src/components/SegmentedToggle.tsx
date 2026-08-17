import React from 'react'

interface Props<T extends string> {
  label?: string
  options: { value: T; label: string; icon?: React.ReactNode }[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
}

// A reusable segmented toggle switch with a sliding blue accent highlight.
// Used for "Settings: Quick / Clear" (feature 15) and "Parameters: Common / Full" (feature 30).
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
        {options.map(o => (
          <button
            key={o.value}
            type="button"
            className={`segmented-toggle-btn ${value === o.value ? 'active' : ''}`}
            onClick={() => onChange(o.value)}
            disabled={disabled}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

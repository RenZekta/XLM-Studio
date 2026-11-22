import React from 'react'
import { Zap } from 'lucide-react'
import type { CardPreset } from '../../../shared/cardLogic'

// The preset buttons of an engine card, above its parameters.
export default function CardPresetBar({ presets, active, disabled, onApply }: {
  presets: CardPreset[]
  active?: string
  disabled?: boolean
  onApply: (preset: CardPreset) => void
}) {
  return (
    <div className="preset-toggle-row">
      <span className="preset-toggle-label">Presets:</span>
      {presets.map(p => (
        <button
          key={p.id} type="button" className={`preset-btn quick${active === p.id ? ' active' : ''}`}
          onClick={() => onApply(p)} disabled={disabled} title={p.description}
          style={active === p.id ? { borderColor: 'var(--accent)' } : undefined}
        >
          <Zap size={12} /> {p.name}
        </button>
      ))}
    </div>
  )
}

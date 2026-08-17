import React from 'react'
import { Zap, Eraser } from 'lucide-react'

interface Props {
  onQuick: () => void
  onClear: () => void
  disabled?: boolean
}

// Quick / Clear preset toggle placed above the Advanced Parameters section.
// - "Quick" fills all advanced inputs with LM-Studio-style optimized defaults.
// - "Clear" purges all non-automatic inputs, leaving placeholders empty so the
//   backend relies on its own implicit binary defaults.
export default function PresetToggle({ onQuick, onClear, disabled }: Props) {
  return (
    <div className="preset-toggle-row">
      <span className="preset-toggle-label">Settings:</span>
      <button type="button" className="preset-btn quick" onClick={onQuick} disabled={disabled} title="Populate optimized defaults (LM Studio style)">
        <Zap size={12} /> Quick
      </button>
      <button type="button" className="preset-btn clear" onClick={onClear} disabled={disabled} title="Clear all non-automatic inputs">
        <Eraser size={12} /> Clear
      </button>
    </div>
  )
}

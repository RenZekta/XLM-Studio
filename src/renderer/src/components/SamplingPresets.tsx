import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { Plus, Trash } from 'lucide-react'
import { StarIcon as StarShape } from '../utils/format'

interface Props {
  onApply: (values: any) => void
  disabled?: boolean
}

// Reusable sampling temperature presets manager.
// The dropdown now tracks the currently-selected preset independently
// of the starred preset, so selecting a preset updates the display.
export default function SamplingPresets({ onApply, disabled }: Props) {
  const { samplingPresets, setSamplingPresets } = useStore()
  const [showAddModal, setShowAddModal] = useState(false)
  const [newName, setNewName] = useState('')
  const starred = samplingPresets.find(p => p.isStarred) || samplingPresets[0]
  // Track the currently-selected preset (defaults to the starred one).
  const [selectedId, setSelectedId] = useState<string>(starred?.id || '')
  const selectedPreset = samplingPresets.find(p => p.id === selectedId) || starred

  async function handleStar(id: string) {
    try {
      await window.api?.starSamplingPreset?.(id)
      const updated = samplingPresets.map(p => ({ ...p, isStarred: p.id === id }))
      setSamplingPresets(updated)
      setSelectedId(id)
    } catch {}
  }

  async function handleDelete(id: string) {
    const preset = samplingPresets.find(p => p.id === id)
    if (preset?.isDefault) { alert('Hardcoded presets cannot be deleted.'); return }
    if (!confirm(`Delete preset "${preset?.name}"?`)) return
    try {
      await window.api?.deleteSamplingPreset?.(id)
      setSamplingPresets(samplingPresets.filter(p => p.id !== id))
      if (selectedId === id) setSelectedId(starred?.id || '')
    } catch {}
  }

  async function handleAdd() {
    if (!newName.trim()) return
    try {
      const res = await window.api?.addSamplingPreset?.(newName.trim(), {})
      if (res?.success) {
        setSamplingPresets([...samplingPresets, res.preset])
        setNewName('')
        setShowAddModal(false)
      }
    } catch {}
  }

  function handleSelect(id: string) {
    const p = samplingPresets.find(x => x.id === id)
    if (p) {
      setSelectedId(id)
      onApply(p.values)
    }
  }

  return (
    <div className="sampling-presets-row">
      <span className="sampling-presets-label">Temperature Presets:</span>
      <select
        className="cmd-select sampling-presets-select"
        value={selectedPreset?.id || ''}
        onChange={e => handleSelect(e.target.value)}
        disabled={disabled}
      >
        {samplingPresets.map(p => (
          <option key={p.id} value={p.id}>
            {p.name}{p.isStarred ? ' ★' : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="star-btn"
        onClick={() => selectedPreset && handleStar(selectedPreset.id)}
        title={selectedPreset?.isStarred ? 'Main default preset (click to unstar)' : 'Set as main default preset'}
        style={selectedPreset?.isStarred ? { color: '#f5b400' } : {}}
      >
        <StarShape active={!!selectedPreset?.isStarred} size={16} />
      </button>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => setShowAddModal(true)}
        disabled={disabled}
        title="Add custom preset"
      >
        <Plus size={12} /> Add Preset
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon text-danger"
        onClick={() => selectedPreset && handleDelete(selectedPreset.id)}
        disabled={disabled || selectedPreset?.isDefault}
        title="Delete preset"
      >
        <Trash size={14} />
      </button>
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header"><h2 className="modal-title">New Preset</h2></div>
            <div className="modal-body">
              <input
                className="form-input"
                type="text"
                placeholder="Preset name..."
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowAddModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={!newName.trim()}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

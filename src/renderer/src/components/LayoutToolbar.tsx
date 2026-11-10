import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Save, X, Menu, Minimize2, Maximize2, Plus, Pencil, Trash, Check } from 'lucide-react'
import { useStore } from '../store/useStore'
import { ENGINES } from '../../../shared/engines'
import { activeLayoutPreset, isDefaultLayoutId, layoutPresetsOf } from '../../../shared/paramLayout'
import { useOverlayClose } from '../hooks/useOverlayClose'

// Controls of Edit Layout, docked at the top right of the open parameter list: save, quit without
// saving, the layout presets of the Template's engine, and a compact view of the list.

type NameTask = { kind: 'add' } | { kind: 'rename'; id: string; name: string } | { kind: 'save' }

export default function LayoutToolbar() {
  const {
    layoutEdit, layoutLibrary, saveLayoutEdit, cancelLayoutEdit, setLayoutCompact, layoutSaveNeedsName,
    selectLayoutPreset, createLayoutPreset, renameLayoutPreset, removeLayoutPreset
  } = useStore()
  const [listOpen, setListOpen] = useState(false)
  const [task, setTask] = useState<NameTask | null>(null)
  const [name, setName] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const overlayClose = useOverlayClose(() => setTask(null))

  useEffect(() => {
    if (!listOpen) return
    const onDown = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setListOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setListOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [listOpen])

  if (!layoutEdit) return null
  const { engine, presetId, draft, compact } = layoutEdit
  const presets = layoutPresetsOf(layoutLibrary, engine)
  const inUse = activeLayoutPreset(layoutLibrary, engine).id

  function askName(next: NameTask) {
    setName(next.kind === 'rename' ? next.name : next.kind === 'save' ? 'My layout' : '')
    setTask(next)
    setListOpen(false)
  }

  function confirmName() {
    if (!task || !name.trim()) return
    if (task.kind === 'add') createLayoutPreset(name)
    else if (task.kind === 'rename') renameLayoutPreset(task.id, name)
    else saveLayoutEdit(name)
    setTask(null)
  }

  function handleSave() {
    if (layoutSaveNeedsName()) askName({ kind: 'save' })
    else saveLayoutEdit()
  }

  function handleSelect(id: string) {
    if (id === presetId) return
    if (draft && !confirm('Switching layouts discards the changes you have not saved. Continue?')) return
    selectLayoutPreset(id)
  }

  function handleDelete(id: string, label: string) {
    if (isDefaultLayoutId(id) || !confirm(`Delete layout "${label}"?`)) return
    removeLayoutPreset(id)
  }

  return (
    <div className="layout-toolbar" ref={wrapRef}>
      <button type="button" className="layout-tool-btn layout-tool-save" title="Save and use this layout" onClick={handleSave}>
        <Save size={16} />
      </button>
      <button type="button" className="layout-tool-btn layout-tool-cancel" title="Discard changes and quit editing" onClick={() => cancelLayoutEdit()}>
        <X size={16} />
      </button>
      <button
        type="button"
        className={`layout-tool-btn layout-tool-list ${listOpen ? 'active' : ''}`}
        title="Layout presets"
        onClick={() => setListOpen(o => !o)}
      >
        <Menu size={16} />
      </button>
      <button
        type="button"
        className={`layout-tool-btn layout-tool-compact ${compact ? 'active' : ''}`}
        title={compact ? 'Show full parameters' : 'Show groups, blocks and parameters as a compact list'}
        onClick={() => setLayoutCompact(!compact)}
      >
        {compact ? <Maximize2 size={16} /> : <Minimize2 size={16} />}
      </button>
      {listOpen && (
        <div className="layout-presets-pop">
          <div className="layout-presets-title">{ENGINES[engine].label} layouts</div>
          <div className="layout-presets-list">
            {presets.map(p => {
              const isDefault = isDefaultLayoutId(p.id)
              return (
                <div
                  key={p.id}
                  className={`layout-preset-row ${p.id === presetId ? 'selected' : ''}`}
                  onClick={() => handleSelect(p.id)}
                >
                  <span className="layout-preset-check">{p.id === presetId && <Check size={13} />}</span>
                  <span className="layout-preset-name">{p.name}</span>
                  {isDefault && <span className="layout-preset-tag">built in</span>}
                  {p.id === inUse && <span className="layout-preset-tag layout-preset-tag-use">in use</span>}
                  {!isDefault && (
                    <>
                      <button type="button" className="btn btn-ghost btn-icon" title="Rename layout"
                        onClick={e => { e.stopPropagation(); askName({ kind: 'rename', id: p.id, name: p.name }) }}>
                        <Pencil size={12} />
                      </button>
                      <button type="button" className="btn btn-ghost btn-icon text-danger" title="Delete layout"
                        onClick={e => { e.stopPropagation(); handleDelete(p.id, p.name) }}>
                        <Trash size={12} />
                      </button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
          <button type="button" className="btn btn-secondary btn-sm layout-presets-add" onClick={() => askName({ kind: 'add' })}
            title="Save the layout as it is now under a new name">
            <Plus size={12} /> Add Preset
          </button>
        </div>
      )}
      {task && createPortal(
        <div className="modal-overlay" {...overlayClose}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2 className="modal-title">{task.kind === 'rename' ? 'Rename Layout' : task.kind === 'save' ? 'Save as New Layout' : 'New Layout'}</h2>
            </div>
            <div className="modal-body">
              {task.kind === 'save' && (
                <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
                  The built-in Default cannot be changed, so your arrangement is saved as a new layout.
                </div>
              )}
              <input
                className="form-input"
                type="text"
                placeholder="Layout name..."
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmName() }}
                autoFocus
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setTask(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={confirmName} disabled={!name.trim()}>
                {task.kind === 'rename' ? 'Rename' : task.kind === 'save' ? 'Save' : 'Add'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

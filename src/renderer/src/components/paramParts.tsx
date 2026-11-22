import React from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import HybridSlider from './HybridSlider'
import SegmentedToggle from './SegmentedToggle'
import SelectMenu from './SelectMenu'
import { CONTEXT_POWER_OF_TWO_STEPS } from '../utils/contextFormat'
import type { CommandParam } from '../../../shared/types'
import type { CardTone } from '../../../shared/cardLogic'
import type { ParamView } from '../../../shared/cardRules'

// The pieces a parameter row is made of. The card editor, the override panel and
// card blocks all build from these, so a widget looks and behaves the same wherever it appears.

export const TONE_COLOR: Record<CardTone, string> = {
  info: 'var(--info-blue)', success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', muted: 'var(--text-muted)'
}

export function Banner({ tone = 'info', icon, children }: { tone?: CardTone; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cpu-info-banner" style={{ color: TONE_COLOR[tone] }}>
      {icon}
      <span style={{ minWidth: 0 }}>{children}</span>
    </div>
  )
}

export function ParamRow({ label, description, arg, note, children }: { label: string; description?: string; arg?: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cmd-row">
      <div className="cmd-label-group">
        <div className="cmd-label tooltip-wrap">
          {label}
          {description ? <span className="tooltip">{description}</span> : null}
        </div>
        {arg ? <div className="cmd-arg">{arg}</div> : null}
        {note ? <div className="cmd-arg" style={{ color: 'var(--warning)' }}>{note}</div> : null}
      </div>
      <div className="cmd-input-group">{children}</div>
    </div>
  )
}

interface ControlProps {
  cmd: CommandParam
  view: ParamView
  value: any
  onChange: (value: any) => void
  disabled?: boolean
}

function ToggleControl({ cmd, view, value, onChange, disabled }: ControlProps) {
  const checked = value === undefined ? !!view.default : !!value
  return (
    <div className="toggle-wrap">
      <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} disabled={disabled} aria-label={cmd.label} />
        <span className="toggle-track"></span><span className="toggle-thumb"></span>
      </label>
    </div>
  )
}

function TristateControl({ value, onChange, disabled }: ControlProps) {
  return (
    <SelectMenu
      variant="compact" style={{ width: '100%' }} disabled={disabled}
      value={value === true ? 'on' : value === false ? 'off' : ''}
      onChange={v => onChange(v === 'on' ? true : v === 'off' ? false : null)}
      options={[{ value: '', label: 'Engine default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
    />
  )
}

function NumberControl({ cmd, view, value, onChange, disabled }: ControlProps) {
  return (
    <input
      type="number" className="cmd-input" value={value ?? view.default ?? ''} placeholder={cmd.placeholder}
      min={view.min} max={view.max} step="any" disabled={disabled}
      onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
    />
  )
}

function SliderControl({ cmd, view, value, onChange, disabled }: ControlProps) {
  const min = view.min ?? 0
  const max = Math.max(min, view.max ?? min + 100)
  const s = cmd.slider ?? {}
  const ladder = s.scale === 'ladder'
  return (
    <HybridSlider
      value={value ?? ''} min={min} max={max} step={s.step ?? 1}
      allowAuto={s.allowAuto ?? true} recommended={s.recommended} recommendedLabel={s.recommendedLabel}
      defaultVal={typeof view.default === 'number' ? view.default : undefined}
      useSpacedFormat={max >= 10000} use2xIncrements={ladder} ladderSteps={ladder ? CONTEXT_POWER_OF_TWO_STEPS : undefined}
      placeholder={cmd.placeholder} disabled={disabled}
      onChange={v => onChange(v === '' ? null : Number(v))}
    />
  )
}

function SelectControl({ cmd, view, value, onChange, disabled }: ControlProps) {
  const options = view.options ?? []
  const val = value ?? view.default ?? ''
  return (
    <SelectMenu
      variant="compact" style={{ width: '100%' }} value={String(val)}
      placeholder={cmd.emptyLabel || 'Engine default'} disabled={disabled}
      onChange={v => onChange(v)}
      options={[
        ...(!cmd.requireValue ? [{ value: '', label: cmd.emptyLabel || 'Engine default' }] : []),
        ...options.map(opt => ({ value: opt, label: cmd.optionLabels?.[opt] ?? opt })),
        ...(val !== '' && !options.includes(String(val)) ? [{ value: String(val), label: String(val) }] : [])
      ]}
    />
  )
}

function SegmentedControl({ cmd, view, value, onChange, disabled }: ControlProps) {
  const options = view.options ?? []
  const val = value ?? view.default ?? ''
  // An unset segmented control is a second click away from unset again.
  return (
    <SegmentedToggle
      disabled={disabled} value={String(val)}
      options={options.map(o => ({ value: o, label: cmd.optionLabels?.[o] ?? o }))}
      onChange={v => onChange(v === String(val) && !cmd.requireValue ? null : v)}
    />
  )
}

function TextControl({ cmd, value, onChange, disabled }: ControlProps) {
  const common = { className: 'cmd-input', value: value ?? '', placeholder: cmd.placeholder, disabled, style: { flex: 1, minWidth: 0 } as React.CSSProperties }
  if (cmd.widget === 'textarea') {
    return <textarea className="cmd-textarea" rows={3} style={{ width: '100%' }} value={value ?? ''} placeholder={cmd.placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} />
  }
  return <input type={cmd.widget === 'password' ? 'password' : 'text'} autoComplete="off" {...common} onChange={e => onChange(e.target.value)} />
}

function PathControl({ cmd, value, onChange, disabled }: ControlProps) {
  async function pick() {
    const picked = cmd.widget === 'folder' ? await window.api.pickFolder() : await window.api.pickAnyFile()
    if (picked) onChange(picked)
  }
  return (
    <div style={{ display: 'flex', gap: 6, width: '100%' }}>
      <input type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={value ?? ''} placeholder={cmd.placeholder} disabled={disabled} onChange={e => onChange(e.target.value)} />
      <button type="button" className="btn btn-ghost" disabled={disabled} onClick={pick} title={cmd.widget === 'folder' ? 'Choose a folder' : 'Choose a file'}><FolderOpen size={14} /></button>
    </div>
  )
}

// Items are stored as a list of strings; a pair editor splits each on its first "=".
function ListControl({ cmd, value, onChange, disabled }: ControlProps) {
  const items: string[] = Array.isArray(value) ? value : []
  const pairs = cmd.widget === 'keyvalue'
  const set = (next: string[]) => onChange(next)
  const split = (s: string): [string, string] => { const i = s.indexOf('='); return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)] }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
      {items.map((item, i) => {
        const [k, v] = split(item)
        return (
          <div key={i} style={{ display: 'flex', gap: 6 }}>
            {pairs ? (
              <>
                <input type="text" className="cmd-input" style={{ width: 120 }} value={k} placeholder="name" disabled={disabled} onChange={e => set(items.map((x, j) => (j === i ? `${e.target.value}=${v}` : x)))} />
                <input type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={v} placeholder="value" disabled={disabled} onChange={e => set(items.map((x, j) => (j === i ? `${k}=${e.target.value}` : x)))} />
              </>
            ) : (
              <input type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={item} placeholder={cmd.placeholder} disabled={disabled} onChange={e => set(items.map((x, j) => (j === i ? e.target.value : x)))} />
            )}
            <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => set(items.filter((_, j) => j !== i))} title="Remove"><X size={14} /></button>
          </div>
        )
      })}
      <div><button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => set([...items, pairs ? '=' : ''])}><Plus size={14} /> Add</button></div>
    </div>
  )
}

// The editor for one parameter, chosen by its widget and then by its type.
export function ParamControl(props: ControlProps) {
  const { cmd } = props
  switch (cmd.widget) {
    case 'slider': return <SliderControl {...props} />
    case 'segmented': return <SegmentedControl {...props} />
    case 'tristate': return <TristateControl {...props} />
    case 'file': case 'folder': return <PathControl {...props} />
    case 'list': case 'keyvalue': return <ListControl {...props} />
    case 'password': case 'textarea': return <TextControl {...props} />
    default: break
  }
  if (cmd.type === 'boolean') return cmd.offArg ? <TristateControl {...props} /> : <ToggleControl {...props} />
  if (cmd.type === 'number') return <NumberControl {...props} />
  if (cmd.type === 'select') return <SelectControl {...props} />
  return <TextControl {...props} />
}

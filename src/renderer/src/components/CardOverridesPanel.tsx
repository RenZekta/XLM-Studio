import React from 'react'
import { Server } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { EngineCard } from '../../../shared/engineCard'
import type { OverrideField } from '../../../shared/cardLogic'
import type { CommandParam } from '../../../shared/types'
import { cardParamMap } from '../../../shared/cardRules'
import { ParamControl } from './paramParts'

// The override fields of an engine card. A field with a value forces its
// parameter on every Template of the engine; a field that is off forces nothing.

function paramOf(f: OverrideField): CommandParam {
  return {
    arg: f.id, label: f.label, description: f.description ?? '', type: f.type === 'boolean' ? 'boolean' : f.type,
    ...(f.min !== undefined ? { min: f.min } : {}), ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.options ? { options: f.options } : {}), requireValue: true
  }
}

const initial = (f: OverrideField): unknown =>
  f.type === 'boolean' ? true : f.type === 'number' ? (f.min ?? 1) : f.type === 'select' ? (f.options?.[0] ?? '') : ' '

export default function CardOverridesPanel({ card }: { card: EngineCard }) {
  const { engineOverrides, setEngineOverrides } = useStore()
  const values = engineOverrides[card.id] ?? {}
  const params = cardParamMap(card)
  const sections = card.overrides?.sections ?? []
  const global = card.overrides?.global ?? {}

  function save(id: string, v: unknown) {
    const next = { ...values }
    if (v === undefined || v === null) delete next[id]
    else next[id] = v
    setEngineOverrides({ ...engineOverrides, [card.id]: next })
    window.api.setEngineOverrides(card.id, next).catch(() => {})
  }

  if (sections.length === 0 && Object.keys(global).length === 0) {
    return <div className="text-muted text-sm">{card.label} has no global overrides.</div>
  }
  return (
    <>
      {Object.keys(global).length > 0 && (
        <div className="text-muted text-sm" style={{ marginBottom: 12 }}>
          The global {Object.entries(global).map(([k, arg]) => `${k === 'parallel' ? 'Parallel Inference' : 'CPU Threads'} override (${params.get(arg as string)?.label ?? arg})`).join(' and ')} on the llama.cpp tab also applies to {card.label}.
        </div>
      )}
      {sections.map(section => (
        <div className="settings-section" key={section.id}>
          <div className="settings-section-title"><Server /> {section.title}</div>
          {section.fields.map(f => {
            const on = values[f.id] !== undefined
            return (
              <div className="settings-row" key={f.id} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                  <div>
                    <div className="settings-row-label">{f.label}</div>
                    <div className="settings-row-sub">
                      {f.description ? `${f.description} ` : ''}Forces <code>{f.applyTo}</code> on every {card.label} Template.
                    </div>
                  </div>
                  <div className="toggle-wrap">
                    <label className="toggle">
                      <input type="checkbox" checked={on} onChange={e => save(f.id, e.target.checked ? initial(f) : null)} />
                      <span className="toggle-track"></span><span className="toggle-thumb"></span>
                    </label>
                  </div>
                </div>
                {on && f.type !== 'boolean' && (
                  <ParamControl cmd={paramOf(f)} view={{ label: f.label, description: '', min: f.min, max: f.max, options: f.options }} value={values[f.id]} onChange={v => save(f.id, v)} />
                )}
                {on && f.type === 'boolean' && (
                  <ParamControl cmd={{ ...paramOf(f), offArg: '-' }} view={{ label: f.label, description: '' }} value={values[f.id]} onChange={v => save(f.id, v === null ? true : v)} />
                )}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

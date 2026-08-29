import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { Link2, Database, Shield, Copy, Check, Server } from 'lucide-react'
import { formatWithSpaces, parseSpacedNumber, CONTEXT_POWER_OF_TWO_STEPS, snapToNearestPowerOfTwo, indexOnLadder } from '../utils/contextFormat'


// Base URL field — LM Studio style.
// REST (not focused): the whole URL "http://localhost:<port>/v1" is one
//   continuous white string (a single link, no breaks). A copy button sits
//   on the RIGHT inside the box.
// FOCUSED (editing the port): "http://localhost:" turns gray, the port is
//   white/editable, and "/v1" is pushed to the right border (gray, static
//   suffix). The copy button disappears to make room for /v1 at the right.
//   A blue/purple focus glow highlights the box.
function BaseUrlField({ port, onPortChange, onPortBlur }: {
  port: number
  onPortChange: (p: number) => void
  onPortBlur: () => void
}) {
  const [focused, setFocused] = useState(false)
  const [copied, setCopied] = useState(false)
  const fullUrl = `http://localhost:${port}/v1`
  function handleCopy() {
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div
      className="base-url-field-lm"
      style={{
        display: 'flex', alignItems: 'center',
        width: '100%', maxWidth: 420, height: 36,
        border: `1px solid ${focused ? 'var(--info-blue, #3b82f6)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
        boxShadow: focused ? '0 0 0 3px rgba(59,130,246,.18)' : 'none',
        transition: 'border-color 150ms, box-shadow 150ms',
        fontFamily: 'var(--font-mono)', fontSize: 13,
        overflow: 'hidden'
      }}
    >
      {/* "http://localhost:" — white in rest, gray when focused (editing). */}
      <span
        style={{
          padding: '0 0 0 10px',
          color: focused ? 'var(--text-muted)' : 'var(--text)',
          whiteSpace: 'nowrap', userSelect: 'none'
        }}
      >
        http://localhost:
      </span>
      {/* The port — inline transparent input. White in both states. */}
      <input
        type="number"
        min={1}
        max={65535}
        value={port}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const p = Math.max(1, Math.min(65535, Number(e.target.value) || 1234))
          onPortChange(p)
        }}
        onBlur={() => { setFocused(false); onPortBlur() }}
        style={{
          width: `${Math.max(1, String(port || '').length)}ch`,
          minWidth: '1ch',
          border: 'none', outline: 'none', background: 'transparent',
          textAlign: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 13,
          color: 'var(--text)', fontWeight: 600,
          MozAppearance: 'textfield', padding: 0,
          flexGrow: 0
        }}
        title="Port number (1–65535)"
      />
      {/* Right side: in REST show "/v1" + copy button as one continuous white
          link. When FOCUSED, push "/v1" to the right border (gray) and hide the
          copy button (it would collide). */}
      {!focused ? (
        <>
          <span style={{ padding: '0 2px', color: 'var(--text)', whiteSpace: 'nowrap', userSelect: 'none' }}>
            /v1
          </span>
          <button
            type="button"
            onClick={handleCopy}
            title="Copy URL"
            style={{
              flexShrink: 0, width: 34, height: '100%', marginLeft: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', borderLeft: '1px solid var(--border)',
              background: 'transparent', cursor: 'pointer',
              color: copied ? 'var(--success)' : 'var(--text-muted)'
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </>
      ) : (
        <span style={{ padding: '0 10px 0 4px', color: 'var(--text-muted)', whiteSpace: 'nowrap', userSelect: 'none', marginLeft: 'auto' }}>
          /v1
        </span>
      )}
    </div>
  )
}

export default function OverridesView() {
  const {
    modelDefaults, setModelDefaults, baseUrlOverride, setBaseUrlOverride, cpuInfo,
    vramInfo, systemRam
  } = useStore()
  // "Recommended CPU Threads override" — local text-input draft state so
  // the user can type any % while editing, snapping to a whole-core-accurate
  // value only on Enter/blur (not on every keystroke).
  const [cpuThreadsPercentDraft, setCpuThreadsPercentDraft] = useState<string | null>(null)
  // "Parallel Sequences override" — draft-input state, keyed per slider
  // (unified/dense/moe) since Separate mode needs two independent drafts.
  const [parallelValueDraft, setParallelValueDraft] = useState<Record<string, string | null> | null>(null)

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Overrides</h1>
          <p className="page-subtitle">Global settings that override or influence per-template values across every model.</p>
        </div>
      </div>

      {/* Feature 24: Base URL Override */}
      <div className="settings-section">
        <div className="settings-section-title"><Link2 /> Base URL Override</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Enable Base URL override</div>
              <div className="settings-row-sub">Force every launched backend onto a single port. The server listens at <code>http://localhost:&lt;port&gt;/v1</code>.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={baseUrlOverride.enabled} onChange={async (e) => {
                  const o = { ...baseUrlOverride, enabled: e.target.checked }
                  setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {/* Task 1: Base URL — LM Studio style. Single unified box with the full
              URL as one continuous string; the port is an inline transparent input.
              A copy button sits on the LEFT, visible when the input isn't focused.
              When focused, a purple/blue focus glow highlights the box. */}
          <div style={{ width: '100%' }}>
            <BaseUrlField
              port={baseUrlOverride.port}
              onPortChange={async (p) => {
                const o = { ...baseUrlOverride, port: p }
                setBaseUrlOverride(o)
              }}
              onPortBlur={async () => { try { await window.api?.setBaseUrlOverride?.(baseUrlOverride) } catch {} }}
            />
            <div className="form-hint">Only the port number is editable. Click the box to edit, or use the copy button to copy the full URL.</div>
          </div>

          {/* Serve on local network */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Serve on local network</div>
              <div className="settings-row-sub">Bind to <code>0.0.0.0</code> so other devices on your LAN can reach the server.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!baseUrlOverride.serveOnLocalNetwork} onChange={async (e) => {
                  const o = { ...baseUrlOverride, serveOnLocalNetwork: e.target.checked }
                  setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {/* API Key */}
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div>
                <div className="settings-row-label">API Key</div>
                <div className="settings-row-sub">Require an API key for all requests (adds <code>--api-key</code>).</div>
              </div>
              <div className="toggle-wrap">
                <label className="toggle">
                  <input type="checkbox" checked={!!baseUrlOverride.apiKeyEnabled} onChange={async (e) => {
                    const o = { ...baseUrlOverride, apiKeyEnabled: e.target.checked }
                    setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                  }} />
                  <span className="toggle-track"></span><span className="toggle-thumb"></span>
                </label>
              </div>
            </div>
            {baseUrlOverride.apiKeyEnabled && (
              <input
                type="text"
                className="form-input"
                style={{ width: '100%', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                value={baseUrlOverride.apiKey}
                placeholder="sk-..."
                onChange={async (e) => {
                  const o = { ...baseUrlOverride, apiKey: e.target.value }
                  setBaseUrlOverride(o)
                }}
                onBlur={async () => { try { await window.api?.setBaseUrlOverride?.(baseUrlOverride) } catch {} }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Item (this round): "Parallel Inference" block — Unified/Separate replaces
          the old MoE-only scoping toggle. */}
      <div className="settings-section">
        <div className="settings-section-title"><Server /> Parallel Inference</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Enable Parallel Sequences override</div>
              <div className="settings-row-sub">
                Forces <code>--parallel</code> / <code>-np</code> to the value(s) below at launch, regardless of what the template itself has set — sets the number of independent virtual slots ("users") for parallel agents.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!modelDefaults.parallelOverrideEnabled} onChange={async (e) => {
                  const d = { ...modelDefaults, parallelOverrideEnabled: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {modelDefaults.parallelOverrideEnabled && (() => {
            const mode: 'unified' | 'separate' = modelDefaults.parallelInferenceMode === 'separate' ? 'separate' : 'unified'
            const setMode = async (m: 'unified' | 'separate') => {
              const d = { ...modelDefaults, parallelInferenceMode: m }
              setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
            }
            const makeSlider = (label: string, field: 'parallelOverrideValue' | 'parallelOverrideValueDense' | 'parallelOverrideValueMoe', draftKey: string) => {
              const currentValue = (modelDefaults as any)[field] ?? 4
              const draft = (parallelValueDraft as any)?.[draftKey]
              const commitValue = async (raw: number) => {
                const clamped = Math.max(1, Math.min(256, Math.round(raw)))
                const d = { ...modelDefaults, [field]: clamped }
                setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                setParallelValueDraft((prev: any) => ({ ...(prev || {}), [draftKey]: null }))
              }
              return (
                <div key={field} style={{ width: '100%', marginTop: 6 }}>
                  {label && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, fontWeight: 600 }}>{label}</div>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input type="range" min={1} max={64} step={1} value={currentValue} style={{ flex: 1 }}
                      onChange={(e) => commitValue(Number(e.target.value))} />
                    <input
                      type="text" inputMode="numeric" className="form-input" style={{ width: 70, textAlign: 'right' }}
                      value={draft ?? String(currentValue)}
                      onChange={(e) => setParallelValueDraft((prev: any) => ({ ...(prev || {}), [draftKey]: e.target.value.replace(/[^\d]/g, '') }))}
                      onBlur={() => {
                        const n = parseInt(draft ?? '', 10)
                        if (!isNaN(n)) commitValue(n)
                        else setParallelValueDraft((prev: any) => ({ ...(prev || {}), [draftKey]: null }))
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const n = parseInt(draft ?? '', 10)
                          if (!isNaN(n)) commitValue(n)
                          else setParallelValueDraft((prev: any) => ({ ...(prev || {}), [draftKey]: null }))
                          ;(e.target as HTMLInputElement).blur()
                        }
                      }}
                    />
                  </div>
                </div>
              )
            }
            return (
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Parallel Inference overrides for Dense and MoE:</span>
                  <div className="segmented-toggle" style={{ width: 'auto' }}>
                    <div className="segmented-toggle-highlight" style={{ width: 'calc(100% / 2)', transform: `translateX(${mode === 'separate' ? 100 : 0}%)` }} />
                    <button type="button" className={`segmented-toggle-btn ${mode === 'unified' ? 'active' : ''}`} onClick={() => setMode('unified')}>Unified</button>
                    <button type="button" className={`segmented-toggle-btn ${mode === 'separate' ? 'active' : ''}`} onClick={() => setMode('separate')}>Separate</button>
                  </div>
                </div>
                {mode === 'unified'
                  ? makeSlider('', 'parallelOverrideValue', 'unified')
                  : (
                    <>
                      {makeSlider('Dense models', 'parallelOverrideValueDense', 'dense')}
                      {makeSlider('MoE models', 'parallelOverrideValueMoe', 'moe')}
                    </>
                  )}
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {mode === 'unified'
                    ? <code>--parallel {modelDefaults.parallelOverrideValue ?? 4}</code>
                    : <><code>--parallel {modelDefaults.parallelOverrideValueDense ?? 4}</code> (Dense) · <code>--parallel {modelDefaults.parallelOverrideValueMoe ?? 4}</code> (MoE)</>}
                  {' '}— applied at launch for every template.
                </div>
              </div>
            )
          })()}
        </div>
      </div>

      {/* Feature 18: Model Defaults — AutoFit context override */}
      <div className="settings-section">
        <div className="settings-section-title"><Database /> Model Defaults</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Minimum AutoFit context length override</div>
              <div className="settings-row-sub">Guarantees a minimum context token ceiling during VRAM budgeting.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={modelDefaults.autoFitEnabled} onChange={async (e) => {
                  const d = { ...modelDefaults, autoFitEnabled: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {modelDefaults.autoFitEnabled && (
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Minimum AutoFit context length</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  style={{ width: 110 }}
                  value={formatWithSpaces(modelDefaults.autoFitContextLength)}
                  onChange={async (e) => {
                    const raw = parseSpacedNumber(e.target.value)
                    const clamped = Math.max(0, Math.min(2097152, raw))
                    const value = modelDefaults.autoFitUse2xIncrements ? snapToNearestPowerOfTwo(clamped) : clamped
                    const d = { ...modelDefaults, autoFitContextLength: value }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
                {/* Item 5: bumped ceiling 200 000 → 2 097 152 (2M-context models). */}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>tokens (0 – 2 097 152; 0 = no minimum, defers to the template's/model's own context)</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!modelDefaults.autoFitUse2xIncrements} onChange={async (e) => {
                    const use2x = e.target.checked
                    const d = {
                      ...modelDefaults,
                      autoFitUse2xIncrements: use2x,
                      // Snap the current value onto the ladder immediately so the
                      // slider and the number field agree the moment this is checked.
                      autoFitContextLength: use2x ? snapToNearestPowerOfTwo(modelDefaults.autoFitContextLength) : modelDefaults.autoFitContextLength
                    }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
                  Use 2x increments
                </label>
              </div>
              {modelDefaults.autoFitUse2xIncrements ? (
                <input
                  type="range"
                  min={0}
                  max={CONTEXT_POWER_OF_TWO_STEPS.length - 1}
                  step={1}
                  value={indexOnLadder(modelDefaults.autoFitContextLength)}
                  style={{ width: '100%' }}
                  onChange={async (e) => {
                    const value = CONTEXT_POWER_OF_TWO_STEPS[Number(e.target.value)]
                    const d = { ...modelDefaults, autoFitContextLength: value }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
              ) : (
                <input type="range" min={0} max={2097152} step={1024} value={modelDefaults.autoFitContextLength} style={{ width: '100%' }}
                  onChange={async (e) => {
                    const d = { ...modelDefaults, autoFitContextLength: Number(e.target.value) }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
              )}
              {/* Item 5: "Automatic YaRN scaling control override and upscale to
                  AutoFit" — when on, every template's effective max context can be
                  upscaled via YaRN to reach this AutoFit floor even if the model's
                  native context is smaller. See item 8 for the per-template switch
                  this mirrors/drives. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 12 }}>
                <div>
                  <div className="settings-row-label" style={{ fontSize: 12 }}>Automatic YaRN scaling control override and upscale to AutoFit</div>
                  <div className="settings-row-sub" style={{ fontSize: 11 }}>
                    When a model's native context is below the Minimum AutoFit override above, automatically apply YaRN RoPE scaling to reach it, instead of capping at the model's native maximum.
                  </div>
                </div>
                <div className="toggle-wrap">
                  <label className="toggle">
                    <input type="checkbox" checked={!!modelDefaults.autoFitYarnAutoScale} onChange={async (e) => {
                      const d = { ...modelDefaults, autoFitYarnAutoScale: e.target.checked }
                      setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                    }} />
                    <span className="toggle-track"></span><span className="toggle-thumb"></span>
                  </label>
                </div>
              </div>
            </div>
          )}
          {/* Task 4: Current Memory State use in memory calculations */}
          {/* Item 4 (rename): "Current Memory State use in memory calculations"
              -> "Use current memory state in memory calculations" — same
              setting, just reads better grammatically. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
            <div>
              <div className="settings-row-label">Use current memory state in memory calculations</div>
              <div className="settings-row-sub">
                ON = use the currently-available Free VRAM / Free RAM (polled every 10s). OFF (default) = use the static maximum VRAM / RAM totals — more conservative and stable.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!modelDefaults.useCurrentMemState} onChange={async (e) => {
                  const d = { ...modelDefaults, useCurrentMemState: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {!modelDefaults.useCurrentMemState && (
            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6, lineHeight: 1.5 }}>
              Consider turning memory overhead on for system stability when using device alongside running model with full VRAM/RAM utilization.
            </div>
          )}
          {/* New: "Enable Multimodal Projector automatically in new Template
              if mmproj was detected" — ON by default. This governs whether a
              brand-new template defaults mmproj ON when the model has one, or
              always starts OFF (saving VRAM/RAM for users who don't need
              vision) until manually enabled. Existing templates and manual
              toggles are unaffected either way. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
            <div>
              <div className="settings-row-label">Enable Multimodal Projector automatically in new Template if mmproj was detected</div>
              <div className="settings-row-sub">
                Save memory when you don't need vision capabilities.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={modelDefaults.autoEnableMmproj !== false} onChange={async (e) => {
                  const d = { ...modelDefaults, autoEnableMmproj: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {/* New: "Recommended CPU Threads override" — controls what
              Template -> CPU Threads defaults to for new templates (normally
              75% of physical cores). Off by default; when on, defaults to
              100%. The slider steps in 5% increments; the text input accepts
              any %, but always gets snapped to the nearest whole-core-
              equivalent percentage on Enter/blur, so it can never resolve to
              a fractional core count. Existing templates whose --threads
              doesn't match the (possibly overridden) recommendation get the
              standard preset-diff highlighting + reset-to-default button. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
            <div>
              <div className="settings-row-label">Recommended CPU Threads override</div>
              <div className="settings-row-sub">
                Overrides the default 75% of physical cores used to recommend Template → CPU Threads.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!modelDefaults.cpuThreadsOverrideEnabled} onChange={async (e) => {
                  const d = { ...modelDefaults, cpuThreadsOverrideEnabled: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {modelDefaults.cpuThreadsOverrideEnabled && (() => {
            const physicalCores = cpuInfo?.physicalCores || 8
            // Snap any % to the nearest one that corresponds to a WHOLE
            // number of cores for THIS machine — e.g. on a 6-core CPU, 50%
            // (3 cores exactly) stays 50%, but 45% (2.7 cores) snaps to
            // whichever of 33%/50% is closer to a whole core.
            const snapToWholeCore = (pct: number): number => {
              const clamped = Math.max(0, Math.min(100, pct))
              const cores = Math.max(1, Math.min(physicalCores, Math.round((clamped / 100) * physicalCores)))
              return Math.round((cores / physicalCores) * 100)
            }
            const commitPercent = async (rawPct: number) => {
              const snapped = snapToWholeCore(rawPct)
              const d = { ...modelDefaults, cpuThreadsOverridePercent: snapped }
              setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
              setCpuThreadsPercentDraft(null)
            }
            const currentPercent = modelDefaults.cpuThreadsOverridePercent ?? 100
            const currentCores = Math.max(1, Math.round((currentPercent / 100) * physicalCores))
            return (
              <div style={{ width: '100%', marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={currentPercent}
                    style={{ flex: 1 }}
                    onChange={(e) => commitPercent(Number(e.target.value))}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    className="form-input"
                    style={{ width: 70, textAlign: 'right' }}
                    value={cpuThreadsPercentDraft ?? String(currentPercent)}
                    onChange={(e) => setCpuThreadsPercentDraft(e.target.value.replace(/[^\d]/g, ''))}
                    onBlur={() => {
                      const n = parseInt(cpuThreadsPercentDraft ?? '', 10)
                      if (!isNaN(n)) commitPercent(n)
                      else setCpuThreadsPercentDraft(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const n = parseInt(cpuThreadsPercentDraft ?? '', 10)
                        if (!isNaN(n)) commitPercent(n)
                        else setCpuThreadsPercentDraft(null)
                        ;(e.target as HTMLInputElement).blur()
                      }
                    }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>%</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {currentPercent}% of {physicalCores} physical cores = <strong>{currentCores}</strong> recommended thread{currentCores === 1 ? '' : 's'} for new templates.
                </div>
              </div>
            )
          })()}
          <div style={{ width: '100%', marginTop: 12 }}>
            <div className="settings-row-label" style={{ marginBottom: 4 }}>Strategy for MoE offloading calculations</div>
            <div className="settings-row-sub" style={{ marginBottom: 8 }}>
              "Offload GPU Layers" leaves layer placement to llama.cpp's own MoE-aware auto-split heuristic. "MAX GPU Layers and Force MoE Weights onto CPU" (default) keeps all non-expert layers resident on GPU and only forces as many MoE/expert weight blocks onto CPU RAM as needed to fit the desired context — the more precise, usually faster option. Works together with "Maximum available" AutoFill (it computes exactly how many layers to force onto CPU to reach that context, live).
            </div>
            <div className="mmproj-mode-toggle" style={{ display: 'inline-flex' }}>
              <button
                type="button"
                className={`mmproj-mode-btn ${(modelDefaults.moeOffloadStrategy || 'offload') === 'offload' ? 'active' : ''}`}
                onClick={async () => {
                  const d = { ...modelDefaults, moeOffloadStrategy: 'offload' as const }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }}
              >Offload GPU Layers</button>
              <button
                type="button"
                className={`mmproj-mode-btn ${modelDefaults.moeOffloadStrategy === 'max' ? 'active' : ''}`}
                onClick={async () => {
                  const d = { ...modelDefaults, moeOffloadStrategy: 'max' as const }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }}
              >MAX GPU Layers and Force MoE Weights onto CPU</button>
            </div>
          </div>
        </div>
      </div>

      {/* Feature 19: Model Loading Guardrails */}
      <div className="settings-section">
        <div className="settings-section-title"><Shield /> Model Loading Guardrails</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          {[
            { mode: 'off', label: 'OFF (Not Recommended)', hint: 'No precautions against system overload' },
            { mode: 'relaxed', label: 'Relaxed', hint: 'Mild precautions against system overload' },
            { mode: 'balanced', label: 'Balanced', hint: 'Moderate precautions against system overload' },
            { mode: 'strict', label: 'Strict', hint: 'Strong precautions against system overload' },
            { mode: 'custom', label: 'Custom', hint: 'Set your own limit for maximum model size that can be loaded' }
          ].map(opt => (
            <label key={opt.mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', width: '100%' }}>
              <input type="radio" name="guardrail" value={opt.mode} checked={modelDefaults.guardrailMode === opt.mode}
                onChange={async (e) => {
                  const d = { ...modelDefaults, guardrailMode: e.target.value }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opt.hint}</div>
              </div>
            </label>
          ))}
          {modelDefaults.guardrailMode === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 12 }}>Max model size (GB):</span>
              <input type="number" className="form-input" style={{ width: 100 }} min={0} step={0.5} value={modelDefaults.customMaxSizeGB}
                onChange={async (e) => {
                  const d = { ...modelDefaults, customMaxSizeGB: Number(e.target.value) }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
            </div>
          )}
          {vramInfo && systemRam && (() => {
            // Vendor-aware label — no longer hardcodes "NVIDIA GPU" when an AMD /
            // Intel / unknown GPU is present (fix for RX 9070 XT being reported as
            // "NVIDIA GPU (0 MB VRAM)").
            const gpuLabel = vramInfo.gpuName
              || (vramInfo.vendor ? `${vramInfo.vendor} GPU` : 'GPU not detected')
            const vram = vramInfo.totalVRAMMB || 0
            const ram = systemRam.totalRAMMB || 0
            const total = vram + ram
            return (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Detected: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{gpuLabel}</span>
                {vram > 0 ? ` (${vram.toLocaleString()} MB VRAM)` : ' (VRAM unavailable)'}
                {' · '}{ram.toLocaleString()} MB system RAM
                {' · Total: '}<span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{total.toLocaleString()} MB</span>
                {' (VRAM + RAM)'}
              </div>
            )
          })()}
        </div>
      </div>

    </div>
  )
}

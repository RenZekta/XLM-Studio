import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useStore } from '../store/useStore'
import {
  Activity, ChevronDown, Download, Upload, Maximize2, X, GitCompare
} from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend
} from 'recharts'

// Item 4: Monitoring tab. Tracks generation speed and prefill (prompt-
// processing) speed for every running template by polling llama-server's
// own /metrics endpoint from the main process (see src/main/perfMonitor.ts
// for the full rationale — Chat UI opens in an external browser, so the app
// has no other way to see individual requests). This component is the
// live/historical viewer + export/import/comparison UI on top of that data.

interface GenPoint { ts: number; contextTokens: number; genTps: number }
interface PrefillPoint { ts: number; promptSize: number; promptTps: number; cached: boolean }
interface SessionData {
  id: string
  templateId: string
  templateNameSnapshot: string
  startedAt: number
  endedAt: number | null
  genPoints: GenPoint[]
  prefillPoints: PrefillPoint[]
}
interface ActiveSessionSummary { sessionId: string; templateId: string; templateName: string; startedAt: number }
interface HistorySessionSummary { id: string; templateId: string; templateNameSnapshot: string; startedAt: number; endedAt: number | null }

// A "selection key" uniquely identifies either a live active session (by
// templateId, since that's what the backend keys live polling on) or an
// archived history session (by its persisted session id).
type SelKey = { kind: 'active'; templateId: string } | { kind: 'history'; sessionId: string }
function keyId(k: SelKey) { return k.kind === 'active' ? `active:${k.templateId}` : `history:${k.sessionId}` }

// Distinct colors for comparing multiple sessions at once — chosen to be
// visually separable at a glance, cycling if there are more sessions than colors.
const SERIES_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16']

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString()
}
function fmtDuration(startedAt: number, endedAt: number | null) {
  const end = endedAt ?? Date.now()
  const s = Math.max(0, Math.round((end - startedAt) / 1000))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

export default function MonitoringView() {
  const { modelDefaults, setModelDefaults } = useStore()

  const [activeSessions, setActiveSessions] = useState<ActiveSessionSummary[]>([])
  const [history, setHistory] = useState<HistorySessionSummary[]>([])
  const [selected, setSelected] = useState<SelKey[]>([])
  const [compareMode, setCompareMode] = useState(false)
  const [activeDropdownOpen, setActiveDropdownOpen] = useState(false)
  const [historyDropdownOpen, setHistoryDropdownOpen] = useState(false)
  const [dataCache, setDataCache] = useState<Record<string, SessionData>>({})
  const [fullscreenChart, setFullscreenChart] = useState<'ts' | 'prefill' | null>(null)
  const [maxSessionsDraft, setMaxSessionsDraft] = useState<string | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const hasAutoSelectedRef = useRef(false)

  const refreshActive = useCallback(async () => {
    const list = await window.api?.perfGetActiveSessions?.() || []
    setActiveSessions(list)
    return list
  }, [])
  const refreshHistory = useCallback(async () => {
    const list = await window.api?.perfGetSessionHistory?.() || []
    setHistory(list)
    return list
  }, [])

  const loadSessionData = useCallback(async (k: SelKey) => {
    const id = keyId(k)
    let data: SessionData | null = null
    if (k.kind === 'active') data = await window.api?.perfGetActiveSessionData?.(k.templateId)
    else data = await window.api?.perfGetSessionData?.(k.sessionId)
    if (data) setDataCache(prev => ({ ...prev, [id]: data as SessionData }))
  }, [])

  // Initial load + auto-select behavior:
  //  - Active sessions: "Auto-switches to the last opened session."
  //  - Session History: "Upon opening the first time... show saved data from
  //    the last session if there is one, otherwise say 'No session data
  //    recorded yet.'" — only used as a fallback when nothing is running.
  useEffect(() => {
    (async () => {
      const [act, hist] = await Promise.all([refreshActive(), refreshHistory()])
      if (!hasAutoSelectedRef.current) {
        hasAutoSelectedRef.current = true
        if (act.length > 0) {
          const latest = [...act].sort((a, b) => b.startedAt - a.startedAt)[0]
          const k: SelKey = { kind: 'active', templateId: latest.templateId }
          setSelected([k])
          loadSessionData(k)
        } else if (hist.length > 0) {
          const latest = [...hist].sort((a, b) => b.startedAt - a.startedAt)[0]
          const k: SelKey = { kind: 'history', sessionId: latest.id }
          setSelected([k])
          loadSessionData(k)
        }
      }
    })()
  }, [refreshActive, refreshHistory, loadSessionData])

  // Live updates: new data points streamed in for whichever active
  // session(s) are currently selected.
  useEffect(() => {
    window.api?.onPerfDataPoint?.(({ templateId, type, point }) => {
      const id = keyId({ kind: 'active', templateId })
      setDataCache(prev => {
        const existing = prev[id]
        if (!existing) return prev  // not currently viewing this session
        const updated: SessionData = { ...existing }
        if (type === 'gen') updated.genPoints = [...existing.genPoints, point]
        else updated.prefillPoints = [...existing.prefillPoints, point]
        return { ...prev, [id]: updated }
      })
    })
    window.api?.onPerfSessionStarted?.(async ({ templateId }) => {
      const list = await refreshActive()
      // "Auto-switches to the last opened session" — a NEW session starting
      // is, by definition, the most recently opened one.
      const k: SelKey = { kind: 'active', templateId }
      setSelected(compareMode ? (prev => [...prev]) as any : [k])
      if (!compareMode) loadSessionData(k)
      void list
    })
    window.api?.onPerfSessionEnded?.(async () => {
      await refreshActive()
      await refreshHistory()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode, refreshActive, refreshHistory, loadSessionData])

  function toggleSelect(k: SelKey) {
    const id = keyId(k)
    if (compareMode) {
      setSelected(prev => {
        const exists = prev.some(s => keyId(s) === id)
        const next = exists ? prev.filter(s => keyId(s) !== id) : [...prev, k]
        return next
      })
      if (!dataCache[id]) loadSessionData(k)
    } else {
      setSelected([k])
      loadSessionData(k)
      setActiveDropdownOpen(false)
      setHistoryDropdownOpen(false)
    }
  }

  const selectedSessions = useMemo(() => {
    return selected
      .map(k => ({ key: k, data: dataCache[keyId(k)] }))
      .filter(s => !!s.data) as { key: SelKey; data: SessionData }[]
  }, [selected, dataCache])

  async function handleExport(k: SelKey) {
    if (k.kind === 'active') {
      // Active sessions export via their live data (already the freshest
      // copy); the backend export handler works off persisted session ids,
      // so for an in-progress session we ask the user to stop it first —
      // simplest correct behavior without a separate "export in-flight" path.
      const id = keyId(k)
      const data = dataCache[id]
      if (!data) return
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(data.templateNameSnapshot || 'session').replace(/[^\w.-]+/g, '_')}-${new Date(data.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`
      a.click()
      URL.revokeObjectURL(url)
      return
    }
    await window.api?.perfExportSession?.(k.sessionId)
  }
  async function handleExportAllActive() {
    await window.api?.perfExportAllActive?.()
  }
  async function handleImport() {
    setImportBusy(true)
    try {
      const res = await window.api?.perfImportSession?.()
      if (res?.success) await refreshHistory()
    } finally {
      setImportBusy(false)
    }
  }

  const noDataAtAll = activeSessions.length === 0 && history.length === 0

  return (
    <div className="max-w-6xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Monitoring</h1>
          <p className="page-subtitle">Real-time and historical performance for your running and past sessions.</p>
        </div>
      </div>

      {/* ----- Controls row: Active Sessions / Session History / Compare / Export-Import ----- */}
      <div className="settings-section">
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', width: '100%' }}>
            {/* Active Sessions dropdown */}
            <div style={{ position: 'relative' }}>
              <button className="btn btn-secondary" onClick={() => { setActiveDropdownOpen(v => !v); setHistoryDropdownOpen(false) }}>
                <Activity size={14} /> Active Sessions ({activeSessions.length}) <ChevronDown size={13} />
              </button>
              {activeDropdownOpen && (
                <div className="dropdown-panel" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50, minWidth: 260, maxHeight: 280, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)' }}>
                  {activeSessions.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No models are currently running.</div>}
                  {activeSessions.map(s => {
                    const k: SelKey = { kind: 'active', templateId: s.templateId }
                    const isSel = selected.some(x => keyId(x) === keyId(k))
                    return (
                      <div key={s.templateId} onClick={() => toggleSelect(k)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: isSel ? 'var(--surface-2, rgba(59,130,246,.1))' : undefined }}>
                        {compareMode && <input type="checkbox" checked={isSel} readOnly />}
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }} />
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.templateName}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Running {fmtDuration(s.startedAt, null)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Session History dropdown */}
            <div style={{ position: 'relative' }}>
              <button className="btn btn-secondary" onClick={() => { setHistoryDropdownOpen(v => !v); setActiveDropdownOpen(false) }}>
                <ChevronDown size={13} style={{ marginRight: 2 }} /> Session History ({history.length})
              </button>
              {historyDropdownOpen && (
                <div className="dropdown-panel" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 50, minWidth: 280, maxHeight: 320, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-md)' }}>
                  {history.length === 0 && <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)' }}>No session data recorded yet.</div>}
                  {history.map(s => {
                    const k: SelKey = { kind: 'history', sessionId: s.id }
                    const isSel = selected.some(x => keyId(x) === keyId(k))
                    return (
                      <div key={s.id} onClick={() => toggleSelect(k)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer', background: isSel ? 'var(--surface-2, rgba(59,130,246,.1))' : undefined }}>
                        {compareMode && <input type="checkbox" checked={isSel} readOnly />}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.templateNameSnapshot}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtTime(s.startedAt)} · {fmtDuration(s.startedAt, s.endedAt)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Compare toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: 4 }}>
              <input type="checkbox" checked={compareMode} onChange={(e) => {
                setCompareMode(e.target.checked)
                if (!e.target.checked && selected.length > 1) setSelected(selected.slice(0, 1))
              }} />
              <GitCompare size={13} /> Compare multiple sessions
            </label>

            <div style={{ flex: 1 }} />

            {/* Export / Import / Export all */}
            {/* Bug fix (item 4): kept the icons in the same positions, but
                swapped what they DO — a down-arrow ("Download") reads as
                "bring something INTO the app" (import), and an up-arrow
                ("Upload") reads as "send something OUT" (export), which is
                the opposite of what they used to do. */}
            <button className="btn btn-ghost btn-icon" title="Import a session" disabled={importBusy} onClick={handleImport}>
              <Download size={14} />
            </button>
            <button className="btn btn-ghost btn-icon" title="Export selected session" disabled={selected.length !== 1} onClick={() => selected[0] && handleExport(selected[0])}>
              <Upload size={14} />
            </button>
            <button className="btn btn-secondary" title="Export all active sessions" disabled={activeSessions.length === 0} onClick={handleExportAllActive}>
              Export all
            </button>
          </div>

          {/* Save last X sessions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
            Save last
            <input
              type="text"
              inputMode="numeric"
              className="form-input"
              style={{ width: 60, textAlign: 'center' }}
              value={maxSessionsDraft ?? String(modelDefaults.perfMaxSessions ?? 20)}
              onChange={(e) => setMaxSessionsDraft(e.target.value.replace(/[^\d]/g, ''))}
              onBlur={async () => {
                const n = parseInt(maxSessionsDraft ?? '', 10)
                if (!isNaN(n) && n >= 1) {
                  const d = { ...modelDefaults, perfMaxSessions: Math.min(500, n) }
                  setModelDefaults(d)
                  try { await window.api?.setModelDefaults?.(d) } catch {}
                  try { await window.api?.perfSetMaxSessions?.(d.perfMaxSessions!) } catch {}
                  await refreshHistory()
                }
                setMaxSessionsDraft(null)
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
            />
            sessions in Session History — oldest are deleted automatically once this is exceeded.
          </div>

          {compareMode && selectedSessions.length > 0 && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {selectedSessions.map((s, i) => (
                <div key={keyId(s.key)} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                  {s.data.templateNameSnapshot}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {noDataAtAll ? (
        <div className="settings-section">
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No session data recorded yet. Run a model to start tracking performance.
          </div>
        </div>
      ) : selectedSessions.length === 0 ? (
        <div className="settings-section">
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            Select an active session or a session from history above to view its performance.
          </div>
        </div>
      ) : (
        <>
          <TsChart sessions={selectedSessions} onFullscreen={() => setFullscreenChart('ts')} />
          <PrefillChart sessions={selectedSessions} onFullscreen={() => setFullscreenChart('prefill')} />
        </>
      )}

      {fullscreenChart && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 1000, display: 'flex', flexDirection: 'column', padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12, flexShrink: 0 }}>
            <button className="btn btn-ghost btn-icon" onClick={() => setFullscreenChart(null)}><X size={18} /></button>
          </div>
          {/* Bug fix (item 2): the old fullscreen container relied on a chain
              of height:'100%' divs to reach the chart's ResponsiveContainer —
              but ResponsiveContainer needs every ancestor in that chain to
              have a DEFINITE (non-percentage) height for percentages to
              resolve at all, and .settings-section (TsChart/PrefillChart's
              own root wrapper) doesn't set one, breaking the chain silently
              (no error, just a 0-height chart — "shows the block but not the
              chart"). Pass a concrete pixel height down explicitly instead,
              computed from the viewport, sidestepping the whole chain. */}
          <div style={{ flex: 1, minHeight: 0 }}>
            {fullscreenChart === 'ts'
              ? <TsChart sessions={selectedSessions} fullscreen heightPx={window.innerHeight - 140} />
              : <PrefillChart sessions={selectedSessions} fullscreen heightPx={window.innerHeight - 140} />}
          </div>
        </div>
      )}
    </div>
  )
}

// Shared custom tooltip so the T/s and Prefill charts can clearly label
// which session (and, for prefill, whether the point is a cold or cached/
// warm burst — item 3) a hovered point belongs to, instead of relying on
// color/shape alone.
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null
  const p = payload[0]?.payload
  if (!p) return null
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{p.__seriesLabel}</div>
      {p.contextTokens !== undefined && <div>Context: {p.contextTokens.toLocaleString()} tok</div>}
      {p.genTps !== undefined && <div>Speed: {p.genTps} t/s</div>}
      {p.promptSize !== undefined && <div>Prompt size: {p.promptSize.toLocaleString()} tok</div>}
      {p.promptTps !== undefined && <div>Throughput: {p.promptTps} t/s</div>}
      {p.cached !== undefined && <div style={{ color: p.cached ? '#10b981' : '#f59e0b', fontWeight: 600 }}>{p.cached ? 'Cached (warm)' : 'Cold'}</div>}
    </div>
  )
}

// ----- T/s chart: X = context size (tokens), Y = generation speed (t/s) -----
function TsChart({ sessions, onFullscreen, fullscreen, heightPx }: { sessions: { key: SelKey; data: SessionData }[]; onFullscreen?: () => void; fullscreen?: boolean; heightPx?: number }) {
  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Generation Speed vs Context Size</span>
        {!fullscreen && onFullscreen && (
          <button className="btn btn-ghost btn-icon" title="Fullscreen" onClick={onFullscreen}><Maximize2 size={14} /></button>
        )}
      </div>
      <div style={{ width: '100%', height: heightPx ?? 320 }}>
        <ResponsiveContainer>
          {/* Bug fix (item 1): switched from ScatterChart (unconnected dots)
              to ComposedChart + <Line>, which connects points of the same
              session with a line in that session's color (in the order they
              were recorded — i.e. over time as the session progressed),
              while still showing a dot at each actual data point. */}
          <ComposedChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" dataKey="contextTokens" name="Context size" unit=" tok" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
            <YAxis type="number" dataKey="genTps" name="Generation speed" unit=" t/s" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            {sessions.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {sessions.map((s, i) => {
              const color = SERIES_COLORS[i % SERIES_COLORS.length]
              const data = s.data.genPoints.map(p => ({ ...p, __seriesLabel: s.data.templateNameSnapshot }))
              return (
                <Line
                  key={keyId(s.key)}
                  type="monotone"
                  name={s.data.templateNameSnapshot}
                  data={data}
                  dataKey="genTps"
                  stroke={color}
                  strokeWidth={2}
                  dot={{ r: 3, fill: color, strokeWidth: 0 }}
                  activeDot={{ r: 5 }}
                  connectNulls
                  isAnimationActive={false}
                />
              )
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {sessions.every(s => s.data.genPoints.length === 0) && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
          No generation activity recorded yet for the selected session(s) — send a message via the model's chat UI to see data here.
        </div>
      )}
    </div>
  )
}

// ----- Prefill chart: X = prompt size (log scale), Y = throughput (t/s), split cold/warm -----
function PrefillChart({ sessions, onFullscreen, fullscreen, heightPx }: { sessions: { key: SelKey; data: SessionData }[]; onFullscreen?: () => void; fullscreen?: boolean; heightPx?: number }) {
  return (
    <div className="settings-section">
      <div className="settings-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Prefill Speed vs Prompt Size</span>
        {!fullscreen && onFullscreen && (
          <button className="btn btn-ghost btn-icon" title="Fullscreen" onClick={onFullscreen}><Maximize2 size={14} /></button>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        "Cached (warm)" is a heuristic — llama-server doesn't report cache hits directly, so bursts far faster than this session's own typical cold-prefill speed are inferred as cache hits.
        {/* Item 3: legend explaining the line-style distinction, since color
            alone (same per session) no longer differs between cold/warm. */}
        {' '}Solid line = cold, dashed line = cached (warm) — hover any point for the exact value.
      </div>
      <div style={{ width: '100%', height: heightPx ?? 320 }}>
        <ResponsiveContainer>
          <ComposedChart margin={{ top: 10, right: 20, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis type="number" dataKey="promptSize" name="Prompt size" unit=" tok" scale="log" domain={['auto', 'auto']} stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
            <YAxis type="number" dataKey="promptTps" name="Throughput" unit=" t/s" stroke="var(--text-muted)" tick={{ fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {sessions.map((s, i) => {
              const base = SERIES_COLORS[i % SERIES_COLORS.length]
              // Bug fix (item 3): previously both cold/warm points used the
              // SAME color (just different opacity/shape), and the tooltip
              // never actually said which was which — indistinguishable at a
              // glance and on hover. Now cold is a SOLID line in the
              // session's color, warm is a DASHED line in the same color
              // (so you can still tell which SESSION it belongs to), and the
              // shared ChartTooltip explicitly labels "Cold" vs "Cached (warm)".
              const cold = s.data.prefillPoints.filter(p => !p.cached).map(p => ({ ...p, __seriesLabel: `${s.data.templateNameSnapshot} — cold` }))
              const warm = s.data.prefillPoints.filter(p => p.cached).map(p => ({ ...p, __seriesLabel: `${s.data.templateNameSnapshot} — warm` }))
              return (
                <React.Fragment key={keyId(s.key)}>
                  <Line
                    type="monotone" name={`${s.data.templateNameSnapshot} — cold`} data={cold} dataKey="promptTps"
                    stroke={base} strokeWidth={2} dot={{ r: 3, fill: base, strokeWidth: 0 }} activeDot={{ r: 5 }}
                    connectNulls isAnimationActive={false}
                  />
                  <Line
                    type="monotone" name={`${s.data.templateNameSnapshot} — warm`} data={warm} dataKey="promptTps"
                    stroke={base} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: base, strokeWidth: 1, stroke: 'var(--surface)' }} activeDot={{ r: 5 }}
                    connectNulls isAnimationActive={false}
                  />
                </React.Fragment>
              )
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {sessions.every(s => s.data.prefillPoints.length === 0) && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', marginTop: 8 }}>
          No prompt-processing activity recorded yet for the selected session(s).
        </div>
      )}
    </div>
  )
}

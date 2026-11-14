import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Plug, Download, Hammer, RefreshCw, Loader2, AlertCircle, Link2, Folder, Check, ExternalLink, Trash, Terminal } from 'lucide-react'
import { useStore } from '../store/useStore'
import { buildLogId } from '../../../shared/sourceBuild'
import { HARNESSES, HARNESS_ORDER, type HarnessId, type HarnessSettings, type HarnessState, type HarnessStatus } from '../../../shared/harnesses'

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="toggle-track"></span><span className="toggle-thumb"></span>
    </label>
  )
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return `${Math.floor(s / 3600)} h ago`
}

export default function HarnessManagerSection() {
  const { setView, setLogsSource } = useStore()
  const [state, setState] = useState<HarnessState | null>(null)
  const [checking, setChecking] = useState(false)
  const [updatingAll, setUpdatingAll] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<HarnessId, string>>>({})
  // Text fields apply when they lose focus, so typing doesn't write on every key.
  const [pithUrl, setPithUrl] = useState('')
  const [pithDir, setPithDir] = useState('')
  const [pithWork, setPithWork] = useState('')
  const [pithPassword, setPithPassword] = useState('')

  // Only the newest answer counts, so a slow older one can't undo a newer state.
  const seq = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const next = await window.api.getHarnessState()
      if (mine === seq.current) setState(next)
    } catch { /* main process not ready */ }
  }, [])

  useEffect(() => {
    void refresh()
    window.api.onHarnessesChanged(() => { void refresh() })
    return () => window.api.removeHarnessesChangedListener()
  }, [refresh])

  const settings = state?.settings
  useEffect(() => {
    if (!settings) return
    setPithUrl(settings.pithagorasUrl)
    setPithDir(settings.pithagorasDir)
    setPithWork(settings.pithagorasWorkspacesDir)
    setPithPassword(settings.pithagorasPassword)
  }, [settings?.pithagorasUrl, settings?.pithagorasDir, settings?.pithagorasPassword, settings?.pithagorasWorkspacesDir])

  if (!state || !settings) {
    // The first look for harnesses can take a moment; the section shows at once.
    return (
      <div className="settings-section">
        <div className="settings-section-title"><Plug /> Harness Manager</div>
        <div className="settings-row-sub"><Loader2 size={13} className="spin" style={{ display: 'inline', marginRight: 6 }} />Looking for harnesses...</div>
      </div>
    )
  }

  async function patch(p: Partial<HarnessSettings>) {
    // The switch moves at once; the files are written in the background and
    // the next state from the main process settles anything that differs.
    setState(prev => prev && ({
      ...prev,
      settings: { ...prev.settings, ...p },
      statuses: p.syncOn ? prev.statuses.map(st => ({ ...st, syncOn: p.syncOn!.includes(st.id) })) : prev.statuses
    }))
    await window.api.setHarnessSettings(p)
  }

  async function check() {
    setChecking(true)
    try { setState(await window.api.checkHarnessUpdates()) } finally { setChecking(false) }
  }

  async function change(id: HarnessId, kind: 'install' | 'update' | 'remove' | 'rebuild') {
    if (kind === 'remove' && !window.confirm(`Remove ${HARNESSES[id].label}? ${id === 'pithagoras' ? 'Its container is stopped and removed; the clone and its data stay.' : 'Its settings and data stay.'}`)) return
    setErrors(e => ({ ...e, [id]: undefined }))
    const call = kind === 'install' ? window.api.installHarness : kind === 'update' ? window.api.updateHarness : kind === 'rebuild' ? window.api.rebuildHarness : window.api.removeHarness
    const res = await call(id)
    if (!res.success) setErrors(e => ({ ...e, [id]: res.error || 'Failed.' }))
    await refresh()
  }

  async function updateAll() {
    setUpdatingAll(true)
    try { setState(await window.api.updateAllHarnesses()) } finally { setUpdatingAll(false) }
  }

  function toggleHarness(id: HarnessId, on: boolean) {
    const next = new Set(settings!.syncOn)
    if (on) next.add(id); else next.delete(id)
    void patch({ syncOn: [...next] })
  }

  const installed = state.statuses.filter(s => s.installed)
  const anyUpdate = installed.some(s => s.updateAvailable && s.canUpdate)
  const allOn = HARNESS_ORDER.every(id => settings.syncOn.includes(id))
  const providerLine = state.providers.length
    ? state.providers.map(p => `${p.label} (${p.models})`).join(', ')
    : 'No Templates to add yet.'

  function renderCard(s: HarnessStatus) {
    const def = HARNESSES[s.id]
    const err = errors[s.id]
    const syncErr = s.sync?.error
    return (
      <div key={s.id} className="tracker-card">
        <div className="tracker-card-header">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="tracker-name">
              {def.label}
              {s.source && <span className="tracker-default-tag">{s.source}</span>}
            </div>
            <div className="tracker-repo">
              <Link2 size={11} style={{ display: 'inline', marginRight: 4 }} />
              {def.url.replace('https://', '')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>
            {s.busy && (
              <span className="tracker-release" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={13} className="spin" />
                {s.busy === 'install' ? 'Installing...' : s.busy === 'update' ? 'Updating...' : s.busy === 'rebuild' ? 'Building...' : 'Removing...'}
              </span>
            )}
            {(s.hasLog || s.busy) && (
              <button className="btn btn-ghost btn-icon" onClick={() => { setLogsSource(buildLogId(s.id, 'harness')); setView('logs') }} title="Show the output in the Logs tab">
                <Terminal size={14} />
              </button>
            )}
            <button className="btn btn-ghost btn-icon" onClick={() => window.api.openExternal(def.url)} title="Open on GitHub">
              <ExternalLink size={14} />
            </button>
            {s.installed && (
              <button className="btn btn-ghost btn-icon" onClick={() => window.api.openHarnessConfig(s.id)} title="Open the config folder">
                <Folder size={14} />
              </button>
            )}
            {!s.installed && !s.busy && (
              <button className="btn btn-primary btn-sm" disabled={updatingAll} onClick={() => change(s.id, 'install')}>
                <Download size={13} /> Install
              </button>
            )}
            {s.canRebuild && !s.busy && (
              <button className={`btn btn-sm ${s.source?.includes('container') ? 'btn-secondary' : 'btn-primary'}`} disabled={updatingAll} onClick={() => change(s.id, 'rebuild')}
                title="Build the image from the clone and start the container">
                <Hammer size={13} /> {s.source?.includes('container') ? 'Rebuild' : 'Build'}
              </button>
            )}
            {s.installed && s.updateAvailable && s.canUpdate && !s.busy && (
              <button className="btn btn-primary btn-sm" disabled={updatingAll} onClick={() => change(s.id, 'update')}>
                <Download size={13} /> Update
              </button>
            )}
            {s.installed && !s.busy && (
              <button className="btn btn-ghost btn-icon text-danger" onClick={() => change(s.id, 'remove')} title="Remove">
                <Trash size={14} />
              </button>
            )}
          </div>
        </div>

        {!s.installed ? (
          <div className="tracker-release">Not detected.</div>
        ) : (
          <>
            <div className="tracker-release">
              {s.version ? `Version ${s.version}` : 'Version unknown'}
              {s.updateAvailable
                ? <span className="new-badge">Update available{s.latest ? `: ${s.latest}` : ''}</span>
                : s.latest && s.version ? <span className="up-to-date"><Check size={12} style={{ display: 'inline', marginRight: 3 }} />Up to date</span> : null}
            </div>
            {(s.configFiles.length > 0 || s.api) && (
              <div className="tracker-release" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, wordBreak: 'break-all' }}>
                {s.api ?? s.configFiles.join('\n')}
              </div>
            )}
            <div className="mmproj-widget-row" style={{ width: '100%', marginTop: 10 }}>
              <span className="mmproj-widget-label">Add the XLM Studio provider</span>
              <Toggle checked={s.syncOn} onChange={on => toggleHarness(s.id, on)} />
            </div>
            {s.syncOn && s.sync && !syncErr && (
              <div className="tracker-release">Provider written {ago(s.sync.at)}.{s.mcp ? ' MCP server added.' : ''}{s.id === 'goose' ? ' Restart Goose to load it.' : ''}</div>
            )}
            {s.syncOn && s.mcp === false && (
              <div className="tracker-release">The MCP server is not added: it is off or serves as a skill (Settings, MCP Server).</div>
            )}
          </>
        )}

        {s.note && <div className="tracker-release"><AlertCircle size={12} style={{ display: 'inline', marginRight: 5 }} />{s.note}</div>}
        {syncErr && <div className="tracker-release" style={{ color: 'var(--danger, #d33)' }}><AlertCircle size={12} style={{ display: 'inline', marginRight: 5 }} />{syncErr}</div>}
        {err && <div className="tracker-release" style={{ color: 'var(--danger, #d33)' }}><AlertCircle size={12} style={{ display: 'inline', marginRight: 5 }} />{err}</div>}

        {s.id === 'pithagoras' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
            <input className="form-input" type="text" placeholder="Portal address (default http://localhost:4100)" value={pithUrl}
              onChange={e => setPithUrl(e.target.value)} onBlur={() => { if (pithUrl !== settings!.pithagorasUrl) void patch({ pithagorasUrl: pithUrl }) }} />
            <input className="form-input" type="password" placeholder="Portal password (made on install; needed to write the provider)" value={pithPassword}
              onChange={e => setPithPassword(e.target.value)} onBlur={() => { if (pithPassword !== settings!.pithagorasPassword) void patch({ pithagorasPassword: pithPassword }) }} />
            <input className="form-input" type="text" placeholder="Workspaces folder: the repositories it may edit (optional, used on the next build)" value={pithWork}
              onChange={e => setPithWork(e.target.value)} onBlur={() => { if (pithWork !== settings!.pithagorasWorkspacesDir) void patch({ pithagorasWorkspacesDir: pithWork }) }} />
            <input className="form-input" type="text" placeholder="Folder of the git clone (found from the container when empty)" value={pithDir}
              onChange={e => setPithDir(e.target.value)} onBlur={() => { if (pithDir !== settings!.pithagorasDir) void patch({ pithagorasDir: pithDir }) }} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Plug /> Harness Manager</div>

      <div className="settings-row">
        <div>
          <div className="settings-row-label">Add XLM Studio Templates as a provider</div>
          <div className="settings-row-sub">
            Each harness below has its own switch. A switched-on harness gets every Template with its name, context window and vision support, and stays in step when Templates change. A Template runs under its own name, so that name is the model id. Templates that follow the Base URL Override share one provider; any other port gets its own. Only entries named xlm-studio are touched, and the first change to a file keeps a copy as <code>.xlm-studio.bak</code>.
          </div>
        </div>
        <button className="btn btn-secondary btn-sm" style={{ flexShrink: 0 }} disabled={allOn} onClick={() => patch({ syncOn: [...HARNESS_ORDER] })}>
          <Plug size={13} /> {allOn ? 'On for all' : 'Turn on for all'}
        </button>
      </div>

      {settings.syncOn.length > 0 && (
        <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          <div className="settings-row-sub">Providers: {providerLine}</div>
          {state.skipped.length > 0 && (
            <div className="settings-row-sub">
              <AlertCircle size={12} style={{ display: 'inline', marginRight: 5 }} />
              Left out (duplicate or missing name): {state.skipped.map(k => k.name || '(unnamed)').join(', ')}
            </div>
          )}
        </div>
      )}

      <div className="settings-row">
        <div>
          <div className="settings-row-label">Update harnesses automatically</div>
          <div className="settings-row-sub">
            After the check at startup, updates every detected harness that has a newer version. Off by default. DSH is skipped while <code>dsh web</code> runs.
          </div>
        </div>
        <div className="toggle-wrap">
          <Toggle checked={settings.autoUpdate} onChange={on => patch({ autoUpdate: on })} />
        </div>
      </div>

      <div className="settings-section-title" style={{ marginTop: 18 }}>Harness Tracker</div>
      <div style={{ marginTop: 8 }}>
        {state.statuses.map(renderCard)}
      </div>

      <div className="mt-4 pt-4 border-t flex flex-col gap-2">
        <button className="btn btn-secondary w-full justify-center" onClick={check} disabled={checking}>
          <RefreshCw size={14} className={checking ? 'spin' : ''} />
          {checking ? 'Checking harnesses...' : 'Check for updates (all harnesses)'}
        </button>
        {anyUpdate && (
          <button className="btn btn-primary w-full justify-center" onClick={updateAll} disabled={updatingAll}>
            {updatingAll ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            Update all
          </button>
        )}
      </div>
    </div>
  )
}

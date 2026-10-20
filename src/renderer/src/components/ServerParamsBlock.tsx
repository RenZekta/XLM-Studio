import React, { useEffect, useState } from 'react'
import { ChevronDown, Server } from 'lucide-react'
import type { ServerOverrides } from '../utils/templatePort'

// The --port / --host / --api-key parameters of a Template, shared by the
// llama.cpp and Strata editors. The port lives on the Template (serverPort),
// host and API key in its args; the New/Edit Template form's Server Port field
// edits the same value, so the two always mirror. A global Base URL Override
// is only reported here: the Template keeps its own value for when the
// override is off.

export const LOCAL_ONLY_HOST = '127.0.0.1'
export const NETWORK_HOST = '0.0.0.0'

interface Props {
  port: number
  host: string
  apiKey: string
  overrides: ServerOverrides
  // Name of another Template saved on the same port.
  conflict: string | null
  disabled?: boolean
  onPortChange: (port: number) => void
  onHostChange: (host: string) => void
  onApiKeyChange: (key: string) => void
}

const noteStyle: React.CSSProperties = { fontSize: 11, color: 'var(--warning)', marginTop: -4, marginBottom: 10, paddingLeft: 4 }

function OverrideNote({ children }: { children: React.ReactNode }) {
  return <div style={noteStyle}>Overridden by the global Base URL Override: {children}</div>
}

export default function ServerParamsBlock({
  port, host, apiKey, overrides, conflict, disabled, onPortChange, onHostChange, onApiKeyChange
}: Props) {
  // Edited as text so the field can be empty mid-edit; the port only changes
  // once the draft is a valid number.
  const [draft, setDraft] = useState(port > 0 ? String(port) : '')
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(port > 0 ? String(port) : '') }, [port, focused])

  function handleDraft(raw: string) {
    const digits = raw.replace(/\D/g, '').slice(0, 5)
    setDraft(digits)
    const p = Number(digits)
    if (p >= 1 && p <= 65535) onPortChange(p)
  }

  // Closed like the Memory calculation block; the toggle row keeps a summary
  // so an override or a port clash stays visible.
  const [open, setOpen] = useState(false)
  const shownPort = overrides.port ?? port
  const shownHost = overrides.host ?? host
  const summary = `port ${shownPort > 0 ? shownPort : 'not set'}, ${shownHost && shownHost !== LOCAL_ONLY_HOST ? (shownHost === NETWORK_HOST ? 'local network' : shownHost) : 'this PC only'}${(overrides.apiKey ?? apiKey) ? ', API key' : ''}`
  const overridden = overrides.port !== null || overrides.host !== null || overrides.apiKey !== null
  const flagged = overridden || !!conflict

  const serving = host === NETWORK_HOST
  const dim: React.CSSProperties = disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}

  return (
    <div className="collapsible-section" style={{ marginBottom: 12 }}>
      <button type="button" className="collapsible-toggle" onClick={() => setOpen(!open)}>
        <Server size={14} />
        <span>Server</span>
        <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: flagged ? 'var(--warning)' : 'var(--text-muted)' }}>
          {summary}{overridden ? ' (overridden)' : ''}{conflict ? ' (port clash)' : ''}
        </span>
        <ChevronDown size={14} style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
      </button>
      {open && (
        <div className="collapsible-body">
          <div className="mmproj-widget-arg">--port / --host / --api-key</div>

          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">Server Port</span>
            <input
              type="text" inputMode="numeric" className="cmd-input" style={{ width: 120 }}
              value={draft} placeholder="8080" disabled={disabled}
              onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
              onChange={e => handleDraft(e.target.value)}
            />
          </div>
          {overrides.port !== null && <OverrideNote>runs on port {overrides.port}.</OverrideNote>}
          {conflict && <div style={noteStyle}>Port {port} is already used by &ldquo;{conflict}&rdquo;. They cannot run at the same time.</div>}

          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">Serve on local network</span>
            <div className="toggle-wrap">
              <label className="toggle" style={dim}>
                <input type="checkbox" checked={serving} disabled={disabled} onChange={e => onHostChange(e.target.checked ? NETWORK_HOST : '')} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">Server Host</span>
            <input
              type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }}
              value={host} placeholder={LOCAL_ONLY_HOST} disabled={disabled}
              onChange={e => onHostChange(e.target.value.trim())}
            />
          </div>
          {overrides.host !== null && <OverrideNote>host {overrides.host} (Serve on local network).</OverrideNote>}
          {!serving && !host && !overrides.host && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: -4, marginBottom: 10, paddingLeft: 4 }}>
              Listening on {LOCAL_ONLY_HOST}: this PC only. Serve on local network binds {NETWORK_HOST} (set an API key too).
            </div>
          )}

          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">API Key</span>
            <input
              type="text" className="cmd-input" style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
              value={apiKey} placeholder="none" disabled={disabled}
              onChange={e => onApiKeyChange(e.target.value)}
            />
          </div>
          {overrides.apiKey !== null && <OverrideNote>{overrides.apiKey}</OverrideNote>}
        </div>
      )}
    </div>
  )
}

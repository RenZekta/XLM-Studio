import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { Terminal, Trash, Pause, Play, Download } from 'lucide-react'

interface LogEntry {
  id: string
  name: string
  // 'stdout' / 'stderr' = raw llama-server output.
  // 'app' = app-level meta log (lifecycle / generation / chat-request / errors).
  stream: 'stdout' | 'stderr' | 'app'
  line: string
  ts: number
}

// Fix 4: Logs tab — displays a live streaming window of llama-server stdout/stderr.
// Bug fix (item 4): logs now live in the global store (populated by a listener
// registered once at App root — see App.tsx) instead of local component state,
// so they persist across tab navigation until the app closes or the user hits
// Clear. This view is now a thin read-only + pause/filter layer over that
// global log list; "Pause" just stops the local view from re-rendering on new
// entries (the store keeps collecting them in the background either way, so
// nothing is lost while paused — resuming shows everything that arrived).
export default function LogsView() {
  const { cards, logs: storeLogs, clearLogs } = useStore()
  const [paused, setPaused] = useState(false)
  // While paused, freeze the displayed list at what it was the moment Pause
  // was pressed, rather than dropping subsequently-arriving lines entirely.
  const [pausedSnapshot, setPausedSnapshot] = useState<LogEntry[] | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedModel, setSelectedModel] = useState<string>('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  const logs = paused ? (pausedSnapshot || storeLogs) : storeLogs

  function togglePaused() {
    if (!paused) setPausedSnapshot(storeLogs)
    else setPausedSnapshot(null)
    setPaused(!paused)
  }

  // Auto-scroll to bottom when new logs arrive (not while paused).
  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, paused])

  const filteredLogs = useCallback(() => {
    let result = logs
    if (selectedModel !== 'all') result = result.filter(l => l.id === selectedModel)
    if (filter.trim()) {
      const q = filter.toLowerCase()
      result = result.filter(l => l.line.toLowerCase().includes(q))
    }
    return result
  }, [logs, selectedModel, filter])

  function handleClear() { clearLogs(); setPausedSnapshot(null) }

  function handleExport() {
    const text = filteredLogs().map(l => `[${new Date(l.ts).toISOString()}] [${l.stream}] [${l.name}] ${l.line}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `xlm-studio-logs-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const runningModels = cards.filter(c => c.status === 'running')
  const displayed = filteredLogs()
  const appLogCount = logs.filter(l => l.stream === 'app').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-subtitle">
            Live server output stream · {logs.length} lines {appLogCount > 0 ? `· ${appLogCount} events ` : ''}{paused ? '· Paused' : ''}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-icon" onClick={togglePaused} title={paused ? 'Resume' : 'Pause'}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
          <button className="btn btn-ghost btn-icon" onClick={handleExport} title="Export logs" disabled={logs.length === 0}>
            <Download size={15} />
          </button>
          <button className="btn btn-ghost btn-icon text-danger" onClick={handleClear} title="Clear logs" disabled={logs.length === 0}>
            <Trash size={15} />
          </button>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <select className="cmd-select" style={{ minWidth: 180 }} value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
          <option value="all">All Models</option>
          {runningModels.map(c => (
            <option key={c.template.id} value={c.template.id}>{c.template.name}</option>
          ))}
        </select>
        <input
          className="form-input"
          style={{ flex: 1 }}
          type="text"
          placeholder="Filter logs..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
      </div>

      {/* Log window */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: 12,
          overflowY: 'auto',
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          lineHeight: 1.5,
          minHeight: 0
        }}
      >
        {displayed.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 40 }}>
            <Terminal size={28} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.5 }} />
            No logs yet. Start a model to see server output, generation events, chat messages and lifecycle info here.
          </div>
        ) : (
          displayed.map((l, i) => {
            // App-level meta logs (lifecycle / generation / chat-request / errors)
            // get a subtle highlight (left blue bar + faint blue tint) so the user
            // can spot "important" events among the raw server output. Text colors
            // still follow the requested scheme: time=white, name=blue, rest=gray.
            const isApp = l.stream === 'app'
            return (
              <div
                key={i}
                style={{
                  color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  padding: isApp ? '2px 6px 2px 8px' : '1px 0',
                  margin: isApp ? '2px 0' : 0,
                  borderRadius: isApp ? 4 : 0,
                  borderLeft: isApp ? '3px solid var(--info-blue)' : 'none',
                  background: isApp ? 'rgba(59,130,246,.06)' : 'transparent'
                }}
              >
                <span style={{ color: 'var(--text)', fontSize: 11 }}>
                  [{new Date(l.ts).toLocaleTimeString()}]
                </span>{' '}
                <span style={{ color: 'var(--info-blue)', fontSize: 11, fontWeight: 600 }}>[{l.name}]</span>{' '}
                {l.line}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

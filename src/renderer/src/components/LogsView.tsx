import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useStore } from '../store/useStore'
import { Terminal, Trash, Pause, Play, Download } from 'lucide-react'

interface LogEntry {
  id: string
  name: string
  stream: 'stdout' | 'stderr'
  line: string
  ts: number
}

// Fix 4: Logs tab — displays a live streaming window of llama-server stdout/stderr.
export default function LogsView() {
  const { cards } = useStore()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const [selectedModel, setSelectedModel] = useState<string>('all')
  const scrollRef = useRef<HTMLDivElement>(null)
  const maxLogs = 5000  // cap to prevent memory issues

  useEffect(() => {
    const onLog = (data: { id: string; name: string; stream: string; line: string; ts: number }) => {
      if (paused) return
      setLogs(prev => {
        const next = [...prev, data as LogEntry]
        if (next.length > maxLogs) return next.slice(-maxLogs)
        return next
      })
    }
    window.api?.onServerLog?.(onLog)
    return () => window.api?.removeServerLogListener?.()
  }, [paused])

  // Auto-scroll to bottom when new logs arrive.
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

  function handleClear() { setLogs([]) }

  function handleExport() {
    const text = filteredLogs().map(l => `[${new Date(l.ts).toISOString()}] [${l.stream}] ${l.line}`).join('\n')
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Logs</h1>
          <p className="page-subtitle">
            Live server output stream · {logs.length} lines {paused ? '· Paused' : ''}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-icon" onClick={() => setPaused(!paused)} title={paused ? 'Resume' : 'Pause'}>
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
            No logs yet. Start a model to see server output here.
          </div>
        ) : (
          displayed.map((l, i) => (
            <div
              key={i}
              style={{
                color: l.stream === 'stderr' ? 'var(--danger)' : 'var(--text-secondary)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                padding: '1px 0'
              }}
            >
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                [{new Date(l.ts).toLocaleTimeString()}]
              </span>{' '}
              <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>[{l.name}]</span>{' '}
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

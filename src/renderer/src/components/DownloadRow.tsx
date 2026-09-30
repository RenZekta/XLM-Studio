import React, { useState } from 'react'
import { Pause, Play, X, Loader2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { formatBytes, formatSpeed } from '../utils/format'
import type { ModelDownloadInfo } from '../store/useStore'

export default function DownloadRow({ dl }: { dl: ModelDownloadInfo }) {
  const { removeModelDownload } = useStore()
  const isQueued = dl.phase === 'queued'
  const isPaused = dl.phase === 'paused'
  const isDone = dl.phase === 'done'
  const isErr = dl.phase === 'error'
  const [pending, setPending] = useState<'pausing' | 'resuming' | null>(null)

  async function togglePause() {
    if (isPaused) {
      setPending('resuming')
      await window.api.resumeModelDownload(dl.id)
    } else {
      setPending('pausing')
      await window.api.pauseModelDownload(dl.id)
    }
    setTimeout(() => setPending(null), 1500)
  }
  async function cancel() {
    await window.api.cancelModelDownload(dl.id)
    removeModelDownload(dl.id)
  }

  const showSpeed = dl.phase === 'downloading' && !pending && dl.speed && dl.speed > 0
  const statusLabel = pending === 'pausing'
    ? 'Pausing…'
    : pending === 'resuming'
    ? 'Resuming…'
    : isQueued ? `Queued${dl.queuePosition ? ` (#${dl.queuePosition})` : ''}`
    : isPaused ? 'Paused'
    : isErr ? 'Error'
    : isDone ? 'Done'
    : showSpeed ? formatSpeed(dl.speed)
    : `${dl.percent}%`

  return (
    <div className={`models-dl-row ${isDone ? 'done' : ''} ${isErr ? 'error' : ''}`}>
      <div className="models-dl-meta">
        <span className="models-dl-name">{dl.filename}</span>
        <span className="models-dl-size">
          {isQueued ? 'Waiting for a download slot' : `${formatBytes(dl.receivedBytes)} / ${formatBytes(dl.totalBytes)}`}
        </span>
      </div>
      <div className="models-dl-bar-row">
        <div className="models-dl-bar">
          <div className="models-dl-fill" style={{ width: `${dl.percent}%`, background: isErr ? 'var(--danger)' : isDone ? 'var(--success)' : 'var(--accent)', opacity: isPaused || isQueued || pending ? 0.5 : 1, transition: 'width 0.3s ease' }} />
        </div>
        <span className="models-dl-pct" style={{ minWidth: 80, textAlign: 'right', color: isPaused || isQueued ? 'var(--text-muted)' : 'inherit' }}>
          {statusLabel}
        </span>
        {!isDone && !isErr && (
          <>
            <button className="btn btn-ghost btn-icon" onClick={togglePause} disabled={!!pending} title={isPaused ? 'Resume' : 'Pause'}>
              {pending ? <Loader2 size={13} className="spin" /> : isPaused ? <Play size={13} /> : <Pause size={13} />}
            </button>
            <button className="btn btn-ghost btn-icon text-danger" onClick={cancel} title="Cancel">
              <X size={13} />
            </button>
          </>
        )}
        {(isDone || isErr) && (
          <button className="btn btn-ghost btn-icon" onClick={() => removeModelDownload(dl.id)} title="Dismiss">
            <X size={13} />
          </button>
        )}
      </div>
      {isErr && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>{dl.error || 'Download failed'}</div>}
      {isDone && <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 2 }}>✓ Saved to {dl.destPath}</div>}
    </div>
  )
}

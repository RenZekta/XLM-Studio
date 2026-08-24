import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store/useStore'
import {
  HardDrive, Download, Trash, Pause, Play, X, Link, FolderOpen,
  Pencil, Check, AlertCircle, Loader2, RefreshCw, Search, FilePlus,
  ChevronRight, Eye, Layers, Zap
} from 'lucide-react'
import { formatBytes, formatSpeed } from '../utils/format'
import type { ModelGroup } from '../../../shared/types'

function UrlDownloadModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [hfFiles, setHfFiles] = useState<{ name: string; size: number; downloadUrl: string }[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  function parseHfRepoId(url: string): string | null {
    const m = url.match(/huggingface\.co\/([^/]+\/[^/]+?)(?:\/|$)/)
    return m ? m[1] : null
  }
  function isDirectGguf(url: string) {
    return url.toLowerCase().includes('.gguf') || url.toLowerCase().includes('.ggml') || url.toLowerCase().includes('.bin')
  }
  async function handleAnalyze() {
    setError(''); setHfFiles([]); setLoading(true)
    try {
      if (isDirectGguf(url)) {
        const filename = url.split('/').pop()?.split('?')[0] || 'model.gguf'
        const folder = url.includes('huggingface.co') ? (parseHfRepoId(url)?.split('/').pop() || 'downloads') : 'downloads'
        await window.api.startModelDownload({ url, filename, modelFolder: folder })
        onClose()
      } else {
        const repoId = parseHfRepoId(url)
        if (!repoId) throw new Error('Unrecognized URL. Paste a direct .gguf link or a HuggingFace model page URL.')
        const res = await window.api.hfGetFiles(repoId)
        if ('error' in res) throw new Error((res as any).error)
        setHfFiles(res as any)
      }
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }
  async function handleDownloadFile(file: { name: string; downloadUrl: string }) {
    const repoId = parseHfRepoId(url) || 'downloads'
    await window.api.startModelDownload({ url: file.downloadUrl, filename: file.name, repoId, modelFolder: repoId.split('/').pop() })
    onClose()
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Download by URL</h2>
        </div>
        <div className="modal-body">
          <p className="form-hint" style={{ marginBottom: 12 }}>
            Paste a direct <strong>.gguf</strong> URL, or a HuggingFace model page link.<br />
            Example: <code>https://huggingface.co/TheBloke/Llama-2-7B-GGUF</code>
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="form-input" style={{ flex: 1 }} type="url" placeholder="https://..." value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAnalyze()} autoFocus />
            <button className="btn btn-primary" onClick={handleAnalyze} disabled={!url.trim() || loading}>
              {loading ? <Loader2 size={14} className="spin" /> : <Link size={14} />} Analyze
            </button>
          </div>
          {error && <div className="hub-error" style={{ marginTop: 10 }}><AlertCircle size={14} />{error}</div>}
          {hfFiles.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div className="hub-detail-section-label">Choose a GGUF file to download</div>
              {hfFiles.map(f => (
                <div key={f.name} className="hub-file-row" style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="hub-file-name" style={{ fontSize: 12 }}>{f.name}</div>
                    <div className="hub-file-size">{formatBytes(f.size)}</div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={() => handleDownloadFile(f)}>
                    <Download size={13} /> Download
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function DownloadRow({ dl }: { dl: any }) {
  const { removeModelDownload } = useStore()
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
          {formatBytes(dl.receivedBytes)} / {formatBytes(dl.totalBytes)}
        </span>
      </div>
      <div className="models-dl-bar-row">
        <div className="models-dl-bar">
          <div className="models-dl-fill" style={{ width: `${dl.percent}%`, background: isErr ? 'var(--danger)' : isDone ? 'var(--success)' : 'var(--accent)', opacity: isPaused || pending ? 0.5 : 1, transition: 'width 0.3s ease' }} />
        </div>
        <span className="models-dl-pct" style={{ minWidth: 80, textAlign: 'right', color: isPaused ? 'var(--text-muted)' : 'inherit' }}>
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
      {isErr && <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 2 }}>Download failed</div>}
      {isDone && <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 2 }}>✓ Saved to {dl.destPath}</div>}
    </div>
  )
}

// A single model file row inside a group.
function ModelFileRow({
  name, path, size, group, onDeleted
}: {
  name: string
  path: string
  size: number
  group: ModelGroup
  onDeleted: () => void
}) {
  const { setShowCreateModal, setView, setPrefillModelPath } = useStore()
  const [editing, setEditing] = useState(false)
  const [newName, setNewName] = useState(name.replace(/\.[^.]+$/, ''))
  async function handleDelete() {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return
    const res = await window.api.deleteModel(path)
    if (res.success) onDeleted()
    else alert('Delete failed: ' + res.error)
  }
  async function handleRename() {
    if (!newName.trim() || newName === name.replace(/\.[^.]+$/, '')) { setEditing(false); return }
    const res = await window.api.renameModel(path, newName.trim())
    if (res.success) { setEditing(false); onDeleted() }
    else alert('Rename failed: ' + res.error)
  }
  // Always create a NEW template for this model (never edit an existing one).
  // The user wants to be able to quickly create many templates even with the
  // same model, so the button never switches to "edit existing" mode.
  function handleTemplate() {
    setView('cards')
    setPrefillModelPath(path)
    setShowCreateModal(true, null)
  }
  // Size breakdown: if mmproj exists in the folder, show Total / Model + mmproj.
  const mmproj = group.mmproj
  const totalWithMmproj = mmproj ? size + mmproj.size : size
  return (
    <div className="models-file-row">
      <div className="models-file-icon"><HardDrive size={16} /></div>
      <div className="models-file-meta">
        {editing ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input className="form-input" style={{ padding: '4px 8px', fontSize: 12, flex: 1 }} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditing(false) }} autoFocus />
            <button className="btn btn-primary btn-sm btn-icon" onClick={handleRename}><Check size={13} /></button>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setEditing(false)}><X size={13} /></button>
          </div>
        ) : (
          <span className="models-file-name">{name}</span>
        )}
        {mmproj ? (
          <div className="model-size-breakdown">
            <span className="total-chip">Total: {formatBytes(totalWithMmproj)}</span>
            <span>Model: {formatBytes(size)}</span>
            <span className="mmproj-chip">+ mmproj {formatBytes(mmproj.size)}</span>
          </div>
        ) : (
          <div className="model-size-breakdown">
            <span className="total-chip">Model: {formatBytes(size)}</span>
          </div>
        )}
      </div>
      <div className="models-file-actions">
        <button
          className="btn btn-ghost btn-icon"
          onClick={handleTemplate}
          title="Create a new template for this model"
        >
          <FilePlus size={14} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(true)} title={group.external ? 'Rename disabled for external models' : 'Rename'} disabled={group.external}><Pencil size={14} /></button>
        <button className="btn btn-ghost btn-icon" onClick={() => window.api.openFolder(group.folderPath)} title="Open folder"><FolderOpen size={14} /></button>
        <button className="btn btn-ghost btn-icon text-danger" onClick={handleDelete} title={group.external ? 'Delete disabled for external models' : 'Delete'} disabled={group.external}><Trash size={14} /></button>
      </div>
    </div>
  )
}

// A model group (folder) — expandable to show its model files.
function ModelGroupCard({ group, onDeleted }: { group: ModelGroup; onDeleted: () => void }) {
  const { expandedModelGroups, toggleModelGroup } = useStore()
  const expanded = !!expandedModelGroups[group.folderPath]
  const mmproj = group.mmproj
  return (
    <div className="model-group">
      <div className="model-group-header" onClick={() => toggleModelGroup(group.folderPath)}>
        <ChevronRight size={16} className={`model-group-chevron ${expanded ? 'open' : ''}`} />
        <Layers size={15} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <span className="model-group-name" title={group.folderPath}>{group.folder}</span>
        {group.external && <span className="external-tag" title="Model from an external folder">External</span>}
        {mmproj ? (
          <span className="mmproj-badge" title={mmproj.name}>
            <Eye size={11} /> mmproj
          </span>
        ) : (
          <span className="mmproj-badge absent" title="No multimodal projector detected">no mmproj</span>
        )}
        <span className="model-group-count">{group.models.length} model{group.models.length !== 1 ? 's' : ''}</span>
        <span className="model-group-size">
          {mmproj
            ? `Total ${formatBytes(group.totalSize)}`
            : formatBytes(group.totalSize)}
        </span>
      </div>
      {expanded && (
        <div className="model-group-body">
          {group.models.map(m => (
            <ModelFileRow
              key={m.path}
              name={m.name}
              path={m.path}
              size={m.size}
              group={group}
              onDeleted={onDeleted}
            />
          ))}
          {mmproj && (
            <div className="models-file-row" style={{ opacity: 0.7 }} title="Multimodal projector — shared by all models in this folder. Not listed as a separate model.">
              <div className="models-file-icon"><Eye size={16} /></div>
              <div className="models-file-meta">
                <span className="models-file-name" style={{ color: 'var(--success)' }}>{mmproj.name}</span>
                <div className="model-size-breakdown">
                  <span className="mmproj-chip">mmproj {formatBytes(mmproj.size)}</span>
                  <span style={{ fontSize: 10 }}>auto-detected, shared by this folder</span>
                </div>
              </div>
            </div>
          )}
          {/* Item 2: speculative-decoding sidecar files (draft/EAGLE3/DSpark2/
              DFlash2 heads) — same non-interactive treatment as mmproj above:
              shown here for visibility, but never selectable as a Model File
              (they're excluded from `group.models` entirely on the backend). */}
          {group.specDecodeSidecars?.map(s => (
            <div key={s.path} className="models-file-row" style={{ opacity: 0.7 }} title={`${s.label} (Tier ${s.tier}) speculative-decoding sidecar — detected alongside this folder's model(s), not listed as a separate model.`}>
              <div className="models-file-icon"><Zap size={16} /></div>
              <div className="models-file-meta">
                <span className="models-file-name" style={{ color: '#3b82f6' }}>{s.name}</span>
                <div className="model-size-breakdown">
                  <span className="mmproj-chip" style={{ background: 'rgba(59,130,246,.12)', color: '#3b82f6' }}>T{s.tier} · {s.label} · {formatBytes(s.size)}</span>
                  <span style={{ fontSize: 10 }}>speculative decoding sidecar, auto-detected</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ModelsView() {
  const { models, setModels, modelDownloads, upsertModelDownload, paths, clearGgufMetadataAll } = useStore()
  const [showUrlModal, setShowUrlModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reextracting, setReextracting] = useState(false)
  const [filter, setFilter] = useState('')

  const totalModelFiles = useMemo(() => models.reduce((a, g) => a + g.models.length, 0), [models])
  const filteredGroups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return models
    return models
      .map(g => ({
        ...g,
        models: g.models.filter(m => m.name.toLowerCase().includes(q))
      }))
      .filter(g => g.folder.toLowerCase().includes(q) || g.models.length > 0)
  }, [models, filter])

  const refresh = useCallback(async () => {
    setLoading(true)
    const m = await window.api.listModels()
    setModels(m)
    setLoading(false)
  }, [setModels])

  // Item 3: "Reextract model data" — wipes BOTH the persisted (main-process)
  // and in-memory (renderer store) metadata caches, then re-triggers
  // extraction for every currently-detected model, exactly like the app-launch
  // parallel scan does for uncached models (see App.tsx's init effect) — the
  // only difference is this one is unconditional (every model gets rescanned,
  // not just ones missing from the cache), and mmproj files are naturally
  // skipped since they were never included in `g.models` to begin with.
  const reextractAll = useCallback(async () => {
    if (reextracting) return
    if (!confirm('This deletes all stored model metadata and re-extracts it from scratch for every detected model. This can take a while for large libraries. Continue?')) return
    setReextracting(true)
    try {
      await window.api.clearMetadataCache?.()
      clearGgufMetadataAll()
      const fresh = await window.api.listModels()
      setModels(fresh)
      const allPaths: string[] = []
      for (const g of fresh) for (const m of g.models) allPaths.push(m.path)
      // Fire-and-forget in parallel, same as the startup scan — the
      // onMetadataExtracting/onGgufMetadataUpdated listeners registered in
      // App.tsx handle the notification + populating the store as results
      // stream back in, so we don't need to await each one here.
      for (const p of allPaths) {
        window.api?.getGgufMetadata?.(p).catch(() => {})
      }
    } finally {
      setReextracting(false)
    }
  }, [reextracting, clearGgufMetadataAll, setModels])

  useEffect(() => {
    refresh()
    window.api.listModelDownloads().then((list: any[]) => {
      list.forEach(dl => upsertModelDownload(dl))
    })
  }, [])

  const downloads = Object.values(modelDownloads)
  const activeDownloads = downloads.filter(d => d.phase !== 'cancelled')

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Models</h1>
          <p className="page-subtitle">
            {filter ? `${filteredGroups.length} of ${models.length} folders` : models.length} folder{models.length !== 1 ? 's' : ''}
            {' · '}{totalModelFiles} model{totalModelFiles !== 1 ? 's' : ''}
            {activeDownloads.length > 0 ? ` · ${activeDownloads.length} downloading` : ''}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-ghost btn-icon" onClick={refresh} title="Refresh" disabled={loading}>
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
          {/* Item 3: manual full re-extraction — clears stored metadata for every
              detected model and re-runs extraction from scratch. */}
          <button
            className="btn btn-ghost btn-icon"
            onClick={reextractAll}
            disabled={reextracting}
            title="Reextract model data — delete all stored metadata and re-extract it from every detected model"
          >
            <Layers size={15} className={reextracting ? 'spin' : ''} />
          </button>
          <button className="btn btn-secondary" onClick={() => paths && window.api.openFolder(paths.mainModelFolder || paths.models)} disabled={!paths}>
            <FolderOpen size={15} /> Open Folder
          </button>
          <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
            <Download size={15} /> Download by URL
          </button>
        </div>
      </div>

      {activeDownloads.length > 0 && (
        <div className="models-section">
          <div className="models-section-title">
            <Loader2 size={13} className="spin" /> Active Downloads
          </div>
          {activeDownloads.map(dl => <DownloadRow key={dl.id} dl={dl} />)}
        </div>
      )}

      <div className="models-section">
        <div className="models-section-title">
          <HardDrive size={13} /> Installed Models
        </div>
        {models.length > 0 && (
          <div className="params-search-box">
            <Search size={16} style={{ color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="form-input"
              placeholder="Filter models by name or folder..."
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {filter && (
              <button className="btn btn-ghost btn-icon" onClick={() => setFilter('')} title="Clear filter" style={{ padding: 4 }}>
                <X size={14} />
              </button>
            )}
          </div>
        )}
        {loading && models.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)', fontSize: 13 }}>
            <Loader2 size={16} className="spin" style={{ display: 'block', margin: '0 auto 8px' }} /> Loading...
          </div>
        )}
        {!loading && models.length === 0 && (
          <div className="empty-state" style={{ padding: '40px 24px' }}>
            <div className="empty-state-icon"><HardDrive size={28} /></div>
            <h3>No models yet</h3>
            <p>Download a model from the Model Hub or use the "Download by URL" button.</p>
            <button className="btn btn-primary" onClick={() => setShowUrlModal(true)}>
              <Download size={15} /> Download by URL
            </button>
          </div>
        )}
        {models.length > 0 && filteredGroups.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)', fontSize: 13 }}>
            No models match "{filter}"
          </div>
        )}
        {filteredGroups.map(g => (
          <ModelGroupCard key={g.folderPath} group={g} onDeleted={refresh} />
        ))}
      </div>
      {showUrlModal && <UrlDownloadModal onClose={() => { setShowUrlModal(false); refresh() }} />}
    </div>
  )
}

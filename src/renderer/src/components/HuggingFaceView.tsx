import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { groupHubFiles, type HubEntry, type HubFile } from '../../../shared/hubFiles'
import SelectMenu from './SelectMenu'
import {
  Search, Download, Heart, ChevronDown, ChevronLeft,
  FolderOpen, CheckCircle, Loader2, X, AlertCircle, Box, Pause, Play,
  ArrowDown, ArrowUp, Calendar
} from 'lucide-react'
interface HfModel {
  id: string
  author: string
  name: string
  downloads: number
  likes: number
  tags: string[]
  lastModified: string
}
function formatBytes(bytes: number): string {
  if (!bytes) return '?'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
function formatSpeed(bps?: number): string {
  if (!bps) return ''
  const mbps = bps / (1024 * 1024)
  return `${mbps.toFixed(1)} MB/s`
}
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}
function quantLabel(filename: string): { label: string; color: string } {
  const upper = filename.toUpperCase()
  if (upper.includes('Q1')) return { label: 'Q1', color: '#dc2626' }
  if (upper.includes('Q2')) return { label: 'Q2', color: '#ef4444' }
  if (upper.includes('Q3')) return { label: 'Q3', color: '#f97316' }
  if (upper.includes('Q4')) return { label: 'Q4', color: '#eab308' }
  if (upper.includes('Q5')) return { label: 'Q5', color: '#22c55e' }
  if (upper.includes('Q6')) return { label: 'Q6', color: '#3b82f6' }
  if (upper.includes('Q8')) return { label: 'Q8', color: '#8b5cf6' }
  if (upper.includes('BF16')) return { label: 'BF16', color: '#6366f1' }
  if (upper.includes('F16')) return { label: 'F16', color: '#6366f1' }
  if (upper.includes('F32')) return { label: 'F32', color: '#6366f1' }
  return { label: 'GGUF', color: '#6b7280' }
}
export default function HuggingFaceView() {
  const {
    modelDownloads,
    hubQuery, hubResults, hubSelectedModelId,
    setHubQuery, setHubResults, setHubSelectedModelId,
    hubSort, hubDirection, setHubSort, setHubDirection
  } = useStore()

  const selectedModel = (hubResults as HfModel[]).find(m => m.id === hubSelectedModelId) ?? null

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [files, setFiles] = useState<HubFile[]>([])
  const [filesLoading, setFilesLoading] = useState(false)

  const [inputValue, setInputValue] = useState(hubQuery)

  useEffect(() => {
    if (hubSelectedModelId && hubResults.length > 0 && files.length === 0) {
      const model = (hubResults as HfModel[]).find(m => m.id === hubSelectedModelId)
      if (model) fetchFiles(model)
    }
  }, [])

  const doSearch = useCallback(async (q: string, sort = hubSort, direction = hubDirection) => {
    if (!q.trim()) return
    setHubQuery(q)          
    setLoading(true)
    setError('')
    setHubResults([])
    setHubSelectedModelId(null)
    try {
      const res = await window.api.hfSearch(q.trim(), sort, direction)
      if ('error' in res) throw new Error((res as any).error)
      setHubResults(res as HfModel[])
    } catch (e: any) {
      setError(e.message || 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [hubSort, hubDirection])

  async function fetchFiles(model: HfModel) {
    setFiles([])
    setFilesLoading(true)
    try {
      const res = await window.api.hfGetFiles(model.id)
      if ('error' in res) throw new Error((res as any).error)
      setFiles(res as HubFile[])
    } catch (e: any) {
      setError(e.message || 'Failed to fetch files')
    } finally {
      setFilesLoading(false)
    }
  }

  async function handleSelectModel(model: HfModel) {
    setHubSelectedModelId(model.id)
    fetchFiles(model)
  }

  // A model split into shards is queued part by part, first shard first, so
  // choosing it once is enough. Parts that are already queued, running or
  // finished are left alone.
  async function handleDownload(entry: HubEntry) {
    if (!selectedModel) return
    let failure = ''
    for (const shard of entry.shards) {
      const dl = getProgress(shard.name)
      if (dl && dl.phase !== 'cancelled' && dl.phase !== 'error') continue
      const res = await window.api.startModelDownload({
        url: shard.downloadUrl,
        filename: shard.name,
        repoId: selectedModel.id,
        modelFolder: entry.modelFolder
      })
      if (!res.success && res.error !== 'Already downloading' && !failure) failure = res.error || 'unknown error'
    }
    if (failure) alert(`Download failed: ${failure}`)
  }

  // Tasks are keyed by repoId+filename (see enqueueModelDownload in
  // ipc.ts) so two repos shipping a same-named file can't collide.
  const downloadIdFor = (filename: string) => `${selectedModel?.id || ''}::${filename}`
  const getProgress = (filename: string) => modelDownloads[downloadIdFor(filename)]
  // One row stands for every part of a model, so its progress is the sum
  // over its shards.
  function entryState(entry: HubEntry) {
    const parts = entry.shards.map(shard => ({ shard, dl: getProgress(shard.name) }))
    const live = parts.filter(p => p.dl && p.dl.phase !== 'done' && p.dl.phase !== 'cancelled')
    const doneParts = parts.filter(p => p.dl?.phase === 'done').length
    const received = parts.reduce((sum, p) =>
      sum + (p.dl?.phase === 'done' ? p.shard.size : p.dl && p.dl.phase !== 'cancelled' ? p.dl.receivedBytes : 0), 0)
    const phases = live.map(p => p.dl!.phase)
    const phase = phases.includes('error') ? 'error'
      : phases.includes('downloading') ? 'downloading'
      : phases.includes('queued') ? 'queued'
      : phases.includes('paused') ? 'paused'
      : null
    const queuePositions = live.map(p => p.dl!.queuePosition).filter((n): n is number => !!n)
    return {
      live, doneParts, phase,
      done: doneParts === parts.length,
      percent: entry.size > 0 ? Math.min(100, Math.floor(received / entry.size * 100)) : 0,
      speed: live.reduce((sum, p) => sum + (p.dl!.speed || 0), 0),
      error: live.find(p => p.dl!.phase === 'error')?.dl?.error,
      queuePosition: queuePositions.length ? Math.min(...queuePositions) : 0
    }
  }
  async function pauseEntry(entry: HubEntry) {
    for (const shard of entry.shards) {
      const phase = getProgress(shard.name)?.phase
      if (phase === 'downloading' || phase === 'queued') await window.api.pauseModelDownload(downloadIdFor(shard.name))
    }
  }
  async function resumeEntry(entry: HubEntry) {
    for (const shard of entry.shards) {
      if (getProgress(shard.name)?.phase === 'paused') await window.api.resumeModelDownload(downloadIdFor(shard.name))
    }
  }
  const entries = useMemo(
    () => (selectedModel ? groupHubFiles(files, selectedModel.id.split('/').pop() || selectedModel.id) : []),
    [files, selectedModel?.id]
  )
  const popularQueries = ['llama', 'mistral', 'phi', 'qwen', 'gemma', 'deepseek', 'falcon']
  return (
    <div className="hub-container">
      {}
      <div className="page-header">
        <div>
          <h1 className="page-title">Model Hub</h1>
          <p className="page-subtitle">Search and download GGUF models from HuggingFace</p>
        </div>
        <button className="btn btn-ghost" onClick={() => window.api.hfOpenModelsDir()} title="Open the main models folder">
          <FolderOpen size={15} /> Open models folder
        </button>
      </div>
      {}
      <div className="hub-search-bar">
        <Search size={16} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input
          className="hub-search-input"
          type="text"
          placeholder="Search GGUF models on HuggingFace..."
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch(inputValue)}
        />
        {inputValue && (
          <button className="hub-search-clear" onClick={() => { setInputValue(''); setHubQuery(''); setHubResults([]); setHubSelectedModelId(null) }}>
            <X size={14} />
          </button>
        )}
        <div className="hub-sort-divider" />
        <SelectMenu
          variant="bare"
          value={hubSort}
          onChange={sort => {
            setHubSort(sort)
            // HF API doesn't support ascending for downloads/likes
            let newDirection = hubDirection
            if ((sort === 'downloads' || sort === 'likes') && hubDirection === 1) {
              newDirection = -1
              setHubDirection(-1)
            }
            if (inputValue.trim()) {
              doSearch(inputValue, sort, newDirection)
            }
          }}
          options={[
            { value: 'downloads', label: 'Downloads' },
            { value: 'likes', label: 'Likes' },
            { value: 'createdAt', label: 'Date Created' },
            { value: 'lastModified', label: 'Last Updated' }
          ]}
        />
        {hubSort !== 'downloads' && hubSort !== 'likes' && (
          <button
            className="btn btn-ghost btn-icon"
            style={{ padding: '6px', marginLeft: '-4px', marginRight: '4px' }}
            title={hubDirection === -1 ? 'Descending' : 'Ascending'}
            onClick={() => {
              const newDir = hubDirection === -1 ? 1 : -1
              setHubDirection(newDir)
              if (inputValue.trim()) {
                doSearch(inputValue, hubSort, newDir)
              }
            }}
          >
            {hubDirection === -1 ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
          </button>
        )}
        <button className="btn btn-primary" onClick={() => doSearch(inputValue)} disabled={loading || !inputValue.trim()}>
          {loading ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
          Search
        </button>
      </div>
      {}
      {!hubResults.length && !loading && (
        <div className="hub-tags">
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>Popular:</span>
          {popularQueries.map(q => (
            <button key={q} className="hub-tag-btn" onClick={() => { setInputValue(q); doSearch(q) }}>
              {q}
            </button>
          ))}
        </div>
      )}
      {}
      {error && (
        <div className="hub-error">
          <AlertCircle size={14} />
          {error}
          <button onClick={() => setError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>
            <X size={12} />
          </button>
        </div>
      )}
      {}
      {loading && (
        <div className="hub-grid">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="hub-card skeleton" />
          ))}
        </div>
      )}
      {}
      {!loading && hubResults.length > 0 && (
        <div className={`hub-results-layout ${selectedModel ? 'has-detail' : ''}`}>
          {}
          <div className="hub-grid">
            {(hubResults as HfModel[]).map(model => (
              <button
                key={model.id}
                className={`hub-card ${selectedModel?.id === model.id ? 'selected' : ''}`}
                onClick={() => handleSelectModel(model)}
              >
                <div className="hub-card-icon">
                  <Box size={18} />
                </div>
                <div className="hub-card-body">
                  <div className="hub-card-name" title={model.name}>{model.name}</div>
                  <div className="hub-card-author">{model.author}</div>
                  <div className="hub-card-stats">
                    <span><Download size={11} /> {formatNumber(model.downloads)}</span>
                    <span><Heart size={11} /> {formatNumber(model.likes)}</span>
                    {model.lastModified && <span><Calendar size={11} /> {new Date(model.lastModified).toLocaleDateString()}</span>}
                  </div>
                </div>
                <ChevronDown size={14} style={{ transform: 'rotate(-90deg)', flexShrink: 0, color: 'var(--text-muted)' }} />
              </button>
            ))}
          </div>
          {}
          {selectedModel && (
            <div className="hub-detail-panel">
              <div className="hub-detail-header">
                <button className="btn btn-ghost btn-icon" onClick={() => setHubSelectedModelId(null)} title="Back">
                  <ChevronLeft size={16} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="hub-detail-name" title={selectedModel.name}>{selectedModel.name}</div>
                  <div className="hub-detail-author">{selectedModel.author}</div>
                </div>
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => window.api.openExternal(`https://huggingface.co/${selectedModel.id}`)}
                  title="Open on HuggingFace"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                </button>
              </div>
              <div className="hub-detail-stats">
                <span><Download size={12} /> {formatNumber(selectedModel.downloads)} downloads</span>
                <span><Heart size={12} /> {formatNumber(selectedModel.likes)} likes</span>
              </div>
              <div className="hub-detail-section-label">GGUF Files</div>
              {filesLoading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                  <Loader2 size={14} className="spin" /> Loading files...
                </div>
              )}
              {!filesLoading && files.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '8px 0' }}>No GGUF files found in this repository.</div>
              )}
              {!filesLoading && entries.map((entry, index) => {
                const st = entryState(entry)
                const { label, color } = quantLabel(`${entry.folder}/${entry.title}`)
                const multi = entry.shardCount > 1
                const firstSupport = entry.support && !entries[index - 1]?.support
                return (
                  <React.Fragment key={entry.key}>
                    {firstSupport && (
                      <div className="hub-detail-section-label" style={{ marginTop: 16 }}>Projectors and extras</div>
                    )}
                    <div className="hub-file-row">
                      <div className="hub-file-info">
                        <span className="hub-quant-badge" style={{ background: color + '22', color }}>
                          {label}
                        </span>
                        <div className="hub-file-name" title={entry.shards.map(s => s.name).join('\n')}>{entry.title}</div>
                        {multi && (
                          <span className="hub-part-chip" title={entry.shards.map(s => `${s.name.slice(s.name.lastIndexOf('/') + 1)}  ${formatBytes(s.size)}`).join('\n')}>
                            {entry.shardCount} parts
                          </span>
                        )}
                        <div className="hub-file-size">{formatBytes(entry.size)}</div>
                      </div>
                      {entry.folder && <div className="hub-file-folder">{entry.folder}/</div>}
                      {!entry.complete && (
                        <div className="hub-file-folder" style={{ color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <AlertCircle size={11} /> Only {entry.shards.length} of {entry.shardCount} parts are in this repository
                        </div>
                      )}
                      {st.phase && !st.done ? (
                        <div className="hub-file-progress">
                          <div className="hub-progress-bar">
                            <div className="hub-progress-fill" style={{ width: `${st.percent}%`, opacity: st.phase === 'paused' ? 0.45 : 1, transition: 'width 0.3s ease' }} />
                          </div>
                          <span className="hub-progress-label">
                            {st.phase === 'queued'
                              ? `Queued${st.queuePosition ? ` (#${st.queuePosition})` : ''}`
                              : st.phase === 'error'
                              ? (st.error || 'Failed')
                              : st.phase === 'paused'
                              ? `Paused \u2022 ${st.percent}%`
                              : `${st.percent}%${multi ? ` \u2022 ${st.doneParts}/${entry.shardCount} parts` : ''}${st.speed ? ` \u2022 ${formatSpeed(st.speed)}` : ''}`
                            }
                          </span>
                          {st.phase === 'paused' ? (
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ marginLeft: 4 }}
                              onClick={() => resumeEntry(entry)}
                              title="Resume"
                            >
                              <Play size={12} />
                            </button>
                          ) : st.phase === 'downloading' ? (
                            <button
                              className="btn btn-ghost btn-icon"
                              style={{ marginLeft: 4 }}
                              onClick={() => pauseEntry(entry)}
                              title="Pause"
                            >
                              <Pause size={12} />
                            </button>
                          ) : null}
                        </div>
                      ) : st.done ? (
                        <div className="hub-file-done">
                          <CheckCircle size={16} style={{ color: 'var(--success)' }} />
                        </div>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm hub-dl-btn"
                          disabled={!entry.complete}
                          onClick={() => handleDownload(entry)}
                        >
                          <Download size={13} />
                          {st.doneParts > 0
                            ? `Download remaining (${entry.shardCount - st.doneParts} of ${entry.shardCount} parts)`
                            : multi ? `Download (${entry.shardCount} parts)` : 'Download'}
                        </button>
                      )}
                    </div>
                  </React.Fragment>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

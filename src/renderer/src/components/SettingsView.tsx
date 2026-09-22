import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../store/useStore'
import {
  HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal,
  Bell, BellOff, Folder, Monitor, Moon, Sun, Plus, Link2,
  AlertCircle, ExternalLink, Cpu, Layers, Database
} from 'lucide-react'
import CommandsEditor from './CommandsEditor'
import ExternalFolderList from './ExternalFolderList'
import McpSettingsSection from './McpSettingsSection'
import LaunchSettingsSection from './LaunchSettingsSection'
import { changeTheme } from '../hooks/useTheme'
import { formatBytes } from '../utils/format'
import { pickDefaultAsset, setLastAssetType } from '../utils/backendAssetPref'
import type { ThemePref, TrackedBackend, TrackedBackendRelease, RedundantCheckpoint } from '../../../shared/types'

const NOTIF_KEY = 'hexllama_update_notify'

function getNotifPref(): 'banner' | 'manual' {
  return (localStorage.getItem(NOTIF_KEY) as 'banner' | 'manual') || 'banner'
}

export default function SettingsView() {
  const {
    backends, activeBackend, setActiveBackend, setCommandsSchema, setBackends,
    releaseInfo, downloadProgress, setDownloadProgress, setReleaseInfo,
    setModels, compactSidebarEnabled, setCompactSidebarEnabled,
    theme, systemTheme,
    externalModelFolders, externalBackendFolders,
    mainModelFolder, mainBackendFolder,
    trackedBackends, trackerResults, checkingAllBackends,
    setExternalModelFolders, setExternalBackendFolders,
    setMainModelFolder, setMainBackendFolder, setTrackedBackends,
    setTrackerResult, setCheckingAllBackends,
    kvCacheCheckpoints, setKvCacheCheckpoints
  } = useStore()

  const [selectedAssetByUrl, setSelectedAssetByUrl] = useState<Record<string, string>>({})
  const [expandedEditor, setExpandedEditor] = useState<string | null>(null)
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [customBackendLink, setCustomBackendLink] = useState('')
  const [customBackendErr, setCustomBackendErr] = useState('')
  // Checkpoints flagged by the last redundant-checkpoint scan (see
  // scan-redundant-checkpoints) -- re-run on mount and whenever the
  // Model/Model-Template mode changes, since both are exactly the moments a
  // previously-fine checkpoint can become redundant.
  const [redundantCheckpoints, setRedundantCheckpoints] = useState<RedundantCheckpoint[]>([])
  const [deletingCheckpoints, setDeletingCheckpoints] = useState(false)
  const kvCacheCheckpointsRef = useRef(kvCacheCheckpoints)
  useEffect(() => { kvCacheCheckpointsRef.current = kvCacheCheckpoints }, [kvCacheCheckpoints])
  const refreshRedundantCheckpoints = useCallback(async () => {
    try {
      const found = await window.api.scanRedundantCheckpoints()
      if (found.length > 0 && kvCacheCheckpointsRef.current.autoDeleteRedundant) {
        await window.api.deleteRedundantCheckpoints(found.map(c => c.file))
        setRedundantCheckpoints([])
        return
      }
      setRedundantCheckpoints(found)
    } catch { setRedundantCheckpoints([]) }
  }, [])
  useEffect(() => { refreshRedundantCheckpoints() }, [refreshRedundantCheckpoints, kvCacheCheckpoints.mode])
  // Which tracked backend's asset-type dropdown is open (at most one at a
  // time). Closed on any click outside a ".asset-picker" element.
  const [openDropdownId, setOpenDropdownId] = useState<string | null>(null)
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('.asset-picker')) setOpenDropdownId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (releaseInfo?.assets.length) {
      // legacy single release uses key 'llama-cpp'
      if (!selectedAssetByUrl['llama-cpp']) {
        setSelectedAssetByUrl(prev => ({ ...prev, 'llama-cpp': pickDefaultAsset('llama-cpp', releaseInfo.assets) }))
      }
    }
  }, [releaseInfo, selectedAssetByUrl])

  async function refreshModels() {
    const m = await window.api.listModels()
    setModels(m)
  }

  function handleNotifPref(pref: 'banner' | 'manual') {
    setNotifPref(pref)
    localStorage.setItem(NOTIF_KEY, pref)
  }

  async function handleSwitchBackend(backendId: string) {
    const b = backends.find(x => x.id === backendId || x.name === backendId)
    if (!b) return
    setActiveBackend(b)
    window.api.setGlobalBackend({ backendKey: b.backendKey, backendVersion: b.name, backendType: b.backendType ?? null }).catch(() => {})
    const cmds = await window.api.getCommands(b.backendKey)
    if (cmds) setCommandsSchema(cmds)
  }

  async function handleDeleteBackend(backendId: string) {
    const b = backends.find(x => x.id === backendId)
    if (!b) return
    if (!confirm(`Delete backend "${b.displayName}"? This will remove all files in that version folder.`)) return
    const res = await window.api.deleteBackend(backendId)
    if (res.success) {
      const updated = await window.api.listBackends()
      setBackends(updated)
    } else alert('Delete failed: ' + res.error)
  }

  // Global "Check for updates" across ALL tracked backends.
  const handleCheckAllBackends = useCallback(async () => {
    setCheckingAllBackends(true)
    try {
      const { results } = await window.api.checkAllBackends()
      for (const r of results) setTrackerResult(r)
      // Also sync the legacy releaseInfo with the llama.cpp result for the banner.
      const llama = results.find(r => r.trackedId === 'llama-cpp')
      if (llama) {
        const { trackedId, folderName, ...rest } = llama
        setReleaseInfo(rest as any)
      }
    } finally {
      setCheckingAllBackends(false)
    }
  }, [setCheckingAllBackends, setTrackerResult, setReleaseInfo])

  async function handleAddTrackedBackend() {
    setCustomBackendErr('')
    const link = customBackendLink.trim()
    if (!link) return
    const res = await window.api.addTrackedBackend(link)
    if (res.success && res.tracked) {
      setTrackedBackends([...trackedBackends, res.tracked])
      setCustomBackendLink('')
      // Immediately check the newly added backend so the user sees its release.
      handleCheckAllBackends()
    } else {
      setCustomBackendErr(res.error || 'Failed to add')
    }
  }

  async function handleRemoveTrackedBackend(t: TrackedBackend) {
    if (t.isDefault) { alert('Built-in backends cannot be removed.'); return }
    if (!confirm(`Stop tracking "${t.name}"? Already-downloaded versions are kept.`)) return
    const res = await window.api.removeTrackedBackend(t.id)
    if (res.success) setTrackedBackends(trackedBackends.filter(x => x.id !== t.id))
  }

  async function handleDownloadAsset(t: TrackedBackend, asset: { name: string; downloadUrl: string }, release: TrackedBackendRelease) {
    const versionHint = release.tagName || asset.name.replace(/\.(zip|tar\.gz)$/i, '')
    // Resolves once this download has actually run -- if another download
    // (for this backend or any other) is already in progress, the main
    // process queues this one and runs it automatically afterwards, sending
    // 'queued' progress events (position in line) in the meantime.
    const res = await window.api.downloadRelease({
      url: asset.downloadUrl,
      version: versionHint,
      assetName: asset.name,
      backendKey: t.folderName,
      trackedId: t.id
    })
    setDownloadProgress(`${t.id}::${asset.name}`, null)
    if (res.success) {
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
      // Refresh just this backend's tracker result so its badges reflect
      // the install that just happened, without a full "Check for updates
      // (all backends)" pass.
      const updated = await window.api.checkTrackedBackend(t.id)
      if (!('error' in updated)) setTrackerResult(updated)
    } else if (res.error !== 'Cancelled') alert(`Download failed: ${res.error}`)
  }

  // Queues every already-installed-but-outdated variant for one backend
  // (e.g. both "vulkan" and "cuda" if you have both and a new release
  // shipped for the fork). Fresh (never-installed) variants are left alone
  // -- this is an update, not an install-everything button.
  async function handleUpdateBackend(t: TrackedBackend, release: TrackedBackendRelease) {
    const outdated = release.assets.filter(a => a.status === 'outdated')
    if (!outdated.length) return
    await Promise.all(outdated.map(async asset => {
      const res = await window.api.downloadRelease({
        url: asset.downloadUrl,
        version: release.tagName || asset.name.replace(/\.(zip|tar\.gz)$/i, ''),
        assetName: asset.name,
        backendKey: t.folderName,
        trackedId: t.id
      })
      setDownloadProgress(`${t.id}::${asset.name}`, null)
      return res
    }))
    const backendsData = await window.api.listBackends()
    setBackends(backendsData)
    const updated = await window.api.checkTrackedBackend(t.id)
    if (!('error' in updated)) setTrackerResult(updated)
  }

  // Global equivalent of handleUpdateBackend: every outdated variant across
  // every tracked backend.
  async function handleUpdateAll() {
    const jobs: { t: TrackedBackend; release: TrackedBackendRelease; asset: TrackedBackendRelease['assets'][number] }[] = []
    for (const t of trackedBackends) {
      const release = trackerResults[t.id]
      if (!release?.assets) continue
      for (const asset of release.assets) if (asset.status === 'outdated') jobs.push({ t, release, asset })
    }
    if (!jobs.length) return
    await Promise.all(jobs.map(async ({ t, release, asset }) => {
      const res = await window.api.downloadRelease({
        url: asset.downloadUrl,
        version: release.tagName || asset.name.replace(/\.(zip|tar\.gz)$/i, ''),
        assetName: asset.name,
        backendKey: t.folderName,
        trackedId: t.id
      })
      setDownloadProgress(`${t.id}::${asset.name}`, null)
      return res
    }))
    const backendsData = await window.api.listBackends()
    setBackends(backendsData)
    const affectedIds = [...new Set(jobs.map(j => j.t.id))]
    const results = await Promise.all(affectedIds.map(id => window.api.checkTrackedBackend(id)))
    for (const r of results) if (!('error' in r)) setTrackerResult(r)
  }

  async function handleDeleteBackendType(t: TrackedBackend, asset: { name: string; type?: string }) {
    if (!asset.type) return
    if (!confirm(`Delete the installed "${asset.type}" build of "${t.name}"? This removes it from disk.`)) return
    const res = await window.api.deleteBackendType(t.folderName, asset.type)
    if (res.success) {
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
      const updated = await window.api.checkTrackedBackend(t.id)
      if (!('error' in updated)) setTrackerResult(updated)
    } else alert(`Delete failed: ${res.error}`)
  }

  async function handleSetTheme(t: ThemePref) {
    await changeTheme(t)
  }

  const anyUpdatesDetected = trackedBackends.some(t => trackerResults[t.id]?.assets?.some(a => a.status === 'outdated'))

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage llama.cpp backends, models and appearance</p>
        </div>
      </div>

      {/* Appearance / Theme */}
      <div className="settings-section">
        <div className="settings-section-title"><Monitor /> Appearance</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Choose how XLM Studio looks. <strong>Match System</strong> follows your OS theme.
            If the system theme can't be detected, it falls back to Dark.
          </p>
          <div className="theme-segmented">
            <button
              className={`theme-segmented-btn ${theme === 'system' ? 'active' : ''}`}
              onClick={() => handleSetTheme('system')}
              title="Follow the operating system theme"
            >
              <Monitor size={14} /> Match System
              {theme === 'system' && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                  ({systemTheme})
                </span>
              )}
            </button>
            <button
              className={`theme-segmented-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => handleSetTheme('dark')}
              title="Always use dark theme"
            >
              <Moon size={14} /> Dark
            </button>
            <button
              className={`theme-segmented-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => handleSetTheme('light')}
              title="Always use light theme"
            >
              <Sun size={14} /> Light
            </button>
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className="settings-section">
        <div className="settings-section-title"><Bell /> Update Notifications</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Choose how you'd like to be informed when a new version of llama.cpp is available.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`launch-mode-btn ${notifPref === 'banner' ? 'active' : ''}`} onClick={() => handleNotifPref('banner')}>
              <Bell size={13} /> Show Banner Automatically
            </button>
            <button className={`launch-mode-btn ${notifPref === 'manual' ? 'active' : ''}`} onClick={() => handleNotifPref('manual')}>
              <BellOff size={13} /> Check Manually Only
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar Layout */}
      <div className="settings-section">
        <div className="settings-section-title"><Terminal /> Sidebar Layout</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Toggle the sidebar mode. Auto-collapse shrinks the sidebar to icons and expands on hover.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`launch-mode-btn ${!compactSidebarEnabled ? 'active' : ''}`} onClick={() => setCompactSidebarEnabled(false)}>
              Full Sidebar (Default)
            </button>
            <button className={`launch-mode-btn ${compactSidebarEnabled ? 'active' : ''}`} onClick={() => setCompactSidebarEnabled(true)}>
              Auto-Collapse Sidebar
            </button>
          </div>
        </div>
      </div>

      {/* External Model Folders (with star/main selector) */}
      <div className="settings-section">
        <div className="settings-section-title"><Folder /> External Model Folders</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Add folders outside the app's default models directory. Files inside appear on the Models page.
            Star one folder to make it the <strong>main folder</strong> — all models downloaded through the app
            land there (in their own subfolder, named after the page model). If nothing is starred, the default
            app folder is used. The starred folder is pinned to the top; others are sorted alphabetically.
          </p>
          <ExternalFolderList
            folders={externalModelFolders}
            mainFolder={mainModelFolder}
            onAdd={async () => {
              const res = await window.api.addExternalModelFolder()
              if (res.success && res.folders) setExternalModelFolders(res.folders)
              return res
            }}
            onRemove={async (folder) => {
              const res = await window.api.removeExternalModelFolder(folder)
              setExternalModelFolders(res.folders)
              return res
            }}
            onSetMain={async (folder) => {
              const res = await window.api.setMainModelFolder(folder)
              // Reload main folder state from the source of truth.
              const mm = await window.api.getMainModelFolder()
              setMainModelFolder(mm.isDefault ? null : mm.folder)
              return res
            }}
            onMigrate={(folder) => window.api.migrateModelFolders(folder)}
            addLabel="Add Model Folder"
            emptyText="No external model folders configured. The default app folder is used."
            onAfterChange={refreshModels}
          />
        </div>
      </div>

      {/* External Backend Folders (same mechanics) */}
      <div className="settings-section">
        <div className="settings-section-title"><Cpu /> External Backends Folders</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Add folders that contain pre-built llama.cpp backends (e.g. a folder where you keep several
            compiled forks). Star one to make it the <strong>main backend folder</strong> — backends
            downloaded through the Backends Tracker land there, under <code>&lt;fork-name&gt;/&lt;version&gt;/</code>.
            Same star/sort mechanics as model folders.
          </p>
          <ExternalFolderList
            folders={externalBackendFolders}
            mainFolder={mainBackendFolder}
            onAdd={async () => {
              const res = await window.api.addExternalBackendFolder()
              if (res.success && res.folders) setExternalBackendFolders(res.folders)
              return res
            }}
            onRemove={async (folder) => {
              const res = await window.api.removeExternalBackendFolder(folder)
              setExternalBackendFolders(res.folders)
              return res
            }}
            onSetMain={async (folder) => {
              const res = await window.api.setMainBackendFolder(folder)
              const mb = await window.api.getMainBackendFolder()
              setMainBackendFolder(mb.isDefault ? null : mb.folder)
              return res
            }}
            addLabel="Add Backend Folder"
            emptyText="No external backend folders configured. The default app folder is used."
            onAfterChange={async () => {
              const updated = await window.api.listBackends()
              setBackends(updated)
            }}
          />
        </div>
      </div>

      {/* KV Cache Checkpoints */}
      <div className="settings-section">
        <div className="settings-section-title"><Database /> KV Cache Checkpoints</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Store KV Cache Checkpoints</div>
              <div className="settings-row-sub">
                Save each Template's context to disk on Stop and restore it on the next Start, so switching
                back to a Template doesn't re-read the whole prompt from scratch. Never applied to Benchmarks,
                to keep their measurements fresh.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={kvCacheCheckpoints.enabled} onChange={async (e) => {
                  const o = { ...kvCacheCheckpoints, enabled: e.target.checked }
                  setKvCacheCheckpoints(o)
                  try { await window.api.setKvCacheCheckpoints(o) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {kvCacheCheckpoints.enabled && (
            <>
              {/* Storage mode */}
              <div style={{ width: '100%' }}>
                <div className="settings-row-label">Store checkpoint per each:</div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className={`launch-mode-btn ${kvCacheCheckpoints.mode === 'model' ? 'active' : ''}`}
                    onClick={async () => {
                      const o = { ...kvCacheCheckpoints, mode: 'model' as const }
                      setKvCacheCheckpoints(o)
                      try { await window.api.setKvCacheCheckpoints(o) } catch {}
                    }}
                  >
                    Model
                  </button>
                  <button
                    className={`launch-mode-btn ${kvCacheCheckpoints.mode === 'model-template' ? 'active' : ''}`}
                    onClick={async () => {
                      const o = { ...kvCacheCheckpoints, mode: 'model-template' as const }
                      setKvCacheCheckpoints(o)
                      try { await window.api.setKvCacheCheckpoints(o) } catch {}
                    }}
                  >
                    Model-Template
                  </button>
                </div>
                <div className="form-hint" style={{ marginTop: 6 }}>
                  {kvCacheCheckpoints.mode === 'model'
                    ? 'Checkpoint per model is recommended if you use all models for general purposes.'
                    : 'Checkpoint per model-template is recommended if you use templates for different purposes, e.g. for specialized agents and multi-agent setups on different ports.'}
                </div>
              </div>

              {/* Checkpoint folders */}
              <div style={{ width: '100%' }}>
                <div className="settings-row-label">Checkpoint Folders</div>
                <div className="settings-row-sub" style={{ marginBottom: 8 }}>
                  By default checkpoints are stored inside the app's own folder. Add a folder on a bigger
                  drive and star it to store checkpoints there instead.
                </div>
                <ExternalFolderList
                  folders={kvCacheCheckpoints.externalFolders}
                  mainFolder={kvCacheCheckpoints.mainFolder}
                  onAdd={async () => {
                    const res = await window.api.addExternalCheckpointFolder()
                    if (res.success && res.folders) setKvCacheCheckpoints({ ...kvCacheCheckpoints, externalFolders: res.folders })
                    return res
                  }}
                  onRemove={async (folder) => {
                    const res = await window.api.removeExternalCheckpointFolder(folder)
                    setKvCacheCheckpoints({ ...kvCacheCheckpoints, externalFolders: res.folders, mainFolder: res.folders.includes(kvCacheCheckpoints.mainFolder || '') ? kvCacheCheckpoints.mainFolder : null })
                    return res
                  }}
                  onSetMain={async (folder) => {
                    const res = await window.api.setMainCheckpointFolder(folder)
                    setKvCacheCheckpoints({ ...kvCacheCheckpoints, mainFolder: res.mainFolder })
                    return res
                  }}
                  addLabel="Add Checkpoint Folder"
                  emptyText="No external checkpoint folders configured. The default app folder is used."
                />
              </div>

              {/* Redundant checkpoints */}
              {redundantCheckpoints.length > 0 && (
                <div style={{ width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                    <div>
                      <div className="settings-row-label" style={{ color: '#d99e00' }}>
                        <AlertCircle size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                        Redundant Checkpoints detected. Delete?
                      </div>
                      <div className="settings-row-sub">
                        {redundantCheckpoints.length} checkpoint{redundantCheckpoints.length === 1 ? '' : 's'} no longer needed
                        (leftover from a mode switch, a deleted Template, or a Template whose model changed).
                      </div>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={deletingCheckpoints}
                      onClick={async () => {
                        setDeletingCheckpoints(true)
                        try {
                          await window.api.deleteRedundantCheckpoints(redundantCheckpoints.map(c => c.file))
                          await refreshRedundantCheckpoints()
                        } finally {
                          setDeletingCheckpoints(false)
                        }
                      }}
                    >
                      {deletingCheckpoints ? <Loader2 size={13} className="spin" /> : <Trash size={13} />} Confirm
                    </button>
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {redundantCheckpoints.map(c => (
                      <div key={c.file} className="form-hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span>{c.modelName}{c.mode === 'model-template' ? ` — ${c.templateName}` : ''}</span>
                        <span style={{ opacity: 0.7 }}>{c.reason}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Auto-delete redundant */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <div>
                  <div className="settings-row-label">Automatically delete redundant checkpoints</div>
                  <div className="settings-row-sub">Skip the confirmation above and delete redundant checkpoints as soon as they're detected.</div>
                </div>
                <div className="toggle-wrap">
                  <label className="toggle">
                    <input type="checkbox" checked={kvCacheCheckpoints.autoDeleteRedundant} onChange={async (e) => {
                      const o = { ...kvCacheCheckpoints, autoDeleteRedundant: e.target.checked }
                      setKvCacheCheckpoints(o)
                      try { await window.api.setKvCacheCheckpoints(o) } catch {}
                      if (e.target.checked && redundantCheckpoints.length > 0) {
                        try {
                          await window.api.deleteRedundantCheckpoints(redundantCheckpoints.map(c => c.file))
                          await refreshRedundantCheckpoints()
                        } catch {}
                      }
                    }} />
                    <span className="toggle-track"></span><span className="toggle-thumb"></span>
                  </label>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Installed Backends */}
      <div className="settings-section">
        <div className="settings-section-title"><HardDrive /> Installed Backends</div>
        {backends.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
            No backends installed. Download one from the Backends Tracker below.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {backends.map((b) => (
              <div key={b.id}>
                <div className="settings-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="settings-row-label flex items-center gap-2">
                      <Layers size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.displayName}</span>
                      {activeBackend?.id === b.id && <span className="version-badge active-version">Active</span>}
                      {!b.hasCommands && <span className="version-badge">Fallback Schema</span>}
                      {b.external && <span className="version-badge">External</span>}
                    </div>
                    <div className="settings-row-sub mono" style={{ wordBreak: 'break-all' }}>
                      {b.exe ? `${b.path}${b.path.endsWith('/') || b.path.endsWith('\\') ? '' : '/'}${b.exe}` : 'No executable found'}
                    </div>
                  </div>
                  <div className="flex gap-2" style={{ flexShrink: 0 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSwitchBackend(b.id)}
                      disabled={activeBackend?.id === b.id}
                    >
                      Set Active
                    </button>
                    <button
                      className={`btn btn-ghost btn-sm flex items-center gap-1 ${expandedEditor === b.id ? 'btn-primary' : ''}`}
                      onClick={() => setExpandedEditor(expandedEditor === b.id ? null : b.id)}
                      title="Edit commands.json for this backend fork"
                    >
                      <Terminal size={13} />
                      <ChevronDown size={12} style={{ transform: expandedEditor === b.id ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon text-danger"
                      onClick={() => handleDeleteBackend(b.id)}
                      title="Delete backend version"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                </div>
                {expandedEditor === b.id && (
                  <div className="ce-panel">
                    <CommandsEditor backendKey={b.backendKey} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backends Tracker (renamed from "Available Updates") */}
      <div className="settings-section">
        <div className="settings-section-title"><Download /> Backends Tracker</div>

        {/* Add custom backend from link */}
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Track additional llama.cpp forks by their GitHub repository. Paste a link like
            <code> https://github.com/owner/repo </code> or <code>owner/repo</code>. Backends are
            organised under <code>&lt;fork-name&gt;/&lt;version&gt;/</code> and a resilient search
            locates the <code>llama-server</code> binary — even when it's nested deep in <code>build/bin/</code>.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              type="text"
              placeholder="https://github.com/owner/repo  or  owner/repo"
              value={customBackendLink}
              onChange={e => setCustomBackendLink(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddTrackedBackend() }}
            />
            <button className="btn btn-primary" onClick={handleAddTrackedBackend} disabled={!customBackendLink.trim()}>
              <Plus size={14} /> Add custom backend from link
            </button>
          </div>
          {customBackendErr && (
            <div className="hub-error"><AlertCircle size={14} />{customBackendErr}</div>
          )}
        </div>

        {/* Tracked backends list */}
        <div style={{ marginTop: 16 }}>
          {trackedBackends.map(t => {
            const release = trackerResults[t.id]
            const loadingThis = checkingAllBackends && !release
            const selectedUrl = selectedAssetByUrl[t.id] || pickDefaultAsset(t.id, release?.assets || [])
            const selectedAsset = release?.assets.find(a => a.downloadUrl === selectedUrl)
            // Progress is keyed per (backend, asset) -- several of this
            // backend's own variants can be queued/downloading at once (via
            // Update), so only the currently-SELECTED asset's progress is
            // shown inline next to the Download button.
            const outdatedAssets = release?.assets.filter(a => a.status === 'outdated') || []
            // Every asset of this backend that's currently queued or
            // downloading, regardless of which one is selected in the
            // dropdown right now -- switching the dropdown selection must
            // never hide the fact that something is still working in the
            // background (this drives both the "N builds..." list below and
            // the busy state on the primary button when it IS the selected
            // one).
            const busyAssets = release?.assets.filter(a => downloadProgress[`${t.id}::${a.name}`]) || []
            const otherBusyAssets = busyAssets.filter(a => a.name !== selectedAsset?.name)
            return (
              <div key={t.id} className="tracker-card">
                <div className="tracker-card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="tracker-name">
                      {t.name}
                      {t.isDefault && <span className="tracker-default-tag">built-in</span>}
                    </div>
                    <div className="tracker-repo">
                      <Link2 size={11} style={{ display: 'inline', marginRight: 4 }} />
                      {t.repo}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {release?.url && (
                      <button
                        className="btn btn-ghost btn-icon"
                        onClick={() => window.api.openExternal(release.url)}
                        title="Open release on GitHub"
                      >
                        <ExternalLink size={14} />
                      </button>
                    )}
                    {!t.isDefault && (
                      <button
                        className="btn btn-ghost btn-icon text-danger"
                        onClick={() => handleRemoveTrackedBackend(t)}
                        title="Stop tracking this fork"
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {loadingThis ? (
                  <div className="tracker-release" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={13} className="spin" /> Checking GitHub for releases...
                  </div>
                ) : release?.error ? (
                  <div className="tracker-release" style={{ color: 'var(--danger)' }}>
                    <AlertCircle size={13} style={{ display: 'inline', marginRight: 6 }} />
                    Error: {release.error}
                  </div>
                ) : release ? (
                  <>
                    <div className="tracker-release">
                      <strong>{release.name || release.tagName}</strong>
                      {release.publishedAt && (
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                          Published: {new Date(release.publishedAt).toLocaleDateString()}
                        </span>
                      )}
                      {release.isNewer === false && <span className="up-to-date">✓ Up to date</span>}
                      {release.isNewer === true && <span className="new-badge">Update available</span>}
                    </div>
                    {release.assets.length > 0 && (
                      <div className="tracker-assets-row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        <div className="asset-picker" style={{ position: 'relative' }}>
                          <button
                            type="button"
                            className="cmd-select"
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', width: '100%', minWidth: 260, backgroundImage: 'none' }}
                            onClick={() => setOpenDropdownId(openDropdownId === t.id ? null : t.id)}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {selectedAsset ? `${selectedAsset.name} (${formatBytes(selectedAsset.size)})` : 'Select a build...'}
                            </span>
                            <ChevronDown size={13} style={{ flexShrink: 0 }} />
                          </button>
                          {openDropdownId === t.id && (
                            <div
                              className="asset-dropdown-menu"
                              style={{
                                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                                marginTop: 4, background: 'var(--surface-2, var(--surface))', border: '1px solid var(--border)',
                                borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxHeight: 280, overflowY: 'auto'
                              }}
                            >
                              {release.assets.map(a => (
                                <div
                                  key={a.downloadUrl}
                                  onClick={() => {
                                    setSelectedAssetByUrl(prev => ({ ...prev, [t.id]: a.downloadUrl }))
                                    setLastAssetType(t.id, a.name)
                                    setOpenDropdownId(null)
                                  }}
                                  style={{
                                    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                                    cursor: 'pointer', borderBottom: '1px solid var(--border)'
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,.05))')}
                                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                >
                                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                                    {a.name} <span style={{ color: 'var(--text-muted)' }}>({formatBytes(a.size)})</span>
                                  </span>
                                  {downloadProgress[`${t.id}::${a.name}`] ? (
                                    <Loader2 size={12} className="spin" style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                                  ) : a.status !== 'not-installed' ? (
                                    <button
                                      className="btn btn-ghost btn-icon text-danger"
                                      onClick={e => { e.stopPropagation(); handleDeleteBackendType(t, a) }}
                                      title={`Delete installed "${a.type}" build`}
                                      style={{ flexShrink: 0, padding: 2 }}
                                    >
                                      <Trash size={12} />
                                    </button>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        {(() => {
                          const myProgress = selectedAsset ? downloadProgress[`${t.id}::${selectedAsset.name}`] : undefined
                          const isQueued = myProgress?.phase === 'queued'
                          const isActive = !!myProgress && !isQueued
                          return isQueued ? (
                            <div className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                              <Loader2 size={14} className="spin" />
                              {`Queued (#${myProgress?.queuePosition || 1})`}
                              <button
                                className="btn btn-ghost btn-sm text-danger"
                                onClick={() => { window.api.cancelBackendDownload(t.id, selectedAsset?.name); setDownloadProgress(`${t.id}::${selectedAsset?.name}`, null) }}
                                style={{ padding: '0 8px' }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : isActive ? (
                            <div className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                              <Loader2 size={14} className="spin" />
                              {myProgress?.phase === 'extracting' ? 'Extracting...' : `Downloading... ${myProgress?.percent || 0}%`}
                              <button
                                className="btn btn-ghost btn-sm text-danger"
                                onClick={() => { window.api.cancelBackendDownload(t.id, selectedAsset?.name); setDownloadProgress(`${t.id}::${selectedAsset?.name}`, null) }}
                                style={{ padding: '0 8px' }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button
                                className="btn btn-primary btn-sm"
                                onClick={() => selectedAsset && handleDownloadAsset(t, selectedAsset, release)}
                                disabled={!selectedAsset}
                              >
                                <Download size={13} /> {selectedAsset?.status === 'installed' ? 'Re-download' : 'Download'}
                              </button>
                              {outdatedAssets.length > 0 && (
                                <button
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => handleUpdateBackend(t, release)}
                                  title={`Update ${outdatedAssets.length} installed build${outdatedAssets.length === 1 ? '' : 's'}`}
                                >
                                  <RefreshCw size={13} /> Update ({outdatedAssets.length})
                                </button>
                              )}
                            </div>
                          )
                        })()}
                        {/* Any OTHER build of this backend that's queued/downloading in the
                            background -- shown regardless of which one is currently selected
                            in the dropdown above, so switching selection never hides the fact
                            that something is still working. */}
                        {otherBusyAssets.length > 0 && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%' }}>
                            {otherBusyAssets.map(a => {
                              const p = downloadProgress[`${t.id}::${a.name}`]
                              const label = p?.phase === 'queued'
                                ? `Queued (#${p.queuePosition || 1})`
                                : p?.phase === 'extracting' ? 'Extracting...' : `Downloading... ${p?.percent || 0}%`
                              return (
                                <div key={a.name} className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                                  <Loader2 size={13} className="spin" />
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.type}: {label}</span>
                                  <button
                                    className="btn btn-ghost btn-sm text-danger"
                                    onClick={() => { window.api.cancelBackendDownload(t.id, a.name); setDownloadProgress(`${t.id}::${a.name}`, null) }}
                                    style={{ padding: '0 8px' }}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="tracker-release" style={{ color: 'var(--text-muted)' }}>
                    Click "Check for updates" to query GitHub for the latest release.
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Global check for updates button — single action for all tracked backends */}
        <div className="mt-4 pt-4 border-t flex flex-col gap-2">
          <button
            className="btn btn-secondary w-full justify-center"
            onClick={handleCheckAllBackends}
            disabled={checkingAllBackends}
          >
            <RefreshCw size={14} className={checkingAllBackends ? 'spin' : ''} />
            {checkingAllBackends ? 'Checking all backends...' : 'Check for updates (all backends)'}
          </button>
          {anyUpdatesDetected && (
            <button
              className="btn btn-primary w-full justify-center"
              onClick={handleUpdateAll}
            >
              <Download size={14} />
              Update all
            </button>
          )}
        </div>
      </div>

      <McpSettingsSection />
      <LaunchSettingsSection />
    </div>
  )
}

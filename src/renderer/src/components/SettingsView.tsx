import React, { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import {
  HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal,
  Bell, BellOff, Folder, Monitor, Moon, Sun, Plus, Link2,
  AlertCircle, ExternalLink, Cpu, Layers
} from 'lucide-react'
import CommandsEditor from './CommandsEditor'
import ExternalFolderList from './ExternalFolderList'
import { changeTheme } from '../hooks/useTheme'
import { formatBytes } from '../utils/format'
import type { ThemePref, TrackedBackend, TrackedBackendRelease } from '../../../shared/types'

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
    setTrackerResult, setCheckingAllBackends
  } = useStore()

  const [downloading, setDownloading] = useState(false)
  const [selectedAssetByUrl, setSelectedAssetByUrl] = useState<Record<string, string>>({})
  const [expandedEditor, setExpandedEditor] = useState<string | null>(null)
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [customBackendLink, setCustomBackendLink] = useState('')
  const [customBackendErr, setCustomBackendErr] = useState('')

  useEffect(() => {
    if (releaseInfo?.assets.length) {
      // legacy single release uses key 'llama-cpp'
      if (!selectedAssetByUrl['llama-cpp']) {
        setSelectedAssetByUrl(prev => ({ ...prev, 'llama-cpp': releaseInfo.assets[0].downloadUrl }))
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

  async function handleDownloadTracked(t: TrackedBackend, release: TrackedBackendRelease) {
    const assetUrl = selectedAssetByUrl[t.id] || (release.assets[0]?.downloadUrl || '')
    const asset = release.assets.find(a => a.downloadUrl === assetUrl) || release.assets[0]
    if (!asset) return
    setDownloading(true)
    const versionHint = release.tagName || asset.name.replace(/\.(zip|tar\.gz)$/i, '')
    const res = await window.api.downloadRelease({
      url: asset.downloadUrl,
      version: versionHint,
      assetName: asset.name,
      backendKey: t.folderName
    })
    setDownloading(false)
    setDownloadProgress(null)
    if (res.success) {
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
    } else alert(`Download failed: ${res.error}`)
  }

  async function handleSetTheme(t: ThemePref) {
    await changeTheme(t)
  }

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
            const selectedUrl = selectedAssetByUrl[t.id] || (release?.assets[0]?.downloadUrl || '')
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
                      {release.isNewer === true && <span className="new-badge">New version available</span>}
                    </div>
                    {release.assets.length > 0 && release.isNewer !== false && (
                      <div className="tracker-assets-row">
                        <select
                          className="cmd-select"
                          value={selectedUrl}
                          onChange={e => setSelectedAssetByUrl(prev => ({ ...prev, [t.id]: e.target.value }))}
                          disabled={downloading || !!downloadProgress}
                        >
                          {release.assets.map(a => (
                            <option key={a.downloadUrl} value={a.downloadUrl}>
                              {a.name} ({formatBytes(a.size)})
                            </option>
                          ))}
                        </select>
                        {downloading || downloadProgress ? (
                          <div className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={14} className="spin" />
                            {downloadProgress?.phase === 'extracting' ? 'Extracting...' : `Downloading... ${downloadProgress?.percent || 0}%`}
                            <button
                              className="btn btn-ghost btn-sm text-danger"
                              onClick={() => { window.api.cancelBackendDownload(); setDownloading(false); setDownloadProgress(null) }}
                              style={{ padding: '0 8px' }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => handleDownloadTracked(t, release)}>
                            <Download size={13} /> Download
                          </button>
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
        <div className="mt-4 pt-4 border-t">
          <button
            className="btn btn-secondary w-full justify-center"
            onClick={handleCheckAllBackends}
            disabled={checkingAllBackends || downloading}
          >
            <RefreshCw size={14} className={checkingAllBackends ? 'spin' : ''} />
            {checkingAllBackends ? 'Checking all backends...' : 'Check for updates (all backends)'}
          </button>
        </div>
      </div>
    </div>
  )
}

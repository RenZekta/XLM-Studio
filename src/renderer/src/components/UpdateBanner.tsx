import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { X, Download, Loader2, RefreshCw } from 'lucide-react'

// Mirrors Settings -> Engine tracker's own "Update (N)" action for the
// llama-cpp tracked backend: every already-installed build that's now
// outdated gets updated in one click, no per-click asset-type choice (that
// choice was already made whenever each build was originally installed --
// see the Tracker, which is also where a *new* type gets added). The old
// version of this banner offered a single-type picker + Download button,
// which is the older single-type-per-backend model this app has since
// moved away from.
function LlamaUpdateBanner() {
  const {
    releaseInfo, updateDismissed, setUpdateDismissed, downloadProgress, setDownloadProgress,
    setBackends, setTrackerResult
  } = useStore()
  const [updating, setUpdating] = useState(false)

  // .status is populated here despite the ReleaseInfo type not declaring it
  // -- see App.tsx's onBackendsCheckedSilent, which builds releaseInfo from
  // the llama-cpp TrackedBackendRelease result (status included) with just
  // trackedId/folderName stripped off.
  const outdatedAssets = (releaseInfo?.assets || []).filter(a => (a as { status?: string }).status === 'outdated')
  const notifPref = localStorage.getItem('hexllama_update_notify') || 'banner'
  if (!releaseInfo || releaseInfo.error || updateDismissed || releaseInfo.isNewer === false || notifPref === 'manual' || outdatedAssets.length === 0) return null

  // Keyed the same way the Tracker keys its own progress map, so this
  // banner and the Tracker never disagree about the same download's state.
  const busyAssets = outdatedAssets.map(a => ({ asset: a, progress: downloadProgress[`llama-cpp::${a.name}`] }))
  const anyBusy = updating || busyAssets.some(b => b.progress)

  async function handleUpdate() {
    setUpdating(true)
    await Promise.all(outdatedAssets.map(async asset => {
      const res = await window.api.downloadRelease({
        url: asset.downloadUrl,
        version: releaseInfo!.tagName,
        assetName: asset.name,
        backendKey: 'llama.cpp',
        trackedId: 'llama-cpp'
      })
      setDownloadProgress(`llama-cpp::${asset.name}`, null)
      return res
    }))
    setUpdating(false)
    const backendsData = await window.api.listBackends()
    setBackends(backendsData)
    const updated = await window.api.checkTrackedBackend('llama-cpp')
    if (!('error' in updated)) setTrackerResult(updated)
    else setUpdateDismissed(true)
  }

  function handleCancel() {
    outdatedAssets.forEach(a => {
      window.api.cancelBackendDownload('llama-cpp', a.name)
      setDownloadProgress(`llama-cpp::${a.name}`, null)
    })
    setUpdating(false)
  }

  const busyLabel = busyAssets.find(b => b.progress)?.progress
  const busyText = !busyLabel ? 'Updating…'
    : busyLabel.phase === 'queued' ? `Queued (#${busyLabel.queuePosition || 1})`
    : busyLabel.phase === 'extracting' ? 'Extracting...'
    : `Downloading... ${busyLabel.percent || 0}%`

  return (
    <div className="update-banner">
      {anyBusy ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
      <span>
        <strong>{releaseInfo.name || releaseInfo.tagName}</strong> is available —{' '}
        <button onClick={() => window.api.openExternal(releaseInfo.url)}>
          View release
        </button>
        {' '}·{' '}
        {anyBusy ? (
          <span style={{ opacity: 0.8 }}>{busyText}</span>
        ) : (
          <button
            onClick={handleUpdate}
            title={`Update ${outdatedAssets.length} installed build${outdatedAssets.length === 1 ? '' : 's'}`}
          >
            <RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
            Update ({outdatedAssets.length})
          </button>
        )}
      </span>
      {anyBusy ? (
        <button className="dismiss text-danger" onClick={handleCancel} title="Cancel Download">
          Cancel
        </button>
      ) : (
        <button className="dismiss" onClick={() => setUpdateDismissed(true)} title="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  )
}

// Git-installed engines (Strata) are updated by pulling the clone, so they
// have no assets to list: the notice names the new release tag and offers the
// same update the Engine tracker has. Dismissal is per release tag.
function GitEngineBanner() {
  const { trackedBackends, trackerResults, setBackends, setTrackerResult } = useStore()
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({})
  // Several engines can update at the same time, each with its own state.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<Record<string, string>>({})
  const notifPref = localStorage.getItem('hexllama_update_notify') || 'banner'
  if (notifPref === 'manual') return null
  const pending = trackedBackends.filter(t => {
    const g = trackerResults[t.id]?.git
    return t.kind === 'git' && g?.updateAvailable && !dismissed[`${t.id}@${g.latestTag}`]
  })
  if (pending.length === 0) return null

  async function update(id: string) {
    setBusy(b => ({ ...b, [id]: true }))
    const res = await window.api.updateGitEngine(id)
    if (!res.success) setError(e => ({ ...e, [id]: res.error || 'Update failed' }))
    setBackends(await window.api.listBackends())
    const checked = await window.api.checkTrackedBackend(id)
    if (!('error' in checked)) setTrackerResult(checked)
    setBusy(b => { const n = { ...b }; delete n[id]; return n })
  }

  return (
    <>
      {pending.map(t => {
        const g = trackerResults[t.id]!.git!
        return (
          <div className="update-banner" key={t.id}>
            {busy[t.id] ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
            <span>
              <strong>{t.name} {g.latestTag}</strong> is available (installed {g.localVersion}) |{' '}
              <button onClick={() => window.api.openExternal(trackerResults[t.id]!.url)}>View release</button>
              {' '}|{' '}
              {busy[t.id] ? <span style={{ opacity: 0.8 }}>Updating...</span> : (
                <button onClick={() => update(t.id)} title="git fetch and fast-forward to the upstream branch">
                  <RefreshCw size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                  Update
                </button>
              )}
              {error[t.id] && <span style={{ color: 'var(--danger)', marginLeft: 8 }}>{error[t.id]}</span>}
            </span>
            <button className="dismiss" onClick={() => setDismissed(d => ({ ...d, [`${t.id}@${g.latestTag}`]: true }))} title="Dismiss">
              <X size={14} />
            </button>
          </div>
        )
      })}
    </>
  )
}

export default function UpdateBanner() {
  return (
    <>
      <LlamaUpdateBanner />
      <GitEngineBanner />
    </>
  )
}

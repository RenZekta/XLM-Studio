import React, { useEffect } from 'react'
import { useStore } from './store/useStore'
import Titlebar from './components/Titlebar'
import Sidebar from './components/Sidebar'
import CardsView from './components/CardsView'
import SettingsView from './components/SettingsView'
import HuggingFaceView from './components/HuggingFaceView'
import ModelsView from './components/ModelsView'
import AboutView from './components/AboutView'
import LogsView from './components/LogsView'
import OverridesView from './components/OverridesView'
import MonitoringView from './components/MonitoringView'
import CreateModal from './components/CreateModal'
import UpdateBanner from './components/UpdateBanner'
import ChatWindow from './components/ChatWindow'
import MetadataExtractionToast from './components/MetadataExtractionToast'
import { buildDefaultTemplate } from './utils/defaultTemplate'
import { phrases } from './utils/phrases'
import { useTheme } from './hooks/useTheme'
import type { Template } from '../../shared/types'

export default function App() {
  const searchParams = new URLSearchParams(window.location.search)
  const chatUrl = searchParams.get('chat_url')

  if (chatUrl) {
    return <ChatWindow url={chatUrl} />
  }

  // Initialise theme system (system / dark / light), default = system, fallback = dark.
  useTheme()

  const [loading, setLoading] = React.useState(true)
  const [phraseIndex, setPhraseIndex] = React.useState(0)

  React.useEffect(() => {
    const timer = setTimeout(() => setLoading(false), 2000)
    const interval = setInterval(() => {
      setPhraseIndex((prev) => (prev + 1) % phrases.length)
    }, 500)
    window.api?.getVersion?.().then((v) => console.log('XLM Studio version:', v)).catch(() => {})
    return () => { clearTimeout(timer); clearInterval(interval) }
  }, [])

  const {
    view, showCreateModal, activeBackend,
    setBackends, setModels, setActiveBackend, setCommandsSchema,
    setCards, setPaths, setReleaseInfo, setCheckingUpdate,
    setHfDownload, removeHfDownload,
    upsertModelDownload, removeModelDownload,
    setExternalModelFolders, setExternalBackendFolders,
    setMainModelFolder, setMainBackendFolder,
    setTrackedBackends, setCpuInfo,
    setVramInfo, setSystemRam, setModelDefaults, setBaseUrlOverride, setSamplingPresets,
    setTrackerResult,
    setGgufMetadataBulk, setGgufMetadata, setMetadataExtraction, clearMetadataExtraction
  } = useStore()

  useEffect(() => {
    async function init() {
      try {
        const [paths, backendsData, modelsData, extModelFolders, extBackendFolders, tracked] = await Promise.all([
          window.api.getPaths(),
          window.api.listBackends(),
          window.api.listModels(),
          window.api.listExternalModelFolders(),
          window.api.listExternalBackendFolders(),
          window.api.listTrackedBackends()
        ])
        setPaths(paths)
        setBackends(backendsData)
        setModels(modelsData)
        // Bulk-load the GGUF metadata cache so metadata is instantly
        // available for every detected model (no re-extraction on view).
        try {
          const cache = await window.api?.getMetadataCache?.()
          if (cache && typeof cache === 'object') setGgufMetadataBulk(cache)
        } catch {}
        // Trigger background extraction for any detected model that
        // isn't yet in the cache. The main process caches + broadcasts the
        // result; we show a "extracting…" notification meanwhile.
        try {
          const allPaths: string[] = []
          for (const g of modelsData) for (const m of g.models) allPaths.push(m.path)
          const cached = useStore.getState().ggufMetadata
          for (const p of allPaths) {
            if (!cached[p]) {
              // Fire-and-forget — the onMetadataExtracting listener shows the
              // notification; onGgufMetadataUpdated populates the store.
              window.api?.getGgufMetadata?.(p).catch(() => {})
            }
          }
        } catch {}
        setExternalModelFolders(extModelFolders)
        setExternalBackendFolders(extBackendFolders)
        setTrackedBackends(tracked)
        // Resolve which folder is currently starred.
        try {
          const mm = await window.api.getMainModelFolder()
          setMainModelFolder(mm.isDefault ? null : mm.folder)
        } catch {}
        try {
          const mb = await window.api.getMainBackendFolder()
          setMainBackendFolder(mb.isDefault ? null : mb.folder)
        } catch {}
        if (backendsData.length > 0) {
          setActiveBackend(backendsData[0])
          const cmds = await window.api.getCommands(backendsData[0].backendKey)
          if (cmds) setCommandsSchema(cmds)
        } else {
          const cmds = await window.api.getCommands('')
          if (cmds) setCommandsSchema(cmds)
        }
        const templates = await window.api.listTemplates()
        setCards(
          (templates as Template[]).map((t) => ({
            template: t,
            status: 'idle',
            expanded: false
          }))
        )
      } catch (e) {
        console.error('Init error:', e)
      }
      // Load CPU info for thread slider bounds + recommended defaults.
      try { setCpuInfo(await window.api?.getCpuInfo?.()) } catch {}
      // Load VRAM + system RAM for the budgeting algorithm.
      try { setVramInfo(await window.api?.getVramInfo?.()) } catch {}
      try { setSystemRam(await window.api?.getSystemRam?.()) } catch {}
      // Load model defaults + base URL override + sampling presets (features 18/24/28).
      try { setModelDefaults(await window.api?.getModelDefaults?.()) } catch {}
      try { setBaseUrlOverride(await window.api?.getBaseUrlOverride?.()) } catch {}
      try { setSamplingPresets(await window.api?.listSamplingPresets?.()) } catch {}
      checkUpdates()
    }
    init()

    // Listen for silent backend check results broadcast on startup.
    try {
      window.api?.onBackendsCheckedSilent?.((data: any) => {
        if (data?.results) {
          for (const r of data.results) setTrackerResult(r)
          // Sync legacy releaseInfo with llama.cpp for the UpdateBanner.
          const llama = data.results.find((r: any) => r.trackedId === 'llama-cpp')
          if (llama) {
            const { trackedId, folderName, ...rest } = llama
            useStore.getState().setReleaseInfo(rest as any)
          }
        }
      })
    } catch {}

    window.api.onModelError((data) => {
      useStore.getState().setCardStatus(data.id, 'error')
      alert(`Model execution error:\n\n${data.error}`)
    })
    window.api.onModelExited((data) => {
      const s = useStore.getState()
      const card = s.cards.find(c => c.template.id === data.id)
      if (card && card.status === 'running') s.setCardStatus(data.id, 'idle')
    })

    // Refresh the backends list when the main process reports a change
    // (e.g. after auto-cleanup of outdated backend versions on update).
    try {
      window.api?.onBackendsChanged?.(async () => {
        const updated = await window.api.listBackends()
        useStore.getState().setBackends(updated)
      })
    } catch {}

    // Metadata extraction lifecycle — show "extracting…" notification
    // and populate the store when the main process finishes caching.
    try {
      window.api?.onMetadataExtracting?.((data) => {
        if (data.status === 'extracting') {
          setMetadataExtraction(data.modelPath, data.name, 'extracting')
        } else {
          // done/error → clear the notification (the store auto-clears on
          // done/error, but we call it to be explicit).
          clearMetadataExtraction(data.modelPath)
        }
      })
    } catch {}
    try {
      window.api?.onGgufMetadataUpdated?.((data) => {
        setGgufMetadata(data.modelPath, data.meta)
      })
    } catch {}

    // Register the server-log listener ONCE here at the App
    // root (not inside LogsView, which used to only listen while mounted —
    // losing every log line that arrived while the user was on another tab).
    // appendLog writes into the global store, so logs now persist for the
    // life of the app regardless of which view is active.
    try {
      window.api?.onServerLog?.((data) => {
        useStore.getState().appendLog(data as any)
      })
    } catch {}

    // Poll Free VRAM + Free RAM every 10s so the VRAM banner + the
    // Automatic Context Fill calculator always use the freshest memory data.
    // Without this, memory figures would be stale from the single init fetch.
    const memPoll = setInterval(async () => {
      try { setVramInfo(await window.api?.getVramInfo?.()) } catch {}
      try { setSystemRam(await window.api?.getSystemRam?.()) } catch {}
    }, 10000)
    return () => clearInterval(memPoll)
  }, [])

  useEffect(() => {
    window.api.onHfDownloadProgress(async (data) => {
      upsertModelDownload({
        id: (data as any).id || data.filename,
        url: '',
        filename: data.filename,
        destPath: data.destPath,
        receivedBytes: (data as any).receivedBytes ?? 0,
        totalBytes: (data as any).totalBytes ?? 0,
        speed: (data as any).speed ?? 0,
        percent: data.percent,
        phase: data.phase as any,
        repoId: (data as any).repoId
      })

      if (data.phase === 'done') {
        setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'saving' })
        const models = await window.api.listModels()
        useStore.getState().setModels(models)
        setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'creating_template' })
        const { cards, activeBackend: backend, addCard: add } = useStore.getState()
        const template = buildDefaultTemplate(
          data.filename,
          data.destPath,
          cards.map(c => c.template),
          backend?.name || ''
        )
        const res = await window.api.saveTemplate(template)
        if (res.success) add({ ...template, id: res.id })
        setHfDownload({ repoId: '', filename: data.filename, percent: 100, phase: 'done' })
        setTimeout(() => removeHfDownload(data.filename), 2500)
      } else {
        setHfDownload({
          repoId: '',
          filename: data.filename,
          percent: data.percent,
          phase: data.phase as any,
          speed: (data as any).speed
        })
      }
    })
    return () => window.api.removeHfDownloadListener()
  }, [])

  useEffect(() => {
    window.api.onModelDownloadProgress(async (data: any) => {
      if (data.repoId) return
      upsertModelDownload(data)
      if (data.phase === 'done') {
        const models = await window.api.listModels()
        useStore.getState().setModels(models)
        const { cards, activeBackend: backend, addCard: add } = useStore.getState()
        const template = buildDefaultTemplate(
          data.filename,
          data.destPath,
          cards.map(c => c.template),
          backend?.name || ''
        )
        const res = await window.api.saveTemplate(template)
        if (res.success) add({ ...template, id: res.id })
        setTimeout(() => removeModelDownload(data.id), 4000)
      }
    })
    window.api.listModelDownloads().then(list => {
      list.forEach((dl: any) => upsertModelDownload(dl))
    })
    return () => window.api.removeModelDownloadListener()
  }, [])

  useEffect(() => {
    if (!activeBackend) return
    window.api.getCommands(activeBackend.backendKey).then((cmds) => {
      if (cmds) setCommandsSchema(cmds)
    })
  }, [activeBackend, setCommandsSchema])

  useEffect(() => {
    window.api.onDownloadProgress((data) => {
      useStore.getState().setDownloadProgress(data)
    })
    return () => window.api.removeDownloadListener()
  }, [])

  async function checkUpdates() {
    setCheckingUpdate(true)
    try {
      const info = await window.api.checkUpdates()
      setReleaseInfo(info)
    } finally {
      setCheckingUpdate(false)
    }
  }

  function renderView() {
    if (view === 'hub') return <HuggingFaceView />
    if (view === 'settings') return <SettingsView />
    if (view === 'models') return <ModelsView />
    if (view === 'logs') return <LogsView />
    if (view === 'monitoring') return <MonitoringView />
    if (view === 'overrides') return <OverridesView />
    if (view === 'about') return <AboutView />
    return <CardsView />
  }

  if (loading) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 9999,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text)'
      }}>
        <style dangerouslySetInnerHTML={{ __html: `
          @keyframes pixelateSplashIn {
            0% { opacity: 0; transform: scale(0.5); filter: blur(12px) contrast(200%); }
            40% { opacity: 0.5; transform: scale(0.75); filter: blur(6px) contrast(150%); }
            75% { opacity: 0.85; transform: scale(0.9); filter: blur(2px) contrast(120%); }
            100% { opacity: 1; transform: scale(1); filter: blur(0) contrast(100%); }
          }
        `}} />
        <img
          src="./icon.png"
          alt="XLM Studio Icon"
          style={{
            width: 96, height: 96, marginBottom: 24,
            animation: 'pixelateSplashIn 1.5s steps(8) forwards',
            imageRendering: 'pixelated'
          }}
          draggable={false}
        />
        <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '0.5px', minHeight: 28 }}>
          {phrases[phraseIndex]}
        </h2>
      </div>
    )
  }

  return (
    <div className="app">
      <Titlebar />
      <UpdateBanner />
      <div className="main-layout">
        <Sidebar />
        <main className="content">
          {renderView()}
        </main>
      </div>
      {showCreateModal && <CreateModal />}
      <MetadataExtractionToast />
    </div>
  )
}

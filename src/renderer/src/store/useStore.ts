import { create } from 'zustand'
import { setBackendKeyAliases } from '../../../shared/backendPin'
import type { EngineId } from '../../../shared/engines'
import {
  activeLayoutPreset, addLayoutPreset, defaultLayoutId, deleteLayoutPreset, findLayoutPreset, isDefaultLayoutId,
  newLayoutPresetId, parseLayoutLibrary, setActiveLayout, shownLayout, updateLayoutPreset,
  type LayoutLibrary, type ParamLayout
} from '../../../shared/paramLayout'
import type {
  Template, TemplateFolder, BackendVersion, CommandsSchema, ReleaseInfo, RunningStatus,
  ModelGroup, TrackedBackend, TrackedBackendRelease, ThemePref, SpecDetectionResult,
  KvCacheCheckpointSettings
} from '../../../shared/types'

let backendSwitchSeq = 0

const LAYOUT_LIBRARY_KEY = 'xlm_param_layouts'
// An earlier version kept one layout for every Template.
const LEGACY_LAYOUT_KEY = 'hexllama_param_layout'

function loadLayoutLibrary(): LayoutLibrary {
  try {
    return parseLayoutLibrary(localStorage.getItem(LAYOUT_LIBRARY_KEY), localStorage.getItem(LEGACY_LAYOUT_KEY))
  } catch {
    return parseLayoutLibrary(null, null)
  }
}

function storeLayoutLibrary(lib: LayoutLibrary) {
  try {
    localStorage.setItem(LAYOUT_LIBRARY_KEY, JSON.stringify(lib))
    localStorage.removeItem(LEGACY_LAYOUT_KEY)
  } catch {}
}
// Monotonic id handed to each log entry, so the Logs list can key rows on
// something stable while the 10000-entry cap drops lines off the front.
let logSeq = 0

interface CardState {
  template: Template
  status: RunningStatus
  pid?: number
  expanded: boolean
  tempPort?: number
}

export interface ModelDownloadInfo {
  id: string; url: string; filename: string; destPath: string
  receivedBytes: number; totalBytes: number
  phase: 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  percent: number; repoId?: string; speed?: number; error?: string; queuePosition?: number
}

// Edit Layout of one Template's parameter list. `draft` is null until something is moved, and
// the layout shown is then the preset's own.
export interface LayoutEdit {
  templateId: string
  engine: EngineId
  presetId: string
  draft: ParamLayout | null
  compact: boolean
}

interface AppStore {
  cards: CardState[]
  backends: BackendVersion[]
  models: ModelGroup[]
  activeBackend: BackendVersion | null
  // The global selection (a repo) of every engine except llama.cpp, whose
  // selection is activeBackend.
  engineGlobals: Partial<Record<EngineId, { backendKey: string }>>
  commandsSchema: CommandsSchema | null
  releaseInfo: ReleaseInfo | null
  paths: { models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string } | null
  // Folders of the Templates page and the one currently open (null = top level).
  templateFolders: TemplateFolder[]
  currentFolderId: string | null
  view: 'cards' | 'settings' | 'hub' | 'models' | 'about' | 'logs' | 'overrides' | 'monitoring'
  showCreateModal: boolean
  editingTemplate: Template | null
  prefillModelPath: string | null
  updateDismissed: boolean
  checkingUpdate: boolean
  // Keyed by `${trackedId}::${assetName}` (a single tracked backend can have
  // several of its own variants queued/downloading at once -- see
  // ipc.ts's downloadQueue) so simultaneous downloads/queue positions for
  // different backends AND different variants of the same backend don't
  // clobber each other's progress display.
  downloadProgress: Record<string, { percent: number; phase: string; queuePosition?: number }>
  // Git engines being updated right now, whoever started it (a row's button,
  // Update all, or the startup auto-update).
  engineUpdating: Record<string, boolean>
  templateSearch: string
  modelDownloads: Record<string, ModelDownloadInfo>
  hubQuery: string
  hubResults: any[]
  hubSelectedModelId: string | null
  hubSort: string
  hubDirection: number
  compactSidebarEnabled: boolean

  // New state for feature groups
  externalModelFolders: string[]
  externalBackendFolders: string[]
  mainModelFolder: string | null
  mainBackendFolder: string | null
  trackedBackends: TrackedBackend[]
  trackerResults: Record<string, TrackedBackendRelease>
  checkingAllBackends: boolean
  theme: ThemePref
  systemTheme: 'dark' | 'light'
  expandedModelGroups: Record<string, boolean>
  // Split models shown as one file per shard instead of one entry, by set key.
  ungroupedShardSets: Record<string, boolean>
  cpuInfo: { physicalCores: number; logicalCores: number; modelName: string } | null
  detectedSpeculation: Record<string, SpecDetectionResult>
  speculationApplied: Record<string, boolean>
  // New state for features 12-34
  ggufMetadata: Record<string, any>  // keyed by modelPath
  // Per-model metadata extraction status (for the "extracting…" notification).
  metadataExtractions: Record<string, { name: string; status: 'extracting' | 'done' | 'error' }>
  vramInfo: { freeVRAMMB: number; totalVRAMMB: number; hasNvidia: boolean; gpuName: string | null; vendor?: string | null; gpuType?: string | null } | null
  systemRam: { totalRAMMB: number; freeRAMMB: number } | null
  modelDefaults: { autoFitEnabled: boolean; autoFitContextLength: number; guardrailMode: string; customMaxSizeGB: number; useCurrentMemState?: boolean; moeOffloadStrategy?: 'offload' | 'max'; autoFitUse2xIncrements?: boolean; autoFitYarnAutoScale?: boolean; autoEnableMmproj?: boolean; mmprojOffloadToRam?: boolean; cpuThreadsOverrideEnabled?: boolean; cpuThreadsOverridePercent?: number; parallelOverrideEnabled?: boolean; parallelInferenceMode?: 'unified' | 'separate'; parallelOverrideValue?: number; parallelOverrideValueDense?: number; parallelOverrideValueMoe?: number; perfMaxSessions?: number; autoOpenChatUI?: boolean }
  baseUrlOverride: { enabled: boolean; port: number; serveOnLocalNetwork: boolean; apiKeyEnabled: boolean; apiKey: string }
  kvCacheCheckpoints: KvCacheCheckpointSettings
  samplingPresets: any[]
  paramViewMode: 'common' | 'full'
  quickBaselineActive: boolean      // tracks if Quick preset is the active baseline
  // 3-way preset mode. 'clear' = empty, 'quick' = LM Studio baselines,
  // 'fullauto' = Quick baselines + Ignore-Context-Override + Auto-Context-Fill ON.
  presetMode: 'clear' | 'quick' | 'fullauto'

  // Logs live in the global store, populated by a listener registered once
  // at App root, so they persist until the app is closed or cleared
  // manually — a listener scoped to LogsView's own mount would lose every
  // log that arrived while the view wasn't mounted, not just hide them.
  logs: { id: string; name: string; stream: 'stdout' | 'stderr' | 'app'; line: string; ts: number; seq?: number }[]

  // Saved parameter layouts (per engine) and the Edit Layout session, if any.
  layoutLibrary: LayoutLibrary
  layoutEdit: LayoutEdit | null
  // A request for a new group at this screen height, taken up by the list being edited.
  layoutGroupRequest: { y: number; id: number } | null
  requestLayoutGroup: (y: number) => void
  clearLayoutGroupRequest: () => void
  startLayoutEdit: (templateId: string, engine: EngineId) => void
  setLayoutDraft: (draft: ParamLayout) => void
  setLayoutCompact: (compact: boolean) => void
  selectLayoutPreset: (id: string) => void
  // Saves the layout as shown under a new name and switches the edit to it.
  createLayoutPreset: (name: string) => void
  renameLayoutPreset: (id: string, name: string) => void
  removeLayoutPreset: (id: string) => void
  // The built-in Default cannot be overwritten, so saving it needs a name for a new preset.
  layoutSaveNeedsName: () => boolean
  saveLayoutEdit: (name?: string) => void
  cancelLayoutEdit: () => void

  setCompactSidebarEnabled: (enabled: boolean) => void
  setView: (v: AppStore['view']) => void
  setTemplateFolders: (f: TemplateFolder[]) => void
  setCurrentFolderId: (id: string | null) => void
  setShowCreateModal: (show: boolean, template?: Template | null) => void
  setPrefillModelPath: (path: string | null) => void
  setActiveBackend: (b: BackendVersion) => void
  setEngineGlobals: (g: Partial<Record<EngineId, { backendKey: string }>>) => void
  switchBackend: (b: BackendVersion) => Promise<void>
  setCommandsSchema: (s: CommandsSchema) => void
  setBackends: (b: BackendVersion[]) => void
  setModels: (m: ModelGroup[]) => void
  setCards: (c: CardState[]) => void
  setReleaseInfo: (r: ReleaseInfo | null) => void
  setPaths: (p: { models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string }) => void
  setUpdateDismissed: (v: boolean) => void
  setCheckingUpdate: (v: boolean) => void
  setEngineUpdating: (trackedId: string, busy: boolean) => void
  setDownloadProgress: (trackedId: string, data: { percent: number; phase: string; queuePosition?: number } | null) => void
  setTemplateSearch: (q: string) => void
  upsertModelDownload: (d: ModelDownloadInfo) => void
  removeModelDownload: (id: string) => void
  setHubQuery: (q: string) => void
  setHubResults: (r: any[]) => void
  setHubSelectedModelId: (id: string | null) => void
  setHubSort: (s: string) => void
  setHubDirection: (d: number) => void
  addCard: (template: Template) => void
  updateCard: (id: string, template: Partial<Template>) => void
  removeCard: (id: string) => void
  setCardStatus: (id: string, status: RunningStatus, pid?: number, tempPort?: number) => void
  toggleCardExpanded: (id: string) => void
  collapseAllCards: () => void

  setExternalModelFolders: (f: string[]) => void
  setExternalBackendFolders: (f: string[]) => void
  setMainModelFolder: (f: string | null) => void
  setMainBackendFolder: (f: string | null) => void
  setTrackedBackends: (t: TrackedBackend[]) => void
  setTrackerResult: (r: TrackedBackendRelease) => void
  setCheckingAllBackends: (v: boolean) => void
  setTheme: (t: ThemePref) => void
  setSystemTheme: (t: 'dark' | 'light') => void
  toggleModelGroup: (folderPath: string) => void
  toggleShardSetGrouping: (setKey: string) => void
  setCpuInfo: (info: { physicalCores: number; logicalCores: number; modelName: string } | null) => void
  setDetectedSpeculation: (modelPath: string, result: SpecDetectionResult) => void
  markSpeculationApplied: (templateId: string, applied: boolean) => void
  setGgufMetadata: (modelPath: string, meta: any) => void
  setGgufMetadataBulk: (cache: Record<string, any>) => void
  // Wipes the renderer's in-memory metadata cache — the "Reextract
  // models' data" button calls this right after clearing the persisted
  // main-process cache, so nothing stale lingers in either place.
  clearGgufMetadataAll: () => void
  setMetadataExtraction: (modelPath: string, name: string, status: 'extracting' | 'done' | 'error') => void
  clearMetadataExtraction: (modelPath: string) => void
  setVramInfo: (info: any) => void
  setSystemRam: (info: { totalRAMMB: number; freeRAMMB: number }) => void
  setModelDefaults: (defaults: any) => void
  setBaseUrlOverride: (opts: any) => void
  setKvCacheCheckpoints: (opts: KvCacheCheckpointSettings) => void
  setSamplingPresets: (presets: any[]) => void
  setParamViewMode: (mode: 'common' | 'full') => void
  setQuickBaselineActive: (active: boolean) => void
  setPresetMode: (mode: 'clear' | 'quick' | 'fullauto') => void
  // Global log actions — appendLogs is called by the App-root
  // listener with the server-log IPC events collected since its last flush (so
  // logs accumulate regardless of which tab is active); clearLogs is the
  // manual "Clear" button.
  appendLogs: (entries: { id: string; name: string; stream: 'stdout' | 'stderr' | 'app'; line: string; ts: number }[]) => void
  clearLogs: () => void
  // Which source the Logs view shows ('all', a running Template or an engine
  // build); kept here so it survives switching to another tab and back.
  logsSource: string
  setLogsSource: (source: string) => void
}

export const useStore = create<AppStore>((set, get) => ({
  cards: [], backends: [], models: [], activeBackend: null, engineGlobals: {},
  commandsSchema: null, releaseInfo: null, paths: null,
  templateFolders: [], currentFolderId: null,
  view: 'cards', showCreateModal: false, editingTemplate: null, prefillModelPath: null,
  updateDismissed: false, checkingUpdate: false, downloadProgress: {}, engineUpdating: {},
  templateSearch: '', modelDownloads: {},
  hubQuery: '', hubResults: [], hubSelectedModelId: null, hubSort: 'downloads', hubDirection: -1,
  compactSidebarEnabled: localStorage.getItem('compactSidebar') === 'true',

  externalModelFolders: [],
  externalBackendFolders: [],
  mainModelFolder: null,
  mainBackendFolder: null,
  trackedBackends: [],
  trackerResults: {},
  checkingAllBackends: false,
  theme: (localStorage.getItem('hexllama_theme') as ThemePref) || 'system',
  systemTheme: 'dark',
  expandedModelGroups: {},
  ungroupedShardSets: {},
  cpuInfo: null,
  detectedSpeculation: {},
  speculationApplied: {},
  ggufMetadata: {},
  metadataExtractions: {},
  vramInfo: null,
  systemRam: null,
  modelDefaults: { autoFitEnabled: true, autoFitContextLength: 60000, guardrailMode: 'strict', customMaxSizeGB: 0, useCurrentMemState: true, moeOffloadStrategy: 'max' /* default to MAX+ForceMoEtoCPU */, autoEnableMmproj: true, mmprojOffloadToRam: true, cpuThreadsOverrideEnabled: false, cpuThreadsOverridePercent: 50, parallelOverrideEnabled: false, parallelInferenceMode: 'unified', parallelOverrideValue: 4, parallelOverrideValueDense: 4, parallelOverrideValueMoe: 4, perfMaxSessions: 20, autoOpenChatUI: false },
  baseUrlOverride: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: false, apiKey: '' },
  kvCacheCheckpoints: { enabled: false, mode: 'model', autoDeleteRedundant: false, externalFolders: [], mainFolder: null },
  samplingPresets: [],
  paramViewMode: 'common',
  quickBaselineActive: true,  // Quick settings is the default baseline
  presetMode: 'quick',        // default to Quick (matches quickBaselineActive)
  logs: [],
  logsSource: 'all',
  layoutLibrary: loadLayoutLibrary(),
  layoutEdit: null,
  layoutGroupRequest: null,

  setCompactSidebarEnabled: (enabled) => {
    localStorage.setItem('compactSidebar', String(enabled))
    set({ compactSidebarEnabled: enabled })
  },
  setView: (v) => set({ view: v }),
  setTemplateFolders: (f) => set({ templateFolders: f }),
  setCurrentFolderId: (id) => set({ currentFolderId: id }),
  setShowCreateModal: (show, template = null) => set({ showCreateModal: show, editingTemplate: template }),
  setPrefillModelPath: (path) => set({ prefillModelPath: path }),
  setActiveBackend: (b) => set({ activeBackend: b }),
  setEngineGlobals: (g) => set({ engineGlobals: g }),
  // The active backend and the commands schema describe the same thing and
  // must change in one update: the KV cache defaults and option lists are
  // derived from the pair, so a window where only one has changed shows (and
  // briefly applies) values that don't belong to either backend. The schema
  // is fetched first; a response that arrives after a newer switch started is
  // dropped so rapid clicks can't leave the older backend's schema behind.
  switchBackend: async (b) => {
    const seq = ++backendSwitchSeq
    let schema: CommandsSchema | null = null
    try { schema = await window.api.getCommands(b.backendKey) } catch {}
    if (seq !== backendSwitchSeq) return
    set(schema ? { activeBackend: b, commandsSchema: schema } : { activeBackend: b })
  },
  setCommandsSchema: (s) => set({ commandsSchema: s }),
  setBackends: (b) => set({ backends: b }),
  setModels: (m) => set({ models: m }),
  setCards: (c) => set({ cards: c }),
  setReleaseInfo: (r) => set({ releaseInfo: r }),
  setPaths: (p) => set({ paths: p }),
  setUpdateDismissed: (v) => set({ updateDismissed: v }),
  setCheckingUpdate: (v) => set({ checkingUpdate: v }),
  setEngineUpdating: (trackedId, busy) => set((s) => {
    if (!!s.engineUpdating[trackedId] === busy) return {}
    const next = { ...s.engineUpdating }
    if (busy) next[trackedId] = true
    else delete next[trackedId]
    return { engineUpdating: next }
  }),
  setDownloadProgress: (trackedId, data) => set((s) => {
    if (data === null) {
      if (!(trackedId in s.downloadProgress)) return {}
      const next = { ...s.downloadProgress }
      delete next[trackedId]
      return { downloadProgress: next }
    }
    const prev = s.downloadProgress[trackedId]
    if (prev && prev.percent === data.percent && prev.phase === data.phase && prev.queuePosition === data.queuePosition) return {}
    return { downloadProgress: { ...s.downloadProgress, [trackedId]: data } }
  }),
  setTemplateSearch: (q) => set({ templateSearch: q }),
  upsertModelDownload: (d) => set((s) => ({ modelDownloads: { ...s.modelDownloads, [d.id]: d } })),
  removeModelDownload: (id) => set((s) => {
    const next = { ...s.modelDownloads }; delete next[id]; return { modelDownloads: next }
  }),
  setHubQuery: (q) => set({ hubQuery: q }),
  setHubResults: (r) => set({ hubResults: r }),
  setHubSelectedModelId: (id) => set({ hubSelectedModelId: id }),
  setHubSort: (s) => set({ hubSort: s }),
  setHubDirection: (d) => set({ hubDirection: d }),
  addCard: (template) => set((s) => ({ cards: [...s.cards, { template, status: 'idle', expanded: false }] })),
  updateCard: (id, partial) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, template: { ...c.template, ...partial, updatedAt: new Date().toISOString() } } : c)
  })),
  removeCard: (id) => set((s) => ({ cards: s.cards.filter(c => c.template.id !== id) })),
  setCardStatus: (id, status, pid, tempPort) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? {
      ...c,
      status,
      pid: status === 'idle' || status === 'error' ? undefined : (pid ?? c.pid),
      tempPort: status === 'idle' || status === 'error' ? undefined : (tempPort ?? c.tempPort)
    } : c)
  })),
  toggleCardExpanded: (id) => set((s) => ({
    cards: s.cards.map(c => c.template.id === id ? { ...c, expanded: !c.expanded } : c)
  })),
  collapseAllCards: () => set((s) => ({ cards: s.cards.map(c => ({ ...c, expanded: false })) })),

  setExternalModelFolders: (f) => set({ externalModelFolders: f }),
  setExternalBackendFolders: (f) => set({ externalBackendFolders: f }),
  setMainModelFolder: (f) => set({ mainModelFolder: f }),
  setMainBackendFolder: (f) => set({ mainBackendFolder: f }),
  setTrackedBackends: (t) => { setBackendKeyAliases(t); set({ trackedBackends: t }) },
  // The update banner reads releaseInfo, which mirrors the llama.cpp tracker
  // result; keeping them in one setter means every refresh path (Settings
  // tracker, banner, startup check) closes or opens the banner consistently.
  setTrackerResult: (r) => set((s) => {
    const trackerResults = { ...s.trackerResults, [r.trackedId]: r }
    if (r.trackedId !== 'llama-cpp') return { trackerResults }
    const { trackedId: _id, folderName: _folder, ...releaseInfo } = r
    return { trackerResults, releaseInfo }
  }),
  setCheckingAllBackends: (v) => set({ checkingAllBackends: v }),
  setTheme: (t) => {
    localStorage.setItem('hexllama_theme', t)
    set({ theme: t })
  },
  setSystemTheme: (t) => set({ systemTheme: t }),
  toggleShardSetGrouping: (setKey) => set((s) => ({
    ungroupedShardSets: { ...s.ungroupedShardSets, [setKey]: !s.ungroupedShardSets[setKey] }
  })),
  toggleModelGroup: (folderPath) => set((s) => ({
    expandedModelGroups: { ...s.expandedModelGroups, [folderPath]: !s.expandedModelGroups[folderPath] }
  })),
  setCpuInfo: (info) => set({ cpuInfo: info }),
  setDetectedSpeculation: (modelPath, result) => set((s) => ({
    detectedSpeculation: { ...s.detectedSpeculation, [modelPath]: result }
  })),
  markSpeculationApplied: (templateId, applied) => set((s) => ({
    speculationApplied: { ...s.speculationApplied, [templateId]: applied }
  })),
  setGgufMetadata: (modelPath, meta) => set((s) => ({ ggufMetadata: { ...s.ggufMetadata, [modelPath]: meta } })),
  setGgufMetadataBulk: (cache) => set((s) => ({ ggufMetadata: { ...cache, ...s.ggufMetadata } })),
  clearGgufMetadataAll: () => set({ ggufMetadata: {} }),
  setMetadataExtraction: (modelPath, name, status) => set((s) => {
    if (status === 'done' || status === 'error') {
      // Auto-clear after done/error (the notification fades).
      const next = { ...s.metadataExtractions }
      delete next[modelPath]
      return { metadataExtractions: next }
    }
    return { metadataExtractions: { ...s.metadataExtractions, [modelPath]: { name, status } } }
  }),
  clearMetadataExtraction: (modelPath) => set((s) => {
    const next = { ...s.metadataExtractions }
    delete next[modelPath]
    return { metadataExtractions: next }
  }),
  setVramInfo: (info) => set({ vramInfo: info }),
  setSystemRam: (info) => set({ systemRam: info }),
  setModelDefaults: (defaults) => set({ modelDefaults: defaults }),
  setBaseUrlOverride: (opts) => set({ baseUrlOverride: opts }),
  setKvCacheCheckpoints: (opts) => set({ kvCacheCheckpoints: opts }),
  setSamplingPresets: (presets) => set({ samplingPresets: presets }),
  setParamViewMode: (mode) => set({ paramViewMode: mode }),
  setQuickBaselineActive: (active) => set({ quickBaselineActive: active }),
  setPresetMode: (mode) => set({ presetMode: mode, quickBaselineActive: mode !== 'clear' }),
  // Cap at 10000 entries to avoid unbounded memory growth
  // over a long-running session (LogsView still only shows the most recent
  // ones by default via its own filter, but the cap lives here now since this
  // is the single persistent source of truth for the whole app lifetime).
  appendLogs: (entries) => set((s) => {
    if (entries.length === 0) return {}
    const next = s.logs.concat(entries.map(e => ({ ...e, seq: ++logSeq })))
    return { logs: next.length > 10000 ? next.slice(-10000) : next }
  }),
  clearLogs: () => set({ logs: [] }),
  setLogsSource: (source) => set({ logsSource: source }),

  requestLayoutGroup: (y) => set((s) => s.layoutEdit ? { layoutGroupRequest: { y, id: (s.layoutGroupRequest?.id ?? 0) + 1 } } : {}),
  clearLayoutGroupRequest: () => set({ layoutGroupRequest: null }),
  startLayoutEdit: (templateId, engine) => set((s) => ({
    layoutGroupRequest: null,
    layoutEdit: { templateId, engine, presetId: activeLayoutPreset(s.layoutLibrary, engine).id, draft: null, compact: false }
  })),
  setLayoutDraft: (draft) => set((s) => s.layoutEdit ? { layoutEdit: { ...s.layoutEdit, draft } } : {}),
  setLayoutCompact: (compact) => set((s) => s.layoutEdit ? { layoutEdit: { ...s.layoutEdit, compact } } : {}),
  selectLayoutPreset: (id) => set((s) => s.layoutEdit ? { layoutEdit: { ...s.layoutEdit, presetId: id, draft: null } } : {}),
  createLayoutPreset: (name) => set((s) => {
    const edit = s.layoutEdit
    const label = name.trim()
    if (!edit || !label) return {}
    const preset = { id: newLayoutPresetId(), name: label, engine: edit.engine, layout: shownLayout(s.layoutLibrary, edit.engine, edit) }
    const layoutLibrary = addLayoutPreset(s.layoutLibrary, preset)
    storeLayoutLibrary(layoutLibrary)
    return { layoutLibrary, layoutEdit: { ...edit, presetId: preset.id, draft: null } }
  }),
  renameLayoutPreset: (id, name) => set((s) => {
    const label = name.trim()
    if (!label || isDefaultLayoutId(id)) return {}
    const layoutLibrary = updateLayoutPreset(s.layoutLibrary, id, { name: label })
    storeLayoutLibrary(layoutLibrary)
    return { layoutLibrary }
  }),
  removeLayoutPreset: (id) => set((s) => {
    if (isDefaultLayoutId(id)) return {}
    const layoutLibrary = deleteLayoutPreset(s.layoutLibrary, id)
    storeLayoutLibrary(layoutLibrary)
    const edit = s.layoutEdit
    if (edit && edit.presetId === id) {
      return { layoutLibrary, layoutEdit: { ...edit, presetId: defaultLayoutId(edit.engine), draft: null } }
    }
    return { layoutLibrary }
  }),
  layoutSaveNeedsName: () => {
    const edit = get().layoutEdit
    return !!edit && !!edit.draft && isDefaultLayoutId(edit.presetId)
  },
  saveLayoutEdit: (name) => {
    const { layoutEdit: edit, layoutLibrary } = get()
    if (!edit) return
    let lib = layoutLibrary
    let id = edit.presetId
    if (edit.draft) {
      if (isDefaultLayoutId(id)) {
        const label = name?.trim()
        if (!label) return
        id = newLayoutPresetId()
        lib = addLayoutPreset(lib, { id, name: label, engine: edit.engine, layout: edit.draft })
      } else if (findLayoutPreset(lib, edit.engine, id).id === id) {
        lib = updateLayoutPreset(lib, id, { layout: edit.draft })
      }
    }
    lib = setActiveLayout(lib, edit.engine, id)
    storeLayoutLibrary(lib)
    set({ layoutLibrary: lib, layoutEdit: null, layoutGroupRequest: null })
  },
  cancelLayoutEdit: () => set((s) => s.layoutEdit ? { layoutEdit: null, layoutGroupRequest: null } : {})
}))

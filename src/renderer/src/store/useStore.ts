import { create } from 'zustand'
import type {
  Template, BackendVersion, CommandsSchema, ReleaseInfo, RunningStatus,
  ModelGroup, TrackedBackend, TrackedBackendRelease, ThemePref
} from '../../../shared/types'

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
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  percent: number; repoId?: string; speed?: number
}

interface AppStore {
  cards: CardState[]
  backends: BackendVersion[]
  models: ModelGroup[]
  activeBackend: BackendVersion | null
  commandsSchema: CommandsSchema | null
  releaseInfo: ReleaseInfo | null
  paths: { models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string } | null
  view: 'cards' | 'settings' | 'hub' | 'models' | 'about' | 'logs'
  showCreateModal: boolean
  editingTemplate: Template | null
  prefillModelPath: string | null
  updateDismissed: boolean
  checkingUpdate: boolean
  downloadProgress: { percent: number; phase: string } | null
  templateSearch: string
  modelDownloads: Record<string, ModelDownloadInfo>
  hfDownloads: { repoId: string; filename: string; percent: number; phase: 'downloading' | 'paused' | 'saving' | 'creating_template' | 'done' | 'error' | 'starting'; speed?: number }[]
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
  cpuInfo: { physicalCores: number; logicalCores: number; modelName: string } | null
  detectedSpeculation: Record<string, { mode: 'off' | 'mtp' | 'draft' | 'dspark'; reason?: string }>
  speculationApplied: Record<string, boolean>
  // New state for features 12-34
  ggufMetadata: Record<string, any>  // keyed by modelPath
  // Task 1: per-model metadata extraction status (for the "extracting…" notification).
  metadataExtractions: Record<string, { name: string; status: 'extracting' | 'done' | 'error' }>
  vramInfo: { freeVRAMMB: number; totalVRAMMB: number; hasNvidia: boolean; gpuName: string | null; vendor?: string | null; gpuType?: string | null } | null
  systemRam: { totalRAMMB: number; freeRAMMB: number } | null
  modelDefaults: { autoFitEnabled: boolean; autoFitContextLength: number; guardrailMode: string; customMaxSizeGB: number; useCurrentMemState?: boolean; moeOffloadStrategy?: 'offload' | 'max' }
  baseUrlOverride: { enabled: boolean; port: number; serveOnLocalNetwork: boolean; apiKeyEnabled: boolean; apiKey: string }
  samplingPresets: any[]
  paramViewMode: 'common' | 'full'  // feature 30
  quickBaselineActive: boolean      // feature 25 — tracks if Quick preset is the active baseline
  // Task 5: 3-way preset mode. 'clear' = empty, 'quick' = LM Studio baselines,
  // 'fullauto' = Quick baselines + Ignore-Context-Override + Auto-Context-Fill ON.
  presetMode: 'clear' | 'quick' | 'fullauto'

  setCompactSidebarEnabled: (enabled: boolean) => void
  setView: (v: AppStore['view']) => void
  setShowCreateModal: (show: boolean, template?: Template | null) => void
  setPrefillModelPath: (path: string | null) => void
  setActiveBackend: (b: BackendVersion) => void
  setCommandsSchema: (s: CommandsSchema) => void
  setBackends: (b: BackendVersion[]) => void
  setModels: (m: ModelGroup[]) => void
  setCards: (c: CardState[]) => void
  setReleaseInfo: (r: ReleaseInfo | null) => void
  setPaths: (p: { models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string }) => void
  setUpdateDismissed: (v: boolean) => void
  setCheckingUpdate: (v: boolean) => void
  setDownloadProgress: (data: { percent: number; phase: string } | null) => void
  setTemplateSearch: (q: string) => void
  upsertModelDownload: (d: ModelDownloadInfo) => void
  removeModelDownload: (id: string) => void
  setHfDownload: (d: { repoId: string; filename: string; percent: number; phase: 'downloading' | 'paused' | 'saving' | 'creating_template' | 'done' | 'error' | 'starting'; speed?: number }) => void
  removeHfDownload: (filename: string) => void
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
  setCpuInfo: (info: { physicalCores: number; logicalCores: number; modelName: string } | null) => void
  setDetectedSpeculation: (modelPath: string, mode: 'off' | 'mtp' | 'draft' | 'dspark', reason?: string) => void
  markSpeculationApplied: (templateId: string, applied: boolean) => void
  setGgufMetadata: (modelPath: string, meta: any) => void
  setGgufMetadataBulk: (cache: Record<string, any>) => void
  setMetadataExtraction: (modelPath: string, name: string, status: 'extracting' | 'done' | 'error') => void
  clearMetadataExtraction: (modelPath: string) => void
  setVramInfo: (info: any) => void
  setSystemRam: (info: { totalRAMMB: number; freeRAMMB: number }) => void
  setModelDefaults: (defaults: any) => void
  setBaseUrlOverride: (opts: any) => void
  setSamplingPresets: (presets: any[]) => void
  setParamViewMode: (mode: 'common' | 'full') => void
  setQuickBaselineActive: (active: boolean) => void
  setPresetMode: (mode: 'clear' | 'quick' | 'fullauto') => void
}

export const useStore = create<AppStore>((set) => ({
  cards: [], backends: [], models: [], activeBackend: null,
  commandsSchema: null, releaseInfo: null, paths: null,
  view: 'cards', showCreateModal: false, editingTemplate: null, prefillModelPath: null,
  updateDismissed: false, checkingUpdate: false, downloadProgress: null,
  templateSearch: '', modelDownloads: {}, hfDownloads: [],
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
  cpuInfo: null,
  detectedSpeculation: {},
  speculationApplied: {},
  ggufMetadata: {},
  metadataExtractions: {},
  vramInfo: null,
  systemRam: null,
  modelDefaults: { autoFitEnabled: true, autoFitContextLength: 60000, guardrailMode: 'strict', customMaxSizeGB: 0, useCurrentMemState: false, moeOffloadStrategy: 'offload' },
  baseUrlOverride: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: false, apiKey: '' },
  samplingPresets: [],
  paramViewMode: 'common',
  quickBaselineActive: true,  // Fix 5: Quick settings is the default baseline
  presetMode: 'quick',        // Task 5: default to Quick (matches quickBaselineActive)

  setCompactSidebarEnabled: (enabled) => {
    localStorage.setItem('compactSidebar', String(enabled))
    set({ compactSidebarEnabled: enabled })
  },
  setView: (v) => set({ view: v }),
  setShowCreateModal: (show, template = null) => set({ showCreateModal: show, editingTemplate: template }),
  setPrefillModelPath: (path) => set({ prefillModelPath: path }),
  setActiveBackend: (b) => set({ activeBackend: b }),
  setCommandsSchema: (s) => set({ commandsSchema: s }),
  setBackends: (b) => set({ backends: b }),
  setModels: (m) => set({ models: m }),
  setCards: (c) => set({ cards: c }),
  setReleaseInfo: (r) => set({ releaseInfo: r }),
  setPaths: (p) => set({ paths: p }),
  setUpdateDismissed: (v) => set({ updateDismissed: v }),
  setCheckingUpdate: (v) => set({ checkingUpdate: v }),
  setDownloadProgress: (data) => set({ downloadProgress: data }),
  setTemplateSearch: (q) => set({ templateSearch: q }),
  upsertModelDownload: (d) => set((s) => ({ modelDownloads: { ...s.modelDownloads, [d.id]: d } })),
  removeModelDownload: (id) => set((s) => {
    const next = { ...s.modelDownloads }; delete next[id]; return { modelDownloads: next }
  }),
  setHfDownload: (d) => set((s) => {
    const arr = s.hfDownloads.filter(x => x.filename !== d.filename)
    return { hfDownloads: [...arr, d] }
  }),
  removeHfDownload: (filename) => set((s) => ({ hfDownloads: s.hfDownloads.filter(x => x.filename !== filename) })),
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
  setTrackedBackends: (t) => set({ trackedBackends: t }),
  setTrackerResult: (r) => set((s) => ({ trackerResults: { ...s.trackerResults, [r.trackedId]: r } })),
  setCheckingAllBackends: (v) => set({ checkingAllBackends: v }),
  setTheme: (t) => {
    localStorage.setItem('hexllama_theme', t)
    set({ theme: t })
  },
  setSystemTheme: (t) => set({ systemTheme: t }),
  toggleModelGroup: (folderPath) => set((s) => ({
    expandedModelGroups: { ...s.expandedModelGroups, [folderPath]: !s.expandedModelGroups[folderPath] }
  })),
  setCpuInfo: (info) => set({ cpuInfo: info }),
  setDetectedSpeculation: (modelPath, mode, reason) => set((s) => ({
    detectedSpeculation: { ...s.detectedSpeculation, [modelPath]: { mode, reason } }
  })),
  markSpeculationApplied: (templateId, applied) => set((s) => ({
    speculationApplied: { ...s.speculationApplied, [templateId]: applied }
  })),
  setGgufMetadata: (modelPath, meta) => set((s) => ({ ggufMetadata: { ...s.ggufMetadata, [modelPath]: meta } })),
  setGgufMetadataBulk: (cache) => set((s) => ({ ggufMetadata: { ...cache, ...s.ggufMetadata } })),
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
  setSamplingPresets: (presets) => set({ samplingPresets: presets }),
  setParamViewMode: (mode) => set({ paramViewMode: mode }),
  setQuickBaselineActive: (active) => set({ quickBaselineActive: active }),
  setPresetMode: (mode) => set({ presetMode: mode, quickBaselineActive: mode !== 'clear' })
}))

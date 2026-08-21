import type {
  Template, BackendVersion, CommandsSchema, ReleaseInfo,
  ModelGroup, TrackedBackend, TrackedBackendRelease, ThemePref,
  CpuInfo, SpeculationMode
} from '../../shared/types'

interface ModelDownloadInfo {
  id: string
  url: string
  filename: string
  destPath: string
  receivedBytes: number
  totalBytes: number
  phase: 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'
  percent: number
  speed?: number
  repoId?: string
}
interface HfModelResult {
  id: string; author: string; name: string
  downloads: number; likes: number; tags: string[]; lastModified: string
}
interface HfFileResult { name: string; size: number; downloadUrl: string }

interface LlamaCppApi {
  // Models
  listModels: () => Promise<ModelGroup[]>
  deleteModel: (filePath: string) => Promise<{ success: boolean; error?: string }>
  renameModel: (oldPath: string, newName: string) => Promise<{ success: boolean; newPath?: string; error?: string }>
  startModelDownload: (opts: { url: string; filename: string; repoId?: string; modelFolder?: string }) => Promise<{ success: boolean; id?: string; error?: string }>
  pauseModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  resumeModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  cancelModelDownload: (id: string) => Promise<{ success: boolean; error?: string }>
  listModelDownloads: () => Promise<ModelDownloadInfo[]>
  onModelDownloadProgress: (cb: (data: ModelDownloadInfo) => void) => void
  removeModelDownloadListener: () => void

  // Model folders
  listExternalModelFolders: () => Promise<string[]>
  addExternalModelFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeExternalModelFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  getMainModelFolder: () => Promise<{ folder: string; isDefault: boolean }>
  setMainModelFolder: (folder: string) => Promise<{ success: boolean; mainModelFolder: string | null }>

  // Backends
  listBackends: () => Promise<BackendVersion[]>
  deleteBackend: (backendId: string) => Promise<{ success: boolean; error?: string }>
  getCommands: (backendKey: string) => Promise<CommandsSchema | null>
  saveBackendCommands: (backendKey: string, schema: object) => Promise<{ success: boolean; error?: string }>

  // Backend folders
  listExternalBackendFolders: () => Promise<string[]>
  addExternalBackendFolder: () => Promise<{ success: boolean; folders?: string[] }>
  removeExternalBackendFolder: (folder: string) => Promise<{ success: boolean; folders: string[] }>
  getMainBackendFolder: () => Promise<{ folder: string; isDefault: boolean }>
  setMainBackendFolder: (folder: string) => Promise<{ success: boolean; mainBackendFolder: string | null }>

  // Tracked backends
  listTrackedBackends: () => Promise<TrackedBackend[]>
  addTrackedBackend: (link: string) => Promise<{ success: boolean; error?: string; tracked?: TrackedBackend }>
  removeTrackedBackend: (trackedId: string) => Promise<{ success: boolean; error?: string }>
  checkAllBackends: () => Promise<{ results: TrackedBackendRelease[] }>
  checkUpdates: () => Promise<ReleaseInfo>
  downloadRelease: (opts: { url: string; version: string; assetName: string; backendKey: string }) => Promise<{ success: boolean; path?: string; error?: string }>
  cancelBackendDownload: () => Promise<{ success: boolean }>
  onDownloadProgress: (callback: (data: { percent: number; phase: string }) => void) => void
  removeDownloadListener: () => void

  // Templates
  listTemplates: () => Promise<Template[]>
  saveTemplate: (template: object) => Promise<{ success: boolean; id: string }>
  deleteTemplate: (id: string) => Promise<{ success: boolean }>
  importTemplate: () => Promise<Template | null>
  exportTemplate: (template: object) => Promise<{ success: boolean }>

  // File pickers
  pickModelFile: () => Promise<{ name: string; path: string } | null>
  pickAnyFile: () => Promise<string | null>

  // Run model
  runModel: (opts: { id: string; name: string; backendPath: string; exe: string; args: string[]; openBrowser: boolean; port: number }) => Promise<{ success: boolean; pid?: number; error?: string; port?: number }>
  stopModel: (id: string) => Promise<{ success: boolean; error?: string; alreadyStopped?: boolean }>
  onModelError: (cb: (data: { id: string; error: string }) => void) => void
  onModelExited: (cb: (data: { id: string }) => void) => void

  // HuggingFace
  hfSearch: (query: string, sort?: string, direction?: number) => Promise<HfModelResult[] | { error: string }>
  hfGetFiles: (repoId: string) => Promise<HfFileResult[] | { error: string }>
  hfDownloadModel: (opts: { repoId: string; filename: string; downloadUrl: string }) => Promise<{ success: boolean; error?: string }>
  hfOpenModelsDir: () => Promise<void>
  onHfDownloadProgress: (callback: (data: { percent: number; phase: string; filename: string; destPath: string; speed?: number }) => void) => void
  removeHfDownloadListener: () => void

  // Folders / paths
  openFolder: (path: string) => Promise<void>
  getPaths: () => Promise<{ models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string }>
  openExternal: (url: string) => Promise<void>

  // Chat windows
  openChatWindow: (port: number, name: string, ctxSize?: number) => Promise<void>
  openDetachedChatWindow: (port: number, name: string) => Promise<void>
  onAddChatTab: (cb: (data: { url: string; name: string }) => void) => void
  notifyTabMoved: (url: string) => Promise<void>
  onTabMovedElsewhere: (cb: (data: { url: string }) => void) => void

  getVersion: () => Promise<string>

  // Theme
  getTheme: () => Promise<ThemePref>
  setTheme: (theme: ThemePref) => Promise<{ success: boolean; theme: ThemePref }>
  getSystemTheme: () => Promise<'dark' | 'light'>
  onThemeChanged: (cb: (theme: ThemePref) => void) => void
  removeThemeListener: () => void

  // CPU + speculation detection
  getCpuInfo: () => Promise<CpuInfo>
  detectSpeculation: (modelPath: string) => Promise<{ mode: SpeculationMode; reason?: string; error?: string }>

  // GGUF metadata + VRAM + system RAM
  getGgufMetadata: (modelPath: string) => Promise<any>
  // Task 1: metadata cache
  getMetadataCache: () => Promise<Record<string, any>>
  clearMetadataCache: () => Promise<{ success: boolean; cleared: number }>
  onMetadataExtracting: (cb: (data: { modelPath: string; name: string; status: 'extracting' | 'done' | 'error' }) => void) => void
  removeMetadataExtractingListener: () => void
  onGgufMetadataUpdated: (cb: (data: { modelPath: string; meta: any }) => void) => void
  removeGgufMetadataUpdatedListener: () => void
  getVramInfo: () => Promise<any>
  getSystemRam: () => Promise<{ totalRAMMB: number; freeRAMMB: number }>

  // Model defaults + guardrails
  getModelDefaults: () => Promise<any>
  setModelDefaults: (defaults: any) => Promise<{ success: boolean }>
  checkModelLoadingGuardrail: (opts: any) => Promise<{ allowed: boolean; reason: string }>

  // Base URL override
  getBaseUrlOverride: () => Promise<any>
  setBaseUrlOverride: (opts: any) => Promise<{ success: boolean }>

  // Sampling presets
  listSamplingPresets: () => Promise<any[]>
  addSamplingPreset: (name: string, values: any) => Promise<any>
  deleteSamplingPreset: (id: string) => Promise<{ success: boolean }>
  starSamplingPreset: (id: string) => Promise<{ success: boolean }>

  // Silent backend check
  onBackendsCheckedSilent: (cb: (data: any) => void) => void

  // Backends list changed (e.g. after auto-cleanup of outdated versions)
  onBackendsChanged: (cb: (data: { deleted: string[] }) => void) => void
  removeBackendsChangedListener: () => void

  // Server log stream (Fix 4)
  onServerLog: (cb: (data: { id: string; name: string; stream: string; line: string; ts: number }) => void) => void
  removeServerLogListener: () => void
}
declare global {
  interface Window { api: LlamaCppApi }
}

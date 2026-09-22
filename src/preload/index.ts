import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ModelGroup, BackendVersion, TrackedBackend,
  TrackedBackendRelease, ThemePref, ReleaseInfo, CpuInfo, SpecDetectionResult
} from '../shared/types'

const api = {
  // ----- Models -----
  listModels: () => ipcRenderer.invoke('list-models') as Promise<ModelGroup[]>,
  deleteModel: (filePath: string) => ipcRenderer.invoke('delete-model', filePath),
  renameModel: (oldPath: string, newName: string) => ipcRenderer.invoke('rename-model', oldPath, newName),
  startModelDownload: (opts: object) => ipcRenderer.invoke('start-model-download', opts),
  pauseModelDownload: (id: string) => ipcRenderer.invoke('pause-model-download', id),
  resumeModelDownload: (id: string) => ipcRenderer.invoke('resume-model-download', id),
  cancelModelDownload: (id: string) => ipcRenderer.invoke('cancel-model-download', id),
  listModelDownloads: () => ipcRenderer.invoke('list-model-downloads'),
  onModelDownloadProgress: (cb: (data: object) => void) => {
    ipcRenderer.removeAllListeners('model-download-progress')
    ipcRenderer.on('model-download-progress', (_e, data) => cb(data))
  },
  removeModelDownloadListener: () => ipcRenderer.removeAllListeners('model-download-progress'),

  // ----- Model folders (external + main/starred) -----
  listExternalModelFolders: () => ipcRenderer.invoke('list-external-model-folders') as Promise<string[]>,
  addExternalModelFolder: () => ipcRenderer.invoke('add-external-model-folder'),
  removeExternalModelFolder: (folder: string) => ipcRenderer.invoke('remove-external-model-folder', folder),
  getMainModelFolder: () => ipcRenderer.invoke('get-main-model-folder') as Promise<{ folder: string; isDefault: boolean }>,
  setMainModelFolder: (folder: string) => ipcRenderer.invoke('set-main-model-folder', folder),
  migrateModelFolders: (rootFolder: string) => ipcRenderer.invoke('migrate-model-folders', rootFolder),

  // ----- Backends -----
  listBackends: () => ipcRenderer.invoke('list-backends') as Promise<BackendVersion[]>,
  deleteBackend: (backendId: string) => ipcRenderer.invoke('delete-backend', backendId),
  deleteBackendType: (backendKey: string, backendType: string) => ipcRenderer.invoke('delete-backend-type', { backendKey, backendType }) as Promise<{ success: boolean; deleted?: boolean; error?: string }>,
  getCommands: (backendKey: string) => ipcRenderer.invoke('get-commands', backendKey),
  saveBackendCommands: (backendKey: string, schema: object) => ipcRenderer.invoke('save-backend-commands', backendKey, schema),

  // ----- Backend folders (external + main/starred) -----
  listExternalBackendFolders: () => ipcRenderer.invoke('list-external-backend-folders') as Promise<string[]>,
  addExternalBackendFolder: () => ipcRenderer.invoke('add-external-backend-folder'),
  removeExternalBackendFolder: (folder: string) => ipcRenderer.invoke('remove-external-backend-folder', folder),
  getMainBackendFolder: () => ipcRenderer.invoke('get-main-backend-folder') as Promise<{ folder: string; isDefault: boolean }>,
  setMainBackendFolder: (folder: string) => ipcRenderer.invoke('set-main-backend-folder', folder),

  // ----- Tracked backends (Backends Tracker) -----
  listTrackedBackends: () => ipcRenderer.invoke('list-tracked-backends') as Promise<TrackedBackend[]>,
  addTrackedBackend: (link: string) => ipcRenderer.invoke('add-tracked-backend', link) as Promise<{ success: boolean; error?: string; tracked?: TrackedBackend }>,
  removeTrackedBackend: (trackedId: string) => ipcRenderer.invoke('remove-tracked-backend', trackedId),
  checkAllBackends: () => ipcRenderer.invoke('check-all-backends') as Promise<{ results: TrackedBackendRelease[] }>,
  checkTrackedBackend: (trackedId: string) => ipcRenderer.invoke('check-tracked-backend', trackedId) as Promise<TrackedBackendRelease | { error: string }>,
  // Legacy single check (for UpdateBanner / Titlebar) — returns llama.cpp release.
  checkUpdates: () => ipcRenderer.invoke('check-updates') as Promise<ReleaseInfo>,
  downloadRelease: (opts: object) => ipcRenderer.invoke('download-release', opts),
  cancelBackendDownload: (trackedId?: string, assetName?: string) => ipcRenderer.invoke('cancel-backend-download', trackedId, assetName),
  onDownloadProgress: (callback: (data: { percent: number; phase: string; trackedId?: string | null; assetName?: string; queuePosition?: number }) => void) => {
    ipcRenderer.removeAllListeners('download-progress')
    ipcRenderer.on('download-progress', (_event, data) => callback(data))
  },
  removeDownloadListener: () => ipcRenderer.removeAllListeners('download-progress'),

  // ----- Templates -----
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  saveTemplate: (template: object, opts?: { silentSync?: boolean }) => ipcRenderer.invoke('save-template', template, opts),
  deleteTemplate: (id: string) => ipcRenderer.invoke('delete-template', id),
  importTemplate: () => ipcRenderer.invoke('import-template'),
  exportTemplate: (template: object) => ipcRenderer.invoke('export-template', template),

  // ----- File pickers -----
  pickModelFile: () => ipcRenderer.invoke('pick-model-file'),
  pickAnyFile: () => ipcRenderer.invoke('pick-any-file'),

  // ----- Run model -----
  runModel: (opts: object) => ipcRenderer.invoke('run-model', opts),
  stopModel: (id: string, opts?: { skipCheckpoint?: boolean }) => ipcRenderer.invoke('stop-model', id, opts),
  onModelError: (cb: (data: { id: string; error: string }) => void) => {
    ipcRenderer.removeAllListeners('model-error')
    ipcRenderer.on('model-error', (_e, data) => cb(data))
  },
  onModelExited: (cb: (data: { id: string }) => void) => {
    ipcRenderer.removeAllListeners('model-exited')
    ipcRenderer.on('model-exited', (_e, data) => cb(data))
  },
  onModelStarted: (cb: (data: { id: string; pid?: number; port: number }) => void) => {
    ipcRenderer.removeAllListeners('model-started')
    ipcRenderer.on('model-started', (_e, data) => cb(data))
  },
  onTemplatesChanged: (cb: () => void) => {
    ipcRenderer.removeAllListeners('templates-changed')
    ipcRenderer.on('templates-changed', () => cb())
  },

  // ----- HuggingFace -----
  hfSearch: (query: string, sort?: string, direction?: number) => ipcRenderer.invoke('hf-search', query, sort, direction),
  hfGetFiles: (repoId: string) => ipcRenderer.invoke('hf-get-files', repoId),
  hfDownloadModel: (opts: object) => ipcRenderer.invoke('hf-download-model', opts),
  hfOpenModelsDir: () => ipcRenderer.invoke('hf-open-models-dir'),
  onHfDownloadProgress: (callback: (data: { percent: number; phase: string; filename: string; destPath: string }) => void) => {
    ipcRenderer.removeAllListeners('hf-download-progress')
    ipcRenderer.on('hf-download-progress', (_event, data) => callback(data))
  },
  removeHfDownloadListener: () => ipcRenderer.removeAllListeners('hf-download-progress'),

  // ----- Folders / paths -----
  openFolder: (path: string) => ipcRenderer.invoke('open-folder', path),
  getPaths: () => ipcRenderer.invoke('get-paths') as Promise<{ models: string; templates: string; backend: string; mainModelFolder: string; mainBackendFolder: string }>,
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // ----- Chat windows -----
  openChatWindow: (port: number, name: string, ctxSize?: number) => ipcRenderer.invoke('open-chat-window', port, name, ctxSize),
  openDetachedChatWindow: (port: number, name: string) => ipcRenderer.invoke('open-detached-chat-window', port, name),
  onAddChatTab: (cb: (data: { url: string; name: string }) => void) => {
    ipcRenderer.removeAllListeners('add-chat-tab')
    ipcRenderer.on('add-chat-tab', (_e, data) => cb(data))
  },
  notifyTabMoved: (url: string) => ipcRenderer.invoke('notify-tab-moved', url),
  onTabMovedElsewhere: (cb: (data: { url: string }) => void) => {
    ipcRenderer.removeAllListeners('tab-moved-elsewhere')
    ipcRenderer.on('tab-moved-elsewhere', (_e, data) => cb(data))
  },

  getVersion: () => ipcRenderer.invoke('get-version'),

  // ----- Theme -----
  getTheme: () => ipcRenderer.invoke('get-theme') as Promise<ThemePref>,
  setTheme: (theme: ThemePref) => ipcRenderer.invoke('set-theme', theme) as Promise<{ success: boolean; theme: ThemePref }>,
  getSystemTheme: () => ipcRenderer.invoke('get-system-theme') as Promise<'dark' | 'light'>,
  onThemeChanged: (cb: (theme: ThemePref) => void) => {
    ipcRenderer.removeAllListeners('theme-changed')
    ipcRenderer.on('theme-changed', (_e, theme: ThemePref) => cb(theme))
  },
  removeThemeListener: () => ipcRenderer.removeAllListeners('theme-changed'),

  // ----- CPU info (for thread slider bounds) -----
  getCpuInfo: () => ipcRenderer.invoke('get-cpu-info') as Promise<CpuInfo>,

  // ----- GGUF speculation auto-detection -----
  detectSpeculation: (modelPath: string, hasNativeMtp?: boolean) => ipcRenderer.invoke('detect-speculation', modelPath, hasNativeMtp) as Promise<SpecDetectionResult>,

  // ----- GGUF metadata parser (features 12/13/14/16/29) -----
  getGgufMetadata: (modelPath: string) => ipcRenderer.invoke('get-gguf-metadata', modelPath) as Promise<any>,
  // Metadata cache (bulk-load + live updates)
  getMetadataCache: () => ipcRenderer.invoke('get-metadata-cache') as Promise<Record<string, any>>,
  clearMetadataCache: () => ipcRenderer.invoke('clear-metadata-cache') as Promise<{ success: boolean; cleared: number }>,
  // Monitoring tab.
  perfGetActiveSessions: () => ipcRenderer.invoke('perf-get-active-sessions') as Promise<{ sessionId: string; templateId: string; templateName: string; startedAt: number }[]>,
  perfGetActiveSessionData: (templateId: string) => ipcRenderer.invoke('perf-get-active-session-data', templateId) as Promise<any>,
  perfGetSessionHistory: () => ipcRenderer.invoke('perf-get-session-history') as Promise<any[]>,
  perfGetSessionData: (sessionId: string) => ipcRenderer.invoke('perf-get-session-data', sessionId) as Promise<any>,
  perfSetMaxSessions: (n: number) => ipcRenderer.invoke('perf-set-max-sessions', n) as Promise<{ success: boolean }>,
  perfExportSession: (sessionId: string) => ipcRenderer.invoke('perf-export-session', sessionId) as Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>,
  perfExportAllActive: () => ipcRenderer.invoke('perf-export-all-active') as Promise<{ success: boolean; path?: string; error?: string; canceled?: boolean }>,
  perfImportSession: () => ipcRenderer.invoke('perf-import-session') as Promise<{ success: boolean; imported?: number; error?: string; canceled?: boolean }>,
  onPerfDataPoint: (cb: (data: { templateId: string; type: 'gen' | 'prefill'; point: any }) => void) => {
    ipcRenderer.removeAllListeners('perf-data-point')
    ipcRenderer.on('perf-data-point', (_e, data) => cb(data))
  },
  onPerfSessionStarted: (cb: (data: { templateId: string; sessionId: string; startedAt: number }) => void) => {
    ipcRenderer.removeAllListeners('perf-session-started')
    ipcRenderer.on('perf-session-started', (_e, data) => cb(data))
  },
  onPerfSessionEnded: (cb: (data: { templateId: string; sessionId: string }) => void) => {
    ipcRenderer.removeAllListeners('perf-session-ended')
    ipcRenderer.on('perf-session-ended', (_e, data) => cb(data))
  },
  onMetadataExtracting: (cb: (data: { modelPath: string; name: string; status: 'extracting' | 'done' | 'error' }) => void) => {
    ipcRenderer.removeAllListeners('metadata-extracting')
    ipcRenderer.on('metadata-extracting', (_e, data) => cb(data))
  },
  removeMetadataExtractingListener: () => ipcRenderer.removeAllListeners('metadata-extracting'),
  onGgufMetadataUpdated: (cb: (data: { modelPath: string; meta: any }) => void) => {
    ipcRenderer.removeAllListeners('gguf-metadata-updated')
    ipcRenderer.on('gguf-metadata-updated', (_e, data) => cb(data))
  },
  removeGgufMetadataUpdatedListener: () => ipcRenderer.removeAllListeners('gguf-metadata-updated'),

  // ----- VRAM + system RAM telemetry (features 14/19) -----
  getVramInfo: () => ipcRenderer.invoke('get-vram-info') as Promise<any>,
  getSystemRam: () => ipcRenderer.invoke('get-system-ram') as Promise<{ totalRAMMB: number; freeRAMMB: number }>,

  // ----- Model Defaults settings (features 18/19) -----
  getModelDefaults: () => ipcRenderer.invoke('get-model-defaults') as Promise<any>,
  setModelDefaults: (defaults: any) => ipcRenderer.invoke('set-model-defaults', defaults) as Promise<{ success: boolean }>,
  checkModelLoadingGuardrail: (opts: any) => ipcRenderer.invoke('check-model-loading-guardrail', opts) as Promise<{ allowed: boolean; reason: string }>,

  // ----- Base URL Override -----
  getBaseUrlOverride: () => ipcRenderer.invoke('get-base-url-override') as Promise<any>,
  setBaseUrlOverride: (opts: any) => ipcRenderer.invoke('set-base-url-override', opts) as Promise<{ success: boolean }>,
  getLaunchSettings: () => ipcRenderer.invoke('get-launch-settings') as Promise<{ launchOnStartup: boolean; autostartMainTemplates: boolean }>,
  setLaunchOnStartup: (enabled: boolean) => ipcRenderer.invoke('set-launch-on-startup', enabled) as Promise<{ success: boolean }>,
  setAutostartMainTemplates: (enabled: boolean) => ipcRenderer.invoke('set-autostart-main-templates', enabled) as Promise<{ success: boolean }>,
  getGlobalBackend: () => ipcRenderer.invoke('get-global-backend') as Promise<{ backendKey: string; backendVersion: string; backendType?: string | null } | null>,
  setGlobalBackend: (backend: { backendKey: string; backendVersion: string; backendType?: string | null } | null) => ipcRenderer.invoke('set-global-backend', backend) as Promise<{ success: boolean }>,
  getMcpSettings: () => ipcRenderer.invoke('get-mcp-settings') as Promise<any>,
  setMcpSettings: (mcp: any) => ipcRenderer.invoke('set-mcp-settings', mcp) as Promise<{ success: boolean }>,
  addSkillFiles: () => ipcRenderer.invoke('add-skill-files') as Promise<{ success: boolean; error?: string }>,
  removeSkillFiles: () => ipcRenderer.invoke('remove-skill-files') as Promise<{ success: boolean }>,

  // ----- KV Cache Checkpoints -----
  getKvCacheCheckpoints: () => ipcRenderer.invoke('get-kv-cache-checkpoints') as Promise<any>,
  setKvCacheCheckpoints: (opts: any) => ipcRenderer.invoke('set-kv-cache-checkpoints', opts) as Promise<{ success: boolean }>,
  listExternalCheckpointFolders: () => ipcRenderer.invoke('list-external-checkpoint-folders') as Promise<string[]>,
  addExternalCheckpointFolder: () => ipcRenderer.invoke('add-external-checkpoint-folder'),
  removeExternalCheckpointFolder: (folder: string) => ipcRenderer.invoke('remove-external-checkpoint-folder', folder),
  getMainCheckpointFolder: () => ipcRenderer.invoke('get-main-checkpoint-folder') as Promise<{ folder: string; isDefault: boolean }>,
  setMainCheckpointFolder: (folder: string) => ipcRenderer.invoke('set-main-checkpoint-folder', folder),
  scanRedundantCheckpoints: () => ipcRenderer.invoke('scan-redundant-checkpoints') as Promise<{ file: string; reason: string; tokens: number | null; modelName: string; templateName: string; mode: string }[]>,
  deleteRedundantCheckpoints: (files: string[]) => ipcRenderer.invoke('delete-redundant-checkpoints', files) as Promise<{ success: boolean; deleted: number }>,

  // ----- Sampling presets -----
  listSamplingPresets: () => ipcRenderer.invoke('list-sampling-presets') as Promise<any[]>,
  addSamplingPreset: (name: string, values: any) => ipcRenderer.invoke('add-sampling-preset', name, values) as Promise<any>,
  deleteSamplingPreset: (id: string) => ipcRenderer.invoke('delete-sampling-preset', id) as Promise<{ success: boolean }>,
  starSamplingPreset: (id: string) => ipcRenderer.invoke('star-sampling-preset', id) as Promise<{ success: boolean }>,

  // ----- Silent backend check listener -----
  onBackendsCheckedSilent: (cb: (data: any) => void) => {
    ipcRenderer.removeAllListeners('backends-checked-silent')
    ipcRenderer.on('backends-checked-silent', (_e, data) => cb(data))
  },

  // Server log stream listener (for the Logs tab)
  onServerLog: (cb: (data: { id: string; name: string; stream: string; line: string; ts: number }) => void) => {
    ipcRenderer.removeAllListeners('server-log')
    ipcRenderer.on('server-log', (_e, data) => cb(data))
  },
  removeServerLogListener: () => ipcRenderer.removeAllListeners('server-log'),

  // Backends list changed (e.g. after auto-cleanup of outdated versions).
  onBackendsChanged: (cb: (data: { deleted: string[] }) => void) => {
    ipcRenderer.removeAllListeners('backends-changed')
    ipcRenderer.on('backends-changed', (_e, data) => cb(data))
  },
  removeBackendsChangedListener: () => ipcRenderer.removeAllListeners('backends-changed'),

  onDownloadProgressLegacy: () => {},
  removeDownloadListenerLegacy: () => {}
}
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error — contextIsolation disabled; attach directly to window.
  window.electron = electronAPI
  // @ts-expect-error — contextIsolation disabled; attach directly to window.
  window.api = api
}

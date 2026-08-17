// ============================================================================
// Shared types used by main process, preload and renderer.
// ============================================================================

export interface ModelFile {
  name: string
  path: string
}

// A single .gguf model file that lives inside a model group (folder).
export interface ModelEntry {
  name: string
  path: string
  size: number
}

// Multimodal projector file detected alongside models in the same folder.
export interface MmprojFile {
  name: string
  path: string
  size: number
}

// LM-Studio style grouping: one folder may hold several .gguf model files plus
// (optionally) a single shared mmproj file. All models in the folder share it.
export interface ModelGroup {
  folder: string        // display name (folder basename)
  folderPath: string    // absolute path to the folder
  external: boolean     // true when the folder is under an external model folder
  models: ModelEntry[]  // .gguf/.bin/.ggml files excluding mmproj
  mmproj: MmprojFile | null
  totalSize: number     // sum of models + mmproj
  modelSize: number     // sum of models only
}

export interface BackendVersion {
  id: string              // unique key: `${rootIndex}::${backendKey}::${version}`
  name: string            // stable version identifier (version subfolder name) — used for template matching
  displayName: string     // human readable, e.g. "llama.cpp: (b10448-...)"
  backendKey: string      // fork folder name, e.g. "llama.cpp" — used for commands lookup
  version: string         // version subfolder name (alias of `name`)
  path: string            // absolute path to the directory containing the exe (cwd)
  exe: string             // exe filename, relative to `path`
  hasCommands: boolean    // whether a commands.json exists for backendKey
  rootDir: string         // backend root folder (default BACKEND_DIR or external)
  external: boolean       // true when discovered inside an external backend folder
}

export interface CommandParam {
  arg: string
  short?: string
  label: string
  description: string
  type: 'boolean' | 'number' | 'string' | 'select' | 'text'
  default?: string | number | boolean | null
  options?: string[]
  min?: number
  max?: number
  placeholder?: string
  env?: string
  deprecated?: boolean
}
export interface CommandCategory {
  name: string
  icon: string
  commands: CommandParam[]
}
export interface CommandsSchema {
  version: string
  categories: CommandCategory[]
}
export interface Template {
  id: string
  name: string
  description?: string
  backendVersion?: string
  modelPath?: string
  serverPort: number
  args: Record<string, string | number | boolean | null>
  tags?: string[]
  launchMode?: 'chat' | 'api'
  createdAt: string
  updatedAt: string
  _file?: string
}
export interface ReleaseAsset {
  name: string
  downloadUrl: string
  size: number
}
export interface ReleaseInfo {
  tagName: string
  name: string
  url: string
  publishedAt: string
  isNewer?: boolean
  assets: ReleaseAsset[]
  error?: string
}
export type RunningStatus = 'idle' | 'running' | 'error'
export interface CardState {
  template: Template
  status: RunningStatus
  pid?: number
  expanded: boolean
  tempPort?: number
}

// Tracked backend repository (a fork of llama.cpp to watch for releases).
export interface TrackedBackend {
  id: string              // stable slug, e.g. "llama-cpp" or "atomic-llama-cpp-turboquant"
  repo: string            // "owner/repo"
  name: string            // display name e.g. "llama.cpp"
  folderName: string      // subfolder name under BACKEND_DIR for this backend
  isDefault: boolean      // true for built-in entries (cannot be deleted)
  // Optional default options injected into the commands.json for select params,
  // keyed by the param arg name (e.g. "--cache-type-k").
  defaultOptions?: Record<string, string[]>
}

// Result of checking a single tracked backend for updates.
export interface TrackedBackendRelease extends ReleaseInfo {
  trackedId: string
  folderName: string
}

// Aggregated result of the global "Check for updates" action.
export interface BackendsTrackerResult {
  results: TrackedBackendRelease[]
}

// Theme preference stored in settings.json.
export type ThemePref = 'system' | 'dark' | 'light'

// CPU hardware info used for thread slider bounds and recommended defaults.
export interface CpuInfo {
  physicalCores: number   // physical core count (not logical/hyperthreaded)
  logicalCores: number    // logical processor count (os.cpus().length)
  modelName: string       // CPU model string
}

// Speculative decoding mode exposed in the Advanced Parameters UI.
export type SpeculationMode = 'off' | 'mtp' | 'draft' | 'dspark'

// GGUF model metadata extracted from the file header. Used by features 12/13/14/16/29.
export interface GgufMetadata {
  blockCount: number | null       // llama.block_count — GPU layer slider max
  contextLength: number | null    // llama.context_length — context slider max
  expertCount: number | null      // llama.expert_count — MoE expert slider max
  chatTemplate: string | null     // tokenizer.chat_template — Jinja editor
  hiddenSize: number | null       // llama.embedding_length — VRAM KV math
  kvHeads: number | null          // llama.attention.head_count_kv — VRAM KV math
  modelName: string | null        // general.name
  architecture: string | null     // general.architecture
  isMoe: boolean                  // derived: expert_count > 0 or expert tensors found
  fileSizeMB: number              // file size in MB for VRAM estimation
  error?: string
}

// VRAM telemetry returned by the main process for the budgeting algorithm (feature 14).
export interface VramInfo {
  freeVRAMMB: number       // free VRAM in MB (0 if unavailable)
  totalVRAMMB: number      // total VRAM in MB (0 if unavailable)
  hasNvidia: boolean       // whether an NVIDIA GPU was detected
  gpuName: string | null
  error?: string
}

// System RAM info for guardrail enforcement (feature 19).
export interface SystemRamInfo {
  totalRAMMB: number
  freeRAMMB: number
}

// Model Loading Guardrail mode (feature 19).
export type GuardrailMode = 'off' | 'relaxed' | 'balanced' | 'strict' | 'custom'

// Sampling preset for the presets manager (feature 28).
export interface SamplingPreset {
  id: string
  name: string
  isDefault: boolean    // true for the 3 hardcoded presets
  isStarred: boolean    // true for the main default preset
  values: {
    temperature?: number
    topK?: number
    topP?: number
    minP?: number
    repeatPenalty?: number
    presencePenalty?: number
  }
}

// Model Defaults settings (feature 18).
export interface ModelDefaultsSettings {
  autoFitEnabled: boolean
  autoFitContextLength: number
  guardrailMode: GuardrailMode
  customMaxSizeGB: number
}

// Base URL Override settings (feature 24).
// The override forces every launched backend onto a single configurable port
// (default 1234). Only the port number is user-editable; the URL is always
// `http://localhost:<port>/v1`. Optionally the server can bind to all
// interfaces (Serve on local network) and require an API key.
export interface BaseUrlOverride {
  enabled: boolean
  port: number                 // just the port number (e.g. 1234)
  serveOnLocalNetwork: boolean // when true, adds --host 0.0.0.0 to the server
  apiKeyEnabled: boolean       // when true, adds --api-key <apiKey> to the server
  apiKey: string               // the API key string
}



// The UI's curated "Common Parameters" flag set (CmdParamsEditor.tsx's
// paramViewMode toggle). Shared so display-parameters-common (mcpControl.ts)
// returns the exact same curated subset the UI does, rather than returning
// everything for both the common and full views.
export const COMMON_PARAM_FLAGS = new Set([
  '--ctx-size', '--threads', '--gpu-layers', '--batch-size', '--ubatch-size',
  '--parallel', '--flash-attn', '--temperature', '--top-p', '--min-p', '--top-k',
  '--load-mode', '--cache-type-k', '--cache-type-v', '--kv-offload',
  '--kv-unified', '--keep', '--seed'
])

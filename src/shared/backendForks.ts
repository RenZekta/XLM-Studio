// Fork-specific backend knowledge shared by the main process (tracked-backend
// definitions, commands schema), the renderer (defaults, arg pruning) and the
// MCP layer. Keeping it in one place stops the schema, the Quick baseline and
// the VRAM estimator from drifting apart per fork.

import type { CommandCategory } from './types'

export const TURBOQUANT_BACKEND_KEY = 'atomic-llama-cpp-turboquant'
export const BEELLAMA_BACKEND_KEY = 'beellama.cpp'

// Also matches the owner-qualified folder ("beellama.cpp-anbeeld") that the
// custom tracker generates for the same repo, so a backend installed before
// BeeLlama became built-in keeps its fork behavior.
export function isBeeLlamaBackendKey(backendKey: string | undefined | null): boolean {
  return !!backendKey && /^beellama\.cpp(-anbeeld(-\d+)?)?$/i.test(backendKey)
}

// KVarN widths accepted by --cache-type-k/-v and the SWA overrides.
export const BEELLAMA_KVARN_TYPES = ['kvarn2', 'kvarn3', 'kvarn4', 'kvarn5', 'kvarn6', 'kvarn8']

// Upstream types plus the fork's q2_0..q6_1 ladder and KVarN.
export const BEELLAMA_KV_TYPES = [
  'f32', 'f16', 'bf16',
  'q8_0', 'q6_0', 'q6_1', 'q5_0', 'q5_1', 'q4_0', 'q4_1', 'q3_0', 'q3_1', 'q2_0', 'q2_1',
  'iq4_nl',
  ...BEELLAMA_KVARN_TYPES
]

// Parameters only llama-server from BeeLlama understands. Merged into the base
// schema by category name; a category that does not exist yet is appended.
export const BEELLAMA_EXTRA_COMMANDS: CommandCategory[] = [
  {
    name: 'KV Cache',
    icon: 'Database',
    commands: [
      {
        arg: '--cache-type-k-swa', label: 'KVarN K Type (SWA layers)',
        description: 'Overrides the KVarN K precision for sliding-window attention layers. Requires a KVarN target cache and must be paired with the V override',
        type: 'select', options: BEELLAMA_KVARN_TYPES, env: 'LLAMA_ARG_CACHE_TYPE_K_SWA'
      },
      {
        arg: '--cache-type-v-swa', label: 'KVarN V Type (SWA layers)',
        description: 'Overrides the KVarN V precision for sliding-window attention layers. Requires a KVarN target cache and must be paired with the K override',
        type: 'select', options: BEELLAMA_KVARN_TYPES, env: 'LLAMA_ARG_CACHE_TYPE_V_SWA'
      },
      {
        arg: '--kv-tail-tokens', label: 'KV Precision Tail (tokens)',
        description: 'Keep the most recent tokens of a quantized KV cache in exact F16/BF16. A number applies to every cache group (KVarN rounds up to 128-token groups), "auto" requests 1024, "N0,N1" or "full=N,swa=N" set groups individually. 0 or empty disables it for standard caches',
        type: 'string', placeholder: '1024', env: 'LLAMA_ARG_KV_TAIL_TOKENS'
      },
      {
        arg: '--kv-tail-type', label: 'KV Precision Tail Type',
        description: 'Storage type of the precision tail. Default is bf16 for standard caches and f16 for KVarN',
        type: 'select', options: ['f16', 'bf16'], env: 'LLAMA_ARG_KV_TAIL_TYPE'
      }
    ]
  },
  {
    name: 'Speculative Decoding',
    icon: 'GitBranch',
    commands: [
      {
        arg: '--spec-dm-controller', label: 'DFlash Depth Controller',
        description: 'DFlash only. "profit" adapts the draft depth from measured cycle profit against a no-spec baseline; "off" keeps the maximum static',
        type: 'select', options: ['profit', 'off'], env: 'LLAMA_ARG_SPEC_DM_CONTROLLER'
      },
      {
        arg: '--spec-dm-profit-min', label: 'DFlash Profit Min',
        description: 'Minimum margin over the no-spec baseline before the disable dwell clears',
        type: 'number', default: 0.05, min: 0, max: 0.5, env: 'LLAMA_ARG_SPEC_DM_PROFIT_MIN'
      },
      {
        arg: '--spec-dm-profit-raise-margin', label: 'DFlash Raise Margin',
        description: 'Relative profit margin required to raise the draft depth',
        type: 'number', default: 0.05, min: 0, max: 1, env: 'LLAMA_ARG_SPEC_DM_PROFIT_RAISE_MARGIN'
      },
      {
        arg: '--spec-dm-profit-lower-margin', label: 'DFlash Lower Margin',
        description: 'Relative profit margin required to lower the draft depth',
        type: 'number', default: 0.05, min: 0, max: 1, env: 'LLAMA_ARG_SPEC_DM_PROFIT_LOWER_MARGIN'
      },
      {
        arg: '--spec-dm-profit-ewma-alpha', label: 'DFlash Profit EWMA Alpha',
        description: 'EWMA weight for the profit statistics',
        type: 'number', default: 0.15, min: 0.01, max: 1, env: 'LLAMA_ARG_SPEC_DM_PROFIT_EWMA_ALPHA'
      },
      {
        arg: '--spec-dm-profit-min-samples', label: 'DFlash Min Samples',
        description: 'Samples required before a depth\'s profit statistics are considered ready',
        type: 'number', default: 3, min: 1, max: 64, env: 'LLAMA_ARG_SPEC_DM_PROFIT_MIN_SAMPLES'
      },
      {
        arg: '--spec-dm-profit-warmup', label: 'DFlash Warmup Samples',
        description: 'Measured samples for each initial positive-depth probe (0 uses Min Samples)',
        type: 'number', default: 0, min: 0, max: 64, env: 'LLAMA_ARG_SPEC_DM_PROFIT_WARMUP'
      },
      {
        arg: '--spec-dm-profit-baseline-interval', label: 'DFlash Baseline Interval',
        description: 'Active controller cycles between no-spec baseline probes (0 disables periodic probes)',
        type: 'number', default: 1024, min: 0, max: 4096, env: 'LLAMA_ARG_SPEC_DM_PROFIT_BASELINE_INTERVAL'
      }
    ]
  },
  {
    name: 'Reasoning Loop Guard',
    icon: 'Repeat',
    commands: [
      {
        arg: '--reasoning-loop-guard', label: 'Loop Guard Mode',
        description: 'Reaction when hidden reasoning starts repeating: "force-close" ends the reasoning phase, "stop" ends generation, "off" disables the checks',
        type: 'select', options: ['off', 'force-close', 'stop'], env: 'LLAMA_ARG_REASONING_LOOP_GUARD'
      },
      {
        arg: '--reasoning-loop-min-tokens', label: 'Loop Guard Min Tokens',
        description: 'Delay checks until this many reasoning tokens have been seen',
        type: 'number', default: 512, min: 0, max: 65536, env: 'LLAMA_ARG_REASONING_LOOP_MIN_TOKENS'
      },
      {
        arg: '--reasoning-loop-window', label: 'Loop Guard Window',
        description: 'Token-tail window inspected for repetition (at least the minimum coverage)',
        type: 'number', default: 1024, min: 1, max: 65536, env: 'LLAMA_ARG_REASONING_LOOP_WINDOW'
      },
      {
        arg: '--reasoning-loop-max-period', label: 'Loop Guard Max Period',
        description: 'Longest periodic loop checked (at most one third of the window)',
        type: 'number', default: 128, min: 1, max: 21845, env: 'LLAMA_ARG_REASONING_LOOP_MAX_PERIOD'
      },
      {
        arg: '--reasoning-loop-min-coverage', label: 'Loop Guard Min Coverage',
        description: 'Repeated-token coverage required to trigger the guard',
        type: 'number', default: 256, min: 1, max: 65536, env: 'LLAMA_ARG_REASONING_LOOP_MIN_COVERAGE'
      },
      {
        arg: '--reasoning-loop-check-interval', label: 'Loop Guard Check Interval',
        description: 'Run a check after every N accepted reasoning tokens',
        type: 'number', default: 64, min: 1, max: 4096, env: 'LLAMA_ARG_REASONING_LOOP_CHECK_INTERVAL'
      },
      {
        arg: '--reasoning-loop-interventions', label: 'Loop Guard Interventions',
        description: 'Successful force-close interventions allowed before a later trigger stops generation',
        type: 'number', default: 2, min: 0, max: 100, env: 'LLAMA_ARG_REASONING_LOOP_INTERVENTIONS'
      }
    ]
  }
]

// Every arg that exists only in some fork's schema. A template that moves to a
// backend whose schema lacks one of these must drop it, since llama-server
// rejects unknown arguments.
export const FORK_ONLY_ARGS: ReadonlySet<string> = new Set(
  BEELLAMA_EXTRA_COMMANDS.flatMap(cat => cat.commands.map(c => c.arg))
)

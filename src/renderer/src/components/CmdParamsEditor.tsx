import React, { useMemo, useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch,
  Search, Star, Lock, Clipboard, FolderOpen, Eye, CheckCircle2, XCircle,
  Image as ImageIcon, RotateCcw, Gauge, Sparkles, Layers, AlertTriangle,
  MessageSquare, Copy, Check
} from 'lucide-react'
import type { CommandParam, SpeculationMode } from '../../../shared/types'
import HybridSlider from './HybridSlider'
import SegmentedToggle from './SegmentedToggle'
import SamplingPresets from './SamplingPresets'
import { useVramBudget, computeAutoFillContext } from '../hooks/useVramBudget'

const iconMap: Record<string, React.ReactNode> = {
  Box: <Box size={14} />, Cpu: <Cpu size={14} />, Zap: <Zap size={14} />,
  Database: <Database size={14} />, Sliders: <Sliders size={14} />, Wind: <Wind size={14} />,
  Server: <Server size={14} />, FileText: <FileText size={14} />, GitBranch: <GitBranch size={14} />,
  Star: <Star size={14} />
}
const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']
const HYBRID_PARAMS = ['--threads', '--gpu-layers', '--temperature', '--top-p', '--top-k', '--min-p', '--ctx-size', '--moe-cpu-layers']
// Params that get a custom widget (excluded from the regular command grid).
const CUSTOM_PARAMS = ['--model', '--port', '--host', '--api-key', '--mmproj', '--spec-type', '--chat-template', '--reasoning-budget', '--reasoning-budget-message', '--moe-cpu-layers']

interface Props {
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
}

// Speculative decoding options and their CLI flag mappings (feature 9/26).
const SPEC_OPTIONS: { mode: SpeculationMode; label: string; flag: string | null }[] = [
  { mode: 'off', label: 'Off', flag: null },
  { mode: 'mtp', label: 'MTP', flag: 'draft-mtp' },
  { mode: 'draft', label: 'Draft Model', flag: 'draft-simple' },
  { mode: 'dspark', label: 'dspark', flag: 'draft-dspark' }
]

// Params visible in "Common" view mode (feature 30).
const COMMON_VISIBLE = new Set([
  '--ctx-size', '--threads', '--gpu-layers', '--batch-size', '--ubatch-size',
  '--parallel', '--flash-attn', '--temperature', '--top-p', '--min-p', '--top-k',
  '--mmap', '--mlock', '--cache-type-k', '--cache-type-v', '--kv-offload',
  '--keep', '--seed'
])

export default function CmdParamsEditor({ templateId, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp }: Props) {
  const {
    commandsSchema, updateCard, cards, models, cpuInfo,
    detectedSpeculation, setDetectedSpeculation, markSpeculationApplied,
    ggufMetadata, setGgufMetadata, activeBackend,
    paramViewMode, setParamViewMode, quickBaselineActive,
    presetMode, setPresetMode, modelDefaults
  } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [previewCopied, setPreviewCopied] = useState(false)  // Task 5: preview copy button

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning

  // Task 1+3: On mount, for a NEW template (no templateId, args empty or only
  // sampling-seeded), auto-apply the Quick preset so the engine baselines
  // (threads/batch/flash-attn/etc.) are actually set — not just visually
  // selected. The starred sampling preset's values are seeded by CreateModal and
  // preserved (handleQuickPreset sets temperature/top-p/etc. which the starred
  // preset may have already set; we merge so the starred values win if present).
  const autoAppliedRef = useRef(false)
  useEffect(() => {
    if (autoAppliedRef.current) return
    if (templateId) { autoAppliedRef.current = true; return }  // editing existing — don't auto-apply
    // New template: check if args are empty or only have sampling values.
    const hasEngineArgs = Object.keys(args).some(k =>
      !k.startsWith('__') && !['--temperature', '--top-p', '--top-k', '--min-p', '--repeat-penalty', '--presence-penalty'].includes(k)
    )
    if (!hasEngineArgs && !disabled) {
      autoAppliedRef.current = true
      // Apply Quick baseline, but PRESERVE any starred-preset sampling values
      // that CreateModal already seeded (don't overwrite them with LM Studio defaults).
      handleQuickPreset()
    } else {
      autoAppliedRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, disabled])

  // Resolve the effective model path (for metadata + mmproj + speculation).
  const effectiveModelPath = card?.template.modelPath || modelPathFallback || ''
  const modelGroup = useMemo(() => {
    if (!effectiveModelPath) return null
    return models.find(g => g.models.some(m => m.path === effectiveModelPath)) || null
  }, [models, effectiveModelPath])
  const detectedMmproj = modelGroup?.mmproj || null

  // Feature 12/29/16: Load GGUF metadata when model changes.
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    const cached = ggufMetadata[effectiveModelPath]
    if (cached) return
    window.api?.getGgufMetadata?.(effectiveModelPath).then(meta => {
      if (meta) setGgufMetadata(effectiveModelPath, meta)
    }).catch(() => {})
  }, [effectiveModelPath, disabled, ggufMetadata, setGgufMetadata])

  const meta = effectiveModelPath ? ggufMetadata[effectiveModelPath] : null
  const blockCount = meta?.blockCount || 0    // 0 = unknown → fallback to 120
  const contextLength = meta?.contextLength || 0  // 0 = unknown → fallback to 131072
  const expertCount = meta?.expertCount || 0
  const isMoe = meta?.isMoe || expertCount > 0
  const nativeChatTemplate = meta?.chatTemplate || null

  // CPU info: physical cores for thread slider max + recommended (3/4, rounded down).
  const physicalCores = cpuInfo?.physicalCores || 8
  const recommendedThreads = Math.max(1, Math.floor(physicalCores * 0.75))

  // Feature 12: GPU layers slider max = block_count (fallback 120).
  const gpuLayersMax = blockCount > 0 ? blockCount : 120
  // Feature 29: Context slider max = model context_length (fallback 131072).
  const ctxSliderMax = contextLength > 0 ? contextLength : 131072

  // Feature 14: VRAM budget calculation.
  const modelSizeMB = meta?.fileSizeMB || 0
  const mmprojEnabled = args['--mmproj'] !== undefined && args['--mmproj'] !== '' && args['--mmproj'] !== false
  const mmprojSizeMB = detectedMmproj ? Math.round(detectedMmproj.size / (1024 * 1024)) : 0
  const currentCtx = args['--ctx-size'] !== undefined && args['--ctx-size'] !== '' ? Number(args['--ctx-size']) : 32768
  // Default KV cache quant depends on the backend (TurboQuant fork → turbo3,
  // otherwise q8_0). The user can override per-template via --cache-type-k/v.
  const defaultKvQuant = activeBackend?.backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo3' : 'q8_0'
  // kvQuant kept as an alias for the Quick-baseline setters below.
  const kvQuant = defaultKvQuant
  const kvQuantK = (typeof args['--cache-type-k'] === 'string' && args['--cache-type-k']) ? String(args['--cache-type-k']) : defaultKvQuant
  const kvQuantV = (typeof args['--cache-type-v'] === 'string' && args['--cache-type-v']) ? String(args['--cache-type-v']) : kvQuantK
  // Task 2.1/2.2/2.3/5: per-preset context-fill toggles + memory overhead.
  const ignoreCtxOverride = args['__ignoreCtxOverride'] === true
  const autoCtxFill = (args['__autoCtxFill'] as 'off' | 'auto' | 'maximum') || 'off'
  // Task 5: Memory Overhead — off by default everywhere. When enabled, the
  // default value is 2.5 GB (2560 MB). The overhead reduces Free VRAM then RAM.
  const memOverheadEnabled = args['__memOverheadEnabled'] === true
  const memOverheadMB = memOverheadEnabled ? (Number(args['__memOverheadMB']) || 2560) : 0
  const moeStrategy = modelDefaults.moeOffloadStrategy || 'offload'
  // Task 2: pass whether AutoFill "Auto" is active so useVramBudget can ignore
  // the selected ctx and check full-fit by speed priority for dense models.
  const autoFillAuto = ignoreCtxOverride && autoCtxFill === 'auto'
  const vramBudget = useVramBudget({
    modelPath: effectiveModelPath,
    modelSizeMB,
    maxLayers: blockCount,
    contextSize: currentCtx,
    mmprojEnabled,
    mmprojSizeMB,
    kvQuantType: kvQuantK,
    kvQuantTypeV: kvQuantV,
    memOverheadMB,
    autoFillAuto
  })

  // Task 4: Removed the gpu-layers auto-apply effect. The VRAM-recommended GPU
  // layers are now only a DISPLAY value (shown in the VRAM banner) — the user
  // must manually set --gpu-layers if they want to use it. Settings must not
  // turn themselves on/off (per the user's earlier directive), so Quick no
  // longer forces --gpu-layers either.

  // Task 4: When the MoE offload strategy is "MAX GPU Layers and Force MoE
  // Weights onto CPU", the "Maximum available" AutoFill option conflicts (it
  // would max context, fighting for VRAM). So actually SWITCH the toggle to
  // 'auto' (not just disable the button) — the user must not end up with a
  // stale 'maximum' value that still affects ctx + the card hint.
  useEffect(() => {
    if (disabled) return
    if (moeStrategy === 'max' && isMoe && ignoreCtxOverride && autoCtxFill === 'maximum') {
      commit({ ...args, '__autoCtxFill': 'auto' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moeStrategy, isMoe, ignoreCtxOverride, autoCtxFill, disabled])

  // Task 2.2/7: Automatic Context Fill — compute the max context that fits and
  // auto-write it into --ctx-size ONLY when AutoFill is "Maximum available"
  // (the only case where ctx is auto-applied, per the user's spec). Dense 'auto'
  // and MoE 'auto' defer to llama-server --fit (no ctx forced).
  const autoFillActive = ignoreCtxOverride && autoCtxFill === 'maximum'
  const autoFillResult = (autoFillActive && meta && vramBudget) ? computeAutoFillContext({
    meta,
    modelSizeMB,
    maxLayers: blockCount || 120,
    maxContext: contextLength > 0 ? contextLength : 131072,
    kvQuantType: kvQuantK,
    kvQuantTypeV: kvQuantV,
    freeVRAMMB: vramBudget.freeVRAMMB,
    freeRAMMB: vramBudget.freeRAMMB,
    mmprojSizeMB: mmprojEnabled ? mmprojSizeMB : 0,
    isMoe,
    activeExperts: (meta as any)?.expertUsedCount || expertCount || undefined,
    totalExperts: expertCount || undefined
  }) : null
  useEffect(() => {
    if (disabled || !autoFillResult) return
    const cur = args['--ctx-size']
    if (cur !== autoFillResult.context) {
      commit({ ...args, '--ctx-size': autoFillResult.context })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFillResult?.context, disabled])

  // ----- mmproj widget state (Task 2.1) -----
  // Task 2.1: if mmproj detected → ON + Automatic. If not detected → OFF + Manual.
  // The user can manually override at any time (tracked via __mmproj_manual).
  const mmprojArgValue = args['--mmproj']
  const mmprojManuallyToggled = args['__mmproj_manual'] === true
  const mmprojOn = mmprojManuallyToggled
    ? (args['__mmproj_enabled'] !== false)  // respect manual toggle
    : !!detectedMmproj  // default: ON only if detected
  const mmprojMode: 'auto' | 'manual' = useMemo(() => {
    if (!mmprojOn) return 'manual'  // off → show Manual
    if (detectedMmproj && mmprojArgValue === detectedMmproj.path) return 'auto'
    return mmprojManuallyToggled ? 'manual' : 'auto'
  }, [mmprojOn, mmprojArgValue, detectedMmproj, mmprojManuallyToggled])

  // Task 2.1: Auto-select detected mmproj when ON and in auto mode.
  useEffect(() => {
    if (disabled) return
    if (mmprojOn && detectedMmproj) {
      if (args['--mmproj'] !== detectedMmproj.path) {
        commit({ ...args, '--mmproj': detectedMmproj.path })
      }
    } else if (!mmprojManuallyToggled && !detectedMmproj && args['--mmproj'] !== undefined) {
      // No mmproj detected + not manually toggled → remove the --mmproj arg.
      const newArgs = { ...args }
      delete newArgs['--mmproj']
      commit(newArgs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedMmproj, disabled, mmprojOn, mmprojManuallyToggled])

  function commit(newArgs: Record<string, any>) {
    if (onChange) onChange(newArgs)
    else if (templateId) updateCard(templateId, { args: newArgs })
  }
  function setMmprojOn(on: boolean) {
    const newArgs: Record<string, any> = { ...args }
    // Fix 3: Mark as manually toggled so the default-ON behavior doesn't override.
    newArgs['__mmproj_manual'] = true
    newArgs['__mmproj_enabled'] = on
    if (!on) {
      // Turning OFF: remove the --mmproj flag.
      delete newArgs['--mmproj']
    } else {
      // Turning ON: use detected path if available, else keep existing manual path.
      if (!newArgs['--mmproj']) newArgs['--mmproj'] = detectedMmproj ? detectedMmproj.path : ''
    }
    commit(newArgs)
  }
  // Fix 2: Clicking Manual opens the file picker immediately.
  async function setMmprojMode(mode: 'auto' | 'manual') {
    const newArgs: Record<string, any> = { ...args }
    delete newArgs['__mmproj_disabled']
    newArgs['__mmproj_manual'] = true
    newArgs['__mmproj_enabled'] = true
    if (mode === 'auto') {
      newArgs['--mmproj'] = detectedMmproj ? detectedMmproj.path : ''
      commit(newArgs)
    } else {
      // Manual: open file picker to let the user choose a .gguf file.
      if (!disabled) {
        const f = await window.api?.pickAnyFile?.()
        if (f) {
          newArgs['--mmproj'] = f
          commit(newArgs)
        } else {
          // User cancelled — still switch to manual mode with existing/empty value.
          if (!newArgs['--mmproj']) newArgs['--mmproj'] = detectedMmproj ? detectedMmproj.path : ''
          commit(newArgs)
        }
      } else {
        commit(newArgs)
      }
    }
  }
  function setMmprojManualPath(p: string) { commit({ ...args, '--mmproj': p }) }
  async function pickMmprojFile() {
    const f = await window.api?.pickAnyFile?.()
    if (f) setMmprojManualPath(f)
  }

  // ----- Speculation auto-detection (feature 9/Task 2.2) -----
  // Task 2.2: detection runs AND auto-applies the detected mode (MTP/draft/etc.)
  // so the user doesn't have to manually enable it. If not detected, stays off.
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    const cached = detectedSpeculation[effectiveModelPath]
    if (cached) {
      // Apply the cached detection if --spec-type isn't set yet.
      if (cached.mode !== 'off' && args['--spec-type'] === undefined) {
        const flag = SPEC_OPTIONS.find(o => o.mode === cached.mode)?.flag
        if (flag) commit({ ...args, '--spec-type': flag })
      }
      return
    }
    window.api?.detectSpeculation?.(effectiveModelPath).then(res => {
      if (res) {
        setDetectedSpeculation(effectiveModelPath, res.mode, res.reason)
        // Auto-apply the detected mode (Task 2.2).
        if (res.mode !== 'off' && args['--spec-type'] === undefined) {
          const flag = SPEC_OPTIONS.find(o => o.mode === res.mode)?.flag
          if (flag) commit({ ...args, '--spec-type': flag })
        }
      }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveModelPath, disabled])
  const currentSpecMode: SpeculationMode = useMemo(() => {
    const v = args['--spec-type']; if (!v) return 'off'
    return SPEC_OPTIONS.find(o => o.flag === v)?.mode || 'off'
  }, [args])
  function setSpecMode(mode: SpeculationMode) {
    const flag = SPEC_OPTIONS.find(o => o.mode === mode)?.flag ?? null
    const newArgs = { ...args }
    if (flag === null) delete newArgs['--spec-type']
    else newArgs['--spec-type'] = flag
    commit(newArgs); if (templateId) markSpeculationApplied(templateId, true)
  }

  // ----- Jinja Chat Template (feature 13/Fix 5/Task 6) -----
  // ON by default. The textarea DISPLAYS the model's native chat_template when
  // --chat-template is not set, but we do NOT write the native template into
  // args. --chat-template is only added to the command when the text DIFFERS
  // from the native template by at least 1 symbol (Task 6). This way the
  // unchanged native template is never passed to llama-server; --jinja alone
  // is enough for llama-server to apply the model's native template.
  const jinjaOn = args['--jinja'] !== false  // default ON
  // Display: show --chat-template if set, else the native template (read-only view).
  const jinjaValue = typeof args['--chat-template'] === 'string' && args['--chat-template'] !== ''
    ? args['--chat-template']
    : (nativeChatTemplate || '')
  // Changed = user edited away from the native template (by >=1 symbol).
  const jinjaChanged = nativeChatTemplate !== null && jinjaValue !== nativeChatTemplate
  // Ensure --jinja: true is set when Jinja is ON (so the flag actually reaches
  // llama-server). We deliberately do NOT auto-populate --chat-template here.
  useEffect(() => {
    if (disabled || !jinjaOn) return
    if (args['--jinja'] !== true) {
      commit({ ...args, '--jinja': true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeChatTemplate, jinjaOn, disabled])
  function setJinjaOn(on: boolean) {
    const newArgs: Record<string, any> = { ...args }
    if (!on) {
      // OFF: don't pass any template flags.
      delete newArgs['--chat-template']
      delete newArgs['--jinja']
      newArgs['--jinja'] = false
    } else {
      // ON: only set --jinja. Do NOT add --chat-template unless the user edits it
      // away from the native template (handled in setJinjaValue).
      newArgs['--jinja'] = true
    }
    commit(newArgs)
  }
  function setJinjaValue(v: string) {
    const newArgs: Record<string, any> = { ...args }
    // Only keep --chat-template in args when the text is non-empty AND differs
    // from the native template by at least 1 symbol. Otherwise delete it so the
    // native template (shown via display fallback) is NOT passed to llama-server.
    const differs = nativeChatTemplate === null ? v.trim().length > 0 : v !== nativeChatTemplate
    if (differs && v.length > 0) {
      newArgs['--chat-template'] = v
    } else {
      delete newArgs['--chat-template']
    }
    if (jinjaOn) newArgs['--jinja'] = true
    commit(newArgs)
  }
  function resetJinja() {
    // Reset = revert to the native template (don't pass --chat-template at all).
    const newArgs = { ...args }
    delete newArgs['--chat-template']
    if (jinjaOn) newArgs['--jinja'] = true
    commit(newArgs)
  }

  // ----- Reasoning Budget (feature 17) -----
  const reasoningOn = args['--reasoning-budget'] !== undefined && args['--reasoning-budget'] !== -1 && args['--reasoning-budget'] !== '' && args['--reasoning-budget'] !== false
  const reasoningValue = reasoningOn ? Number(args['--reasoning-budget']) : 8192
  const reasoningMessage = typeof args['--reasoning-budget-message'] === 'string' ? args['--reasoning-budget-message'] : ''
  function setReasoningOn(on: boolean) {
    const newArgs = { ...args }
    if (!on) { delete newArgs['--reasoning-budget']; delete newArgs['--reasoning-budget-message'] }
    else { newArgs['--reasoning-budget'] = 8192 }
    commit(newArgs)
  }
  function setReasoningValue(v: number) { commit({ ...args, '--reasoning-budget': v }) }
  function setReasoningMessage(v: string) {
    const newArgs = { ...args }
    if (v.trim()) newArgs['--reasoning-budget-message'] = v
    else delete newArgs['--reasoning-budget-message']
    commit(newArgs)
  }

  // ----- MoE controls (feature 16) -----
  const moeCpuLayers = args['--moe-cpu-layers']
  const moeCpuLayersSet = moeCpuLayers !== undefined && moeCpuLayers !== '' && moeCpuLayers !== false
  // Feature 16: inverse locking — MoE-CPU control is ONLY active when GPU layers is manually set.
  const gpuLayersManuallySet = args['--gpu-layers'] !== undefined && args['--gpu-layers'] !== '' && args['--gpu-layers'] !== false && args['--gpu-layers'] !== 'auto'

  // ----- handleUpdate + changed-state tracking (feature 8/25) -----
  const handleUpdate = (argName: string, value: any) => {
    const newArgs = { ...args }
    if (value === null || value === false || value === '') delete newArgs[argName]
    else newArgs[argName] = value
    commit(newArgs)
  }
  function isChanged(cmd: CommandParam, val: any): boolean {
    // Feature 25: if Quick baseline is active, compare against the Quick baseline values, not the schema default.
    if (quickBaselineActive) {
      const quickBaselines: Record<string, any> = {
        '--threads': recommendedThreads, '--batch-size': 2048,
        '--ubatch-size': 512, '--parallel': 4, '--flash-attn': 'on', '--mmap': true,
        '--cache-type-k': kvQuant, '--cache-type-v': kvQuant, '--temperature': 0.8,
        '--top-p': 0.95, '--min-p': 0.05, '--top-k': 40, '--repeat-penalty': 1.1,
        '--keep': 32, '--kv-offload': true, '--mlock': true, '--spec-draft-n-max': 3,
        '--spec-draft-n-min': 0, '--spec-draft-p-min': 0.75
      }
      // Fix 2: ctx-size baseline = model's native context (or 32768 if unknown).
      if (meta?.contextLength && meta.contextLength > 0) {
        quickBaselines['--ctx-size'] = Math.min(meta.contextLength, 32768)
      }
      const baseline = quickBaselines[cmd.arg]
      if (baseline !== undefined) {
        const currentSet = val !== undefined && val !== false && val !== ''
        const baseSet = baseline !== undefined && baseline !== false && baseline !== ''
        if (!currentSet && !baseSet) return false
        if (currentSet !== baseSet) return true
        return String(val) !== String(baseline)
      }
    }
    const def = cmd.default
    const currentSet = val !== undefined && val !== false && val !== ''
    const defSet = def !== undefined && def !== false && def !== '' && def !== -1
    if (!currentSet && !defSet) return false
    if (currentSet !== defSet) return true
    return String(val) !== String(def)
  }
  function handleReset(cmd: CommandParam) {
    const newArgs: Record<string, any> = { ...args }
    // Fix 7: CPU Threads resets to 3/4 of physical cores (not the schema default of -1).
    if (cmd.arg === '--threads') {
      newArgs[cmd.arg] = recommendedThreads
      commit(newArgs)
      return
    }
    // Fix 5: Reset to the current preset baseline, not the schema default.
    if (quickBaselineActive) {
      const quickBaselines: Record<string, any> = {
        '--threads': recommendedThreads, '--batch-size': 2048,
        '--ubatch-size': 512, '--parallel': 4, '--flash-attn': 'on', '--mmap': true,
        '--cache-type-k': kvQuant, '--cache-type-v': kvQuant, '--temperature': 0.8,
        '--top-p': 0.95, '--min-p': 0.05, '--top-k': 40, '--repeat-penalty': 1.1,
        '--keep': 32, '--kv-offload': true, '--mlock': true, '--spec-draft-n-max': 3,
        '--spec-draft-n-min': 0, '--spec-draft-p-min': 0.75
      }
      // Fix 2: ctx-size baseline = model's native context (or 32768 if unknown).
      if (meta?.contextLength && meta.contextLength > 0) {
        quickBaselines['--ctx-size'] = Math.min(meta.contextLength, 32768)
      }
      const baseline = quickBaselines[cmd.arg]
      if (baseline !== undefined) {
        newArgs[cmd.arg] = baseline
        commit(newArgs)
        return
      }
    }
    // Clear preset: reset to empty (no value = auto/implicit default)
    const def = cmd.default
    if (def === undefined || def === false || def === '' || def === -1) delete newArgs[cmd.arg]
    else newArgs[cmd.arg] = def
    commit(newArgs)
  }

  // ----- Quick / Clear presets (feature 10/15/25/27) -----
  // Task 1: helper — only set a sampling value if it isn't already present (so
  // the starred preset's values seeded by CreateModal are preserved when Quick
  // is auto-applied on a new template).
  const setIfAbsent = (obj: Record<string, any>, key: string, val: any) => {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') obj[key] = val
  }
  function handleQuickPreset() {
    const newArgs = { ...args }
    // Feature 27: LM Studio engine performance bases.
    if (meta?.contextLength && meta.contextLength > 0) {
      setIfAbsent(newArgs, '--ctx-size', Math.min(meta.contextLength, 32768))
    }
    newArgs['--threads'] = recommendedThreads
    newArgs['--batch-size'] = 2048
    newArgs['--ubatch-size'] = 512
    newArgs['--parallel'] = 4
    newArgs['--flash-attn'] = 'on'
    newArgs['--mmap'] = true
    newArgs['--mlock'] = true
    newArgs['--kv-offload'] = true
    newArgs['--cache-type-k'] = kvQuant
    newArgs['--cache-type-v'] = kvQuant
    newArgs['--keep'] = 32
    // Task 1: sampling values — only set if absent (preserve starred preset).
    setIfAbsent(newArgs, '--temperature', 0.8)
    setIfAbsent(newArgs, '--top-p', 0.95)
    setIfAbsent(newArgs, '--min-p', 0.05)
    setIfAbsent(newArgs, '--top-k', 40)
    setIfAbsent(newArgs, '--repeat-penalty', 1.1)
    // Feature 26: Speculative decoding LM Studio defaults.
    setIfAbsent(newArgs, '--spec-draft-n-max', 3)
    setIfAbsent(newArgs, '--spec-draft-n-min', 0)
    setIfAbsent(newArgs, '--spec-draft-p-min', 0.75)
    // Task 4: Quick does NOT auto-apply recommended GPU layers — leave it
    // unset so llama-server uses its default ('auto'). The user can manually
    // apply the recommendation if desired.
    // (Previously: if (vramBudget && vramBudget.recommendedLayers > 0) newArgs['--gpu-layers'] = ...)
    // Task 2.1/2.2: Quick has the context-fill toggles OFF.
    newArgs['__ignoreCtxOverride'] = false
    newArgs['__autoCtxFill'] = 'off'
    // Task 5: Memory Overhead off by default in Quick.
    newArgs['__memOverheadEnabled'] = false
    commit(newArgs)
    // Feature 25: mark Quick as the active baseline so blue lines DON'T appear.
    setPresetMode('quick')
  }
  function handleClearPreset() {
    const newArgs: Record<string, any> = {}
    if (args['--mmproj'] !== undefined) newArgs['--mmproj'] = args['--mmproj']
    // Task 2.1/2.2: turn OFF the context-fill toggles in Clear mode.
    newArgs['__ignoreCtxOverride'] = false
    newArgs['__autoCtxFill'] = 'off'
    // Task 5: Memory Overhead off by default in Clear.
    newArgs['__memOverheadEnabled'] = false
    commit(newArgs)
    setPresetMode('clear')
  }
  // Task 5: FULL AUTO = Quick baselines + Ignore-Context-Override ON +
  // Auto-Context-Fill ON (Auto mode — llama-server handles offloading + ctx).
  // Stacks the best defaults so the user can "set it and forget it".
  function handleFullAutoPreset() {
    // Reuse the Quick baseline, then enable the two advanced context toggles.
    const newArgs: Record<string, any> = { ...args }
    if (meta?.contextLength && meta.contextLength > 0) {
      newArgs['--ctx-size'] = Math.min(meta.contextLength, 32768)
    }
    newArgs['--threads'] = recommendedThreads
    newArgs['--batch-size'] = 2048
    newArgs['--ubatch-size'] = 512
    newArgs['--parallel'] = 4
    newArgs['--flash-attn'] = 'on'
    newArgs['--mmap'] = true
    newArgs['--mlock'] = true
    newArgs['--kv-offload'] = true
    newArgs['--cache-type-k'] = kvQuant
    newArgs['--cache-type-v'] = kvQuant
    newArgs['--keep'] = 32
    newArgs['--temperature'] = 0.8
    newArgs['--top-p'] = 0.95
    newArgs['--min-p'] = 0.05
    newArgs['--top-k'] = 40
    newArgs['--repeat-penalty'] = 1.1
    newArgs['--spec-draft-n-max'] = 3
    newArgs['--spec-draft-n-min'] = 0
    newArgs['--spec-draft-p-min'] = 0.75
    if (vramBudget && vramBudget.recommendedLayers > 0) newArgs['--gpu-layers'] = vramBudget.recommendedLayers
    // Task 2.1/2.2: enable the advanced context-fill toggles.
    // FULL AUTO defaults to 'auto' (llama-server --fit handles offloading + ctx)
    // for both dense and MoE — the user can manually switch to Maximum if desired.
    newArgs['__ignoreCtxOverride'] = true
    newArgs['__autoCtxFill'] = 'auto'
    // Task 5: Memory Overhead off by default in FULL AUTO too.
    newArgs['__memOverheadEnabled'] = false
    commit(newArgs)
    setPresetMode('fullauto')
  }

  // ----- Command preview -----
  const cmdPreview = useMemo(() => {
    const parts: React.ReactNode[] = []
    parts.push(<span key="base">llama-server</span>)
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push(' ', <span key="arg-m" className="arg">-m</span>, ' ', <span key="val-m" className="val">"{finalModelPath}"</span>)
    // Build a runtime-accurate arg map: skip internal __ flags, and reflect the
    // AutoFill "Auto" → --fit on / no --ctx-size behavior (so the preview matches
    // what actually reaches llama-server).
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const runtimeArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith('__')) continue  // internal UI flags never reach llama-server
      if (k === '--ctx-size' || k === '-c') {
        if (isAutoFitAuto) continue  // Auto: no --ctx-size passed
      }
      if (k === '--fit' || k === '-fit') {
        if (isAutoFitAuto) { runtimeArgs[k] = 'on'; continue }
      }
      runtimeArgs[k] = v
    }
    if (isAutoFitAuto && runtimeArgs['--fit'] === undefined && runtimeArgs['-fit'] === undefined) {
      runtimeArgs['--fit'] = 'on'
    }
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      if (val === true) parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>)
      else if (val !== false && val !== null && val !== '') parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>, ' ', <span key={`val-${key}`} className="val">{val}</span>)
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && runtimeArgs['--port'] === undefined) parts.push(' ', <span key="arg-port" className="arg">--port</span>, ' ', <span key="val-port" className="val">{finalPort}</span>)
    return parts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback])

  // Task 5: plain-text version of the preview for the copy button.
  const cmdPreviewText = useMemo(() => {
    const parts: string[] = ['llama-server']
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push('-m', `"${finalModelPath}"`)
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const runtimeArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith('__')) continue
      if (k === '--ctx-size' || k === '-c') { if (isAutoFitAuto) continue }
      if (k === '--fit' || k === '-fit') { if (isAutoFitAuto) { runtimeArgs[k] = 'on'; continue } }
      runtimeArgs[k] = v
    }
    if (isAutoFitAuto && runtimeArgs['--fit'] === undefined && runtimeArgs['-fit'] === undefined) {
      runtimeArgs['--fit'] = 'on'
    }
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      if (val === true) parts.push(key)
      else if (val !== false && val !== null && val !== '') parts.push(key, String(val))
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && runtimeArgs['--port'] === undefined) parts.push('--port', String(finalPort))
    return parts.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback])

  const filteredCategories = useMemo(() => {
    if (!commandsSchema) return []
    let allCommands: CommandParam[] = []
    commandsSchema.categories.forEach(cat => allCommands.push(...cat.commands))
    const q = searchQuery.toLowerCase()
    if (q) {
      return commandsSchema.categories.map(cat => ({
        ...cat,
        commands: cat.commands.filter(cmd =>
          cmd.label.toLowerCase().includes(q) || cmd.arg.toLowerCase().includes(q) ||
          (cmd.short && cmd.short.toLowerCase().includes(q))
        )
      })).filter(cat => cat.commands.length > 0)
    }
    const featuredCommands = allCommands.filter(c => FEATURED_ARGS.includes(c.arg))
    const cats = commandsSchema.categories.map(cat => ({
      ...cat,
      commands: cat.commands.filter(c => {
        if (CUSTOM_PARAMS.includes(c.arg)) return false
        if (FEATURED_ARGS.includes(c.arg)) return false
        // Feature 30: "Common" view filters out low-level params.
        if (paramViewMode === 'common' && !COMMON_VISIBLE.has(c.arg)) return false
        return true
      })
    })).filter(cat => cat.commands.length > 0)
    if (featuredCommands.length > 0) {
      const filtered = paramViewMode === 'common'
        ? featuredCommands.filter(c => COMMON_VISIBLE.has(c.arg))
        : featuredCommands
      if (filtered.length > 0) {
        filtered.sort((a, b) => FEATURED_ARGS.indexOf(a.arg) - FEATURED_ARGS.indexOf(b.arg))
        cats.unshift({ name: 'Context and Performance', icon: 'Star', commands: filtered })
      }
    }
    return cats
  }, [commandsSchema, searchQuery, paramViewMode])

  if (!commandsSchema) return <div className="text-muted text-sm">No commands schema loaded. Ensure a backend is installed.</div>

  // ----- Render a single command row -----
  const renderCommand = (cmd: CommandParam) => {
    if (CUSTOM_PARAMS.includes(cmd.arg)) return null
    // Task 2: when AutoFill "Auto" is active, the Context Size block is
    // disabled (llama-server --fit decides context; we don't pass --ctx-size).
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const ctxDisabled = isAutoFitAuto && (cmd.arg === '--ctx-size' || cmd.arg === '-c')
    const val = args[cmd.arg] ?? (cmd.type === 'boolean' ? false : '')
    const isActive = args[cmd.arg] !== undefined && args[cmd.arg] !== false && args[cmd.arg] !== ''
    const changed = isChanged(cmd, val)
    const isHybrid = HYBRID_PARAMS.includes(cmd.arg)
    const rowDisabled = disabled || ctxDisabled
    return (
      <div key={cmd.arg} className={`cmd-row ${isActive ? 'active-param' : ''} ${changed ? 'changed-param' : ''} ${cmd.type === 'text' ? 'cmd-row-full' : ''} ${isHybrid ? 'cmd-row-hybrid' : ''}`}>
        {changed && <div className="changed-indicator" />}
        <div className="cmd-label-group">
          <div className="cmd-label tooltip-wrap">
            {cmd.label}
            {/* Fix 7: Removed the orange "Recommended" badge. Reset goes to 3/4 cores. */}
            <span className="tooltip">{cmd.description}</span>
          </div>
          <div className="cmd-arg">{cmd.short ? `${cmd.short}, ` : ''}{cmd.arg}</div>
        </div>
        <div className="cmd-input-group">
          {isHybrid && cmd.arg === '--threads' && (
            <HybridSlider value={val} min={0} max={physicalCores} step={1} onChange={v => handleUpdate(cmd.arg, v)} placeholder="auto" allowAuto disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--gpu-layers' && (
            <HybridSlider value={val} min={0} max={gpuLayersMax} step={1} onChange={v => handleUpdate(cmd.arg, v)} placeholder="auto" allowAuto disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--temperature' && (
            <HybridSlider value={val} min={0} max={2} step={0.01} onChange={v => handleUpdate(cmd.arg, v)} defaultVal={0.8} disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--top-p' && (
            <HybridSlider value={val} min={0} max={1} step={0.01} onChange={v => handleUpdate(cmd.arg, v)} defaultVal={0.95} disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--min-p' && (
            <HybridSlider value={val} min={0} max={1} step={0.01} onChange={v => handleUpdate(cmd.arg, v)} defaultVal={0.05} disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--top-k' && (
            <HybridSlider value={val} min={0} max={1000} step={1} onChange={v => handleUpdate(cmd.arg, v)} defaultVal={40} disabled={disabled} />
          )}
          {isHybrid && cmd.arg === '--ctx-size' && (
            <>
              <HybridSlider value={val} min={0} max={ctxSliderMax} step={1} onChange={v => handleUpdate(cmd.arg, v)} placeholder="32768" defaultVal={32768} disabled={rowDisabled} />
              {ctxDisabled && (
                <span style={{ fontSize: 10, color: 'var(--warning)', marginLeft: 6, whiteSpace: 'nowrap' }} title="Automatic Context Fill (Auto) is on — llama-server --fit decides context">
                  auto (--fit)
                </span>
              )}
            </>
          )}
          {!isHybrid && cmd.type === 'boolean' && (
            <div className="toggle-wrap">
              <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
                <input type="checkbox" checked={!!val} onChange={(e) => handleUpdate(cmd.arg, e.target.checked)} disabled={disabled} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          )}
          {!isHybrid && cmd.type === 'number' && (
            <input type="number" className="cmd-input" value={val} placeholder={cmd.default?.toString()} min={cmd.min} max={cmd.max} step="any" onChange={(e) => handleUpdate(cmd.arg, e.target.value === '' ? '' : Number(e.target.value))} disabled={disabled} />
          )}
          {!isHybrid && cmd.type === 'string' && (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', width: '100%' }}>
              <input type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={val} placeholder={cmd.placeholder || cmd.default?.toString()} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />
              <button type="button" className="num-btn" style={{ width: 28, height: 30, borderRadius: 'var(--radius-sm)' }} onClick={() => navigator.clipboard.readText().then(t => { if (t) handleUpdate(cmd.arg, t.replace(/(^"|"$)/g, '')) })} disabled={disabled} title="Paste from clipboard"><Clipboard size={14} /></button>
              <button type="button" className="num-btn" style={{ width: 28, height: 30, borderRadius: 'var(--radius-sm)' }} onClick={async () => { const f = await window.api?.pickAnyFile?.(); if (f) handleUpdate(cmd.arg, f) }} disabled={disabled} title="Browse file"><FolderOpen size={14} /></button>
            </div>
          )}
          {!isHybrid && cmd.type === 'select' && (
            <select className="cmd-select" value={val} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled}>
              <option value="">Default</option>
              {cmd.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </div>
        {changed && <button type="button" className="cmd-reset-btn" onClick={() => handleReset(cmd)} disabled={disabled} title="Reset to default"><RotateCcw size={12} /></button>}
        {cmd.type === 'text' && <textarea className="cmd-textarea" value={val} placeholder={cmd.placeholder} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />}
      </div>
    )
  }

  // ----- mmproj widget (feature 22: auto-toggle + unlock manual) -----
  const renderMmprojWidget = () => (
    <div className="mmproj-widget">
      <div className="mmproj-widget-title"><ImageIcon size={15} /> Multimodal Projector</div>
      <div className="mmproj-widget-arg">--mmproj, -mm · Path to multimodal projector file</div>
      <div className="mmproj-widget-row">
        <span className="mmproj-widget-label">Enable multimodal projector</span>
        <div className="toggle-wrap">
          <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
            <input type="checkbox" checked={mmprojOn} onChange={(e) => setMmprojOn(e.target.checked)} disabled={disabled} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>
      </div>
      {/* Fix 2: mmproj selection + status ALWAYS visible, even when projector is OFF. */}
      <div className="mmproj-widget-row" style={mmprojOn ? {} : { opacity: 0.5 }}>
        <span className="mmproj-widget-label">mmproj selection</span>
        <div className="mmproj-mode-toggle">
          <button type="button" className={`mmproj-mode-btn ${mmprojMode === 'auto' ? 'active' : ''}`} onClick={() => setMmprojMode('auto')} disabled={disabled || !mmprojOn}>Automatic</button>
          {/* Fix 2: Manual button is ALWAYS clickable — opens file picker. */}
          <button type="button" className={`mmproj-mode-btn ${mmprojMode === 'manual' ? 'active' : ''}`} onClick={() => setMmprojMode('manual')} disabled={disabled || !mmprojOn}>Manual</button>
        </div>
      </div>
      {/* Status always visible */}
      <div className="mmproj-widget-row" style={mmprojOn ? {} : { opacity: 0.5 }}>
        <span className="mmproj-widget-label">Status</span>
        {detectedMmproj ? <span className="mmproj-commentary detected"><CheckCircle2 size={13} /> mmproj detected</span> : <span className="mmproj-commentary absent"><XCircle size={13} /> mmproj not detected</span>}
      </div>
      {mmprojMode === 'auto' && detectedMmproj && mmprojOn && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: "var(--font-mono)", wordBreak: 'break-all' }}>Using: {detectedMmproj.path}</div>}
      {/* Manual path input + browse button — always visible when in manual mode */}
      {mmprojMode === 'manual' && mmprojOn && (
        <div className="mmproj-manual-row">
          <input type="text" className="form-input mono" style={{ flex: 1, minWidth: 0, fontSize: 12 }} value={typeof mmprojArgValue === 'string' ? mmprojArgValue : ''} placeholder="/path/to/mmproj.gguf" onChange={e => setMmprojManualPath(e.target.value)} disabled={disabled} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={pickMmprojFile} disabled={disabled} title="Browse"><FolderOpen size={14} /></button>
          {detectedMmproj && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMmprojManualPath(detectedMmproj.path)} disabled={disabled} title="Use detected mmproj"><Eye size={14} /> Use detected</button>}
        </div>
      )}
    </div>
  )

  // ----- Jinja Chat Template widget (feature 13) -----
  const renderJinjaWidget = () => (
    <div className={`mmproj-widget ${jinjaChanged ? 'changed-param' : ''}`}>
      {jinjaChanged && <div className="changed-indicator" />}
      <div className="mmproj-widget-title"><MessageSquare size={15} /> Jinja Chat Template</div>
      <div className="mmproj-widget-arg">--chat-template, --jinja · Custom Jinja chat template string</div>
      <div className="mmproj-widget-row">
        <span className="mmproj-widget-label">Enable Jinja templating</span>
        <div className="toggle-wrap">
          <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
            <input type="checkbox" checked={jinjaOn} onChange={(e) => setJinjaOn(e.target.checked)} disabled={disabled} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>
      </div>
      {jinjaOn && (
        <div style={{ position: 'relative', marginTop: 10 }}>
          <textarea
            className="cmd-textarea mono"
            style={{ width: '100%', minHeight: 150, fontSize: 13, resize: 'vertical' }}
            value={jinjaValue}
            placeholder="No chat template found in GGUF metadata. Empty = use llama.cpp internal parser."
            onChange={e => setJinjaValue(e.target.value)}
            disabled={disabled}
          />
          {jinjaChanged && (
            <button type="button" className="cmd-reset-btn" style={{ position: 'absolute', top: 4, right: 4, opacity: 1 }} onClick={resetJinja} disabled={disabled} title="Reset to model's native template">
              <RotateCcw size={12} />
            </button>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {nativeChatTemplate
              ? `Showing model's native tokenizer.chat_template (${nativeChatTemplate.length} chars). The native template is NOT passed to llama-server (—jinja alone applies it). Edit to customize — --chat-template is only added when the text differs from the native template by ≥1 symbol.`
              : 'No native chat_template found in GGUF metadata. Type a custom template to pass --chat-template; --jinja alone uses llama.cpp internal parser.'}
          </div>
        </div>
      )}
    </div>
  )

  // ----- Speculative Decoding widget (feature 9/26) -----
  const renderSpecWidget = () => {
    const detected = effectiveModelPath ? detectedSpeculation[effectiveModelPath] : null
    return (
      <div className="spec-widget">
        <div className="mmproj-widget-title"><Sparkles size={15} /> Speculative Decoding</div>
        <div className="mmproj-widget-arg">--spec-type · Accelerate generation using draft tokens</div>
        <div className="spec-widget-row">
          <span className="mmproj-widget-label">Mode</span>
          <select className="cmd-select" value={currentSpecMode} onChange={e => setSpecMode(e.target.value as SpeculationMode)} disabled={disabled}>
            {SPEC_OPTIONS.map(o => <option key={o.mode} value={o.mode}>{o.label}</option>)}
          </select>
        </div>
        {detected && detected.mode !== 'off' && (
          <div className="spec-detected-info"><Gauge size={12} /> Auto-detected: {detected.reason} (enable manually)</div>
        )}
        {/* Task 2: draft params shown whenever a spec mode is picked (not 'off').
            Values fall back to LM Studio defaults (3/0/0.75) so the boxes are
            never empty even if MTP wasn't detected. */}
        {currentSpecMode !== 'off' && (
          <div style={{ marginTop: 8 }}>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Max Draft Tokens <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(2-3 is recommended)</span></div><div className="cmd-arg">--spec-draft-n-max</div></div>
              <HybridSlider value={args['--spec-draft-n-max'] ?? 3} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-max', v)} defaultVal={3} disabled={disabled} />
            </div>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Min Draft Tokens</div><div className="cmd-arg">--spec-draft-n-min</div></div>
              <HybridSlider value={args['--spec-draft-n-min'] ?? 0} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-min', v)} defaultVal={0} disabled={disabled} />
            </div>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Draft Probability</div><div className="cmd-arg">--spec-draft-p-min</div></div>
              <HybridSlider value={args['--spec-draft-p-min'] ?? 0.75} min={0} max={1} step={0.01} onChange={v => handleUpdate('--spec-draft-p-min', v)} defaultVal={0.75} disabled={disabled} />
            </div>
          </div>
        )}
        {currentSpecMode === 'draft' && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>A draft model path (--spec-draft-model) is required for this mode.</div>}
      </div>
    )
  }

  // ----- MoE widget (feature 16) -----
  const renderMoeWidget = () => {
    if (!isMoe) return null
    const moeMax = expertCount > 0 ? expertCount : 256
    // Fix 1: expert_used_count = active experts. Default the slider to this value.
    const expertUsedCount = (meta as any)?.expertUsedCount || expertCount || 0
    const nExpertsVal = args['--n-experts-used']
    const nExpertsChanged = nExpertsVal !== undefined && nExpertsVal !== '' && nExpertsVal !== expertUsedCount
    return (
      <div className="spec-widget">
        <div className="mmproj-widget-title"><Layers size={15} /> MoE (Mixture of Experts)</div>
        <div className="mmproj-widget-arg">Total experts: {expertCount > 0 ? expertCount : 'unknown'} · Active experts: {expertUsedCount > 0 ? expertUsedCount : 'unknown'}</div>
        {/* Fix 2: Number of Active Experts — with blue line + reset button */}
        <div className={`cmd-row cmd-row-hybrid ${nExpertsChanged ? 'changed-param' : ''}`} style={{ padding: '8px 12px', border: '1px solid var(--border)', background: 'var(--surface)', position: 'relative', overflow: 'visible' }}>
          {nExpertsChanged && <div className="changed-indicator" />}
          <div className="cmd-label-group" style={{ paddingLeft: 4 }}>
            <div className="cmd-label">Number of Active Experts</div>
            <div className="cmd-arg">--n-experts-used</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HybridSlider
              value={nExpertsVal ?? expertUsedCount}
              min={1} max={moeMax} step={1}
              onChange={v => handleUpdate('--n-experts-used', v)}
              defaultVal={expertUsedCount}
              disabled={disabled}
            />
            {nExpertsChanged && (
              <button type="button" className="cmd-reset-btn" style={{ opacity: 1 }}
                onClick={() => handleUpdate('--n-experts-used', expertUsedCount)}
                disabled={disabled}
                title="Reset to model default">
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        </div>
        {/* Force MoE weights onto CPU layers (feature 16: inverse locking) */}
        <div className={`cmd-row cmd-row-hybrid ${moeCpuLayersSet ? 'changed-param' : ''}`} style={{ padding: '8px 12px', border: '1px solid var(--border)', background: 'var(--surface)', position: 'relative', overflow: 'visible' }}
          title={!gpuLayersManuallySet ? 'Accessible only when GPU Offload is configured manually' : ''}>
          {moeCpuLayersSet && <div className="changed-indicator" />}
          <div className="cmd-label-group" style={{ paddingLeft: 4 }}>
            <div className="cmd-label">Force MoE Weights onto CPU Layers</div>
            <div className="cmd-arg">--moe-force-cpu-layers</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HybridSlider
              value={moeCpuLayers}
              min={0} max={blockCount > 0 ? blockCount : 120} step={1}
              onChange={v => handleUpdate('--moe-cpu-layers', v)}
              placeholder={gpuLayersManuallySet ? '0' : 'auto'}
              allowAuto
              disabled={disabled || !gpuLayersManuallySet}
            />
            {/* Fix 1: Reset button for moe-cpu-layers */}
            {moeCpuLayersSet && (
              <button type="button" className="cmd-reset-btn" style={{ opacity: 1 }}
                onClick={() => handleUpdate('--moe-cpu-layers', '')}
                disabled={disabled}
                title="Reset to default">
                <RotateCcw size={12} />
              </button>
            )}
          </div>
          {!gpuLayersManuallySet && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4, width: '100%', paddingLeft: 4 }}>
              Accessible only when GPU Offload is configured manually
            </div>
          )}
        </div>
      </div>
    )
  }

  // ----- Reasoning Budget widget (feature 17) -----
  // Fix 3: ALL parameters need blue line + reset button.
  const reasoningBudgetChanged = reasoningOn && reasoningValue !== 8192
  const reasoningMsgChanged = reasoningOn && reasoningMessage !== '' && reasoningMessage !== 'I have to answer now.'
  const renderReasoningWidget = () => (
    <div className="spec-widget">
      <div className="mmproj-widget-title"><MessageSquare size={15} /> Reasoning Budget</div>
      <div className="mmproj-widget-arg">--reasoning-budget · Limit thinking tokens to prevent overthinking loops</div>
      <div className="mmproj-widget-row">
        <span className="mmproj-widget-label">Enable reasoning budget</span>
        <div className="toggle-wrap">
          <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
            <input type="checkbox" checked={reasoningOn} onChange={(e) => setReasoningOn(e.target.checked)} disabled={disabled} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>
      </div>
      {reasoningOn && (
        <>
          {/* Fix 3: Reasoning Budget row with blue line + reset */}
          <div className={`cmd-row cmd-row-hybrid ${reasoningBudgetChanged ? 'changed-param' : ''}`} style={{ padding: '8px 12px', border: '1px solid var(--border)', background: 'var(--surface)', position: 'relative', overflow: 'visible' }}>
            {reasoningBudgetChanged && <div className="changed-indicator" />}
            <div className="cmd-label-group" style={{ paddingLeft: 4 }}>
              <div className="cmd-label">Reasoning Budget (tokens)</div>
              <div className="cmd-arg">--reasoning-budget</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <HybridSlider value={reasoningValue} min={0} max={65536} step={1} onChange={v => setReasoningValue(v)} defaultVal={8192} disabled={disabled} />
              {reasoningBudgetChanged && (
                <button type="button" className="cmd-reset-btn" style={{ opacity: 1 }} onClick={() => setReasoningValue(8192)} disabled={disabled} title="Reset to default (8192)">
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
          {/* Fix 3: Reasoning Budget Message row with blue line + reset */}
          <div className={`cmd-row cmd-row-hybrid ${reasoningMsgChanged ? 'changed-param' : ''}`} style={{ padding: '8px 12px', border: '1px solid var(--border)', background: 'var(--surface)', position: 'relative', overflow: 'visible', marginTop: 6 }}>
            {reasoningMsgChanged && <div className="changed-indicator" />}
            <div className="cmd-label-group" style={{ paddingLeft: 4 }}>
              <div className="cmd-label">Reasoning Budget Message</div>
              <div className="cmd-arg">--reasoning-budget-message</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
              <input type="text" className="form-input" style={{ flex: 1 }} value={reasoningMessage} placeholder="I have to answer now." onChange={e => setReasoningMessage(e.target.value)} disabled={disabled} />
              {reasoningMsgChanged && (
                <button type="button" className="cmd-reset-btn" style={{ opacity: 1 }} onClick={() => setReasoningMessage('')} disabled={disabled} title="Reset to default">
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )

  // ----- Context block (Task 2.1/2.2/2.3): Ignore-Override + AutoFill + Memory Overhead -----
  // (autoFillResult + its effect are computed in the component body above/below)
  const renderContextBlock = () => {
    const totalMemMB = (vramBudget?.totalVRAMMB || 0) + (vramBudget?.totalRAMMB || 0)
    return (
      <div className="spec-widget">
        <div className="mmproj-widget-title"><Gauge size={15} /> Context</div>
        <div className="mmproj-widget-arg">Per-preset context control · --ctx-size · --fit</div>
        {/* 2.1: Ignore Context Length Override */}
        <div className="mmproj-widget-row">
          <span className="mmproj-widget-label">Ignore Context Length Override</span>
          <div className="toggle-wrap">
            <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
              <input type="checkbox" checked={ignoreCtxOverride} onChange={(e) => {
                const newArgs: Record<string, any> = { ...args, '__ignoreCtxOverride': e.target.checked }
                // Auto-disable AutoFill when Ignore-Override turns off (can't be used without it).
                if (!e.target.checked) newArgs['__autoCtxFill'] = 'off'
                commit(newArgs)
              }} disabled={disabled} />
              <span className="toggle-track"></span><span className="toggle-thumb"></span>
            </label>
          </div>
        </div>
        {ignoreCtxOverride && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 4 }}>
            When ON, this preset uses its own --ctx-size and ignores the global Minimum AutoFit override from Settings.
          </div>
        )}
        {/* 2.2: Use Automatic Context Fill */}
        <div className="mmproj-widget-row" style={ignoreCtxOverride ? {} : { opacity: 0.5 }}>
          <span className="mmproj-widget-label">
            Use Automatic Context Fill
            {!ignoreCtxOverride && <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>(requires Ignore Override)</span>}
          </span>
          <div className="toggle-wrap">
            <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
              <input type="checkbox" checked={autoCtxFill !== 'off'} onChange={(e) => {
                // Turning ON → default to 'auto' for dense. For MoE, 'maximum'
                // unless the MoE strategy is 'max' (conflict → 'auto').
                const newMode = e.target.checked ? (isMoe ? (moeStrategy === 'max' ? 'auto' : 'maximum') : 'auto') : 'off'
                commit({ ...args, '__autoCtxFill': newMode })
              }} disabled={disabled || !ignoreCtxOverride} />
              <span className="toggle-track"></span><span className="toggle-thumb"></span>
            </label>
          </div>
        </div>
        {/* MoE sub-toggle: Auto / Maximum available.
            Task 8: "Maximum available" is disabled when the MoE offload
            strategy is "MAX GPU Layers and Force MoE Weights onto CPU" (conflict). */}
        {ignoreCtxOverride && autoCtxFill !== 'off' && isMoe && (
          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">Fit context window up to:</span>
            <div className="mmproj-mode-toggle">
              <button type="button" className={`mmproj-mode-btn ${autoCtxFill === 'auto' ? 'active' : ''}`} onClick={() => commit({ ...args, '__autoCtxFill': 'auto' })} disabled={disabled}>Auto</button>
              <button type="button" className={`mmproj-mode-btn ${autoCtxFill === 'maximum' ? 'active' : ''}`} onClick={() => commit({ ...args, '__autoCtxFill': 'maximum' })} disabled={disabled || moeStrategy === 'max'} title={moeStrategy === 'max' ? 'Disabled: conflicts with MAX GPU Layers MoE strategy' : ''}>Maximum available</button>
            </div>
          </div>
        )}
        {ignoreCtxOverride && autoCtxFill === 'auto' && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 4 }}>
            {isMoe
              ? 'Auto: llama-server --fit handles GPU offloading + context evaluation automatically.'
              : 'Dense: the model is fit fully into the fastest memory (VRAM→RAM), then the remaining memory is filled with context up to the model\'s max.'}
          </div>
        )}
        {ignoreCtxOverride && autoCtxFill === 'maximum' && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingLeft: 4 }}>
            Maximum available: fills the context window up to the model's max, giving VRAM to the model and offloading the rest to RAM. Stops early if no memory remains.
          </div>
        )}
        {/* Task 5: Memory Overhead — on/off switch + slider. Off by default;
            default value 2.5 GB (2560 MB) when enabled. */}
        <div className="mmproj-widget-row" style={{ marginTop: 8 }}>
          <span className="mmproj-widget-label">Memory Overhead</span>
          <div className="toggle-wrap">
            <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
              <input type="checkbox" checked={memOverheadEnabled} onChange={(e) => {
                const newArgs: Record<string, any> = { ...args, '__memOverheadEnabled': e.target.checked }
                // When turning ON for the first time, seed the default 2.5 GB.
                if (e.target.checked && !args['__memOverheadMB']) newArgs['__memOverheadMB'] = 2560
                commit(newArgs)
              }} disabled={disabled} />
              <span className="toggle-track"></span><span className="toggle-thumb"></span>
            </label>
          </div>
        </div>
        {memOverheadEnabled && (
          <div className={`cmd-row cmd-row-hybrid`} style={{ padding: '8px 12px', border: '1px solid var(--border)', background: 'var(--surface)', position: 'relative', overflow: 'visible' }}>
            <div className="cmd-label-group" style={{ paddingLeft: 4 }}>
              <div className="cmd-label">Memory Overhead amount</div>
              <div className="cmd-arg">Reserves memory for other apps (reduces Free VRAM, then Free RAM)</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
              <HybridSlider
                value={memOverheadMB}
                min={0}
                max={totalMemMB > 0 ? totalMemMB : 32768}
                step={256}
                onChange={v => commit({ ...args, '__memOverheadMB': v })}
                defaultVal={2560}
                disabled={disabled}
              />
              <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 70, textAlign: 'right' }}>
                {memOverheadMB.toLocaleString()} MB
              </span>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ----- VRAM budget display (feature 14) -----
  const renderVramInfo = () => {
    if (!vramBudget) return null
    // Task 3: BPW-accurate VRAM breakdown (W + KV + B + O) so the user can see
    // exactly where the memory goes and verify the calculation.
    const kv = vramBudget as any
    return (
      <div className="vram-info-banner">
        <Gauge size={13} />
        <span>Free VRAM: {vramBudget.vramAvailable.toLocaleString()} MB</span>
        <span title="Model weight memory (≈ file size, mmap upper bound)">
          W: <strong>{Math.round(kv.weightMB || 0).toLocaleString()}</strong> MB
        </span>
        <span title={`KV cache — ${kv.kvArchitecture === 'mla' ? 'MLA' : kv.kvArchitecture.toUpperCase()} architecture, ${kv.bytesPerKvElement.toFixed(3)} bytes/elem × ctx × layers`}>
          KV: <strong>{Math.round(vramBudget.vramKV).toLocaleString()}</strong> MB
          <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>
            ({kv.kvArchitecture === 'mla' ? 'MLA' : kv.kvArchitecture.toUpperCase()} · {kv.bytesPerKvElement.toFixed(3)} B/e)
          </span>
        </span>
        {vramBudget.vramMM > 0 && <span>mmproj: {Math.round(vramBudget.vramMM).toLocaleString()} MB</span>}
        <span title="Compute & batch buffers — conservative 10% of W+KV (min 512 MB)">
          B: {Math.round(kv.computeBufferMB || 0).toLocaleString()} MB
        </span>
        <span title="Runtime overhead — CUDA context + mmap + tokenizer">
          O: {Math.round(kv.overheadMB || 0).toLocaleString()} MB
        </span>
        {/* Task 3: when the MoE offload strategy is "MAX GPU Layers and Force
            MoE Weights onto CPU", the recommended count is about non-expert
            layers forced to GPU (experts go to CPU), so the label changes. */}
        <span>
          {(isMoe && (modelDefaults.moeOffloadStrategy === 'max'))
            ? 'Recommended Force MoE Weights onto CPU Layers'
            : 'Recommended GPU layers'}: <strong>{vramBudget.recommendedLayers}</strong> / {vramBudget.maxLayers}
        </span>
        {vramBudget.modelFitsFully && <span style={{ color: 'var(--success)' }}>✓ Full offload</span>}
        {vramBudget.warning && <span style={{ color: 'var(--danger)' }}><AlertTriangle size={11} /> {vramBudget.warning}</span>}
      </div>
    )
  }

  return (
    <div className="params-editor-container">
      {/* Task 5: 3-way Settings toggle — FULL AUTO / Quick / Clear. FULL AUTO's
          label stacks "FULL" and "AUTO" vertically to save horizontal space. */}
      <SegmentedToggle
        label="Settings:"
        options={[
          { value: 'fullauto', label: 'FULL\nAUTO', icon: null as any },
          { value: 'quick', label: 'Quick' },
          { value: 'clear', label: 'Clear' }
        ]}
        value={presetMode}
        onChange={v => v === 'fullauto' ? handleFullAutoPreset() : v === 'quick' ? handleQuickPreset() : handleClearPreset()}
        disabled={disabled}
      />
      {/* Feature 30: Parameters Common/Full switch */}
      <SegmentedToggle
        label="Parameters:"
        options={[
          { value: 'common', label: 'Common' },
          { value: 'full', label: 'Full' }
        ]}
        value={paramViewMode}
        onChange={v => setParamViewMode(v as 'common' | 'full')}
        disabled={disabled}
      />
      {disabled && isRunning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', marginBottom: 12, borderRadius: 8, background: 'var(--surface-2, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))', color: 'var(--text-muted)', fontSize: 12 }}>
          <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
          Parameters are locked while the model is running. Stop it first to make changes.
        </div>
      )}
      {cpuInfo && (
        <div className="cpu-info-banner">
          <Cpu size={13} />
          <span>{cpuInfo.modelName}</span>
          <span className="cpu-info-cores">{cpuInfo.physicalCores} physical / {cpuInfo.logicalCores} logical cores</span>
          <span className="cpu-info-rec">Thread slider max: {physicalCores} · Recommended: {recommendedThreads}</span>
        </div>
      )}
      {/* Feature 29: Model context info (Task 3: + file_type/BPW + attention geometry) */}
      {meta && (
        <div className="cpu-info-banner">
          <Layers size={13} />
          <span>{meta.modelName || 'Unknown model'}</span>
          {meta.blockCount && <span className="cpu-info-cores">{meta.blockCount} layers</span>}
          {meta.contextLength && <span className="cpu-info-cores">Model supports up to {meta.contextLength.toLocaleString()} tokens</span>}
          {meta.fileType && (
            <span className="cpu-info-cores" title="Dominant quantization (general.file_type)">
              Quant: <strong>{meta.fileType}</strong>
            </span>
          )}
          {meta.kvLoraRank ? (
            <span className="cpu-info-cores" title="MLA attention: kv_lora_rank + qk_rope_head_dim">
              MLA: {meta.kvLoraRank}+{meta.qkRopeHeadDim || 0} latent dims
            </span>
          ) : (meta.headCountKv && (meta.keyLength || meta.hiddenSize) && (
            <span className="cpu-info-cores" title="Attention geometry used for BPW-accurate KV math">
              KV: {meta.headCountKv}h × {(meta.keyLength || (meta.hiddenSize! / (meta.headCount || 1)))}d
              {meta.valueLength && meta.valueLength !== (meta.keyLength || (meta.hiddenSize! / (meta.headCount || 1))) ? `/${meta.valueLength}d` : ''}
            </span>
          ))}
          {meta.slidingWindow && meta.slidingWindow > 0 && (
            <span className="cpu-info-cores" title="Sliding-window attention caps KV at this many tokens per SWA layer">
              SWA: {meta.slidingWindow.toLocaleString()}
            </span>
          )}
          {meta.isMoe
            ? <span style={{ color: 'var(--warning)' }}>MoE: {meta.expertCount || '?'} experts{meta.expertUsedCount ? ` (${meta.expertUsedCount} active)` : ''}</span>
            : <span className="cpu-info-cores" style={{ color: 'var(--success)' }}>Dense</span>}
        </div>
      )}
      {renderVramInfo()}
      {/* Task 2.1/2.2/2.3: Context block — Ignore-Override + AutoFill + Memory Overhead */}
      {renderContextBlock()}
      {/* Feature 28: Sampling presets manager */}
      <SamplingPresets
        onApply={(values) => {
          const newArgs = { ...args }
          if (values.temperature !== undefined) newArgs['--temperature'] = values.temperature
          if (values.topK !== undefined) newArgs['--top-k'] = values.topK
          if (values.topP !== undefined) newArgs['--top-p'] = values.topP
          if (values.minP !== undefined) newArgs['--min-p'] = values.minP
          if (values.repeatPenalty !== undefined) newArgs['--repeat-penalty'] = values.repeatPenalty
          if (values.presencePenalty !== undefined) newArgs['--presence-penalty'] = values.presencePenalty
          commit(newArgs)
        }}
        disabled={disabled}
      />
      {renderMmprojWidget()}
      {renderJinjaWidget()}
      {renderSpecWidget()}
      {renderMoeWidget()}
      {renderReasoningWidget()}
      <div className="params-search-box">
        <Search size={16} style={{ color: 'var(--text-muted)' }} />
        <input type="text" className="form-input" placeholder="Search parameters..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
      </div>
      <div className="params-scroll-area" style={disabled ? { opacity: 0.55, pointerEvents: 'none', userSelect: 'none' } : {}}>
        {filteredCategories.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted">No parameters matched your search.</div>
        ) : (
          filteredCategories.map((cat) => (
            <div key={cat.name} className="cmd-section">
              <div className="cmd-section-header" style={cat.name === 'Context and Performance' ? { color: 'var(--text)' } : {}}>
                {iconMap[cat.icon]} {cat.name}
              </div>
              <div className="cmd-grid">{cat.commands.map(renderCommand)}</div>
            </div>
          ))
        )}
      </div>
      {/* Task 5: Preview — selectable text + a copy button to copy the full
          llama-server command to the clipboard. */}
      <div className="cmd-section" style={{ marginBottom: 0, marginTop: 16 }}>
        <div className="cmd-section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Preview</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              navigator.clipboard.writeText(cmdPreviewText).then(() => {
                setPreviewCopied(true)
                setTimeout(() => setPreviewCopied(false), 1500)
              })
            }}
            title="Copy command to clipboard"
            style={{ width: 26, height: 26 }}
          >
            {previewCopied ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
          </button>
        </div>
        <div className="cmd-preview" style={{ userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>{cmdPreview}</div>
      </div>
    </div>
  )
}

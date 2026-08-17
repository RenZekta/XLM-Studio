import React, { useMemo, useState, useEffect } from 'react'
import { useStore } from '../store/useStore'
import {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch,
  Search, Star, Lock, Clipboard, FolderOpen, Eye, CheckCircle2, XCircle,
  Image as ImageIcon, RotateCcw, Gauge, Sparkles, Layers, AlertTriangle,
  MessageSquare
} from 'lucide-react'
import type { CommandParam, SpeculationMode } from '../../../shared/types'
import HybridSlider from './HybridSlider'
import SegmentedToggle from './SegmentedToggle'
import SamplingPresets from './SamplingPresets'
import { useVramBudget } from '../hooks/useVramBudget'

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
    detectedSpeculation, setDetectedSpeculation, speculationApplied, markSpeculationApplied,
    ggufMetadata, setGgufMetadata, activeBackend,
    paramViewMode, setParamViewMode, quickBaselineActive, setQuickBaselineActive
  } = useStore()
  const [searchQuery, setSearchQuery] = useState('')

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning

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
  const kvQuant = activeBackend?.backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo3' : 'q8_0'
  const vramBudget = useVramBudget({
    modelPath: effectiveModelPath,
    modelSizeMB,
    maxLayers: blockCount,
    contextSize: currentCtx,
    mmprojEnabled,
    mmprojSizeMB,
    kvQuantType: kvQuant
  })

  // Fix 9: Auto-apply the VRAM-recommended GPU layers when the budget is
  // calculated and the user hasn't manually set --gpu-layers. This prevents
  // the default "auto" from overwriting the calculated value.
  useEffect(() => {
    if (disabled || !vramBudget || vramBudget.recommendedLayers <= 0) return
    // Only auto-apply if the user hasn't manually set a value.
    if (args['--gpu-layers'] === undefined || args['--gpu-layers'] === '' || args['--gpu-layers'] === 'auto') {
      const newArgs = { ...args, '--gpu-layers': vramBudget.recommendedLayers }
      commit(newArgs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vramBudget?.recommendedLayers, disabled])

  // ----- mmproj widget state (Fix 3: ON by default, auto-turn OFF if not detected) -----
  const mmprojArgValue = args['--mmproj']
  const mmprojManuallyToggled = args['__mmproj_manual'] === true
  // Fix 3: mmproj is ON by default. It turns ON automatically if an mmproj file
  // is detected in the model's folder. If no mmproj is detected, it stays ON
  // but with no file selected (will be a no-op when running). The user can
  // manually toggle it off, and it won't auto-re-enable.
  const mmprojOn = mmprojManuallyToggled
    ? (args['__mmproj_enabled'] !== false)  // respect manual toggle
    : true  // default ON
  const mmprojMode: 'auto' | 'manual' = useMemo(() => {
    if (!mmprojOn) return 'auto'
    if (detectedMmproj && mmprojArgValue === detectedMmproj.path) return 'auto'
    return 'manual'
  }, [mmprojOn, mmprojArgValue, detectedMmproj])

  // Fix 3: Auto-select detected mmproj when ON and in auto mode.
  useEffect(() => {
    if (disabled) return
    if (mmprojOn && detectedMmproj) {
      // Auto-select the detected mmproj if not already set to it.
      if (args['--mmproj'] !== detectedMmproj.path) {
        commit({ ...args, '--mmproj': detectedMmproj.path })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedMmproj, disabled, mmprojOn])

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

  // ----- Speculation auto-detection (feature 9) -----
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    const cached = detectedSpeculation[effectiveModelPath]
    if (cached) { applySpecDetection(cached.mode); return }
    window.api?.detectSpeculation?.(effectiveModelPath).then(res => {
      if (res) { setDetectedSpeculation(effectiveModelPath, res.mode, res.reason); applySpecDetection(res.mode) }
    }).catch(() => {})
  }, [effectiveModelPath, disabled])
  function applySpecDetection(mode: SpeculationMode) {
    if (args['--spec-type'] !== undefined) return
    if (templateId && speculationApplied[templateId]) return
    if (mode === 'off') return
    const flag = SPEC_OPTIONS.find(o => o.mode === mode)?.flag
    if (flag) { commit({ ...args, '--spec-type': flag }); if (templateId) markSpeculationApplied(templateId, true) }
  }
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

  // ----- Jinja Chat Template (feature 13/Fix 5) -----
  // ON by default; auto-populate from tokenizer.chat_template; changed-state tracking.
  const jinjaOn = args['--jinja'] !== false  // default ON
  // Fix 5: Display the model's native template when --chat-template is not set.
  // If args has --chat-template, show that. Otherwise show nativeChatTemplate.
  const jinjaValue = typeof args['--chat-template'] === 'string' && args['--chat-template'] !== ''
    ? args['--chat-template']
    : (nativeChatTemplate || '')
  // Changed = user edited away from the native template.
  const jinjaChanged = nativeChatTemplate !== null && jinjaValue !== nativeChatTemplate
  // Fix 5: Auto-populate --chat-template with the native template when Jinja is ON
  // and the user hasn't set it yet.
  useEffect(() => {
    if (disabled || !jinjaOn || !nativeChatTemplate) return
    if (args['--chat-template'] === undefined || args['--chat-template'] === '') {
      const newArgs = { ...args, '--chat-template': nativeChatTemplate, '--jinja': true }
      commit(newArgs)
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
      // ON: auto-populate from native template if available.
      if (nativeChatTemplate && !args['--chat-template']) newArgs['--chat-template'] = nativeChatTemplate
      newArgs['--jinja'] = true
    }
    commit(newArgs)
  }
  function setJinjaValue(v: string) { commit({ ...args, '--chat-template': v }) }
  function resetJinja() {
    const newArgs = { ...args }
    if (nativeChatTemplate) newArgs['--chat-template'] = nativeChatTemplate
    else delete newArgs['--chat-template']
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
  function handleQuickPreset() {
    const newArgs = { ...args }
    // Feature 27: LM Studio engine performance bases.
    // Fix 2: Don't override --ctx-size. Let the model's native context be used.
    // Only set it if the model's context_length is known and larger than 32768.
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
    // Feature 26: Speculative decoding LM Studio defaults.
    newArgs['--spec-draft-n-max'] = 3
    newArgs['--spec-draft-n-min'] = 0
    newArgs['--spec-draft-p-min'] = 0.75
    // Feature 14: VRAM-recommended GPU layers.
    if (vramBudget && vramBudget.recommendedLayers > 0) newArgs['--gpu-layers'] = vramBudget.recommendedLayers
    commit(newArgs)
    // Feature 25: mark Quick as the active baseline so blue lines DON'T appear.
    setQuickBaselineActive(true)
  }
  function handleClearPreset() {
    const newArgs: Record<string, any> = {}
    if (args['--mmproj'] !== undefined) newArgs['--mmproj'] = args['--mmproj']
    commit(newArgs)
    setQuickBaselineActive(false)
  }

  // ----- Command preview -----
  const cmdPreview = useMemo(() => {
    const parts: React.ReactNode[] = []
    parts.push(<span key="base">llama-server</span>)
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push(' ', <span key="arg-m" className="arg">-m</span>, ' ', <span key="val-m" className="val">"{finalModelPath}"</span>)
    Object.entries(args).forEach(([key, val]) => {
      if (val === true) parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>)
      else if (val !== false && val !== null && val !== '') parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>, ' ', <span key={`val-${key}`} className="val">{val}</span>)
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && args['--port'] === undefined) parts.push(' ', <span key="arg-port" className="arg">--port</span>, ' ', <span key="val-port" className="val">{finalPort}</span>)
    return parts
  }, [args, cards, templateId, modelPathFallback, serverPortFallback])

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
    const val = args[cmd.arg] ?? (cmd.type === 'boolean' ? false : '')
    const isActive = args[cmd.arg] !== undefined && args[cmd.arg] !== false && args[cmd.arg] !== ''
    const changed = isChanged(cmd, val)
    const isHybrid = HYBRID_PARAMS.includes(cmd.arg)
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
            <HybridSlider value={val} min={0} max={ctxSliderMax} step={1} onChange={v => handleUpdate(cmd.arg, v)} placeholder="32768" defaultVal={32768} disabled={disabled} />
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
            {nativeChatTemplate ? `Showing model's native tokenizer.chat_template (${nativeChatTemplate.length} chars). Edit to customize.` : 'No native chat_template found in GGUF metadata'}
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
        {detected && detected.mode !== 'off' && currentSpecMode === detected.mode && (
          <div className="spec-detected-info"><Gauge size={12} /> Auto-detected: {detected.reason}</div>
        )}
        {/* Feature 26: LM Studio default draft params (shown when Quick or spec mode != off) */}
        {(currentSpecMode !== 'off' || quickBaselineActive) && (
          <div style={{ marginTop: 8 }}>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Max Draft Tokens <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>(2-3 is recommended)</span></div><div className="cmd-arg">--spec-draft-n-max</div></div>
              <HybridSlider value={args['--spec-draft-n-max']} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-max', v)} defaultVal={3} disabled={disabled} />
            </div>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Min Draft Tokens</div><div className="cmd-arg">--spec-draft-n-min</div></div>
              <HybridSlider value={args['--spec-draft-n-min']} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-min', v)} defaultVal={0} disabled={disabled} />
            </div>
            <div className="cmd-row cmd-row-hybrid" style={{ padding: '6px 0', border: 'none', background: 'transparent' }}>
              <div className="cmd-label-group"><div className="cmd-label">Draft Probability</div><div className="cmd-arg">--spec-draft-p-min</div></div>
              <HybridSlider value={args['--spec-draft-p-min']} min={0} max={1} step={0.01} onChange={v => handleUpdate('--spec-draft-p-min', v)} defaultVal={0.75} disabled={disabled} />
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

  // ----- VRAM budget display (feature 14) -----
  const renderVramInfo = () => {
    if (!vramBudget) return null
    return (
      <div className="vram-info-banner">
        <Gauge size={13} />
        <span>Free VRAM: {vramBudget.vramAvailable} MB</span>
        <span>Budget: {vramBudget.vramBudget} MB</span>
        <span>KV Cache: {Math.round(vramBudget.vramKV)} MB</span>
        {vramBudget.vramMM > 0 && <span>mmproj: {Math.round(vramBudget.vramMM)} MB</span>}
        <span>Recommended GPU layers: <strong>{vramBudget.recommendedLayers}</strong> / {vramBudget.maxLayers}</span>
        {vramBudget.modelFitsFully && <span style={{ color: 'var(--success)' }}>✓ Full offload</span>}
        {vramBudget.warning && <span style={{ color: 'var(--danger)' }}><AlertTriangle size={11} /> {vramBudget.warning}</span>}
      </div>
    )
  }

  return (
    <div className="params-editor-container">
      {/* Feature 15: Segmented toggle for Quick/Clear (single instance, not duplicated) */}
      <SegmentedToggle
        label="Settings:"
        options={[
          { value: 'quick', label: 'Quick' },
          { value: 'clear', label: 'Clear' }
        ]}
        value={quickBaselineActive ? 'quick' : 'clear'}
        onChange={v => v === 'quick' ? handleQuickPreset() : handleClearPreset()}
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
      {/* Feature 29: Model context info */}
      {meta && (
        <div className="cpu-info-banner">
          <Layers size={13} />
          <span>{meta.modelName || 'Unknown model'}</span>
          {meta.blockCount && <span className="cpu-info-cores">{meta.blockCount} layers</span>}
          {meta.contextLength && <span className="cpu-info-cores">Model supports up to {meta.contextLength} tokens</span>}
          {meta.isMoe && <span style={{ color: 'var(--warning)' }}>MoE: {meta.expertCount || '?'} experts</span>}
        </div>
      )}
      {renderVramInfo()}
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
      <div className="cmd-section" style={{ marginBottom: 0, marginTop: 16 }}>
        <div className="cmd-section-header">Preview</div>
        <div className="cmd-preview">{cmdPreview}</div>
      </div>
    </div>
  )
}

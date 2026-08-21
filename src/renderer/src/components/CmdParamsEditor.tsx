import React, { useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
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
import { useVramBudget, computeAutoFillContext, estimateMoeDefaultContext } from '../hooks/useVramBudget'
import { formatWithSpaces, CONTEXT_POWER_OF_TWO_STEPS, snapToNearestPowerOfTwo } from '../utils/contextFormat'
import { buildQuickEngineBaseline } from '../utils/presetBaselines'

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
// Bug fix (item 1.2): sampling values are per-model/user-preferred, set once
// at template creation from the starred sampling preset, and must NEVER be
// touched by the Quick/FullAuto/Clear engine presets. Shared list so every
// place that needs to check "is this a sampling key" (the initial-args
// detection, Clear's wipe, etc.) agrees on exactly the same set.
const SAMPLING_KEYS = ['--temperature', '--top-p', '--top-k', '--min-p', '--repeat-penalty', '--presence-penalty']

interface Props {
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
  // Bug fix (Task 1 follow-up): CreateModal wants the Settings/Parameters
  // toggles + CPU/model/Free-VRAM info banners to always be visible above the
  // collapsible "Advanced Parameters" section, not hidden inside it. Rather
  // than duplicate that JSX (and its state/hooks) in CreateModal, CmdParamsEditor
  // stays the single source of truth and portals that header block into a DOM
  // node CreateModal renders outside the collapsible area. When this isn't
  // provided (e.g. ModelCard's usage, which has no such split), the header
  // renders inline in its normal position as before.
  headerPortalTarget?: HTMLElement | null
  // Item 8: the actual launch command (see ModelCard.tsx's handleRunToggle)
  // pushes --no-webui when launchMode is 'api', on top of the stored args —
  // pass it through so the preview reflects that too.
  launchMode?: 'chat' | 'api'
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

export default function CmdParamsEditor({ templateId, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp, headerPortalTarget, launchMode }: Props) {
  const {
    commandsSchema, updateCard, cards, models, cpuInfo,
    detectedSpeculation, setDetectedSpeculation, markSpeculationApplied,
    ggufMetadata, setGgufMetadata, activeBackend,
    paramViewMode, setParamViewMode,
    setPresetMode, modelDefaults, samplingPresets
  } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [previewCopied, setPreviewCopied] = useState(false)  // Task 5: preview copy button

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning

  // Bug fix (Task 1.1): keep a ref mirroring the latest `args` prop. Async
  // callbacks (e.g. the speculation/MTP file-scan below) close over `args` as
  // of the render in which the effect fired. If the scan takes a while and the
  // parent's args change in the meantime (e.g. Quick preset finishing its own
  // commit), committing `{ ...args, ... }` from the stale closure would revert
  // those newer fields — silently discarding them and, from the user's
  // perspective, making the auto-selected MTP mode "not stick" or other Quick
  // settings mysteriously disappear. Reading argsRef.current at commit time
  // instead always bases the patch on the latest known args.
  const argsRef = useRef(args)
  useEffect(() => { argsRef.current = args }, [args])

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
      !k.startsWith('__') && !SAMPLING_KEYS.includes(k)
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

  // Bug fix (item 1 — toggle "stuck" on last-selected preset): `presetMode`
  // is a SINGLE GLOBAL store field shared across every open template/card, so
  // it only ever reflects whichever preset button was clicked MOST RECENTLY
  // ANYWHERE in the app — not necessarily anything to do with the template
  // currently being viewed. Opening a different template (or a fresh new
  // one, whose args were seeded synchronously without ever calling
  // setPresetMode) left the toggle showing a stale leftover value. Derive the
  // displayed/effective mode straight from THIS template's actual `args`
  // every render instead — a value that can never go stale, because it isn't
  // stored anywhere.
  //   - 'clear': no engine preset has been applied — Clear wipes ALL engine
  //     args (see handleClearPreset), so the tell is simply "--threads unset".
  //     Quick/FullAuto both always set --threads as part of their shared
  //     baseline (see buildQuickEngineBaseline), so its presence reliably
  //     means "some engine preset is active".
  //   - 'fullauto' vs 'quick': both set --threads identically, but only
  //     FullAuto turns on __ignoreCtxOverride (Quick explicitly turns it
  //     off) — a reliable, cheap discriminator between the two.
  const derivedPresetMode: 'quick' | 'fullauto' | 'clear' = args['--threads'] === undefined
    ? 'clear'
    : (args['__ignoreCtxOverride'] === true ? 'fullauto' : 'quick')

  // Feature 12: GPU layers slider max = block_count (fallback 120).
  const gpuLayersMax = blockCount > 0 ? blockCount : 120
  // Task 2.1/2.2/2.3/5: per-preset context-fill toggles + memory overhead.
  // (Moved up from below so the YaRN auto-scale logic right after it can see it.)
  const ignoreCtxOverride = args['__ignoreCtxOverride'] === true
  // Item 8: per-template "Automatic YaRN scaling control" — when on, unlocks
  // the Context Size slider up to 2 097 152 and auto-computes YaRN RoPE
  // scaling to reach whatever context the user picks.
  const yarnAutoScale = args['__yarnAutoScale'] === true
  // Item 5: the GLOBAL "Automatic YaRN scaling control override and upscale
  // to AutoFit" switch (Settings) also enables the same auto-scaling
  // behavior, but only when this preset is actually subject to the AutoFit
  // override (i.e. NOT ignoring it) AND the override is genuinely higher than
  // the model's native context — that's the only situation where "upscale
  // to AutoFit" has anything to do.
  const globalYarnUpscale = !!modelDefaults.autoFitYarnAutoScale && !ignoreCtxOverride &&
    modelDefaults.autoFitEnabled && contextLength > 0 && modelDefaults.autoFitContextLength > contextLength
  const effectiveYarnAutoScale = yarnAutoScale || globalYarnUpscale
  // Item 5: "Use 2x increments" for the per-template Context Size slider.
  const ctxUse2xIncrements = args['__ctxUse2xIncrements'] === true
  // Feature 29: Context slider max = model context_length (fallback 131072).
  // Item 8: unlocked to 2 097 152 while YaRN auto-scaling (per-template or via
  // the global upscale-to-AutoFit switch) is active, regardless of the
  // model's native context — that's the entire point of the switch.
  const ctxSliderMax = effectiveYarnAutoScale ? 2097152 : (contextLength > 0 ? contextLength : 131072)

  // Feature 14: VRAM budget calculation.
  const modelSizeMB = meta?.fileSizeMB || 0
  const mmprojEnabled = args['--mmproj'] !== undefined && args['--mmproj'] !== '' && args['--mmproj'] !== false
  const mmprojSizeMB = detectedMmproj ? Math.round(detectedMmproj.size / (1024 * 1024)) : 0
  const currentCtx = args['--ctx-size'] !== undefined && args['--ctx-size'] !== '' ? Number(args['--ctx-size']) : 32768
  // Default KV cache quant depends on the backend (TurboQuant fork → turbo3,
  // otherwise q8_0). The user can override per-template via --cache-type-k/v.
  const defaultKvQuant = activeBackend?.backendKey === 'atomic-llama-cpp-turboquant' ? 'turbo3' : 'q8_0'
  const kvQuantK = (typeof args['--cache-type-k'] === 'string' && args['--cache-type-k']) ? String(args['--cache-type-k']) : defaultKvQuant
  const kvQuantV = (typeof args['--cache-type-v'] === 'string' && args['--cache-type-v']) ? String(args['--cache-type-v']) : kvQuantK
  // Task 2.1/2.2/2.3/5: per-preset context-fill toggle + memory overhead.
  // (ignoreCtxOverride itself now declared above, near the YaRN logic that needs it.)
  const autoCtxFill = (args['__autoCtxFill'] as 'off' | 'auto' | 'maximum') || 'off'
  // Task 5: Memory Overhead — off by default everywhere. When enabled, the
  // default value is 2.5 GB (2560 MB). The overhead reduces Free VRAM then RAM.
  const memOverheadEnabled = args['__memOverheadEnabled'] === true
  const memOverheadMB = memOverheadEnabled ? (Number(args['__memOverheadMB']) || 2560) : 0
  // (moeStrategy local var removed — item 7 eliminated its only two call
  // sites; call sites elsewhere read modelDefaults.moeOffloadStrategy directly.)
  // Task 2: pass whether AutoFill "Auto" is active so useVramBudget can ignore
  // the selected ctx and check full-fit by speed priority for dense models.
  const autoFillAuto = ignoreCtxOverride && autoCtxFill === 'auto'
  // Bug fix (item 7): compute the YaRN-scaled effective max context (if RoPE
  // scaling is set to yarn) so the AutoFit guardrail warning doesn't
  // misfire against the model's raw (un-scaled) native context.
  const ropeScalingType = args['--rope-scaling']
  const ropeScaleFactor = Number(args['--rope-scale'])
  const ropeScaledMaxContext = (ropeScalingType === 'yarn' && ropeScaleFactor > 0 && contextLength > 0)
    ? Math.round(contextLength * ropeScaleFactor)
    : undefined
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
    autoFillAuto,
    ignoreCtxOverride,
    ropeScaledMaxContext
  })  // Task 4: Removed the gpu-layers auto-apply effect. The VRAM-recommended GPU
  // layers are now only a DISPLAY value (shown in the VRAM banner) — the user
  // must manually set --gpu-layers if they want to use it. Settings must not
  // turn themselves on/off (per the user's earlier directive), so Quick no
  // longer forces --gpu-layers either.

  // Item 7 (this round): for Dense models, Quick/FullAuto set --gpu-layers to
  // vramBudget.recommendedLayers at the moment the preset button is clicked
  // (or, for a brand-new template, synchronously at creation via
  // buildQuickEngineBaseline) — but vramBudget needs GGUF metadata, which
  // usually ISN'T available yet at either of those moments (no model has
  // been picked yet, or its metadata is still being fetched). The
  // recommendation was then simply never backfilled once that data actually
  // arrived, leaving Dense models sitting on an unset/"auto" --gpu-layers
  // under a preset that's supposed to guarantee a concrete recommended value.
  // This effect fills it in retroactively, without needing the user to
  // re-click the preset button.
  useEffect(() => {
    if (disabled || derivedPresetMode === 'clear' || isMoe) return
    if (!vramBudget || vramBudget.recommendedLayers <= 0) return
    const curArgs = argsRef.current
    if (curArgs['--gpu-layers'] !== vramBudget.recommendedLayers) {
      commit({ ...curArgs, '--gpu-layers': vramBudget.recommendedLayers })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, derivedPresetMode, isMoe, vramBudget?.recommendedLayers])

  // Item 3: the equivalent backfill for --ctx-size — Quick/FullAuto set it
  // at click/creation time based on model metadata (native context length,
  // and for MoE, the VRAM+RAM leftover estimate), but that data is USUALLY
  // NOT YET AVAILABLE at either of those moments for a brand-new template
  // (no model picked yet, or its metadata is still loading). Previously
  // nothing ever filled --ctx-size in once metadata actually arrived, which
  // is exactly why a freshly-created MoE template could sit on an unset
  // ("0"/empty, read as unlimited by the VRAM calculator) --ctx-size under a
  // preset that's supposed to guarantee a sensible default — this effect
  // fills it in retroactively, the same way the --gpu-layers effect above does.
  useEffect(() => {
    if (disabled || derivedPresetMode === 'clear' || !meta?.contextLength || meta.contextLength <= 0) return
    const curArgs = argsRef.current
    // Only backfill when --ctx-size is genuinely unset — never override a
    // value the user (or a prior successful preset application) already set.
    if (curArgs['--ctx-size'] !== undefined && curArgs['--ctx-size'] !== '') return
    let target: number
    if (isMoe && vramBudget) {
      target = estimateMoeDefaultContext({
        meta, modelSizeMB, kvQuantType: kvQuantK, kvQuantTypeV: kvQuantV,
        freeVRAMMB: vramBudget.freeVRAMMB, freeRAMMB: vramBudget.freeRAMMB,
        mmprojSizeMB: mmprojEnabled ? mmprojSizeMB : 0,
        fallback: Math.min(meta.contextLength, 32768), cap: meta.contextLength
      })
    } else {
      target = Math.min(meta.contextLength, 32768)
    }
    commit({ ...curArgs, '--ctx-size': target })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, derivedPresetMode, isMoe, meta?.contextLength, vramBudget?.freeVRAMMB, vramBudget?.freeRAMMB, modelSizeMB, kvQuantK, kvQuantV, mmprojEnabled, mmprojSizeMB])

  // Item 7: "Maximum available" AutoFill used to force-switch back to 'auto'
  // whenever the MoE strategy was "MAX GPU Layers and Force MoE Weights onto
  // CPU", on the assumption the two conflicted. That's no longer true — the
  // recommendation engine (Task 4 fix) now correctly computes how many
  // layers to force onto CPU to fit a given context under this strategy, so
  // "Maximum available" (fit the biggest context by moving layers to CPU as
  // needed) works fine together with it. This effect — and the disabled
  // state on the "Maximum available" button below — has been removed.

  // Item 8 (+ item 5's global "upscale to AutoFit"): "Automatic YaRN scaling
  // control" — while active (per-template switch, OR the global override
  // switch kicking in because this preset isn't ignoring an AutoFit override
  // that exceeds the model's native context), force RoPE scaling to yarn and
  // auto-compute the scale factor + original-context needed to reach the
  // relevant target context, per the reference formula:
  //   --rope-scaling yarn
  //   --rope-scale       = target_ctx / native_ctx   (>= 1)
  //   --yarn-orig-ctx     = native_ctx (the model's own trained context)
  // target_ctx is: the per-template --ctx-size normally, OR — when driven by
  // the global upscale switch rather than the per-template one — whichever is
  // larger of that and the global AutoFit override (the whole point of
  // "upscale to AutoFit" is reaching the override even if --ctx-size itself
  // is lower). Only recomputes when something actually changed, so this can't loop.
  useEffect(() => {
    if (disabled || !effectiveYarnAutoScale) return
    const nativeCtx = contextLength > 0 ? contextLength : 0
    if (!nativeCtx) return
    const curArgs = argsRef.current
    let targetCtx = currentCtx > 0 ? currentCtx : nativeCtx
    if (globalYarnUpscale) targetCtx = Math.max(targetCtx, modelDefaults.autoFitContextLength)
    const scale = targetCtx > nativeCtx ? Math.max(1, targetCtx / nativeCtx) : 1
    // Round the scale to 2 decimal places — llama.cpp accepts fractional
    // scales and this keeps the displayed/stored value tidy.
    const roundedScale = Math.round(scale * 100) / 100
    const needsUpdate = curArgs['--rope-scaling'] !== 'yarn' ||
      Number(curArgs['--rope-scale']) !== roundedScale ||
      Number(curArgs['--yarn-orig-ctx']) !== nativeCtx
    if (needsUpdate) {
      commit({
        ...curArgs,
        '--rope-scaling': 'yarn',
        '--rope-scale': roundedScale,
        '--yarn-orig-ctx': nativeCtx
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveYarnAutoScale, globalYarnUpscale, currentCtx, contextLength, disabled, modelDefaults.autoFitContextLength])

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
    const curArgs = argsRef.current
    const newArgs: Record<string, any> = { ...curArgs }
    let changed = false
    if (curArgs['--ctx-size'] !== autoFillResult.context) {
      newArgs['--ctx-size'] = autoFillResult.context
      changed = true
    }
    // Item 7: now that "Maximum available" is allowed together with the MoE
    // "MAX GPU Layers and Force MoE Weights onto CPU" strategy, also write
    // the layer placement it computed — not just --ctx-size — so the
    // strategy actually gets the CPU-forced layer count needed to fit the
    // context AutoFill just picked, instead of leaving --moe-cpu-layers at
    // whatever (possibly unrelated) value it had before. Dense/other MoE
    // modes are left exactly as before — only --ctx-size is auto-written for
    // them, same as pre-existing behavior.
    if (isMoe && modelDefaults.moeOffloadStrategy === 'max') {
      const cpuLayers = Math.max(0, autoFillResult.maxLayers - autoFillResult.layers)
      if (curArgs['--moe-cpu-layers'] !== cpuLayers) { newArgs['--moe-cpu-layers'] = cpuLayers; changed = true }
      if (curArgs['--gpu-layers'] !== autoFillResult.maxLayers) { newArgs['--gpu-layers'] = autoFillResult.maxLayers; changed = true }
    }
    if (changed) commit(newArgs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFillResult?.context, autoFillResult?.layers, autoFillResult?.maxLayers, disabled, isMoe, modelDefaults.moeOffloadStrategy])

  // Item 6: "With (L2/Ltotal) GPU Offload Layers selected, context window of
  // (C2) will fit into the (VRAM/RAM)" — the second Free-VRAM recommendation
  // line. Unlike autoFillResult above (which only runs when AutoFill=Maximum
  // and WRITES --ctx-size), this is a pure read-only projection computed
  // ALWAYS (whenever we have metadata + a VRAM budget) so the line can be
  // shown regardless of which AutoFill mode is active — it answers "if I use
  // (ideally) all my layers on the fastest memory, what's the biggest context
  // I could get", independent of what --ctx-size is currently set to.
  const maxFitResult = (meta && vramBudget) ? computeAutoFillContext({
    meta,
    modelSizeMB,
    maxLayers: blockCount || 120,
    maxContext: effectiveYarnAutoScale ? 2097152 : (contextLength > 0 ? contextLength : 131072),
    kvQuantType: kvQuantK,
    kvQuantTypeV: kvQuantV,
    freeVRAMMB: vramBudget.freeVRAMMB,
    freeRAMMB: vramBudget.freeRAMMB,
    mmprojSizeMB: mmprojEnabled ? mmprojSizeMB : 0,
    isMoe,
    activeExperts: (meta as any)?.expertUsedCount || expertCount || undefined,
    totalExperts: expertCount || undefined
  }) : null

  // ----- mmproj widget state (Task 2.1) -----
  // Task 2.1: if mmproj detected → ON + Automatic. If not detected → OFF + Manual.
  // The user can manually override at any time (tracked via __mmproj_manual).
  const mmprojArgValue = args['--mmproj']
  const mmprojManuallyToggled = args['__mmproj_manual'] === true
  const mmprojOn = mmprojManuallyToggled
    ? (args['__mmproj_enabled'] !== false)  // respect manual toggle
    // New Settings toggle: "Enable Multimodal Projector automatically in new
    // Template if mmproj was detected" — when OFF, a fresh/never-touched
    // template defaults mmproj to OFF even when one is detected (saves
    // memory for users who don't need vision), until manually turned on.
    // Defaults to true (matches the setting's own ON-by-default).
    : (!!detectedMmproj && modelDefaults.autoEnableMmproj !== false)
  const mmprojMode: 'auto' | 'manual' = useMemo(() => {
    if (!mmprojOn) return 'manual'  // off → show Manual
    if (detectedMmproj && mmprojArgValue === detectedMmproj.path) return 'auto'
    return mmprojManuallyToggled ? 'manual' : 'auto'
  }, [mmprojOn, mmprojArgValue, detectedMmproj, mmprojManuallyToggled])

  // Task 2.1: Auto-select detected mmproj when ON and in auto mode.
  useEffect(() => {
    if (disabled) return
    // Bug fix (item 1): base on argsRef.current, not `args` — see commit()
    // comment above for why this matters when sibling effects fire in the
    // same flush.
    const curArgs = argsRef.current
    if (mmprojOn && detectedMmproj) {
      if (curArgs['--mmproj'] !== detectedMmproj.path) {
        commit({ ...curArgs, '--mmproj': detectedMmproj.path })
      }
    } else if (!mmprojManuallyToggled && !detectedMmproj && curArgs['--mmproj'] !== undefined) {
      // No mmproj detected + not manually toggled → remove the --mmproj arg.
      const newArgs = { ...curArgs }
      delete newArgs['--mmproj']
      commit(newArgs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedMmproj, disabled, mmprojOn, mmprojManuallyToggled])

  function commit(newArgs: Record<string, any>) {
    // Bug fix (item 1 — MTP detected but not applied for vision+MTP models
    // like Qwen3.8-27B): multiple mount-time auto-apply effects (mmproj
    // detection, MTP/speculation detection, Jinja auto-enable, etc.) can all
    // become ready and fire within the SAME synchronous effect flush (e.g.
    // right after picking a model that has both an mmproj file AND a cached
    // speculation-detection result). Each one calls commit({ ...args, ownKey })
    // built from its own closure over `args` — but since no re-render happens
    // BETWEEN sibling effects in the same flush, every one of them reads the
    // exact same pre-flush `args` snapshot. React just applies each
    // setArgs(...) call in order as a full replacement, so only the LAST
    // effect's change survives — every earlier one is silently discarded.
    // This isn't the "async resolves late" staleness argsRef already guarded
    // against; it's two effects resolving in the SAME tick. Fixing it
    // requires argsRef to be current not just across renders but WITHIN a
    // single flush — so commit() now updates it eagerly and synchronously,
    // and every auto-apply effect below reads argsRef.current (not `args`)
    // as the base for its patch, so each one builds on top of whatever the
    // previous one in the same flush already committed.
    argsRef.current = newArgs
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
  //
  // Bug fix (this round): previously the "trigger the scan" and "apply the
  // result" logic were combined into ONE effect that only ever attempted to
  // apply the result at the two specific moments the scan resolved (from
  // cache, or from the async .then()). If literally anything interfered with
  // applying at exactly that moment — for any reason, including ones we
  // haven't been able to pin down without live debugging — the opportunity
  // was gone for good; nothing would ever retry. Split into two effects:
  // this one ONLY triggers the scan and records the result in the store.
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    if (detectedSpeculation[effectiveModelPath]) return  // already scanned/cached
    window.api?.detectSpeculation?.(effectiveModelPath).then(res => {
      if (res) setDetectedSpeculation(effectiveModelPath, res.mode, res.reason)
    }).catch(() => {})
  }, [effectiveModelPath, disabled, detectedSpeculation, setDetectedSpeculation])

  // Bug fix (this round): applying the detected mode is now a fully separate,
  // continuously-reactive effect (the same self-correcting "backfill" pattern
  // used for --gpu-layers and --ctx-size above) — it re-evaluates on every
  // render where the detected result, this template's args, or the disabled
  // state change, rather than only at the single moment the scan happened to
  // resolve. Once --spec-type is set (by this effect, or manually by the
  // user), the condition below is naturally false forever after, so this
  // can't loop or fight a manual choice — it just means a transient failure
  // to apply on the "first attempt" is no longer permanent.
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    const detected = detectedSpeculation[effectiveModelPath]
    if (!detected || detected.mode === 'off') return
    const curArgs = argsRef.current
    if (curArgs['--spec-type'] !== undefined) return  // already set (by us or the user)
    const flag = SPEC_OPTIONS.find(o => o.mode === detected.mode)?.flag
    if (flag) commit({ ...curArgs, '--spec-type': flag })
  }, [effectiveModelPath, disabled, detectedSpeculation, args])
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
  // Bug fix (item 1.5a): Jinja used to default to ON unconditionally (`args['--jinja']
  // !== false`), regardless of whether a native chat_template was actually found in
  // the GGUF metadata — so it looked "on everywhere" even for models with no
  // template to apply. It should default ON only when a native template was
  // actually detected, same "auto unless manually touched" pattern as mmproj.
  const jinjaManuallyToggled = args['__jinja_manual'] === true
  const jinjaOn = jinjaManuallyToggled ? (args['--jinja'] !== false) : !!nativeChatTemplate
  // Bug fix (item 1.5b): distinguish "no override yet, showing native template
  // for reference" from "user explicitly cleared the box" — previously these
  // were indistinguishable (both = args['--chat-template'] absent/empty), so
  // clearing the box just made it immediately snap back to showing the native
  // template on the next render, making it impossible to actually see an
  // empty box to paste a new template into. __jinja_cleared (UI-only, never
  // reaches the command) remembers the user's explicit "I cleared this" intent.
  const explicitChatTemplate = typeof args['--chat-template'] === 'string' ? args['--chat-template'] : undefined
  const jinjaUserCleared = args['__jinja_cleared'] === true
  const jinjaValue = explicitChatTemplate !== undefined
    ? explicitChatTemplate
    : (jinjaUserCleared ? '' : (nativeChatTemplate || ''))
  // Changed = user has an explicit override that differs from native, OR
  // explicitly cleared the box (both are "not showing the plain native
  // default anymore" states, so both get the changed-indicator + reset button).
  const jinjaChanged = (nativeChatTemplate !== null && explicitChatTemplate !== undefined && explicitChatTemplate !== nativeChatTemplate) || jinjaUserCleared
  // Ensure --jinja: true is set when Jinja is ON (so the flag actually reaches
  // llama-server). We deliberately do NOT auto-populate --chat-template here.
  useEffect(() => {
    if (disabled || !jinjaOn) return
    const curArgs = argsRef.current
    if (curArgs['--jinja'] !== true) {
      commit({ ...curArgs, '--jinja': true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nativeChatTemplate, jinjaOn, disabled])
  function setJinjaOn(on: boolean) {
    const newArgs: Record<string, any> = { ...args }
    newArgs['__jinja_manual'] = true
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
    if (v === '') {
      // Bug fix (item 1.5b): remove any override AND remember the user
      // explicitly cleared it, so the display stays empty on the next render
      // instead of snapping back to the native template — the whole point of
      // clearing is to paste something new into a visibly-empty box.
      delete newArgs['--chat-template']
      newArgs['__jinja_cleared'] = true
    } else if (nativeChatTemplate !== null && v === nativeChatTemplate) {
      // Exactly matches native — no need to pass an override at all.
      delete newArgs['--chat-template']
      delete newArgs['__jinja_cleared']
    } else {
      newArgs['--chat-template'] = v
      delete newArgs['__jinja_cleared']
    }
    if (jinjaOn) newArgs['--jinja'] = true
    commit(newArgs)
  }
  function resetJinja() {
    // Reset = revert to the native template (don't pass --chat-template at all).
    const newArgs = { ...args }
    delete newArgs['--chat-template']
    delete newArgs['__jinja_cleared']
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
  // Item 2: map each sampling arg to its field name on a SamplingPreset's
  // `values` object — used to diff against the currently-starred preset,
  // independent of whichever engine preset (Quick/FullAuto/Clear) is active.
  const SAMPLING_FIELD_MAP: Record<string, string> = {
    '--temperature': 'temperature', '--top-k': 'topK', '--top-p': 'topP',
    '--min-p': 'minP', '--repeat-penalty': 'repeatPenalty', '--presence-penalty': 'presencePenalty'
  }
  function getStarredSamplingValue(arg: string): any {
    const starred = samplingPresets?.find(p => p.isStarred) || samplingPresets?.[0]
    const field = SAMPLING_FIELD_MAP[arg]
    if (!starred?.values || !field) return undefined
    return (starred.values as any)[field]
  }

  function isChanged(cmd: CommandParam, val: any): boolean {
    // Bug fix (items 1.6/1.7): unify the two previously-separate highlight
    // systems into one, driven by whichever preset is ACTUALLY selected:
    //  - Clear: no preset is applied, so there's no baseline to diff against
    //    at all — nothing is ever highlighted as "changed" (this also
    //    replaces the old hexllama-era "active-param" contour, which used to
    //    highlight ANY set value regardless of preset — see item 1.7,
    //    removed below where the className is built).
    //  - Quick / FullAuto: both share the exact same engine baseline (see
    //    buildQuickEngineBaseline) — diff against THAT, not a stale
    //    hardcoded copy that could drift from what the button actually sets.
    // Item 2: sampling keys (temperature/top-p/etc.) are compared separately,
    // against the CURRENTLY STARRED sampling preset — never against the
    // engine preset (Quick/FullAuto/Clear never touch them, per item 1.2),
    // and this comparison applies regardless of derivedPresetMode/Clear,
    // since it's an independent axis from the engine baseline.
    if (SAMPLING_KEYS.includes(cmd.arg)) {
      const target = getStarredSamplingValue(cmd.arg)
      if (target === undefined) return false
      const currentSet = val !== undefined && val !== false && val !== ''
      if (!currentSet) return false
      return String(val) !== String(target)
    }
    if (derivedPresetMode === 'clear') return false
    // Bug fix (item 6): --gpu-layers isn't a static baseline value — Quick/
    // FullAuto set it dynamically based on Dense-vs-MoE (see the identical
    // isMoe branch in handleQuickPreset/handleFullAutoPreset): MoE leaves it
    // unset ("auto"), Dense sets it to vramBudget.recommendedLayers. The
    // generic quickBaselines lookup below has no entry for it at all, so it
    // was falling through to comparing against the schema's raw numeric
    // default — which doesn't understand "auto" — and lighting up as
    // "changed" for a MoE model sitting at its own correct baseline (auto vs
    // auto). Handle it explicitly, mirroring the actual preset logic exactly.
    if (cmd.arg === '--gpu-layers') {
      const expectedUnset = isMoe || !vramBudget || vramBudget.recommendedLayers <= 0
      const currentUnset = val === undefined || val === '' || val === false
      if (expectedUnset) return !currentUnset
      return currentUnset || String(val) !== String(vramBudget!.recommendedLayers)
    }
    const quickBaselines: Record<string, any> = buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey })
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
    // Item 2: sampling keys reset to the currently-starred sampling preset's
    // value — independent of the engine preset (Quick/FullAuto/Clear).
    if (SAMPLING_KEYS.includes(cmd.arg)) {
      const target = getStarredSamplingValue(cmd.arg)
      if (target !== undefined) {
        newArgs[cmd.arg] = target
        commit(newArgs)
        return
      }
    }
    // Bug fix (item 6): mirror the same explicit --gpu-layers handling as
    // isChanged() above — reset to "unset/auto" for MoE, or the VRAM-
    // recommended layer count for Dense.
    if (cmd.arg === '--gpu-layers' && derivedPresetMode !== 'clear') {
      if (isMoe || !vramBudget || vramBudget.recommendedLayers <= 0) {
        delete newArgs[cmd.arg]
      } else {
        newArgs[cmd.arg] = vramBudget.recommendedLayers
      }
      commit(newArgs)
      return
    }
    // Fix 5: Reset to the current preset baseline, not the schema default.
    // Bug fix (items 1.6/1.7): same unification as isChanged() above.
    if (derivedPresetMode !== 'clear' && !SAMPLING_KEYS.includes(cmd.arg)) {
      const quickBaselines: Record<string, any> = buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey })
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
    // Item 1.1 refactor: engine baseline now comes from the same pure
    // function CreateModal's lazy initializer uses, so the button and the
    // "apply on template creation" path can never drift apart.
    Object.assign(newArgs, buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey }))
    // ctx-size needs model metadata, which the shared baseline function
    // doesn't have access to — set it here only if not already present.
    // Item 3: MoE gets a memory-aware default (VRAM+RAM leftover after model
    // weight) rather than a flat 32768 cap — MoE tolerates RAM-resident
    // layers well, so there's usually much more usable context available
    // than a VRAM-only assumption would suggest. Dense keeps the flat cap
    // (Dense doesn't like being spread across memory tiers — see the
    // gpu-layers logic just below).
    if (meta?.contextLength && meta.contextLength > 0) {
      if (isMoe && vramBudget) {
        setIfAbsent(newArgs, '--ctx-size', estimateMoeDefaultContext({
          meta, modelSizeMB, kvQuantType: kvQuantK, kvQuantTypeV: kvQuantV,
          freeVRAMMB: vramBudget.freeVRAMMB, freeRAMMB: vramBudget.freeRAMMB,
          mmprojSizeMB: mmprojEnabled ? mmprojSizeMB : 0,
          fallback: Math.min(meta.contextLength, 32768), cap: meta.contextLength
        }))
      } else {
        setIfAbsent(newArgs, '--ctx-size', Math.min(meta.contextLength, 32768))
      }
    }
    // Bug fix (item 1.2): Quick/FullAuto/Clear must NEVER touch sampling
    // values (temperature, top-p, top-k, min-p, repeat-penalty, presence-
    // penalty) — those are per-model/user-preferred and set once at template
    // creation from the starred sampling preset (see CreateModal), then only
    // ever edited directly by the user or via the separate "apply sampling
    // preset" action. Switching Quick/FullAuto/Clear must leave them exactly
    // as they were. (Previously Quick used setIfAbsent — which still clobbered
    // them the moment Clear had wiped them out first — and FullAuto
    // unconditionally overwrote them with LM Studio's hardcoded defaults
    // every time it was clicked, even over a value the user had deliberately
    // set.)
    // Task 2: llama.cpp's built-in "auto" GPU-layers heuristic does a good job
    // splitting MoE layers between GPU/RAM (it's designed for that — offload
    // whole expert blocks, keep hot tensors on GPU), but a POOR job with Dense
    // models: it still splits them across GPU/CPU to squeeze out more context,
    // even though dense models suffer badly from any CPU-resident layers (every
    // token has to cross the PCIe bus for every single layer, not just the
    // active experts). So:
    //   - MoE   → leave --gpu-layers unset, llama-server's 'auto' handles it.
    //   - Dense → set --gpu-layers explicitly to the VRAM-recommended layer
    //             count so llama.cpp doesn't try to split it further.
    // Only applies once we actually know the model (meta) and have a VRAM
    // budget; otherwise (no model picked yet) leave it unset either way.
    if (isMoe) {
      delete newArgs['--gpu-layers']
    } else if (vramBudget && vramBudget.recommendedLayers > 0) {
      newArgs['--gpu-layers'] = vramBudget.recommendedLayers
    } else {
      delete newArgs['--gpu-layers']
    }
    commit(newArgs)
    // Feature 25: mark Quick as the active baseline so blue lines DON'T appear.
    setPresetMode('quick')
  }
  function handleClearPreset() {
    const newArgs: Record<string, any> = {}
    if (args['--mmproj'] !== undefined) newArgs['--mmproj'] = args['--mmproj']
    // Bug fix (item 1.2): Clear must preserve sampling values too — it wipes
    // the ENGINE args (everything else), not the model's/user's sampling
    // setup. Previously `newArgs = {}` dropped temperature/top-p/etc.
    // entirely, and then re-selecting Quick or FullAuto would silently
    // refill them with hardcoded LM Studio defaults instead of what was
    // actually there before.
    for (const k of SAMPLING_KEYS) {
      if (args[k] !== undefined) newArgs[k] = args[k]
    }
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
    // Item 1.1 refactor: same shared baseline as Quick, then override the
    // two advanced context toggles for FULL AUTO's "set it and forget it" behavior.
    const newArgs: Record<string, any> = { ...args }
    Object.assign(newArgs, buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey }))
    // Item 3: same MoE-aware default as Quick (see the identical note there).
    if (meta?.contextLength && meta.contextLength > 0) {
      if (isMoe && vramBudget) {
        newArgs['--ctx-size'] = estimateMoeDefaultContext({
          meta, modelSizeMB, kvQuantType: kvQuantK, kvQuantTypeV: kvQuantV,
          freeVRAMMB: vramBudget.freeVRAMMB, freeRAMMB: vramBudget.freeRAMMB,
          mmprojSizeMB: mmprojEnabled ? mmprojSizeMB : 0,
          fallback: Math.min(meta.contextLength, 32768), cap: meta.contextLength
        })
      } else {
        newArgs['--ctx-size'] = Math.min(meta.contextLength, 32768)
      }
    }
    // Bug fix (item 1.2): sampling values are never touched by presets — see
    // the identical note in handleQuickPreset above. FullAuto previously
    // unconditionally overwrote temperature/top-p/top-k/min-p/repeat-penalty
    // with hardcoded defaults every time, clobbering the user's/model's own
    // values — removed entirely.
    // Task 3: mirror Quick's Dense-vs-MoE GPU offload split (see the identical
    // logic + rationale in handleQuickPreset above) — previously FULL AUTO
    // always applied the recommended layer count to BOTH dense and MoE models,
    // which fights llama.cpp's own (good) MoE auto-split heuristic.
    if (isMoe) {
      delete newArgs['--gpu-layers']
    } else if (vramBudget && vramBudget.recommendedLayers > 0) {
      newArgs['--gpu-layers'] = vramBudget.recommendedLayers
    } else {
      delete newArgs['--gpu-layers']
    }
    // Task 2.1/2.2: enable the advanced context-fill toggles.
    // FULL AUTO defaults to 'auto' (llama-server --fit handles offloading + ctx)
    // for both dense and MoE — the user can manually switch to Maximum if desired.
    newArgs['__ignoreCtxOverride'] = true
    newArgs['__autoCtxFill'] = 'auto'
    commit(newArgs)
    setPresetMode('fullauto')
  }

  // ----- Command preview -----
  // Item 8: the preview must show what ACTUALLY reaches llama-server, not
  // just the raw stored args. Two things were previously invisible here:
  //  1. The global "Minimum Context Length Override" floor — when enabled and
  //     not ignored, ModelCard.tsx's actual launch logic uses
  //     max(preset --ctx-size, override) as the real --ctx-size, but the
  //     preview only ever showed the raw preset value.
  //  2. The default --port fallback was already shown, but let's make the
  //     "this differs from the stored value" case visually obvious too, so
  //     the user can tell at a glance when something here isn't literally
  //     what's saved in the template.
  // effectiveCtx below duplicates ModelCard.tsx's calculation exactly (same
  // fallback chain, same floor behavior) so the preview and the actual
  // launch can never disagree.
  const previewEffectiveCtx = useMemo(() => {
    const presetCtx = args['--ctx-size']
    const presetVal = presetCtx !== undefined && presetCtx !== '' && presetCtx !== null ? Number(presetCtx) : 0
    const native = contextLength > 0 ? contextLength : 0
    let base = presetVal > 0 ? presetVal : (native > 0 ? native : 32768)
    if (!ignoreCtxOverride && modelDefaults?.autoFitEnabled) {
      const minCtx = Math.max(2048, Number(modelDefaults.autoFitContextLength) || 32768)
      base = Math.max(base, minCtx)
    }
    return base
  }, [args, contextLength, ignoreCtxOverride, modelDefaults])
  const ctxOverriddenInPreview = (() => {
    if (ignoreCtxOverride || !modelDefaults?.autoFitEnabled) return false
    const rawCtx = args['--ctx-size'] !== undefined && args['--ctx-size'] !== '' && args['--ctx-size'] !== null ? Number(args['--ctx-size']) : 0
    return previewEffectiveCtx > rawCtx
  })()

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
        continue // handled below via previewEffectiveCtx, which folds in the override floor
      }
      if (k === '--fit' || k === '-fit') {
        if (isAutoFitAuto) { runtimeArgs[k] = 'on'; continue }
      }
      runtimeArgs[k] = v
    }
    if (isAutoFitAuto && runtimeArgs['--fit'] === undefined && runtimeArgs['-fit'] === undefined) {
      runtimeArgs['--fit'] = 'on'
    }
    if (!isAutoFitAuto) {
      runtimeArgs['--ctx-size'] = previewEffectiveCtx
    }
    // Item 8: API launch mode adds --no-webui dynamically at run time (see
    // ModelCard.tsx handleRunToggle) — reflect it here too if not already set.
    if (launchMode === 'api' && runtimeArgs['--no-webui'] === undefined) {
      runtimeArgs['--no-webui'] = true
    }
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      const isOverriddenCtx = key === '--ctx-size' && ctxOverriddenInPreview
      if (val === true) parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>)
      else if (val !== false && val !== null && val !== '') {
        parts.push(
          ' ',
          <span key={`arg-${key}`} className="arg">{key}</span>,
          ' ',
          <span
            key={`val-${key}`}
            className={isOverriddenCtx ? 'val cmd-preview-overridden' : 'val'}
            title={isOverriddenCtx ? `Raised from this preset's own ${formatWithSpaces(Number(args['--ctx-size']) || 0)} by the global Minimum AutoFit override` : undefined}
          >{val}</span>
        )
      }
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && runtimeArgs['--port'] === undefined) parts.push(' ', <span key="arg-port" className="arg">--port</span>, ' ', <span key="val-port" className="val">{finalPort}</span>)
    return parts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback, previewEffectiveCtx, ctxOverriddenInPreview, launchMode])

  // Task 5: plain-text version of the preview for the copy button.
  const cmdPreviewText = useMemo(() => {
    const parts: string[] = ['llama-server']
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push('-m', `"${finalModelPath}"`)
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const runtimeArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith('__')) continue
      if (k === '--ctx-size' || k === '-c') { continue } // handled below via previewEffectiveCtx
      if (k === '--fit' || k === '-fit') { if (isAutoFitAuto) { runtimeArgs[k] = 'on'; continue } }
      runtimeArgs[k] = v
    }
    if (isAutoFitAuto && runtimeArgs['--fit'] === undefined && runtimeArgs['-fit'] === undefined) {
      runtimeArgs['--fit'] = 'on'
    }
    if (!isAutoFitAuto) {
      runtimeArgs['--ctx-size'] = previewEffectiveCtx
    }
    if (launchMode === 'api' && runtimeArgs['--no-webui'] === undefined) {
      runtimeArgs['--no-webui'] = true
    }
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      if (val === true) parts.push(key)
      else if (val !== false && val !== null && val !== '') parts.push(key, String(val))
    })
    const finalPort = card?.template.serverPort || serverPortFallback
    if (finalPort && runtimeArgs['--port'] === undefined) parts.push('--port', String(finalPort))
    return parts.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback, previewEffectiveCtx, launchMode])

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
    // Bug fix (item 1.7): removed the legacy hexllama-era "active-param"
    // contour, which highlighted ANY set value regardless of which preset was
    // selected (i.e. "differs from nothing") — redundant now that
    // isChanged()/changed-param does the equivalent job relative to whichever
    // preset is actually selected (and correctly shows nothing under Clear,
    // where there's no preset baseline to diff against at all).
    const changed = isChanged(cmd, val)
    const isHybrid = HYBRID_PARAMS.includes(cmd.arg)
    const rowDisabled = disabled || ctxDisabled
    return (
      <div key={cmd.arg} className={`cmd-row ${changed ? 'changed-param' : ''} ${cmd.type === 'text' ? 'cmd-row-full' : ''} ${isHybrid ? 'cmd-row-hybrid' : ''}`}>
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
              <HybridSlider
                value={val} min={0} max={ctxSliderMax} step={1}
                onChange={v => handleUpdate(cmd.arg, v)}
                placeholder="32768" defaultVal={32768} disabled={rowDisabled}
                useSpacedFormat
                use2xIncrements={ctxUse2xIncrements}
                ladderSteps={CONTEXT_POWER_OF_TWO_STEPS}
              />
              {ctxDisabled && (
                <span style={{ fontSize: 10, color: 'var(--warning)', marginLeft: 6, whiteSpace: 'nowrap' }} title="Automatic Context Fill (Auto) is on — llama-server --fit decides context">
                  auto (--fit)
                </span>
              )}
              {/* Item 5: per-template "Use 2x increments" — locks the slider above
                  to the 2k/4k/8k/.../2M ladder and formats the number field with
                  spaces, same convention as the global AutoFit slider in Settings. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: rowDisabled ? 'not-allowed' : 'pointer' }}>
                  <input type="checkbox" checked={ctxUse2xIncrements} disabled={rowDisabled} onChange={(e) => {
                    const use2x = e.target.checked
                    const newArgs: Record<string, any> = { ...args, '__ctxUse2xIncrements': use2x }
                    if (use2x && currentCtx > 0) newArgs['--ctx-size'] = snapToNearestPowerOfTwo(currentCtx, CONTEXT_POWER_OF_TWO_STEPS.filter(s => s <= ctxSliderMax))
                    commit(newArgs)
                  }} />
                  Use 2x increments
                </label>
                {/* Item 8: per-template YaRN auto-scaling — see the effect above
                    that computes --rope-scaling/--rope-scale/--yarn-orig-ctx. */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: rowDisabled ? 'not-allowed' : 'pointer' }} title="Overrides RoPE Scaling to 'yarn', unlocks this slider to 2 097 152, and auto-computes the scale factor needed to reach whatever context you pick.">
                  <input type="checkbox" checked={yarnAutoScale} disabled={rowDisabled} onChange={(e) => {
                    commit({ ...args, '__yarnAutoScale': e.target.checked })
                  }} />
                  Automatic YaRN scaling control
                </label>
              </div>
              {effectiveYarnAutoScale && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {contextLength > 0
                    ? `Native context: ${formatWithSpaces(contextLength)}. RoPE Scaling, RoPE Scale and YaRN Original Context are now managed automatically for this preset${(!yarnAutoScale && globalYarnUpscale) ? ' (via the global "upscale to AutoFit" setting)' : ''}.`
                    : `Waiting on model metadata to know the native context to scale from…`}
                </div>
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
            placeholder={
              // Bug fix (item 4): the placeholder used to unconditionally say
              // "No chat template found in GGUF metadata" — misleading when a
              // native template WAS found and the user just cleared the box
              // to paste something new (it looked like detection had failed).
              // Distinguish the two cases properly.
              nativeChatTemplate
                ? "Empty — the model's own Jinja chat template (detected in GGUF metadata) will be used."
                : 'No chat template found in GGUF metadata. Empty = use llama.cpp internal parser.'
            }
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
              ? (jinjaUserCleared
                  ? `Box cleared — the model's native tokenizer.chat_template (${nativeChatTemplate.length} chars) will be used, exactly as if nothing had been typed here. Paste a new template to override it, or hit reset to see the native one again.`
                  : `Showing model's native tokenizer.chat_template (${nativeChatTemplate.length} chars). The native template is NOT passed to llama-server (—jinja alone applies it). Edit to customize — --chat-template is only added when the text differs from the native template by ≥1 symbol.`)
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
          <div className="spec-detected-info"><Gauge size={12} /> Auto-detected: {detected.reason} (applied automatically)</div>
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
                // Item 7: turning ON now defaults to 'maximum' for BOTH dense
                // and MoE regardless of the MoE offload strategy — the old
                // "MAX strategy conflicts with Maximum available" assumption
                // no longer holds (see the removed force-effect above).
                const newMode = e.target.checked ? (isMoe ? 'maximum' : 'auto') : 'off'
                commit({ ...args, '__autoCtxFill': newMode })
              }} disabled={disabled || !ignoreCtxOverride} />
              <span className="toggle-track"></span><span className="toggle-thumb"></span>
            </label>
          </div>
        </div>
        {/* MoE sub-toggle: Auto / Maximum available.
            Item 7: "Maximum available" is now always available regardless of
            MoE offload strategy — the recommendation engine correctly
            computes how many layers to force onto CPU to fit the requested
            context even under "MAX GPU Layers and Force MoE Weights onto CPU". */}
        {ignoreCtxOverride && autoCtxFill !== 'off' && isMoe && (
          <div className="mmproj-widget-row">
            <span className="mmproj-widget-label">Fit context window up to:</span>
            <div className="mmproj-mode-toggle">
              <button type="button" className={`mmproj-mode-btn ${autoCtxFill === 'auto' ? 'active' : ''}`} onClick={() => commit({ ...args, '__autoCtxFill': 'auto' })} disabled={disabled}>Auto</button>
              <button type="button" className={`mmproj-mode-btn ${autoCtxFill === 'maximum' ? 'active' : ''}`} onClick={() => commit({ ...args, '__autoCtxFill': 'maximum' })} disabled={disabled}>Maximum available</button>
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
  // Item 6: apply the recommended GPU-layers / CPU-forced-layers value from
  // line 1 (L1) into --gpu-layers or --moe-cpu-layers depending on strategy.
  function applyLine1Recommendation() {
    if (!vramBudget) return
    if (isMoe && modelDefaults.moeOffloadStrategy === 'max') {
      commit({ ...args, '--moe-cpu-layers': vramBudget.recommendedLayers, '--gpu-layers': vramBudget.maxLayers })
    } else {
      commit({ ...args, '--gpu-layers': vramBudget.recommendedLayers })
    }
  }
  // Item 6: apply line 2's projection — L2 GPU layers (ideally = all layers)
  // and the context that fits alongside them.
  function applyLine2Recommendation() {
    if (!maxFitResult) return
    const newArgs: Record<string, any> = { ...args, '--ctx-size': maxFitResult.context }
    if (isMoe && modelDefaults.moeOffloadStrategy === 'max') {
      newArgs['--gpu-layers'] = maxFitResult.maxLayers
      newArgs['--moe-cpu-layers'] = Math.max(0, maxFitResult.maxLayers - maxFitResult.layers)
    } else {
      newArgs['--gpu-layers'] = maxFitResult.layers
    }
    commit(newArgs)
  }

  const renderVramInfo = () => {
    if (!vramBudget) return null
    // Task 3: BPW-accurate VRAM breakdown (W + KV + B + O) so the user can see
    // exactly where the memory goes and verify the calculation.
    const kv = vramBudget as any
    const isMaxStrategy = isMoe && modelDefaults.moeOffloadStrategy === 'max'
    const c1 = formatWithSpaces(vramBudget.autoFitContext)
    // Item 6, line 1: label depends on Dense vs MoE (vs MoE+"max" strategy).
    const line1Label = !isMoe
      ? `${vramBudget.recommendedLayers}/${vramBudget.maxLayers} layers fit on your GPU with ${c1} context window`
      : isMaxStrategy
        ? `${vramBudget.recommendedLayers}/${vramBudget.maxLayers} Layers need to be Forced onto CPU Layers to fit ${c1} context window`
        : `${vramBudget.recommendedLayers}/${vramBudget.maxLayers} Layers need to be offloaded to GPU to fit ${c1} context window`
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
        {/* Item 6: redesigned recommendation lines, each with a small ✓ apply button. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
          <span style={{ flex: 1 }}>{line1Label}</span>
          <button
            type="button"
            className="vram-apply-btn"
            title="Apply this recommendation"
            onClick={applyLine1Recommendation}
            disabled={disabled}
          >
            <Check size={11} />
          </button>
        </div>
        {/* Item 5: line 2 only makes sense for Dense models — for MoE, the
            model is often much larger than total VRAM by design (that's the
            point of MoE), so "put everything on GPU, get a huge context in
            RAM" is nonsensical: RAM is slower, and for MoE we always want the
            fast tier (VRAM) prioritized for KV, never RAM for context. */}
        {maxFitResult && !isMoe && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
            <span style={{ flex: 1 }}>
              With {maxFitResult.layers}/{maxFitResult.maxLayers} GPU Offload Layers, context window of {formatWithSpaces(maxFitResult.context)} will fit into the {maxFitResult.usedVRAM ? 'VRAM' : 'RAM'}
            </span>
            <button
              type="button"
              className="vram-apply-btn"
              title="Apply this recommendation"
              onClick={applyLine2Recommendation}
              disabled={disabled}
            >
              <Check size={11} />
            </button>
          </div>
        )}
        {vramBudget.modelFitsFully && <span style={{ color: 'var(--success)' }}>✓ Full offload</span>}
        {vramBudget.warning && <span style={{ color: 'var(--danger)' }}><AlertTriangle size={11} /> {vramBudget.warning}</span>}
      </div>
    )
  }

  const headerContent = (
    <>
      {/* Task 5: 3-way Settings toggle — FULL AUTO / Quick / Clear. FULL AUTO's
          label stacks "FULL" and "AUTO" vertically to save horizontal space. */}
      <SegmentedToggle
        label="Settings:"
        options={[
          { value: 'fullauto', label: 'FULL\nAUTO', icon: null as any },
          { value: 'quick', label: 'Quick' },
          { value: 'clear', label: 'Clear' }
        ]}
        value={derivedPresetMode}
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
            <span
              className="cpu-info-cores"
              title={
                // Bug fix (item 2): explain the source, and flag it when the
                // filename-derived label (what's shown) disagrees with the
                // internal general.file_type metadata (which can happen for
                // Unsloth Dynamic/mixed quants — see parseQuantFromFilename
                // in ipc.ts).
                (meta as any).fileTypeInternal && (meta as any).fileTypeInternal !== meta.fileType
                  ? `From filename. Internal general.file_type metadata says "${(meta as any).fileTypeInternal}" — Dynamic/mixed quants intentionally use different bit-widths per tensor, so this can legitimately differ.`
                  : 'Quantization (from filename, or general.file_type if the filename has no recognizable quant label)'
              }
            >
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
    </>
  )

  return (
    <div className="params-editor-container">
      {headerPortalTarget ? createPortal(headerContent, headerPortalTarget) : headerContent}
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

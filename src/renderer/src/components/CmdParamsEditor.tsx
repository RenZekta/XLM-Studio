import React, { useMemo, useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/useStore'
import {
  Box, Cpu, Zap, Database, Sliders, Wind, Server, FileText, GitBranch,
  Search, Star, Lock, Clipboard, FolderOpen, Eye, CheckCircle2, XCircle,
  Image as ImageIcon, RotateCcw, Gauge, Sparkles, Layers, AlertTriangle,
  MessageSquare, Copy, Check
} from 'lucide-react'
import type { CommandParam, SpecMethod } from '../../../shared/types'
import HybridSlider from './HybridSlider'
import SegmentedToggle from './SegmentedToggle'
import SamplingPresets from './SamplingPresets'
import { useVramBudget, computeAutoFillContext, estimateMoeDefaultContext } from '../hooks/useVramBudget'
import { formatWithSpaces, CONTEXT_POWER_OF_TWO_STEPS, snapToNearestPowerOfTwo } from '../utils/contextFormat'
import { buildQuickEngineBaseline, computeRecommendedThreads, defaultKvQuantFor, defaultKvQuantVFor } from '../utils/presetBaselines'

const iconMap: Record<string, React.ReactNode> = {
  Box: <Box size={14} />, Cpu: <Cpu size={14} />, Zap: <Zap size={14} />,
  Database: <Database size={14} />, Sliders: <Sliders size={14} />, Wind: <Wind size={14} />,
  Server: <Server size={14} />, FileText: <FileText size={14} />, GitBranch: <GitBranch size={14} />,
  Star: <Star size={14} />
}
const FEATURED_ARGS = ['--ctx-size', '--gpu-layers', '--threads', '--batch-size', '--flash-attn']
const HYBRID_PARAMS = ['--threads', '--gpu-layers', '--temperature', '--top-p', '--top-k', '--min-p', '--ctx-size', '--moe-cpu-layers']
// Params that get a custom widget (excluded from the regular command grid).
const CUSTOM_PARAMS = ['--model', '--port', '--host', '--api-key', '--mmproj', '--spec-type', '--spec-draft-model', '--chat-template', '--reasoning-budget', '--reasoning-budget-message', '--moe-cpu-layers', '--reasoning-preserve',
  '--spec-ngram-map-k4v-size-n', '--spec-ngram-map-k4v-size-m', '--spec-ngram-map-k4v-min-hits',
  '--spec-ngram-mod-n-match', '--spec-ngram-mod-n-min', '--spec-ngram-mod-n-max']
// Sampling values are per-model/user-preferred, set once
// at template creation from the starred sampling preset, and must NEVER be
// touched by the Quick/FullAuto/Clear engine presets. Shared list so every
// place that needs to check "is this a sampling key" (the initial-args
// detection, Clear's wipe, etc.) agrees on exactly the same set.
const SAMPLING_KEYS = ['--temperature', '--top-p', '--top-k', '--min-p', '--repeat-penalty', '--presence-penalty']

// --reasoning-preserve support detection. There's no GGUF
// metadata field that directly says "this template supports preserving
// reasoning across turns" — the only signal available is the chat template's
// own Jinja source. Templates that support carrying a previous turn's
// reasoning/thinking forward (Qwen3, DeepSeek-R1/V3, GLM-4.5, Kimi K2, etc.)
// all do it the same way: the per-message rendering loop reads a
// `reasoning_content` field off past assistant messages (not just generates
// one for the newest turn) so it can re-inject it into the prompt. Templates
// that only produce/strip a <think> block for the CURRENT turn never
// reference `reasoning_content` on prior messages at all. Checking for that
// token in the template source is therefore a reliable, low-cost proxy for
// "this template has reasoning-preserve logic to turn on" without needing to
// actually parse/execute the Jinja.
function templateSupportsReasoningPreserve(template: string | null | undefined): boolean {
  if (!template) return false
  return /reasoning_content/i.test(template)
}


interface Props {
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
  // CreateModal wants the Settings/Parameters
  // toggles + CPU/model/Free-VRAM info banners to always be visible above the
  // collapsible "Advanced Parameters" section, not hidden inside it. Rather
  // than duplicate that JSX (and its state/hooks) in CreateModal, CmdParamsEditor
  // stays the single source of truth and portals that header block into a DOM
  // node CreateModal renders outside the collapsible area. When this isn't
  // provided (e.g. ModelCard's usage, which has no such split), the header
  // renders inline in its normal position as before.
  headerPortalTarget?: HTMLElement | null
  // The actual launch command (see ModelCard.tsx's handleRunToggle)
  // pushes --no-webui when launchMode is 'api', on top of the stored args —
  // pass it through so the preview reflects that too.
  launchMode?: 'chat' | 'api'
}

// Speculative-decoding tier table — mirrors the backend definitions in
// src/main/ipc.ts (SPEC_TIER_DEFS/classifySidecarFilename). Duplicated here
// (not imported from main) since main-process modules can't be imported into
// the renderer bundle; kept in sync manually — the tier numbers, methods, and
// flags are a stable, rarely-changing reference table.
interface SpecTierDef { tier: number; method: SpecMethod; label: string; flag: string | null; draftMax: number; draftMin: number; draftPMin: number }
const SPEC_TIER_DEFS: SpecTierDef[] = [
  { tier: 0, method: 'off', label: 'Off', flag: null, draftMax: 0, draftMin: 0, draftPMin: 0 },
  { tier: 1, method: 'native-mtp', label: 'Native MTP', flag: 'draft-mtp', draftMax: 3, draftMin: 0, draftPMin: 0.75 },
  { tier: 2, method: 'draft-model', label: 'Draft Model', flag: 'draft-simple', draftMax: 5, draftMin: 0, draftPMin: 0.00 },
  { tier: 3, method: 'eagle3', label: 'EAGLE3', flag: 'draft-eagle3', draftMax: 4, draftMin: 0, draftPMin: 0.50 },
  { tier: 4, method: 'dspark2', label: 'DSpark2', flag: 'draft-dspark', draftMax: 6, draftMin: 0, draftPMin: 0.75 },
  { tier: 5, method: 'dflash2', label: 'DFlash2', flag: 'draft-dflash', draftMax: 5, draftMin: 0, draftPMin: 0.80 }
]

// Params visible in "Common" view mode.
const COMMON_VISIBLE = new Set([
  '--ctx-size', '--threads', '--gpu-layers', '--batch-size', '--ubatch-size',
  '--parallel', '--flash-attn', '--temperature', '--top-p', '--min-p', '--top-k',
  '--load-mode', '--cache-type-k', '--cache-type-v', '--kv-offload',
  '--kv-unified', '--keep', '--seed'
])

// Reusable on/off block for a stackable n-gram speculative-decoding
// modifier (ngram-map-k4v, ngram-mod) — a toggle that, when on, reveals a
// slider+input row per llama.cpp flag, each seeded with llama.cpp's own
// documented default the first time it's turned on.
function NgramModifierBlock({ title, flagPrefix, enabled, onToggle, disabled, fields, args, handleUpdate }: {
  title: string
  flagPrefix: string
  enabled: boolean
  onToggle: (on: boolean) => void
  disabled?: boolean
  fields: { key: string; label: string; def: number }[]
  args: Record<string, any>
  handleUpdate: (arg: string, value: any) => void
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer' }}>
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={e => onToggle(e.target.checked)} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{flagPrefix}...</span>
      </label>
      {enabled && (
        <div style={{ marginTop: 4, marginLeft: 22 }}>
          {fields.map(f => {
            const arg = `${flagPrefix}-${f.key}`
            return (
              <div key={arg} className="cmd-row cmd-row-hybrid" style={{ padding: '4px 0', border: 'none', background: 'transparent' }}>
                <div className="cmd-label-group"><div className="cmd-label">{f.label}</div><div className="cmd-arg">{arg}</div></div>
                <HybridSlider value={args[arg] ?? f.def} min={0} max={Math.max(256, f.def * 4)} step={1} onChange={v => handleUpdate(arg, v)} defaultVal={f.def} disabled={disabled} />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function CmdParamsEditor({ templateId, args, onChange, modelPathFallback, serverPortFallback, disabled: disabledProp, headerPortalTarget, launchMode }: Props) {
  const {
    commandsSchema, updateCard, cards, models, cpuInfo,
    detectedSpeculation, setDetectedSpeculation, markSpeculationApplied,
    ggufMetadata, setGgufMetadata, activeBackend,
    paramViewMode, setParamViewMode,
    setPresetMode, modelDefaults, samplingPresets, baseUrlOverride
  } = useStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [previewCopied, setPreviewCopied] = useState(false)  // "Copied" flash state for the preview copy button
  // Vertical-stack command preview toggle.
  const [stackedPreview, setStackedPreview] = useState(false)

  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const isRunning = card?.status === 'running'
  const disabled = disabledProp || isRunning

  // Keep a ref mirroring the latest `args` prop. Async
  // callbacks (e.g. the speculation/MTP file-scan below) close over `args` as
  // of the render in which the effect fired. If the scan takes a while and the
  // parent's args change in the meantime (e.g. Quick preset finishing its own
  // commit), committing `{ ...args, ... }` from the stale closure would revert
  // those newer fields — silently discarding them and, from the user's
  // perspective, making the auto-selected MTP mode "not stick" or other Quick
  // settings mysteriously disappear. Reading argsRef.current at commit time
  // instead always bases the patch on the latest known args.
  const argsRef = useRef(args)
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { argsRef.current = args }, [args])

  // Flush safeguard for the debounced inline-edit save in commit() above:
  // if the card collapses or this editor unmounts while a save is still
  // pending (within its 400ms debounce window), fire it immediately instead
  // of letting the stale timeout resolve on its own later — and definitely
  // instead of losing it if the app quits before the timeout ever fires.
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current)
        if (templateId) {
          const latestCard = useStore.getState().cards.find(c => c.template.id === templateId)
          if (latestCard) window.api?.saveTemplate?.(latestCard.template).catch(() => {})
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])


  // On mount, for a NEW template (no templateId, args empty or only
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

  // Load GGUF metadata when model changes.
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

  // CPU info: physical cores for thread slider max + recommended (3/4 by
  // default, or the Settings "Recommended CPU Threads override" percentage
  // if enabled — both go through computeRecommendedThreads for consistency).
  const physicalCores = cpuInfo?.physicalCores || 8
  const cpuThreadsOverridePercent = modelDefaults.cpuThreadsOverrideEnabled ? modelDefaults.cpuThreadsOverridePercent : null
  const recommendedThreads = computeRecommendedThreads(cpuInfo, cpuThreadsOverridePercent)

  // `presetMode`
  // is a SINGLE GLOBAL store field shared across every open template/card, so
  // it only ever reflects whichever preset button was clicked MOST RECENTLY
  // ANYWHERE in the app — not necessarily anything to do with the template
  // currently being viewed. Opening a different template (or a fresh new
  // one, whose args were seeded synchronously without ever calling
  // setPresetMode) left the toggle showing a stale leftover value. Derive the
  // displayed/effective mode from THIS template's own args instead — scoped
  // per-template so it can't leak across cards, unlike the old global field.
  //
  // The FIRST version of this derivation used
  // `__ignoreCtxOverride === true` as the Quick-vs-FullAuto discriminator —
  // but that flag is ALSO an independent, directly user-toggleable checkbox
  // ("Ignore Context Length Override"), not something exclusive to FULL
  // AUTO. So manually turning that checkbox on (with no preset button
  // clicked at all) made the toggle jump to showing FULL AUTO — backwards
  // from the intended relationship ("FULL AUTO turns ON Ignore Override",
  // not "Ignore Override implies FULL AUTO"). Track an explicit per-template
  // marker instead (`__lastPreset`, set by the three preset handlers when
  // actually clicked) as the primary source of truth; only fall back to the
  // "--threads unset → clear" heuristic for templates that predate this
  // marker (e.g. edited before this fix, so never had it set at all).
  const derivedPresetMode: 'quick' | 'fullauto' | 'clear' =
    (args['__lastPreset'] === 'quick' || args['__lastPreset'] === 'fullauto' || args['__lastPreset'] === 'clear')
      ? args['__lastPreset']
      : (args['--threads'] === undefined ? 'clear' : 'quick')

  // GPU layers slider max = block_count (fallback 120).
  const gpuLayersMax = blockCount > 0 ? blockCount : 120
  // Per-preset context-fill toggles + memory overhead.
  // (Moved up from below so the YaRN auto-scale logic right after it can see it.)
  const ignoreCtxOverride = args['__ignoreCtxOverride'] === true
  // Per-template "Automatic YaRN scaling control" — when on, unlocks
  // the Context Size slider up to 2 097 152 and auto-computes YaRN RoPE
  // scaling to reach whatever context the user picks.
  const yarnAutoScale = args['__yarnAutoScale'] === true
  // The GLOBAL "Automatic YaRN scaling control override and upscale
  // to AutoFit" switch (Settings) also enables the same auto-scaling
  // behavior, but only when this preset is actually subject to the AutoFit
  // override (i.e. NOT ignoring it) AND the override is genuinely higher than
  // the model's native context — that's the only situation where "upscale
  // to AutoFit" has anything to do.
  const globalYarnUpscale = !!modelDefaults.autoFitYarnAutoScale && !ignoreCtxOverride &&
    modelDefaults.autoFitEnabled && contextLength > 0 && modelDefaults.autoFitContextLength > contextLength
  const effectiveYarnAutoScale = yarnAutoScale || globalYarnUpscale
  // "Use 2x increments" for the per-template Context Size slider.
  const ctxUse2xIncrements = args['__ctxUse2xIncrements'] === true
  // Context slider max = model context_length (fallback 131072).
  // Unlocked to 2 097 152 while YaRN auto-scaling (per-template or via
  // the global upscale-to-AutoFit switch) is active, regardless of the
  // model's native context — that's the entire point of the switch.
  const ctxSliderMax = effectiveYarnAutoScale ? 2097152 : (contextLength > 0 ? contextLength : 131072)

  // VRAM budget calculation.
  const modelSizeMB = meta?.fileSizeMB || 0
  const mmprojEnabled = args['--mmproj'] !== undefined && args['--mmproj'] !== '' && args['--mmproj'] !== false
  const mmprojSizeMB = detectedMmproj ? Math.round(detectedMmproj.size / (1024 * 1024)) : 0
  const currentCtx = args['--ctx-size'] !== undefined && args['--ctx-size'] !== '' ? Number(args['--ctx-size']) : 32768
  // Default KV cache quant depends on the backend (TurboQuant fork →
  // K=turbo4 / V=turbo3, otherwise q8_0/q8_0). The user can override per-
  // template via --cache-type-k/v.
  // Llama.cpp silently upgrades K to q8_0 when K/V
  // quant types are too asymmetric (a quality-preserving safety fallback).
  // turbo4 on K stays safely above that asymmetry threshold, so K defaults
  // to turbo4 while V defaults to turbo3 — the lighter V-only quant is what
  // actually buys back the VRAM/context headroom TurboQuant is for, without
  // silently triggering llama.cpp's K fallback the way an all-turbo3 pair did.
  const defaultKvQuantK = defaultKvQuantFor(activeBackend?.backendKey)
  const defaultKvQuantV = defaultKvQuantVFor(activeBackend?.backendKey)
  const kvQuantK = (typeof args['--cache-type-k'] === 'string' && args['--cache-type-k']) ? String(args['--cache-type-k']) : defaultKvQuantK
  const kvQuantV = (typeof args['--cache-type-v'] === 'string' && args['--cache-type-v']) ? String(args['--cache-type-v']) : defaultKvQuantV
  // Per-preset context-fill toggle + memory overhead.
  // (ignoreCtxOverride itself now declared above, near the YaRN logic that needs it.)
  const autoCtxFill = (args['__autoCtxFill'] as 'off' | 'auto' | 'maximum') || 'off'
  // Memory Overhead — off by default everywhere. When enabled, the
  // default value is 2.5 GB (2560 MB). The overhead reduces Free VRAM then RAM.
  const memOverheadEnabled = args['__memOverheadEnabled'] === true
  const memOverheadMB = memOverheadEnabled ? (Number(args['__memOverheadMB']) || 2560) : 0
  // Pass whether AutoFill "Auto" is active so useVramBudget can ignore
  // the selected ctx and check full-fit by speed priority for dense models.
  const autoFillAuto = ignoreCtxOverride && autoCtxFill === 'auto'
  // Compute the YaRN-scaled effective max context (if RoPE
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
  })
  // The VRAM-recommended GPU layer count is a display value only (shown in
  // the VRAM banner) — the user must manually set --gpu-layers to use it.
  // Settings never turn themselves on/off, so Quick doesn't force it either.

  // Dense models under Quick/FullAuto just get "all layers" (gpuLayersMax),
  // known synchronously the moment GGUF metadata (blockCount) is available —
  // no need to wait on a VRAM budget calculation. This still needs to be a
  // backfill (not just the button click / buildQuickEngineBaseline) because
  // for a brand-new template metadata usually isn't loaded yet at either of
  // those moments.
  //
  // This used to re-fire and FORCE
  // --gpu-layers back to gpuLayersMax on ANY divergence — including a value
  // the user had deliberately set manually. Since `disabled` is one of this
  // effect's dependencies, it also re-evaluated every time the server
  // stopped (disabled flips true→false), which could silently overwrite a
  // manual edit right after closing the server, with no visible trigger.
  // A backfill must only ever fill in a genuinely UNSET value — never
  // re-enforce a value that's already present, whatever it is. Per the
  // explicit requirement that recommended offload layers only ever get
  // applied by clicking the Apply button (or the preset buttons), this now
  // strictly does nothing once --gpu-layers has any value at all.
  useEffect(() => {
    if (disabled || derivedPresetMode === 'clear' || isMoe) return
    if (!blockCount || blockCount <= 0) return
    const curArgs = argsRef.current
    if (curArgs['--gpu-layers'] === undefined || curArgs['--gpu-layers'] === '') {
      commit({ ...curArgs, '--gpu-layers': gpuLayersMax })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, derivedPresetMode, isMoe, blockCount, gpuLayersMax])

  // The equivalent backfill for --ctx-size — Quick/FullAuto set it
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

  // "Automatic YaRN scaling control" — while active (per-template switch, OR
  // the global override switch kicking in because this preset isn't
  // ignoring an AutoFit override that exceeds the model's native context),
  // force RoPE scaling to yarn and auto-compute the scale factor +
  // original-context needed to reach the relevant target context, per the
  // reference formula:
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

  // Automatic Context Fill — compute the max context that fits and
  // auto-write it into --ctx-size ONLY when AutoFill is "Maximum available".
  // Dense 'auto' and MoE 'auto' defer to llama-server --fit (no ctx forced).
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
    // Now that "Maximum available" is allowed together with the MoE
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

  // "With (L2/Ltotal) GPU Offload Layers selected, context window of
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

  // ----- mmproj widget state -----
  // If mmproj detected → ON + Automatic. If not detected → OFF + Manual.
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

  // Auto-select detected mmproj when ON and in auto mode.
  useEffect(() => {
    if (disabled) return
    // Base on argsRef.current, not `args` — see commit()
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
    // Multiple mount-time auto-apply effects (mmproj detection,
    // MTP/speculation detection, Jinja auto-enable, etc.) can become ready
    // and fire within the same synchronous effect flush. Each one calls
    // commit({ ...args, ownKey }) from its own closure over `args`, but
    // since no re-render happens between sibling effects in the same flush,
    // every one of them would otherwise see the same pre-flush `args`
    // snapshot and clobber each other (only the last effect's change would
    // survive). argsRef is updated eagerly here, synchronously, and every
    // auto-apply effect below reads argsRef.current (not `args`) as the base
    // for its patch, so each one builds on whatever the previous one in the
    // same flush already committed.
    argsRef.current = newArgs
    if (onChange) onChange(newArgs)
    else if (templateId) {
      updateCard(templateId, { args: newArgs })
      // This `templateId` branch backs the live editor embedded directly in
      // an expanded card (ModelCard passes `templateId`, not `onChange` —
      // CreateModal's Save button handles its own persistence separately via
      // the `onChange` branch above). updateCard() only writes to the
      // in-memory store, so this also flushes the change to the template's
      // JSON file on disk, debounced (400ms) so rapid consecutive edits
      // (typing in a number field, dragging a slider) settle to one write.
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
      const idToSave = templateId
      saveTimeoutRef.current = setTimeout(() => {
        const latestCard = useStore.getState().cards.find(c => c.template.id === idToSave)
        if (latestCard) window.api?.saveTemplate?.(latestCard.template).catch(() => {})
      }, 400)
    }
  }
  function setMmprojOn(on: boolean) {
    const newArgs: Record<string, any> = { ...args }
    // Mark as manually toggled so the default-ON behavior doesn't override.
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
  // Clicking Manual opens the file picker immediately.
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

  // ----- Speculation auto-detection -----
  // Detection runs AND auto-applies the detected method so the
  // user doesn't have to manually enable it. If not detected, stays off.
  //
  // Tier 1 (embedded native MTP) is a static fact of the model's own GGUF
  // metadata — it's extracted exactly once, as part of the same metadata
  // parse that already populates `ggufMetadata` (see hasNativeMtp on
  // GgufMetadata / the main process's detectHasNativeMtp), and persisted to
  // disk with the rest of that metadata. It never needs to be re-scanned
  // here; `meta.hasNativeMtp` is the answer, whenever metadata for this
  // model has loaded.
  //
  // Sidecar files (Tiers 2-5) are just files sitting in the model's folder —
  // the user can add or remove them at any time — so that part genuinely
  // needs to be checked live rather than trusted from a one-time cache. This
  // effect re-runs the sidecar scan (a cheap folder listing + filename
  // classification, no per-model file parsing) whenever the model changes or
  // its metadata finishes loading, and always writes a fresh result rather
  // than skipping because something was already cached, so a stale/negative
  // sidecar result can never get stuck.
  const hasNativeMtp = !!meta?.hasNativeMtp
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    window.api?.detectSpeculation?.(effectiveModelPath, hasNativeMtp).then(res => {
      if (res) setDetectedSpeculation(effectiveModelPath, res)
    }).catch(() => {})
  }, [effectiveModelPath, disabled, hasNativeMtp, setDetectedSpeculation])

  // Parse the current primary method out of --spec-type. It's now a
  // comma-separated list (primary draft method + stackable n-gram
  // modifiers), so this specifically looks for whichever segment matches one
  // of the mutually-exclusive PRIMARY method flags (draft-mtp/draft-simple/
  // draft-eagle3/draft-dspark/draft-dflash) — ngram-map-k4v/ngram-mod are
  // handled completely separately below since they're additive, not
  // exclusive with the primary method or each other.
  const specTypeSegments: string[] = useMemo(() => {
    const v = args['--spec-type']
    return typeof v === 'string' && v.length > 0 ? v.split(',').map(s => s.trim()).filter(Boolean) : []
  }, [args])
  const currentSpecTierDef: SpecTierDef = useMemo(() => {
    for (const seg of specTypeSegments) {
      const match = SPEC_TIER_DEFS.find(t => t.flag === seg)
      if (match) return match
    }
    return SPEC_TIER_DEFS[0]  // off
  }, [specTypeSegments])
  const ngramMapK4vOn = specTypeSegments.includes('ngram-map-k4v')
  const ngramModOn = specTypeSegments.includes('ngram-mod')

  function buildSpecTypeValue(primaryFlag: string | null, mapK4v: boolean, mod: boolean): string {
    const parts: string[] = []
    if (primaryFlag) parts.push(primaryFlag)
    if (mapK4v) parts.push('ngram-map-k4v')
    if (mod) parts.push('ngram-mod')
    return parts.join(',')
  }

  // 
  // applying the detected method is a continuously-reactive effect (see
  // above), which is great for resilience against transient failures — but
  // it meant choosing "Off" (or any OTHER method) in the dropdown looked
  // identical to "never touched" the moment the primary segment changed, so
  // this effect kept reapplying the detected method over any manual choice,
  // including switching to a lower-tier method or a different sidecar file
  // of the SAME tier. Track an explicit __spec_manual flag (same pattern as
  // mmproj's manual-override tracking) the moment the user picks ANY primary
  // method — including Off — so auto-apply only ever fires before the user
  // has made their own explicit choice, exactly once, at template creation.
  useEffect(() => {
    if (!effectiveModelPath || disabled) return
    if (argsRef.current['__spec_manual'] === true) return  // user already made an explicit choice
    const detected = detectedSpeculation[effectiveModelPath]
    if (!detected || detected.tier === 0) return
    const curArgs = argsRef.current
    if (curArgs['--spec-type'] !== undefined) return  // already set (shouldn't happen without __spec_manual, but stay safe)
    const tierDef = SPEC_TIER_DEFS.find(t => t.method === detected.method)
    if (!tierDef?.flag) return
    const newArgs = { ...curArgs, '--spec-type': tierDef.flag }
    // For sidecar-based tiers (2-5), also point --spec-draft-model at the
    // detected file, and seed the draft-max/min/p-min from the tier's own
    // "preset" values (see the table this whole rework is based on).
    if (detected.path) newArgs['--spec-draft-model'] = detected.path
    newArgs['--spec-draft-n-max'] = tierDef.draftMax
    newArgs['--spec-draft-n-min'] = tierDef.draftMin
    newArgs['--spec-draft-p-min'] = tierDef.draftPMin
    commit(newArgs)
  }, [effectiveModelPath, disabled, detectedSpeculation, args])

  // Selecting a primary method (Off / Native MTP / Draft Model / EAGLE3 /
  // DSpark2 / DFlash2) — mutually exclusive with each other, but preserves
  // whichever n-gram modifiers were already stacked on top.
  function setSpecTier(tierDef: SpecTierDef, sidecarPath?: string | null) {
    const newArgs = { ...args }
    newArgs['__spec_manual'] = true
    newArgs['--spec-type'] = buildSpecTypeValue(tierDef.flag, ngramMapK4vOn, ngramModOn) || undefined
    if (!newArgs['--spec-type']) delete newArgs['--spec-type']
    if (tierDef.tier === 0) {
      // Also clear the draft-tuning
      // params when switching to Off — they only mean anything paired with
      // an active primary method, so leaving them behind is the same class
      // of "settings survive after their toggle turns off" bug.
      delete newArgs['--spec-draft-model']
      delete newArgs['--spec-draft-n-max']
      delete newArgs['--spec-draft-n-min']
      delete newArgs['--spec-draft-p-min']
    } else {
      // Draft-max/min/p-min act as this tier's own "preset" — apply
      // them whenever switching TO this tier (matching the comparison table).
      newArgs['--spec-draft-n-max'] = tierDef.draftMax
      newArgs['--spec-draft-n-min'] = tierDef.draftMin
      newArgs['--spec-draft-p-min'] = tierDef.draftPMin
      if (tierDef.tier >= 2) {
        // Sidecar-based tier — use the given path (from manual candidate
        // picking) or fall back to whatever was already there.
        if (sidecarPath !== undefined) newArgs['--spec-draft-model'] = sidecarPath || ''
        else if (!newArgs['--spec-draft-model']) newArgs['--spec-draft-model'] = ''
      } else {
        delete newArgs['--spec-draft-model']  // Native MTP is embedded, no sidecar file
      }
    }
    commit(newArgs); if (templateId) markSpeculationApplied(templateId, true)
  }
  function setNgramModifier(which: 'map-k4v' | 'mod', on: boolean) {
    const newArgs = { ...args }
    newArgs['__spec_manual'] = true
    const nextMapK4v = which === 'map-k4v' ? on : ngramMapK4vOn
    const nextMod = which === 'mod' ? on : ngramModOn
    const value = buildSpecTypeValue(currentSpecTierDef.flag, nextMapK4v, nextMod)
    if (value) newArgs['--spec-type'] = value
    else delete newArgs['--spec-type']
    // Seed each modifier's own llama.cpp defaults the first time it's turned
    // on; turning a modifier off deletes its flags too, since --spec-type no
    // longer references them.
    if (which === 'map-k4v') {
      if (on) {
        setIfAbsent(newArgs, '--spec-ngram-map-k4v-size-n', 12)
        setIfAbsent(newArgs, '--spec-ngram-map-k4v-size-m', 48)
        setIfAbsent(newArgs, '--spec-ngram-map-k4v-min-hits', 1)
      } else {
        delete newArgs['--spec-ngram-map-k4v-size-n']
        delete newArgs['--spec-ngram-map-k4v-size-m']
        delete newArgs['--spec-ngram-map-k4v-min-hits']
      }
    }
    if (which === 'mod') {
      if (on) {
        setIfAbsent(newArgs, '--spec-ngram-mod-n-match', 24)
        setIfAbsent(newArgs, '--spec-ngram-mod-n-min', 48)
        setIfAbsent(newArgs, '--spec-ngram-mod-n-max', 64)
      } else {
        delete newArgs['--spec-ngram-mod-n-match']
        delete newArgs['--spec-ngram-mod-n-min']
        delete newArgs['--spec-ngram-mod-n-max']
      }
    }
    commit(newArgs)
  }

  // ----- Jinja Chat Template -----
  // Jinja defaults ON only when a native chat_template was actually
  // detected in the GGUF metadata — same "auto unless manually touched"
  // pattern as mmproj.
  const jinjaManuallyToggled = args['__jinja_manual'] === true
  const jinjaOn = jinjaManuallyToggled ? (args['--jinja'] !== false) : !!nativeChatTemplate
  // __jinja_cleared (UI-only, never reaches the command) distinguishes "no
  // override yet, showing the native template for reference" from "user
  // explicitly cleared the box" — without it, clearing the box would
  // immediately snap back to showing the native template on the next
  // render, making it impossible to paste a new template into an empty box.
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
      // OFF: don't pass any template flags. --reasoning-preserve is only
      // ever meaningful "under jinja" (it re-injects reasoning_content via
      // the jinja template loop), so it goes with it.
      delete newArgs['--chat-template']
      delete newArgs['--jinja']
      delete newArgs['--reasoning-preserve']
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
      // Remove any override AND remember the user
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

  // ----- Reasoning Preserve (under Jinja) -----
  // Only relevant, and only shown, when Jinja is on AND the template
  // actually in effect (the user's own override if they've set one,
  // otherwise the model's native tokenizer.chat_template) has reasoning-
  // preserve logic to turn on at all — see templateSupportsReasoningPreserve.
  const effectiveChatTemplateForReasoning = explicitChatTemplate !== undefined ? explicitChatTemplate : nativeChatTemplate
  const reasoningPreserveSupported = jinjaOn && templateSupportsReasoningPreserve(effectiveChatTemplateForReasoning)
  // On by default: an unset boolean always displays/behaves as OFF regardless
  // of the schema's own `default` (same established pattern as --kv-unified),
  // so once support is detected we backfill --reasoning-preserve: true the
  // first time — same "fill in once metadata arrives" shape as the
  // --gpu-layers/--ctx-size backfill effects above, since template support
  // isn't known until GGUF metadata (or a pasted custom template) exists.
  useEffect(() => {
    if (disabled || !reasoningPreserveSupported) return
    const curArgs = argsRef.current
    if (curArgs['--reasoning-preserve'] === undefined) {
      commit({ ...curArgs, '--reasoning-preserve': true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, reasoningPreserveSupported])
  // Mirror-image cleanup: if support goes away (jinja turned off, or the
  // template was edited to one without reasoning-preserve logic) while the
  // flag is still set, strip it — otherwise it keeps silently reaching
  // llama-server with no way to see or turn it off, since the widget itself
  // is hidden whenever support isn't detected.
  useEffect(() => {
    if (disabled || reasoningPreserveSupported) return
    const curArgs = argsRef.current
    if (curArgs['--reasoning-preserve'] !== undefined) {
      const newArgs = { ...curArgs }
      delete newArgs['--reasoning-preserve']
      commit(newArgs)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, reasoningPreserveSupported])
  // '--load-mode' backfill: --load-mode is a select, so (per requireValue
  // above) it has no synthetic empty "Default" choice to fall back to — an
  // unset value would just leave the dropdown showing whichever option
  // happens to be first, with nothing actually persisted in args. Ensure it
  // always resolves to a concrete choice matching this app's own opinionated
  // default (mmap+mlock — the historical "both switches on" behavior),
  // regardless of preset mode, so the dropdown's displayed selection always
  // matches what's actually in the template. Never overrides a value that's
  // already set (including 'auto', 'none', etc. — anything the user or a
  // preset already chose).
  useEffect(() => {
    if (disabled) return
    const curArgs = argsRef.current
    if (curArgs['--load-mode'] === undefined || curArgs['--load-mode'] === '') {
      commit({ ...curArgs, '--load-mode': 'mmap+mlock' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])
  // '--cache-type-k'/'--cache-type-v' backfill: same reasoning as
  // '--load-mode' above (requireValue, so no synthetic empty "Default"
  // choice to fall back to). Resolves to the backend-appropriate baseline
  // (turbo4/turbo3 for the TurboQuant fork, q8_0/q8_0 otherwise) so the
  // dropdown always shows a concrete, diffable value instead of blank.
  //
  // On a backend switch this also has to decide whether the current value
  // still reflects a deliberate choice or was just riding the old
  // backend's default. A value that isn't valid for the new backend's
  // options is always reset (it can no longer be passed to llama-server at
  // all). A value that IS still valid gets reset only if it exactly
  // matched the PREVIOUS backend's default — e.g. it was left on q8_0
  // under stock llama.cpp and the backend switches to the TurboQuant fork,
  // whose default is turbo4/turbo3, not q8_0 — so the template keeps
  // tracking "whatever this backend recommends" instead of freezing at
  // whichever backend happened to be active when the value was last
  // implicitly set. Anything that diverges from the previous backend's
  // default is treated as a deliberate override and survives the switch
  // unchanged (as long as it's still a valid option).
  const prevKvBackendKeyRef = useRef<string | null | undefined>(activeBackend?.backendKey)
  useEffect(() => {
    if (disabled || !commandsSchema) return
    const curArgs = argsRef.current
    const prevBackendKey = prevKvBackendKeyRef.current
    prevKvBackendKeyRef.current = activeBackend?.backendKey
    const prevDefaultK = defaultKvQuantFor(prevBackendKey)
    const prevDefaultV = defaultKvQuantVFor(prevBackendKey)
    const findOptions = (arg: string): string[] | undefined => {
      for (const cat of commandsSchema.categories) {
        const cmd = cat.commands.find(c => c.arg === arg)
        if (cmd) return cmd.options
      }
      return undefined
    }
    const kOptions = findOptions('--cache-type-k')
    const vOptions = findOptions('--cache-type-v')
    const newArgs: Record<string, any> = { ...curArgs }
    let changed = false
    const curK = curArgs['--cache-type-k']
    const kUnset = curK === undefined || curK === ''
    const kInvalid = !kUnset && !!kOptions && !kOptions.includes(String(curK))
    const kOnPriorDefault = !kUnset && String(curK) === String(prevDefaultK)
    if (kUnset || kInvalid || kOnPriorDefault) {
      newArgs['--cache-type-k'] = defaultKvQuantK
      changed = true
    }
    const curV = curArgs['--cache-type-v']
    const vUnset = curV === undefined || curV === ''
    const vInvalid = !vUnset && !!vOptions && !vOptions.includes(String(curV))
    const vOnPriorDefault = !vUnset && String(curV) === String(prevDefaultV)
    if (vUnset || vInvalid || vOnPriorDefault) {
      newArgs['--cache-type-v'] = defaultKvQuantV
      changed = true
    }
    if (changed) commit(newArgs)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, defaultKvQuantK, defaultKvQuantV, commandsSchema, activeBackend?.backendKey])

  const reasoningPreserveOn = args['--reasoning-preserve'] !== false
  function setReasoningPreserveOn(on: boolean) {
    commit({ ...args, '--reasoning-preserve': on })  }

  // ----- Reasoning Budget -----
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

  // ----- MoE controls -----
  const moeCpuLayers = args['--moe-cpu-layers']
  const moeCpuLayersSet = moeCpuLayers !== undefined && moeCpuLayers !== '' && moeCpuLayers !== false
  // Inverse locking — MoE-CPU control is ONLY active when GPU layers is manually set.
  const gpuLayersManuallySet = args['--gpu-layers'] !== undefined && args['--gpu-layers'] !== '' && args['--gpu-layers'] !== false && args['--gpu-layers'] !== 'auto'

  // ----- handleUpdate + changed-state tracking -----
  const handleUpdate = (argName: string, value: any) => {
    const newArgs = { ...args }
    if (value === null || value === false || value === '') delete newArgs[argName]
    else newArgs[argName] = value
    commit(newArgs)
  }
  // Map each sampling arg to its field name on a SamplingPreset's
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
    // The highlight is driven by whichever preset is ACTUALLY selected:
    //  - Clear: no preset is applied, so there's no baseline to diff against
    //    at all — nothing is ever highlighted as "changed".
    //  - Quick / FullAuto: both share the exact same engine baseline (see
    //    buildQuickEngineBaseline) — diff against THAT, not a stale
    //    hardcoded copy that could drift from what the button actually sets.
    // Sampling keys (temperature/top-p/etc.) are compared separately,
    // against the CURRENTLY STARRED sampling preset — never against the
    // engine preset (Quick/FullAuto/Clear never touch them), and this
    // comparison applies regardless of derivedPresetMode/Clear, since it's
    // an independent axis from the engine baseline.
    if (SAMPLING_KEYS.includes(cmd.arg)) {
      const target = getStarredSamplingValue(cmd.arg)
      if (target === undefined) return false
      const currentSet = val !== undefined && val !== false && val !== ''
      if (!currentSet) return false
      return String(val) !== String(target)
    }
    if (derivedPresetMode === 'clear') return false
    // --gpu-layers isn't a static baseline value — Quick/FullAuto set it
    // dynamically based on Dense-vs-MoE (see the identical isMoe branch in
    // handleQuickPreset/handleFullAutoPreset): MoE leaves it unset ("auto"),
    // Dense sets it to gpuLayersMax (request all layers, not a computed VRAM
    // recommendation). Handle it explicitly, mirroring the actual preset logic.
    if (cmd.arg === '--gpu-layers') {
      const expectedUnset = isMoe || !blockCount || blockCount <= 0
      const currentUnset = val === undefined || val === '' || val === false
      if (expectedUnset) return !currentUnset
      return currentUnset || String(val) !== String(gpuLayersMax)
    }
    const quickBaselines: Record<string, any> = buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey, cpuThreadsOverridePercent })
    // Ctx-size baseline = model's native context (or 32768 if unknown).
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
    // CPU Threads resets to 3/4 of physical cores (not the schema default of -1).
    if (cmd.arg === '--threads') {
      newArgs[cmd.arg] = recommendedThreads
      commit(newArgs)
      return
    }
    // Sampling keys reset to the currently-starred sampling preset's
    // value — independent of the engine preset (Quick/FullAuto/Clear).
    if (SAMPLING_KEYS.includes(cmd.arg)) {
      const target = getStarredSamplingValue(cmd.arg)
      if (target !== undefined) {
        newArgs[cmd.arg] = target
        commit(newArgs)
        return
      }
    }
    // Mirror the same explicit --gpu-layers handling as
    // isChanged() above — reset to "unset/auto" for MoE, or gpuLayersMax
    // (all layers, not a computed VRAM recommendation) for Dense.
    if (cmd.arg === '--gpu-layers' && derivedPresetMode !== 'clear') {
      if (isMoe || !blockCount || blockCount <= 0) {
        delete newArgs[cmd.arg]
      } else {
        newArgs[cmd.arg] = gpuLayersMax
      }
      commit(newArgs)
      return
    }
    // Reset to the current preset baseline, not the schema default.
    // Same unification as isChanged() above.
    if (derivedPresetMode !== 'clear' && !SAMPLING_KEYS.includes(cmd.arg)) {
      const quickBaselines: Record<string, any> = buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey, cpuThreadsOverridePercent })
      // Ctx-size baseline = model's native context (or 32768 if unknown).
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

  // ----- Quick / Clear presets -----
  // Helper — only set a sampling value if it isn't already present (so
  // the starred preset's values seeded by CreateModal are preserved when Quick
  // is auto-applied on a new template).
  const setIfAbsent = (obj: Record<string, any>, key: string, val: any) => {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') obj[key] = val
  }
  function handleQuickPreset() {
    const newArgs = { ...args }
    // The engine baseline comes from the same pure function CreateModal's
    // lazy initializer uses, so the button and "apply on template creation"
    // can never drift apart.
    Object.assign(newArgs, buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey, cpuThreadsOverridePercent }))
    // ctx-size needs model metadata, which the shared baseline function
    // doesn't have access to — set it here only if not already present.
    // MoE gets a memory-aware default (VRAM+RAM leftover after model
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
    // Quick/FullAuto/Clear must never touch sampling values (temperature,
    // top-p, top-k, min-p, repeat-penalty, presence-penalty) — those are
    // per-model/user-preferred and set once at template creation from the
    // starred sampling preset (see CreateModal), then only ever edited
    // directly by the user or via the separate "apply sampling preset"
    // action. Switching Quick/FullAuto/Clear must leave them exactly as
    // they were.
    //
    // Rather than computing a specific "how many layers fit" recommendation
    // for Dense models, just request ALL layers on GPU (llama.cpp clamps to
    // the model's actual layer count, and — especially combined with FULL
    // AUTO's --fit below — figures out itself how much actually ends up
    // GPU-resident to fit the requested context, no separate VRAM-budget
    // calculation needed on our end). MoE still leaves --gpu-layers unset
    // entirely so llama.cpp's own MoE-aware auto-split heuristic decides
    // layer placement.
    if (isMoe) {
      delete newArgs['--gpu-layers']
    } else {
      newArgs['--gpu-layers'] = gpuLayersMax
    }
    // Explicit per-template marker for derivedPresetMode above — see its
    // comment for why this replaced the old __ignoreCtxOverride-based
    // heuristic.
    newArgs['__lastPreset'] = 'quick'
    commit(newArgs)
    // Mark Quick as the active baseline so blue lines DON'T appear.
    setPresetMode('quick')
  }
  function handleClearPreset() {
    const newArgs: Record<string, any> = {}
    if (args['--mmproj'] !== undefined) newArgs['--mmproj'] = args['--mmproj']
    // Clear must preserve sampling values too — it wipes the engine args
    // (everything else), not the model's/user's sampling setup.
    for (const k of SAMPLING_KEYS) {
      if (args[k] !== undefined) newArgs[k] = args[k]
    }
    // Turn OFF the context-fill toggles in Clear mode.
    newArgs['__ignoreCtxOverride'] = false
    newArgs['__autoCtxFill'] = 'off'
    // Memory Overhead off by default in Clear.
    newArgs['__memOverheadEnabled'] = false
    newArgs['__lastPreset'] = 'clear'
    commit(newArgs)
    setPresetMode('clear')
  }
  // FULL AUTO = Quick baselines + Ignore-Context-Override ON +
  // Auto-Context-Fill ON (Auto mode — llama-server handles offloading + ctx).
  // Stacks the best defaults so the user can "set it and forget it".
  function handleFullAutoPreset() {
    // Same shared baseline as Quick, then override the two advanced context
    // toggles for FULL AUTO's "set it and forget it" behavior.
    const newArgs: Record<string, any> = { ...args }
    Object.assign(newArgs, buildQuickEngineBaseline({ cpuInfo, backendKey: activeBackend?.backendKey, cpuThreadsOverridePercent }))
    // Same MoE-aware default as Quick (see the identical note there).
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
    // Sampling values are never touched by presets — see
    // the identical note in handleQuickPreset above. FullAuto previously
    // unconditionally overwrote temperature/top-p/top-k/min-p/repeat-penalty
    // with hardcoded defaults every time, clobbering the user's/model's own
    // values — removed entirely.
    // Same "just request all layers" approach as Quick above — for
    // FULL AUTO this combines with --fit (autoCtxFill='auto' below) so
    // llama.cpp determines actual GPU-resident layer count AND context
    // together in one pass, genuinely one-click "best achievable" behavior.
    if (isMoe) {
      delete newArgs['--gpu-layers']
    } else {
      newArgs['--gpu-layers'] = gpuLayersMax
    }
    // Enable the advanced context-fill toggles.
    // FULL AUTO defaults to 'auto' (llama-server --fit handles offloading + ctx)
    // for both dense and MoE — the user can manually switch to Maximum if desired.
    newArgs['__ignoreCtxOverride'] = true
    newArgs['__autoCtxFill'] = 'auto'
    newArgs['__lastPreset'] = 'fullauto'
    commit(newArgs)
    setPresetMode('fullauto')
  }

  // ----- Command preview -----
  // The preview must show what ACTUALLY reaches llama-server, not
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

  // The preview previously only ever reflected the Minimum Context
  // Length override — every OTHER global override (Parallel Inference, Base
  // URL Override's port/local-network/API-key) was silently invisible here,
  // showing whatever was literally stored in the template's own args instead
  // of what ModelCard.tsx's handleRunToggle actually sends to llama-server.
  // These mirror ModelCard.tsx's own override logic exactly so the preview
  // and the real launch can never disagree.
  //
  // Parallel Inference override (Overrides → Parallel Inference).
  const parallelOverrideActive = !!modelDefaults?.parallelOverrideEnabled
  const previewEffectiveParallel = parallelOverrideActive
    ? (modelDefaults.parallelInferenceMode === 'separate'
        ? Math.max(1, Number(isMoe ? modelDefaults.parallelOverrideValueMoe : modelDefaults.parallelOverrideValueDense) || 4)
        : Math.max(1, Number(modelDefaults.parallelOverrideValue) || 4))
    : null  // null = don't touch, use whatever's in the template's own args
  const parallelOverriddenInPreview = parallelOverrideActive

  // Base URL Override (Overrides → Base URL Override): port always wins when
  // enabled (main process force-rewrites --port to the resolved port
  // regardless of what's in the template's args — see run-model's "ALWAYS
  // update the --port argument" comment); host/api-key only apply when their
  // own sub-toggle is also on.
  const baseUrlOverrideActive = !!baseUrlOverride?.enabled
  const previewEffectivePort = baseUrlOverrideActive
    ? (baseUrlOverride.port || 1234)
    : (card?.template.serverPort || serverPortFallback || 8080)
  const portOverriddenInPreview = baseUrlOverrideActive
  const hostOverrideActive = baseUrlOverrideActive && !!baseUrlOverride.serveOnLocalNetwork
  const apiKeyOverrideActive = baseUrlOverrideActive && !!baseUrlOverride.apiKeyEnabled && !!baseUrlOverride.apiKey

  // Shared by all three preview builders below: takes the raw args, strips
  // out whatever's being override-controlled, and injects the effective
  // (possibly overridden) value in its place — the same transform, reused
  // three times instead of drifting apart again.
  function buildRuntimeArgs(): Record<string, any> {
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const runtimeArgs: Record<string, any> = {}
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith('__')) continue  // internal UI flags never reach llama-server
      if (k === '--ctx-size' || k === '-c') continue  // handled via previewEffectiveCtx
      if (k === '--parallel' || k === '-np') continue  // handled via previewEffectiveParallel
      if (k === '--port') continue  // handled via previewEffectivePort
      if (k === '--host' && hostOverrideActive) continue  // overridden below
      if (k === '--api-key' && apiKeyOverrideActive) continue  // overridden below
      if (k === '--fit' || k === '-fit') {
        if (isAutoFitAuto) { runtimeArgs[k] = 'on'; continue }
      }
      runtimeArgs[k] = v
    }
    if (isAutoFitAuto && runtimeArgs['--fit'] === undefined && runtimeArgs['-fit'] === undefined) {
      runtimeArgs['--fit'] = 'on'
    }
    if (!isAutoFitAuto) runtimeArgs['--ctx-size'] = previewEffectiveCtx
    runtimeArgs['--parallel'] = previewEffectiveParallel !== null ? previewEffectiveParallel : (args['--parallel'] ?? args['-np'])
    if (runtimeArgs['--parallel'] === undefined || runtimeArgs['--parallel'] === null) delete runtimeArgs['--parallel']
    runtimeArgs['--port'] = previewEffectivePort
    if (hostOverrideActive) runtimeArgs['--host'] = '0.0.0.0'
    if (apiKeyOverrideActive) runtimeArgs['--api-key'] = baseUrlOverride.apiKey
    if (launchMode === 'api' && runtimeArgs['--no-webui'] === undefined) runtimeArgs['--no-webui'] = true
    return runtimeArgs
  }

  const cmdPreview = useMemo(() => {
    const parts: React.ReactNode[] = []
    parts.push(<span key="base">llama-server</span>)
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push(' ', <span key="arg-m" className="arg">-m</span>, ' ', <span key="val-m" className="val">"{finalModelPath}"</span>)
    // Build a runtime-accurate arg map: skip internal __ flags, and reflect
    // every active override (context floor, parallel, port, host, API key —
    // see buildRuntimeArgs) so the preview matches what actually reaches
    // llama-server, not just what's literally stored in this template.
    const runtimeArgs = buildRuntimeArgs()
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      const isOverridden =
        (key === '--ctx-size' && ctxOverriddenInPreview) ||
        (key === '--parallel' && parallelOverriddenInPreview) ||
        (key === '--port' && portOverriddenInPreview) ||
        (key === '--host' && hostOverrideActive) ||
        (key === '--api-key' && apiKeyOverrideActive)
      const title = key === '--ctx-size' && isOverridden
        ? `Raised from this preset's own ${formatWithSpaces(Number(args['--ctx-size']) || 0)} by the global Minimum AutoFit override`
        : key === '--parallel' && isOverridden
          ? `Set by the global Parallel Inference override (was ${args['--parallel'] ?? args['-np'] ?? 'unset'} in this preset)`
          : key === '--port' && isOverridden
            ? `Set by the global Base URL Override (was ${card?.template.serverPort || serverPortFallback || 8080} for this preset)`
            : key === '--host' && isOverridden
              ? 'Added by the global Base URL Override → "Serve on local network"'
              : key === '--api-key' && isOverridden
                ? 'Added by the global Base URL Override → API Key'
                : undefined
      if (val === true) parts.push(' ', <span key={`arg-${key}`} className="arg">{key}</span>)
      else if (val !== false && val !== null && val !== '') {
        parts.push(
          ' ',
          <span key={`arg-${key}`} className="arg">{key}</span>,
          ' ',
          <span
            key={`val-${key}`}
            className={isOverridden ? 'val cmd-preview-overridden' : 'val'}
            title={title}
          >{val}</span>
        )
      }
    })
    return parts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback, previewEffectiveCtx, ctxOverriddenInPreview, previewEffectiveParallel, parallelOverriddenInPreview, previewEffectivePort, portOverriddenInPreview, hostOverrideActive, apiKeyOverrideActive, baseUrlOverride, isMoe, modelDefaults, launchMode])

  // Plain-text version of the preview for the copy button.
  const cmdPreviewText = useMemo(() => {
    const parts: string[] = ['llama-server']
    const finalModelPath = card?.template.modelPath || modelPathFallback
    if (finalModelPath) parts.push('-m', `"${finalModelPath}"`)
    const runtimeArgs = buildRuntimeArgs()
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      if (val === true) parts.push(key)
      else if (val !== false && val !== null && val !== '') parts.push(key, String(val))
    })
    return parts.join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback, previewEffectiveCtx, previewEffectiveParallel, previewEffectivePort, hostOverrideActive, apiKeyOverrideActive, baseUrlOverride, isMoe, modelDefaults, launchMode])

  // Vertical-stack preview — same underlying runtime-accurate args as
  // cmdPreviewText above, just formatted one flag per line with backslash
  // line-continuations (shell-script style), for readability with long
  // commands (e.g. stacked speculative-decoding flags).
  const cmdPreviewStackedText = useMemo(() => {
    const finalModelPath = card?.template.modelPath || modelPathFallback
    const runtimeArgs = buildRuntimeArgs()
    const argLines: string[] = []
    if (finalModelPath) argLines.push(`-m "${finalModelPath}"`)
    Object.entries(runtimeArgs).forEach(([key, val]) => {
      if (val === true) argLines.push(key)
      else if (val !== false && val !== null && val !== '') argLines.push(`${key} ${val}`)
    })
    const allLines = ['llama-server', ...argLines]
    return allLines.map((l, i) => {
      const isLast = i === allLines.length - 1
      return `${i === 0 ? '' : '  '}${l}${isLast ? '' : ' \\'}`
    }).join('\n')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, ignoreCtxOverride, autoCtxFill, cards, templateId, modelPathFallback, serverPortFallback, previewEffectiveCtx, previewEffectiveParallel, previewEffectivePort, hostOverrideActive, apiKeyOverrideActive, baseUrlOverride, isMoe, modelDefaults, launchMode])

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
        // "Common" view filters out low-level params.
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
    // When AutoFill "Auto" is active, the Context Size block is
    // disabled (llama-server --fit decides context; we don't pass --ctx-size).
    const isAutoFitAuto = ignoreCtxOverride && autoCtxFill === 'auto'
    const ctxDisabled = isAutoFitAuto && (cmd.arg === '--ctx-size' || cmd.arg === '-c')
    const val = args[cmd.arg] ?? (cmd.type === 'boolean' ? false : '')
    // Removed the legacy hexllama-era "active-param"
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
              {!cmd.requireValue && <option value="">Default</option>}
              {cmd.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          )}
        </div>
        {changed && <button type="button" className="cmd-reset-btn" onClick={() => handleReset(cmd)} disabled={disabled} title="Reset to default"><RotateCcw size={12} /></button>}
        {cmd.type === 'text' && <textarea className="cmd-textarea" value={val} placeholder={cmd.placeholder} onChange={(e) => handleUpdate(cmd.arg, e.target.value)} disabled={disabled} />}
      </div>
    )
  }

  // ----- mmproj widget (auto-toggle + unlock manual) -----
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

  // ----- Jinja Chat Template widget -----
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
      {reasoningPreserveSupported && (
        <div className="mmproj-widget-row" title="This chat template re-injects reasoning_content from previous turns, so reasoning can be preserved across multi-turn chat.">
          <span className="mmproj-widget-label">Preserve reasoning across turns <span style={{ opacity: 0.6, fontWeight: 400 }}>(--reasoning-preserve)</span></span>
          <div className="toggle-wrap">
            <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
              <input type="checkbox" checked={reasoningPreserveOn} onChange={(e) => setReasoningPreserveOn(e.target.checked)} disabled={disabled} />
              <span className="toggle-track"></span><span className="toggle-thumb"></span>
            </label>
          </div>
        </div>
      )}
      {jinjaOn && (
        <div style={{ position: 'relative', marginTop: 10 }}>
          <textarea
            className="cmd-textarea mono"
            style={{ width: '100%', minHeight: 150, fontSize: 13, resize: 'vertical' }}
            value={jinjaValue}
            placeholder={
              // The placeholder used to unconditionally say
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

  // ----- Speculative Decoding widget -----
  const renderSpecWidget = () => {
    const detected = effectiveModelPath ? detectedSpeculation[effectiveModelPath] : null
    const candidates = detected?.candidates || []
    // draft-max/min/p-min act as each tier's own "preset" — diff-highlight
    // them against the CURRENTLY SELECTED tier's own values, not a fixed
    // hardcoded baseline, and offer a reset-to-tier-default button, matching
    // how every other preset-diff in this app works.
    const draftMaxVal = args['--spec-draft-n-max']
    const draftMinVal = args['--spec-draft-n-min']
    const draftPMinVal = args['--spec-draft-p-min']
    const draftMaxChanged = currentSpecTierDef.tier > 0 && draftMaxVal !== undefined && draftMaxVal !== '' && Number(draftMaxVal) !== currentSpecTierDef.draftMax
    const draftMinChanged = currentSpecTierDef.tier > 0 && draftMinVal !== undefined && draftMinVal !== '' && Number(draftMinVal) !== currentSpecTierDef.draftMin
    const draftPMinChanged = currentSpecTierDef.tier > 0 && draftPMinVal !== undefined && draftPMinVal !== '' && Number(draftPMinVal) !== currentSpecTierDef.draftPMin
    return (
      <div className="spec-widget">
        <div className="mmproj-widget-title"><Sparkles size={15} /> Speculative Decoding</div>
        <div className="mmproj-widget-arg">--spec-type · Accelerate generation using draft tokens</div>
        <div className="spec-widget-row">
          <span className="mmproj-widget-label">Method</span>
          <select
            className="cmd-select"
            value={currentSpecTierDef.method}
            onChange={e => {
              const t = SPEC_TIER_DEFS.find(td => td.method === e.target.value) || SPEC_TIER_DEFS[0]
              // If we have exactly one detected candidate for this tier, use
              // its path automatically; otherwise leave the existing/empty
              // path for the user to fill in via the candidate list or
              // manual browse below.
              const matchingCandidate = candidates.find(c => c.method === t.method)
              setSpecTier(t, matchingCandidate ? matchingCandidate.path : undefined)
            }}
            disabled={disabled}
          >
            {SPEC_TIER_DEFS.map(t => <option key={t.method} value={t.method}>{t.label}{t.tier > 0 ? ` (T${t.tier})` : ''}</option>)}
          </select>
        </div>
        {detected && detected.tier > 0 && (
          <div className="spec-detected-info"><Gauge size={12} /> Auto-detected: {detected.reason} (applied automatically — highest tier found)</div>
        )}
        {/* Item 1: manual candidate picker — every sidecar file (and native
            MTP, if present) found alongside this model, so the user can
            switch to a LOWER tier, or a different file of the same tier,
            without fighting the auto-detected winner. */}
        {candidates.length > 1 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>All detected speculative decoding sources for this model:</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {candidates.map(c => {
                const tierDef = SPEC_TIER_DEFS.find(t => t.method === c.method)
                if (!tierDef) return null
                const isActive = currentSpecTierDef.method === c.method && (tierDef.tier < 2 || args['--spec-draft-model'] === c.path)
                return (
                  <button
                    type="button"
                    key={`${c.method}-${c.path || 'internal'}`}
                    className={`spec-candidate-btn ${isActive ? 'active' : ''}`}
                    onClick={() => setSpecTier(tierDef, c.path)}
                    disabled={disabled}
                  >
                    <span className="spec-candidate-tier">T{c.tier}</span>
                    <span className="spec-candidate-label">{c.label}</span>
                    <span className="spec-candidate-file">{c.name || '(embedded)'}</span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
        {currentSpecTierDef.tier >= 2 && (
          <div className="spec-widget-row" style={{ marginTop: 8 }}>
            <span className="mmproj-widget-label">Sidecar file</span>
            <input
              type="text"
              className="cmd-input mono"
              style={{ flex: 1, fontSize: 12 }}
              value={args['--spec-draft-model'] || ''}
              placeholder="/path/to/draft-model.gguf"
              onChange={e => handleUpdate('--spec-draft-model', e.target.value)}
              disabled={disabled}
            />
            <button type="button" className="btn btn-ghost btn-icon" title="Browse" disabled={disabled} onClick={async () => {
              const f = await window.api?.pickAnyFile?.()
              if (f) handleUpdate('--spec-draft-model', f)
            }}>
              <FolderOpen size={14} />
            </button>
          </div>
        )}
        {/* Item 2: draft-max/min/p-min are each tier's own "preset" — shown
            whenever a method is picked (not Off), diffed against the
            SELECTED tier's own values, with a reset button. */}
        {currentSpecTierDef.tier > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className={`cmd-row cmd-row-hybrid ${draftMaxChanged ? 'changed-param' : ''}`} style={{ padding: '6px 0', border: 'none', background: 'transparent', position: 'relative' }}>
              {draftMaxChanged && <div className="changed-indicator" />}
              <div className="cmd-label-group">
                <div className="cmd-label">Max Draft Tokens</div>
                <div className="cmd-arg">--spec-draft-n-max</div>
              </div>
              <HybridSlider value={draftMaxVal ?? currentSpecTierDef.draftMax} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-max', v)} defaultVal={currentSpecTierDef.draftMax} disabled={disabled} />
              {draftMaxChanged && <button type="button" className="cmd-reset-btn" onClick={() => handleUpdate('--spec-draft-n-max', currentSpecTierDef.draftMax)} disabled={disabled} title={`Reset to ${currentSpecTierDef.label} default (${currentSpecTierDef.draftMax})`}><RotateCcw size={12} /></button>}
            </div>
            <div className={`cmd-row cmd-row-hybrid ${draftMinChanged ? 'changed-param' : ''}`} style={{ padding: '6px 0', border: 'none', background: 'transparent', position: 'relative' }}>
              {draftMinChanged && <div className="changed-indicator" />}
              <div className="cmd-label-group">
                <div className="cmd-label">Min Draft Tokens</div>
                <div className="cmd-arg">--spec-draft-n-min</div>
              </div>
              <HybridSlider value={draftMinVal ?? currentSpecTierDef.draftMin} min={0} max={128} step={1} onChange={v => handleUpdate('--spec-draft-n-min', v)} defaultVal={currentSpecTierDef.draftMin} disabled={disabled} />
              {draftMinChanged && <button type="button" className="cmd-reset-btn" onClick={() => handleUpdate('--spec-draft-n-min', currentSpecTierDef.draftMin)} disabled={disabled} title={`Reset to ${currentSpecTierDef.label} default (${currentSpecTierDef.draftMin})`}><RotateCcw size={12} /></button>}
            </div>
            <div className={`cmd-row cmd-row-hybrid ${draftPMinChanged ? 'changed-param' : ''}`} style={{ padding: '6px 0', border: 'none', background: 'transparent', position: 'relative' }}>
              {draftPMinChanged && <div className="changed-indicator" />}
              <div className="cmd-label-group">
                <div className="cmd-label">Draft Probability</div>
                <div className="cmd-arg">--spec-draft-p-min</div>
              </div>
              <HybridSlider value={draftPMinVal ?? currentSpecTierDef.draftPMin} min={0} max={1} step={0.01} onChange={v => handleUpdate('--spec-draft-p-min', v)} defaultVal={currentSpecTierDef.draftPMin} disabled={disabled} />
              {draftPMinChanged && <button type="button" className="cmd-reset-btn" onClick={() => handleUpdate('--spec-draft-p-min', currentSpecTierDef.draftPMin)} disabled={disabled} title={`Reset to ${currentSpecTierDef.label} default (${currentSpecTierDef.draftPMin})`}><RotateCcw size={12} /></button>}
            </div>
          </div>
        )}
        {currentSpecTierDef.method === 'draft-model' && !args['--spec-draft-model'] && (
          <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6 }}>A draft model path (--spec-draft-model) is required for this method.</div>
        )}

        {/* Item 4: stackable n-gram modifiers — these ADD to --spec-type
            (comma-separated) alongside whatever primary method is selected
            above (including "Off" — n-gram-only speculative decoding is
            valid), per llama.cpp's stacking support. */}
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
            Stackable modifiers — combine with the method above
          </div>
          <NgramModifierBlock
            title="N-gram Map (K4V)"
            flagPrefix="--spec-ngram-map-k4v"
            enabled={ngramMapK4vOn}
            onToggle={(on) => setNgramModifier('map-k4v', on)}
            disabled={disabled}
            fields={[
              { key: 'size-n', label: 'Match Window Size', def: 12 },
              { key: 'size-m', label: 'Map Table Size', def: 48 },
              { key: 'min-hits', label: 'Minimum Hits', def: 1 }
            ]}
            args={args}
            handleUpdate={handleUpdate}
          />
          <NgramModifierBlock
            title="N-gram Modifier"
            flagPrefix="--spec-ngram-mod"
            enabled={ngramModOn}
            onToggle={(on) => setNgramModifier('mod', on)}
            disabled={disabled}
            fields={[
              { key: 'n-match', label: 'Match Length', def: 24 },
              { key: 'n-min', label: 'Minimum N-gram Size', def: 48 },
              { key: 'n-max', label: 'Maximum N-gram Size', def: 64 }
            ]}
            args={args}
            handleUpdate={handleUpdate}
          />
        </div>
      </div>
    )
  }

  // ----- MoE widget -----
  const renderMoeWidget = () => {
    if (!isMoe) return null
    const moeMax = expertCount > 0 ? expertCount : 256
    // Expert_used_count = active experts. Default the slider to this value.
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
        {/* Force MoE weights onto CPU layers (inverse locking) */}
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

  // ----- Reasoning Budget widget -----
  // ALL parameters need blue line + reset button.
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

  // ----- Context block: Ignore-Override + AutoFill + Memory Overhead -----
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
                // Turning ON now defaults to 'maximum' for BOTH dense
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

  // ----- VRAM budget display -----
  // Apply the recommended GPU-layers / CPU-forced-layers value from
  // line 1 (L1) into --gpu-layers or --moe-cpu-layers depending on strategy.
  function applyLine1Recommendation() {
    if (!vramBudget) return
    if (isMoe && modelDefaults.moeOffloadStrategy === 'max') {
      commit({ ...args, '--moe-cpu-layers': vramBudget.recommendedLayers, '--gpu-layers': vramBudget.maxLayers })
    } else {
      commit({ ...args, '--gpu-layers': vramBudget.recommendedLayers })
    }
  }
  // Apply line 2's projection — L2 GPU layers (ideally = all layers)
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
    // BPW-accurate VRAM breakdown (W + KV + B + O) so the user can see
    // exactly where the memory goes and verify the calculation.
    const kv = vramBudget as any
    const isMaxStrategy = isMoe && modelDefaults.moeOffloadStrategy === 'max'
    const c1 = formatWithSpaces(vramBudget.autoFitContext)
    // Label depends on Dense vs MoE (vs MoE+"max" strategy).
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
      {/* Model context info: file_type/BPW + attention geometry */}
      {meta && (
        <div className="cpu-info-banner">
          <Layers size={13} />
          <span>{meta.modelName || 'Unknown model'}</span>
          {meta.blockCount && <span className="cpu-info-cores">{meta.blockCount} layers</span>}
          {meta.contextLength && <span className="cpu-info-cores">Model supports up to {meta.contextLength.toLocaleString()} tokens</span>}
          {meta.fileType && (() => {
            const filenameLabel = (meta as any).fileTypeFilenameHint as string | null | undefined
            // `meta.fileType` is now the
            // internal general.file_type value whenever available — this is
            // what llama-server itself reports/uses when loading the model,
            // so our display matches llama-server's own logs. Unsloth
            // Dynamic/mixed quants (e.g. "UD-Q3_K_XL" in the filename) mix
            // bit-widths per-tensor, so the internal "dominant type" enum can
            // legitimately differ from that marketing label — when it does,
            // show BOTH, clearly labeled, instead of silently picking one.
            return (
              <span className="cpu-info-cores" title="Dominant quantization (general.file_type) — matches what llama-server itself reports when loading this model">
                Quant: <strong>{meta.fileType}</strong>
                {filenameLabel && filenameLabel !== meta.fileType && (
                  <span style={{ opacity: 0.7 }} title={`Filename says "${filenameLabel}". Dynamic/mixed quants intentionally use different bit-widths per tensor, so this can legitimately differ from the internal dominant-type metadata above — llama-server itself will report "${meta.fileType}", not "${filenameLabel}".`}>
                    {' '}(filename: {filenameLabel})
                  </span>
                )}
              </span>
            )
          })()}
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Item 5: vertical-stack toggle — flips the preview between a
                continuous flag string and one flag per line (shell-script
                style with backslash continuations), for readability with
                long/stacked commands. */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }} title="Show as a vertical stack of flags instead of one continuous line">
              <input type="checkbox" checked={stackedPreview} onChange={e => setStackedPreview(e.target.checked)} />
              Stacked view
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={() => {
                navigator.clipboard.writeText(stackedPreview ? cmdPreviewStackedText : cmdPreviewText).then(() => {
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
        </div>
        {stackedPreview ? (
          <pre className="cmd-preview cmd-preview-stacked" style={{ userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>{cmdPreviewStackedText}</pre>
        ) : (
          <div className="cmd-preview" style={{ userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }}>{cmdPreview}</div>
        )}
      </div>
    </div>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Cpu, Database, GitBranch, Lock, RotateCcw, Server, Wind, Zap } from 'lucide-react'
import { useStore } from '../store/useStore'
import SegmentedToggle from './SegmentedToggle'
import HybridSlider from './HybridSlider'
import CommandPreview, { type PreviewToken } from './CommandPreview'
import type { CommandParam, CommandsSchema, StrataSettings } from '../../../shared/types'
import { ENGINES, type EngineId } from '../../../shared/engines'
import {
  buildStrataArgv, buildStrataQuickBaseline, estimateStrataMemory, strataDefaults, strataGgufDir,
  STRATA_COMMON_FLAGS, STRATA_NATIVE_CONTEXT, STRATA_VARIANTS
} from '../../../shared/strata'
import { resolveEngineBackend } from '../utils/engineBackends'
import { formatWithSpaces, CONTEXT_POWER_OF_TWO_STEPS, snapToNearestPowerOfTwo } from '../utils/contextFormat'
import { markTemplateSavePending, markTemplateSaveDone } from '../utils/templateSync'

// Parameter editor for engines whose settings are a short, flat list (Strata).
// llama.cpp keeps CmdParamsEditor, which carries a lot of llama-only logic
// (GPU layers, MoE offload, speculative decoding, YaRN, mmproj). Both edit the
// same Template `args`, share the preset marker `__lastPreset`, the Common /
// Full switch and the Preview. There is no Manual preset here: with so few
// settings, all of them chosen automatically, it would add nothing.
//
// A value left out of `args` is not shown as "Default": the field shows the
// value the engine will actually use (strataDefaults). Presets work as in the
// llama.cpp editor: each has its own baseline, a field is highlighted when it
// differs from the SELECTED preset's baseline, and editing never switches the
// preset.

interface Props {
  engine: EngineId
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
  disabled?: boolean
  backendKey?: string | null
  headerPortalTarget?: HTMLElement | null
}

type Preset = 'fullauto' | 'quick'

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Box: <Box size={14} />, Cpu: <Cpu size={14} />, Zap: <Zap size={14} />, Database: <Database size={14} />,
  Wind: <Wind size={14} />, Server: <Server size={14} />, GitBranch: <GitBranch size={14} />
}

// Slider ceiling while Automatic YaRN scaling control is on, as in the llama.cpp
// editor.
const CTX_YARN_MAX = 2097152

function kLabel(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}

// A comparison that treats 2048 and "2048" alike.
function same(a: unknown, b: unknown): boolean {
  return String(a ?? '') === String(b ?? '')
}

export default function EngineParamsEditor({
  engine, templateId, args, onChange, modelPathFallback, serverPortFallback,
  disabled: disabledProp, backendKey: backendKeyProp, headerPortalTarget
}: Props) {
  const {
    updateCard, cards, models, ggufMetadata, backends, activeBackend, engineGlobals,
    vramInfo, systemRam, modelDefaults, baseUrlOverride, paramViewMode, setParamViewMode
  } = useStore()
  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const disabled = disabledProp || card?.status === 'running'
  const modelPath = modelPathFallback ?? card?.template.modelPath ?? ''
  const port = serverPortFallback ?? card?.template.serverPort ?? 8080
  const meta = modelPath ? ggufMetadata[modelPath] : undefined
  const verdict = meta?.strata as { kind: string; family?: string; model?: string } | undefined

  const build = useMemo(() => resolveEngineBackend(
    engine,
    { backendKey: backendKeyProp !== undefined ? backendKeyProp : card?.template.backendKey },
    backends, activeBackend, engineGlobals
  ), [engine, backendKeyProp, card?.template.backendKey, backends, activeBackend, engineGlobals])

  const [schema, setSchema] = useState<CommandsSchema | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.getCommands(build?.backendKey || '', engine).then(s => { if (!cancelled) setSchema(s) })
    return () => { cancelled = true }
  }, [build?.backendKey, engine])

  // What the launch will add on top of the template: the data folder and the
  // Strata-wide parallel override.
  const [strataCfg, setStrataCfg] = useState<{ strata: StrataSettings; strataDataDir: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.getEngineSettings().then(s => { if (!cancelled) setStrataCfg({ strata: s.strata, strataDataDir: s.strataDataDir }) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const argsRef = useRef(args)
  argsRef.current = args
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function commit(next: Record<string, any>) {
    if (onChange) { onChange(next); return }
    if (!templateId) return
    updateCard(templateId, { args: next })
    // Same debounced write-through as the llama.cpp editor: one disk write
    // per burst of edits, tracked so an unsaved edit is never lost on quit.
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)
    else markTemplateSavePending(templateId)
    const id = templateId
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null
      const latest = useStore.getState().cards.find(c => c.template.id === id)
      if (!latest) { markTemplateSaveDone(id); return }
      Promise.resolve(window.api?.saveTemplate?.(latest.template)).catch(() => {}).finally(() => markTemplateSaveDone(id))
    }, 400)
  }

  // ----- Defaults -----
  const vramTotalGb = (vramInfo?.totalVRAMMB || 0) / 1024
  const ramTotalGb = (systemRam?.totalRAMMB || 0) / 1024
  const variant = String(args['--model'] || verdict?.model || '')
  const family = String(args['--family'] || verdict?.family || '')
  const vision = String(args['--vision'] ?? 'no')
  const rec = strataDefaults({ variant, family, vramTotalGb, ramTotalGb, vision })
  const effectiveCtx = Number(args['--context']) || Number(rec['--context'])
  const defaults: Record<string, string | number> = { ...strataDefaults({ variant, family, vramTotalGb, ramTotalGb, vision, context: effectiveCtx }) }
  // The identity fields default to what was detected, not to a pick.
  if (verdict?.family) defaults['--family'] = verdict.family; else delete defaults['--family']
  if (verdict?.model) defaults['--model'] = verdict.model; else delete defaults['--model']

  // ----- Presets (same model as the llama.cpp editor) -----
  // A Template saved before Manual was removed (marker 'clear') is FULL AUTO.
  const preset: Preset = args.__lastPreset === 'quick' ? 'quick' : 'fullauto'
  const hasVision = !!models.find(g => g.models.some(m => m.path === modelPath))?.mmproj
  const quickArgs = buildStrataQuickBaseline({ contextLength: meta?.contextLength, hasVision })
  // The value a field has in the SELECTED preset: its explicit value there,
  // else the engine default.
  const baselineOf = (arg: string) => (preset === 'quick' && quickArgs[arg] !== undefined ? quickArgs[arg] : defaults[arg])
  const effective = (arg: string) => args[arg] ?? defaults[arg]
  const isChanged = (arg: string) => !same(effective(arg), baselineOf(arg))

  // FULL AUTO sends only the model's identity; everything is left to the
  // engine's own recommendation. Quick is the shared baseline.
  function applyFullAuto() { commit({ __lastPreset: 'fullauto' }) }
  function applyQuick() { commit({ ...quickArgs, __lastPreset: 'quick' }) }

  function update(arg: string, value: any) {
    const next = { ...args }
    if (value === null || value === undefined || value === '' || value === false) delete next[arg]
    else next[arg] = value
    commit(next)
  }
  // Back to the selected preset's own value for the field.
  function reset(arg: string) {
    update(arg, preset === 'quick' && quickArgs[arg] !== undefined ? quickArgs[arg] : null)
  }

  // ----- Automatic YaRN scaling (same control as the llama.cpp editor) -----
  const ctxUse2x = args['__ctxUse2xIncrements'] === true
  const yarnAuto = args['__yarnAutoScale'] === true
  const nativeCtx = meta?.contextLength > 0 ? meta.contextLength : STRATA_NATIVE_CONTEXT
  // Like the llama.cpp slider: the model's own context from its metadata, and
  // up to 2 097 152 while YaRN scaling is managed automatically.
  const ctxSliderMax = yarnAuto ? CTX_YARN_MAX : nativeCtx
  const ctxLadder = CONTEXT_POWER_OF_TWO_STEPS.filter(s => s <= ctxSliderMax)
  useEffect(() => {
    if (disabled || !yarnAuto) return
    const cur = argsRef.current
    const target = Number(cur['--context']) || effectiveCtx
    const next = { ...cur }
    if (target > nativeCtx) {
      next['--rope-scaling'] = 'yarn'
      next['--rope-scale'] = Math.round(Math.max(1, target / nativeCtx) * 100) / 100
    } else {
      delete next['--rope-scaling']
      delete next['--rope-scale']
    }
    if (!same(next['--rope-scaling'], cur['--rope-scaling']) || !same(next['--rope-scale'], cur['--rope-scale'])) commit(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yarnAuto, effectiveCtx, nativeCtx, disabled])

  // ----- Memory estimate (mirrors the engine's own setup rules) -----
  const useCurrent = modelDefaults?.useCurrentMemState !== false
  const vramGb = ((useCurrent ? vramInfo?.freeVRAMMB : vramInfo?.totalVRAMMB) || 0) / 1024
  const ramGb = ((useCurrent ? systemRam?.freeRAMMB : systemRam?.totalRAMMB) || 0) / 1024
  const estimate = STRATA_VARIANTS[variant] && engine === 'strata'
    ? estimateStrataMemory({
        variant, context: effectiveCtx, kv: String(effective('--kv')),
        vision: vision !== 'no' && vision !== 'none',
        kvStreaming: String(effective('--kv-streaming')), lowRam: String(effective('--low-ram')),
        reserveMib: Number(effective('--vram-reserve-mib')), vramGb, ramGb
      })
    : null

  // ----- Loading guardrail -----
  // The same modes as the llama.cpp editor, judged on this engine's own RAM
  // need (Strata maps its experts from disk in low-RAM mode, so file size
  // would wrongly block a model that fits).
  const guardMode = modelDefaults?.guardrailMode || 'strict'
  const guardFraction: Record<string, number> = { relaxed: 0.95, balanced: 0.85, strict: 0.75, custom: 0.75 }
  const totalRamGuard = (systemRam?.totalRAMMB || 0) / 1024
  const customMaxGb = modelDefaults?.customMaxSizeGB || 0
  const guardWarning = (() => {
    if (!estimate || guardMode === 'off' || totalRamGuard <= 0) return ''
    const limit = totalRamGuard * (guardFraction[guardMode] ?? 0.75)
    if (guardMode === 'custom' && customMaxGb > 0 && estimate.arenaGb > customMaxGb) {
      return `The model's experts (${estimate.arenaGb.toFixed(1)} GB) exceed your custom limit of ${customMaxGb} GB.`
    }
    if (estimate.ramNeedGb > limit) {
      return `Strata needs about ${estimate.ramNeedGb.toFixed(0)} GB of RAM, above the ${guardMode} guardrail of ${limit.toFixed(0)} GB (${Math.round((guardFraction[guardMode] ?? 0.75) * 100)}% of ${totalRamGuard.toFixed(0)} GB). Loading may make the PC unresponsive.`
    }
    return ''
  })()

  // ----- Preview: the command the launch really runs, overrides applied -----
  const ignoreBaseUrlOverride = args['__ignoreBaseUrlOverride'] === true
  const overrideOn = !!baseUrlOverride?.enabled && !ignoreBaseUrlOverride
  const effectivePort = overrideOn ? (baseUrlOverride.port || 1234) : port
  const hostOverride = overrideOn && !!baseUrlOverride.serveOnLocalNetwork ? '0.0.0.0' : null
  const apiKeyOverride = overrideOn && !!baseUrlOverride.apiKeyEnabled && !!baseUrlOverride.apiKey ? baseUrlOverride.apiKey : null
  const parallelOverride = strataCfg?.strata.parallelOverride ?? null

  const preview = useMemo((): { tokens: PreviewToken[]; error?: string } => {
    if (!modelPath) return { tokens: [] }
    const built = buildStrataArgv({
      ggufDir: strataGgufDir(modelPath), family: verdict?.family, model: verdict?.model, port: effectivePort,
      args: parallelOverride ? { ...args, '--parallel': parallelOverride } : args,
      host: hostOverride, apiKey: apiKeyOverride, dataDir: strataCfg?.strataDataDir
    })
    if ('error' in built) return { tokens: [], error: built.error }
    const tokens: PreviewToken[] = []
    for (let i = 0; i < built.argv.length; i++) {
      const flag = built.argv[i]
      if (!flag.startsWith('--')) continue
      const next = built.argv[i + 1]
      const hasValue = next !== undefined && !next.startsWith('--')
      if (hasValue) i++
      const title = flag === '--port' && overrideOn ? `Set by the global Base URL Override (was ${port} for this Template)`
        : flag === '--host' && hostOverride ? 'Added by the global Base URL Override -> "Serve on local network"'
          : flag === '--api-key' && apiKeyOverride ? 'Added by the global Base URL Override -> API Key'
            : flag === '--parallel' && parallelOverride ? `Set by the Strata parallel override (was ${args['--parallel'] ?? 'unset'} in this Template)`
              : flag === '--data-dir' ? 'Added from Settings > Strata > Data folder'
                : undefined
      tokens.push({ flag, value: hasValue ? next : undefined, overridden: !!title, title })
    }
    return { tokens }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args, modelPath, verdict?.family, verdict?.model, effectivePort, port, overrideOn, hostOverride, apiKeyOverride, parallelOverride, strataCfg?.strataDataDir])

  // ----- Rows -----
  const renderRow = (cmd: CommandParam) => {
    const raw = args[cmd.arg]
    const val = raw ?? defaults[cmd.arg] ?? ''
    const changed = isChanged(cmd.arg)
    const isCtx = cmd.arg === '--context'
    const managedRope = yarnAuto && (cmd.arg === '--rope-scaling' || cmd.arg === '--rope-scale')
    const rowDisabled = disabled || managedRope
    const showReset = changed && !rowDisabled
    return (
      <div key={cmd.arg} className={`cmd-row ${changed ? 'changed-param' : ''} ${isCtx ? 'cmd-row-hybrid' : ''}`}>
        {changed && <div className="changed-indicator" />}
        <div className="cmd-label-group">
          <div className="cmd-label tooltip-wrap">
            {cmd.label}
            <span className="tooltip">{cmd.description}</span>
          </div>
          <div className="cmd-arg">{cmd.arg}</div>
        </div>
        <div className="cmd-input-group">
          {isCtx && (
            <>
              {/* The value is the explicit one only, so the field can be erased to
                  type a number by hand; the engine's default shows as the placeholder. */}
              <HybridSlider
                value={raw ?? ''} min={0} max={ctxSliderMax} step={1}
                onChange={v => update('--context', v === '' || v === null || Number(v) <= 0 ? null : Number(v))}
                placeholder={String(defaults['--context'])} defaultVal={defaults['--context']} disabled={rowDisabled}
                useSpacedFormat use2xIncrements={ctxUse2x} ladderSteps={ctxLadder}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6, flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: rowDisabled ? 'not-allowed' : 'pointer' }}>
                  <input type="checkbox" checked={ctxUse2x} disabled={rowDisabled} onChange={e => {
                    const next: Record<string, any> = { ...args, '__ctxUse2xIncrements': e.target.checked }
                    if (e.target.checked && effectiveCtx > 0) next['--context'] = snapToNearestPowerOfTwo(effectiveCtx, ctxLadder)
                    commit(next)
                  }} />
                  Use 2x increments
                </label>
                <label
                  style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: rowDisabled ? 'not-allowed' : 'pointer' }}
                  title="Sets RoPE scaling to yarn and the scale factor to reach the chosen context whenever it is longer than the model's native context."
                >
                  <input type="checkbox" checked={yarnAuto} disabled={rowDisabled} onChange={e => commit({ ...args, '__yarnAutoScale': e.target.checked })} />
                  Automatic YaRN scaling control
                </label>
              </div>
              {yarnAuto && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  Native context: {formatWithSpaces(nativeCtx)}. RoPE Scaling and RoPE Scale are now managed automatically for this Template.
                </div>
              )}
            </>
          )}
          {!isCtx && cmd.type === 'boolean' && (
            <div className="toggle-wrap">
              <label className="toggle" style={rowDisabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
                <input type="checkbox" checked={!!val} onChange={e => update(cmd.arg, e.target.checked)} disabled={rowDisabled} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          )}
          {!isCtx && cmd.type === 'number' && (
            <input
              type="number" className="cmd-input" value={val} placeholder={cmd.placeholder}
              min={cmd.min} max={cmd.max} step="any" disabled={rowDisabled}
              onChange={e => update(cmd.arg, e.target.value === '' ? null : Number(e.target.value))}
            />
          )}
          {!isCtx && cmd.type === 'string' && (
            <input
              type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={val}
              placeholder={cmd.placeholder} disabled={rowDisabled}
              onChange={e => update(cmd.arg, e.target.value)}
            />
          )}
          {!isCtx && cmd.type === 'select' && (
            <select className="cmd-select" value={val} onChange={e => update(cmd.arg, e.target.value)} disabled={rowDisabled}>
              {val === '' && <option value="">{cmd.emptyLabel || 'Not set'}</option>}
              {cmd.options?.map(opt => <option key={opt} value={opt}>{cmd.optionLabels?.[opt] ?? opt}</option>)}
              {val !== '' && cmd.options && !cmd.options.includes(String(val)) && <option value={String(val)}>{String(val)}</option>}
            </select>
          )}
        </div>
        {showReset && (
          <button type="button" className="cmd-reset-btn" onClick={() => reset(cmd.arg)} title="Reset to this preset's value">
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    )
  }

  const visibleCategories = (schema?.categories || [])
    .map(cat => ({ ...cat, commands: cat.commands.filter(c => paramViewMode === 'full' || STRATA_COMMON_FLAGS.has(c.arg)) }))
    .filter(cat => cat.commands.length > 0)

  const header = (
    <>
      <SegmentedToggle
        label="Settings:"
        options={[
          { value: 'fullauto', label: 'FULL\nAUTO', icon: null as any },
          { value: 'quick', label: 'Quick' }
        ]}
        value={preset}
        onChange={v => v === 'quick' ? applyQuick() : applyFullAuto()}
        disabled={disabled}
      />
      <SegmentedToggle
        label="Parameters:"
        options={[{ value: 'common', label: 'Common' }, { value: 'full', label: 'Full' }]}
        value={paramViewMode}
        onChange={v => setParamViewMode(v as 'common' | 'full')}
        disabled={disabled}
      />
      {disabled && card?.status === 'running' && (
        <div className="cpu-info-banner">
          <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
          Parameters are locked while the model is running. Stop it first to make changes.
        </div>
      )}
      {preset === 'fullauto' && (
        <div className="cpu-info-banner">
          <span>Every value not changed here is left to {ENGINES[engine].label}'s own recommendation for this machine.</span>
        </div>
      )}
    </>
  )

  return (
    <div>
      {headerPortalTarget ? createPortal(header, headerPortalTarget) : header}
      {estimate && (
        <div className="cpu-info-banner" style={{ flexWrap: 'wrap' }}>
          <span>KV cache: <strong>{estimate.kvGb.toFixed(1)}</strong> GB at {kLabel(effectiveCtx)} ({(estimate.kvBytesPerToken / 1024).toFixed(1)} KB/token)</span>
          {vramGb > 0 && <span>Experts on GPU: <strong>{estimate.expertCacheGb.toFixed(1)}</strong> of {estimate.arenaGb.toFixed(1)} GB ({Math.round(estimate.gpuShare * 100)}%)</span>}
          {ramGb > 0 && (
            <span style={estimate.fitsRam ? undefined : { color: 'var(--danger)' }}>
              RAM: needs about <strong>{estimate.ramNeedGb.toFixed(0)}</strong> GB, {useCurrent ? 'free' : 'installed'} {ramGb.toFixed(0)} GB{estimate.lowRam ? ' (low-RAM mode)' : ''}
            </span>
          )}
        </div>
      )}
      {guardWarning && (
        <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>{guardWarning}</div>
      )}
      {verdict && verdict.kind !== 'known' && verdict.kind !== 'layout' && (
        <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>
          This file is not one Strata is known to run. Launching it may be refused by Strata's setup.
        </div>
      )}
      {!schema ? (
        <div className="text-muted text-sm">No commands schema loaded. Ensure an engine is installed.</div>
      ) : visibleCategories.map(cat => (
        <div key={cat.name} className="cmd-section">
          <div className="cmd-section-header">{CATEGORY_ICONS[cat.icon]} {cat.name}</div>
          <div className="cmd-grid">{cat.commands.map(renderRow)}</div>
        </div>
      ))}
      {preview.error && <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>{preview.error}</div>}
      {preview.tokens.length > 0 && (
        <CommandPreview program={/win/i.test(navigator.platform) ? 'START-HERE.bat' : 'setup.sh'} tokens={preview.tokens} />
      )}
    </div>
  )
}

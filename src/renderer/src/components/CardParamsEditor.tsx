import React, { useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Box, Cpu, Database, GitBranch, Image as ImageIcon, Lock, Server, SlidersHorizontal, Wind, Wrench, Zap } from 'lucide-react'
import { useStore } from '../store/useStore'
import CommandPreview, { type PreviewToken } from './CommandPreview'
import type { CommandParam, Template } from '../../../shared/types'
import { engineDef, type EngineId } from '../../../shared/engines'
import { buildCardArgv, cardLauncherFile } from '../../../shared/engineCard'
import type { CardBlock } from '../../../shared/cardLogic'
import { applyPreset, overrideArgsFor, paramView, renderBlock, resolveCard, setArgValue } from '../../../shared/cardRules'
import { globalOverrideValues } from '../../../shared/cardGlobals'
import { CUSTOM_ARGS_KEY } from '../../../shared/customArgs'
import { resolveEngineBackend } from '../utils/engineBackends'
import { markTemplateSavePending, markTemplateSaveDone } from '../utils/templateSync'
import { activeServerOverrides, findPortConflict } from '../utils/templatePort'
import { useCardContext } from '../hooks/useCardContext'
import { useVramBudget } from '../hooks/useVramBudget'
import ServerParamsBlock from './ServerParamsBlock'
import SegmentedToggle from './SegmentedToggle'
import LayoutSections, { type LayoutSection } from './LayoutSections'
import CardPresetBar from './CardPresetBar'
import { Banner, ParamControl, ParamRow } from './paramParts'

// Parameter editor for engines defined by a card. Rows, rules, blocks and
// presets all come from the card; the editor knows nothing else about the
// engine. It edits the same Template `args` as the other editors, with the
// same debounced save, Server block, layout editing and Preview.

interface Props {
  engine: EngineId
  templateId?: string
  args: Record<string, any>
  onChange?: (args: Record<string, any>) => void
  modelPathFallback?: string
  serverPortFallback?: number
  onServerPortChange?: (port: number) => void
  disabled?: boolean
  layoutEditing?: boolean
  backendKey?: string | null
  headerPortalTarget?: HTMLElement | null
}

// Server parameters kept in `args`; the port is the Template's own field.
const SERVER_ARGS = ['--host', '--api-key']

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  Box: <Box size={14} />, Cpu: <Cpu size={14} />, Zap: <Zap size={14} />, Database: <Database size={14} />,
  Wind: <Wind size={14} />, Server: <Server size={14} />, GitBranch: <GitBranch size={14} />,
  Image: <ImageIcon size={14} />, Wrench: <Wrench size={14} />, Sliders: <SlidersHorizontal size={14} />
}

const gb = (mb: number) => (mb / 1024).toFixed(1)

export default function CardParamsEditor({
  engine, templateId, args, onChange, modelPathFallback, serverPortFallback, onServerPortChange,
  disabled: disabledProp, backendKey: backendKeyProp, headerPortalTarget, layoutEditing = false
}: Props) {
  const { updateCard, cards, backends, activeBackend, engineGlobals, baseUrlOverride, engineOverrides, modelDefaults, cpuInfo, ggufMetadata } = useStore()
  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const disabled = disabledProp || card?.status === 'running'
  const modelPath = modelPathFallback ?? card?.template.modelPath ?? ''
  const port = serverPortFallback ?? card?.template.serverPort ?? 8080
  const def = engineDef(engine)
  const engineCard = def.card ?? null
  const templateName = card?.template.name ?? ''

  const build = useMemo(() => resolveEngineBackend(
    engine,
    { backendKey: backendKeyProp !== undefined ? backendKeyProp : card?.template.backendKey },
    backends, activeBackend, engineGlobals
  ), [engine, backendKeyProp, card?.template.backendKey, backends, activeBackend, engineGlobals])

  const argsRef = useRef(args)
  argsRef.current = args
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function commit(next: Record<string, any>, patch?: Partial<Template>) {
    if (onChange) { onChange(next); return }
    if (!templateId) return
    updateCard(templateId, { args: next, ...patch })
    // One disk write per burst of edits, tracked so an unsaved edit is never
    // lost on quit.
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


  function update(cmd: CommandParam | null, arg: string, value: any) {
    commit(setArgValue(cmd, args, arg, value))
  }

  const ignoreBaseUrlOverride = args['__ignoreBaseUrlOverride'] === true
  const serverOverrides = activeServerOverrides(baseUrlOverride, ignoreBaseUrlOverride)
  const overrideOn = serverOverrides.port !== null
  const effectivePort = serverOverrides.port ?? port

  const ctx = useCardContext({
    engine, args, modelPath, templateName, port: effectivePort,
    host: serverOverrides.host, apiKeySet: !!serverOverrides.apiKey
  })
  const meta = modelPath ? ggufMetadata[modelPath] : null
  const isMoe = !!meta?.isMoe || (meta?.expertCount || 0) > 0

  // The same resolution a launch makes, so what is shown is what is sent.
  const overrideArgs = useMemo(() => (engineCard
    ? overrideArgsFor(engineCard, engineOverrides[engine], globalOverrideValues(modelDefaults, isMoe, cpuInfo), ctx)
    : {}), [engineCard, engineOverrides, engine, modelDefaults, isMoe, cpuInfo, ctx])
  const resolved = useMemo(() => (engineCard ? resolveCard(engineCard, args, ctx, overrideArgs) : null), [engineCard, args, ctx, overrideArgs])
  const viewCtx = useMemo(() => ({ ...ctx, args: resolved?.args ?? args }), [ctx, resolved, args])

  const preview = useMemo((): { tokens: PreviewToken[]; error?: string } => {
    if (!engineCard || !modelPath) return { tokens: [] }
    const built = buildCardArgv(engineCard, {
      modelPath, port: effectivePort, host: serverOverrides.host ? '0.0.0.0' : undefined,
      apiKey: serverOverrides.apiKey || undefined, engineDir: build?.path ?? '', args, context: ctx, overrideArgs
    })
    if ('error' in built) return { tokens: [], error: built.error }
    const tokens: PreviewToken[] = []
    for (let i = 0; i < built.argv.length; i++) {
      const flag = built.argv[i]
      const isFlag = flag.startsWith('-')
      const next = built.argv[i + 1]
      const hasValue = isFlag && next !== undefined && !next.startsWith('-')
      if (hasValue) i++
      const title = flag === '--port' && overrideOn ? `Set by the global Base URL Override (was ${port} for this Template)` : undefined
      tokens.push({ flag, value: hasValue ? next : undefined, overridden: !!title, title })
    }
    return { tokens }
  }, [engineCard, args, modelPath, effectivePort, port, overrideOn, serverOverrides.host, serverOverrides.apiKey, build?.path, ctx, overrideArgs])

  // Memory estimate: the llama estimator fed with the card's own parameters.
  const mem = engineCard?.memory
  const mapped = (field: keyof NonNullable<typeof mem>['map']) => (mem?.map[field] && resolved ? resolved.args[mem.map[field] as string] : undefined)
  const isGguf = /\.gguf$/i.test(modelPath)
  const budget = useVramBudget({
    modelPath, modelSizeMB: meta?.fileSizeMB ?? 0, maxLayers: meta?.blockCount ?? 0,
    contextSize: Number(mapped('contextLength')) || 0, mmprojEnabled: false, mmprojSizeMB: 0,
    kvQuantType: String(mapped('cacheTypeK') || 'f16'), kvQuantTypeV: mapped('cacheTypeV') ? String(mapped('cacheTypeV')) : undefined,
    ignoreCtxOverride: true
  })

  const renderRow = (cmd: CommandParam) => {
    if (!resolved) return null
    const view = paramView(cmd, viewCtx)
    const lock = resolved.locked.get(cmd.arg)
    const value = lock ? resolved.args[cmd.arg] : args[cmd.arg]
    const inRowBlocks = (engineCard?.params?.blocks ?? []).filter(b => (b.at && typeof b.at === 'object' && b.at.after === cmd.arg) || (b.at === 'end' && lastArgOf(b.section) === cmd.arg))
    const warns = resolved.warnings.filter(w => w.at === cmd.arg)
    return (
      <React.Fragment key={cmd.arg}>
        <ParamRow label={view.label} description={view.description} arg={cmd.arg} note={lock ? lock.reason : undefined}>
          <ParamControl cmd={cmd} view={view} value={value} disabled={disabled || !!lock || resolved.disabled.has(cmd.arg)} onChange={v => update(cmd, cmd.arg, v)} />
        </ParamRow>
        {warns.map((w, i) => <Banner key={i} tone={w.tone}>{w.text}</Banner>)}
        {inRowBlocks.map(b => <React.Fragment key={b.id}>{blockNode(b)}</React.Fragment>)}
      </React.Fragment>
    )
  }

  const firstCategory = engineCard?.params?.categories[0]?.name
  function lastArgOf(section: string | undefined): string | undefined {
    const cat = engineCard?.params?.categories.find(c => c.name === (section ?? firstCategory))
    return cat?.commands.filter(c => !SERVER_ARGS.includes(c.arg)).slice(-1)[0]?.arg
  }

  function blockNode(b: CardBlock): React.ReactNode {
    const r = renderBlock(b, viewCtx)
    if (!r) return null
    if (b.kind === 'banner') return <Banner tone={r.tone}>{r.text}</Banner>
    if (b.kind === 'stat') return <ParamRow label={b.label ?? ''}><span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{r.text}</span></ParamRow>
    if (b.kind === 'divider' || b.kind === 'group') return <div className="text-sm" style={{ color: 'var(--text-muted)', fontWeight: 600, margin: '8px 0 4px' }}>{b.label}</div>
    if (b.kind === 'estimate') {
      if (!modelPath) return <Banner tone="muted">Pick a model to see the memory estimate.</Banner>
      if (!isGguf) return <Banner tone="warning">The memory estimate reads GGUF models only.</Banner>
      if (!budget) return <Banner tone="muted">Memory figures of this machine are not available yet.</Banner>
      const total = budget.weightMB + budget.vramKV + budget.computeBufferMB + budget.overheadMB
      const over = budget.freeVRAMMB > 0 && total > budget.freeVRAMMB
      return (
        <Banner tone={over ? 'warning' : 'info'}>
          {b.label ? `${b.label}: ` : 'Estimated memory: '}{gb(total)} GB (weights {gb(budget.weightMB)}, KV cache {gb(budget.vramKV)}, buffers {gb(budget.computeBufferMB + budget.overheadMB)}) of {gb(budget.freeVRAMMB)} GB VRAM. Modelled on llama.cpp.
        </Banner>
      )
    }
    return null
  }

  const serverBlock = (
    <ServerParamsBlock
      port={port}
      host={String(args['--host'] ?? '')}
      apiKey={String(args['--api-key'] ?? '')}
      overrides={serverOverrides}
      conflict={onServerPortChange ? null : findPortConflict(cards, port, templateId)}
      disabled={disabled}
      onPortChange={p => {
        if (onServerPortChange) onServerPortChange(p)
        else commit(args, { serverPort: p })
      }}
      onHostChange={v => update(null, '--host', v)}
      onApiKeyChange={v => update(null, '--api-key', v)}
    />
  )

  const customArgsBlock = (
    <textarea
      className="custom-args-input" rows={2} spellCheck={false} disabled={disabled}
      placeholder="Flags the list above does not have, as typed on a command line"
      value={String(args[CUSTOM_ARGS_KEY] ?? '')}
      onChange={e => update(null, CUSTOM_ARGS_KEY, e.target.value)}
    />
  )

  // The same per-Template switch llama.cpp Templates have, for engines whose card describes checkpoints.
  const checkpointMode = (args['__checkpointMode'] as string) || 'follow'
  const checkpointBlock = (
    <SegmentedToggle
      label="Automatic checkpoint saving:" disabled={disabled} value={checkpointMode}
      options={[{ value: 'follow', label: 'Follow global' }, { value: 'disabled', label: 'Disabled' }, { value: 'enabled', label: 'Enabled' }]}
      onChange={v => update(null, '__checkpointMode', v === 'follow' ? null : v)}
    />
  )

  const blocksFor = (section: string): { id: string; title: string; node: React.ReactNode }[] => {
    const out: { id: string; title: string; node: React.ReactNode }[] = []
    ;(engineCard?.params?.blocks ?? []).forEach(b => {
      const at = b.at ?? 'start'
      if (at !== 'start' || (b.section ?? firstCategory) !== section) return
      const node = blockNode(b)
      if (node) out.push({ id: `card:${b.id}`, title: b.label ?? b.id, node })
    })
    ;(resolved?.warnings ?? []).forEach((w, i) => {
      if (w.at === section) out.push({ id: `card:warn-${i}`, title: 'Notice', node: <Banner tone={w.tone}>{w.text}</Banner> })
    })
    return out
  }

  const visibleCategories = (engineCard?.params?.categories || [])
    .map(cat => ({ ...cat, commands: cat.commands.filter(c => !SERVER_ARGS.includes(c.arg)) }))
    .filter(cat => cat.commands.length > 0)
  const layoutSections: LayoutSection<CommandParam>[] = [
    { key: 'card-server', title: 'Server', rows: [], blocks: [{ id: 'server', title: 'Server', node: serverBlock }], hideTitle: true },
    ...visibleCategories.map(cat => ({ key: cat.name, title: cat.name, icon: CATEGORY_ICONS[cat.icon] ?? CATEGORY_ICONS.Sliders, rows: cat.commands, blocks: blocksFor(cat.name) })),
    ...(engineCard?.checkpoints ? [{ key: 'card-checkpoints', title: 'KV Cache Checkpoints', icon: CATEGORY_ICONS.Database, rows: [] as CommandParam[], blocks: [{ id: 'checkpoints', title: 'KV Cache Checkpoints', node: checkpointBlock }] }] : []),
    { key: 'card-custom-args', title: 'Custom Arguments', icon: CATEGORY_ICONS.Wrench, rows: [], blocks: [{ id: 'custom-args', title: 'Custom Arguments', node: customArgsBlock }] }
  ]

  const header = disabled && card?.status === 'running' ? (
    <div className="cpu-info-banner">
      <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
      Parameters are locked while the model is running. Stop it first to make changes.
    </div>
  ) : null

  const launcher = engineCard ? cardLauncherFile(engineCard, /win/i.test(navigator.platform) ? 'win32' : 'linux') : null
  const presets = engineCard?.params?.presets ?? []
  const topWarnings = (resolved?.warnings ?? []).filter(w => !w.at)
  return (
    <div>
      {headerPortalTarget ? createPortal(header, headerPortalTarget) : header}
      {def.missing && (
        <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>
          The engine card for "{engine}" is not loaded, so this Template cannot start. Add the card in Settings &gt; Engine Cards, or pick another engine for the Template.
        </div>
      )}
      {!def.missing && !build && (
        <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>
          {def.label} is not installed. Put the engine in the "{engineCard?.engine.folder}" folder inside the engines folder (Settings &gt; Engine Cards &gt; Open engine folder).
        </div>
      )}
      {presets.length > 0 && engineCard && (
        <CardPresetBar presets={presets} active={args.__lastPreset} disabled={disabled} onApply={p => commit(applyPreset(engineCard, p, args, ctx))} />
      )}
      {topWarnings.map((w, i) => <Banner key={i} tone={w.tone}>{w.text}</Banner>)}
      {(resolved?.missing ?? []).map(m => <Banner key={m.arg} tone="warning">{m.message}</Banner>)}
      <LayoutSections engine={engine} sections={layoutSections} editing={layoutEditing} hiddenRows={resolved?.hidden ?? new Set<string>()} renderRow={renderRow} />
      {preview.error && <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>{preview.error}</div>}
      {preview.tokens.length > 0 && <CommandPreview program={launcher ?? 'launcher'} tokens={preview.tokens} />}
    </div>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Box, Cpu, Database, GitBranch, Image as ImageIcon, Lock, Server, SlidersHorizontal, Wind, Wrench, Zap } from 'lucide-react'
import { useStore } from '../store/useStore'
import CommandPreview, { type PreviewToken } from './CommandPreview'
import type { CommandParam, CommandsSchema, Template } from '../../../shared/types'
import { engineDef, type EngineId } from '../../../shared/engines'
import { buildCardArgv, cardLauncherFile } from '../../../shared/engineCard'
import { resolveEngineBackend } from '../utils/engineBackends'
import { markTemplateSavePending, markTemplateSaveDone } from '../utils/templateSync'
import { activeServerOverrides, findPortConflict } from '../utils/templatePort'
import ServerParamsBlock from './ServerParamsBlock'
import LayoutSections, { type LayoutSection } from './LayoutSections'
import SelectMenu from './SelectMenu'

// Parameter editor for engines defined by a card. Rows come from the card's
// parameter categories; the editor knows nothing else about the engine. It
// edits the same Template `args` as the other editors, with the same debounced
// save, Server block, layout editing and Preview.

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

export default function CardParamsEditor({
  engine, templateId, args, onChange, modelPathFallback, serverPortFallback, onServerPortChange,
  disabled: disabledProp, backendKey: backendKeyProp, headerPortalTarget, layoutEditing = false
}: Props) {
  const { updateCard, cards, backends, activeBackend, engineGlobals, baseUrlOverride } = useStore()
  const card = templateId ? cards.find(c => c.template.id === templateId) : null
  const disabled = disabledProp || card?.status === 'running'
  const modelPath = modelPathFallback ?? card?.template.modelPath ?? ''
  const port = serverPortFallback ?? card?.template.serverPort ?? 8080
  const def = engineDef(engine)

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
  }, [build?.backendKey, engine, def.card])

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

  // A boolean with an "off" flag keeps an explicit false; every other empty
  // value is removed so the engine's own default applies.
  function update(cmd: CommandParam | null, arg: string, value: any) {
    const next = { ...args }
    const keepFalse = value === false && !!cmd?.offArg
    if (value === null || value === undefined || value === '' || (value === false && !keepFalse)) delete next[arg]
    else next[arg] = value
    commit(next)
  }

  const ignoreBaseUrlOverride = args['__ignoreBaseUrlOverride'] === true
  const serverOverrides = activeServerOverrides(baseUrlOverride, ignoreBaseUrlOverride)
  const overrideOn = serverOverrides.port !== null
  const effectivePort = serverOverrides.port ?? port

  const preview = useMemo((): { tokens: PreviewToken[]; error?: string } => {
    if (!def.card || !modelPath) return { tokens: [] }
    const built = buildCardArgv(def.card, {
      modelPath, port: effectivePort, host: serverOverrides.host ? '0.0.0.0' : undefined,
      apiKey: serverOverrides.apiKey || undefined, engineDir: build?.path ?? '', args
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.card, args, modelPath, effectivePort, port, overrideOn, serverOverrides.host, serverOverrides.apiKey, build?.path])

  const renderRow = (cmd: CommandParam) => {
    const raw = args[cmd.arg]
    const val = raw ?? cmd.default ?? ''
    return (
      <div key={cmd.arg} className="cmd-row">
        <div className="cmd-label-group">
          <div className="cmd-label tooltip-wrap">
            {cmd.label}
            <span className="tooltip">{cmd.description}</span>
          </div>
          <div className="cmd-arg">{cmd.arg}</div>
        </div>
        <div className="cmd-input-group">
          {cmd.type === 'boolean' && !cmd.offArg && (
            <div className="toggle-wrap">
              <label className="toggle" style={disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}}>
                <input type="checkbox" checked={raw === undefined ? !!cmd.default : !!raw} onChange={e => update(cmd, cmd.arg, e.target.checked)} disabled={disabled} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          )}
          {cmd.type === 'boolean' && !!cmd.offArg && (
            <SelectMenu
              variant="compact" style={{ width: '100%' }} disabled={disabled}
              value={raw === true ? 'on' : raw === false ? 'off' : ''}
              onChange={v => update(cmd, cmd.arg, v === 'on' ? true : v === 'off' ? false : null)}
              options={[{ value: '', label: 'Engine default' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
            />
          )}
          {cmd.type === 'number' && (
            <input
              type="number" className="cmd-input" value={val} placeholder={cmd.placeholder}
              min={cmd.min} max={cmd.max} step="any" disabled={disabled}
              onChange={e => update(cmd, cmd.arg, e.target.value === '' ? null : Number(e.target.value))}
            />
          )}
          {(cmd.type === 'string' || cmd.type === 'text') && (
            <input
              type="text" className="cmd-input" style={{ flex: 1, minWidth: 0 }} value={val}
              placeholder={cmd.placeholder} disabled={disabled}
              onChange={e => update(cmd, cmd.arg, e.target.value)}
            />
          )}
          {cmd.type === 'select' && (
            <SelectMenu
              variant="compact" style={{ width: '100%' }} value={String(val)}
              placeholder={cmd.emptyLabel || 'Engine default'} disabled={disabled}
              onChange={v => update(cmd, cmd.arg, v)}
              options={[
                ...(!cmd.requireValue ? [{ value: '', label: cmd.emptyLabel || 'Engine default' }] : []),
                ...(cmd.options ?? []).map(opt => ({ value: opt, label: cmd.optionLabels?.[opt] ?? opt })),
                ...(val !== '' && cmd.options && !cmd.options.includes(String(val)) ? [{ value: String(val), label: String(val) }] : [])
              ]}
            />
          )}
        </div>
      </div>
    )
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

  const visibleCategories = (schema?.categories || [])
    .map(cat => ({ ...cat, commands: cat.commands.filter(c => !SERVER_ARGS.includes(c.arg)) }))
    .filter(cat => cat.commands.length > 0)
  const layoutSections: LayoutSection<CommandParam>[] = [
    { key: 'card-server', title: 'Server', rows: [], blocks: [{ id: 'server', title: 'Server', node: serverBlock }], hideTitle: true },
    ...visibleCategories.map(cat => ({ key: cat.name, title: cat.name, icon: CATEGORY_ICONS[cat.icon] ?? CATEGORY_ICONS.Sliders, rows: cat.commands, blocks: [] }))
  ]

  const header = disabled && card?.status === 'running' ? (
    <div className="cpu-info-banner">
      <Lock size={13} style={{ flexShrink: 0, opacity: 0.7 }} />
      Parameters are locked while the model is running. Stop it first to make changes.
    </div>
  ) : null

  const launcher = def.card ? cardLauncherFile(def.card, /win/i.test(navigator.platform) ? 'win32' : 'linux') : null
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
          {def.label} is not installed. Put the engine in the "{def.card?.engine.folder}" folder inside the engines folder (Settings &gt; Engine Cards &gt; Open engine folder).
        </div>
      )}
      <LayoutSections engine={engine} sections={layoutSections} editing={layoutEditing} hiddenRows={new Set<string>()} renderRow={renderRow} />
      {preview.error && <div className="cpu-info-banner" style={{ color: 'var(--warning)' }}>{preview.error}</div>}
      {preview.tokens.length > 0 && <CommandPreview program={launcher ?? 'launcher'} tokens={preview.tokens} />}
    </div>
  )
}

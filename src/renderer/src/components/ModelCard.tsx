import React, { useState, useEffect, useRef, useMemo } from 'react'
import { useStore } from '../store/useStore'
import { Play, Square, Settings, ChevronDown, MoreVertical, Copy, Trash, Download, Globe, Server, AlertCircle, Gauge, Loader2 } from 'lucide-react'
import type { CardState } from '../../../shared/types'
import CmdParamsEditor from './CmdParamsEditor'
interface Props { card: CardState }
export default function ModelCard({ card }: Props) {
  const { toggleCardExpanded, updateCard, setCardStatus, removeCard, backends, activeBackend, commandsSchema, setShowCreateModal, models, modelDefaults, ggufMetadata } = useStore()

  // Compute the EFFECTIVE context that will be passed to
  // llama.cpp on the next run. Precedence:
  //   1. Per-preset "Ignore Context Length Override" (__ignoreCtxOverride) ON
  //      → use the preset's own --ctx-size (or AutoFill-computed value), ignoring
  //      the global Minimum AutoFit override from Settings.
  //   2. Global "Minimum Context Length Override" (Model Defaults → autoFitEnabled)
  //      ON → acts as a MINIMUM (floor): use max(preset --ctx-size, override).
  //      If the preset's ctx is higher, it's respected. If lower, the minimum wins.
  //   3. OFF → use the preset's own --ctx-size value (if set and > 0).
  //   4. Otherwise fall back to the model's native context_length from the
  //      GGUF metadata, then 32768.
  const ignoreCtxOverride = card.template.args?.['__ignoreCtxOverride'] === true
  const autoCtxFill = (card.template.args?.['__autoCtxFill'] as 'off' | 'auto' | 'maximum') || 'off'
  const effectiveCtx = useMemo(() => {
    const presetCtx = card.template.args?.['--ctx-size']
    const presetVal = presetCtx !== undefined && presetCtx !== '' && presetCtx !== null ? Number(presetCtx) : 0
    const meta = ggufMetadata[card.template.modelPath || '']
    const native = meta?.contextLength && meta.contextLength > 0 ? meta.contextLength : 0
    // Base value: preset ctx, else native, else 32768.
    let base = presetVal > 0 ? presetVal : (native > 0 ? native : 32768)
    // Global override acts as a MINIMUM (floor), not a strict override.
    // When the override is enabled and not ignored, ensure ctx >= autoFitContextLength.
    if (!ignoreCtxOverride && modelDefaults?.autoFitEnabled) {
      // Was `Math.max(2048, ... || 32768)` — a hard 2048 floor plus a
      // `||` fallback that treats 0 as falsy. Both defeated the point of
      // allowing 0 ("no minimum, defer to the template's/model's own
      // context") — 0 would get silently promoted to 32768 by the `||`, and
      // even a genuinely-set low value could never go below 2048. Use isNaN
      // for the fallback and drop the hard floor entirely: 0 now means
      // exactly what it should, no minimum at all (Math.max(base, 0) is a
      // no-op, leaving `base` as whatever the template/model already gives).
      const overrideVal = Number(modelDefaults.autoFitContextLength)
      const minCtx = Math.max(0, isNaN(overrideVal) ? 32768 : overrideVal)
      base = Math.max(base, minCtx)
    }
    return base
  }, [modelDefaults, card.template.args, card.template.modelPath, ggufMetadata, ignoreCtxOverride])
  // "from override" = the value comes from the global override (blue badge).
  // When the per-preset Ignore-Override is ON, the badge is neutral (preset).
  const ctxFromOverride = !ignoreCtxOverride && !!modelDefaults?.autoFitEnabled
  // When both Ignore-Override + AutoFill (Maximum) are ON, the
  // hint changes to "*Auto/Max Context Fill".
  const bothAutoFillOn = ignoreCtxOverride && autoCtxFill !== 'off'

  // Overrides tab → "Parallel Inference" block. Mirrors the same
  // "global override wins" shape as the AutoFit context override above, but
  // --parallel is a hard override (not a floor) since there's no meaningful
  // "minimum parallel sequences" concept — either the override applies, or
  // the template's own value is used untouched.
  //
  // "Unified/Separate" replaces the old MoE-only scoping
  // toggle — Unified applies ONE value to both Dense and MoE; Separate lets
  // Dense and MoE have their own independent override values.
  const meta = ggufMetadata[card.template.modelPath || '']
  const isMoeModel = !!meta?.isMoe || (meta?.expertCount || 0) > 0
  const parallelOverrideActive = !!modelDefaults?.parallelOverrideEnabled
  const effectiveParallel = parallelOverrideActive
    ? (modelDefaults.parallelInferenceMode === 'separate'
        ? Math.max(1, Number(isMoeModel ? modelDefaults.parallelOverrideValueMoe : modelDefaults.parallelOverrideValueDense) || 4)
        : Math.max(1, Number(modelDefaults.parallelOverrideValue) || 4))
    : null  // null = don't touch, use whatever's in the template's own args
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const isRunning = card.status === 'running'
  const isStopping = card.status === 'stopping'
  const isExpanded = card.expanded
  const launchMode = card.template.launchMode || 'chat'
  const modelExists = !card.template.modelPath || models.some(g => g.models.some(m => m.path === card.template.modelPath))
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])
  async function handleRunToggle() {
    if (isRunning) {
      // Enter 'stopping' state: disables the Start button + shows a spinner while
      // the main process kills the tree and waits for the port to be released.
      // This is what makes rapid Stop→Start reliable (no more "port in use").
      setCardStatus(card.template.id, 'stopping')
      const res = await window.api.stopModel(card.template.id)
      if (res.success) setCardStatus(card.template.id, 'idle')
      else { setCardStatus(card.template.id, 'running'); alert(`Failed to stop: ${res.error}`) }
      return
    }
    let targetBackend = backends.find(b => b.name === card.template.backendVersion || b.version === card.template.backendVersion || b.id === card.template.backendVersion)
    if (!targetBackend && activeBackend) targetBackend = activeBackend
    if (!targetBackend || !targetBackend.exe) {
      alert('Backend not found or has no executable.')
      return
    }
    const args: string[] = []
    const tArgs = card.template.args
    if (card.template.modelPath) args.push('-m', card.template.modelPath)
    // Helper to check if a key is an internal UI flag (not a real CLI arg).
    const isInternal = (k: string) => k.startsWith('__')
    if (commandsSchema) {
      const knownArgs = new Set<string>()
      for (const cat of commandsSchema.categories) {
        for (const cmd of cat.commands) {
          knownArgs.add(cmd.arg)
          const val = tArgs[cmd.arg]
          if (val !== undefined && val !== null && val !== '') {
            if (cmd.type === 'boolean') { if (val === true) args.push(cmd.arg) }
            else args.push(cmd.arg, String(val))
          }
        }
      }
      // Safety net: a key can exist in a template's saved `args` without (yet)
      // existing in the loaded schema — e.g. a per-backend commands.json that
      // predates a newly-added flag, before the healing migration in
      // get-commands has had a chance to run. Rather than silently dropping
      // it from the actual launch command (which is how --kv-unified went
      // missing from real runs while still showing correctly in the command
      // preview, which is built straight from `args` rather than the schema),
      // fall back to passing any unrecognized, non-internal key straight
      // through.
      for (const [k, v] of Object.entries(tArgs)) {
        if (isInternal(k) || knownArgs.has(k)) continue
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    } else {
      for (const [k, v] of Object.entries(tArgs)) {
        if (isInternal(k)) continue  // skip __-prefixed internal flags
        if (v === true) args.push(k)
        else if (v !== false && v !== null && v !== '') args.push(k, String(v))
      }
    }
    if (!args.includes('--port') && card.template.serverPort) {
      args.push('--port', String(card.template.serverPort))
    }
    // Determine how --ctx-size / --fit are passed.
    // AutoFill "Auto" (dense OR MoE): defer to llama-server's --fit — do NOT
    //   pass --ctx-size at all, so llama-server decides context freely.
    //   Note: --fit is a SELECT arg (options on/off), so it must be passed as
    //   "--fit on" (a bare "--fit" flag crashes llama-server → server closes
    //   instantly).
    // AutoFill "Maximum": force --ctx-size to the computed max-fitting context.
    // Otherwise: force --ctx-size to the effective context.
    const autoFitMode = ignoreCtxOverride && autoCtxFill  // 'off' | 'auto' | 'maximum'
    const isAutoFitAuto = autoFitMode === 'auto'
    const setCtxArg = (val: number) => {
      const idx = args.indexOf('--ctx-size')
      if (idx !== -1 && idx + 1 < args.length) { args[idx + 1] = String(val); return }
      const shortIdx = args.indexOf('-c')
      if (shortIdx !== -1 && shortIdx + 1 < args.length) { args[shortIdx + 1] = String(val); return }
      args.push('--ctx-size', String(val))
    }
    const removeCtxArg = () => {
      let idx = args.indexOf('--ctx-size')
      while (idx !== -1) { args.splice(idx, idx + 1 < args.length ? 2 : 1); idx = args.indexOf('--ctx-size') }
      let sIdx = args.indexOf('-c')
      while (sIdx !== -1) { args.splice(sIdx, sIdx + 1 < args.length ? 2 : 1); sIdx = args.indexOf('-c') }
    }
    const setFitArg = (val: string) => {
      const idx = args.indexOf('--fit')
      if (idx !== -1 && idx + 1 < args.length) { args[idx + 1] = val; return }
      const shortIdx = args.indexOf('-fit')
      if (shortIdx !== -1 && shortIdx + 1 < args.length) { args[shortIdx + 1] = val; return }
      args.push('--fit', val)
    }
    if (isAutoFitAuto) {
      // Auto: defer to llama-server --fit (handles offloading + context).
      removeCtxArg()
      setFitArg('on')
    } else {
      setCtxArg(effectiveCtx)
    }
    // Parallel Inference override — hard-overrides --parallel (not a
    // floor like the context override; there's no "minimum parallel
    // sequences" that makes sense), scoped to MoE-only unless that scoping
    // is turned off in Overrides.
    if (effectiveParallel !== null) {
      const idx = args.indexOf('--parallel')
      if (idx !== -1 && idx + 1 < args.length) args[idx + 1] = String(effectiveParallel)
      else {
        const shortIdx = args.indexOf('-np')
        if (shortIdx !== -1 && shortIdx + 1 < args.length) args[shortIdx + 1] = String(effectiveParallel)
        else args.push('--parallel', String(effectiveParallel))
      }
    }
    // If not set, llama-server uses the model's native context length (ctx=0).
    if (launchMode === 'api' && !args.includes('--no-webui')) {
      args.push('--no-webui')
    }
    const openBrowser = launchMode === 'chat'
    const res = await window.api.runModel({
      id: card.template.id,
      name: card.template.name,
      backendPath: targetBackend.path,
      exe: targetBackend.exe,
      args,
      openBrowser,
      port: card.template.serverPort || 8080
    })
    if (res.success) setCardStatus(card.template.id, 'running', res.pid, res.port)
    else { alert(`Failed to run: ${res.error}`); setCardStatus(card.template.id, 'error') }
  }
  async function handleDelete() {
    if (isRunning) { alert('Please stop the model before deleting.'); return }
    if (confirm('Delete this template?')) {
      await window.api.deleteTemplate(card.template.id)
      removeCard(card.template.id)
    }
  }
  async function handleExport() { await window.api.exportTemplate(card.template); setShowMenu(false) }
  function handleEdit() { setShowCreateModal(true, card.template); setShowMenu(false) }
  function handleDuplicate() {
    const t = { ...card.template, id: Date.now().toString(), name: `${card.template.name} (Copy)` }
    window.api.saveTemplate(t).then(res => { if (res.success) useStore.getState().addCard(t) })
    setShowMenu(false)
  }
  function setLaunchMode(mode: 'chat' | 'api') {
    updateCard(card.template.id, { launchMode: mode })
    window.api.saveTemplate({ ...card.template, launchMode: mode })
  }
  return (
    <div className={`model-card ${isRunning ? 'running' : ''}`} style={{ overflow: 'visible' }}>
      <div className="card-header">
        <div className="card-icon">
          {isRunning ? (
            <div className="spin"><Settings size={20} className="text-success" /></div>
          ) : isStopping ? (
            <div className="spin"><Settings size={20} className="text-warning" /></div>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          )}
        </div>
        <div className="card-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <h3 className="card-name" title={card.template.name}>{card.template.name}</h3>
            {/* Feature (context): badge showing the context amount that will be
                (or is being) used by llama.cpp. When the Minimum Context Length
                Override is ON (and the per-preset "Ignore" is OFF), the badge is
                blue and matches the Model Defaults value; otherwise it reflects
                the preset's --ctx-size. Always visible so the user can verify
                the value before/while running. */}
            <span
              className={`ctx-badge ${ctxFromOverride ? 'ctx-badge-override' : ''} ${isRunning ? 'ctx-badge-live' : ''}`}
              title={
                ctxFromOverride
                  ? `Context: ${effectiveCtx.toLocaleString()} tokens — from Minimum Context Length Override (Model Defaults). Passed to llama.cpp, /props and the chat window.`
                  : `Context: ${effectiveCtx.toLocaleString()} tokens — from this preset's --ctx-size. Passed to llama.cpp, /props and the chat window.`
              }
            >
              <Gauge size={11} />
              ctx {effectiveCtx.toLocaleString()}
            </span>
            {/* Task 2.1/2.2: yellow hint when Ignore Context Length Override is ON.
                When AutoFill is also ON, the hint shows the chosen mode
                ("Auto Context Fill" or "Max Context Fill") with a two-row tooltip. */}
            {bothAutoFillOn ? (
              <span
                className="ctx-override-hint"
                title={`Ignore Context Length Override in preset settings is turned on\nUse Automatic Context Fill is set to ${autoCtxFill === 'maximum' ? 'Maximum available' : 'Auto'}`}
              >
                *{autoCtxFill === 'maximum' ? 'Max' : 'Auto'} Context Fill
              </span>
            ) : ignoreCtxOverride ? (
              <span
                className="ctx-override-hint"
                title="Ignore Context Length Override in preset settings is turned on"
              >
                *Override is ignored
              </span>
            ) : null}
          </div>
          <p className="card-desc" title={card.template.description}>{card.template.description || 'No description'}</p>
        </div>
        <div className="card-menu-btn" ref={menuRef} style={{ position: 'relative', zIndex: 10 }}>
          <button className="btn btn-ghost btn-icon" onClick={() => setShowMenu(!showMenu)}>
            <MoreVertical size={16} />
          </button>
          {showMenu && (
            <div className="dropdown-menu" style={{ position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 500 }}>
              <button className="dropdown-item" onClick={handleEdit}><Settings size={14} /> Edit Template</button>
              <button className="dropdown-item" onClick={handleDuplicate}><Copy size={14} /> Duplicate</button>
              <button className="dropdown-item" onClick={handleExport}><Download size={14} /> Export</button>
              <div className="dropdown-divider" />
              <button className="dropdown-item danger" onClick={handleDelete}><Trash size={14} /> Delete</button>
            </div>
          )}
        </div>
      </div>
      <div className="card-meta">
        <span className="card-tag" title={card.template.modelPath}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" /><polyline points="14 2 14 8 20 8" /></svg>
          {!modelExists ? <span style={{ color: 'var(--danger)' }}>Missing File</span> : (card.template.modelPath?.split(/[/\\]/).pop() || 'No model')}
        </span>
        <span className="card-tag">
          <span className={`status-dot ${isRunning ? 'running' : isStopping ? 'stopping' : 'idle'}`} />
          {isRunning ? `Port ${card.tempPort || card.template.serverPort || 8080}${useStore.getState().baseUrlOverride?.enabled ? ' (Overridden)' : ''}` : isStopping ? 'Stopping…' : 'Ready'}
        </span>
        {card.template.tags?.map(t => (
          <span key={t} className="card-tag" style={{ background: 'var(--surface-2, rgba(255,255,255,0.05))', border: '1px solid var(--border)' }}>
            #{t}
          </span>
        ))}
      </div>
      {!modelExists && card.template.modelPath && (
        <div className="hub-error" style={{ margin: '0 18px 12px', fontSize: 12 }}>
          <AlertCircle size={14} />
          <span>Model file not found at <code style={{ background: 'transparent', wordBreak: 'break-all' }}>{card.template.modelPath}</code>. Move the file back, re-download it, or edit the template.</span>
        </div>
      )}
      {}
      <div className="card-launch-mode">
        <button
          className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`}
          onClick={() => setLaunchMode('chat')}
          title="Open chat web UI when started"
          disabled={isRunning}
        >
          <Globe size={12} /> Chat UI
        </button>
        <button
          className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`}
          onClick={() => setLaunchMode('api')}
          title="Serve API only, no web UI"
          disabled={isRunning}
        >
          <Server size={12} /> API Only
        </button>
      </div>
      <div className="card-actions">
        <button
          className={`btn card-run-btn ${isRunning ? 'btn-danger' : 'btn-primary'}`}
          onClick={handleRunToggle}
          disabled={isStopping || (!isRunning && !modelExists)}
          style={isRunning && launchMode === 'chat' ? { flex: 0.5 } : {}}
          title={isStopping ? 'Stopping… waiting for the port to be released' : (!isRunning && !modelExists ? 'Cannot start: model file is missing' : '')}
        >
          {isStopping ? <><Loader2 size={14} className="spin" /> Stopping…</> : isRunning ? <><Square size={14} /> Stop</> : <><Play size={14} /> Start</>}
        </button>
        {isRunning && launchMode === 'chat' && (
          <button
            className="btn card-run-btn"
            style={{ flex: 0.5, background: 'var(--accent)', color: 'var(--accent-fg)' }}
            onClick={() => {
              // Pass the EFFECTIVE context (override-aware) so the chat window
              // badge shows the same value llama-server is actually using.
              window.api.openChatWindow(card.tempPort || card.template.serverPort || 8080, card.template.name, effectiveCtx)
            }}
            title="Open Chat Window"
          >
            <Globe size={14} /> Open Chat
          </button>
        )}
        <button
          className={`card-expand-btn ${isExpanded ? 'open' : ''}`}
          onClick={() => toggleCardExpanded(card.template.id)}
          title="Configure CLI Parameters"
        >
          <ChevronDown size={16} />
        </button>
      </div>
      <div className={`card-expanded ${isExpanded ? 'open' : ''}`}>
        <div className="expanded-inner">
          <CmdParamsEditor templateId={card.template.id} args={card.template.args} launchMode={card.template.launchMode} />
        </div>
      </div>
    </div>
  )
}

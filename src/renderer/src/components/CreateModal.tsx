import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { FolderOpen, ChevronDown, Terminal } from 'lucide-react'
import type { Template, CommandsSchema, BackendVersion, EngineValues } from '../../../shared/types'
import { ENGINES, ENGINE_IDS, engineOf, engineAcceptsModel, modelSpecificEngines, type EngineId } from '../../../shared/engines'
import { buildStrataQuickBaseline } from '../../../shared/strata'
import { backendTypeGroupLabel } from '../../../shared/backendType'
import { backendsOfEngine, globalBackendOf, resolveEngineBackend, autoEngineFor, missingEngineFor } from '../utils/engineBackends'
import CmdParamsEditor from './CmdParamsEditor'
import EngineParamsEditor from './EngineParamsEditor'
import SelectMenu from './SelectMenu'
import { buildQuickEngineBaseline, seedSamplingArgsFromPreset } from '../../../shared/presetBaselines'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { normalizeImportedArgs, parseServerCommand, parseStrataCommand } from '../../../shared/importCommand'
import { activeServerOverrides, findPortConflict } from '../utils/templatePort'
import { strataInfoFor } from '../../../shared/strata'
// Starting values of a new Template for an engine: llama.cpp gets the starred
// sampling preset plus the Quick baseline, Strata the Quick baseline of the
// few settings it shares (context, KV precision, image input).
function seedArgsFor(engine: EngineId, activeBackend: BackendVersion | null, samplingPresets: any, meta: any, hasVision: boolean): Record<string, any> {
  if (engine === 'strata') {
    return { ...buildStrataQuickBaseline({ contextLength: meta?.contextLength, hasVision }), __lastPreset: 'quick' }
  }
  const seeded: Record<string, any> = seedSamplingArgsFromPreset(samplingPresets)
  Object.assign(seeded, buildQuickEngineBaseline({
    cpuInfo: useStore.getState().cpuInfo,
    backendKey: activeBackend?.backendKey,
    backendInfo: activeBackend,
    cpuThreadsOverridePercent: useStore.getState().modelDefaults.cpuThreadsOverrideEnabled
      ? useStore.getState().modelDefaults.cpuThreadsOverridePercent
      : null
  }))
  // Mark this as Quick explicitly, matching handleQuickPreset's own marker --
  // see derivedPresetMode's comment in CmdParamsEditor.tsx.
  seeded['__lastPreset'] = 'quick'
  return seeded
}

const STRATA_VERDICT_TEXT: Record<string, string> = {
  known: 'A file Strata installs',
  layout: 'Same layout as a Strata file (a fine-tune, not tested)',
  untested: 'Not a file Strata installs; untested',
  unverified: 'Not checked ahead: the engine checks this file when it starts',
  no: 'Strata cannot run this file'
}

export default function CreateModal() {
  const { setShowCreateModal, editingTemplate, backends, activeBackend, addCard, updateCard, models, prefillModelPath, setPrefillModelPath, cards, baseUrlOverride, samplingPresets, ggufMetadata, engineGlobals } = useStore()
  const overlayClose = useOverlayClose(() => setShowCreateModal(false))
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [backendVersion, setBackendVersion] = useState('')
  const [backendKey, setBackendKey] = useState('')
  const [backendType, setBackendType] = useState<string | null>(null)
  // The engine is picked once, when the form opens for a model: the first
  // model-specific engine that is installed and accepts it, else llama.cpp.
  // Later model changes never switch it (a hint offers the switch instead).
  const [engine, setEngine] = useState<EngineId>(() =>
    editingTemplate ? engineOf(editingTemplate) : autoEngineFor(prefillModelPath ? useStore.getState().ggufMetadata[prefillModelPath] : undefined, backends))
  // Values of engines this Template was switched away from, restored when
  // one is picked again.
  const [parked, setParked] = useState<Partial<Record<EngineId, EngineValues>>>(() => ({ ...(editingTemplate?.engineValues || {}) }))
  const [modelPath, setModelPath] = useState('')
  const [serverPort, setServerPort] = useState(8080)
  // Anchor DOM node for CmdParamsEditor's header
  // portal (Settings/Parameters toggles + CPU/model/Free-VRAM banners) — kept
  // in state (not a plain ref) so the portal target is available on the very
  // first render that has it, triggering the re-render createPortal needs.
  const [headerAnchor, setHeaderAnchor] = useState<HTMLDivElement | null>(null)
  // NEW templates are seeded with the starred
  // preset's sampling values (temperature/top-k/etc.) so the user doesn't have
  // to re-select a preset each time. This runs ONCE on mount for a new
  // template; existing templates keep their own args untouched.
  const [args, setArgs] = useState<Record<string, any>>(() => {
    if (editingTemplate) return { ...(editingTemplate.args || {}) }
    // New template: apply the starred sampling preset AND the Quick engine
    // baseline, both synchronously, in this lazy initializer. A useState
    // initializer runs exactly once, synchronously, on the first render —
    // no effect, no mount-order dependency, no race with CmdParamsEditor
    // possibly not being mounted yet. buildQuickEngineBaseline is the same
    // pure function the Quick button uses, so this can never drift from
    // what clicking Quick manually would produce.
    const startEngine: EngineId = autoEngineFor(prefillModelPath ? useStore.getState().ggufMetadata[prefillModelPath] : undefined, backends)
    const startMeta = prefillModelPath ? useStore.getState().ggufMetadata[prefillModelPath] : undefined
    return seedArgsFor(startEngine, activeBackend, samplingPresets, startMeta, false)
  })
  const [tagsStr, setTagsStr] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importCmd, setImportCmd] = useState('')
  // What the last import did that the form does not show by itself.
  const [importNote, setImportNote] = useState('')
  // Effects fire AFTER every
  // render, regardless of dependency array contents — dependencies only decide
  // whether to SKIP a re-run, not whether the very first run happens. So the
  // seeding effect below always ran once on mount even after removing `cards`
  // from its deps. React also fires CHILD effects before PARENT effects on
  // mount — so CmdParamsEditor's own mount effect (which auto-applies the
  // Quick preset baseline into `args` via onChange -> setArgs) fired FIRST,
  // and THEN this parent effect's unconditional `setArgs(seeded)` fired
  // SECOND and silently clobbered it back to bare sampling-only args. The
  // lazy useState(() => ...) initializer for `args` above already seeds it
  // identically for a brand-new template, so this ref lets the effect below
  // skip its own redundant (and destructive) first run entirely, while still
  // reseeding correctly if it legitimately re-runs later (e.g. editingTemplate
  // actually changes while the modal stays mounted).
  const seedEffectRanRef = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowCreateModal(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setShowCreateModal])
  useEffect(() => {
    const isFirstRun = !seedEffectRanRef.current
    seedEffectRanRef.current = true
    if (editingTemplate) {
      setName(editingTemplate.name)
      setDescription(editingTemplate.description || '')
      setBackendVersion(editingTemplate.backendVersion || '')
      setBackendKey(editingTemplate.backendKey || '')
      setBackendType(editingTemplate.backendType ?? null)
      setEngine(engineOf(editingTemplate))
      setParked({ ...(editingTemplate.engineValues || {}) })
      setModelPath(editingTemplate.modelPath || '')
      setServerPort(editingTemplate.serverPort || 8080)
      setArgs(editingTemplate.args || {})
      setTagsStr(editingTemplate.tags?.join(', ') || '')
    } else {
      // A new template should default to "Default (Active)" (no pinned
      // backend, i.e. backendKey/backendVersion/backendType left empty) so
      // it always follows whatever the sidebar's active backend is, rather
      // than freezing in whatever happened to be active at creation time.
      // Skip the redundant (and destructive) reseed on the very
      // first run — see seedEffectRanRef comment above. The lazy `args`
      // initializer already seeded sampling values identically, and calling
      // setArgs here again on mount is what was clobbering CmdParamsEditor's
      // Quick-preset auto-apply every single time. Only reseed on LATER runs
      // of this effect (a real transition back to "new template" while the
      // modal stays open, if that ever happens).
      if (!isFirstRun) {
        // Stay consistent with the lazy initializer above — a real reseed
        // should also reapply the Quick engine baseline, not just sampling.
        setArgs(seedArgsFor(engine, activeBackend, samplingPresets, undefined, false))
        setTagsStr('')
      }
      if (prefillModelPath) {
        setModelPath(prefillModelPath)
        setPrefillModelPath(null)
      }
      const usedPorts = new Set(cards.map(c => c.template.serverPort))
      let port = 8080
      while (usedPorts.has(port)) port++
      setServerPort(port)
    }
    // This effect used to depend on `cards`
    // (only needed a few lines up to pick a free default port), so it re-ran —
    // and re-ran its ENTIRE new-template branch, including `setArgs(seeded)` —
    // every single time ANY card's status changed ANYWHERE in the app (e.g. a
    // periodic health/status poll while this modal was still open). That
    // silently wiped out whatever Quick/FULL AUTO preset (or MTP
    // auto-detection, or manual edits) had just been applied a moment earlier
    // by CmdParamsEditor's mount effect, reverting the form back to bare
    // "Pure"/sampling-only args — which is exactly the "still have to click
    // Quick preset manually" / "MTP still isn't applied automatically" reports.
    // `cards` is intentionally NOT a dependency below; the port-picking code
    // above still reads the current `cards` closure value at the moment this
    // effect actually runs (mount, or when editingTemplate/activeBackend/
    // prefillModelPath change), it just no longer RE-runs merely because some
    // unrelated card's live status changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingTemplate, activeBackend, prefillModelPath, setPrefillModelPath])
  async function handlePickModel() {
    const file = await window.api.pickModelFile()
    if (file) setModelPath(file.path)
  }
  async function handleImportCmd() {
    if (!importCmd.trim()) return
    if (engine === 'strata') { await importStrataCmd(); return }
    const parsed = parseServerCommand(importCmd)
    // Normalize against the schema of the backend this Template will use, so
    // short flags/aliases (-ctkd, -c, ...) land under the keys the editor reads.
    let schema: CommandsSchema | null = null
    try { schema = await window.api.getCommands(backendKey || activeBackend?.backendKey || '', engine) } catch {}
    const normalized = normalizeImportedArgs(parsed.args, schema)
    if (parsed.modelPath) setModelPath(parsed.modelPath)
    if (parsed.serverPort !== null) setServerPort(parsed.serverPort)
    setArgs((prev) => ({ ...prev, ...normalized }))
    // Host and API key are edited in the Server block of the parameters.
    if (normalized['--host'] !== undefined || normalized['--api-key'] !== undefined) setShowAdvanced(true)
    setImportNote('')
    setShowImport(false)
    setImportCmd('')
  }
  async function importStrataCmd() {
    const parsed = parseStrataCommand(importCmd)
    let schema: CommandsSchema | null = null
    try { schema = await window.api.getCommands(shownBuild?.backendKey || '', engine) } catch {}
    const known = new Set((schema?.categories || []).flatMap(c => c.commands.map(x => x.arg)))
    const unlisted = Object.keys(parsed.args).filter(k => !known.has(k) && k !== '--host' && k !== '--api-key')
    if (parsed.serverPort !== null) setServerPort(parsed.serverPort)
    setArgs(prev => ({ ...prev, ...parsed.args }))
    if (parsed.args['--host'] !== undefined || parsed.args['--api-key'] !== undefined) setShowAdvanced(true)
    // Strata is given a folder; a Template names a file in it.
    const notes: string[] = []
    if (parsed.ggufDir) {
      const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase() === b.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
      const files = models.filter(g => same(g.folderPath, parsed.ggufDir)).flatMap(g => g.models)
      const variant = String(parsed.args['--model'] ?? '').toLowerCase()
      const pick = (variant && files.find(f => f.name.toLowerCase().includes(variant))) || files[0]
      if (pick) {
        if (!modelPath || !same(modelPath.replace(/[^\\/]+$/, ''), parsed.ggufDir)) setModelPath(pick.path)
      } else if (!modelPath) {
        notes.push(`Pick the model file inside ${parsed.ggufDir}: it is not in your model folders.`)
      }
    }
    if (parsed.ignored.length) notes.push(`${parsed.ignored.join(', ')} left out: they are added on every launch.`)
    if (unlisted.length) notes.push(`${unlisted.join(', ')} not in this engine's parameter list: passed on as written.`)
    setImportNote(notes.join(' '))
    setShowImport(false)
    setImportCmd('')
  }
  const portOverride = activeServerOverrides(baseUrlOverride, args['__ignoreBaseUrlOverride'] === true).port
  const portConflict = findPortConflict(cards, serverPort, editingTemplate?.id)
  const engineBuilds = backendsOfEngine(backends, engine)
  // With no pin the Template follows the engine's global selection.
  const follow = !backendKey
  const shownBuild = follow
    ? globalBackendOf(engine, backends, activeBackend, engineGlobals)
    : resolveEngineBackend(engine, { backendKey, backendType, backendVersion }, backends, activeBackend, engineGlobals)
  const repoKeys = Array.from(new Set(engineBuilds.map(b => b.backendKey)))
  const typesInRepo = Array.from(new Set(engineBuilds.filter(b => b.backendKey === shownBuild?.backendKey).map(b => b.backendType ?? '')))
  function pinTo(b: BackendVersion | undefined) {
    setBackendKey(b?.backendKey || '')
    setBackendVersion(b?.name || '')
    setBackendType(b?.backendType ?? null)
  }
  function switchEngine(next: EngineId) {
    if (next === engine) return
    const meta = modelPath ? ggufMetadata[modelPath] : undefined
    const restored = parked[next]
    setParked(p => {
      const q = { ...p, [engine]: { args, backendKey, backendVersion, backendType } as EngineValues }
      delete q[next]
      return q
    })
    setEngine(next)
    if (restored) {
      setArgs(restored.args)
      setBackendKey(restored.backendKey || '')
      setBackendVersion(restored.backendVersion || '')
      setBackendType(restored.backendType ?? null)
    } else {
      setArgs(seedArgsFor(next, activeBackend, samplingPresets, meta, false))
      pinTo(undefined)
    }
  }
  // Model-specific engines that accept the chosen model, shown as a hint.
  const modelMeta = modelPath ? ggufMetadata[modelPath] : undefined
  const suggested = modelSpecificEngines().find(e => engineAcceptsModel(e.id, modelMeta))
  const missingEngine = missingEngineFor(modelMeta, backends)
  // The verdict of the engine this Template would run on.
  const engineInfo = strataInfoFor(modelMeta, shownBuild?.backendKey)
  // Another installed Strata engine that runs this file when the one this
  // Template follows does not.
  const betterBuild = engine === 'strata' && engineInfo && engineInfo.kind !== 'known' && engineInfo.kind !== 'layout'
    ? engineBuilds.find(b => {
        const k = modelMeta?.strataEngines?.[b.backendKey ?? '']?.kind
        return b.backendKey !== shownBuild?.backendKey && (k === 'known' || k === 'layout')
      })
    : undefined
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    // No field on this form should block Save with a validation popup --
    // an empty name silently becomes "Unnamed" instead of warning the user.
    const effectiveName = name.trim() || 'Unnamed'
    const templateData: Partial<Template> = {
      name: effectiveName,
      description,
      backendVersion,
      backendKey,
      backendType,
      engine,
      engineValues: Object.keys(parked).length ? parked : undefined,
      modelPath,
      serverPort,
      args,
      tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean)
    }
    if (editingTemplate) {
      const res = await window.api.saveTemplate({ ...editingTemplate, ...templateData })
      if (res.success) {
        updateCard(editingTemplate.id, templateData)
        setShowCreateModal(false)
      }
    } else {
      const newTemplate: Omit<Template, 'id'> = {
        name: effectiveName,
        description,
        backendVersion,
        backendKey,
        backendType,
        engine,
        engineValues: Object.keys(parked).length ? parked : undefined,
        modelPath,
        serverPort,
        args,
        tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      const res = await window.api.saveTemplate(newTemplate)
      if (res.success) {
        addCard({ ...newTemplate, id: res.id } as Template)
        setShowCreateModal(false)
      }
    }
  }
  return (
    <div className="modal-overlay" {...overlayClose}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{editingTemplate ? 'Edit Template' : 'New Template'}</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="modal-body">
            <div className="collapsible-section" style={{ marginBottom: importNote ? 6 : 16 }}>
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => setShowImport(!showImport)}
              >
                <Terminal size={14} />
                <span>Import from command</span>
                <ChevronDown
                  size={14}
                  style={{ marginLeft: 'auto', transform: showImport ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
                />
              </button>
              {showImport && (
                <div className="collapsible-body">
                  <p className="form-hint" style={{ marginBottom: 8 }}>
                    {engine === 'strata'
                      ? <>Paste a Strata launch command (<code>START-HERE.bat</code>, <code>./setup.sh</code> or <code>python setup.py</code> with its flags) and the form will be filled automatically.</>
                      : <>Paste a <code>llama-server</code> command and the form will be filled automatically.</>}
                  </p>
                  <textarea
                    className="form-textarea mono"
                    rows={3}
                    value={importCmd}
                    onChange={e => setImportCmd(e.target.value)}
                    placeholder={engine === 'strata'
                      ? 'START-HERE.bat --family qwen --model IQ3_S --gguf-dir D:\\models\\qwen --port 8080 --context 65536 ...'
                      : 'llama-server -m /models/model.gguf --port 8080 --ctx-size 4096 ...'}
                    style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: 8 }}
                    onClick={handleImportCmd}
                  >
                    Parse &amp; Fill
                  </button>
                </div>
              )}
            </div>
            {importNote && <div className="form-hint" style={{ marginBottom: 16 }}>{importNote}</div>}
            <div className="form-group">
              <label className="form-label">Template Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Llama 3 8B Default (leave empty for &quot;Unnamed&quot;)"
                autoFocus
              />
            </div>
            {}
            <div className="form-group">
              <label className="form-label">Description (Optional)</label>
              <textarea
                className="form-textarea"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Short description of this configuration..."
              />
            </div>
            {}
            <div className="form-group">
              <label className="form-label">Tags (comma-separated)</label>
              <input
                type="text"
                className="form-input"
                value={tagsStr}
                onChange={e => setTagsStr(e.target.value)}
                placeholder="e.g. llama3, coding, 8b"
              />
            </div>
            {}
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Engine</label>
                <SelectMenu
                  variant="field"
                  value={engine}
                  onChange={id => switchEngine(id as EngineId)}
                  options={ENGINE_IDS.map(id => ({
                    value: id,
                    label: `${ENGINES[id].label}${ENGINES[id].kind === 'model-specific' ? ' (model-specific)' : ''}${backendsOfEngine(backends, id).length === 0 ? ' - not installed' : ''}`
                  }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Server Port</label>
                <input
                  type="number"
                  className="form-input"
                  value={serverPort}
                  onChange={e => setServerPort(Number(e.target.value))}
                  min={1024}
                  max={65535}
                />
                {portOverride !== null && (
                  <div className="form-hint" style={{ color: 'var(--warning)' }}>
                    Overridden by the global Base URL Override: runs on port {portOverride}.
                  </div>
                )}
                {portConflict && (
                  <div className="form-hint" style={{ color: 'var(--warning)' }}>
                    Port {serverPort} is already used by &ldquo;{portConflict}&rdquo;. They cannot run at the same time.
                  </div>
                )}
              </div>
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={follow} onChange={e => pinTo(e.target.checked ? undefined : shownBuild)} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{ENGINES[engine].followLabel}</span>
              </label>
              <div className="form-hint">
                {engineBuilds.length === 0
                  ? `${ENGINES[engine].label} is not installed. Install it from Settings > Engine tracker.`
                  : follow
                    ? `Uses ${shownBuild?.displayName || ENGINES[engine].label}, the engine's selection in the sidebar. Choosing a repo or backend below pins this Template to it.`
                    : 'Pinned: this Template keeps using the repo below when the global selection changes.'}
              </div>
            </div>
            {engineBuilds.length > 0 && (
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Repo</label>
                  <SelectMenu
                    variant="field"
                    value={shownBuild?.backendKey || ''}
                    onChange={key => {
                      const inRepo = engineBuilds.filter(b => b.backendKey === key)
                      pinTo(inRepo.find(b => (b.backendType ?? null) === (shownBuild?.backendType ?? null)) ?? inRepo[0])
                    }}
                    options={repoKeys.map(k => ({ value: k, label: k }))}
                  />
                </div>
                {ENGINES[engine].caps.backendSelection === 'builds' && (
                  <div className="form-group">
                    <label className="form-label">Backend</label>
                    <SelectMenu
                      variant="field"
                      disabled={typesInRepo.length < 2}
                      value={shownBuild?.backendType ?? ''}
                      onChange={t => pinTo(engineBuilds.find(b => b.backendKey === shownBuild?.backendKey && (b.backendType ?? '') === t))}
                      options={typesInRepo.map(t => ({
                        value: t,
                        label: `${backendTypeGroupLabel(t || null)}${t && backendTypeGroupLabel(t).toLowerCase() !== t.toLowerCase() ? ` (${t})` : ''}`
                      }))}
                    />
                  </div>
                )}
              </div>
            )}
            <div className="form-group mb-0">
              <label className="form-label">Model File</label>
              <div className="file-picker">
                <select
                  className="form-select mono text-sm flex-1"
                  value={modelPath}
                  onChange={e => setModelPath(e.target.value)}
                >
                  <option value="">-- Select a model --</option>
                  {models.map(g => (
                    <optgroup key={g.folderPath} label={`${g.folder}${g.external ? ' (external)' : ''}${g.mmproj ? ' [has mmproj]' : ''}`}>
                      {g.models.map(m => (
                        <option key={m.path} value={m.path}>{m.name}</option>
                      ))}
                    </optgroup>
                  ))}
                  {modelPath && !models.some(g => g.models.some(m => m.path === modelPath)) && (
                    <option value={modelPath}>{modelPath.split(/[/\\]/).pop()}</option>
                  )}
                </select>
                <button type="button" className="btn btn-secondary" onClick={handlePickModel}>
                  <FolderOpen size={16} />
                  Browse
                </button>
              </div>
              <div className="form-hint">Models are grouped by folder. mmproj files are auto-detected and shared within each folder.</div>
              {modelPath && engine === 'strata' && engineInfo && (
                <div className="form-hint" style={engineInfo.kind === 'known' || engineInfo.kind === 'layout' ? undefined : { color: 'var(--warning)' }}>
                  {shownBuild?.backendKey || 'Strata'}: {STRATA_VERDICT_TEXT[engineInfo.kind]}{engineInfo.family ? ` (${engineInfo.family} / ${engineInfo.model})` : ''}. {engineInfo.detail}
                  {betterBuild && (
                    <> {betterBuild.backendKey} can run this file.{' '}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => pinTo(betterBuild)}>Use {betterBuild.backendKey}</button>
                    </>
                  )}
                </div>
              )}
              {modelPath && engine !== 'strata' && suggested && (
                <div className="form-hint">
                  {suggested.label} can run this model ({STRATA_VERDICT_TEXT[modelMeta?.strata?.kind || 'known'].toLowerCase()}).{' '}
                  {missingEngine === suggested.id
                    ? `It is not installed: install it from Settings > Engine tracker.`
                    : <button type="button" className="btn btn-ghost btn-sm" onClick={() => switchEngine(suggested.id)}>Use {suggested.label}</button>}
                </div>
              )}
            </div>
            {/* Settings/Parameters toggle + CPU/model/Free-VRAM info render
                here (via CmdParamsEditor's header portal) so they're always
                visible without expanding "Advanced Parameters" below. */}
            <div ref={setHeaderAnchor} className="cmd-header-anchor" />
            <div className="collapsible-section" style={{ marginTop: 20 }}>
              <button
                type="button"
                className="collapsible-toggle"
                onClick={() => setShowAdvanced(!showAdvanced)}
              >
                <span>Advanced Parameters</span>
                <ChevronDown
                  size={14}
                  style={{ marginLeft: 'auto', transform: showAdvanced ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }}
                />
              </button>
              {/* CmdParamsEditor must always be mounted, even while this
                  section is collapsed — its mount-time effects ("auto-apply
                  Quick preset for a new template", MTP/speculation
                  auto-detect) only run once, when the component first
                  mounts, and need to fire as soon as the modal opens rather
                  than only after the user expands "Advanced Parameters".
                  Hidden visually via CSS when collapsed instead of being
                  unmounted. */}
              <div className="collapsible-body" style={showAdvanced ? undefined : { display: 'none' }}>
                {engine === 'llama.cpp' ? (
                  <CmdParamsEditor
                    args={args}
                    onChange={setArgs}
                    modelPathFallback={modelPath}
                    serverPortFallback={serverPort}
                    onServerPortChange={setServerPort}
                    backendKey={backendKey}
                    backendVersionName={backendVersion}
                    backendType={backendType}
                    headerPortalTarget={headerAnchor}
                  />
                ) : (
                  <EngineParamsEditor
                    engine={engine}
                    args={args}
                    onChange={setArgs}
                    modelPathFallback={modelPath}
                    serverPortFallback={serverPort}
                    onServerPortChange={setServerPort}
                    backendKey={backendKey}
                    headerPortalTarget={headerAnchor}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setShowCreateModal(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              {editingTemplate ? 'Save Changes' : 'Create Template'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

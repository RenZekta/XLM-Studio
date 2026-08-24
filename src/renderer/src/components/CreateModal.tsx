import React, { useState, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'
import { FolderOpen, ChevronDown, Terminal, Globe, Server } from 'lucide-react'
import type { Template } from '../../../shared/types'
import CmdParamsEditor from './CmdParamsEditor'
import { buildQuickEngineBaseline } from '../utils/presetBaselines'
function parseCommand(cmd: string): {
  modelPath: string
  serverPort: number
  args: Record<string, string | number | boolean>
} {
  const parts: string[] = []
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(cmd)) !== null) {
    parts.push(m[0].replace(/^['"]|['"]$/g, ''))
  }
  let modelPath = ''
  let serverPort = 8080
  const args: Record<string, string | number | boolean> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p === '-m' || p === '--model') {
      modelPath = parts[++i] || ''
    } else if (p === '--port') {
      serverPort = parseInt(parts[++i] || '8080', 10)
    } else if (p.startsWith('--') || p.startsWith('-')) {
      const next = parts[i + 1]
      if (next && !next.startsWith('-')) {
        const numVal = Number(next)
        args[p] = isNaN(numVal) ? next : numVal
        i++
      } else {
        args[p] = true
      }
    }
  }
  return { modelPath, serverPort, args }
}
export default function CreateModal() {
  const { setShowCreateModal, editingTemplate, backends, activeBackend, addCard, updateCard, models, prefillModelPath, setPrefillModelPath, cards, baseUrlOverride, samplingPresets } = useStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [backendVersion, setBackendVersion] = useState('')
  const [modelPath, setModelPath] = useState('')
  const [serverPort, setServerPort] = useState(8080)
  // Bug fix (Task 1 follow-up): anchor DOM node for CmdParamsEditor's header
  // portal (Settings/Parameters toggles + CPU/model/Free-VRAM banners) — kept
  // in state (not a plain ref) so the portal target is available on the very
  // first render that has it, triggering the re-render createPortal needs.
  const [headerAnchor, setHeaderAnchor] = useState<HTMLDivElement | null>(null)
  // Feature (sampling presets): NEW templates are seeded with the starred
  // preset's sampling values (temperature/top-k/etc.) so the user doesn't have
  // to re-select a preset each time. This runs ONCE on mount for a new
  // template; existing templates keep their own args untouched.
  const [args, setArgs] = useState<Record<string, any>>(() => {
    if (editingTemplate) return { ...(editingTemplate.args || {}) }
    // New template: apply the starred sampling preset AND the Quick engine
    // baseline, both synchronously, in this lazy initializer.
    //
    // Item 1.1 architectural fix: this used to only seed sampling values here,
    // relying on a useEffect inside CmdParamsEditor (which might not even be
    // mounted yet — see the collapsible-section history below) to apply the
    // Quick engine baseline (threads/batch-size/flash-attn/etc.) afterward.
    // That effect-based approach kept failing in new ways across many fix
    // attempts: the component not mounting unless "Advanced Parameters" was
    // expanded, then (after fixing that) a parent effect's redundant
    // setArgs(seeded) clobbering the child's work due to effect ordering.
    // A lazy useState initializer runs exactly once, synchronously, during
    // the very first render — there is no effect, no ordering, no mount
    // timing, and therefore no possible race: `args` is CORRECT from the very
    // first frame, full stop. buildQuickEngineBaseline is the same pure
    // function CmdParamsEditor's Quick button uses, so this can never drift
    // from what clicking "Quick" manually would produce.
    const starred = samplingPresets.find(p => p.isStarred) || samplingPresets[0]
    const seeded: Record<string, any> = {}
    if (starred?.values) {
      if (starred.values.temperature !== undefined) seeded['--temperature'] = starred.values.temperature
      if (starred.values.topK !== undefined) seeded['--top-k'] = starred.values.topK
      if (starred.values.topP !== undefined) seeded['--top-p'] = starred.values.topP
      if (starred.values.minP !== undefined) seeded['--min-p'] = starred.values.minP
      if (starred.values.repeatPenalty !== undefined) seeded['--repeat-penalty'] = starred.values.repeatPenalty
      if (starred.values.presencePenalty !== undefined) seeded['--presence-penalty'] = starred.values.presencePenalty
    }
    Object.assign(seeded, buildQuickEngineBaseline({
      cpuInfo: useStore.getState().cpuInfo,
      backendKey: activeBackend?.backendKey,
      cpuThreadsOverridePercent: useStore.getState().modelDefaults.cpuThreadsOverrideEnabled
        ? useStore.getState().modelDefaults.cpuThreadsOverridePercent
        : null
    }))
    // Bug fix (preset toggle showing wrong mode): mark this as Quick
    // explicitly, matching handleQuickPreset's own marker — see
    // derivedPresetMode's comment in CmdParamsEditor.tsx.
    seeded['__lastPreset'] = 'quick'
    return seeded
  })
  const [tagsStr, setTagsStr] = useState('')
  const [launchMode, setLaunchMode] = useState<'chat' | 'api'>('chat')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importCmd, setImportCmd] = useState('')
  // Bug fix (items 1/2, root cause finally isolated): effects fire AFTER every
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
      setModelPath(editingTemplate.modelPath || '')
      setServerPort(editingTemplate.serverPort || 8080)
      setArgs(editingTemplate.args || {})
      setTagsStr(editingTemplate.tags?.join(', ') || '')
      setLaunchMode(editingTemplate.launchMode || 'chat')
    } else {
      if (activeBackend) setBackendVersion(activeBackend.name)
      // Bug fix: skip the redundant (and destructive) reseed on the very
      // first run — see seedEffectRanRef comment above. The lazy `args`
      // initializer already seeded sampling values identically, and calling
      // setArgs here again on mount is what was clobbering CmdParamsEditor's
      // Quick-preset auto-apply every single time. Only reseed on LATER runs
      // of this effect (a real transition back to "new template" while the
      // modal stays open, if that ever happens).
      if (!isFirstRun) {
        const starred = samplingPresets.find(p => p.isStarred) || samplingPresets[0]
        const seeded: Record<string, any> = {}
        if (starred?.values) {
          if (starred.values.temperature !== undefined) seeded['--temperature'] = starred.values.temperature
          if (starred.values.topK !== undefined) seeded['--top-k'] = starred.values.topK
          if (starred.values.topP !== undefined) seeded['--top-p'] = starred.values.topP
          if (starred.values.minP !== undefined) seeded['--min-p'] = starred.values.minP
          if (starred.values.repeatPenalty !== undefined) seeded['--repeat-penalty'] = starred.values.repeatPenalty
          if (starred.values.presencePenalty !== undefined) seeded['--presence-penalty'] = starred.values.presencePenalty
        }
        // Stay consistent with the lazy initializer above — a real reseed
        // should also reapply the Quick engine baseline, not just sampling.
        Object.assign(seeded, buildQuickEngineBaseline({
          cpuInfo: useStore.getState().cpuInfo,
          backendKey: activeBackend?.backendKey,
          cpuThreadsOverridePercent: useStore.getState().modelDefaults.cpuThreadsOverrideEnabled
            ? useStore.getState().modelDefaults.cpuThreadsOverridePercent
            : null
        }))
        seeded['__lastPreset'] = 'quick'
        setArgs(seeded)
        setTagsStr('')
        setLaunchMode('chat')
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
    // Bug fix (Tasks 1/2 regression): this effect used to depend on `cards`
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
  function handleImportCmd() {
    if (!importCmd.trim()) return
    const parsed = parseCommand(importCmd)
    if (parsed.modelPath) setModelPath(parsed.modelPath)
    if (parsed.serverPort) setServerPort(parsed.serverPort)
    setArgs((prev) => ({ ...prev, ...parsed.args }))
    setShowImport(false)
    setImportCmd('')
  }
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return alert('Name is required')
    const templateData: Partial<Template> = {
      name,
      description,
      backendVersion,
      modelPath,
      serverPort,
      args,
      tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean),
      launchMode
    }
    if (editingTemplate) {
      const res = await window.api.saveTemplate({ ...editingTemplate, ...templateData })
      if (res.success) {
        updateCard(editingTemplate.id, templateData)
        setShowCreateModal(false)
      }
    } else {
      const newTemplate: Omit<Template, 'id'> = {
        name,
        description,
        backendVersion,
        modelPath,
        serverPort,
        args,
        tags: tagsStr.split(',').map(t => t.trim()).filter(Boolean),
        launchMode,
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
    <div className="modal-overlay" onClick={() => setShowCreateModal(false)}>
      <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{editingTemplate ? 'Edit Template' : 'New Template'}</h2>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="modal-body">
            {}
            <div className="collapsible-section" style={{ marginBottom: 16 }}>
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
                    Paste a <code>llama-server</code> command and the form will be filled automatically.
                  </p>
                  <textarea
                    className="form-textarea mono"
                    rows={3}
                    value={importCmd}
                    onChange={e => setImportCmd(e.target.value)}
                    placeholder="llama-server -m /models/model.gguf --port 8080 --ctx-size 4096 ..."
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
            {}
            <div className="form-group">
              <label className="form-label">Template Name</label>
              <input
                type="text"
                className="form-input"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Llama 3 8B Default"
                required
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
                <label className="form-label">Backend Version</label>
                <select
                  className="form-select"
                  value={backendVersion}
                  onChange={e => setBackendVersion(e.target.value)}
                >
                  <option value="">Default (Active)</option>
                  {backends.map(b => (
                    <option key={b.id} value={b.name}>{b.displayName}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">
                  Server Port {baseUrlOverride?.enabled && <span style={{ color: 'var(--warning)', fontSize: 12, fontWeight: 600 }}>(Overridden — using port {baseUrlOverride.port})</span>}</label>
                <input
                  type="number"
                  className="form-input"
                  value={serverPort}
                  onChange={e => setServerPort(Number(e.target.value))}
                  min={1024}
                  max={65535}
                />
                {baseUrlOverride?.enabled && (
                  <div className="form-hint" style={{ color: 'var(--warning)' }}>
                    Base URL Override is enabled. The server will use port {baseUrlOverride.port} instead of {serverPort}. You can still change this port — it will be used when override is disabled. Disable override in Settings to use this port.
                  </div>
                )}
                {(() => {
                  const conflict = cards.find(c =>
                    c.template.id !== editingTemplate?.id &&
                    c.template.serverPort === serverPort
                  )
                  return conflict ? (
                    <div className="form-hint" style={{ color: 'var(--warning)' }}>
                      Port {serverPort} is already used by &ldquo;{conflict.template.name}&rdquo;. They cannot run at the same time.
                    </div>
                  ) : null
                })()}
              </div>
            </div>
            {}
            <div className="form-group">
              <label className="form-label">Launch Mode</label>
              <div className="launch-mode-row">
                <button type="button" className={`launch-mode-btn ${launchMode === 'chat' ? 'active' : ''}`} onClick={() => setLaunchMode('chat')}>
                  <Globe size={13} /> Chat UI
                </button>
                <button type="button" className={`launch-mode-btn ${launchMode === 'api' ? 'active' : ''}`} onClick={() => setLaunchMode('api')}>
                  <Server size={13} /> API Only
                </button>
              </div>
              <div className="form-hint">Chat UI opens the browser. API Only serves at the port without opening the web UI.</div>
            </div>
            {}
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
            </div>
            {}
            {/* Feature 15: Preset toggle is now inside CmdParamsEditor (no duplication). */}
            {/* Bug fix: Settings/Parameters toggles + CPU/model/Free-VRAM info now
                render here (via CmdParamsEditor's header portal) so they're always
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
              {/* Bug fix (Task 1): CmdParamsEditor must always be mounted, even while
                  this section is collapsed. CmdParamsEditor's own "auto-apply Quick
                  preset on mount for a new template" effect (and the MTP/speculation
                  auto-detect effect) only run once, when the component first mounts.
                  Previously this div — and therefore CmdParamsEditor — only rendered
                  after the user manually expanded "Advanced Parameters", so on submit
                  without ever opening this section the Quick baseline (and detected
                  MTP speculation type) was never applied to the template's args. We
                  now always mount it and just hide it visually via CSS when collapsed,
                  so its mount-effects fire immediately when the modal opens. */}
              <div className="collapsible-body" style={showAdvanced ? undefined : { display: 'none' }}>
                <CmdParamsEditor
                  args={args}
                  onChange={setArgs}
                  modelPathFallback={modelPath}
                  serverPortFallback={serverPort}
                  headerPortalTarget={headerAnchor}
                  launchMode={launchMode}
                />
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

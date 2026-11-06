import React, { useEffect, useRef, useState } from 'react'
import { Hammer, Loader2, RefreshCw, Trash, AlertCircle, Terminal, ChevronDown, ChevronUp } from 'lucide-react'
import SelectMenu from './SelectMenu'
import { useStore } from '../store/useStore'
import { ROCM_GPUS } from '../../../shared/rocm'
import { sourceBuildTypesFor, buildLogId } from '../../../shared/sourceBuild'
import type { TrackedBackend, TrackedBackendRelease } from '../../../shared/types'

type ToolsPlan = NonNullable<Awaited<ReturnType<typeof window.api.getBuildToolsPlan>>>

export function hostPlatform(): 'win32' | 'darwin' | 'linux' {
  const p = navigator.platform
  return /win/i.test(p) ? 'win32' : /mac/i.test(p) ? 'darwin' : 'linux'
}

const TYPE_KEY = 'xlm_source_build_type'
const ARGS_KEY = 'xlm_source_build_args'
const GPU_KEY = 'xlm_source_build_gpu'

function readPref(prefix: string, id: string): string | undefined {
  try { return JSON.parse(localStorage.getItem(prefix) || '{}')[id] } catch { return undefined }
}
function writePref(prefix: string, id: string, value: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(prefix) || '{}')
    all[id] = value
    localStorage.setItem(prefix, JSON.stringify(all))
  } catch {}
}

function quoteArg(a: string): string {
  return /\s/.test(a) ? `"${a}"` : a
}

const PHASE_TEXT: Record<string, string> = {
  tools: 'Installing build tools...',
  cloning: 'Cloning...',
  updating: 'Updating source...',
  configuring: 'Configuring...',
  installing: 'Installing...'
}

function phaseText(p: { phase: string; percent: number; queuePosition?: number }): string {
  if (p.phase === 'queued') return `Queued (#${p.queuePosition || 1})`
  if (p.phase === 'tools' && p.percent > 0) return `Installing build tools... ${p.percent}%`
  if (p.phase === 'building') return `Building... ${p.percent}%`
  return PHASE_TEXT[p.phase] ?? 'Working...'
}

interface Props {
  t: TrackedBackend
  release: TrackedBackendRelease
  // Build tools are updated before a build when a newer version exists.
  autoUpdateTools: boolean
  // Where the ROCm SDK comes from; the tool status depends on it.
  rocmSource: 'tarball' | 'pip'
  // Re-reads installed engines and this engine's tracker state.
  onChanged: () => Promise<void>
  onDeleteType: (type: string) => void
}

// Build from Source controls of one tracked engine. It is laid out like the
// binary download row: a menu of the builds (with what is installed of each),
// and the button that makes the selected one.
export default function SourceBuildPanel({ t, release, autoUpdateTools, rocmSource, onChanged, onDeleteType }: Props) {
  const { downloadProgress, setDownloadProgress, setView, setLogsSource } = useStore()
  const types = sourceBuildTypesFor(hostPlatform())
  const [type, setType] = useState(() => {
    const saved = readPref(TYPE_KEY, t.id)
    return types.some(x => x.id === saved) ? saved! : types[0].id
  })
  const [args, setArgs] = useState(() => readPref(ARGS_KEY, t.id) ?? '')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [plan, setPlan] = useState<ToolsPlan | null>(null)
  const [toolsBusy, setToolsBusy] = useState(false)
  const [toolsMessage, setToolsMessage] = useState('')
  // ROCm builds are made for one GPU target (and the SDK downloaded for its family).
  const [gpu, setGpu] = useState(() => readPref(GPU_KEY, t.id) ?? '')
  const gpuTarget = type === 'rocm' && gpu ? gpu : undefined
  const pickerRef = useRef<HTMLDivElement>(null)
  const builds = release.source?.builds ?? []
  const progressOf = (ty: string) => downloadProgress[`${t.id}::build:${ty}`]
  const selectedDef = types.find(x => x.id === type) ?? types[0]
  const installed = builds.find(b => b.type === type)
  const outdatedBuilds = builds.filter(b => b.outdated)
  const selected = progressOf(type)
  const otherBusy = types.filter(x => x.id !== type && progressOf(x.id))
  // A build that is queued has not logged anything yet.
  const isRunning = (ty: string) => { const p = progressOf(ty); return !!p && p.phase !== 'queued' }
  // Shows this build's output: its entry in the Logs source menu is selected.
  const openLog = (ty: string) => { setLogsSource(buildLogId(t.id, ty)); setView('logs') }
  const logButton = (ty: string) => isRunning(ty) && (
    <button className="btn btn-ghost btn-sm" style={{ padding: '0 8px' }} onClick={() => openLog(ty)} title="Show this build's output in the Logs tab">
      <Terminal size={13} /> Logs
    </button>
  )

  useEffect(() => {
    let alive = true
    window.api.getBuildToolsPlan(type, gpuTarget).then(p => { if (alive) setPlan(p) }).catch(() => {})
    return () => { alive = false }
    // Only a ROCm build depends on where the SDK comes from, so the other
    // cards do not ask again when that switch is flipped.
  }, [type, gpuTarget, type === 'rocm' ? rocmSource : '', builds.length])

  // Pre-select the GPU this machine has, the first time a ROCm build is looked at.
  useEffect(() => {
    if (type !== 'rocm' || gpu) return
    window.api.getRocmGpus().then(r => {
      const found = r.detected.find(d => d.gfx)?.gfx
      if (found) { setGpu(found); writePref(GPU_KEY, t.id, found) }
    }).catch(() => {})
  }, [type, gpu, t.id])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!pickerRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const missing = plan?.tools.filter(x => !x.present) ?? []
  const manual = missing.filter(x => !x.installable)
  // The ROCm SDK is downloaded for a GPU family, so it cannot be fetched before one is chosen.
  const needsGpu = type === 'rocm' && !gpu
  const needsInstall = missing.length > 0 && manual.length === 0
  const staleTools = missing.length === 0 ? plan?.tools.filter(x => x.outdated) ?? [] : []

  // pull: bring the branch up to date first (Update, and a first build); false
  // compiles the source as it is (Rebuild).
  async function runBuild(ty: string, extraArgs: string, installTools = false, gpuOverride?: string, pull = true) {
    setError('')
    const res = await window.api.buildFromSource({ trackedId: t.id, type: ty, extraArgs, installTools, gpuTarget: ty === 'rocm' ? gpuOverride || gpu || undefined : undefined, pull })
    setDownloadProgress(`${t.id}::build:${ty}`, null)
    if (!res.success && res.error !== 'Cancelled') setError(res.error || 'Build failed')
    window.api.getBuildToolsPlan(ty, ty === 'rocm' ? gpu || undefined : undefined).then(setPlan).catch(() => {})
    await onChanged()
  }

  // The yellow note under the options already says which tools are installed,
  // so the button does not ask again.
  function startBuild() {
    // Rebuilding what is already built compiles it again as it is; Update & Rebuild is the button that pulls.
    runBuild(type, args, needsInstall, undefined, !installed)
  }

  // Pulls the branch and rebuilds the builds that are behind it, each with the
  // options it was built with. Only offered when there is such a build.
  function updateAndRebuild() {
    outdatedBuilds.forEach(b => runBuild(b.type, b.type === type ? args : b.args.map(quoteArg).join(' '), false, b.gpuTarget))
  }

  async function updateTools() {
    setToolsBusy(true)
    setError('')
    setToolsMessage('')
    const res = await window.api.installBuildTools({ type, mode: 'update', gpuTarget })
    if (!res.success) setError(res.error || 'Updating the build tools failed')
    else setToolsMessage('The build tools were updated. Anything the package manager had nothing newer to install is no longer offered this session.')
    setPlan(await window.api.getBuildToolsPlan(type, gpuTarget))
    setToolsBusy(false)
  }

  function cancel(ty: string) {
    window.api.cancelSourceBuild(t.id, ty)
    setDownloadProgress(`${t.id}::build:${ty}`, null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      <div className="tracker-assets-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div ref={pickerRef} className={`asset-picker select-menu select-menu-field${open ? ' open' : ''}`} style={{ minWidth: 260 }}>
          <button type="button" className="btn btn-secondary select-menu-btn" onClick={() => setOpen(o => !o)}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {selectedDef.label}{installed ? ` (${installed.version})` : ''}
            </span>
            {open ? <ChevronUp size={13} style={{ flexShrink: 0 }} /> : <ChevronDown size={13} style={{ flexShrink: 0 }} />}
          </button>
          {open && (
            <div
              className="asset-dropdown-menu"
              style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
                marginTop: 4, background: 'var(--surface-2, var(--surface))', border: '1px solid var(--border)',
                borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.25)', maxHeight: 280, overflowY: 'auto'
              }}
            >
              {types.map(x => {
                const b = builds.find(y => y.type === x.id)
                return (
                  <div
                    key={x.id}
                    onClick={() => { setType(x.id); writePref(TYPE_KEY, t.id, x.id); setOpen(false) }}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover, rgba(255,255,255,.05))')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>
                      {x.label}{' '}
                      <span style={{ color: 'var(--text-muted)' }}>
                        ({b ? `${b.version}${b.commit ? `, ${b.commit.slice(0, 7)}` : ''}` : 'not built'})
                      </span>
                      {b?.outdated && <span style={{ color: 'var(--warning)', marginLeft: 6 }}>behind the branch</span>}
                    </span>
                    {progressOf(x.id) ? (
                      <Loader2 size={12} className="spin" style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
                    ) : b ? (
                      <button
                        className="btn btn-ghost btn-icon text-danger"
                        onClick={e => { e.stopPropagation(); onDeleteType(b.type) }}
                        title={`Delete the compiled "${b.type}" build`}
                        style={{ flexShrink: 0, padding: 2 }}
                      >
                        <Trash size={12} />
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {type === 'rocm' && (
          <SelectMenu
            variant="field"
            style={{ width: 280, flexShrink: 0 }}
            value={gpu}
            onChange={v => { setGpu(v); writePref(GPU_KEY, t.id, v) }}
            title="The AMD GPU to build for (the ROCm SDK is downloaded for its family)"
            placeholder="Choose your GPU"
            options={ROCM_GPUS.map(g => ({ value: g.gfx, label: g.label }))}
          />
        )}
        {selected ? (
          <div className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
            <Loader2 size={14} className="spin" />
            {phaseText(selected)}
            <button className="btn btn-ghost btn-sm text-danger" style={{ padding: '0 8px' }} onClick={() => cancel(type)}>Cancel</button>
            {logButton(type)}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6 }}>
            {installed && !needsInstall ? (
              <>
                {outdatedBuilds.length > 0 && (
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={manual.length > 0 || toolsBusy || needsGpu}
                    onClick={updateAndRebuild}
                    title={outdatedBuilds.length > 1
                      ? `Pull the branch and rebuild the ${outdatedBuilds.length} builds that are behind it, with the options they were built with`
                      : 'Pull the branch, then compile the build that is behind it again'}
                  >
                    <RefreshCw size={13} /> Update &amp; Rebuild{outdatedBuilds.length > 1 ? ` (${outdatedBuilds.length})` : ''}
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={manual.length > 0 || toolsBusy || needsGpu}
                  onClick={startBuild}
                  title="Compile the source again as it is now, without pulling the branch (after changing options or the SDK)"
                >
                  <Hammer size={13} /> Rebuild
                </button>
              </>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                disabled={manual.length > 0 || toolsBusy || needsGpu}
                onClick={startBuild}
                title={installed ? 'Install the missing tools, then compile this build again' : 'Clone the repository and compile it'}
              >
                <Hammer size={13} /> {needsInstall ? 'Install tools and build' : 'Build from source'}
              </button>
            )}
          </div>
        )}
      </div>

      {otherBusy.map(x => (
        <div key={x.id} className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
          <Loader2 size={13} className="spin" />
          <span>{x.label}: {phaseText(progressOf(x.id))}</span>
          <button className="btn btn-ghost btn-sm text-danger" style={{ padding: '0 8px' }} onClick={() => cancel(x.id)}>Cancel</button>
          {logButton(x.id)}
        </div>
      ))}

      <input
        className="form-input"
        type="text"
        style={{ fontSize: 12 }}
        placeholder="Extra CMake options (optional), e.g. -DCMAKE_CUDA_ARCHITECTURES=89"
        value={args}
        onChange={e => { setArgs(e.target.value); writePref(ARGS_KEY, t.id, e.target.value) }}
      />

      {needsGpu && (
        <div style={{ fontSize: 12, color: 'var(--warning)' }}>
          <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
          Choose your GPU: the build is compiled for it, and the ROCm SDK is downloaded for its family.
        </div>
      )}
      {needsInstall && (
        <div style={{ fontSize: 12, color: 'var(--warning)' }}>
          <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
          Missing: {missing.map(x => x.detail ? `${x.label} (${x.detail})` : x.label).join(', ')}. {plan?.manager ? `They are installed with ${plan.manager} when you build,` : 'They are installed when you build,'} which may ask for administrator permission.
        </div>
      )}
      {manual.map(x => (
        <div key={x.id} style={{ fontSize: 12, color: 'var(--warning)' }}>
          <AlertCircle size={12} style={{ display: 'inline', marginRight: 4 }} />
          {x.label} is missing and cannot be installed automatically. {x.reason}
        </div>
      ))}
      {staleTools.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            Newer versions available: {staleTools.map(x => x.label).join(', ')}.{autoUpdateTools ? ' They are updated before the next build.' : ''}
          </span>
          <button className="btn btn-ghost btn-sm" disabled={toolsBusy} onClick={updateTools}>
            {toolsBusy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />} Update now
          </button>
          {toolsBusy && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setLogsSource('build:tools'); setView('logs') }} title="Show the output of the update in the Logs tab">
              <Terminal size={12} /> Logs
            </button>
          )}
        </div>
      )}
      {toolsMessage && staleTools.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{toolsMessage}</div>}
      {error && <div style={{ fontSize: 12, color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{error} (full output is in the Logs tab)</div>}
    </div>
  )
}

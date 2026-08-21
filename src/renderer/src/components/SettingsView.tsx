import React, { useState, useEffect, useCallback } from 'react'
import { useStore } from '../store/useStore'
import {
  HardDrive, Download, Trash, RefreshCw, Loader2, ChevronDown, Terminal,
  Bell, BellOff, Folder, Monitor, Moon, Sun, Link2, Plus,
  AlertCircle, ExternalLink, Cpu, Layers, Shield, Database, Copy, Check
} from 'lucide-react'
import CommandsEditor from './CommandsEditor'
import ExternalFolderList from './ExternalFolderList'
import { changeTheme } from '../hooks/useTheme'
import { formatBytes } from '../utils/format'
import { formatWithSpaces, parseSpacedNumber, CONTEXT_POWER_OF_TWO_STEPS, snapToNearestPowerOfTwo, indexOnLadder } from '../utils/contextFormat'
import type { ThemePref, TrackedBackend, TrackedBackendRelease } from '../../../shared/types'

const NOTIF_KEY = 'hexllama_update_notify'

function getNotifPref(): 'banner' | 'manual' {
  return (localStorage.getItem(NOTIF_KEY) as 'banner' | 'manual') || 'banner'
}

// Task 1: Base URL field — LM Studio style.
// REST (not focused): the whole URL "http://localhost:<port>/v1" is one
//   continuous white string (a single link, no breaks). A copy button sits
//   on the RIGHT inside the box.
// FOCUSED (editing the port): "http://localhost:" turns gray, the port is
//   white/editable, and "/v1" is pushed to the right border (gray, static
//   suffix). The copy button disappears to make room for /v1 at the right.
//   A blue/purple focus glow highlights the box.
function BaseUrlField({ port, onPortChange, onPortBlur }: {
  port: number
  onPortChange: (p: number) => void
  onPortBlur: () => void
}) {
  const [focused, setFocused] = useState(false)
  const [copied, setCopied] = useState(false)
  const fullUrl = `http://localhost:${port}/v1`
  function handleCopy() {
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div
      className="base-url-field-lm"
      style={{
        display: 'flex', alignItems: 'center',
        width: '100%', maxWidth: 420, height: 36,
        border: `1px solid ${focused ? 'var(--info-blue, #3b82f6)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface)',
        boxShadow: focused ? '0 0 0 3px rgba(59,130,246,.18)' : 'none',
        transition: 'border-color 150ms, box-shadow 150ms',
        fontFamily: 'var(--font-mono)', fontSize: 13,
        overflow: 'hidden'
      }}
    >
      {/* "http://localhost:" — white in rest, gray when focused (editing). */}
      <span
        style={{
          padding: '0 0 0 10px',
          color: focused ? 'var(--text-muted)' : 'var(--text)',
          whiteSpace: 'nowrap', userSelect: 'none'
        }}
      >
        http://localhost:
      </span>
      {/* The port — inline transparent input. White in both states. */}
      <input
        type="number"
        min={1}
        max={65535}
        value={port}
        onFocus={() => setFocused(true)}
        onChange={(e) => {
          const p = Math.max(1, Math.min(65535, Number(e.target.value) || 1234))
          onPortChange(p)
        }}
        onBlur={() => { setFocused(false); onPortBlur() }}
        style={{
          width: `${Math.max(1, String(port || '').length)}ch`,
          minWidth: '1ch',
          border: 'none', outline: 'none', background: 'transparent',
          textAlign: 'center',
          fontFamily: 'var(--font-mono)', fontSize: 13,
          color: 'var(--text)', fontWeight: 600,
          MozAppearance: 'textfield', padding: 0,
          flexGrow: 0
        }}
        title="Port number (1–65535)"
      />
      {/* Right side: in REST show "/v1" + copy button as one continuous white
          link. When FOCUSED, push "/v1" to the right border (gray) and hide the
          copy button (it would collide). */}
      {!focused ? (
        <>
          <span style={{ padding: '0 2px', color: 'var(--text)', whiteSpace: 'nowrap', userSelect: 'none' }}>
            /v1
          </span>
          <button
            type="button"
            onClick={handleCopy}
            title="Copy URL"
            style={{
              flexShrink: 0, width: 34, height: '100%', marginLeft: 'auto',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: 'none', borderLeft: '1px solid var(--border)',
              background: 'transparent', cursor: 'pointer',
              color: copied ? 'var(--success)' : 'var(--text-muted)'
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </>
      ) : (
        <span style={{ padding: '0 10px 0 4px', color: 'var(--text-muted)', whiteSpace: 'nowrap', userSelect: 'none', marginLeft: 'auto' }}>
          /v1
        </span>
      )}
    </div>
  )
}

export default function SettingsView() {
  const {
    backends, activeBackend, setActiveBackend, setCommandsSchema, setBackends,
    releaseInfo, downloadProgress, setDownloadProgress, setReleaseInfo,
    setModels, compactSidebarEnabled, setCompactSidebarEnabled,
    theme, systemTheme,
    externalModelFolders, externalBackendFolders,
    mainModelFolder, mainBackendFolder,
    trackedBackends, trackerResults, checkingAllBackends,
    setExternalModelFolders, setExternalBackendFolders,
    setMainModelFolder, setMainBackendFolder, setTrackedBackends,
    setTrackerResult, setCheckingAllBackends,
    modelDefaults, setModelDefaults, baseUrlOverride, setBaseUrlOverride,
    vramInfo, systemRam
  } = useStore()

  const [downloading, setDownloading] = useState(false)
  const [selectedAssetByUrl, setSelectedAssetByUrl] = useState<Record<string, string>>({})
  const [expandedEditor, setExpandedEditor] = useState<string | null>(null)
  const [notifPref, setNotifPref] = useState<'banner' | 'manual'>(getNotifPref())
  const [customBackendLink, setCustomBackendLink] = useState('')
  const [customBackendErr, setCustomBackendErr] = useState('')

  useEffect(() => {
    if (releaseInfo?.assets.length) {
      // legacy single release uses key 'llama-cpp'
      if (!selectedAssetByUrl['llama-cpp']) {
        setSelectedAssetByUrl(prev => ({ ...prev, 'llama-cpp': releaseInfo.assets[0].downloadUrl }))
      }
    }
  }, [releaseInfo, selectedAssetByUrl])

  async function refreshModels() {
    const m = await window.api.listModels()
    setModels(m)
  }

  function handleNotifPref(pref: 'banner' | 'manual') {
    setNotifPref(pref)
    localStorage.setItem(NOTIF_KEY, pref)
  }

  async function handleSwitchBackend(backendId: string) {
    const b = backends.find(x => x.id === backendId || x.name === backendId)
    if (!b) return
    setActiveBackend(b)
    const cmds = await window.api.getCommands(b.backendKey)
    if (cmds) setCommandsSchema(cmds)
  }

  async function handleDeleteBackend(backendId: string) {
    const b = backends.find(x => x.id === backendId)
    if (!b) return
    if (!confirm(`Delete backend "${b.displayName}"? This will remove all files in that version folder.`)) return
    const res = await window.api.deleteBackend(backendId)
    if (res.success) {
      const updated = await window.api.listBackends()
      setBackends(updated)
    } else alert('Delete failed: ' + res.error)
  }

  // Global "Check for updates" across ALL tracked backends.
  const handleCheckAllBackends = useCallback(async () => {
    setCheckingAllBackends(true)
    try {
      const { results } = await window.api.checkAllBackends()
      for (const r of results) setTrackerResult(r)
      // Also sync the legacy releaseInfo with the llama.cpp result for the banner.
      const llama = results.find(r => r.trackedId === 'llama-cpp')
      if (llama) {
        const { trackedId, folderName, ...rest } = llama
        setReleaseInfo(rest as any)
      }
    } finally {
      setCheckingAllBackends(false)
    }
  }, [setCheckingAllBackends, setTrackerResult, setReleaseInfo])

  async function handleAddTrackedBackend() {
    setCustomBackendErr('')
    const link = customBackendLink.trim()
    if (!link) return
    const res = await window.api.addTrackedBackend(link)
    if (res.success && res.tracked) {
      setTrackedBackends([...trackedBackends, res.tracked])
      setCustomBackendLink('')
      // Immediately check the newly added backend so the user sees its release.
      handleCheckAllBackends()
    } else {
      setCustomBackendErr(res.error || 'Failed to add')
    }
  }

  async function handleRemoveTrackedBackend(t: TrackedBackend) {
    if (t.isDefault) { alert('Built-in backends cannot be removed.'); return }
    if (!confirm(`Stop tracking "${t.name}"? Already-downloaded versions are kept.`)) return
    const res = await window.api.removeTrackedBackend(t.id)
    if (res.success) setTrackedBackends(trackedBackends.filter(x => x.id !== t.id))
  }

  async function handleDownloadTracked(t: TrackedBackend, release: TrackedBackendRelease) {
    const assetUrl = selectedAssetByUrl[t.id] || (release.assets[0]?.downloadUrl || '')
    const asset = release.assets.find(a => a.downloadUrl === assetUrl) || release.assets[0]
    if (!asset) return
    setDownloading(true)
    const versionHint = release.tagName || asset.name.replace(/\.(zip|tar\.gz)$/i, '')
    const res = await window.api.downloadRelease({
      url: asset.downloadUrl,
      version: versionHint,
      assetName: asset.name,
      backendKey: t.folderName
    })
    setDownloading(false)
    setDownloadProgress(null)
    if (res.success) {
      const backendsData = await window.api.listBackends()
      setBackends(backendsData)
    } else alert(`Download failed: ${res.error}`)
  }

  async function handleSetTheme(t: ThemePref) {
    await changeTheme(t)
  }

  return (
    <div className="max-w-3xl">
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <p className="page-subtitle">Manage llama.cpp backends, models and appearance</p>
        </div>
      </div>

      {/* Appearance / Theme */}
      <div className="settings-section">
        <div className="settings-section-title"><Monitor /> Appearance</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Choose how XLM Studio looks. <strong>Match System</strong> follows your OS theme.
            If the system theme can't be detected, it falls back to Dark.
          </p>
          <div className="theme-segmented">
            <button
              className={`theme-segmented-btn ${theme === 'system' ? 'active' : ''}`}
              onClick={() => handleSetTheme('system')}
              title="Follow the operating system theme"
            >
              <Monitor size={14} /> Match System
              {theme === 'system' && (
                <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                  ({systemTheme})
                </span>
              )}
            </button>
            <button
              className={`theme-segmented-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => handleSetTheme('dark')}
              title="Always use dark theme"
            >
              <Moon size={14} /> Dark
            </button>
            <button
              className={`theme-segmented-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => handleSetTheme('light')}
              title="Always use light theme"
            >
              <Sun size={14} /> Light
            </button>
          </div>
        </div>
      </div>

      {/* Feature 18: Model Defaults — AutoFit context override */}
      <div className="settings-section">
        <div className="settings-section-title"><Database /> Model Defaults</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Minimum AutoFit context length override</div>
              <div className="settings-row-sub">Guarantees a minimum context token ceiling during VRAM budgeting.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={modelDefaults.autoFitEnabled} onChange={async (e) => {
                  const d = { ...modelDefaults, autoFitEnabled: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {modelDefaults.autoFitEnabled && (
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Minimum AutoFit context length</span>
                <input
                  type="text"
                  inputMode="numeric"
                  className="form-input"
                  style={{ width: 110 }}
                  value={formatWithSpaces(modelDefaults.autoFitContextLength)}
                  onChange={async (e) => {
                    const raw = parseSpacedNumber(e.target.value)
                    const clamped = Math.max(2048, Math.min(2097152, raw))
                    const value = modelDefaults.autoFitUse2xIncrements ? snapToNearestPowerOfTwo(clamped) : clamped
                    const d = { ...modelDefaults, autoFitContextLength: value }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
                {/* Item 5: bumped ceiling 200 000 → 2 097 152 (2M-context models). */}
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>tokens (2 048 – 2 097 152)</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!modelDefaults.autoFitUse2xIncrements} onChange={async (e) => {
                    const use2x = e.target.checked
                    const d = {
                      ...modelDefaults,
                      autoFitUse2xIncrements: use2x,
                      // Snap the current value onto the ladder immediately so the
                      // slider and the number field agree the moment this is checked.
                      autoFitContextLength: use2x ? snapToNearestPowerOfTwo(modelDefaults.autoFitContextLength) : modelDefaults.autoFitContextLength
                    }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
                  Use 2x increments
                </label>
              </div>
              {modelDefaults.autoFitUse2xIncrements ? (
                <input
                  type="range"
                  min={0}
                  max={CONTEXT_POWER_OF_TWO_STEPS.length - 1}
                  step={1}
                  value={indexOnLadder(modelDefaults.autoFitContextLength)}
                  style={{ width: '100%' }}
                  onChange={async (e) => {
                    const value = CONTEXT_POWER_OF_TWO_STEPS[Number(e.target.value)]
                    const d = { ...modelDefaults, autoFitContextLength: value }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
              ) : (
                <input type="range" min={2048} max={2097152} step={1024} value={modelDefaults.autoFitContextLength} style={{ width: '100%' }}
                  onChange={async (e) => {
                    const d = { ...modelDefaults, autoFitContextLength: Number(e.target.value) }
                    setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                  }} />
              )}
              {/* Item 5: "Automatic YaRN scaling control override and upscale to
                  AutoFit" — when on, every template's effective max context can be
                  upscaled via YaRN to reach this AutoFit floor even if the model's
                  native context is smaller. See item 8 for the per-template switch
                  this mirrors/drives. */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 12 }}>
                <div>
                  <div className="settings-row-label" style={{ fontSize: 12 }}>Automatic YaRN scaling control override and upscale to AutoFit</div>
                  <div className="settings-row-sub" style={{ fontSize: 11 }}>
                    When a model's native context is below the Minimum AutoFit override above, automatically apply YaRN RoPE scaling to reach it, instead of capping at the model's native maximum.
                  </div>
                </div>
                <div className="toggle-wrap">
                  <label className="toggle">
                    <input type="checkbox" checked={!!modelDefaults.autoFitYarnAutoScale} onChange={async (e) => {
                      const d = { ...modelDefaults, autoFitYarnAutoScale: e.target.checked }
                      setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                    }} />
                    <span className="toggle-track"></span><span className="toggle-thumb"></span>
                  </label>
                </div>
              </div>
            </div>
          )}
          {/* Task 4: Current Memory State use in memory calculations */}
          {/* Item 4 (rename): "Current Memory State use in memory calculations"
              -> "Use current memory state in memory calculations" — same
              setting, just reads better grammatically. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
            <div>
              <div className="settings-row-label">Use current memory state in memory calculations</div>
              <div className="settings-row-sub">
                ON = use the currently-available Free VRAM / Free RAM (polled every 10s). OFF (default) = use the static maximum VRAM / RAM totals — more conservative and stable.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!modelDefaults.useCurrentMemState} onChange={async (e) => {
                  const d = { ...modelDefaults, useCurrentMemState: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {!modelDefaults.useCurrentMemState && (
            <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 6, lineHeight: 1.5 }}>
              Consider turning memory overhead on for system stability when using device alongside running model with full VRAM/RAM utilization.
            </div>
          )}
          {/* New: "Enable Multimodal Projector automatically in new Template
              if mmproj was detected" — ON by default. This governs whether a
              brand-new template defaults mmproj ON when the model has one, or
              always starts OFF (saving VRAM/RAM for users who don't need
              vision) until manually enabled. Existing templates and manual
              toggles are unaffected either way. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginTop: 8 }}>
            <div>
              <div className="settings-row-label">Enable Multimodal Projector automatically in new Template if mmproj was detected</div>
              <div className="settings-row-sub">
                Save memory when you don't need vision capabilities.
              </div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={modelDefaults.autoEnableMmproj !== false} onChange={async (e) => {
                  const d = { ...modelDefaults, autoEnableMmproj: e.target.checked }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>
          {/* Task 8: Strategy for MoE offloading calculations */}
          <div style={{ width: '100%', marginTop: 12 }}>
            <div className="settings-row-label" style={{ marginBottom: 4 }}>Strategy for MoE offloading calculations</div>
            <div className="settings-row-sub" style={{ marginBottom: 8 }}>
              "Offload GPU Layers" finds a good GPU layer count for MoE models. "MAX GPU Layers and Force MoE Weights onto CPU" pushes as many non-expert layers to GPU as possible (experts on CPU) for higher speed — disables the "Maximum available" AutoFill option (conflict).
            </div>
            <div className="mmproj-mode-toggle" style={{ display: 'inline-flex' }}>
              <button
                type="button"
                className={`mmproj-mode-btn ${(modelDefaults.moeOffloadStrategy || 'offload') === 'offload' ? 'active' : ''}`}
                onClick={async () => {
                  const d = { ...modelDefaults, moeOffloadStrategy: 'offload' as const }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }}
              >Offload GPU Layers</button>
              <button
                type="button"
                className={`mmproj-mode-btn ${modelDefaults.moeOffloadStrategy === 'max' ? 'active' : ''}`}
                onClick={async () => {
                  const d = { ...modelDefaults, moeOffloadStrategy: 'max' as const }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }}
              >MAX GPU Layers and Force MoE Weights onto CPU</button>
            </div>
          </div>
        </div>
      </div>

      {/* Feature 19: Model Loading Guardrails */}
      <div className="settings-section">
        <div className="settings-section-title"><Shield /> Model Loading Guardrails</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
          {[
            { mode: 'off', label: 'OFF (Not Recommended)', hint: 'No precautions against system overload' },
            { mode: 'relaxed', label: 'Relaxed', hint: 'Mild precautions against system overload' },
            { mode: 'balanced', label: 'Balanced', hint: 'Moderate precautions against system overload' },
            { mode: 'strict', label: 'Strict', hint: 'Strong precautions against system overload' },
            { mode: 'custom', label: 'Custom', hint: 'Set your own limit for maximum model size that can be loaded' }
          ].map(opt => (
            <label key={opt.mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', width: '100%' }}>
              <input type="radio" name="guardrail" value={opt.mode} checked={modelDefaults.guardrailMode === opt.mode}
                onChange={async (e) => {
                  const d = { ...modelDefaults, guardrailMode: e.target.value }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{opt.hint}</div>
              </div>
            </label>
          ))}
          {modelDefaults.guardrailMode === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <span style={{ fontSize: 12 }}>Max model size (GB):</span>
              <input type="number" className="form-input" style={{ width: 100 }} min={0} step={0.5} value={modelDefaults.customMaxSizeGB}
                onChange={async (e) => {
                  const d = { ...modelDefaults, customMaxSizeGB: Number(e.target.value) }
                  setModelDefaults(d); try { await window.api?.setModelDefaults?.(d) } catch {}
                }} />
            </div>
          )}
          {vramInfo && systemRam && (() => {
            // Vendor-aware label — no longer hardcodes "NVIDIA GPU" when an AMD /
            // Intel / unknown GPU is present (fix for RX 9070 XT being reported as
            // "NVIDIA GPU (0 MB VRAM)").
            const gpuLabel = vramInfo.gpuName
              || (vramInfo.vendor ? `${vramInfo.vendor} GPU` : 'GPU not detected')
            const vram = vramInfo.totalVRAMMB || 0
            const ram = systemRam.totalRAMMB || 0
            const total = vram + ram
            return (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
                Detected: <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{gpuLabel}</span>
                {vram > 0 ? ` (${vram.toLocaleString()} MB VRAM)` : ' (VRAM unavailable)'}
                {' · '}{ram.toLocaleString()} MB system RAM
                {' · Total: '}<span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{total.toLocaleString()} MB</span>
                {' (VRAM + RAM)'}
              </div>
            )
          })()}
        </div>
      </div>

      {/* Feature 24: Base URL Override */}
      <div className="settings-section">
        <div className="settings-section-title"><Link2 /> Base URL Override</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Enable Base URL override</div>
              <div className="settings-row-sub">Force every launched backend onto a single port. The server listens at <code>http://localhost:&lt;port&gt;/v1</code>.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={baseUrlOverride.enabled} onChange={async (e) => {
                  const o = { ...baseUrlOverride, enabled: e.target.checked }
                  setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {/* Task 1: Base URL — LM Studio style. Single unified box with the full
              URL as one continuous string; the port is an inline transparent input.
              A copy button sits on the LEFT, visible when the input isn't focused.
              When focused, a purple/blue focus glow highlights the box. */}
          <div style={{ width: '100%' }}>
            <BaseUrlField
              port={baseUrlOverride.port}
              onPortChange={async (p) => {
                const o = { ...baseUrlOverride, port: p }
                setBaseUrlOverride(o)
              }}
              onPortBlur={async () => { try { await window.api?.setBaseUrlOverride?.(baseUrlOverride) } catch {} }}
            />
            <div className="form-hint">Only the port number is editable. Click the box to edit, or use the copy button to copy the full URL.</div>
          </div>

          {/* Serve on local network */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
            <div>
              <div className="settings-row-label">Serve on local network</div>
              <div className="settings-row-sub">Bind to <code>0.0.0.0</code> so other devices on your LAN can reach the server.</div>
            </div>
            <div className="toggle-wrap">
              <label className="toggle">
                <input type="checkbox" checked={!!baseUrlOverride.serveOnLocalNetwork} onChange={async (e) => {
                  const o = { ...baseUrlOverride, serveOnLocalNetwork: e.target.checked }
                  setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                }} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          {/* API Key */}
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div>
                <div className="settings-row-label">API Key</div>
                <div className="settings-row-sub">Require an API key for all requests (adds <code>--api-key</code>).</div>
              </div>
              <div className="toggle-wrap">
                <label className="toggle">
                  <input type="checkbox" checked={!!baseUrlOverride.apiKeyEnabled} onChange={async (e) => {
                    const o = { ...baseUrlOverride, apiKeyEnabled: e.target.checked }
                    setBaseUrlOverride(o); try { await window.api?.setBaseUrlOverride?.(o) } catch {}
                  }} />
                  <span className="toggle-track"></span><span className="toggle-thumb"></span>
                </label>
              </div>
            </div>
            {baseUrlOverride.apiKeyEnabled && (
              <input
                type="text"
                className="form-input"
                style={{ width: '100%', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 13 }}
                value={baseUrlOverride.apiKey}
                placeholder="sk-..."
                onChange={async (e) => {
                  const o = { ...baseUrlOverride, apiKey: e.target.value }
                  setBaseUrlOverride(o)
                }}
                onBlur={async () => { try { await window.api?.setBaseUrlOverride?.(baseUrlOverride) } catch {} }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Notifications */}
      <div className="settings-section">
        <div className="settings-section-title"><Bell /> Update Notifications</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Choose how you'd like to be informed when a new version of llama.cpp is available.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`launch-mode-btn ${notifPref === 'banner' ? 'active' : ''}`} onClick={() => handleNotifPref('banner')}>
              <Bell size={13} /> Show Banner Automatically
            </button>
            <button className={`launch-mode-btn ${notifPref === 'manual' ? 'active' : ''}`} onClick={() => handleNotifPref('manual')}>
              <BellOff size={13} /> Check Manually Only
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar Layout */}
      <div className="settings-section">
        <div className="settings-section-title"><Terminal /> Sidebar Layout</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Toggle the sidebar mode. Auto-collapse shrinks the sidebar to icons and expands on hover.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className={`launch-mode-btn ${!compactSidebarEnabled ? 'active' : ''}`} onClick={() => setCompactSidebarEnabled(false)}>
              Full Sidebar (Default)
            </button>
            <button className={`launch-mode-btn ${compactSidebarEnabled ? 'active' : ''}`} onClick={() => setCompactSidebarEnabled(true)}>
              Auto-Collapse Sidebar
            </button>
          </div>
        </div>
      </div>

      {/* External Model Folders (with star/main selector) */}
      <div className="settings-section">
        <div className="settings-section-title"><Folder /> External Model Folders</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Add folders outside the app's default models directory. Files inside appear on the Models page.
            Star one folder to make it the <strong>main folder</strong> — all models downloaded through the app
            land there (in their own subfolder, named after the page model). If nothing is starred, the default
            app folder is used. The starred folder is pinned to the top; others are sorted alphabetically.
          </p>
          <ExternalFolderList
            folders={externalModelFolders}
            mainFolder={mainModelFolder}
            onAdd={async () => {
              const res = await window.api.addExternalModelFolder()
              if (res.success && res.folders) setExternalModelFolders(res.folders)
              return res
            }}
            onRemove={async (folder) => {
              const res = await window.api.removeExternalModelFolder(folder)
              setExternalModelFolders(res.folders)
              return res
            }}
            onSetMain={async (folder) => {
              const res = await window.api.setMainModelFolder(folder)
              // Reload main folder state from the source of truth.
              const mm = await window.api.getMainModelFolder()
              setMainModelFolder(mm.isDefault ? null : mm.folder)
              return res
            }}
            addLabel="Add Model Folder"
            emptyText="No external model folders configured. The default app folder is used."
            onAfterChange={refreshModels}
          />
        </div>
      </div>

      {/* External Backend Folders (same mechanics) */}
      <div className="settings-section">
        <div className="settings-section-title"><Cpu /> External Backends Folders</div>
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Add folders that contain pre-built llama.cpp backends (e.g. a folder where you keep several
            compiled forks). Star one to make it the <strong>main backend folder</strong> — backends
            downloaded through the Backends Tracker land there, under <code>&lt;fork-name&gt;/&lt;version&gt;/</code>.
            Same star/sort mechanics as model folders.
          </p>
          <ExternalFolderList
            folders={externalBackendFolders}
            mainFolder={mainBackendFolder}
            onAdd={async () => {
              const res = await window.api.addExternalBackendFolder()
              if (res.success && res.folders) setExternalBackendFolders(res.folders)
              return res
            }}
            onRemove={async (folder) => {
              const res = await window.api.removeExternalBackendFolder(folder)
              setExternalBackendFolders(res.folders)
              return res
            }}
            onSetMain={async (folder) => {
              const res = await window.api.setMainBackendFolder(folder)
              const mb = await window.api.getMainBackendFolder()
              setMainBackendFolder(mb.isDefault ? null : mb.folder)
              return res
            }}
            addLabel="Add Backend Folder"
            emptyText="No external backend folders configured. The default app folder is used."
            onAfterChange={async () => {
              const updated = await window.api.listBackends()
              setBackends(updated)
            }}
          />
        </div>
      </div>

      {/* Installed Backends */}
      <div className="settings-section">
        <div className="settings-section-title"><HardDrive /> Installed Backends</div>
        {backends.length === 0 ? (
          <div className="text-center py-6 text-sm" style={{ color: 'var(--text-muted)' }}>
            No backends installed. Download one from the Backends Tracker below.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {backends.map((b) => (
              <div key={b.id}>
                <div className="settings-row">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="settings-row-label flex items-center gap-2">
                      <Layers size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.displayName}</span>
                      {activeBackend?.id === b.id && <span className="version-badge active-version">Active</span>}
                      {!b.hasCommands && <span className="version-badge">Fallback Schema</span>}
                      {b.external && <span className="version-badge">External</span>}
                    </div>
                    <div className="settings-row-sub mono" style={{ wordBreak: 'break-all' }}>
                      {b.exe ? `${b.path}${b.path.endsWith('/') || b.path.endsWith('\\') ? '' : '/'}${b.exe}` : 'No executable found'}
                    </div>
                  </div>
                  <div className="flex gap-2" style={{ flexShrink: 0 }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleSwitchBackend(b.id)}
                      disabled={activeBackend?.id === b.id}
                    >
                      Set Active
                    </button>
                    <button
                      className={`btn btn-ghost btn-sm flex items-center gap-1 ${expandedEditor === b.id ? 'btn-primary' : ''}`}
                      onClick={() => setExpandedEditor(expandedEditor === b.id ? null : b.id)}
                      title="Edit commands.json for this backend fork"
                    >
                      <Terminal size={13} />
                      <ChevronDown size={12} style={{ transform: expandedEditor === b.id ? 'rotate(180deg)' : 'none', transition: 'transform 180ms' }} />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon text-danger"
                      onClick={() => handleDeleteBackend(b.id)}
                      title="Delete backend version"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                </div>
                {expandedEditor === b.id && (
                  <div className="ce-panel">
                    <CommandsEditor backendKey={b.backendKey} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Backends Tracker (renamed from "Available Updates") */}
      <div className="settings-section">
        <div className="settings-section-title"><Download /> Backends Tracker</div>

        {/* Add custom backend from link */}
        <div className="settings-row" style={{ borderBottom: 'none', flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
            Track additional llama.cpp forks by their GitHub repository. Paste a link like
            <code> https://github.com/owner/repo </code> or <code>owner/repo</code>. Backends are
            organised under <code>&lt;fork-name&gt;/&lt;version&gt;/</code> and a resilient search
            locates the <code>llama-server</code> binary — even when it's nested deep in <code>build/bin/</code>.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="form-input"
              style={{ flex: 1 }}
              type="text"
              placeholder="https://github.com/owner/repo  or  owner/repo"
              value={customBackendLink}
              onChange={e => setCustomBackendLink(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddTrackedBackend() }}
            />
            <button className="btn btn-primary" onClick={handleAddTrackedBackend} disabled={!customBackendLink.trim()}>
              <Plus size={14} /> Add custom backend from link
            </button>
          </div>
          {customBackendErr && (
            <div className="hub-error"><AlertCircle size={14} />{customBackendErr}</div>
          )}
        </div>

        {/* Tracked backends list */}
        <div style={{ marginTop: 16 }}>
          {trackedBackends.map(t => {
            const release = trackerResults[t.id]
            const loadingThis = checkingAllBackends && !release
            const selectedUrl = selectedAssetByUrl[t.id] || (release?.assets[0]?.downloadUrl || '')
            return (
              <div key={t.id} className="tracker-card">
                <div className="tracker-card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="tracker-name">
                      {t.name}
                      {t.isDefault && <span className="tracker-default-tag">built-in</span>}
                    </div>
                    <div className="tracker-repo">
                      <Link2 size={11} style={{ display: 'inline', marginRight: 4 }} />
                      {t.repo}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {release?.url && (
                      <button
                        className="btn btn-ghost btn-icon"
                        onClick={() => window.api.openExternal(release.url)}
                        title="Open release on GitHub"
                      >
                        <ExternalLink size={14} />
                      </button>
                    )}
                    {!t.isDefault && (
                      <button
                        className="btn btn-ghost btn-icon text-danger"
                        onClick={() => handleRemoveTrackedBackend(t)}
                        title="Stop tracking this fork"
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </div>
                </div>

                {loadingThis ? (
                  <div className="tracker-release" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Loader2 size={13} className="spin" /> Checking GitHub for releases...
                  </div>
                ) : release?.error ? (
                  <div className="tracker-release" style={{ color: 'var(--danger)' }}>
                    <AlertCircle size={13} style={{ display: 'inline', marginRight: 6 }} />
                    Error: {release.error}
                  </div>
                ) : release ? (
                  <>
                    <div className="tracker-release">
                      <strong>{release.name || release.tagName}</strong>
                      {release.publishedAt && (
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
                          Published: {new Date(release.publishedAt).toLocaleDateString()}
                        </span>
                      )}
                      {release.isNewer === false && <span className="up-to-date">✓ Up to date</span>}
                      {release.isNewer === true && <span className="new-badge">New version available</span>}
                    </div>
                    {release.assets.length > 0 && release.isNewer !== false && (
                      <div className="tracker-assets-row">
                        <select
                          className="cmd-select"
                          value={selectedUrl}
                          onChange={e => setSelectedAssetByUrl(prev => ({ ...prev, [t.id]: e.target.value }))}
                          disabled={downloading || !!downloadProgress}
                        >
                          {release.assets.map(a => (
                            <option key={a.downloadUrl} value={a.downloadUrl}>
                              {a.name} ({formatBytes(a.size)})
                            </option>
                          ))}
                        </select>
                        {downloading || downloadProgress ? (
                          <div className="text-sm flex items-center gap-3" style={{ color: 'var(--text-muted)' }}>
                            <Loader2 size={14} className="spin" />
                            {downloadProgress?.phase === 'extracting' ? 'Extracting...' : `Downloading... ${downloadProgress?.percent || 0}%`}
                            <button
                              className="btn btn-ghost btn-sm text-danger"
                              onClick={() => { window.api.cancelBackendDownload(); setDownloading(false); setDownloadProgress(null) }}
                              style={{ padding: '0 8px' }}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-primary btn-sm" onClick={() => handleDownloadTracked(t, release)}>
                            <Download size={13} /> Download
                          </button>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="tracker-release" style={{ color: 'var(--text-muted)' }}>
                    Click "Check for updates" to query GitHub for the latest release.
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Global check for updates button — single action for all tracked backends */}
        <div className="mt-4 pt-4 border-t">
          <button
            className="btn btn-secondary w-full justify-center"
            onClick={handleCheckAllBackends}
            disabled={checkingAllBackends || downloading}
          >
            <RefreshCw size={14} className={checkingAllBackends ? 'spin' : ''} />
            {checkingAllBackends ? 'Checking all backends...' : 'Check for updates (all backends)'}
          </button>
        </div>
      </div>
    </div>
  )
}

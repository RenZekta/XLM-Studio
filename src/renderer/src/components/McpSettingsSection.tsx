import React, { useEffect, useState } from 'react'
import { Boxes, Loader2 } from 'lucide-react'
import { MCP_TOOL_IDS, type McpSettings, type McpToolId } from '../../../shared/types'

const TOOL_LABELS: Record<McpToolId, string> = {
  'template-action': 'template-action — start/stop a Template',
  'info-templates': 'info-templates — list Templates, active state, ports',
  'info-models': 'info-models — list detected model files',
  'info-backends': 'info-backends — list installed backends',
  'info-tracked-backends': 'info-tracked-backends — tracked backend update status',
  'template-duplicate': 'template-duplicate — clone a Template',
  'template-create': 'template-create — create a new Template',
  'template-edit': 'template-edit — edit an existing Template',
  'total-ram': 'total-ram — total RAM / VRAM / combined',
  'free-ram': 'free-ram — free RAM / VRAM / combined',
  'apply-parameters-preset': 'apply-parameters-preset — Clean/Quick/FULL AUTO',
  'display-parameters-common': 'display-parameters-common — common param view',
  'display-parameters-full': 'display-parameters-full — full param view',
  'display-preview': 'display-preview — reconstructed launch command',
  'display-ts': 'display-ts — last-session tokens/sec',
  'benchmark': 'benchmark — 3-prompt speed test',
  'display-benchmark': 'display-benchmark — show past benchmark runs',
  'switch-template': 'switch-template — lifecycle-only start/stop chain'
}

export default function McpSettingsSection() {
  const [mcp, setMcp] = useState<McpSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillMsg, setSkillMsg] = useState<string | null>(null)

  useEffect(() => {
    window.api.getMcpSettings().then(setMcp).catch(() => {})
  }, [])

  async function persist(next: McpSettings) {
    setMcp(next)
    setSaving(true)
    try { await window.api.setMcpSettings(next) } finally { setSaving(false) }
  }

  if (!mcp) return null

  const toggleTool = (id: McpToolId) => {
    persist({ ...mcp, tools: { ...mcp.tools, [id]: !mcp.tools[id] } })
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Boxes /> MCP Server {saving && <Loader2 size={13} className="spin" />}</div>

      <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          Lets an MCP client (or the generated skill below) control XLM Studio: start/stop Templates, inspect models/backends/RAM/VRAM, create/edit Templates, apply presets, and benchmark. Listens on 127.0.0.1 only, protected by a per-install token.
        </p>
        <div className="mmproj-widget-row" style={{ width: '100%' }}>
          <span className="mmproj-widget-label">Enable MCP Server</span>
          <label className="toggle">
            <input type="checkbox" checked={mcp.enabled} onChange={() => persist({ ...mcp, enabled: !mcp.enabled })} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>
      </div>

      {mcp.enabled && (
        <>
          <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
            <div className="mmproj-widget-row" style={{ width: '100%' }}>
              <span className="mmproj-widget-label">Serve with a SKILL instead</span>
              <label className="toggle">
                <input type="checkbox" checked={mcp.skillMode} onChange={() => persist({ ...mcp, skillMode: !mcp.skillMode })} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              When ON, the live MCP protocol server is not started — instead, a skill (SKILL.md + a small CLI script) is written to <code>~/.agents/skills/xlm-studio</code> for skill-based agents (DSH, Claude Code, Codex, OpenCode, etc.) to use. The underlying control API keeps running either way, so the skill's script still needs XLM Studio open with MCP Server enabled.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                disabled={skillBusy}
                onClick={async () => {
                  setSkillBusy(true); setSkillMsg(null)
                  try {
                    const res = await window.api.addSkillFiles()
                    setSkillMsg(res.success ? 'Skill files written.' : (res.error || 'Failed to write skill files.'))
                  } finally { setSkillBusy(false) }
                }}
              >Add SKILL</button>
              <button
                className="btn btn-secondary btn-sm"
                disabled={skillBusy}
                onClick={async () => {
                  setSkillBusy(true); setSkillMsg(null)
                  try {
                    await window.api.removeSkillFiles()
                    setSkillMsg('Skill files removed.')
                  } finally { setSkillBusy(false) }
                }}
              >Remove SKILL</button>
              {skillMsg && <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>{skillMsg}</span>}
            </div>
          </div>

          <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <div className="mmproj-widget-row" style={{ width: '100%' }}>
              <span className="mmproj-widget-label">Only allow Template edits via MCP for MCP-made Templates</span>
              <label className="toggle">
                <input type="checkbox" checked={mcp.restrictEditToMcpMade} onChange={() => persist({ ...mcp, restrictEditToMcpMade: !mcp.restrictEditToMcpMade })} />
                <span className="toggle-track"></span><span className="toggle-thumb"></span>
              </label>
            </div>
          </div>

          <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
            <span className="mmproj-widget-label">Benchmark history to keep per Template</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
              <input
                type="range" min={1} max={20} step={1} value={mcp.maxBenchmarkHistory}
                style={{ flex: 1 }}
                onChange={(e) => persist({ ...mcp, maxBenchmarkHistory: Number(e.target.value) })}
              />
              <input
                type="number" min={1} max={20} step={1} value={mcp.maxBenchmarkHistory}
                className="form-input"
                style={{ width: 56, textAlign: 'center' }}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(20, Math.round(Number(e.target.value) || 1)))
                  persist({ ...mcp, maxBenchmarkHistory: n })
                }}
              />
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              How many of each Template's most recent benchmark runs are kept (1–20, default 5). Older runs are dropped automatically. See display-benchmark below.
            </p>
          </div>

          <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
            <span className="mmproj-widget-label" style={{ marginBottom: 4 }}>Tools</span>
            {MCP_TOOL_IDS.map(id => (
              <div className="mmproj-widget-row" style={{ width: '100%' }} key={id}>
                <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono, monospace)' }}>{TOOL_LABELS[id]}</span>
                <label className="toggle">
                  <input type="checkbox" checked={mcp.tools[id] !== false} onChange={() => toggleTool(id)} />
                  <span className="toggle-track"></span><span className="toggle-thumb"></span>
                </label>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

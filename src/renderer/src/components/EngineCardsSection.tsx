import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Download, FolderOpen, Puzzle, RefreshCw, ScanSearch, X } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { EngineCardInfo } from '../../../shared/engineCard'

// Engines described by a card file. Cards are plain JSON in the cards folder;
// a card that fails validation lists what to fix here and in a .errors.txt
// file beside it.
export default function EngineCardsSection() {
  const backends = useStore(s => s.backends)
  const [cards, setCards] = useState<EngineCardInfo[]>([])
  // The skill that teaches an agent to write a card, added and removed like the control skill under MCP.
  const [skill, setSkill] = useState<{ installed: boolean; dir: string } | null>(null)
  const [skillBusy, setSkillBusy] = useState(false)
  const [skillMsg, setSkillMsg] = useState<string | null>(null)
  // Installs in progress and their log, by card id.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [logs, setLogs] = useState<Record<string, string[]>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const logRef = useRef<HTMLPreElement | null>(null)

  const load = useCallback(() => {
    window.api.getEngineCards().then(setCards).catch(() => setCards([]))
  }, [])
  useEffect(() => { load() }, [load, backends])
  useEffect(() => { window.api.getCardSkillState().then(setSkill).catch(() => setSkill(null)) }, [])
  useEffect(() => {
    const offLog = window.api.onCardInstallLog(e => setLogs(l => ({ ...l, [e.id]: [...(l[e.id] ?? []).slice(-300), e.line] })))
    const offState = window.api.onCardInstallState(e => setBusy(b => ({ ...b, [e.id]: e.busy })))
    return () => { offLog(); offState() }
  }, [])
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [logs])

  async function skillAction(add: boolean) {
    setSkillBusy(true); setSkillMsg(null)
    try {
      if (add) {
        const res = await window.api.addCardSkill()
        setSkillMsg(res.success ? 'Skill files written.' : (res.error || 'Failed to write the skill files.'))
      } else {
        await window.api.removeCardSkill()
        setSkillMsg('Skill files removed.')
      }
      setSkill(await window.api.getCardSkillState())
    } finally { setSkillBusy(false) }
  }

  async function install(id: string) {
    setLogs(l => ({ ...l, [id]: [] })); setNotes(n => ({ ...n, [id]: '' }))
    const r = await window.api.installCardEngine(id)
    setNotes(n => ({ ...n, [id]: r.success ? 'Installed.' : (r.error || 'Install failed.') }))
  }

  async function checkFork(id: string) {
    const r = await window.api.checkForkCard(id)
    setNotes(n => ({
      ...n,
      [id]: r.error ?? (r.missing.length === 0
        ? `All ${r.checked} parameters are known to ${r.build}.`
        : `${r.build} does not mention: ${r.missing.join(', ')}. Check them against the fork.`)
    }))
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Puzzle /> Engine Cards</div>
      <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" className="btn btn-ghost" onClick={() => window.api.openEngineCardsFolder()}>
          <FolderOpen size={14} /> Open cards folder
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => window.api.refreshEngineCards().then(load)}>
          <RefreshCw size={14} /> Reload
        </button>
      </div>

      <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8, borderBottom: 'none', paddingLeft: 0, paddingRight: 0 }}>
        <div>
          <div className="settings-row-label">Skill for writing engine cards</div>
          <div className="settings-row-sub">
            Teaches a skill-based agent (Claude Code, Codex, OpenCode and others) to make a card for an engine from a request like "make a card for this engine (GitHub link) for XLM Studio (GitHub link)". It carries the card guide, a checker the agent runs on its card, and examples, and it tells the agent where this machine keeps cards and engines. It does not need MCP or XLM Studio to be running. Written to <code>{skill?.dir ?? '~/.agents/skills/xlm-studio-engine-card'}</code>
            {skill?.installed ? ' (added)' : ''}.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary btn-sm" disabled={skillBusy} onClick={() => skillAction(true)}>{skill?.installed ? 'Update SKILL' : 'Add SKILL'}</button>
          <button className="btn btn-secondary btn-sm" disabled={skillBusy || !skill?.installed} onClick={() => skillAction(false)}>Remove SKILL</button>
          {skillMsg && <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>{skillMsg}</span>}
        </div>
      </div>

      {cards.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No engine cards yet.</div>
      ) : (
        <div className="flex flex-col gap-2" style={{ width: '100%' }}>
          {cards.map(c => {
            const installed = c.valid && c.kind === 'engine' ? backends.filter(b => b.engine === c.id).length : 0
            const installable = c.valid && c.kind === 'engine' && !!(c.card?.source || c.card?.install)
            return (
              <div key={c.file} className="ext-folder-row" style={{ flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {c.label}
                    <span className="version-badge" style={{ marginLeft: 8 }}>{c.source}</span>
                    {c.replaces && <span className="version-badge" style={{ marginLeft: 6 }}>replaces built-in</span>}
                  </div>
                  {c.valid && c.kind === 'fork' ? (
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      llama.cpp fork {c.repo}{c.branch ? `@${c.branch}` : ''}, {c.paramCount} extra parameters. Install it in the Engine Tracker.
                    </div>
                  ) : c.valid ? (
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      {installed > 0
                        ? `${installed} installed`
                        : installable
                          ? `Not installed${c.card?.source ? `: Install clones ${c.card.source.repo}` : ''}${c.card?.install ? ' and runs its install steps' : ''}.`
                          : `Not installed: put the engine in engines/${c.folder}`}
                    </div>
                  ) : (
                    <div className="text-sm" style={{ color: 'var(--danger)' }}>
                      <AlertCircle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                      {c.file}
                      <ul style={{ margin: '4px 0 0 16px' }}>{c.errors.map(e => <li key={e}>{e}</li>)}</ul>
                    </div>
                  )}
                  {c.warnings.length > 0 && (
                    <ul className="text-sm" style={{ margin: '4px 0 0 16px', color: 'var(--warning)' }}>{c.warnings.map(w => <li key={w}>{w}</li>)}</ul>
                  )}
                  {notes[c.id] && <div className="text-sm" style={{ marginTop: 4, color: 'var(--text-muted)' }}>{notes[c.id]}</div>}
                </div>
                <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                  {installable && (busy[c.id]
                    ? <button type="button" className="btn btn-ghost" onClick={() => window.api.cancelCardInstall(c.id)}><X size={14} /> Cancel</button>
                    : <button type="button" className="btn btn-ghost" onClick={() => install(c.id)}><Download size={14} /> {installed > 0 ? 'Update' : 'Install'}</button>)}
                  {c.valid && c.kind === 'fork' && (
                    <button type="button" className="btn btn-ghost" onClick={() => checkFork(c.id)} title="Runs the installed build with --help and lists card parameters it does not mention">
                      <ScanSearch size={14} /> Check parameters
                    </button>
                  )}
                  {c.valid && c.kind === 'engine' && (
                    <button type="button" className="btn btn-ghost" onClick={() => window.api.openEngineFolder(c.id)}>
                      <FolderOpen size={14} /> Open engine folder
                    </button>
                  )}
                </div>
                {(busy[c.id] || (logs[c.id]?.length ?? 0) > 0) && (
                  <pre ref={logRef} className="mono" style={{ width: '100%', maxHeight: 160, overflow: 'auto', fontSize: 11, margin: '8px 0 0', padding: 8, background: 'var(--bg-tertiary, rgba(0,0,0,0.2))', borderRadius: 'var(--radius-sm)', whiteSpace: 'pre-wrap' }}>
                    {(logs[c.id] ?? []).join('\n')}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

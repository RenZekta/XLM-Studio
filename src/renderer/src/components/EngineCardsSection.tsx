import React, { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Copy, FolderOpen, Puzzle, RefreshCw } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { EngineCardInfo } from '../../../shared/engineCard'

// Engines described by a card file. Cards are plain JSON in the cards folder;
// a card that fails validation lists what to fix here and in a .errors.txt
// file beside it.
export default function EngineCardsSection() {
  const backends = useStore(s => s.backends)
  const [cards, setCards] = useState<EngineCardInfo[]>([])
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    window.api.getEngineCards().then(setCards).catch(() => setCards([]))
  }, [])
  useEffect(() => { load() }, [load, backends])

  async function copyPrompt() {
    const text = await window.api.getEngineCardPrompt()
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Puzzle /> Engine Cards</div>
      <div className="flex gap-2" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <button type="button" className="btn btn-ghost" onClick={() => window.api.openEngineCardsFolder()}>
          <FolderOpen size={14} /> Open cards folder
        </button>
        <button type="button" className="btn btn-ghost" onClick={copyPrompt}>
          <Copy size={14} /> {copied ? 'Copied' : 'Copy prompt for an agent'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => window.api.refreshEngineCards().then(load)}>
          <RefreshCw size={14} /> Reload
        </button>
      </div>
      {cards.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No engine cards yet.</div>
      ) : (
        <div className="flex flex-col gap-2" style={{ width: '100%' }}>
          {cards.map(c => {
            const installed = c.valid ? backends.filter(b => b.engine === c.id).length : 0
            return (
              <div key={c.file} className="ext-folder-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {c.label}
                    <span className="version-badge" style={{ marginLeft: 8 }}>{c.source}</span>
                    {c.replaces && <span className="version-badge" style={{ marginLeft: 6 }}>replaces built-in</span>}
                  </div>
                  {c.valid ? (
                    <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
                      {installed > 0 ? `${installed} installed` : `Not installed: put the engine in engines/${c.folder}`}
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
                </div>
                {c.valid && (
                  <button type="button" className="btn btn-ghost" onClick={() => window.api.openEngineFolder(c.id)}>
                    <FolderOpen size={14} /> Open engine folder
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

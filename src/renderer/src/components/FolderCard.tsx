import React, { useEffect, useRef, useState } from 'react'
import { Folder } from 'lucide-react'

interface Props {
  name: string
  templateCount: number
  folderCount: number
  selected: boolean
  cut: boolean
  dropTarget: boolean
  // Fills the height of its grid row instead of sitting at its own height.
  stretch: boolean
  // A Template inside it (or in a folder below it) is running.
  hasRunning: boolean
  renaming: boolean
  onRename: (name: string | null) => void
}

export default function FolderCard({ name, templateCount, folderCount, selected, cut, dropTarget, stretch, hasRunning, renaming, onRename }: Props) {
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)
  const settled = useRef(false)

  useEffect(() => {
    if (!renaming) return
    settled.current = false
    setDraft(name)
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() })
  }, [renaming])

  function finish(commit: boolean) {
    if (settled.current) return
    settled.current = true
    onRename(commit ? draft : null)
  }

  const parts = [
    folderCount ? `${folderCount} folder${folderCount === 1 ? '' : 's'}` : '',
    `${templateCount} template${templateCount === 1 ? '' : 's'}`
  ].filter(Boolean)

  return (
    <div className={`folder-card card-drag-region ${selected ? 'selected' : ''} ${cut ? 'card-cut' : ''} ${dropTarget ? 'folder-drop-target' : ''} ${stretch ? 'folder-stretch' : ''} ${hasRunning ? 'has-running' : ''}`}>
      <div className="card-icon"><Folder size={20} /></div>
      <div className="card-info">
        {renaming ? (
          <input
            ref={inputRef}
            className="folder-rename-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Enter') finish(true)
              else if (e.key === 'Escape') finish(false)
            }}
            onMouseDown={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
          />
        ) : (
          <h3 className="card-name" title={name}>{name}</h3>
        )}
        <p className="card-desc">{parts.join(' · ')}</p>
      </div>
    </div>
  )
}

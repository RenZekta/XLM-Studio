import React from 'react'
import { Trash, FolderPlus, FolderInput } from 'lucide-react'
import { StarIcon } from '../utils/format'

interface Props {
  folders: string[]
  mainFolder: string | null
  onAdd: () => Promise<any>
  onRemove: (folder: string) => Promise<any>
  onSetMain: (folder: string) => Promise<any>
  addLabel: string
  emptyText: string
  onAfterChange?: () => void
  // When provided, shows a "migrate" button (before the trash icon) on every
  // non-main row that moves that folder's model-group subfolders into the
  // main folder. Omitted entirely for the backend folder list, which has no
  // equivalent operation.
  onMigrate?: (folder: string) => Promise<any>
}

// A reusable list of external folders with star (main) selector, alphabetical
// sorting (main pinned to top), and deletion. Used for both model and backend
// external folder sections.
export default function ExternalFolderList({
  folders, mainFolder, onAdd, onRemove, onSetMain, addLabel, emptyText, onAfterChange, onMigrate
}: Props) {
  async function handleAdd() {
    await onAdd()
    onAfterChange?.()
  }
  async function handleRemove(folder: string) {
    await onRemove(folder)
    onAfterChange?.()
  }
  async function handleStar(folder: string) {
    // Clicking the star on the currently-main folder unstars it; clicking another
    // star makes it the main (and unstars the previous).
    const target = mainFolder === folder ? '' : folder
    await onSetMain(target)
    onAfterChange?.()
  }
  async function handleMigrate(folder: string) {
    if (!onMigrate) return
    const res = await onMigrate(folder)
    onAfterChange?.()
    if (res && res.success === false) {
      alert(`Migration failed: ${res.error || 'Unknown error'}`)
    } else if (res && Array.isArray(res.migrated)) {
      if (res.migrated.length === 0) alert('No model folders found to migrate.')
      else alert(`Migrated ${res.migrated.length} folder${res.migrated.length === 1 ? '' : 's'} to the main model folder.`)
    }
  }

  return (
    <>
      {folders.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>{emptyText}</div>
      ) : (
        <div className="flex flex-col gap-2" style={{ width: '100%' }}>
          {folders.map(f => {
            const isMain = mainFolder === f
            return (
              <div key={f} className={`ext-folder-row ${isMain ? 'is-main' : ''}`}>
                <button
                  className={`star-btn ${isMain ? 'is-main' : ''}`}
                  onClick={() => handleStar(f)}
                  title={isMain ? 'Main folder — click to unstar' : 'Set as main folder'}
                >
                  <StarIcon active={isMain} size={16} />
                </button>
                <div className="ext-folder-path">{f}</div>
                {isMain && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: '#d99e00',
                    background: 'rgba(245,180,0,.12)', border: '1px solid rgba(245,180,0,.3)',
                    borderRadius: 4, padding: '2px 7px', flexShrink: 0
                  }}>
                    MAIN
                  </span>
                )}
                {onMigrate && !isMain && (
                  <button
                    className="btn btn-ghost btn-icon"
                    onClick={() => handleMigrate(f)}
                    title="Migrate model folders (with models, mmproj or speculative-decoding heads) into the main folder"
                  >
                    <FolderInput size={14} />
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-icon text-danger"
                  onClick={() => handleRemove(f)}
                  title="Remove folder"
                >
                  <Trash size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}
      <button className="btn btn-secondary btn-sm" onClick={handleAdd}>
        <FolderPlus size={13} /> {addLabel}
      </button>
    </>
  )
}


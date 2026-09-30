import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Loader2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import DownloadRow from './DownloadRow'

// A single global place to see every active model download, regardless of
// whether it was started from Model Hub's search results, the "Download by
// URL" modal, or a paused download recovered from a previous session (see
// reconcileModelDownloadJournal in ipc.ts) -- all of them land in the one
// `modelDownloads` store slice now, so this is the one list that can show
// all of them correctly. Mounted in the Sidebar next to the Model Hub
// button, which stays rendered across every view, so it's visible
// regardless of where a download was started or which page the user is on.
//
// The panel renders through a portal into document.body rather than as a
// normal absolutely-positioned child: this button sits deep inside the
// sidebar's own scrollable/clipped layout, and a wide panel anchored with
// plain CSS positioning there doesn't get clipped so much as it pushes the
// whole app's layout wider, making the main window itself gain horizontal
// scroll instead of showing a floating overlay. A portal sidesteps that
// entirely -- the panel is a sibling of the whole app in the DOM, and its
// position is computed from the trigger button's own screen coordinates.
export default function DownloadsMenu() {
  const { modelDownloads } = useStore()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node
      if (btnRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const PANEL_WIDTH = 340
  const PANEL_MAX_HEIGHT = 420
  function toggleOpen() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      // Anchored from the top, growing downward, since this button sits
      // near the top of the sidebar -- anchoring from the bottom (growing
      // upward) would need ~400px of room above it that isn't there, and
      // the panel would render almost entirely above the visible window.
      // Still clamp against the bottom edge for a short window, and flip
      // above the button only if that truly has more room to offer.
      const roomBelow = window.innerHeight - r.bottom - 8
      const roomAbove = r.top - 8
      const top = roomBelow >= Math.min(PANEL_MAX_HEIGHT, roomAbove + roomBelow)
        ? r.bottom + 8
        : Math.max(8, r.top - Math.min(PANEL_MAX_HEIGHT, roomAbove))
      const left = Math.min(r.right + 8, window.innerWidth - PANEL_WIDTH - 16)
      setCoords({ left, top })
    }
    setOpen(v => !v)
  }

  const downloads = Object.values(modelDownloads).sort((a, b) => {
    // Active work first (downloading, then queued, then paused), problems
    // next, finished/cancelled last -- so the item most likely to need
    // attention is always the one at the top.
    const rank = (p: string) => ({ downloading: 0, queued: 1, paused: 2, error: 3, done: 4, cancelled: 5 }[p] ?? 6)
    return rank(a.phase) - rank(b.phase)
  })
  const activeCount = downloads.filter(d => d.phase === 'downloading' || d.phase === 'queued').length
  const hasAttention = downloads.some(d => d.phase === 'error')

  // Nothing to show and nothing running -- no point taking up a permanent
  // slot in the sidebar for a feature that has nothing to say right now.
  if (downloads.length === 0) return null

  return (
    <>
      <button
        ref={btnRef}
        className="btn btn-ghost btn-icon downloads-menu-btn"
        onClick={toggleOpen}
        title="Downloads"
      >
        {activeCount > 0 ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
        {activeCount > 0 && <span className="download-count-badge">{activeCount}</span>}
        {hasAttention && activeCount === 0 && <span className="download-count-badge danger">!</span>}
      </button>
      {open && coords && createPortal(
        <div
          ref={panelRef}
          className="dropdown-menu"
          style={{ position: 'fixed', left: coords.left, top: coords.top, width: 340, maxHeight: 420, overflowY: 'auto', padding: 8, zIndex: 9999 }}
        >
          {downloads.map(dl => <DownloadRow key={dl.id} dl={dl} />)}
        </div>,
        document.body
      )}
    </>
  )
}

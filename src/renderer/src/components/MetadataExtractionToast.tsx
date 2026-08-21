import React, { useState } from 'react'
import { useStore } from '../store/useStore'
import { Loader2, Database } from 'lucide-react'

// Item 2 (from an earlier request, finally implemented here): a single
// consolidated "Extracting model metadata" toast, instead of one stacked
// toast PER model. Hovering it reveals a vertical list of every model
// currently being extracted, rendered as an overlay ABOVE the rest of the
// app (so long model names never get clipped by the toast's own width or
// any container it sits in) rather than each name getting its own
// permanently-visible stacked toast.
export default function MetadataExtractionToast() {
  const { metadataExtractions } = useStore()
  const [hovered, setHovered] = useState(false)
  const entries = Object.values(metadataExtractions || {})
  const extracting = entries.filter(e => e.status === 'extracting')
  if (extracting.length === 0) return null

  return (
    <div
      style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9000 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* The hover-expanded list of individual model names — an absolutely
          positioned overlay anchored above the single toast, wide enough and
          unconstrained by any parent so full names are always readable. */}
      {hovered && (
        <div
          className="metadata-toast-list"
          style={{
            position: 'absolute',
            bottom: '100%',
            right: 0,
            marginBottom: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '10px 12px',
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            fontSize: 12,
            fontFamily: 'var(--font)',
            minWidth: 260,
            maxWidth: 480,
            maxHeight: '60vh',
            overflowY: 'auto',
            zIndex: 9001
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: 11, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Extracting ({extracting.length})
          </div>
          {extracting.map(e => (
            <div key={e.name} style={{ display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
              <Loader2 size={12} className="spin" style={{ color: 'var(--info-blue, #3b82f6)', flexShrink: 0 }} />
              <span>{e.name}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className="metadata-toast"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: 'var(--surface)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
          boxShadow: 'var(--shadow-md)',
          fontSize: 12, fontFamily: 'var(--font)',
          cursor: 'default'
        }}
      >
        <Loader2 size={15} className="spin" style={{ color: 'var(--info-blue, #3b82f6)', flexShrink: 0 }} />
        <Database size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <span>
          Extracting model metadata{extracting.length > 1 ? ` (${extracting.length})` : ''}…
        </span>
      </div>
    </div>
  )
}

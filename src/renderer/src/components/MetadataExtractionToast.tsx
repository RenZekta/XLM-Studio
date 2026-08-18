import React from 'react'
import { useStore } from '../store/useStore'
import { Loader2, Database } from 'lucide-react'

// Task 1: toast that shows "Model (name) metadata is being extracted" while
// the main process parses a newly-detected GGUF file. Reads the
// `metadataExtractions` store map (populated by the `metadata-extracting`
// IPC event). Auto-fades when extraction finishes (done/error entries are
// auto-cleared by the store). Positioned bottom-right, above the footer.
export default function MetadataExtractionToast() {
  const { metadataExtractions } = useStore()
  const entries = Object.values(metadataExtractions || {})
  const extracting = entries.filter(e => e.status === 'extracting')
  if (extracting.length === 0) return null
  return (
    <div style={{
      position: 'fixed', right: 16, bottom: 16, zIndex: 9000,
      display: 'flex', flexDirection: 'column', gap: 8,
      maxWidth: 340, pointerEvents: 'none'
    }}>
      {extracting.map((e, i) => (
        <div
          key={i}
          className="metadata-toast"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 14px',
            background: 'var(--surface)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            fontSize: 12, fontFamily: 'var(--font)',
            pointerEvents: 'auto'
          }}
        >
          <Loader2 size={15} className="spin" style={{ color: 'var(--info-blue, #3b82f6)', flexShrink: 0 }} />
          <Database size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Model <strong style={{ fontWeight: 600 }}>{e.name}</strong> metadata is being extracted…
          </span>
        </div>
      ))}
    </div>
  )
}

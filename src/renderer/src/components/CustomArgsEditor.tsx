import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal, Download } from 'lucide-react'
import type { CommandsSchema } from '../../../shared/types'
import { classifyCustomArgs } from '../../../shared/customArgs'

// Matches the .custom-args-input font size and line height in global.css.
const LINE_PX = 19.5
const PAD_Y = 16
const BORDER = 3
// Auto-growth stops at the height of the Jinja chat template box.
const MAX_AUTO_LINES = 9.5
const MIN_HEIGHT = LINE_PX + PAD_Y + BORDER
const MAX_AUTO_HEIGHT = Math.round(MAX_AUTO_LINES * LINE_PX + PAD_Y + BORDER)

interface Props {
  value: string
  schema: CommandsSchema | null | undefined
  disabled?: boolean
  onChange: (value: string) => void
  onImport: () => void
}

export default function CustomArgsEditor({ value, schema, disabled, onChange, onImport }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  // Height the component last set itself; a different measured height means
  // the user dragged the resize handle, after which growth is left to them.
  const autoHeightRef = useRef(MIN_HEIGHT)
  const [manualHeight, setManualHeight] = useState<number | null>(null)

  const entries = useMemo(() => classifyCustomArgs(value, schema), [value, schema])
  const supportedCount = entries.filter(e => e.kind === 'supported').length
  const reservedCount = entries.filter(e => e.kind === 'reserved').length

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    if (value === '' && manualHeight !== null) { setManualHeight(null); return }
    if (manualHeight !== null) { ta.style.height = `${manualHeight}px`; return }
    ta.style.height = '0px'
    const h = Math.min(MAX_AUTO_HEIGHT, Math.max(MIN_HEIGHT, ta.scrollHeight + BORDER))
    ta.style.height = `${h}px`
    autoHeightRef.current = h
  }, [value, manualHeight])

  function syncScroll() {
    if (mirrorRef.current && taRef.current) mirrorRef.current.scrollTop = taRef.current.scrollTop
  }

  function noteManualResize() {
    const ta = taRef.current
    if (!ta || manualHeight !== null) return
    if (Math.abs(ta.offsetHeight - autoHeightRef.current) > 2) setManualHeight(ta.offsetHeight)
  }

  const segments = useMemo(() => {
    const out: React.ReactNode[] = []
    let pos = 0
    for (const e of entries) {
      if (e.kind === 'custom') continue
      if (e.start > pos) out.push(value.slice(pos, e.start))
      out.push(
        <span key={e.start} className={e.kind === 'supported' ? 'custom-args-supported' : 'custom-args-reserved'}>
          {value.slice(e.start, e.end)}
        </span>
      )
      pos = e.end
    }
    out.push(value.slice(pos))
    return out
  }, [entries, value])

  return (
    <div className="mmproj-widget">
      <div className="mmproj-widget-title"><Terminal size={15} /> Custom Arguments</div>
      <div className="mmproj-widget-arg">Flags missing from the parameter list · added to the launch command as typed</div>
      <div className="custom-args-box" style={{ marginTop: 10 }}>
        <div className="custom-args-mirror" ref={mirrorRef} aria-hidden="true">{segments}{' '}</div>
        <textarea
          ref={taRef}
          className="custom-args-input"
          value={value}
          spellCheck={false}
          disabled={disabled}
          placeholder="--flag value, one or more per line"
          onChange={e => onChange(e.target.value)}
          onScroll={syncScroll}
          onMouseUp={noteManualResize}
        />
      </div>
      {supportedCount > 0 && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onImport} disabled={disabled}
            title="Moves the highlighted flags into their own controls above and removes them from this box">
            <Download size={12} /> Import detected tags ({supportedCount})
          </button>
        </div>
      )}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
        {supportedCount > 0
          ? 'Highlighted flags have their own controls above. They stay in the command as typed until imported.'
          : 'Anything typed here is appended to the command after the parameters above.'}
        {reservedCount > 0 && ' Flags marked in orange (-m, --model, --port) are set by the Template itself and left out of the command.'}
      </div>
    </div>
  )
}

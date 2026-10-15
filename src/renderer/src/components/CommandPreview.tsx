import React, { useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'

// The launch command shown under a Template's parameters, shared by every
// engine's editor. Each editor turns its runtime arguments (overrides already
// applied) into tokens; this component owns how they are shown and copied.

export interface PreviewToken {
  flag: string
  // Absent for a bare switch.
  value?: string | number
  // Set by a global override, shown highlighted with `title` as the reason.
  overridden?: boolean
  title?: string
}

interface Props {
  program: string
  tokens: PreviewToken[]
}

// Values with spaces get quotes in the copied text; one that already starts
// with a quote (a model path the editor quoted itself) is left alone.
function text(value: string | number): string {
  const v = String(value)
  return /\s/.test(v) && !v.startsWith('"') ? `"${v}"` : v
}

export default function CommandPreview({ program, tokens }: Props) {
  const [stacked, setStacked] = useState(false)
  const [copied, setCopied] = useState(false)

  const inlineText = useMemo(
    () => [program, ...tokens.map(t => (t.value === undefined ? t.flag : `${t.flag} ${text(t.value)}`))].join(' '),
    [program, tokens]
  )
  // One flag per line with backslash continuations (shell-script style), for
  // readability with long commands.
  const stackedText = useMemo(() => {
    const lines = [program, ...tokens.map(t => (t.value === undefined ? t.flag : `${t.flag} ${text(t.value)}`))]
    return lines.map((l, i) => `${i === 0 ? '' : '  '}${l}${i === lines.length - 1 ? '' : ' \\'}`).join('\n')
  }, [program, tokens])

  const selectable: React.CSSProperties = { userSelect: 'text', WebkitUserSelect: 'text', cursor: 'text' }

  return (
    <div className="cmd-section" style={{ marginBottom: 0, marginTop: 16 }}>
      <div className="cmd-section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Preview</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer' }}
            title="Show as a vertical stack of flags instead of one continuous line."
          >
            <input type="checkbox" checked={stacked} onChange={e => setStacked(e.target.checked)} />
            Stacked view
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              navigator.clipboard.writeText(stacked ? stackedText : inlineText).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }}
            title="Copy command to clipboard"
            style={{ width: 26, height: 26 }}
          >
            {copied ? <Check size={13} style={{ color: 'var(--success)' }} /> : <Copy size={13} />}
          </button>
        </div>
      </div>
      {stacked ? (
        <pre className="cmd-preview cmd-preview-stacked" style={selectable}>{stackedText}</pre>
      ) : (
        <div className="cmd-preview" style={selectable}>
          <span>{program}</span>
          {tokens.map(t => (
            <React.Fragment key={t.flag}>
              {' '}
              <span className="arg">{t.flag}</span>
              {t.value !== undefined && (
                <>
                  {' '}
                  <span className={t.overridden ? 'val cmd-preview-overridden' : 'val'} title={t.title}>{t.value}</span>
                </>
              )}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

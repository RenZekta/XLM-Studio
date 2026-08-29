import React from 'react'

// Custom HTML title bar removed. Only a minimal drag region
// remains so the native OS window frame can be used. The "Check for updates"
// button has been removed; updates are now checked silently on startup.
const IS_MACOS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
export default function Titlebar() {
  return (
    <header className={`titlebar${IS_MACOS ? ' titlebar-macos' : ''}`} style={{ height: 32 }}>
      <div className="titlebar-drag-region" />
    </header>
  )
}

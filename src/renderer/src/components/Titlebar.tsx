import React from 'react'

// The native OS window frame provides the title and the window controls on
// Windows and Linux, so an extra bar under it would only be empty space (update
// notifications render below it, and stack there, so it never needed to be
// reserved for them). macOS is the exception: the window uses 'hiddenInset', so
// the traffic lights sit inside the content and need a drag strip of their own.
const IS_MACOS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
export default function Titlebar() {
  if (!IS_MACOS) return null
  return (
    <header className="titlebar titlebar-macos" style={{ height: 32 }}>
      <div className="titlebar-drag-region" />
    </header>
  )
}

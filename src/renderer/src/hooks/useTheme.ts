import { useEffect } from 'react'
import { useStore } from '../store/useStore'
import type { ThemePref } from '../../../shared/types'

// Applies the persisted theme to <html data-theme="..."> and keeps it in sync
// with native + system changes. Default = "system"; falls back to "dark" if the
// system theme cannot be determined.
export function useTheme() {
  const theme = useStore(s => s.theme)
  const setTheme = useStore(s => s.setTheme)
  const setSystemTheme = useStore(s => s.setSystemTheme)

  useEffect(() => {
    let cancelled = false
    async function init() {
      // 1. Load persisted preference from the main process (source of truth).
      let pref: ThemePref
      try {
        pref = await window.api?.getTheme() ?? 'system'
      } catch {
        pref = 'dark' // fallback per spec
      }
      if (cancelled) return
      setTheme(pref)
      applyToDom(pref)

      // 2. Determine the current system theme for the "Match System" mode.
      try {
        const sys = await window.api?.getSystemTheme()
        if (!cancelled) setSystemTheme(sys ?? 'dark')
      } catch {
        if (!cancelled) setSystemTheme('dark') // fallback per spec
      }
    }
    init()

    // 3. React to theme changes originating from other windows / settings.
    const onThemeChanged = (t: ThemePref) => {
      setTheme(t)
      applyToDom(t)
    }
    try { window.api?.onThemeChanged(onThemeChanged) } catch {}

    // 4. React to OS theme changes when in "system" mode.
    let mql: MediaQueryList | null = null
    const onSysChange = () => {
      if (useStore.getState().theme === 'system') {
        applyToDom('system')
        setSystemTheme(mql?.matches ? 'dark' : 'light')
      }
    }
    try {
      mql = window.matchMedia('(prefers-color-scheme: dark)')
      mql.addEventListener('change', onSysChange)
    } catch {
      // matchMedia unavailable — fall back to dark.
      setSystemTheme('dark')
    }

    return () => {
      cancelled = true
      try { window.api?.removeThemeListener() } catch {}
      try { mql?.removeEventListener('change', onSysChange) } catch {}
    }
  }, [setTheme, setSystemTheme])

  // Re-apply whenever the in-memory theme state changes.
  useEffect(() => {
    applyToDom(theme)
  }, [theme])

  return { theme, setTheme }
}

export function applyToDom(theme: ThemePref) {
  const root = document.documentElement
  root.setAttribute('data-theme', theme)
  // Update the theme-color meta for window chrome if present.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
    meta.setAttribute('content', dark ? '#0e0e10' : '#f5f5f5')
  }
}

export async function changeTheme(theme: ThemePref) {
  useStore.getState().setTheme(theme)
  applyToDom(theme)
  try { await window.api?.setTheme(theme) } catch {}
}

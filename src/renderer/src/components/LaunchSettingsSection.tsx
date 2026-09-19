import React, { useEffect, useState } from 'react'
import { Rocket, Loader2 } from 'lucide-react'

export default function LaunchSettingsSection() {
  const [launchOnStartup, setLaunchOnStartup] = useState<boolean | null>(null)
  const [autostartMainTemplates, setAutostartMainTemplates] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.api.getLaunchSettings().then(s => {
      setLaunchOnStartup(s.launchOnStartup)
      setAutostartMainTemplates(s.autostartMainTemplates)
    }).catch(() => {})
  }, [])

  if (launchOnStartup === null || autostartMainTemplates === null) return null

  async function handleToggleStartup() {
    const next = !launchOnStartup
    setLaunchOnStartup(next)
    setSaving(true)
    try { await window.api.setLaunchOnStartup(next) } finally { setSaving(false) }
  }

  async function handleToggleAutostart() {
    const next = !autostartMainTemplates
    setAutostartMainTemplates(next)
    setSaving(true)
    try { await window.api.setAutostartMainTemplates(next) } finally { setSaving(false) }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title"><Rocket /> Launch {saving && <Loader2 size={13} className="spin" />}</div>

      <div className="settings-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
        <div className="mmproj-widget-row" style={{ width: '100%' }}>
          <span className="mmproj-widget-label">Launch XLM-Studio on startup</span>
          <label className="toggle">
            <input type="checkbox" checked={launchOnStartup} onChange={handleToggleStartup} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>

        <div className="mmproj-widget-row" style={{ width: '100%' }}>
          <span className="mmproj-widget-label">Autostart main Templates upon XLM-Studio launch</span>
          <label className="toggle">
            <input type="checkbox" checked={autostartMainTemplates} onChange={handleToggleAutostart} />
            <span className="toggle-track"></span><span className="toggle-thumb"></span>
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Starts every Template starred as the Main Template for its port (see the star option on a Template's "..." menu) as soon as the app launches.
        </p>
      </div>
    </div>
  )
}

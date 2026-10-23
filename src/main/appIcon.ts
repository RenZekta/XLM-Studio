import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

// The icon of every window the app opens. A packaged app has no assets folder
// (the build only carries out/ and the files listed under extraResources), so
// the icon ships next to the app as resources/icon.png; while developing, it
// is read from assets/.
export function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icon.png'),
    join(process.cwd(), 'assets', 'icon_256.png'),
    join(app.getAppPath(), 'assets', 'icon_256.png')
  ]
  return candidates.find(existsSync)
}

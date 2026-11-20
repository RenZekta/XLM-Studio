import { existsSync } from 'fs'
import { join } from 'path'

// Strata 0.2.16 moved the Terminal's sources, its .venv and the run configs it
// writes from the clone root into terminal/. The launchers (START-HERE.bat,
// setup.sh) stay at the root and enter terminal/ themselves. An older clone
// keeps everything at the root, so both layouts are read.

export const GIT_ENGINE_MARKERS = ['setup.py', 'serve/server.py']

// The folder that holds setup.py, serve/, data/, strata.py, .venv and the run configs.
export function strataSourceDir(clone: string): string {
  return existsSync(join(clone, 'terminal', 'setup.py')) ? join(clone, 'terminal') : clone
}

export function looksLikeStrataClone(dir: string): boolean {
  const src = strataSourceDir(dir)
  return GIT_ENGINE_MARKERS.every(m => existsSync(join(src, ...m.split('/'))))
}

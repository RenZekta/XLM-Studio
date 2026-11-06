import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { NATIVE_PLATFORM } from './buildPlatform'
import type { BuildPlatform } from '../shared/assetPlatform'

// Where a repo is cloned and compiled, kept apart for each OS.
//
// An engines folder can be shared by several systems (dual boot). A clone and a
// CMake build tree are not portable between them: a tree remembers absolute
// paths ("a:/AI/..." against "/mnt/Alpha/AI/..."), and a clone carries the
// other system's line endings and a node_modules with its native packages. A
// tree that is reused across systems fails to configure, and clearing it to
// get going again destroys what the other system built. So each OS gets its own:
//
//   <repo>/.work/<os>/source/        the clone
//   <repo>/.work/<os>/build/<type>/  CMake build tree (kept so a rebuild is incremental)
//
// Folders made before this was done (<repo>/.source and <repo>/.build/<type>)
// stay where they are, as the working folders of the OS that made the clone;
// moving a build tree would break its cache, and rebuilding is the slow part.
// <repo>/<type>/<version>/, the installed builds, are shared: each version
// folder says which OS it is for (see buildPlatform.ts).

export const SOURCE_DIRNAME = '.source'
export const BUILD_DIRNAME = '.build'
export const WORK_DIRNAME = '.work'

// Which OS made a clone, read from its git config: git writes different
// settings on each system when it creates a repository. Null when the config
// is missing or says nothing (a worktree or submodule, an odd configuration).
export function cloneOsOf(srcDir: string): BuildPlatform | null {
  let text: string
  try { text = readFileSync(join(srcDir, '.git', 'config'), 'utf8') } catch { return null }
  const set = (key: string, value: string) => new RegExp(`^\\s*${key}\\s*=\\s*${value}\\s*$`, 'mi').test(text)
  if (set('precomposeunicode', 'true')) return 'macos'
  if (set('symlinks', 'false') || set('ignorecase', 'true')) return 'windows'
  if (set('filemode', 'true')) return 'linux'
  return null
}

export interface WorkDirs {
  os: BuildPlatform
  // True for the folders from before builds were kept per OS.
  legacy: boolean
  source: string
  buildRoot: string
  build: (type: string) => string
}

// The working folders of `os` (this OS by default) for a repo folder.
export function workDirs(forkDir: string, os: BuildPlatform = NATIVE_PLATFORM): WorkDirs {
  const legacySource = join(forkDir, SOURCE_DIRNAME)
  // A clone whose system cannot be told is taken to be this one's.
  const ownsLegacy = existsSync(legacySource) && (cloneOsOf(legacySource) ?? os) === os
  const buildRoot = ownsLegacy ? join(forkDir, BUILD_DIRNAME) : join(forkDir, WORK_DIRNAME, os, 'build')
  return {
    os,
    legacy: ownsLegacy,
    source: ownsLegacy ? legacySource : join(forkDir, WORK_DIRNAME, os, 'source'),
    buildRoot,
    build: type => join(buildRoot, type)
  }
}

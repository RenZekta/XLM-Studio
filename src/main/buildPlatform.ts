import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { buildPlatformOfHost, type BuildPlatform } from '../shared/assetPlatform'

// Which OS an installed build is for. A shared engines folder (dual boot) can
// hold Windows and Linux builds of the same release under the same
// <repo>/<type>/ folder, so every install, cleanup, delete and status check
// must look at the platform of the build it touches.

export const NATIVE_PLATFORM: BuildPlatform = buildPlatformOfHost(process.platform)

// Windows builds always carry .exe/.dll files, macOS ones .dylib, Linux ones
// .so libraries. Null when nothing in the folder says which.
export function detectBuildPlatform(dir: string, depth = 0): BuildPlatform | null {
  let entries: import('fs').Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  let sawMac = false
  let sawLinux = false
  for (const e of entries) {
    if (!e.isFile()) continue
    const n = e.name.toLowerCase()
    if (n.endsWith('.exe') || n.endsWith('.dll')) return 'windows'
    if (n.endsWith('.dylib')) sawMac = true
    else if (/\.so(\.|$)/.test(n)) sawLinux = true
  }
  if (sawMac) return 'macos'
  if (sawLinux) return 'linux'
  if (depth < 3) {
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const found = detectBuildPlatform(join(dir, e.name), depth + 1)
      if (found) return found
    }
  }
  return null
}

const cache = new Map<string, BuildPlatform>()

// Cached per folder and its modification time, so listing installs stays cheap
// and a folder that was replaced is read again. A build with no tell-tale
// files is taken to be native (a static Unix binary).
export function platformOfBuildDir(dir: string): BuildPlatform {
  let key = dir
  try { key = `${dir}|${statSync(dir).mtimeMs}` } catch { /* folder vanished */ }
  const hit = cache.get(key)
  if (hit) return hit
  const platform = detectBuildPlatform(dir) ?? NATIVE_PLATFORM
  cache.set(key, platform)
  return platform
}

// The folder name a new install goes by. It is the release tag, unless that
// folder already holds a build made for another OS: that build is never
// replaced, so this one gets a platform suffix instead (version parsing only
// reads the digits, so the suffix does not disturb update checks).
export function installVersionName(typeDir: string, versionHint: string): string {
  const taken = join(typeDir, versionHint)
  if (existsSync(taken) && platformOfBuildDir(taken) !== NATIVE_PLATFORM) return `${versionHint}-${NATIVE_PLATFORM}`
  return versionHint
}

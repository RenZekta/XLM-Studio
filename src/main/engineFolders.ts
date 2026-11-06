import { existsSync, readdirSync, promises as fsPromises } from 'fs'
import { dirname, join } from 'path'
import { cloneOsOf, WORK_DIRNAME } from './workDirs'

// Moves what an engine folder holds into another folder of the same engine:
// used when two tracker entries turn out to be the same repo (a custom entry
// made before the repo became built-in), so its installs end up where the
// engine's downloads and builds are listed together.

export const BACKEND_TYPE_MARKER_NAME = '.xlm-backend-type'

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fsPromises.rename(from, to)
  } catch (err) {
    // Another drive: copy, then remove.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fsPromises.cp(from, to, { recursive: true, verbatimSymlinks: true })
    await fsPromises.rm(from, { recursive: true, force: true })
  }
}

export interface MergeReport {
  moved: string[]
  dropped: string[]
  failed: string[]
}

// <root>/<from>/<type>/<version> -> <root>/<to>/<type>/<version>, for every
// root. A version that is already in the target stays as it is there and the
// duplicate is dropped. A clone moves if the target has none for the same OS
// (.source, made before clones were kept per OS, belongs to the OS that cloned
// it; .work/<os>/source to <os>); the CMake build trees (.build and
// .work/<os>/build) are dropped, since they hold absolute paths of the old
// place and only speed up a rebuild.
export async function mergeEngineFolder(rootDirs: string[], from: string, to: string): Promise<MergeReport> {
  const report: MergeReport = { moved: [], dropped: [], failed: [] }
  if (from.toLowerCase() === to.toLowerCase()) return report
  for (const root of rootDirs) {
    const src = join(root, from)
    const dst = join(root, to)
    if (!existsSync(src)) continue
    await fsPromises.mkdir(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(src, entry.name)
      try {
        if (entry.name === '.build') {
          await fsPromises.rm(path, { recursive: true, force: true })
          report.dropped.push(path)
        } else if (entry.name === '.source') {
          // A target that has a clone for the same OS, old-style or new, keeps it.
          const os = cloneOsOf(path)
          const covered = existsSync(join(dst, '.source')) || (!!os && existsSync(join(dst, WORK_DIRNAME, os, 'source')))
          if (covered) { await fsPromises.rm(path, { recursive: true, force: true }); report.dropped.push(path) }
          else { await moveDir(path, join(dst, '.source')); report.moved.push(path) }
        } else if (entry.name === WORK_DIRNAME) {
          for (const osDir of readdirSync(path, { withFileTypes: true })) {
            if (!osDir.isDirectory()) continue
            const from3 = join(path, osDir.name, 'source')
            const to3 = join(dst, WORK_DIRNAME, osDir.name, 'source')
            const covered = existsSync(to3) || (cloneOsOf(join(dst, '.source')) ?? '') === osDir.name
            if (existsSync(from3) && !covered) {
              await fsPromises.mkdir(dirname(to3), { recursive: true })
              await moveDir(from3, to3)
              report.moved.push(from3)
            }
          }
          await fsPromises.rm(path, { recursive: true, force: true })
          report.dropped.push(path)
        } else if (!entry.name.startsWith('.')) {
          const typeDst = join(dst, entry.name)
          await fsPromises.mkdir(typeDst, { recursive: true })
          for (const v of readdirSync(path, { withFileTypes: true })) {
            const from2 = join(path, v.name)
            if (v.name === BACKEND_TYPE_MARKER_NAME) {
              if (!existsSync(join(typeDst, v.name))) await moveDir(from2, join(typeDst, v.name))
              continue
            }
            if (!v.isDirectory()) continue
            if (existsSync(join(typeDst, v.name))) { await fsPromises.rm(from2, { recursive: true, force: true }); report.dropped.push(from2) }
            else { await moveDir(from2, join(typeDst, v.name)); report.moved.push(from2) }
          }
          // The type folder is empty now but for its marker.
          await fsPromises.rm(path, { recursive: true, force: true })
        }
      } catch {
        report.failed.push(path)
      }
    }
    // The old folder goes once nothing is left in it.
    if (readdirSync(src).length === 0) await fsPromises.rm(src, { recursive: true, force: true })
  }
  return report
}

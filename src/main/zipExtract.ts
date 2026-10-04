import { createWriteStream, mkdirSync } from 'fs'
import { dirname, join, relative, resolve, isAbsolute } from 'path'
import { pipeline } from 'stream/promises'
import yauzl from 'yauzl'

// Zip entries are untrusted: names may contain "..", absolute paths, or mark
// the entry as a symlink. Symlink entries are skipped (backend archives do not
// need them) and any path that resolves outside the target dir is rejected.
export function extractZip(archivePath: string, dir: string): Promise<void> {
  const root = resolve(dir)
  return new Promise<void>((resolveDone, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, autoClose: true }, (openErr, zip) => {
      if (openErr || !zip) return reject(openErr ?? new Error('Failed to open archive'))
      let settled = false
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        zip.close()
        reject(err)
      }
      zip.on('error', fail)
      zip.on('end', () => {
        if (settled) return
        settled = true
        resolveDone()
      })
      zip.on('entry', (entry: yauzl.Entry) => {
        const target = resolve(join(root, entry.fileName))
        const rel = relative(root, target)
        if (rel.startsWith('..') || isAbsolute(rel)) {
          return fail(new Error(`Archive entry escapes target directory: ${entry.fileName}`))
        }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
        const isSymlink = (unixMode & 0o170000) === 0o120000
        if (entry.fileName.endsWith('/')) {
          mkdirSync(target, { recursive: true })
          return zip.readEntry()
        }
        if (isSymlink) return zip.readEntry()
        mkdirSync(dirname(target), { recursive: true })
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return fail(streamErr ?? new Error('Failed to read entry'))
          const mode = unixMode & 0o777
          pipeline(stream, createWriteStream(target, { mode: mode || 0o644 }))
            .then(() => zip.readEntry())
            .catch(fail)
        })
      })
      zip.readEntry()
    })
  })
}

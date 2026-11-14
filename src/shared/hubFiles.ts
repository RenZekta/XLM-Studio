// The GGUF files of a Hugging Face repo, grouped into what the user actually
// chooses between: one file, or a model split into numbered shards
// ("name-00001-of-00004.gguf") that only work together.
import { parseShardName } from './ggufShards'

export interface HubFile {
  name: string        // path inside the repo
  size: number
  downloadUrl: string
}

export interface HubEntry {
  key: string
  title: string       // the file name; for a shard set, the name without its shard suffix
  folder: string      // repo folder the files sit in, '' for the root
  support: boolean    // a vision projector or a speculative-decoding head rather than a model
  shards: HubFile[]   // in shard order; one item for a single file
  shardCount: number  // how many parts the file names promise, 1 for a single file
  size: number        // of the listed shards
  complete: boolean   // every promised shard is listed
  modelFolder: string // folder under the models directory the files are downloaded into
}

const SUPPORT_NAME_RE = /mmproj|mtp|draft|eagle|dflash|dspark|lilicorr/i
const MMPROJ_RE = /mmproj/i
const SUPPORT_FOLDER_RE = /^(mmproj|mtp|draft|eagle3?|dflash2?|dspark2?|lilicorr)$/i
// Same bound the Models tab uses to tell a speculative-decoding head from a
// full model that merely has "mtp" in its name.
const SUPPORT_MAX_BYTES = 4 * 1024 ** 3

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

export function groupHubFiles(files: HubFile[], repoName: string): HubEntry[] {
  // Files from different repo folders land in one model folder, so two with
  // the same name would overwrite each other; a folder holding such a file
  // gets a model folder of its own.
  const dirsByBase = new Map<string, Set<string>>()
  for (const f of files) {
    const base = baseOf(f.name).toLowerCase()
    if (!dirsByBase.has(base)) dirsByBase.set(base, new Set())
    dirsByBase.get(base)!.add(dirOf(f.name))
  }
  const clashingDirs = new Set<string>()
  for (const f of files) {
    if (dirsByBase.get(baseOf(f.name).toLowerCase())!.size > 1 && dirOf(f.name)) clashingDirs.add(dirOf(f.name))
  }

  const entries = new Map<string, HubEntry>()
  const indexes = new Map<string, number[]>()
  for (const f of files) {
    const folder = dirOf(f.name)
    const base = baseOf(f.name)
    const shard = parseShardName(base)
    const shardCount = shard ? shard.total : 1
    const key = shard ? `${folder}/${shard.prefix}-of-${shardCount}` : f.name
    let entry = entries.get(key)
    if (!entry) {
      entry = {
        key, title: shard ? shard.prefix : base, folder, support: false, shards: [], shardCount,
        size: 0, complete: true,
        modelFolder: clashingDirs.has(folder) ? `${repoName}-${folder.replace(/\//g, '-')}` : repoName
      }
      entries.set(key, entry)
      indexes.set(key, [])
    }
    entry.shards.push(f)
    indexes.get(key)!.push(shard ? shard.index : 1)
  }

  const models: HubEntry[] = []
  const support: HubEntry[] = []
  for (const entry of entries.values()) {
    const order = indexes.get(entry.key)!
    const ranked = entry.shards.map((f, i) => ({ f, n: order[i] })).sort((a, b) => a.n - b.n)
    entry.shards = ranked.map(r => r.f)
    entry.size = entry.shards.reduce((sum, f) => sum + f.size, 0)
    entry.complete = ranked.length === entry.shardCount && ranked.every((r, i) => r.n === i + 1)
    entry.support = entry.shards.some(f => MMPROJ_RE.test(f.name)) ||
      entry.folder.split('/').some(part => SUPPORT_FOLDER_RE.test(part)) ||
      (SUPPORT_NAME_RE.test(entry.shards[0].name) && entry.size <= SUPPORT_MAX_BYTES)
    ;(entry.support ? support : models).push(entry)
  }
  return [...models, ...support]
}

// A GGUF model split into numbered shards: "name-00001-of-00004.gguf" up to
// "name-00004-of-00004.gguf". llama.cpp loads the set from its first shard.
import type { ModelEntry } from './types'

const SHARD_NAME_RE = /^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i

export interface ShardName {
  prefix: string   // the file name without the shard suffix and extension
  index: number    // 1-based
  total: number
  ext: string      // as written in the file name
}

export function parseShardName(fileName: string): ShardName | null {
  const m = SHARD_NAME_RE.exec(fileName)
  return m ? { prefix: m[1], index: parseInt(m[2], 10), total: parseInt(m[3], 10), ext: m[4] } : null
}

export function shardName(set: Pick<ShardName, 'prefix' | 'total' | 'ext'>, index: number): string {
  return `${set.prefix}-${String(index).padStart(5, '0')}-of-${String(set.total).padStart(5, '0')}${set.ext}`
}

// Folds the shards of each set into one entry named after the set. Its path is
// the first shard present (the one a template points at) and its size is that
// of the shards present; `shards` says how many of the promised ones exist.
// Entries that are not shards pass through, and order follows first appearance.
export function groupShardedModels(files: ModelEntry[]): ModelEntry[] {
  type Member = { file: ModelEntry; shard: ShardName }
  const sets = new Map<string, Member[]>()
  const order: Array<ModelEntry | string> = []
  for (const file of files) {
    const shard = parseShardName(file.name)
    if (!shard || shard.total < 2 || shard.index < 1 || shard.index > shard.total) {
      order.push(file)
      continue
    }
    const key = `${shard.prefix.toLowerCase()}|${shard.total}|${shard.ext.toLowerCase()}`
    if (!sets.has(key)) {
      sets.set(key, [])
      order.push(key)
    }
    sets.get(key)!.push({ file, shard })
  }
  return order.map(item => {
    if (typeof item !== 'string') return item
    const members = sets.get(item)!.sort((a, b) => a.shard.index - b.shard.index)
    const { prefix, total, ext } = members[0].shard
    const present = new Set(members.map(m => m.shard.index)).size
    return {
      name: `${prefix}${ext}`,
      path: members[0].file.path,
      size: members.reduce((sum, m) => sum + m.file.size, 0),
      shards: { present, total, files: members.map(m => m.file) }
    }
  })
}

// Whether a model entry is, or contains, the file at this path. A template
// saved before shards were grouped may name a shard other than the first.
export function modelEntryHasPath(entry: ModelEntry, path: string): boolean {
  return entry.path === path || !!entry.shards?.files.some(f => f.path === path)
}

import { open, stat } from 'fs/promises'
import { existsSync } from 'fs'
import {
  ggmlTypeName, summarizeStrataTensors,
  type StrataFingerprint, type StrataTensor
} from '../shared/strata'

// Reads the tensor table of a GGUF file from its header alone (a few MB even
// for a 70 GB model). Stored sizes come from the offsets, like quantscope, so
// they are exact for every tensor type including ones nobody has named yet.

const CHUNK = 1 << 20
// Byte size of each fixed-width GGUF metadata value type; strings (8) and
// arrays (9) are variable.
const FIXED_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 }

class HeaderReader {
  private buf = Buffer.alloc(0)
  private start = 0
  pos = 0

  constructor(private fh: import('fs/promises').FileHandle, readonly size: number) {}

  private async need(n: number): Promise<void> {
    if (this.pos + n > this.size) throw new Error('truncated GGUF header')
    const have = this.start + this.buf.length - this.pos
    if (this.pos >= this.start && have >= n) return
    const from = this.pos
    const len = Math.min(Math.max(CHUNK, n), this.size - from)
    const next = Buffer.alloc(len)
    const { bytesRead } = await this.fh.read(next, 0, len, from)
    this.buf = next.subarray(0, bytesRead)
    this.start = from
    if (bytesRead < n) throw new Error('truncated GGUF header')
  }

  async u32(): Promise<number> {
    await this.need(4)
    const v = this.buf.readUInt32LE(this.pos - this.start)
    this.pos += 4
    return v
  }

  async u64(): Promise<number> {
    await this.need(8)
    const v = Number(this.buf.readBigUInt64LE(this.pos - this.start))
    this.pos += 8
    return v
  }

  async string(): Promise<string> {
    const len = await this.u64()
    if (len > 1 << 26) throw new Error('implausible GGUF string length')
    await this.need(len)
    const s = this.buf.toString('utf8', this.pos - this.start, this.pos - this.start + len)
    this.pos += len
    return s
  }

  skip(n: number): void {
    this.pos += n
  }
}

async function skipValue(r: HeaderReader, type: number): Promise<void> {
  const fixed = FIXED_SIZE[type]
  if (fixed !== undefined) { r.skip(fixed); return }
  if (type === 8) { r.skip(await r.u64()); return }
  if (type !== 9) throw new Error(`unknown GGUF value type ${type}`)
  const elem = await r.u32()
  const count = await r.u64()
  const elemSize = FIXED_SIZE[elem]
  if (elemSize !== undefined) { r.skip(elemSize * count); return }
  for (let i = 0; i < count; i++) await skipValue(r, elem)
}

export interface GgufTensorTable { arch: string | null; tensors: StrataTensor[] }

export async function readGgufTensors(path: string): Promise<GgufTensorTable> {
  const size = (await stat(path)).size
  const fh = await open(path, 'r')
  try {
    const r = new HeaderReader(fh, size)
    const magic = Buffer.alloc(4)
    await fh.read(magic, 0, 4, 0)
    if (magic.toString('latin1') !== 'GGUF') throw new Error('not a GGUF file')
    r.pos = 4
    await r.u32()
    const nTensors = await r.u64()
    const nKv = await r.u64()
    let arch: string | null = null
    let align = 32
    for (let i = 0; i < nKv; i++) {
      const key = await r.string()
      const type = await r.u32()
      if (key === 'general.architecture' && type === 8) arch = await r.string()
      else if (key === 'general.alignment' && (type === 4 || type === 5)) align = (await r.u32()) || 32
      else await skipValue(r, type)
    }
    const raw: Array<{ name: string; type: string; offset: number }> = []
    for (let i = 0; i < nTensors; i++) {
      const name = await r.string()
      const dims = await r.u32()
      r.skip(8 * dims)
      const type = await r.u32()
      const offset = await r.u64()
      raw.push({ name, type: ggmlTypeName(type), offset })
    }
    const dataStart = Math.ceil(r.pos / align) * align
    const order = [...raw].sort((a, b) => a.offset - b.offset)
    const bytes = new Map<string, number>()
    order.forEach((t, i) => {
      const end = i + 1 < order.length ? order[i + 1].offset : size - dataStart
      bytes.set(t.name, end - t.offset)
    })
    return { arch, tensors: raw.map(t => ({ name: t.name, type: t.type, bytes: bytes.get(t.name) ?? 0 })) }
  } finally {
    await fh.close()
  }
}

// Every shard of the set a first-shard path belongs to, or null when a shard
// is missing. A path without a "-00001-of-0000N" suffix is a set of one.
export function ggufShardPaths(path: string): string[] | null {
  const m = path.match(/^(.*)-(\d{5})-of-(\d{5})(\.gguf)$/i)
  if (!m) return [path]
  const total = parseInt(m[3], 10)
  const out: string[] = []
  for (let i = 1; i <= total; i++) {
    const p = `${m[1]}-${String(i).padStart(5, '0')}-of-${m[3]}${m[4]}`
    if (!existsSync(p)) return null
    out.push(p)
  }
  return out
}

// Fingerprint of a whole shard set, or null when the set is incomplete.
export async function fingerprintGguf(path: string): Promise<StrataFingerprint | null> {
  const shards = ggufShardPaths(path)
  if (!shards) return null
  let arch: string | null = null
  const tensors: StrataTensor[] = []
  for (const shard of shards) {
    const t = await readGgufTensors(shard)
    arch = arch ?? t.arch
    tensors.push(...t.tensors)
  }
  return summarizeStrataTensors(arch, tensors)
}

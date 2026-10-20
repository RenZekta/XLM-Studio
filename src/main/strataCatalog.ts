import type { StrataTable } from '../shared/strata'

// The families and variants an installed Strata engine offers, read from its
// own clone so a new family or a fork's models need no app update:
//   - the file table (data/gguf_fingerprints.json): "family/variant" keys, the
//     authoritative pairing for every file the engine installs;
//   - setup.py: the families it declares that the table does not list (the
//     own-path ones, like Qwen3.6, carry their variants in a "models" dict).
// Python is not run; setup.py is read as text, and anything that does not
// parse leaves just what the table gave.

export interface StrataCatalog {
  // Family -> its variants, in the order the engine lists them.
  families: Record<string, string[]>
}

interface DictEntry { key: string; value: string }

// The text of one string literal starting at `i` (past the quote), and the
// index after it. Handles ', " and triple quotes, and backslash escapes.
function skipString(src: string, i: number): number {
  const q = src[i]
  const triple = src.startsWith(q.repeat(3), i)
  const end = triple ? q.repeat(3) : q
  let j = i + (triple ? 3 : 1)
  while (j < src.length) {
    if (src[j] === '\\') { j += 2; continue }
    if (src.startsWith(end, j)) return j + end.length
    if (!triple && src[j] === '\n') return j
    j++
  }
  return src.length
}

// The entries of the dict literal whose '{' is at `open`: each top-level
// string key with the source text of its value. Entries that are not
// `"key": value` (a ** spread) are skipped.
function dictEntries(src: string, open: number): DictEntry[] {
  const entries: DictEntry[] = []
  let i = open + 1
  const skipSpace = () => {
    while (i < src.length) {
      if (/\s/.test(src[i])) i++
      else if (src[i] === '#') { while (i < src.length && src[i] !== '\n') i++ }
      else break
    }
  }
  while (i < src.length) {
    skipSpace()
    if (src[i] === '}' || i >= src.length) break
    if (src[i] === ',') { i++; continue }
    let key: string | null = null
    if (src[i] === '"' || src[i] === "'") {
      const end = skipString(src, i)
      key = src.slice(i + 1, end - 1)
      i = end
      skipSpace()
    }
    // The value (or an entry we do not understand) runs to the next comma at
    // depth 0 or the closing brace.
    let depth = 0
    const from = i
    while (i < src.length) {
      const c = src[i]
      if (c === '"' || c === "'") { i = skipString(src, i); continue }
      if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth-- }
      else if (c === ',' && depth === 0) break
      i++
    }
    if (key !== null && src[from] === ':') entries.push({ key, value: src.slice(from + 1, i) })
  }
  return entries
}

// The entries of a module-level `NAME = { ... }`.
function topLevelDict(src: string, name: string): DictEntry[] {
  const m = new RegExp(`^${name}\\s*=\\s*\\{`, 'm').exec(src)
  return m ? dictEntries(src, m.index + m[0].length - 1) : []
}

// The entries of the dict a `"models": {` key opens inside a value.
function modelsOf(value: string): string[] {
  const m = /"models"\s*:\s*\{/.exec(value)
  return m ? dictEntries(value, m.index + m[0].length - 1).map(e => e.key) : []
}

// The quoted names in a tuple's text.
const names = (tuple: string): string[] => [...tuple.matchAll(/["']([^"']+)["']/g)].map(m => m[1])

export function parseStrataCatalog(setupPy: string | null, table: StrataTable | null): StrataCatalog {
  const families: Record<string, string[]> = {}
  const add = (family: string, model?: string) => {
    const list = (families[family] ??= [])
    if (model && !list.includes(model)) list.push(model)
  }
  const fromTable = new Set<string>()
  for (const key of Object.keys(table ?? {})) {
    if (key.startsWith('_')) continue
    const [family, model] = key.split('/')
    if (family && model) { add(family, model); fromTable.add(family) }
  }
  if (setupPy) {
    try {
      const models = topLevelDict(setupPy, 'MODELS')
      const defaults = /\.get\("families",\s*\(([^)]*)\)\)/.exec(setupPy)?.[1] ?? ''
      for (const f of topLevelDict(setupPy, 'FAMILIES')) {
        if (fromTable.has(f.key)) continue
        // A variant names the families it is for; one that does not is for
        // the families setup.py defaults to.
        add(f.key)
        for (const m of models) {
          const only = /"families"\s*:\s*\(([^)]*)\)/.exec(m.value)
          if (names(only ? only[1] : defaults).includes(f.key)) add(f.key, m.key)
        }
      }
      for (const f of topLevelDict(setupPy, 'OWN_PATH_FAMILIES')) {
        if (fromTable.has(f.key)) continue
        add(f.key)
        for (const m of modelsOf(f.value)) add(f.key, m)
      }
    } catch {
      // Keep what the table gave.
    }
  }
  return { families }
}

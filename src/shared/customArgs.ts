import type { CommandsSchema } from './types'
import { normalizeImportedArgs } from './importCommand'
import { MMPROJ_OFFLOAD_MODE_KEY } from './mmprojOffload'

// Template-level free text holding flags the parameter schema does not list.
// The key starts with `__`, so every launch path already skips it as an
// internal key; the words in it are appended to the command separately.
export const CUSTOM_ARGS_KEY = '__customArgs'

// Flags the Template sets from its own fields (model file, port). Typing them
// here would fight those fields, so they are left out of the launch command.
const RESERVED_FLAGS = new Set(['-m', '--model', '--port'])

export type CustomArgValue = string | number | boolean

export interface CustomArgEntry {
  flag: string
  // Words after the flag, quotes removed. Empty for a switch.
  values: string[]
  // Character range of the whole entry in the source text, end exclusive.
  start: number
  end: number
  // Position of the flag word itself, for highlighting.
  flagStart: number
  flagEnd: number
}

export type CustomArgKind = 'custom' | 'supported' | 'reserved'

export interface ClassifiedEntry extends CustomArgEntry {
  kind: CustomArgKind
  // Key the editor stores the value under (short flags and aliases resolved).
  key?: string
}

const unquote = (v: string) => v.replace(/^(["'])(.*)\1$/, '$2')

// A flag is a dash and a letter. A bare number such as -1 is a value.
const isFlagWord = (w: string) => /^--?[A-Za-z]/.test(w)

// Splits free text into flag entries. A flag takes every word up to the next
// flag, so multi-value flags (--lora-scaled FILE SCALE) stay in one entry.
// `--flag=value` is read as two words and line continuations are dropped.
export function parseCustomArgs(text: string): CustomArgEntry[] {
  const entries: CustomArgEntry[] = []
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  let current: CustomArgEntry | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    let word = m[0]
    const wordStart = m.index
    if (word === '\\' || word === '^') continue
    let inlineValue: string | undefined
    if (word.startsWith('--')) {
      const eq = word.indexOf('=')
      if (eq > 2) { inlineValue = word.slice(eq + 1); word = word.slice(0, eq) }
    }
    if (isFlagWord(word)) {
      current = { flag: word, values: [], start: wordStart, end: wordStart + word.length, flagStart: wordStart, flagEnd: wordStart + word.length }
      if (inlineValue !== undefined) { current.values.push(unquote(inlineValue)); current.end = wordStart + m[0].length }
      entries.push(current)
    } else if (current) {
      current.values.push(unquote(word))
      current.end = wordStart + word.length
    } else {
      // Words before the first flag are passed on as typed.
      current = { flag: '', values: [unquote(word)], start: wordStart, end: wordStart + word.length, flagStart: wordStart, flagEnd: wordStart }
      entries.push(current)
    }
  }
  return entries
}

function schemaLookup(schema: CommandsSchema | null | undefined) {
  const byArg = new Map<string, { type?: string }>()
  for (const cat of schema?.categories || []) for (const cmd of cat.commands) byArg.set(cmd.arg, cmd)
  return byArg
}

// Marks each entry as a flag the editor has a control for ('supported'), one
// the Template sets itself ('reserved'), or a plain custom flag.
export function classifyCustomArgs(text: string, schema: CommandsSchema | null | undefined): ClassifiedEntry[] {
  const known = schemaLookup(schema)
  return parseCustomArgs(text).map(e => {
    if (!e.flag) return { ...e, kind: 'custom' as const }
    if (RESERVED_FLAGS.has(e.flag)) return { ...e, kind: 'reserved' as const }
    const key = Object.keys(normalizeImportedArgs({ [e.flag]: true }, schema))[0]
    if (key === MMPROJ_OFFLOAD_MODE_KEY || known.has(key)) return { ...e, kind: 'supported' as const, key }
    return { ...e, kind: 'custom' as const }
  })
}

// The words appended to the launch command: every typed flag except the
// reserved ones. Flags the controls also manage pass through too; being last
// on the command line, the typed value is the one llama-server keeps.
export function customArgsLaunchTokens(text: unknown): string[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const out: string[] = []
  for (const e of parseCustomArgs(text)) {
    if (RESERVED_FLAGS.has(e.flag)) continue
    if (e.flag) out.push(e.flag)
    out.push(...e.values)
  }
  return out
}

const TEXT_ONLY = (cmdType: string | undefined) => cmdType === 'string' || cmdType === 'select' || cmdType === 'text'

// The value an editor control stores for a typed flag, by the control's type.
function entryValue(entry: ClassifiedEntry, schema: CommandsSchema | null | undefined): CustomArgValue {
  if (entry.key === MMPROJ_OFFLOAD_MODE_KEY) {
    return normalizeImportedArgs({ [entry.flag]: true }, schema)[MMPROJ_OFFLOAD_MODE_KEY]
  }
  const cmd = schemaLookup(schema).get(entry.key || '')
  if (entry.values.length === 0) return true
  const joined = entry.values.join(' ')
  if (cmd?.type === 'boolean') return !/^(false|off|0|no)$/i.test(joined)
  if (TEXT_ONLY(cmd?.type)) return joined
  const n = Number(joined)
  return joined !== '' && !isNaN(n) ? n : joined
}

// Cuts entries out of the text along with the spaces after them, then drops
// the lines that end up empty.
export function removeEntries(text: string, entries: CustomArgEntry[]): string {
  let out = text
  for (const e of [...entries].sort((a, b) => b.start - a.start)) {
    let end = e.end
    while (end < out.length && (out[end] === ' ' || out[end] === '\t')) end++
    out = out.slice(0, e.start) + out.slice(end)
  }
  return out
    .split('\n')
    .map(l => l.replace(/[ \t]+$/, ''))
    .filter(l => l.trim() !== '')
    .join('\n')
}

export interface SupportedConflict {
  flag: string
  key: string
  current: unknown
  incoming: CustomArgValue
}

export interface ImportSupportedResult {
  args: Record<string, any>
  text: string
  imported: string[]
  // Flags whose stored value was kept because overwrite was off.
  kept: string[]
  conflicts: SupportedConflict[]
}

const sameValue = (a: unknown, b: unknown) => String(a) === String(b)

// Moves the supported flags typed in the text into the Template's args and
// leaves the rest of the text in place. With overwrite off, a flag that
// already has a different stored value keeps it and is only dropped from the
// text; flags with no stored value are always imported.
export function importSupportedArgs(
  text: string,
  args: Record<string, any>,
  schema: CommandsSchema | null | undefined,
  overwrite: boolean
): ImportSupportedResult {
  const supported = classifyCustomArgs(text, schema).filter(e => e.kind === 'supported')
  const next = { ...args }
  const imported: string[] = []
  const kept: string[] = []
  const conflicts: SupportedConflict[] = []
  for (const e of supported) {
    const key = e.key as string
    const incoming = entryValue(e, schema)
    const cur = next[key]
    const isSet = cur !== undefined && cur !== null && cur !== '' && cur !== false
    if (isSet && !sameValue(cur, incoming)) {
      conflicts.push({ flag: key, key, current: cur, incoming })
      if (!overwrite) { kept.push(key); continue }
    }
    next[key] = incoming
    imported.push(key)
  }
  return { args: next, text: removeEntries(text, supported), imported, kept, conflicts }
}

// One flag as it is typed in the text area: values with spaces are quoted.
export function formatCustomFlag(flag: string, value: CustomArgValue): string {
  if (value === false) return ''
  if (value === true || value === '') return flag
  const s = String(value)
  return /\s/.test(s) ? `${flag} "${s}"` : `${flag} ${s}`
}

// Adds flags to the end of the text, one per line.
export function appendCustomArgs(text: unknown, flags: Record<string, CustomArgValue>): string {
  const base = typeof text === 'string' ? text.replace(/\s+$/, '') : ''
  const lines = Object.entries(flags).map(([f, v]) => formatCustomFlag(f, v)).filter(Boolean)
  if (lines.length === 0) return base
  return base ? `${base}\n${lines.join('\n')}` : lines.join('\n')
}

// Splits flags parsed from a pasted command into those the schema lists
// (which become args) and those it does not (which go into the text).
export function partitionImportedArgs(
  args: Record<string, CustomArgValue>,
  schema: CommandsSchema | null | undefined
): { known: Record<string, CustomArgValue>; custom: Record<string, CustomArgValue> } {
  const known: Record<string, CustomArgValue> = {}
  const custom: Record<string, CustomArgValue> = {}
  const lookup = schemaLookup(schema)
  const keep = new Set(['--host', '--api-key', '--jinja', MMPROJ_OFFLOAD_MODE_KEY])
  // Without a schema nothing can be judged unknown.
  const decidable = lookup.size > 0
  for (const [k, v] of Object.entries(args)) {
    if (!decidable || keep.has(k) || lookup.has(k)) known[k] = v
    else custom[k] = v
  }
  return { known, custom }
}

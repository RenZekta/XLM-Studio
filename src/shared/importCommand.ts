import type { CommandsSchema } from './types'
import { MMPROJ_OFFLOAD_MODE_KEY } from './mmprojOffload'

// Flags whose value is free text, so a digits-only value (an API key like
// 12345) must stay a string instead of being read as a number.
const TEXT_FLAGS = new Set(['--host', '--api-key', '--family', '--model', '--gguf-dir', '--data-dir'])

export interface ParsedCommand {
  modelPath: string
  serverPort: number | null
  args: Record<string, string | number | boolean>
}

// Words of a pasted command: quotes kept together, a line continuation (\ or
// ^ at the end of a line) dropped, and `--flag=value` read as two words.
function splitCommand(cmd: string): string[] {
  const parts: string[] = []
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  const text = cmd.replace(/[\\^][ \t]*\r?\n/g, ' ')
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const part = m[0]
    const eq = part.startsWith('--') ? part.indexOf('=') : -1
    if (eq > 2) parts.push(part.slice(0, eq), part.slice(eq + 1))
    else parts.push(part)
  }
  return parts
}

const unquote = (v: string) => v.replace(/^['"]|['"]$/g, '')

// A flag and its value. A flag followed by another flag, or by nothing, is a
// switch. Returns how many words it used after the flag.
function readFlag(parts: string[], i: number, args: Record<string, string | number | boolean>): number {
  const flag = unquote(parts[i])
  const next = parts[i + 1] !== undefined ? unquote(parts[i + 1]) : undefined
  if (next !== undefined && !next.startsWith('-')) {
    const numVal = Number(next)
    args[flag] = isNaN(numVal) || TEXT_FLAGS.has(flag) ? next : numVal
    return 1
  }
  args[flag] = true
  return 0
}

function readPort(raw: string | undefined): number | null {
  const port = parseInt(unquote(raw || ''), 10)
  return port > 0 && port <= 65535 ? port : null
}

// Splits a pasted llama-server command into the model, the port and the other
// flags. Both `--flag value` and `--flag=value` are read. The port is returned
// apart because the Template keeps it as its own field; --host and --api-key
// stay in `args`, where the Server block of the editor reads them.
export function parseServerCommand(cmd: string): ParsedCommand {
  const parts = splitCommand(cmd)
  let modelPath = ''
  let serverPort: number | null = null
  const args: Record<string, string | number | boolean> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = unquote(parts[i])
    if (p === '-m' || p === '--model') {
      modelPath = unquote(parts[++i] || '')
    } else if (p === '--port') {
      serverPort = readPort(parts[++i]) ?? serverPort
    } else if (p.startsWith('-')) {
      i += readFlag(parts, i, args)
    }
  }
  return { modelPath, serverPort, args }
}

export interface ParsedStrataCommand {
  // The folder given with --gguf-dir: Strata is pointed at a folder, while a
  // Template names one of the files in it.
  ggufDir: string
  serverPort: number | null
  args: Record<string, string | number | boolean>
  // Flags left out because the launch writes them itself.
  ignored: string[]
}

// Flags XLM Studio adds on every launch, so they are not kept in a Template.
const STRATA_MANAGED_FLAGS = new Set(['--yes', '--no-browser', '--data-dir'])

// Splits a pasted Strata launcher command (START-HERE.bat, ./setup.sh or
// python setup.py, then its flags). Whatever comes before the first flag is
// the launcher and is skipped. --model and --family are Strata's own
// variant and family here, not a file, so they stay in `args`, where they
// take precedence over what was detected from the file. Flags the schema
// does not list are kept as written: the launch passes them on.
export function parseStrataCommand(cmd: string): ParsedStrataCommand {
  const parts = splitCommand(cmd)
  let ggufDir = ''
  let serverPort: number | null = null
  const args: Record<string, string | number | boolean> = {}
  const ignored: string[] = []
  let i = 0
  while (i < parts.length && !unquote(parts[i]).startsWith('-')) i++
  for (; i < parts.length; i++) {
    const p = unquote(parts[i])
    if (!p.startsWith('-')) continue
    if (p === '--gguf-dir') {
      ggufDir = unquote(parts[++i] || '')
    } else if (p === '--port') {
      serverPort = readPort(parts[++i]) ?? serverPort
    } else if (STRATA_MANAGED_FLAGS.has(p)) {
      ignored.push(p)
      const probe: Record<string, string | number | boolean> = {}
      i += readFlag(parts, i, probe)
    } else {
      i += readFlag(parts, i, args)
    }
  }
  return { ggufDir, serverPort, args, ignored }
}

// Turns the raw flags found in a pasted llama-server command into the keys
// the Template editor actually reads:
//  - short flags and alternate spellings become the schema's canonical flag
//    (-ctkd / --cache-type-k-draft -> --spec-draft-type-k, -c -> --ctx-size),
//    so imported values show up in their controls instead of sitting under a
//    key the UI never displays;
//  - --no-mmproj-offload / --mmproj-offload set the per-Template "Offload
//    mmproj to RAM" mode (Enabled / Disabled) rather than being stored as
//    flags, since the launch derives the flag from that mode.
// Flags the schema doesn't know pass through untouched.
export function normalizeImportedArgs(
  args: Record<string, string | number | boolean>,
  schema: CommandsSchema | null | undefined
): Record<string, string | number | boolean> {
  const canonical = new Map<string, string>()
  for (const cat of schema?.categories || []) {
    for (const cmd of cat.commands) {
      if (cmd.short) canonical.set(cmd.short, cmd.arg)
      for (const alias of cmd.aliases || []) canonical.set(alias, cmd.arg)
    }
  }
  const out: Record<string, string | number | boolean> = {}
  for (const [rawKey, value] of Object.entries(args)) {
    if (rawKey === '--no-mmproj-offload') { out[MMPROJ_OFFLOAD_MODE_KEY] = 'enabled'; continue }
    if (rawKey === '--mmproj-offload') { out[MMPROJ_OFFLOAD_MODE_KEY] = 'disabled'; continue }
    const key = canonical.get(rawKey) ?? rawKey
    // An explicit long flag wins over a short/alias spelling of the same one.
    if (key !== rawKey && Object.prototype.hasOwnProperty.call(args, key)) continue
    out[key] = value
  }
  return out
}

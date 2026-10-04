import type { CommandsSchema } from './types'
import { MMPROJ_OFFLOAD_MODE_KEY } from './mmprojOffload'

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

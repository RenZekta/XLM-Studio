import type { CommandCategory, CommandParam } from './types'

// Sections of the llama.cpp editor's parameter list. Kept free of React so the grouping can be
// checked against the real schema (scripts/params-sections-verify.js).

// Flags with a custom widget instead of a row.
export const CUSTOM_PARAMS = ['--model', '--port', '--host', '--api-key', '--mmproj', '--spec-type', '--spec-draft-model', '--chat-template', '--reasoning-budget', '--reasoning-budget-message', '--n-cpu-moe', '--reasoning-preserve',
  '--spec-ngram-map-k4v-size-n', '--spec-ngram-map-k4v-size-m', '--spec-ngram-map-k4v-min-hits',
  '--spec-ngram-mod-n-match', '--spec-ngram-mod-n-min', '--spec-ngram-mod-n-max',
  // Rendered inside the Speculative Decoding widget, next to the other draft settings.
  '--spec-draft-type-k', '--spec-draft-type-v']

export interface ParamSection { key: string; title: string; icon: string; rows: CommandParam[] }

interface SectionDef {
  key: string
  // Schema category whose icon the heading uses.
  iconFrom: string
  // Rows come from these categories in this order; `only` and `skip` pick flags.
  from: { category: string; only?: string[]; skip?: string[] }[]
  // Flags listed first, in this order.
  lead?: string[]
}

const CONTEXT_ARGS = ['--ctx-size']

// Speculative Decoding has no section of its own: its block and rows follow the multimodal projector under Model.
export const SECTIONS: SectionDef[] = [
  { key: 'Model', iconFrom: 'Model', from: [{ category: 'Speculative Decoding' }, { category: 'Model', skip: CONTEXT_ARGS }] },
  { key: 'Context Window', iconFrom: 'KV Cache', from: [{ category: 'Model', only: CONTEXT_ARGS }, { category: 'KV Cache' }] },
  { key: 'GPU', iconFrom: 'GPU', from: [{ category: 'GPU' }], lead: ['--gpu-layers'] },
  {
    key: 'Performance', iconFrom: 'Performance', from: [{ category: 'Performance' }],
    lead: ['--load-mode', '--threads', '--threads-batch', '--batch-size', '--ubatch-size', '--parallel', '--kv-unified', '--flash-attn']
  },
  { key: 'Sampling', iconFrom: 'Sampling', from: [{ category: 'Sampling' }] },
  { key: 'RoPE / YaRN', iconFrom: 'RoPE / YaRN', from: [{ category: 'RoPE / YaRN' }] },
  { key: 'Server', iconFrom: 'Server', from: [{ category: 'Server' }] },
  { key: 'Logging', iconFrom: 'Logging', from: [{ category: 'Logging' }] }
]

// With a search query a row has to match it; otherwise Common shows the curated flags and Full all of them.
export function buildParamSections(
  categories: CommandCategory[],
  opts: { query: string; full: boolean; common: ReadonlySet<string> }
): ParamSection[] {
  const q = opts.query.trim().toLowerCase()
  const visible = (cmd: CommandParam): boolean => {
    if (CUSTOM_PARAMS.includes(cmd.arg)) return false
    if (q) return cmd.label.toLowerCase().includes(q) || cmd.arg.toLowerCase().includes(q) || !!(cmd.short && cmd.short.toLowerCase().includes(q))
    return opts.full || opts.common.has(cmd.arg)
  }
  const rowsOf = (cat: CommandCategory, only?: string[], skip?: string[]): CommandParam[] =>
    cat.commands.filter(c => (!only || only.includes(c.arg)) && !(skip && skip.includes(c.arg)) && visible(c))
  const out: ParamSection[] = SECTIONS.map(def => {
    const rows = def.from.flatMap(f => {
      const cat = categories.find(c => c.name === f.category)
      return cat ? rowsOf(cat, f.only, f.skip) : []
    })
    const lead = def.lead ?? []
    const ordered = [...lead.map(a => rows.find(r => r.arg === a)).filter((r): r is CommandParam => !!r), ...rows.filter(r => !lead.includes(r.arg))]
    return { key: def.key, title: def.key, icon: categories.find(c => c.name === def.iconFrom)?.icon ?? '', rows: ordered }
  })
  // A category the table does not know (a fork's own) follows the known sections.
  const used = new Set(SECTIONS.flatMap(d => d.from.map(f => f.category)))
  for (const cat of categories) {
    if (!used.has(cat.name)) out.push({ key: cat.name, title: cat.name, icon: cat.icon, rows: rowsOf(cat) })
  }
  return out
}

// What the MCP tools and the generated skill know about engine cards: the
// parameters and presets of every loaded card, and how a caller's key and value
// become a stored Template argument.

import type { CommandParam } from '../shared/types'
import type { EngineCard } from '../shared/engineCard'
import { cardParams, cardParamMap, coerceParamValue, findPreset, setArgValue } from '../shared/cardRules'
import { activeForkCards, engineCardOf, listLoadedCards } from './engineCards'

export interface CardParamInfo {
  arg: string
  label: string
  description: string
  category: string
  type: string
  widget?: string
  options?: string[]
  optionsBy?: { arg: string; map: Record<string, string[]> }
  min?: number
  max?: number
  default?: string | number | boolean | null
  offArg?: string
  internal?: boolean
  computed?: string[]
}

export interface CardCatalogEntry {
  id: string
  label: string
  kind: 'engine' | 'fork'
  description?: string
  // Fork cards: the llama.cpp fork and what it adds to the llama.cpp parameters.
  repo?: string
  branch?: string
  parameters: CardParamInfo[]
  presets: { id: string; name: string; description?: string; mode: string; args: Record<string, unknown> }[]
  overrideFields: { section: string; id: string; label: string; type: string; applyTo: string }[]
  hasCheckpoints: boolean
  hasMemoryEstimate: boolean
}

function infoOf(cat: string, p: CommandParam): CardParamInfo {
  return {
    arg: p.arg, label: p.label, description: p.description, category: cat, type: p.type,
    ...(p.widget ? { widget: p.widget } : {}),
    ...(p.options ? { options: p.options } : {}),
    ...(p.optionsBy ? { optionsBy: p.optionsBy } : {}),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.offArg ? { offArg: p.offArg } : {}),
    ...(p.internal ? { internal: true } : {}),
    ...(p.exprs ? { computed: Object.keys(p.exprs) } : {})
  }
}

function paramList(cats: { name: string; commands: CommandParam[] }[] | undefined): CardParamInfo[] {
  return (cats ?? []).flatMap(c => c.commands.map(p => infoOf(c.name, p)))
}

export function cardCatalog(): CardCatalogEntry[] {
  const out: CardCatalogEntry[] = []
  const seen = new Set<string>()
  for (const c of listLoadedCards()) {
    if (seen.has(c.id)) continue
    if (c.card) {
      seen.add(c.id)
      out.push({
        id: c.card.id, label: c.card.label, kind: 'engine', description: c.card.description,
        parameters: paramList(c.card.params?.categories),
        presets: (c.card.params?.presets ?? []).map(p => ({ id: p.id, name: p.name, description: p.description, mode: p.mode ?? 'merge', args: p.args })),
        overrideFields: (c.card.overrides?.sections ?? []).flatMap(s => s.fields.map(f => ({ section: s.title, id: f.id, label: f.label, type: f.type, applyTo: f.applyTo }))),
        hasCheckpoints: !!c.card.checkpoints,
        hasMemoryEstimate: !!c.card.memory
      })
    }
  }
  for (const f of activeForkCards()) {
    out.push({
      id: f.id, label: f.label, kind: 'fork', description: f.description, repo: f.source.repo, branch: f.source.branch,
      parameters: paramList(f.params?.categories), presets: [], overrideFields: [], hasCheckpoints: false, hasMemoryEstimate: false
    })
  }
  return out
}

// A caller names a parameter by its flag, with or without dashes, or by its label.
export function resolveCardKey(card: EngineCard, key: string): CommandParam | null {
  const params = cardParams(card)
  const k = key.trim().toLowerCase()
  const bare = k.replace(/^-+/, '')
  return params.find(p => p.arg.toLowerCase() === k)
    ?? params.find(p => p.arg.toLowerCase().replace(/^-+/, '') === bare)
    ?? params.find(p => p.label.toLowerCase() === k)
    ?? params.find(p => (p.aliases ?? []).some(a => a.toLowerCase().replace(/^-+/, '') === bare))
    ?? null
}

export function validArgsMessage(card: EngineCard): string {
  return `Valid parameters of ${card.label}: ${cardParams(card).map(p => p.arg).join(', ')}. Use list-engine-parameters for details.`
}

// Applies one caller-supplied change to a card Template's arguments.
export function applyCardChange(card: EngineCard, args: Record<string, unknown>, key: string, value: unknown): { args: Record<string, unknown> } | { error: string } {
  if (key.startsWith('__')) return { args: { ...args, [key]: value } }
  const p = resolveCardKey(card, key)
  if (!p) {
    if (key === '--host' || key === '--api-key') return { args: setArgValue(null, args, key, value) }
    return { error: `"${key}" is not a parameter of ${card.label}. ${validArgsMessage(card)}` }
  }
  const c = coerceParamValue(p, value)
  if ('error' in c) return { error: c.error }
  return { args: setArgValue(p, args, p.arg, c.value) }
}

export function cardOfTemplate(engine: string): EngineCard | null {
  return engineCardOf(engine)
}

export { findPreset, cardParamMap }

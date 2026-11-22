// Applies a card's rules to a Template's arguments. One pure function decides
// what the editor shows and what a launch sends, so a preview and a start
// cannot disagree. Stored arguments are never changed by it: forced and default
// values exist only in the resolved view.

import type { CommandParam } from './types'
import type { EngineCard } from './engineCard'
import type { CardContext } from './cardContext'
import type { CardBlock, CardEffect, CardPreset, CardTone } from './cardLogic'
import { evalExpr, interpolate, parseExpr, truthyValue, type Ast } from './cardExpr'

export interface ResolvedCard {
  // Effective arguments: the Template's, then engine overrides, then defaults and forced values.
  args: Record<string, unknown>
  hidden: Set<string>
  disabled: Set<string>
  locked: Map<string, { by: 'rule' | 'override'; reason: string }>
  missing: { arg: string; message: string }[]
  warnings: { tone: CardTone; text: string; at?: string }[]
}

const parseCache = new Map<string, Ast | null>()

function astOf(src: string): Ast | null {
  let ast = parseCache.get(src)
  if (ast === undefined) {
    const parsed = parseExpr(src)
    ast = 'ast' in parsed ? parsed.ast : null
    if (parseCache.size > 500) parseCache.clear()
    parseCache.set(src, ast)
  }
  return ast
}

export function evalCardExpr(src: string, ctx: CardContext): unknown {
  const ast = astOf(src)
  return ast ? evalExpr(ast, ctx) : null
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// A literal, or the value of { "expr": "..." }.
function dyn(v: unknown, ctx: CardContext): unknown {
  return isObj(v) && typeof v.expr === 'string' ? evalCardExpr(v.expr, ctx) : v
}

export function isUnsetValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

export function cardParams(card: Pick<EngineCard, 'params'> | { params?: { categories: { commands: CommandParam[] }[] } }): CommandParam[] {
  return (card.params?.categories ?? []).flatMap(c => c.commands)
}

export function cardParamMap(card: Pick<EngineCard, 'params'>): Map<string, CommandParam> {
  return new Map(cardParams(card).map(p => [p.arg, p]))
}

// Stores a value the way a Template keeps it: empty values are removed so the
// engine's own default applies, and an off switch is kept only when the card
// has a flag for it.
export function setArgValue(cmd: CommandParam | null | undefined, args: Record<string, unknown>, arg: string, value: unknown): Record<string, unknown> {
  const next = { ...args }
  const keepFalse = value === false && !!cmd?.offArg
  if (isUnsetValue(value) || (value === false && !keepFalse)) delete next[arg]
  else next[arg] = value
  return next
}

// Turns what a caller supplies (an MCP client, a preset) into the stored type of a parameter.
export function coerceParamValue(cmd: CommandParam, raw: unknown): { value: unknown } | { error: string } {
  if (raw === null || raw === undefined || raw === '') return { value: null }
  if (cmd.widget === 'list' || cmd.widget === 'keyvalue') {
    const items = Array.isArray(raw) ? raw.map(String) : String(raw).split(cmd.widget === 'keyvalue' ? /\r?\n/ : /[\r\n,]+/).map(s => s.trim())
    return { value: items.filter(s => s !== '') }
  }
  if (cmd.type === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw }
    if (raw === 'true' || raw === 'on' || raw === 1) return { value: true }
    if (raw === 'false' || raw === 'off' || raw === 0) return { value: false }
    return { error: `${cmd.arg} is a switch: use true or false` }
  }
  if (cmd.type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/\s/g, ''))
    if (!Number.isFinite(n)) return { error: `${cmd.arg} must be a number` }
    return { value: n }
  }
  const text = String(raw)
  if (cmd.type === 'select' && cmd.options && !cmd.options.includes(text) && !cmd.optionsBy) return { error: `${cmd.arg} must be one of: ${cmd.options.join(', ')}` }
  return { value: text }
}

export interface ParamView {
  label: string
  description: string
  min?: number
  max?: number
  default?: string | number | boolean | null
  options?: string[]
}

// A parameter's fields once expressions and dependent options are worked out.
export function paramView(cmd: CommandParam, ctx: CardContext): ParamView {
  const ev = (k: keyof NonNullable<CommandParam['exprs']>): unknown => (cmd.exprs?.[k] !== undefined ? evalCardExpr(cmd.exprs[k] as string, ctx) : undefined)
  const num = (v: unknown, fallback: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
  let options = cmd.options
  if (cmd.optionsBy) {
    const by = ctx.args[cmd.optionsBy.arg]
    const list = typeof by === 'string' ? cmd.optionsBy.map[by] : undefined
    options = list ?? cmd.options ?? []
  }
  const def = ev('default')
  return {
    label: typeof ev('label') === 'string' ? (ev('label') as string) : cmd.label,
    description: typeof ev('description') === 'string' ? (ev('description') as string) : cmd.description,
    min: num(ev('min'), cmd.min),
    max: num(ev('max'), cmd.max),
    default: def === undefined ? cmd.default : (def as ParamView['default']),
    options
  }
}

function effectsOf(rule: { then?: CardEffect[]; else?: CardEffect[] }, hit: boolean): CardEffect[] {
  return (hit ? rule.then : rule.else) ?? []
}

export function resolveCard(card: EngineCard, args: Record<string, unknown>, ctx: CardContext, overrideArgs: Record<string, unknown> = {}): ResolvedCard {
  const params = cardParamMap(card)
  const state: Record<string, unknown> = { ...args }
  const locked: ResolvedCard['locked'] = new Map()
  const hidden = new Set<string>()
  const disabled = new Set<string>()
  const warnings: ResolvedCard['warnings'] = []
  const requires: { args: string[]; message?: string }[] = []

  for (const [arg, v] of Object.entries(overrideArgs)) {
    if (!params.has(arg) || isUnsetValue(v)) continue
    state[arg] = v
    locked.set(arg, { by: 'override', reason: 'Set by Overrides' })
  }

  const view = (): CardContext => ({ ...ctx, args: state })
  const setOrDrop = (arg: string, v: unknown) => { if (isUnsetValue(v)) delete state[arg]; else state[arg] = v }

  for (const rule of card.params?.rules ?? []) {
    const hit = truthyValue(evalCardExpr(rule.when, view()))
    for (const e of effectsOf(rule, hit)) {
      for (const a of e.show ?? []) hidden.delete(a)
      for (const a of e.hide ?? []) hidden.add(a)
      for (const a of e.enable ?? []) disabled.delete(a)
      for (const a of e.disable ?? []) disabled.add(a)
      for (const [arg, v] of Object.entries(e.force ?? {})) {
        if (locked.get(arg)?.by === 'override') continue
        setOrDrop(arg, dyn(v, view()))
        locked.set(arg, { by: 'rule', reason: rule.id ? `Set by rule "${rule.id}"` : 'Set by the engine card' })
      }
      for (const [arg, v] of Object.entries(e.default ?? {})) {
        if (locked.has(arg) || !isUnsetValue(args[arg])) continue
        setOrDrop(arg, dyn(v, view()))
      }
      if (e.clamp && typeof state[e.clamp.arg] === 'number') {
        let n = state[e.clamp.arg] as number
        const lo = dyn(e.clamp.min, view())
        const hi = dyn(e.clamp.max, view())
        if (typeof lo === 'number' && n < lo) n = lo
        if (typeof hi === 'number' && n > hi) n = hi
        state[e.clamp.arg] = n
      }
      if (e.require) requires.push({ args: e.require, message: e.message })
      if (e.warn !== undefined) warnings.push({ tone: e.tone ?? 'warning', text: interpolate(e.warn, view()), ...(e.at ? { at: e.at } : {}) })
    }
  }

  for (const b of card.params?.blocks ?? []) {
    if (b.kind !== 'group' || !b.enabledBy) continue
    if (!truthyValue(state[b.enabledBy])) for (const a of b.commands ?? []) disabled.add(a)
  }

  const missing: ResolvedCard['missing'] = []
  for (const r of requires) {
    for (const arg of r.args) {
      if (hidden.has(arg) || !isUnsetValue(state[arg]) || missing.some(m => m.arg === arg)) continue
      missing.push({ arg, message: r.message ?? `${params.get(arg)?.label ?? arg} is required.` })
    }
  }
  return { args: state, hidden, disabled, locked, missing, warnings }
}

// Text blocks ready to show: banners and stats whose condition holds, with ${} filled in.
export interface RenderedBlock {
  block: CardBlock
  tone: CardTone
  text: string
}

export function renderBlock(b: CardBlock, ctx: CardContext): RenderedBlock | null {
  if (b.when !== undefined && !truthyValue(evalCardExpr(b.when, ctx))) return null
  if (b.kind === 'banner') return { block: b, tone: b.tone ?? 'info', text: interpolate(b.text ?? '', ctx) }
  if (b.kind === 'stat') {
    const v = b.value !== undefined ? evalCardExpr(b.value, ctx) : null
    return { block: b, tone: b.tone ?? 'muted', text: v === null || v === undefined ? '-' : typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 100) / 100) : String(v) }
  }
  return { block: b, tone: b.tone ?? 'muted', text: b.label ?? '' }
}

export function findPreset(card: Pick<EngineCard, 'params'>, idOrName: string): CardPreset | null {
  const key = idOrName.trim().toLowerCase()
  return card.params?.presets?.find(p => p.id.toLowerCase() === key || p.name.toLowerCase() === key) ?? null
}

// The Template arguments after a preset. "replace" first clears every declared
// parameter except internal switches; arguments the card does not declare (host,
// key, internal bookkeeping) always stay.
export function applyPreset(card: EngineCard, preset: CardPreset, args: Record<string, unknown>, ctx: CardContext): Record<string, unknown> {
  const params = cardParamMap(card)
  let next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) {
    const p = params.get(k)
    if (preset.mode !== 'replace' || !p || p.internal) next[k] = v
  }
  for (const [arg, raw] of Object.entries(preset.args)) {
    const p = params.get(arg)
    if (!p) continue
    const value = dyn(raw, { ...ctx, args: next })
    const c = coerceParamValue(p, value)
    next = setArgValue(p, next, arg, 'value' in c ? c.value : null)
  }
  next.__lastPreset = preset.id
  return next
}

// Parameters forced by engine override fields and by the app's global settings.
// A field's value is what it sets, or what its `value` expression computes from it.
export function overrideArgsFor(card: EngineCard, fieldValues: Record<string, unknown> | undefined, globals: Partial<Record<string, unknown>> | undefined, ctx: CardContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const own = { ...ctx, overrides: { ...ctx.overrides, engine: fieldValues ?? {} } }
  const global = card.overrides?.global ?? {}
  for (const [key, arg] of Object.entries(global)) {
    const v = globals?.[key]
    if (arg && !isUnsetValue(v)) out[arg] = v
  }
  for (const section of card.overrides?.sections ?? []) {
    for (const f of section.fields) {
      const v = fieldValues?.[f.id]
      if (isUnsetValue(v) || (f.type === 'boolean' && v === false && !cardParamMap(card).get(f.applyTo)?.offArg)) continue
      out[f.applyTo] = f.value !== undefined ? evalCardExpr(f.value, { ...own, args: { ...ctx.args, [f.id]: v } }) ?? v : v
    }
  }
  return out
}

// The arguments the `{params}` placeholder expands to: every parameter with a
// value, in card order, minus hidden ones and the ones that are only switches.
export function cardParamTokens(card: EngineCard, resolved: ResolvedCard, ctx: CardContext): string[] {
  const out: string[] = []
  const view: CardContext = { ...ctx, args: resolved.args }
  for (const cmd of cardParams(card)) {
    if (cmd.internal || resolved.hidden.has(cmd.arg)) continue
    let v = resolved.args[cmd.arg]
    if (cmd.exprs?.emit !== undefined) v = evalCardExpr(cmd.exprs.emit, view)
    if (v === undefined || v === null) continue
    if (typeof v === 'boolean') {
      if (v) out.push(cmd.arg)
      else if (cmd.offArg) out.push(cmd.offArg)
      continue
    }
    if (Array.isArray(v)) {
      const items = v.map(x => String(x).trim()).filter(x => x !== '')
      if (items.length === 0) continue
      if (cmd.join !== undefined && !cmd.repeat) out.push(...(cmd.format === 'equals' ? [`${cmd.arg}=${items.join(cmd.join)}`] : [cmd.arg, items.join(cmd.join)]))
      else for (const item of items) out.push(...(cmd.format === 'equals' ? [`${cmd.arg}=${item}`] : [cmd.arg, item]))
      continue
    }
    const raw = String(v).trim()
    if (!raw) continue
    const text = cmd.valueMap?.[raw] ?? raw
    if (cmd.format === 'equals') out.push(`${cmd.arg}=${text}`)
    else out.push(cmd.arg, text)
  }
  return out
}

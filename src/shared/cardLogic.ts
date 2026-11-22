// The parts of an engine card beyond launching: rules between parameters,
// blocks of extra UI, presets, override sections, checkpoints, the memory
// estimator and how the engine is installed. Types and checks only; the
// resolver that applies them is cardRules.ts.

import type { CommandParam } from './types'
import { parseExpr, parseTemplate, exprRefs, templateRefs, type Ast } from './cardExpr'

export type CardTone = 'info' | 'success' | 'warning' | 'danger' | 'muted'
export const CARD_TONES: CardTone[] = ['info', 'success', 'warning', 'danger', 'muted']

// A value that may be computed: a literal, or { "expr": "..." }.
export interface DynExpr { expr: string }

export interface CardEffect {
  show?: string[]
  hide?: string[]
  enable?: string[]
  disable?: string[]
  force?: Record<string, unknown>
  default?: Record<string, unknown>
  clamp?: { arg: string; min?: unknown; max?: unknown }
  require?: string[]
  message?: string
  warn?: string
  tone?: CardTone
  at?: string
}

export interface CardRule {
  id?: string
  when: string
  then?: CardEffect[]
  else?: CardEffect[]
}

export type BlockKind = 'banner' | 'stat' | 'group' | 'divider' | 'estimate'
export type BlockPlace = 'start' | 'end' | { after: string }

export interface CardBlock {
  id: string
  kind: BlockKind
  // A category name. Blocks without one go to the first category.
  section?: string
  at?: BlockPlace
  when?: string
  tone?: CardTone
  text?: string
  label?: string
  // stat: an expression
  value?: string
  // group: a boolean parameter that switches the group's members on
  enabledBy?: string
  commands?: string[]
}

export interface CardPreset {
  id: string
  name: string
  description?: string
  args: Record<string, unknown>
  mode?: 'merge' | 'replace'
}

export interface OverrideField {
  id: string
  label: string
  type: 'boolean' | 'number' | 'string' | 'select'
  description?: string
  min?: number
  max?: number
  options?: string[]
  // The parameter this field forces on every Template of the engine.
  applyTo: string
  // Computes what is forced from the field's value; the value itself when left out.
  value?: string
}

export interface OverrideSection {
  id: string
  title: string
  icon?: string
  fields: OverrideField[]
}

export interface CardOverrides {
  sections?: OverrideSection[]
  // Which parameter each global setting of the app drives.
  global?: Partial<Record<GlobalOverrideKey, string>>
}

export const GLOBAL_OVERRIDE_KEYS = ['parallel', 'threads'] as const
export type GlobalOverrideKey = typeof GLOBAL_OVERRIDE_KEYS[number]

export interface CardHttpSpec {
  method?: 'POST' | 'PUT' | 'GET'
  path: string
  body?: Record<string, string | number | boolean>
}

export interface CardCheckpoints {
  // The flag that gives the engine a folder to keep checkpoints in.
  enable?: { arg: string; value?: string }
  save?: CardHttpSpec
  restore?: CardHttpSpec
}

export const MEMORY_FIELDS = ['contextLength', 'cacheTypeK', 'cacheTypeV', 'parallel', 'gpuLayers'] as const
export type MemoryField = typeof MEMORY_FIELDS[number]

export interface CardMemory {
  estimator: 'llama'
  map: Partial<Record<MemoryField, string>>
}

export interface CardInstallStep {
  // One program and its arguments, run without a shell inside the engine's clone.
  run: string[]
  platform?: Array<'windows' | 'macos' | 'linux'>
}

export interface CardInstall {
  steps: CardInstallStep[]
}

export interface CardSource {
  repo: string
  branch?: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const hasExpr = (v: unknown): v is DynExpr => isObj(v) && typeof v.expr === 'string'

export interface LogicInput {
  raw: Record<string, unknown>
  // Declared parameters by arg.
  params: Map<string, CommandParam>
  categories: string[]
  errors: string[]
  warnings: string[]
}

export interface CardLogic {
  rules?: CardRule[]
  blocks?: CardBlock[]
  presets?: CardPreset[]
  overrides?: CardOverrides
  checkpoints?: CardCheckpoints
  memory?: CardMemory
}

function checkExpr(src: unknown, where: string, input: LogicInput, what = 'expression'): Ast | null {
  if (typeof src !== 'string') { input.errors.push(`${where}: ${what} must be a string`); return null }
  const parsed = parseExpr(src)
  if ('error' in parsed) { input.errors.push(`${where}: ${parsed.error} (at ${parsed.at}) in "${src}"`); return null }
  for (const a of exprRefs(parsed.ast).args) if (!input.params.has(a)) input.errors.push(`${where}: "${a}" is not a parameter of this card`)
  return parsed.ast
}

function checkText(text: unknown, where: string, input: LogicInput): void {
  if (typeof text !== 'string') { input.errors.push(`${where}: must be text`); return }
  const parsed = parseTemplate(text)
  if ('error' in parsed) { input.errors.push(`${where}: ${parsed.error} (at ${parsed.at})`); return }
  for (const a of templateRefs(parsed.parts).args) if (!input.params.has(a)) input.errors.push(`${where}: "${a}" is not a parameter of this card`)
}

// A literal or { expr }. A literal is also compared with the parameter's type.
function checkDynValue(v: unknown, where: string, input: LogicInput, param?: CommandParam): void {
  if (hasExpr(v)) { checkExpr(v.expr, where, input); return }
  if (!param || v === null) return
  const ok = param.type === 'boolean' ? typeof v === 'boolean'
    : param.type === 'number' ? typeof v === 'number'
    : param.widget === 'list' || param.widget === 'keyvalue' ? Array.isArray(v) && v.every(x => typeof x === 'string')
    : typeof v === 'string' || typeof v === 'number'
  if (!ok) input.errors.push(`${where}: ${param.arg} is a ${param.widget === 'list' || param.widget === 'keyvalue' ? 'list' : param.type}; ${JSON.stringify(v)} does not fit`)
  else if (param.type === 'select' && typeof v === 'string' && v !== '' && !param.options?.includes(v) && !param.optionsBy) {
    input.errors.push(`${where}: "${v}" is not one of the options of ${param.arg}`)
  }
}

function targetList(v: unknown, where: string, input: LogicInput): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'string')) { input.errors.push(`${where}: must be a list of parameter args`); return [] }
  for (const a of v as string[]) if (!input.params.has(a)) input.errors.push(`${where}: "${a}" is not a parameter of this card`)
  return v as string[]
}

const ACTIONS = ['show', 'hide', 'enable', 'disable', 'force', 'default', 'clamp', 'require', 'warn'] as const

function checkEffect(e: unknown, where: string, input: LogicInput): CardEffect | null {
  if (!isObj(e)) { input.errors.push(`${where}: must be an object`); return null }
  const present = ACTIONS.filter(k => e[k] !== undefined)
  if (present.length !== 1) { input.errors.push(`${where}: needs exactly one of ${ACTIONS.join(', ')}`); return null }
  const action = present[0]
  const known: string[] = [action]
  if (action === 'require') known.push('message')
  if (action === 'warn') known.push('tone', 'at')
  for (const k of Object.keys(e)) if (!known.includes(k)) input.warnings.push(`${where}: unknown key "${k}" is ignored`)
  const out: CardEffect = {}
  switch (action) {
    case 'show': case 'hide': case 'enable': case 'disable': out[action] = targetList(e[action], `${where}.${action}`, input); break
    case 'require':
      out.require = targetList(e.require, `${where}.require`, input)
      if (e.message !== undefined) { if (typeof e.message === 'string') out.message = e.message; else input.errors.push(`${where}.message: must be text`) }
      break
    case 'force': case 'default': {
      const map = e[action]
      if (!isObj(map) || Object.keys(map).length === 0) { input.errors.push(`${where}.${action}: must map parameter args to values`); break }
      for (const [arg, v] of Object.entries(map)) {
        const p = input.params.get(arg)
        if (!p) { input.errors.push(`${where}.${action}: "${arg}" is not a parameter of this card`); continue }
        checkDynValue(v, `${where}.${action}["${arg}"]`, input, p)
      }
      out[action] = map
      break
    }
    case 'clamp': {
      const c = e.clamp
      if (!isObj(c) || typeof c.arg !== 'string') { input.errors.push(`${where}.clamp: needs "arg" and "min" and/or "max"`); break }
      const p = input.params.get(c.arg)
      if (!p) input.errors.push(`${where}.clamp: "${c.arg}" is not a parameter of this card`)
      else if (p.type !== 'number') input.errors.push(`${where}.clamp: "${c.arg}" is not a number`)
      if (c.min === undefined && c.max === undefined) input.errors.push(`${where}.clamp: needs "min" and/or "max"`)
      for (const k of ['min', 'max']) if (c[k] !== undefined && !hasExpr(c[k]) && typeof c[k] !== 'number') input.errors.push(`${where}.clamp.${k}: must be a number or { "expr": "..." }`)
      for (const k of ['min', 'max']) if (hasExpr(c[k])) checkExpr((c[k] as DynExpr).expr, `${where}.clamp.${k}`, input)
      out.clamp = c as CardEffect['clamp']
      break
    }
    case 'warn':
      checkText(e.warn, `${where}.warn`, input)
      out.warn = e.warn as string
      if (e.tone !== undefined) { if (CARD_TONES.includes(e.tone as CardTone)) out.tone = e.tone as CardTone; else input.errors.push(`${where}.tone: must be one of ${CARD_TONES.join(', ')}`) }
      if (e.at !== undefined) {
        if (typeof e.at === 'string' && (input.params.has(e.at) || input.categories.includes(e.at))) out.at = e.at
        else input.errors.push(`${where}.at: must name a parameter or a category`)
      }
      break
  }
  return out
}

function checkRules(raw: unknown, input: LogicInput): CardRule[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) { input.errors.push('params.rules: must be a list'); return undefined }
  const out: CardRule[] = []
  const ids = new Set<string>()
  raw.forEach((r, i) => {
    const where = `params.rules[${i}]`
    if (!isObj(r)) { input.errors.push(`${where}: must be an object`); return }
    for (const k of Object.keys(r)) if (!['id', 'when', 'then', 'else'].includes(k)) input.warnings.push(`${where}: unknown key "${k}" is ignored`)
    if (r.id !== undefined) {
      if (!isStr(r.id)) input.errors.push(`${where}.id: must be text`)
      else if (ids.has(r.id)) input.errors.push(`${where}.id: "${r.id}" is used twice`)
      else ids.add(r.id)
    }
    checkExpr(r.when, `${where}.when`, input)
    if (r.then === undefined && r.else === undefined) input.errors.push(`${where}: needs "then" and/or "else"`)
    const rule: CardRule = { when: r.when as string, ...(typeof r.id === 'string' ? { id: r.id } : {}) }
    for (const branch of ['then', 'else'] as const) {
      const list = r[branch]
      if (list === undefined) continue
      if (!Array.isArray(list)) { input.errors.push(`${where}.${branch}: must be a list of effects`); continue }
      rule[branch] = list.map((e, j) => checkEffect(e, `${where}.${branch}[${j}]`, input)).filter((e): e is CardEffect => !!e)
    }
    out.push(rule)
  })
  return out
}

const BLOCK_KINDS: BlockKind[] = ['banner', 'stat', 'group', 'divider', 'estimate']

function checkBlocks(raw: unknown, input: LogicInput, hasMemory: boolean): CardBlock[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) { input.errors.push('params.blocks: must be a list'); return undefined }
  const out: CardBlock[] = []
  const ids = new Set<string>()
  raw.forEach((b, i) => {
    const where = `params.blocks[${i}]`
    if (!isObj(b)) { input.errors.push(`${where}: must be an object`); return }
    if (!isStr(b.id) || !/^[A-Za-z0-9._-]+$/.test(b.id)) { input.errors.push(`${where}.id: required, letters, digits, ".", "_" or "-"`); return }
    if (ids.has(b.id)) { input.errors.push(`${where}.id: "${b.id}" is used twice`); return }
    ids.add(b.id)
    if (typeof b.kind !== 'string' || !BLOCK_KINDS.includes(b.kind as BlockKind)) { input.errors.push(`${where}.kind: must be one of ${BLOCK_KINDS.join(', ')}`); return }
    const kind = b.kind as BlockKind
    const known = ['id', 'kind', 'section', 'at', 'when']
    if (kind === 'banner') known.push('tone', 'text')
    if (kind === 'stat') known.push('label', 'value')
    if (kind === 'group') known.push('label', 'enabledBy', 'commands')
    if (kind === 'divider' || kind === 'estimate') known.push('label')
    for (const k of Object.keys(b)) if (!known.includes(k)) input.warnings.push(`${where}: unknown key "${k}" is ignored`)
    if (b.section !== undefined && !(typeof b.section === 'string' && input.categories.includes(b.section))) input.errors.push(`${where}.section: "${String(b.section)}" is not a category`)
    if (b.at !== undefined) {
      const okAt = b.at === 'start' || b.at === 'end' || (isObj(b.at) && typeof b.at.after === 'string' && input.params.has(b.at.after))
      if (!okAt) input.errors.push(`${where}.at: must be "start", "end" or { "after": "<arg of a parameter>" }`)
    }
    if (b.when !== undefined) checkExpr(b.when, `${where}.when`, input)
    if (b.tone !== undefined && !CARD_TONES.includes(b.tone as CardTone)) input.errors.push(`${where}.tone: must be one of ${CARD_TONES.join(', ')}`)
    if (kind === 'banner') checkText(b.text, `${where}.text`, input)
    if (kind === 'stat') {
      if (!isStr(b.label)) input.errors.push(`${where}.label: required`)
      checkExpr(b.value, `${where}.value`, input)
    }
    if (kind === 'group') {
      if (!isStr(b.label)) input.errors.push(`${where}.label: required`)
      const sw = typeof b.enabledBy === 'string' ? input.params.get(b.enabledBy) : undefined
      if (!sw) input.errors.push(`${where}.enabledBy: must name a boolean parameter`)
      else if (sw.type !== 'boolean') input.errors.push(`${where}.enabledBy: "${sw.arg}" is not a boolean`)
      targetList(b.commands, `${where}.commands`, input)
    }
    if (kind === 'estimate' && !hasMemory) input.errors.push(`${where}: an "estimate" block needs "memory" on the card`)
    out.push(b as unknown as CardBlock)
  })
  return out
}

function checkPresets(raw: unknown, input: LogicInput): CardPreset[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) { input.errors.push('params.presets: must be a list'); return undefined }
  const out: CardPreset[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  raw.forEach((p, i) => {
    const where = `params.presets[${i}]`
    if (!isObj(p)) { input.errors.push(`${where}: must be an object`); return }
    for (const k of Object.keys(p)) if (!['id', 'name', 'description', 'args', 'mode'].includes(k)) input.warnings.push(`${where}: unknown key "${k}" is ignored`)
    if (!isStr(p.id) || !/^[A-Za-z0-9._-]+$/.test(p.id)) { input.errors.push(`${where}.id: required, letters, digits, ".", "_" or "-"`); return }
    if (ids.has(p.id)) input.errors.push(`${where}.id: "${p.id}" is used twice`)
    ids.add(p.id)
    if (!isStr(p.name)) input.errors.push(`${where}.name: required`)
    else if (names.has(p.name.toLowerCase())) input.errors.push(`${where}.name: "${p.name}" is used twice`)
    else names.add(p.name.toLowerCase())
    if (p.mode !== undefined && p.mode !== 'merge' && p.mode !== 'replace') input.errors.push(`${where}.mode: must be "merge" or "replace"`)
    if (!isObj(p.args)) input.errors.push(`${where}.args: must map parameter args to values`)
    else for (const [arg, v] of Object.entries(p.args)) {
      const param = input.params.get(arg)
      if (!param) { input.errors.push(`${where}.args: "${arg}" is not a parameter of this card`); continue }
      checkDynValue(v, `${where}.args["${arg}"]`, input, param)
    }
    out.push(p as unknown as CardPreset)
  })
  return out
}

const OVERRIDE_TYPES = ['boolean', 'number', 'string', 'select']

function checkOverrides(raw: unknown, input: LogicInput): CardOverrides | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { input.errors.push('overrides: must be an object'); return undefined }
  for (const k of Object.keys(raw)) if (!['sections', 'global'].includes(k)) input.warnings.push(`overrides: unknown key "${k}" is ignored`)
  const out: CardOverrides = {}
  if (raw.sections !== undefined) {
    if (!Array.isArray(raw.sections)) input.errors.push('overrides.sections: must be a list')
    else {
      const sectionIds = new Set<string>()
      const fieldIds = new Set<string>()
      out.sections = []
      raw.sections.forEach((s, i) => {
        const where = `overrides.sections[${i}]`
        if (!isObj(s) || !isStr(s.id) || !isStr(s.title)) { input.errors.push(`${where}: needs "id" and "title"`); return }
        if (sectionIds.has(s.id)) input.errors.push(`${where}.id: "${s.id}" is used twice`)
        sectionIds.add(s.id)
        if (!Array.isArray(s.fields) || s.fields.length === 0) { input.errors.push(`${where}.fields: must be a list`); return }
        const fields: OverrideField[] = []
        s.fields.forEach((f, j) => {
          const fw = `${where}.fields[${j}]`
          if (!isObj(f) || !isStr(f.id) || !isStr(f.label)) { input.errors.push(`${fw}: needs "id" and "label"`); return }
          if (fieldIds.has(f.id)) input.errors.push(`${fw}.id: "${f.id}" is used twice`)
          fieldIds.add(f.id)
          if (typeof f.type !== 'string' || !OVERRIDE_TYPES.includes(f.type)) { input.errors.push(`${fw}.type: must be one of ${OVERRIDE_TYPES.join(', ')}`); return }
          if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0 || f.options.some(o => typeof o !== 'string'))) input.errors.push(`${fw}: a select needs a list of string "options"`)
          const target = typeof f.applyTo === 'string' ? input.params.get(f.applyTo) : undefined
          if (!target) input.errors.push(`${fw}.applyTo: must name a parameter of this card`)
          if (f.value !== undefined) checkExpr(f.value, `${fw}.value`, input)
          fields.push(f as unknown as OverrideField)
        })
        out.sections!.push({ id: s.id, title: s.title, icon: typeof s.icon === 'string' ? s.icon : undefined, fields })
      })
    }
  }
  if (raw.global !== undefined) {
    if (!isObj(raw.global)) input.errors.push('overrides.global: must map a global setting to a parameter')
    else {
      out.global = {}
      for (const [k, v] of Object.entries(raw.global)) {
        if (!(GLOBAL_OVERRIDE_KEYS as readonly string[]).includes(k)) input.errors.push(`overrides.global: unknown setting "${k}" (use ${GLOBAL_OVERRIDE_KEYS.join(', ')})`)
        else if (typeof v !== 'string' || !input.params.has(v)) input.errors.push(`overrides.global.${k}: must name a parameter of this card`)
        else out.global[k as GlobalOverrideKey] = v
      }
    }
  }
  return out
}

function checkHttp(raw: unknown, where: string, input: LogicInput): CardHttpSpec | undefined {
  if (!isObj(raw) || !isStr(raw.path) || !raw.path.startsWith('/')) { input.errors.push(`${where}.path: required, a path starting with "/"`); return undefined }
  if (raw.method !== undefined && !['POST', 'PUT', 'GET'].includes(raw.method as string)) input.errors.push(`${where}.method: must be POST, PUT or GET`)
  if (raw.body !== undefined && (!isObj(raw.body) || Object.values(raw.body).some(v => !['string', 'number', 'boolean'].includes(typeof v)))) input.errors.push(`${where}.body: must map names to text, numbers or booleans`)
  for (const k of Object.keys(raw)) if (!['method', 'path', 'body'].includes(k)) input.warnings.push(`${where}: unknown key "${k}" is ignored`)
  return raw as unknown as CardHttpSpec
}

function checkCheckpoints(raw: unknown, input: LogicInput): CardCheckpoints | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw)) { input.errors.push('checkpoints: must be an object'); return undefined }
  for (const k of Object.keys(raw)) if (!['enable', 'save', 'restore'].includes(k)) input.warnings.push(`checkpoints: unknown key "${k}" is ignored`)
  const out: CardCheckpoints = {}
  if (raw.enable !== undefined) {
    if (!isObj(raw.enable) || !isStr(raw.enable.arg) || !raw.enable.arg.startsWith('-')) input.errors.push('checkpoints.enable.arg: required, a flag')
    else out.enable = { arg: raw.enable.arg, ...(typeof raw.enable.value === 'string' ? { value: raw.enable.value } : {}) }
  }
  for (const k of ['save', 'restore'] as const) if (raw[k] !== undefined) out[k] = checkHttp(raw[k], `checkpoints.${k}`, input)
  if (!out.save && !out.restore) input.errors.push('checkpoints: needs "save" and/or "restore"')
  for (const spec of [out.save, out.restore]) {
    if (!spec) continue
    const text = JSON.stringify([spec.path, spec.body ?? {}])
    for (const m of text.matchAll(/\{([A-Za-z]+)\}/g)) if (!['filename', 'checkpointDir'].includes(m[1])) input.errors.push(`checkpoints: unknown placeholder {${m[1]}} (use {filename}, {checkpointDir})`)
  }
  return out
}

function checkMemory(raw: unknown, input: LogicInput): CardMemory | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw) || raw.estimator !== 'llama') { input.errors.push('memory.estimator: only "llama" is supported'); return undefined }
  for (const k of Object.keys(raw)) if (!['estimator', 'map'].includes(k)) input.warnings.push(`memory: unknown key "${k}" is ignored`)
  const map: CardMemory['map'] = {}
  if (!isObj(raw.map)) input.errors.push('memory.map: must map estimator inputs to parameters')
  else for (const [k, v] of Object.entries(raw.map)) {
    if (!(MEMORY_FIELDS as readonly string[]).includes(k)) input.errors.push(`memory.map: unknown input "${k}" (use ${MEMORY_FIELDS.join(', ')})`)
    else if (typeof v !== 'string' || !input.params.has(v)) input.errors.push(`memory.map.${k}: "${String(v)}" is not a parameter of this card`)
    else map[k as MemoryField] = v
  }
  return { estimator: 'llama', map }
}

export function checkCardLogic(input: LogicInput): CardLogic {
  const { raw } = input
  const paramsRaw = isObj(raw.params) ? raw.params : {}
  for (const k of Object.keys(paramsRaw)) if (!['categories', 'rules', 'blocks', 'presets'].includes(k)) input.warnings.push(`params: unknown key "${k}" is ignored`)
  const memory = checkMemory(raw.memory, input)
  return {
    rules: checkRules(paramsRaw.rules, input),
    blocks: checkBlocks(paramsRaw.blocks, input, !!memory),
    presets: checkPresets(paramsRaw.presets, input),
    overrides: checkOverrides(raw.overrides, input),
    checkpoints: checkCheckpoints(raw.checkpoints, input),
    memory
  }
}

// engine.source and engine.install: where an engine comes from and how it is made ready.
export function checkSource(raw: unknown, where: string, errors: string[], warnings: string[]): CardSource | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw) || !isStr(raw.repo) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repo.trim())) {
    errors.push(`${where}.repo: required, the GitHub repository as "owner/repo"`)
    return undefined
  }
  for (const k of Object.keys(raw)) if (!['repo', 'branch'].includes(k)) warnings.push(`${where}: unknown key "${k}" is ignored`)
  if (raw.branch !== undefined && !(isStr(raw.branch) && !/\s/.test(raw.branch))) { errors.push(`${where}.branch: must be a branch name`); return undefined }
  return { repo: raw.repo.trim(), ...(isStr(raw.branch) ? { branch: raw.branch.trim() } : {}) }
}

export function checkInstall(raw: unknown, errors: string[], warnings: string[]): CardInstall | undefined {
  if (raw === undefined) return undefined
  if (!isObj(raw) || !Array.isArray(raw.steps) || raw.steps.length === 0) { errors.push('install.steps: must be a list of steps'); return undefined }
  for (const k of Object.keys(raw)) if (k !== 'steps') warnings.push(`install: unknown key "${k}" is ignored`)
  const steps: CardInstallStep[] = []
  raw.steps.forEach((s, i) => {
    const where = `install.steps[${i}]`
    if (!isObj(s) || !Array.isArray(s.run) || s.run.length === 0 || s.run.some(x => typeof x !== 'string' || x === '')) { errors.push(`${where}.run: must be a program and its arguments, as a list of strings`); return }
    for (const k of Object.keys(s)) if (!['run', 'platform'].includes(k)) warnings.push(`${where}: unknown key "${k}" is ignored`)
    if (s.platform !== undefined && (!Array.isArray(s.platform) || s.platform.some(p => !['windows', 'macos', 'linux'].includes(p as string)))) errors.push(`${where}.platform: must list windows, macos and/or linux`)
    for (const t of s.run as string[]) for (const m of t.matchAll(/\{([A-Za-z]+)\}/g)) if (m[1] !== 'engineDir') errors.push(`${where}.run: unknown placeholder {${m[1]}} (use {engineDir})`)
    steps.push(s as unknown as CardInstallStep)
  })
  return { steps }
}

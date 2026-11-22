// Engine cards: a JSON file that describes an HTTP-serving engine well enough
// for XLM Studio to list, configure, launch and stop it. A card holds data
// only, so it is validated once on load and nothing in it can run code.
// Kept free of Node and React so the main process, the renderer and
// scripts/engine-card-verify.js all read it the same way.

import type { CommandCategory, CommandParam } from './types'
import type { EngineDef } from './engines'
import { isBuiltinEngine } from './engines'
import { exprRefs, parseExpr, type Ast } from './cardExpr'
import { emptyCardContext, type CardContext } from './cardContext'
import {
  checkCardLogic, checkInstall, checkSource,
  type CardBlock, type CardCheckpoints, type CardInstall, type CardMemory, type CardOverrides, type CardPreset, type CardRule, type CardSource
} from './cardLogic'
import { cardParamTokens, resolveCard, type ResolvedCard } from './cardRules'
import { CUSTOM_ARGS_KEY, customArgsLaunchTokens } from './customArgs'

export const CARD_VERSION = 1

export type CardPlatform = 'windows' | 'macos' | 'linux' | 'default'

export interface CardReady {
  // Regular expression tested against each line the engine prints.
  log?: string
  // Path polled on the engine's port until it answers 200.
  http?: string
}

// Prometheus text read with llama.cpp's metric names, so the Performance view
// can chart it.
export interface CardMetrics {
  path?: string
  format: 'prometheus' | 'none'
}

export type CardFile = string | string[]

export interface CardLaunch {
  // Launcher, relative to the engine folder: a file, or a list of candidates
  // of which the first that exists is used ("*" matches within one name), or
  // one of those per platform.
  file: CardFile | Partial<Record<CardPlatform, CardFile>>
  // A string is one argument. An array is a group that is left out when any
  // placeholder in it has no value (["--api-key", "{apiKey}"]).
  argv: Array<string | string[]>
  env?: Record<string, string>
  ready?: CardReady
  stop?: { graceMs?: number }
  metrics?: CardMetrics
}

export interface CardParams {
  categories: CommandCategory[]
  rules?: CardRule[]
  blocks?: CardBlock[]
  presets?: CardPreset[]
}

export interface EngineCard {
  cardVersion: number
  id: string
  label: string
  description?: string
  engine: { folder: string }
  // Where the engine's code comes from and how it is made ready. XLM Studio
  // clones the repository into the engine folder and runs the steps there.
  source?: CardSource
  install?: CardInstall
  launch: CardLaunch
  params?: CardParams
  overrides?: CardOverrides
  checkpoints?: CardCheckpoints
  memory?: CardMemory
}

// A card for a llama.cpp fork. XLM Studio already clones, builds, launches and
// configures llama.cpp, so the card only names the fork and lists the
// parameters that fork adds. It becomes an Engine Tracker entry; there is no
// launcher, no folder and no script.
export interface ForkCard {
  cardVersion: number
  id: string
  label: string
  description?: string
  extends: 'llama.cpp'
  source: { repo: string; branch?: string }
  params?: { categories: CommandCategory[] }
  // Replaces the option list of a built-in select, by its arg.
  defaultOptions?: Record<string, string[]>
}

export const CARD_PLACEHOLDERS = ['model', 'modelDir', 'port', 'host', 'apiKey', 'engineDir', 'name', 'params'] as const
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g

export const DEFAULT_READY: CardReady = { http: '/v1/models' }

const PARAM_TYPES = ['boolean', 'number', 'string', 'select', 'text']
const WIDGET_TYPES: Record<string, string[]> = {
  slider: ['number'], segmented: ['select'], tristate: ['boolean'], password: ['string', 'text'], textarea: ['text', 'string'],
  file: ['string', 'text'], folder: ['string', 'text'], list: ['string', 'text'], keyvalue: ['text', 'string']
}
const DYNAMIC_FIELDS = ['label', 'description', 'default', 'min', 'max']
const SLIDER_SCALES = ['linear', 'ladder']
const METRIC_FORMATS = ['prometheus', 'none']
const PLATFORMS = ['windows', 'macos', 'linux', 'default']
const RESERVED_FOLDERS = new Set(['strata-data'])

export interface CardValidation {
  card: EngineCard | null
  // Set instead of `card` when the file is a fork card.
  fork?: ForkCard | null
  errors: string[]
  warnings: string[]
}

const refsOf = (ast: Ast): string[] => exprRefs(ast).args
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

function placeholdersOf(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER_RE), m => m[1])
}

function relativeFileProblem(file: string): string | null {
  if (/^([a-zA-Z]:|[\\/])/.test(file)) return 'must be relative to the engine folder'
  if (file.split(/[\\/]/).some(part => part === '..')) return 'must stay inside the engine folder'
  return null
}

function unknownKeys(obj: Record<string, unknown>, known: string[], where: string, warnings: string[]): void {
  for (const k of Object.keys(obj)) if (!known.includes(k)) warnings.push(`${where}: unknown key "${k}" is ignored`)
}

function checkArgvToken(token: string, where: string, errors: string[], allowParams: boolean): void {
  for (const name of placeholdersOf(token)) {
    if (!(CARD_PLACEHOLDERS as readonly string[]).includes(name)) errors.push(`${where}: unknown placeholder {${name}} (use ${CARD_PLACEHOLDERS.map(p => `{${p}}`).join(', ')})`)
    else if (name === 'params' && !(allowParams && token === '{params}')) errors.push(`${where}: {params} must be an argument on its own`)
  }
}

interface PendingExpr { where: string; src: string }

// Moves { "expr": "..." } values out of a parameter into `exprs`, leaving the
// static fields for the editor to use when nothing is computed.
function takeExprs(q: Record<string, unknown>, where: string, errors: string[], pending: PendingExpr[]): Record<string, string> {
  const exprs: Record<string, string> = {}
  const take = (key: string, into: string, from: Record<string, unknown>) => {
    const v = from[key]
    if (!isObj(v) || !('expr' in v)) return
    delete from[key]
    if (typeof v.expr !== 'string') { errors.push(`${where}.${key}: "expr" must be a string`); return }
    const parsed = parseExpr(v.expr)
    if ('error' in parsed) errors.push(`${where}.${key}: ${parsed.error} (at ${parsed.at}) in "${v.expr}"`)
    else { exprs[into] = v.expr; pending.push({ where: `${where}.${key}`, src: v.expr }) }
  }
  for (const k of DYNAMIC_FIELDS) take(k, k, q)
  take('emit', 'emit', q)
  if (isObj(q.slider)) {
    const sl = { ...q.slider }
    take('min', 'min', sl)
    take('max', 'max', sl)
    q.slider = sl
  }
  return exprs
}

function checkParam(p: Record<string, unknown>, where: string, errors: string[], warnings: string[], pending: PendingExpr[]): CommandParam | null {
  const q: Record<string, unknown> = { ...p }
  const exprs = takeExprs(q, where, errors, pending)
  if (!isStr(q.label) && exprs.label === undefined) errors.push(`${where}: needs a "label"`)
  if (typeof q.type !== 'string' || !PARAM_TYPES.includes(q.type)) { errors.push(`${where}: "type" must be one of ${PARAM_TYPES.join(', ')}`); return null }
  const type = q.type
  if (isObj(q.options) || (q.options !== undefined && !Array.isArray(q.options))) errors.push(`${where}: "options" must be a list of strings; use "optionsBy" for options that depend on another parameter`)
  if (type === 'select' && q.optionsBy === undefined && (!Array.isArray(q.options) || q.options.length === 0 || q.options.some(o => typeof o !== 'string'))) errors.push(`${where}: a select needs a list of string "options"`)
  if (typeof q.min === 'number' && typeof q.max === 'number' && q.min > q.max) errors.push(`${where}: "min" is above "max"`)
  if (q.offArg !== undefined && type !== 'boolean') errors.push(`${where}: "offArg" is only for booleans`)
  if (q.format !== undefined && q.format !== 'space' && q.format !== 'equals') errors.push(`${where}: "format" must be "space" or "equals"`)

  const widget = q.widget
  if (widget !== undefined) {
    if (typeof widget !== 'string' || !(widget in WIDGET_TYPES)) errors.push(`${where}.widget: must be one of ${Object.keys(WIDGET_TYPES).join(', ')}`)
    else if (!WIDGET_TYPES[widget].includes(type)) errors.push(`${where}.widget: "${widget}" is for ${WIDGET_TYPES[widget].join(' or ')} parameters, not ${type}`)
    else if (widget === 'segmented' && Array.isArray(q.options) && q.options.length > 4) errors.push(`${where}.widget: "segmented" holds at most 4 options`)
    else if (widget === 'tristate' && q.offArg === undefined) errors.push(`${where}.widget: "tristate" needs "offArg"`)
  }
  if (q.slider !== undefined) {
    const sl = q.slider
    if (widget !== 'slider') errors.push(`${where}.slider: only for "widget": "slider"`)
    else if (!isObj(sl)) errors.push(`${where}.slider: must be an object`)
    else {
      unknownKeys(sl, ['min', 'max', 'step', 'scale', 'allowAuto', 'recommended', 'recommendedLabel'], `${where}.slider`, warnings)
      for (const k of ['min', 'max']) {
        if (sl[k] === undefined) continue
        if (typeof sl[k] === 'number') q[k] = sl[k]
        else errors.push(`${where}.slider.${k}: must be a number or { "expr": "..." }`)
      }
      delete sl.min
      delete sl.max
      if (sl.step !== undefined && !(typeof sl.step === 'number' && sl.step > 0)) errors.push(`${where}.slider.step: must be a positive number`)
      if (sl.scale !== undefined && !SLIDER_SCALES.includes(sl.scale as string)) errors.push(`${where}.slider.scale: must be one of ${SLIDER_SCALES.join(', ')}`)
    }
  }
  if (widget === 'slider') {
    const hasMin = typeof q.min === 'number' || exprs.min !== undefined
    const hasMax = typeof q.max === 'number' || exprs.max !== undefined
    if (!hasMin || !hasMax) errors.push(`${where}: a slider needs "slider.min" and "slider.max"`)
  }
  if ((q.repeat !== undefined || q.join !== undefined) && widget !== 'list' && widget !== 'keyvalue') errors.push(`${where}: "repeat" and "join" are for list and keyvalue widgets`)
  if (q.join !== undefined && typeof q.join !== 'string') errors.push(`${where}.join: must be a string`)
  if (q.valueMap !== undefined) {
    if (type !== 'select') errors.push(`${where}.valueMap: only for selects`)
    else if (!isObj(q.valueMap) || Object.values(q.valueMap).some(v => typeof v !== 'string')) errors.push(`${where}.valueMap: must map option values to strings`)
  }
  if (q.optionsBy !== undefined) {
    const ob = q.optionsBy
    if (type !== 'select') errors.push(`${where}.optionsBy: only for selects`)
    else if (!isObj(ob) || typeof ob.arg !== 'string' || !isObj(ob.map) || Object.values(ob.map).some(v => !Array.isArray(v) || v.some(x => typeof x !== 'string'))) errors.push(`${where}.optionsBy: needs "arg" and a "map" from its values to lists of options`)
  }
  if (q.internal !== undefined) {
    if (typeof q.internal !== 'boolean') errors.push(`${where}.internal: must be true or false`)
    else if (q.internal && (q.offArg !== undefined || q.format !== undefined || exprs.emit !== undefined)) errors.push(`${where}: an internal parameter is never sent, so it cannot have "offArg", "format" or "emit"`)
  }
  const keys = ['arg', 'short', 'aliases', 'label', 'description', 'type', 'default', 'options', 'min', 'max', 'placeholder', 'env', 'deprecated', 'requireValue', 'emptyLabel', 'optionLabels', 'offArg', 'format', 'widget', 'slider', 'internal', 'repeat', 'join', 'valueMap', 'optionsBy', 'icon']
  for (const k of Object.keys(q)) if (!keys.includes(k)) warnings.push(`${where}: unknown key "${k}" is ignored`)
  return {
    ...(q as unknown as CommandParam),
    label: typeof q.label === 'string' ? q.label : String(exprs.label ?? q.arg),
    description: typeof q.description === 'string' ? q.description : '',
    ...(Object.keys(exprs).length > 0 ? { exprs } : {})
  }
}

function checkParams(raw: unknown, errors: string[], warnings: string[], allowLogic: boolean): { params: { categories: CommandCategory[] }; declared: Map<string, CommandParam>; pending: PendingExpr[] } | undefined {
  if (!isObj(raw)) { errors.push('params: must be an object with a "categories" list'); return undefined }
  if (!allowLogic) unknownKeys(raw, ['categories'], 'params', warnings)
  if (!Array.isArray(raw.categories)) { errors.push('params.categories: must be a list'); return undefined }
  const declared = new Map<string, CommandParam>()
  const pending: PendingExpr[] = []
  const categories: CommandCategory[] = []
  raw.categories.forEach((c, ci) => {
    const at = `params.categories[${ci}]`
    if (!isObj(c) || !isStr(c.name)) { errors.push(`${at}: needs a "name"`); return }
    if (!Array.isArray(c.commands)) { errors.push(`${at}.commands: must be a list`); return }
    const commands: CommandParam[] = []
    c.commands.forEach((p, pi) => {
      const where = `${at}.commands[${pi}]`
      if (!isObj(p) || !isStr(p.arg)) { errors.push(`${where}: needs an "arg"`); return }
      if (declared.has(p.arg)) { errors.push(`${where}: "${p.arg}" is listed twice`); return }
      if (p.arg.startsWith('__')) errors.push(`${where}: "${p.arg}" is reserved for internal settings`)
      const param = checkParam(p, where, errors, warnings, pending)
      if (!param) { declared.set(p.arg, { arg: p.arg, label: p.arg, description: '', type: 'string' }); return }
      declared.set(p.arg, param)
      commands.push(param)
    })
    categories.push({ name: c.name, icon: typeof c.icon === 'string' ? c.icon : 'Sliders', commands })
  })
  return { params: { categories }, declared, pending }
}

// References between parameters, once every parameter is known.
function checkParamRefs(declared: Map<string, CommandParam>, pending: PendingExpr[], errors: string[]): void {
  for (const { where, src } of pending) {
    const parsed = parseExpr(src)
    if (!('ast' in parsed)) continue
    for (const a of refsOf(parsed.ast)) if (!declared.has(a)) errors.push(`${where}: "${a}" is not a parameter of this card`)
  }
  for (const p of declared.values()) {
    if (!p.optionsBy) continue
    const dep = declared.get(p.optionsBy.arg)
    if (!dep) errors.push(`${p.arg}.optionsBy: "${p.optionsBy.arg}" is not a parameter of this card`)
    else if (dep.arg === p.arg) errors.push(`${p.arg}.optionsBy: a select cannot depend on itself`)
    else if (dep.type !== 'select') errors.push(`${p.arg}.optionsBy: "${dep.arg}" is not a select`)
  }
}

function checkIdentity(raw: Record<string, unknown>, errors: string[]): void {
  if (typeof raw.cardVersion !== 'number') errors.push('cardVersion: required, a number (currently 1)')
  else if (raw.cardVersion > CARD_VERSION) errors.push(`cardVersion ${raw.cardVersion} was made for a newer XLM Studio`)
  else if (raw.cardVersion < 1) errors.push('cardVersion: must be 1 or higher')

  if (!isStr(raw.id) || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw.id)) errors.push('id: required, lowercase letters, digits, ".", "_" or "-", up to 40 characters')
  else if (isBuiltinEngine(raw.id)) errors.push(`id: "${raw.id}" is a built-in engine`)
  if (!isStr(raw.label)) errors.push('label: required, the name shown in the app')
}

function validateForkCard(raw: Record<string, unknown>): CardValidation {
  const errors: string[] = []
  const warnings: string[] = []
  unknownKeys(raw, ['cardVersion', 'id', 'label', 'description', 'extends', 'source', 'params', 'defaultOptions', 'engine', 'launch'], 'card', warnings)
  checkIdentity(raw, errors)
  if (raw.extends !== 'llama.cpp') errors.push('extends: only "llama.cpp" is supported')
  for (const k of ['engine', 'launch']) {
    if (raw[k] !== undefined) errors.push(`${k}: a fork card has none. XLM Studio builds and launches llama.cpp forks itself; remove it`)
  }
  let source: ForkCard['source'] | null = null
  if (!isObj(raw.source) || !isStr(raw.source.repo) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.source.repo.trim())) {
    errors.push('source.repo: required, the GitHub repository as "owner/repo"')
  } else {
    unknownKeys(raw.source, ['repo', 'branch'], 'source', warnings)
    if (raw.source.branch !== undefined && !(isStr(raw.source.branch) && !/\s/.test(raw.source.branch))) errors.push('source.branch: must be a branch name')
    else source = { repo: raw.source.repo.trim(), ...(isStr(raw.source.branch) ? { branch: raw.source.branch.trim() } : {}) }
  }
  const checked = raw.params === undefined ? undefined : checkParams(raw.params, errors, warnings, false)
  const params = checked?.params
  let defaultOptions: Record<string, string[]> | undefined
  if (raw.defaultOptions !== undefined) {
    if (!isObj(raw.defaultOptions) || Object.values(raw.defaultOptions).some(v => !Array.isArray(v) || v.some(x => typeof x !== 'string'))) errors.push('defaultOptions: must map an arg to a list of strings')
    else defaultOptions = raw.defaultOptions as Record<string, string[]>
  }
  if (errors.length > 0 || !source) return { card: null, fork: null, errors, warnings }
  return {
    card: null,
    fork: {
      cardVersion: raw.cardVersion as number,
      id: raw.id as string,
      label: (raw.label as string).trim(),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      extends: 'llama.cpp',
      source,
      params,
      defaultOptions
    },
    errors,
    warnings
  }
}

export function validateEngineCard(raw: unknown): CardValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObj(raw)) return { card: null, errors: ['The file must hold one JSON object.'], warnings }
  if (raw.extends !== undefined) return validateForkCard(raw)
  unknownKeys(raw, ['cardVersion', 'id', 'label', 'description', 'engine', 'source', 'install', 'launch', 'params', 'overrides', 'checkpoints', 'memory'], 'card', warnings)

  checkIdentity(raw, errors)

  let folder = ''
  if (!isObj(raw.engine) || !isStr(raw.engine.folder)) errors.push('engine.folder: required, the engine\'s folder name inside the engines folder')
  else {
    folder = raw.engine.folder.trim()
    unknownKeys(raw.engine, ['folder'], 'engine', warnings)
    if (/[\\/:*?"<>|]/.test(folder) || folder.startsWith('.')) errors.push('engine.folder: must be a plain folder name')
    else if (RESERVED_FOLDERS.has(folder.toLowerCase())) errors.push(`engine.folder: "${folder}" is reserved`)
  }

  let launch: CardLaunch | null = null
  if (!isObj(raw.launch)) errors.push('launch: required')
  else {
    const l = raw.launch
    unknownKeys(l, ['file', 'argv', 'env', 'ready', 'stop', 'metrics'], 'launch', warnings)
    const files: string[] = []
    const addFile = (v: unknown, where: string): void => {
      const list = Array.isArray(v) ? v : [v]
      if (list.length === 0 || list.some(x => !isStr(x))) errors.push(`${where}: must be a file name, or a list of file names`)
      else files.push(...(list as string[]))
    }
    if (isStr(l.file) || Array.isArray(l.file)) addFile(l.file, 'launch.file')
    else if (isObj(l.file) && Object.keys(l.file).length > 0) {
      for (const [k, v] of Object.entries(l.file)) {
        if (!PLATFORMS.includes(k)) errors.push(`launch.file: unknown platform "${k}" (use ${PLATFORMS.join(', ')})`)
        else addFile(v, `launch.file.${k}`)
      }
    } else errors.push('launch.file: required, the launcher relative to the engine folder (or one per platform)')
    for (const f of files) { const bad = relativeFileProblem(f); if (bad) errors.push(`launch.file "${f}": ${bad}`) }

    if (!Array.isArray(l.argv)) errors.push('launch.argv: required, a list of arguments')
    else l.argv.forEach((t, i) => {
      const where = `launch.argv[${i}]`
      if (typeof t === 'string') checkArgvToken(t, where, errors, true)
      else if (Array.isArray(t) && t.length > 0 && t.every(x => typeof x === 'string')) (t as string[]).forEach(x => checkArgvToken(x, where, errors, false))
      else errors.push(`${where}: must be a string or a list of strings`)
    })

    if (l.env !== undefined) {
      if (!isObj(l.env) || Object.values(l.env).some(v => typeof v !== 'string')) errors.push('launch.env: must map names to strings')
      else for (const [k, v] of Object.entries(l.env)) checkArgvToken(v as string, `launch.env.${k}`, errors, false)
    }
    if (l.ready !== undefined) {
      if (!isObj(l.ready) || (l.ready.log === undefined && l.ready.http === undefined)) errors.push('launch.ready: needs "log" (a regular expression) and/or "http" (a path)')
      else {
        unknownKeys(l.ready, ['log', 'http'], 'launch.ready', warnings)
        if (l.ready.log !== undefined) {
          try { new RegExp(String(l.ready.log)) } catch { errors.push('launch.ready.log: not a valid regular expression') }
        }
        if (l.ready.http !== undefined && !(isStr(l.ready.http) && l.ready.http.startsWith('/'))) errors.push('launch.ready.http: must be a path starting with "/"')
      }
    }
    if (l.stop !== undefined) {
      if (!isObj(l.stop) || (l.stop.graceMs !== undefined && !(typeof l.stop.graceMs === 'number' && l.stop.graceMs >= 0 && l.stop.graceMs <= 120000))) errors.push('launch.stop.graceMs: must be a number from 0 to 120000')
    }
    if (l.metrics !== undefined) {
      if (!isObj(l.metrics) || typeof l.metrics.format !== 'string' || !METRIC_FORMATS.includes(l.metrics.format)) errors.push(`launch.metrics.format: must be one of ${METRIC_FORMATS.join(', ')}`)
      else if (l.metrics.path !== undefined && !(isStr(l.metrics.path) && l.metrics.path.startsWith('/'))) errors.push('launch.metrics.path: must be a path starting with "/"')
    }
    launch = l as unknown as CardLaunch
  }

  const checked = raw.params === undefined ? undefined : checkParams(raw.params, errors, warnings, true)
  const declared = checked?.declared ?? new Map<string, CommandParam>()
  if (checked) checkParamRefs(declared, checked.pending, errors)
  const categoryNames = checked?.params.categories.map(c => c.name) ?? []
  const logic = checkCardLogic({ raw, params: declared, categories: categoryNames, errors, warnings })
  const source = checkSource(raw.source, 'source', errors, warnings)
  const install = checkInstall(raw.install, errors, warnings)
  if (logic.rules || logic.blocks || logic.presets) {
    if (!checked) errors.push('params.rules, blocks and presets need params.categories')
  }
  if (errors.length > 0 || !launch) return { card: null, errors, warnings }
  const params = checked ? { ...checked.params, ...(logic.rules ? { rules: logic.rules } : {}), ...(logic.blocks ? { blocks: logic.blocks } : {}), ...(logic.presets ? { presets: logic.presets } : {}) } : undefined
  return {
    card: {
      cardVersion: raw.cardVersion as number,
      id: raw.id as string,
      label: (raw.label as string).trim(),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      engine: { folder },
      ...(source ? { source } : {}),
      ...(install ? { install } : {}),
      launch,
      params,
      ...(logic.overrides ? { overrides: logic.overrides } : {}),
      ...(logic.checkpoints ? { checkpoints: logic.checkpoints } : {}),
      ...(logic.memory ? { memory: logic.memory } : {})
    },
    errors,
    warnings
  }
}

export function cardToEngineDef(card: EngineCard): EngineDef {
  return {
    id: card.id,
    label: card.label,
    kind: 'generic',
    install: card.source ? 'git' : 'local',
    caps: {
      gpuLayers: false, backendSelection: 'flag', paramViewModes: false, slotCheckpoints: !!card.checkpoints,
      autoFit: false, samplingFlags: false, vramEstimator: card.memory ? 'llama' : 'none'
    },
    buildLabel: 'Engine version',
    followLabel: 'Follow global repo',
    card
  }
}

const PLATFORM_KEY: Record<string, CardPlatform> = { win32: 'windows', darwin: 'macos', linux: 'linux' }

// Launcher candidates for a platform, in the order they are tried.
export function cardLauncherCandidates(card: EngineCard, platform: string): string[] {
  const f = card.launch.file
  const list = (v: CardFile | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])
  if (typeof f === 'string' || Array.isArray(f)) return list(f)
  const own = f[PLATFORM_KEY[platform] ?? 'default']
  return own !== undefined ? list(own) : list(f.default)
}

// The first launcher candidate, for showing in the interface.
export function cardLauncherFile(card: EngineCard, platform: string): string | null {
  return cardLauncherCandidates(card, platform)[0] ?? null
}

export interface LauncherFs {
  exists: (path: string) => boolean
  // Names inside a folder; empty when it cannot be read.
  list: (path: string) => string[]
}

function segmentPattern(seg: string): RegExp {
  return new RegExp('^' + seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$', 'i')
}

// The first launcher candidate that exists under `dir`, as a path relative to it.
// "*" matches within one name, so "venv/*/python.exe" finds whichever folder is there.
export function findLauncher(dir: string, candidates: string[], fs: LauncherFs): string | null {
  for (const cand of candidates) {
    const segs = cand.split('/').filter(Boolean)
    let found: string[] = ['']
    for (const seg of segs) {
      const next: string[] = []
      for (const base of found) {
        const abs = base ? `${dir}/${base}` : dir
        if (!seg.includes('*')) {
          const rel = base ? `${base}/${seg}` : seg
          if (fs.exists(`${dir}/${rel}`)) next.push(rel)
          continue
        }
        const re = segmentPattern(seg)
        for (const name of fs.list(abs).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
          if (re.test(name)) next.push(base ? `${base}/${name}` : name)
        }
      }
      found = next
      if (found.length === 0) break
    }
    if (found.length > 0 && segs.length > 0) return found[0]
  }
  return null
}

export interface CardLaunchInput {
  modelPath: string
  port: number
  host?: string
  apiKey?: string
  engineDir: string
  args: Record<string, unknown>
  // What expressions can see besides the arguments; empty values when left out.
  context?: Partial<CardContext>
  // Parameters forced by the engine's override fields, by arg.
  overrideArgs?: Record<string, unknown>
}

function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

export function cardPlaceholderValues(input: CardLaunchInput): Record<string, string> {
  const hostArg = input.host ?? input.args['--host']
  const keyArg = input.apiKey ?? input.args['--api-key']
  return {
    model: input.modelPath,
    modelDir: input.modelPath ? dirOf(input.modelPath) : '',
    port: input.port > 0 ? String(input.port) : '',
    host: hostArg ? String(hostArg) : '',
    apiKey: keyArg ? String(keyArg) : '',
    engineDir: input.engineDir,
    name: input.context?.template?.name ?? ''
  }
}

function fill(text: string, values: Record<string, string>): { text: string; empty: boolean } {
  let empty = false
  const out = text.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values[name] ?? ''
    if (v === '') empty = true
    return v
  })
  return { text: out, empty }
}

export function cardContextOf(input: CardLaunchInput): CardContext {
  const base = emptyCardContext()
  return { ...base, ...input.context, args: input.args }
}

// The launcher's arguments, or what is missing for them. `resolved` is the
// state the arguments were built from, for previews that show what was applied.
export function buildCardArgv(card: EngineCard, input: CardLaunchInput): { argv: string[]; resolved: ResolvedCard } | { error: string } {
  const ctx = cardContextOf(input)
  const resolved = resolveCard(card, input.args, ctx, input.overrideArgs)
  if (resolved.missing.length > 0) return { error: resolved.missing.map(m => m.message).join(' ') }
  const values = cardPlaceholderValues({ ...input, args: resolved.args })
  const usesModel = JSON.stringify(card.launch.argv).includes('{model')
  if (usesModel && !values.model) return { error: `${card.label} needs a model file. Pick one in the Template.` }
  const argv: string[] = []
  for (const token of card.launch.argv) {
    // Free-text flags the card does not list follow the listed parameters.
    if (token === '{params}') { argv.push(...cardParamTokens(card, resolved, ctx), ...customArgsLaunchTokens(resolved.args[CUSTOM_ARGS_KEY])); continue }
    if (Array.isArray(token)) {
      const filled = token.map(t => fill(t, values))
      if (!filled.some(f => f.empty)) argv.push(...filled.map(f => f.text))
      continue
    }
    const f = fill(token, values)
    if (!f.empty) argv.push(f.text)
  }
  return { argv, resolved }
}

export function cardEnv(card: EngineCard, input: CardLaunchInput): Record<string, string> {
  const values = cardPlaceholderValues(input)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(card.launch.env ?? {})) out[k] = fill(v, values).text
  return out
}

// One card file as the Settings list and the renderer's engine registry see it.
export interface EngineCardInfo {
  id: string
  label: string
  // An engine card starts a program; a fork card adds a llama.cpp fork to the tracker.
  kind: 'engine' | 'fork'
  repo?: string
  branch?: string
  paramCount: number
  description?: string
  folder?: string
  file: string
  source: 'built-in' | 'custom'
  valid: boolean
  replaces: boolean
  errors: string[]
  warnings: string[]
  launcher: string | null
  card: EngineCard | null
}

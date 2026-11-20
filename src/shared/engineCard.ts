// Engine cards: a JSON file that describes an HTTP-serving engine well enough
// for XLM Studio to list, configure, launch and stop it. A card holds data
// only, so it is validated once on load and nothing in it can run code.
// Kept free of Node and React so the main process, the renderer and
// scripts/engine-card-verify.js all read it the same way.

import type { CommandCategory, CommandParam } from './types'
import type { EngineDef } from './engines'
import { isBuiltinEngine } from './engines'

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

export interface CardLaunch {
  // Launcher, relative to the engine folder: one file, or one per platform.
  file: string | Partial<Record<CardPlatform, string>>
  // A string is one argument. An array is a group that is left out when any
  // placeholder in it has no value (["--api-key", "{apiKey}"]).
  argv: Array<string | string[]>
  env?: Record<string, string>
  ready?: CardReady
  stop?: { graceMs?: number }
  metrics?: CardMetrics
}

export interface EngineCard {
  cardVersion: number
  id: string
  label: string
  description?: string
  engine: { folder: string }
  launch: CardLaunch
  params?: { categories: CommandCategory[] }
}

export const CARD_PLACEHOLDERS = ['model', 'modelDir', 'port', 'host', 'apiKey', 'engineDir', 'params'] as const
const PLACEHOLDER_RE = /\{([A-Za-z]+)\}/g

export const DEFAULT_READY: CardReady = { http: '/v1/models' }

const PARAM_TYPES = ['boolean', 'number', 'string', 'select', 'text']
const METRIC_FORMATS = ['prometheus', 'none']
const PLATFORMS = ['windows', 'macos', 'linux', 'default']
const RESERVED_FOLDERS = new Set(['strata-data'])

export interface CardValidation {
  card: EngineCard | null
  errors: string[]
  warnings: string[]
}

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

function checkParams(raw: unknown, errors: string[], warnings: string[]): { categories: CommandCategory[] } | undefined {
  if (!isObj(raw)) { errors.push('params: must be an object with a "categories" list'); return undefined }
  unknownKeys(raw, ['categories'], 'params', warnings)
  if (!Array.isArray(raw.categories)) { errors.push('params.categories: must be a list'); return undefined }
  const seen = new Set<string>()
  const categories: CommandCategory[] = []
  raw.categories.forEach((c, ci) => {
    const at = `params.categories[${ci}]`
    if (!isObj(c) || !isStr(c.name)) { errors.push(`${at}: needs a "name"`); return }
    if (!Array.isArray(c.commands)) { errors.push(`${at}.commands: must be a list`); return }
    const commands: CommandParam[] = []
    c.commands.forEach((p, pi) => {
      const where = `${at}.commands[${pi}]`
      if (!isObj(p) || !isStr(p.arg)) { errors.push(`${where}: needs an "arg"`); return }
      if (seen.has(p.arg)) { errors.push(`${where}: "${p.arg}" is listed twice`); return }
      seen.add(p.arg)
      if (p.arg.startsWith('__')) errors.push(`${where}: "${p.arg}" is reserved for internal settings`)
      if (!isStr(p.label)) errors.push(`${where}: needs a "label"`)
      if (typeof p.type !== 'string' || !PARAM_TYPES.includes(p.type)) { errors.push(`${where}: "type" must be one of ${PARAM_TYPES.join(', ')}`); return }
      if (p.type === 'select' && (!Array.isArray(p.options) || p.options.length === 0 || p.options.some(o => typeof o !== 'string'))) errors.push(`${where}: a select needs a list of string "options"`)
      if (typeof p.min === 'number' && typeof p.max === 'number' && p.min > p.max) errors.push(`${where}: "min" is above "max"`)
      if (p.offArg !== undefined && p.type !== 'boolean') errors.push(`${where}: "offArg" is only for booleans`)
      if (p.format !== undefined && p.format !== 'space' && p.format !== 'equals') errors.push(`${where}: "format" must be "space" or "equals"`)
      commands.push({ ...(p as unknown as CommandParam), description: typeof p.description === 'string' ? p.description : '' })
    })
    categories.push({ name: c.name, icon: typeof c.icon === 'string' ? c.icon : 'Sliders', commands })
  })
  return { categories }
}

export function validateEngineCard(raw: unknown): CardValidation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isObj(raw)) return { card: null, errors: ['The file must hold one JSON object.'], warnings }
  unknownKeys(raw, ['cardVersion', 'id', 'label', 'description', 'engine', 'launch', 'params'], 'card', warnings)

  if (typeof raw.cardVersion !== 'number') errors.push('cardVersion: required, a number (currently 1)')
  else if (raw.cardVersion > CARD_VERSION) errors.push(`cardVersion ${raw.cardVersion} was made for a newer XLM Studio`)
  else if (raw.cardVersion < 1) errors.push('cardVersion: must be 1 or higher')

  if (!isStr(raw.id) || !/^[a-z0-9][a-z0-9._-]{0,39}$/.test(raw.id)) errors.push('id: required, lowercase letters, digits, ".", "_" or "-", up to 40 characters')
  else if (isBuiltinEngine(raw.id)) errors.push(`id: "${raw.id}" is a built-in engine`)
  if (!isStr(raw.label)) errors.push('label: required, the name shown in the app')

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
    if (isStr(l.file)) files.push(l.file)
    else if (isObj(l.file) && Object.keys(l.file).length > 0) {
      for (const [k, v] of Object.entries(l.file)) {
        if (!PLATFORMS.includes(k)) errors.push(`launch.file: unknown platform "${k}" (use ${PLATFORMS.join(', ')})`)
        else if (!isStr(v)) errors.push(`launch.file.${k}: must be a file name`)
        else files.push(v)
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

  const params = raw.params === undefined ? undefined : checkParams(raw.params, errors, warnings)
  if (errors.length > 0 || !launch) return { card: null, errors, warnings }
  return {
    card: {
      cardVersion: raw.cardVersion as number,
      id: raw.id as string,
      label: (raw.label as string).trim(),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      engine: { folder },
      launch,
      params
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
    install: 'local',
    caps: { gpuLayers: false, backendSelection: 'flag', paramViewModes: false, slotCheckpoints: false, autoFit: false, samplingFlags: false, vramEstimator: 'none' },
    buildLabel: 'Engine version',
    followLabel: 'Follow global repo',
    card
  }
}

const PLATFORM_KEY: Record<string, CardPlatform> = { win32: 'windows', darwin: 'macos', linux: 'linux' }

// The launcher file for a platform, or null when the card has none for it.
export function cardLauncherFile(card: EngineCard, platform: string): string | null {
  const f = card.launch.file
  if (typeof f === 'string') return f
  return f[PLATFORM_KEY[platform] ?? 'default'] ?? f.default ?? null
}

function paramTokens(card: EngineCard, args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const cat of card.params?.categories ?? []) {
    for (const cmd of cat.commands) {
      const v = args[cmd.arg]
      if (v === undefined || v === null) continue
      if (cmd.type === 'boolean') {
        if (v === true) out.push(cmd.arg)
        else if (v === false && cmd.offArg) out.push(cmd.offArg)
        continue
      }
      const text = String(v).trim()
      if (!text) continue
      if (cmd.format === 'equals') out.push(`${cmd.arg}=${text}`)
      else out.push(cmd.arg, text)
    }
  }
  return out
}

export interface CardLaunchInput {
  modelPath: string
  port: number
  host?: string
  apiKey?: string
  engineDir: string
  args: Record<string, unknown>
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
    engineDir: input.engineDir
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

// The launcher's arguments, or what is missing for them.
export function buildCardArgv(card: EngineCard, input: CardLaunchInput): { argv: string[] } | { error: string } {
  const values = cardPlaceholderValues(input)
  const usesModel = JSON.stringify(card.launch.argv).includes('{model')
  if (usesModel && !values.model) return { error: `${card.label} needs a model file. Pick one in the Template.` }
  const argv: string[] = []
  for (const token of card.launch.argv) {
    if (token === '{params}') { argv.push(...paramTokens(card, input.args)); continue }
    if (Array.isArray(token)) {
      const filled = token.map(t => fill(t, values))
      if (!filled.some(f => f.empty)) argv.push(...filled.map(f => f.text))
      continue
    }
    const f = fill(token, values)
    if (!f.empty) argv.push(f.text)
  }
  return { argv }
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

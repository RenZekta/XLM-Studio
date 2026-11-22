import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import type { SpawnOptions } from 'child_process'
import { cardLauncherCandidates, cardToEngineDef, findLauncher, validateEngineCard, type EngineCard, type ForkCard } from '../shared/engineCard'
import { registerCardEngines } from '../shared/engines'
import { cardWarnings, formatCardReport } from '../shared/cardReport'
import type { BackendVersion } from '../shared/types'

// Built-in cards ship with the app (read-only). Custom cards live in the data
// folder next to the Templates; a custom card with a built-in card's id
// replaces it. A card is an engine card (a program XLM Studio starts) or a fork
// card (a llama.cpp fork XLM Studio builds and runs itself).

export interface LoadedCard {
  file: string
  source: 'built-in' | 'custom'
  kind: 'engine' | 'fork'
  // Set when the file is a valid engine card / a valid fork card.
  card: EngineCard | null
  fork: ForkCard | null
  // Read from the file even when it is not valid.
  id: string
  errors: string[]
  warnings: string[]
  // A built-in card of the same id exists and this card takes its place.
  replaces?: boolean
}

let loaded: LoadedCard[] = []
let active = new Map<string, EngineCard>()
let activeForks = new Map<string, ForkCard>()
let dirs: { builtin: string; custom: string } = { builtin: '', custom: '' }
// The args llama.cpp's own parameter list already has, to warn about copies.
let baseArgs: () => string[] = () => []

const ERRORS_SUFFIX = '.errors.txt'

function readCardFiles(dir: string, source: LoadedCard['source']): LoadedCard[] {
  if (!dir || !existsSync(dir)) return []
  const out: LoadedCard[] = []
  for (const name of readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, name)
    const stem = name.replace(/\.json$/i, '')
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      out.push({ file, source, kind: 'engine', card: null, fork: null, id: stem, errors: [`Not valid JSON: ${(err as Error).message}`], warnings: [] })
      continue
    }
    const v = validateEngineCard(raw)
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { id?: unknown; extends?: unknown }) : null
    const id = v.card?.id ?? v.fork?.id ?? (typeof obj?.id === 'string' ? obj.id : stem)
    out.push({ file, source, kind: obj?.extends !== undefined ? 'fork' : 'engine', card: v.card, fork: v.fork ?? null, id, errors: v.errors, warnings: cardWarnings(v) })
  }
  return out
}

// Next to a custom card, so whoever wrote it (often an agent) can read what to
// fix. Removed once the card is valid and has nothing to warn about.
function syncErrorFile(c: LoadedCard): void {
  if (c.source !== 'custom') return
  const report = c.file.replace(/\.json$/i, ERRORS_SUFFIX)
  try {
    if (c.errors.length === 0 && c.warnings.length === 0) { if (existsSync(report)) unlinkSync(report); return }
    writeFileSync(report, formatCardReport({ card: c.card, errors: c.errors, warnings: c.warnings }, process.platform))
  } catch { /* the list in Settings shows the same text */ }
}

const isValid = (c: LoadedCard): boolean => !!(c.card || c.fork)

export function refreshEngineCards(): LoadedCard[] {
  const builtin = readCardFiles(dirs.builtin, 'built-in')
  const custom = readCardFiles(dirs.custom, 'custom')
  const byId = new Map<string, LoadedCard>()
  for (const c of builtin) if (isValid(c)) byId.set(c.id, c)
  for (const c of custom) {
    if (!isValid(c)) continue
    const prior = byId.get(c.id)
    if (prior?.source === 'custom') {
      c.errors.push(`Another card already uses the id "${c.id}" (${prior.file})`)
      c.card = null
      c.fork = null
    } else {
      if (prior) c.replaces = true
      byId.set(c.id, c)
    }
  }
  loaded = [...builtin, ...custom]
  active = new Map()
  activeForks = new Map()
  let base: Set<string> | null = null
  for (const c of byId.values()) {
    if (c.card) active.set(c.card.id, c.card)
    if (c.fork) {
      activeForks.set(c.fork.id, c.fork)
      // A parameter llama.cpp already has is shown once, from its own list.
      base ??= new Set(baseArgs())
      for (const cat of c.fork.params?.categories ?? []) {
        for (const cmd of cat.commands) {
          if (base.has(cmd.arg)) c.warnings.push(`${cmd.arg} is already a built-in llama.cpp parameter; the card's copy is ignored. List only what the fork adds.`)
        }
      }
    }
  }
  for (const c of custom) syncErrorFile(c)
  registerCardEngines(Array.from(active.values(), cardToEngineDef))
  return loaded
}

export function initEngineCards(builtinDir: string, customDir: string, onChange: () => void, baseArgsOf?: () => string[]): void {
  dirs = { builtin: builtinDir, custom: customDir }
  if (baseArgsOf) baseArgs = baseArgsOf
  try { mkdirSync(customDir, { recursive: true }) } catch { /* listing then shows nothing */ }
  refreshEngineCards()
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    // An editor saves in several steps, so changes are read once they settle.
    watch(customDir, { persistent: false }, (_e, name) => {
      if (name && name.toLowerCase().endsWith(ERRORS_SUFFIX)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { timer = null; refreshEngineCards(); onChange() }, 400)
    })
  } catch { /* cards are then read at start and on refresh */ }
}

export function listLoadedCards(): LoadedCard[] {
  return loaded
}

export function customCardsDir(): string {
  return dirs.custom
}

// The card in effect for an engine id (a custom card wins over a built-in one).
export function engineCardOf(id: string): EngineCard | null {
  return active.get(id) ?? null
}

// The fork cards in effect, merged into the Engine Tracker's list.
export function activeForkCards(): ForkCard[] {
  return Array.from(activeForks.values())
}

export function cardForFolder(folder: string): EngineCard | null {
  for (const card of active.values()) if (card.engine.folder.toLowerCase() === folder.toLowerCase()) return card
  return null
}

// Installs of a card's engine: each folder of <engines>/<folder>/ that holds
// the launcher is one version, or the folder itself when it holds the launcher.
export function scanCardEngine(card: EngineCard, forkDir: string, folderName: string, rootDir: string, rootIndex: number, external: boolean): BackendVersion[] {
  const candidates = cardLauncherCandidates(card, process.platform)
  if (candidates.length === 0) return []
  const fs = { exists: (p: string) => existsSync(p), list: (p: string) => { try { return readdirSync(p) } catch { return [] } } }
  const make = (name: string, path: string, launcher: string): BackendVersion => ({
    id: `${rootIndex}::${folderName}::${name}`,
    name,
    displayName: name === 'local' ? card.label : `${card.label} (${name})`,
    backendKey: folderName,
    backendType: null,
    version: name,
    path,
    exe: launcher,
    hasCommands: false,
    engine: card.id,
    rootDir,
    external
  })
  const versions: BackendVersion[] = []
  try {
    for (const d of readdirSync(forkDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const path = join(forkDir, d.name)
      const launcher = findLauncher(path, candidates, fs)
      if (launcher) versions.push(make(d.name, path, launcher))
    }
  } catch { /* unreadable folder: nothing installed */ }
  if (versions.length === 0) {
    const launcher = findLauncher(forkDir, candidates, fs)
    if (launcher) versions.push(make('local', forkDir, launcher))
  }
  return versions.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
}

export interface CardSpawnSpec { command: string; args: string[]; options: SpawnOptions }

// The launcher runs through the interpreter its extension implies. Output is
// read from pipes and stdin is closed, so a script that waits for a keypress
// returns instead.
export function buildCardSpawn(launcherPath: string, argv: string[], extraEnv: Record<string, string>): CardSpawnSpec | { error: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extraEnv }
  const stdio: SpawnOptions['stdio'] = ['ignore', 'pipe', 'pipe']
  const ext = extname(launcherPath).toLowerCase()
  const cwd = dirname(launcherPath)
  const win = process.platform === 'win32'
  if (win && (ext === '.bat' || ext === '.cmd')) {
    const bad = argv.find(a => /["%]/.test(a))
    if (bad) return { error: `A .bat launcher cannot take "${bad}" safely because it contains a quote or percent sign.` }
    const line = [launcherPath, ...argv].map(a => `"${a}"`).join(' ')
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      options: { cwd, env, stdio, windowsVerbatimArguments: true, windowsHide: true }
    }
  }
  const options: SpawnOptions = { cwd, env, stdio, detached: !win, windowsHide: true }
  if (ext === '.ps1') return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, ...argv], options }
  if (ext === '.py') return { command: win ? 'python' : 'python3', args: [launcherPath, ...argv], options }
  if (ext === '.sh') return { command: 'bash', args: [launcherPath, ...argv], options }
  return { command: launcherPath, args: argv, options }
}

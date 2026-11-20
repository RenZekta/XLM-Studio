import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'fs'
import { dirname, extname, join } from 'path'
import type { SpawnOptions } from 'child_process'
import { cardLauncherFile, cardToEngineDef, validateEngineCard, type EngineCard } from '../shared/engineCard'
import { registerCardEngines } from '../shared/engines'
import type { BackendVersion } from '../shared/types'

// Built-in cards ship with the app (read-only). Custom cards live in the data
// folder next to the Templates; a custom card with a built-in card's id
// replaces it.

export interface LoadedCard {
  file: string
  source: 'built-in' | 'custom'
  // Set when the file is valid; id is read from the file even when it is not.
  card: EngineCard | null
  id: string
  errors: string[]
  warnings: string[]
  // A built-in card of the same id exists and this card takes its place.
  replaces?: boolean
}

let loaded: LoadedCard[] = []
let active = new Map<string, EngineCard>()
let dirs: { builtin: string; custom: string } = { builtin: '', custom: '' }

const ERRORS_SUFFIX = '.errors.txt'

function readCardFiles(dir: string, source: LoadedCard['source']): LoadedCard[] {
  if (!dir || !existsSync(dir)) return []
  const out: LoadedCard[] = []
  for (const name of readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort()) {
    const file = join(dir, name)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      out.push({ file, source, card: null, id: name.replace(/\.json$/i, ''), errors: [`Not valid JSON: ${(err as Error).message}`], warnings: [] })
      continue
    }
    const v = validateEngineCard(raw)
    const id = v.card?.id ?? (typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : name.replace(/\.json$/i, ''))
    out.push({ file, source, card: v.card, id, errors: v.errors, warnings: v.warnings })
  }
  return out
}

// Next to a broken custom card, so whoever wrote it (often an agent) can read
// what to fix. Removed once the card is valid.
function syncErrorFile(c: LoadedCard): void {
  if (c.source !== 'custom') return
  const report = c.file.replace(/\.json$/i, ERRORS_SUFFIX)
  try {
    if (c.errors.length === 0) { if (existsSync(report)) unlinkSync(report); return }
    writeFileSync(report, `${c.errors.map(e => `- ${e}`).join('\n')}\n`)
  } catch { /* the list in Settings shows the same errors */ }
}

export function refreshEngineCards(): LoadedCard[] {
  const builtin = readCardFiles(dirs.builtin, 'built-in')
  const custom = readCardFiles(dirs.custom, 'custom')
  const byId = new Map<string, LoadedCard>()
  for (const c of builtin) if (c.card) byId.set(c.card.id, c)
  for (const c of custom) {
    if (!c.card) continue
    const prior = byId.get(c.card.id)
    if (prior?.source === 'custom') {
      c.errors.push(`Another card already uses the id "${c.card.id}" (${prior.file})`)
      c.card = null
    } else {
      if (prior) c.replaces = true
      byId.set(c.card.id, c)
    }
  }
  loaded = [...builtin, ...custom]
  active = new Map(Array.from(byId.values(), c => [(c.card as EngineCard).id, c.card as EngineCard]))
  for (const c of custom) syncErrorFile(c)
  registerCardEngines(Array.from(byId.values(), c => cardToEngineDef(c.card as EngineCard)))
  return loaded
}

export function initEngineCards(builtinDir: string, customDir: string, onChange: () => void): void {
  dirs = { builtin: builtinDir, custom: customDir }
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

export function cardForFolder(folder: string): EngineCard | null {
  for (const card of active.values()) if (card.engine.folder.toLowerCase() === folder.toLowerCase()) return card
  return null
}

// Installs of a card's engine: each folder of <engines>/<folder>/ that holds
// the launcher is one version, or the folder itself when it holds the launcher.
export function scanCardEngine(card: EngineCard, forkDir: string, folderName: string, rootDir: string, rootIndex: number, external: boolean): BackendVersion[] {
  const launcher = cardLauncherFile(card, process.platform)
  if (!launcher) return []
  const make = (name: string, path: string): BackendVersion => ({
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
      if (existsSync(join(forkDir, d.name, launcher))) versions.push(make(d.name, join(forkDir, d.name)))
    }
  } catch { /* unreadable folder: nothing installed */ }
  if (versions.length === 0 && existsSync(join(forkDir, launcher))) versions.push(make('local', forkDir))
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

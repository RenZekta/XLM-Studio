import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { spawn, type SpawnOptions } from 'child_process'

// The drafter choice lives in the run config's "drafting" key, which the server
// reads at every start. setup.py's --drafter only controls what setup downloads
// and accepts mtp or dflash2, so the Template's --drafter is written to the run
// config here and passed on to setup only as dflash2.

export const DRAFTING_MODES = ['auto', 'mtp', 'dflash2', 'off'] as const
export type DraftingMode = (typeof DRAFTING_MODES)[number]

export function normalizeDrafting(v: unknown): DraftingMode {
  const t = String(v ?? '').trim().toLowerCase()
  return (DRAFTING_MODES as readonly string[]).includes(t) ? (t as DraftingMode) : 'auto'
}

// Left out means auto.
export function splitDrafter(argv: string[]): { argv: string[]; mode: DraftingMode } {
  const i = argv.indexOf('--drafter')
  if (i === -1) return { argv, mode: 'auto' }
  const mode = normalizeDrafting(argv[i + 1])
  const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith('--')
  if (mode === 'dflash2') return { argv, mode }
  const rest = argv.slice(0, i).concat(argv.slice(i + (hasValue ? 2 : 1)))
  return { argv: rest, mode }
}

// setup.py names it strata-<family tag><model>.json, lower case.
export function runConfigPath(cloneDir: string, tags: Record<string, string>, family: string, model: string): string | null {
  if (!(family in tags) || !model) return null
  return join(cloneDir, `strata-${(tags[family] + model).toLowerCase()}.json`)
}

// setup writes the run config with indent=1.
export function withDrafting(text: string, mode: DraftingMode): { text: string; changed: boolean; previous: DraftingMode } | null {
  let cfg: Record<string, unknown>
  try {
    cfg = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return null
  const previous = normalizeDrafting(cfg.drafting)
  if (previous === mode && (mode !== 'auto' || cfg.drafting === undefined || cfg.drafting === 'auto')) {
    return { text, changed: false, previous }
  }
  cfg.drafting = mode
  return { text: JSON.stringify(cfg, null, 1), changed: true, previous }
}

export function venvPython(cloneDir: string): string {
  return process.platform === 'win32' ? join(cloneDir, '.venv', 'Scripts', 'python.exe') : join(cloneDir, '.venv', 'bin', 'python')
}

// Downloads the DFlash2 files only if they are missing.
export function draftingFetchArgv(cloneDir: string, cfgPath: string, dataDir: string): string[] {
  return [join(cloneDir, 'strata.py'), 'drafting', 'fetch', '--if-needed', '--mode', 'dflash2', '--config', cfgPath, '--data-dir', dataDir]
}

export interface StepIO {
  log: (line: string) => void
}

// Resolves with the exit code, or null if the process could not start.
export function runStep(command: string, args: string[], options: SpawnOptions, io: StepIO): Promise<number | null> {
  return new Promise(resolve => {
    let proc
    try {
      proc = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      io.log(`Could not start ${command}: ${(e as Error).message}`)
      resolve(null)
      return
    }
    const feed = (d: Buffer) => d.toString('utf8').split(/\r?\n/).filter(l => l.trim()).forEach(l => io.log(l))
    proc.stdout?.on('data', feed)
    proc.stderr?.on('data', feed)
    proc.on('error', e => { io.log(`Could not run ${command}: ${e.message}`); resolve(null) })
    proc.on('close', code => resolve(code))
  })
}

export function writeConfigAtomic(path: string, text: string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export interface PrepareInput {
  cloneDir: string
  dataDir: string
  family: string
  model: string
  mode: DraftingMode
  tags: Record<string, string>
  // Runs setup with --no-start to create the run config of a model's first launch.
  installOnly: () => Promise<number | null>
  env: NodeJS.ProcessEnv
  io: StepIO
}

// Never throws: a failed step is logged and the launch goes on.
export async function prepareDrafting(p: PrepareInput): Promise<void> {
  const { io } = p
  try {
    const cfgPath = runConfigPath(p.cloneDir, p.tags, p.family, p.model)
    if (!cfgPath) {
      if (p.mode !== 'auto') io.log(`Drafter: unknown family "${p.family}", ${p.mode} not saved.`)
      return
    }
    if (!existsSync(cfgPath) && p.mode === 'auto') return
    if (!existsSync(cfgPath)) {
      io.log(`Drafter: no run config yet, installing first to save ${p.mode} ...`)
      const code = await p.installOnly()
      if (code !== 0 || !existsSync(cfgPath)) {
        io.log(`Drafter: install ${code === 0 ? 'wrote no run config' : `failed (exit ${code})`}, ${p.mode} not saved.`)
        return
      }
    }
    const next = withDrafting(readFileSync(cfgPath, 'utf8'), p.mode)
    if (!next) {
      io.log(`Drafter: ${cfgPath} is not valid JSON, ${p.mode} not saved.`)
      return
    }
    if (next.changed) {
      writeConfigAtomic(cfgPath, next.text)
      io.log(`Drafter: ${p.mode} saved (was ${next.previous}).`)
    }
    if (p.mode !== 'dflash2') return
    const py = venvPython(p.cloneDir)
    if (!existsSync(py)) {
      io.log('Drafter: no Python environment yet, DFlash2 files not checked. Without them Strata starts the MTP.')
      return
    }
    io.log('Drafter: checking DFlash2 files (about 1.2 GB if a download is needed) ...')
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...p.env }
    const code = await runStep(py, draftingFetchArgv(p.cloneDir, cfgPath, p.dataDir), { cwd: p.cloneDir, env, windowsHide: true }, io)
    if (code !== 0) io.log(`Drafter: DFlash2 check failed (${code === null ? 'could not run' : `exit ${code}`}). Without the files Strata starts the MTP.`)
  } catch (e) {
    io.log(`Drafter: ${(e as Error).message}`)
  }
}

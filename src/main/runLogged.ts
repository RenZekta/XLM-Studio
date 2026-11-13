import { spawn, type ChildProcess } from 'child_process'
import { LineAssembler } from './lineAssembler'

// Runs external tools (git, cmake, package managers) with every output line
// forwarded to a log. Shared by the source build and the build tool installer.

export interface RunHooks {
  // app: a message of ours rather than output of a tool.
  log: (line: string, app?: boolean) => void
  killTree: (proc: ChildProcess) => Promise<void>
  signal: AbortSignal
}

// The environment a child runs in: ours, plus what the caller adds. Windows
// names variables case-insensitively, so "Path" from a Visual Studio
// environment replaces our "PATH" instead of sitting beside it.
function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  for (const [key, value] of Object.entries(extra)) {
    if (process.platform === 'win32') {
      for (const existing of Object.keys(env)) if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete env[existing]
    }
    env[key] = value
  }
  return env
}

export class BuildFailed extends Error {}

export function fail(message: string): never {
  throw new BuildFailed(message)
}

// Runs one command, forwarding every output line. Resolves with the exit code,
// or null when the process was killed by a cancel.
export function run(
  cmd: string, args: string[], hooks: RunHooks,
  opts: {
    cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; quiet?: boolean
    // For the .cmd shims npm creates on Windows, which only a shell can start.
    shell?: boolean
    // For a command that can go quiet for minutes (an installer): when it has
    // printed nothing for this long, a line says it is still running, with
    // whatever `describe` can tell about what it is doing.
    heartbeat?: { everyMs: number; describe?: () => string | null }
  } = {}
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (hooks.signal.aborted) return resolve(null)
    if (!opts.quiet) hooks.log(`$ ${[cmd, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`, true)
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: childEnv(opts.env),
      windowsHide: true,
      shell: opts.shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const started = Date.now()
    let lastOutput = started
    const emit = (line: string) => {
      lastOutput = Date.now()
      opts.onLine?.(line)
      if (!opts.quiet) hooks.log(line)
    }
    const beat = opts.heartbeat
    const timer = beat ? setInterval(() => {
      if (Date.now() - lastOutput < beat.everyMs - 50) return
      const m = Math.floor((Date.now() - started) / 60000)
      const sec = Math.floor((Date.now() - started) / 1000) % 60
      let detail: string | null = null
      try { detail = beat.describe?.() ?? null } catch { /* a description is a convenience */ }
      hooks.log(`Still running after ${m}:${String(sec).padStart(2, '0')}${detail ? `: ${detail}` : ' (it prints nothing while it works)'}`, true)
    }, beat.everyMs) : null
    // Compiler output arrives on both pipes; each gets its own assembler so a
    // line split across chunks is never joined to the other stream's text.
    const out = new LineAssembler()
    const err = new LineAssembler()
    proc.stdout?.on('data', d => out.push(d).forEach(emit))
    proc.stderr?.on('data', d => err.push(d).forEach(emit))
    const onAbort = () => { void hooks.killTree(proc) }
    hooks.signal.addEventListener('abort', onAbort, { once: true })
    proc.on('error', e => {
      if (timer) clearInterval(timer)
      hooks.signal.removeEventListener('abort', onAbort)
      reject((e as NodeJS.ErrnoException).code === 'ENOENT' ? new BuildFailed(`${cmd} was not found on PATH.`) : e)
    })
    proc.on('close', code => {
      if (timer) clearInterval(timer)
      hooks.signal.removeEventListener('abort', onAbort)
      out.end().forEach(emit)
      err.end().forEach(emit)
      resolve(hooks.signal.aborted ? null : code)
    })
  })
}

export async function runOrFail(cmd: string, args: string[], hooks: RunHooks, what: string, opts: Parameters<typeof run>[3] = {}): Promise<void> {
  const code = await run(cmd, args, hooks, opts)
  if (code === null) throw new BuildFailed('Cancelled')
  if (code !== 0) fail(`${what} failed (exit code ${code}). See the log for details.`)
}


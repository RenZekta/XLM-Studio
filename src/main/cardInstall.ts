// Makes a card's engine ready: clones (or updates) the repository named in the
// card's `source`, then runs its `install.steps` inside the clone. Steps are
// programs with arguments, run without a shell, with every output line sent to
// the log. Plain Node, so it can be tested without Electron.

import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { EngineCard } from '../shared/engineCard'
import { run, BuildFailed, type RunHooks } from './runLogged'
import { githubCloneUrl } from './strataEngine'

const PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' } as const

export interface InstallResult { ok: boolean; path?: string; error?: string }

// Package managers on Windows are .cmd shims, which only a shell can start.
const NEEDS_SHELL = new Set(['npm', 'npx', 'pnpm', 'yarn'])

export async function installCardEngine(
  card: EngineCard,
  rootDir: string,
  hooks: RunHooks,
  opts: { cloneUrl?: string; platform?: string } = {}
): Promise<InstallResult> {
  if (!card.source && !card.install) return { ok: false, error: `${card.label} has no source or install steps in its card.` }
  const platform = PLATFORM[(opts.platform ?? process.platform) as keyof typeof PLATFORM] ?? 'linux'
  const folder = join(rootDir, card.engine.folder)
  const dest = card.source ? join(folder, card.source.repo.split('/')[1]) : join(folder, 'local')
  try {
    mkdirSync(folder, { recursive: true })
    if (card.source) {
      const url = opts.cloneUrl ?? githubCloneUrl(card.source.repo)
      if (!url) return { ok: false, error: `Not a GitHub repository: ${card.source.repo}` }
      if (existsSync(join(dest, '.git'))) {
        hooks.log(`Updating ${card.source.repo}`, true)
        const code = await run('git', ['-C', dest, 'pull', '--ff-only'], hooks)
        if (code === null) return { ok: false, error: 'Cancelled' }
        if (code !== 0) return { ok: false, error: 'git pull failed. See the log for details.' }
      } else {
        if (existsSync(dest)) return { ok: false, error: `${dest} already exists and is not a git clone of ${card.source.repo}.` }
        hooks.log(`Cloning ${card.source.repo}`, true)
        const args = ['clone', '--progress']
        if (card.source.branch) args.push('--branch', card.source.branch)
        args.push('--', url, dest)
        const code = await run('git', args, hooks, { env: { GIT_ALLOW_PROTOCOL: opts.cloneUrl ? 'file:https' : 'https' } })
        if (code === null) return { ok: false, error: 'Cancelled' }
        if (code !== 0) return { ok: false, error: 'git clone failed. See the log for details.' }
      }
    } else mkdirSync(dest, { recursive: true })

    for (const [i, step] of (card.install?.steps ?? []).entries()) {
      if (step.platform && !step.platform.includes(platform)) continue
      const [cmd, ...rest] = step.run.map(t => t.replace(/\{engineDir\}/g, dest))
      hooks.log(`Step ${i + 1}: ${step.run.join(' ')}`, true)
      const shell = (opts.platform ?? process.platform) === 'win32' && NEEDS_SHELL.has(cmd.toLowerCase())
      const code = await run(cmd, rest, hooks, { cwd: dest, shell, heartbeat: { everyMs: 30000 } })
      if (code === null) return { ok: false, error: 'Cancelled' }
      if (code !== 0) return { ok: false, error: `Step ${i + 1} (${cmd}) failed with exit code ${code}. See the log for details.` }
    }
    hooks.log(`${card.label} is ready.`, true)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: err instanceof BuildFailed ? err.message : err instanceof Error ? err.message : String(err) }
  }
}

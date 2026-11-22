// What is worth telling the author of a card beyond errors: things that load
// but probably do not do what was meant (lints), and the command lines the card
// produces for a sample model. Shared by the sidecar report next to a card in
// the app and by the standalone checker an agent runs while writing one.

import type { CardValidation, EngineCard } from './engineCard'
import { buildCardArgv, cardLauncherCandidates } from './engineCard'
import { applyPreset, cardParams } from './cardRules'
import type { CommandParam } from './types'
import { buildModelContext, buildSystemContext, emptyCardContext, type CardContext } from './cardContext'

const WINDOWS_ONLY = /\.(exe|bat|cmd|ps1)$/i
const UNIX_ONLY = /\.(sh)$/i

export function lintCard(v: CardValidation): string[] {
  const out: string[] = []
  const card = v.card
  if (!card) return out
  const argvText = JSON.stringify(card.launch.argv)
  const params = cardParams(card)

  if (!/\{port\}/.test(argvText) && !JSON.stringify(card.launch.env ?? {}).includes('{port}') && !params.some(p => /port/i.test(p.arg))) {
    out.push('The launch arguments never pass {port}. XLM Studio waits for the engine on its port, so the engine must be told to listen on it.')
  }
  if (params.length > 0 && !card.launch.argv.includes('{params}')) {
    out.push('The card lists parameters but "launch.argv" has no "{params}" entry, so none of them is ever sent.')
  }
  const platformFiles = card.launch.file
  const all = typeof platformFiles === 'string' ? [platformFiles] : Array.isArray(platformFiles) ? platformFiles : Object.values(platformFiles).flat()
  if (typeof platformFiles === 'string' || Array.isArray(platformFiles)) {
    const list = ([] as string[]).concat(platformFiles)
    if (list.length > 0 && list.every(f => WINDOWS_ONLY.test(f))) out.push(`The launcher (${list.join(', ')}) only exists on Windows. Give a launcher per platform ("launch.file": { "windows": ..., "default": ... }) or a candidate list if the engine also runs elsewhere.`)
    else if (list.length > 0 && list.every(f => UNIX_ONLY.test(f))) out.push(`The launcher (${list.join(', ')}) is a shell script, so the engine cannot start on Windows. Add a "windows" launcher if it runs there.`)
  }
  if (all.length === 0) out.push('The card names no launcher.')
  for (const p of params) {
    if (!p.description && p.exprs?.description === undefined) out.push(`${p.arg} has no description, so a user cannot tell what it does.`)
    if (!p.arg.startsWith('-')) out.push(`${p.arg} does not start with "-". Parameters are command-line flags; check that this is what the engine takes.`)
  }
  const used = new Set<string>()
  const scan = (s: unknown) => { for (const m of JSON.stringify(s ?? '').matchAll(/(--?[A-Za-z0-9][A-Za-z0-9_-]*)/g)) used.add(m[1]) }
  scan(card.params?.rules); scan(card.params?.blocks); scan(card.overrides); scan(card.memory); scan(params.map(p => p.exprs))
  for (const p of params) if (p.internal && !used.has(p.arg)) out.push(`${p.arg} is an internal switch that no rule, block or expression uses, so it does nothing.`)
  if (card.install && !card.source && !card.install.steps.some(s => s.run.length > 0)) out.push('"install" has no steps.')
  return out
}

// A machine and a model to try a card on when no real ones are at hand.
export function sampleContext(platform: string): CardContext {
  const base = emptyCardContext(platform)
  return {
    ...base,
    system: buildSystemContext(platform,
      { totalRAMMB: 65536, freeRAMMB: 40000 } as any,
      { totalVRAMMB: 24576, freeVRAMMB: 20000, hasNvidia: true, gpuName: 'Sample GPU' } as any,
      { physicalCores: 8, logicalCores: 16, modelName: 'Sample CPU' }),
    model: buildModelContext('/models/example.gguf', { fileSizeMB: 8000, architecture: 'llama', contextLength: 131072, blockCount: 32, expertCount: 0, hiddenSize: 4096, headCount: 32, kvHeads: 8, isMoe: false }),
    template: { name: 'Example', port: 8080 }
  }
}

export interface SampleCommand { name: string; line: string }

export function sampleCommands(card: EngineCard, platform: string): SampleCommand[] {
  const ctx = sampleContext(platform)
  const launcher = cardLauncherCandidates(card, platform)[0] ?? 'launcher'
  const out: SampleCommand[] = []
  const one = (name: string, args: Record<string, unknown>) => {
    const built = buildCardArgv(card, { modelPath: '/models/example.gguf', port: 8080, engineDir: '/engines/' + card.engine.folder, args, context: { ...ctx, args } })
    const quote = (a: string) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)
    out.push({ name, line: 'error' in built ? `(not buildable: ${built.error})` : [launcher, ...built.argv].map(quote).join(' ') })
  }
  one('defaults', {})
  for (const p of card.params?.presets ?? []) one(`preset "${p.name}"`, applyPreset(card, p, {}, ctx))
  return out
}

export function launcherLines(card: EngineCard): string[] {
  return (['windows', 'macos', 'linux'] as const).map(p => {
    const os = p === 'windows' ? 'win32' : p === 'macos' ? 'darwin' : 'linux'
    const list = cardLauncherCandidates(card, os)
    return `${p}: ${list.length > 0 ? list.join(' | ') : '(none)'}`
  })
}

// The text of the .errors.txt report next to a card. `v.warnings` should
// already hold the lints (see cardWarnings).
export function formatCardReport(v: Pick<CardValidation, 'card' | 'errors' | 'warnings'>, platform: string): string {
  const parts: string[] = []
  if (v.errors.length > 0) parts.push(`Errors (the card is not loaded until these are fixed):\n${v.errors.map(e => `- ${e}`).join('\n')}`)
  const warnings = v.warnings
  if (warnings.length > 0) parts.push(`Warnings:\n${warnings.map(w => `- ${w}`).join('\n')}`)
  if (v.card) {
    parts.push(`Launcher candidates (first that exists is used):\n${launcherLines(v.card).map(l => `- ${l}`).join('\n')}`)
    parts.push(`Command lines for a sample model (/models/example.gguf, port 8080, 24 GB GPU):\n${sampleCommands(v.card, platform).map(s => `- ${s.name}: ${s.line}`).join('\n')}`)
  }
  return `${parts.join('\n\n')}\n`
}

export function cardWarnings(v: CardValidation): string[] {
  return [...v.warnings, ...lintCard(v)]
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// Whether a flag appears in a help text as a word of its own.
export function helpMentions(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,|=\\[<(])${escapeRe(flag)}(?=[\\s,|=\\]>)<:]|$)`, 'm').test(help)
}

// The parameters whose flag (or short flag, alias or off flag) the help text never mentions.
export function missingFromHelp(params: CommandParam[], help: string): string[] {
  return params
    .filter(p => ![p.arg, p.short, ...(p.aliases ?? []), p.offArg].filter((x): x is string => !!x).some(f => helpMentions(help, f)))
    .map(p => p.arg)
}

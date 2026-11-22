// check-card: the standalone checker an agent runs while it writes an engine
// card for XLM Studio. It is the same validation XLM Studio applies when the
// card file appears, plus the lints, the resolved launcher and the command lines
// the card produces, so a card can be tried without the app. Bundled into one
// dependency-free file by scripts/build-card-check.js.
//
//   node check-card.cjs <card.json> [--platform windows|macos|linux]
//        [--binary <program>] [--help-file <text file>] [--engine-dir <folder>] [--json] [--strict]

import { existsSync, readdirSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { validateEngineCard, findLauncher, cardLauncherCandidates } from '../shared/engineCard'
import { cardWarnings, launcherLines, missingFromHelp, sampleCommands } from '../shared/cardReport'
import { cardParams } from '../shared/cardRules'

const USAGE = `Usage: node check-card.cjs <card.json> [options]

Checks an XLM Studio engine card the way the app does, and prints the command
lines the card produces for a sample model.

Options
  --platform <windows|macos|linux>  Platform to resolve launchers and commands for (default: this system)
  --binary <program>                Run "<program> --help" and report card parameters the program does not mention.
                                    For a fork card use the llama-server of the fork.
  --help-file <file>                Read the help text from a file instead of running a program
  --engine-dir <folder>             Also check that a launcher of the card exists in this folder
  --json                            Print the result as JSON
  --strict                          Exit with an error code when there are warnings too
  -h, --help                        Show this text

Exit code: 0 when the card is valid, 1 when it has errors, 2 when it could not be read.`

interface Opts { file?: string; platform: string; binary?: string; helpFile?: string; engineDir?: string; json: boolean; strict: boolean }

function parseArgs(argv: string[]): Opts | null {
  const o: Opts = { platform: process.platform, json: false, strict: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => argv[++i]
    if (a === '-h' || a === '--help') return null
    else if (a === '--platform') { const p = val(); o.platform = p === 'windows' ? 'win32' : p === 'macos' ? 'darwin' : p === 'linux' ? 'linux' : p }
    else if (a === '--binary') o.binary = val()
    else if (a === '--help-file') o.helpFile = val()
    else if (a === '--engine-dir') o.engineDir = val()
    else if (a === '--json') o.json = true
    else if (a === '--strict') o.strict = true
    else if (!a.startsWith('-') && !o.file) o.file = a
    else { console.error(`Unknown option: ${a}\n`); return null }
  }
  return o.file ? o : null
}

function readHelp(o: Opts): { text: string | null; note: string } {
  if (o.helpFile) {
    try { return { text: readFileSync(o.helpFile, 'utf-8'), note: `help text from ${o.helpFile}` } } catch (e) { return { text: null, note: `cannot read ${o.helpFile}: ${(e as Error).message}` } }
  }
  if (!o.binary) return { text: null, note: '' }
  try {
    const out = execFileSync(o.binary, ['--help'], { encoding: 'utf-8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })
    return { text: out, note: `${o.binary} --help` }
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message: string }
    // Many programs print their help to stderr or exit non-zero after it.
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`
    if (text.trim()) return { text, note: `${o.binary} --help` }
    return { text: null, note: `could not run "${o.binary} --help": ${err.message}` }
  }
}

function run(argv: string[]): number {
  const o = parseArgs(argv)
  if (!o) { console.log(USAGE); return argv.includes('-h') || argv.includes('--help') ? 0 : 2 }
  let raw: unknown
  try { raw = JSON.parse(readFileSync(o.file as string, 'utf-8')) } catch (e) {
    console.error(`Cannot read ${o.file}: ${(e as Error).message}`)
    return 2
  }
  const v = validateEngineCard(raw)
  const warnings = cardWarnings(v)
  const isFork = !!v.fork
  const result: Record<string, unknown> = {
    file: o.file, kind: isFork ? 'fork' : 'engine', valid: !!(v.card || v.fork), errors: v.errors, warnings
  }
  const lines: string[] = []
  const say = (t = '') => lines.push(t)

  if (v.card) {
    result.launcher = launcherLines(v.card)
    result.samples = sampleCommands(v.card, o.platform)
    if (o.engineDir) {
      const fs = { exists: (p: string) => existsSync(p), list: (p: string) => { try { return readdirSync(p) } catch { return [] } } }
      const found = findLauncher(o.engineDir, cardLauncherCandidates(v.card, o.platform), fs)
      result.launcherInDir = found
      if (!found) warnings.push(`No launcher of this card exists in ${o.engineDir} (tried: ${cardLauncherCandidates(v.card, o.platform).join(', ')}).`)
    }
  }
  const params = v.card ? cardParams(v.card) : (v.fork?.params?.categories ?? []).flatMap(c => c.commands)
  const help = readHelp(o)
  if (help.note && help.text === null) warnings.push(`Parameter check skipped: ${help.note}.`)
  if (help.text !== null) {
    const missing = missingFromHelp(params, help.text)
    result.notInHelp = missing
    result.helpSource = help.note
    if (missing.length > 0) warnings.push(`Not found in ${help.note}: ${missing.join(', ')}. Check each against the program (a flag may be spelled differently, or only exist in another version).`)
  }
  result.warnings = warnings

  if (o.json) { console.log(JSON.stringify(result, null, 2)); return v.errors.length > 0 || (o.strict && warnings.length > 0) ? 1 : 0 }

  say(v.errors.length === 0 ? `OK: ${(v.card ?? v.fork)?.label} (${isFork ? 'fork card' : 'engine card'}, id "${(v.card ?? v.fork)?.id}")` : 'INVALID: the card is not loaded until these errors are fixed')
  if (v.errors.length > 0) { say(); say('Errors:'); v.errors.forEach(e => say(`  - ${e}`)) }
  if (warnings.length > 0) { say(); say('Warnings:'); warnings.forEach(w => say(`  - ${w}`)) }
  if (v.card) {
    say(); say('Launcher candidates (the first that exists is used):'); launcherLines(v.card).forEach(l => say(`  ${l}`))
    say(); say(`Command lines for a sample model (/models/example.gguf, port 8080, 24 GB GPU), ${o.platform}:`)
    sampleCommands(v.card, o.platform).forEach(s => say(`  ${s.name}: ${s.line}`))
  }
  if (v.fork) { say(); say(`Fork of llama.cpp: ${v.fork.source.repo}${v.fork.source.branch ? `@${v.fork.source.branch}` : ''}, ${params.length} extra parameter(s).`) }
  if (help.text !== null) { say(); say(`Checked ${params.length} parameter(s) against ${help.note}: ${(result.notInHelp as string[]).length === 0 ? 'all found.' : `${(result.notInHelp as string[]).length} not found.`}`) }
  console.log(lines.join('\n'))
  return v.errors.length > 0 || (o.strict && warnings.length > 0) ? 1 : 0
}

if (typeof require !== 'undefined' && require.main === module) process.exit(run(process.argv.slice(2)))

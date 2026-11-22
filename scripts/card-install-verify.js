// Verifies how a card's engine is made ready (clone, update, install steps) and
// how its launcher is found. Uses a throwaway local git repository, no network.
//
//   node scripts/card-install-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-install-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error', external: ['electron'] })
  return require(out)
}
const Card = bundle('src/shared/engineCard.ts', 'card')
const Inst = bundle('src/main/cardInstall.ts', 'inst')
const Grace = bundle('src/main/gracefulStop.ts', 'grace')

async function main() {
  // ----- launcher candidates -----
  const mkFs = files => ({
    exists: p => files.has(p) || [...files].some(f => f.startsWith(p + '/')),
    list: p => [...files].filter(f => f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')).map(f => f.slice(p.length + 1))
      .concat([...files].filter(f => f.startsWith(p + '/') && f.slice(p.length + 1).includes('/')).map(f => f.slice(p.length + 1).split('/')[0]))
  })
  const D = '/e/Engine'
  check('first existing launcher wins', Card.findLauncher(D, ['a.exe', 'b.exe'], mkFs(new Set([`${D}/b.exe`]))) === 'b.exe')
  check('the earlier candidate wins when both exist', Card.findLauncher(D, ['a.exe', 'b.exe'], mkFs(new Set([`${D}/a.exe`, `${D}/b.exe`]))) === 'a.exe')
  check('a glob finds whichever folder is there', Card.findLauncher(D, ['venv/*/python.exe'], mkFs(new Set([`${D}/venv/Scripts/python.exe`]))) === 'venv/Scripts/python.exe')
  check('a glob can match inside a name', Card.findLauncher(D, ['bin/server-*.exe'], mkFs(new Set([`${D}/bin/server-v2.exe`]))) === 'bin/server-v2.exe')
  check('the glob picks the highest numbered match', Card.findLauncher(D, ['v*/run.sh'], mkFs(new Set([`${D}/v2/run.sh`, `${D}/v10/run.sh`]))) === 'v10/run.sh')
  check('nothing found is null', Card.findLauncher(D, ['x.exe', 'y/*/z.exe'], mkFs(new Set())) === null)
  check('dots in a pattern are literal', Card.findLauncher(D, ['a.b*'], mkFs(new Set([`${D}/aXb1`]))) === null)

  const base = { cardVersion: 1, id: 'multi', label: 'Multi', engine: { folder: 'Multi' }, launch: { file: ['run.sh', 'bin/*/run.sh'], argv: ['{params}'] } }
  const v = Card.validateEngineCard(base)
  check('a list of launcher candidates is valid', !!v.card && v.errors.length === 0, v.errors.join('; '))
  check('candidates per platform', (() => {
    const c = Card.validateEngineCard({ ...base, launch: { file: { windows: ['a.bat'], default: ['b.sh', 'c.sh'] }, argv: ['{params}'] } }).card
    return Card.cardLauncherCandidates(c, 'win32').join() === 'a.bat' && Card.cardLauncherCandidates(c, 'linux').join() === 'b.sh,c.sh'
  })())
  check('an absolute candidate is refused', Card.validateEngineCard({ ...base, launch: { file: ['/bin/x'], argv: ['{params}'] } }).errors.length > 0)
  check('an empty list is refused', Card.validateEngineCard({ ...base, launch: { file: [], argv: ['{params}'] } }).errors.length > 0)

  // ----- source and install validation -----
  const withSrc = extra => Card.validateEngineCard({ ...base, ...extra })
  check('source and install are accepted', withSrc({ source: { repo: 'owner/repo', branch: 'main' }, install: { steps: [{ run: ['python', '-m', 'venv', '.venv'] }, { run: ['pip', 'install', '-e', '.'], platform: ['linux', 'macos'] }] } }).errors.length === 0)
  check('source must be owner/repo', withSrc({ source: { repo: 'nonsense' } }).errors.some(e => /owner\/repo/.test(e)))
  check('a step is a list of strings', withSrc({ install: { steps: [{ run: 'pip install' }] } }).errors.some(e => /run/.test(e)))
  check('a step platform must be known', withSrc({ install: { steps: [{ run: ['x'], platform: ['beos'] }] } }).errors.some(e => /platform/.test(e)))
  check('an unknown step placeholder is refused', withSrc({ install: { steps: [{ run: ['x', '{nope}'] }] } }).errors.some(e => /nope/.test(e)))
  check('{engineDir} is accepted in a step', withSrc({ install: { steps: [{ run: ['x', '{engineDir}/y'] }] } }).errors.length === 0)
  check('a card with a source reports it as a git install', Card.cardToEngineDef(withSrc({ source: { repo: 'o/r' } }).card).install === 'git')

  // ----- install from a local repository -----
  let haveGit = true
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }) } catch { haveGit = false }
  if (!haveGit) { check('git is available for the install test', false, 'git not found'); return }

  const repo = path.join(tmp, 'origin')
  const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'], repo)
  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho hello\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'one'], repo)

  const lines = []
  const hooks = { log: l => lines.push(l), killTree: async p => { try { p.kill('SIGKILL') } catch {} }, signal: new AbortController().signal }
  const node = process.execPath
  const card = Card.validateEngineCard({
    ...base, id: 'inst', engine: { folder: 'Inst' }, source: { repo: 'owner/engine', branch: 'main' },
    install: { steps: [
      { run: [node, '-e', "require('fs').writeFileSync('built.txt', 'ok')"] },
      { run: [node, '-e', "require('fs').writeFileSync('onlywin.txt', 'x')"], platform: ['windows'] },
      { run: [node, '-e', "require('fs').writeFileSync(process.argv[1] + '/dir.txt', 'x')", '{engineDir}'] }
    ] }
  }).card
  const rootDir = path.join(tmp, 'engines')
  let r = await Inst.installCardEngine(card, rootDir, hooks, { cloneUrl: repo, platform: 'linux' })
  const dest = path.join(rootDir, 'Inst', 'engine')
  check('the repository is cloned into <engines>/<folder>/<repo>', r.ok && fs.existsSync(path.join(dest, 'run.sh')), r.error)
  check('install steps run inside the clone', fs.existsSync(path.join(dest, 'built.txt')))
  check('a step for another platform is skipped', !fs.existsSync(path.join(dest, 'onlywin.txt')))
  check('{engineDir} is replaced in a step', fs.existsSync(path.join(dest, 'dir.txt')))
  check('output reaches the log', lines.some(l => /Cloning owner\/engine/.test(l)) && lines.some(l => /is ready/.test(l)))

  fs.writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\necho two\n')
  git(['commit', '-qam', 'two'], repo)
  r = await Inst.installCardEngine(card, rootDir, hooks, { cloneUrl: repo, platform: 'linux' })
  check('a second run updates the clone', r.ok && /two/.test(fs.readFileSync(path.join(dest, 'run.sh'), 'utf-8')), r.error)

  const failing = Card.validateEngineCard({ ...base, id: 'bad', engine: { folder: 'Bad' }, install: { steps: [{ run: [node, '-e', 'process.exit(3)'] }, { run: [node, '-e', "require('fs').writeFileSync('after.txt','x')"] }] } }).card
  r = await Inst.installCardEngine(failing, rootDir, hooks, { platform: 'linux' })
  check('a failing step stops the install and names the step', !r.ok && /Step 1/.test(r.error) && !fs.existsSync(path.join(rootDir, 'Bad', 'local', 'after.txt')), r.error)

  const missing = Card.validateEngineCard({ ...base, id: 'nogit', engine: { folder: 'NoSuch' }, install: { steps: [{ run: ['definitely-not-a-program-xyz'] }] } }).card
  r = await Inst.installCardEngine(missing, rootDir, hooks, { platform: 'linux' })
  check('a missing program is reported, not thrown', !r.ok && /not found/i.test(r.error), r.error)

  const ac = new AbortController()
  const slow = Card.validateEngineCard({ ...base, id: 'slow', engine: { folder: 'Slow' }, install: { steps: [{ run: [node, '-e', 'setTimeout(()=>{}, 30000)'] }] } }).card
  const p = Inst.installCardEngine(slow, rootDir, { ...hooks, signal: ac.signal }, { platform: 'linux' })
  setTimeout(() => ac.abort(), 400)
  r = await p
  check('a cancel stops a running step', !r.ok && /Cancelled/.test(r.error), r.error)

  r = await Inst.installCardEngine(Card.validateEngineCard(base).card, rootDir, hooks, {})
  check('a card with nothing to install says so', !r.ok && /no source/.test(r.error))

  // ----- graceful stop helper -----
  const script = Grace.windowsCtrlCScript(4242)
  check('the Windows helper targets the process and raises CTRL_C', /AttachConsole\(4242\)/.test(script) && /GenerateConsoleCtrlEvent\(0, 0\)/.test(script) && /SetConsoleCtrlHandler/.test(script))
  check('the Windows helper only takes a whole number', /AttachConsole\(7\)/.test(Grace.windowsCtrlCScript(7.9)))
}

main().then(() => {
  console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`)
  process.exit(failed === 0 ? 0 : 1)
}).catch(e => { console.error(e); process.exit(1) })

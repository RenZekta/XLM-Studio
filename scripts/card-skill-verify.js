// Verifies the engine card skill: what is written, that the checker in the
// repository is current and works, and that the examples are valid.
//
//   node scripts/card-skill-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-skill-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error', external: ['electron'] })
  return require(out)
}
const Skill = bundle('src/main/cardSkill.ts', 'skill')
const Card = bundle('src/shared/engineCard.ts', 'card')
const Report = bundle('src/shared/cardReport.ts', 'report')

const skillSrc = path.join(root, 'docs', 'engine-card-skill')
const guide = path.join(root, 'docs', 'engine-cards.md')
const node = process.execPath
const checker = (args, cwd) => spawnSync(node, [path.join(skillSrc, 'check-card.cjs'), ...args], { encoding: 'utf-8', cwd })

// ----- repository files -----
const drift = spawnSync(node, [path.join(root, 'scripts', 'build-card-check.js'), '--check'], { encoding: 'utf-8' })
check('the committed checker is up to date with src/tools/checkCard.ts', drift.status === 0, drift.stderr)
for (const f of ['example-engine.json', 'example-fork.json']) {
  const v = Card.validateEngineCard(JSON.parse(fs.readFileSync(path.join(skillSrc, 'examples', f), 'utf-8')))
  check(`${f} is valid and clean`, (v.card || v.fork) && v.errors.length === 0 && Report.cardWarnings(v).length === 0, [...v.errors, ...Report.cardWarnings(v)].join('; '))
}
const skillMd = fs.readFileSync(path.join(skillSrc, 'SKILL.md'), 'utf-8')
check('SKILL.md has the name and a description in its front matter', /^---\nname: xlm-studio-engine-card\ndescription: .{60,}\n---/.test(skillMd))
check('SKILL.md points at both repositories', /RenZekta\/XLM-Studio/.test(skillMd) && /engine-cards\.md/.test(skillMd) && /check-card\.cjs/.test(skillMd))
const guideText = fs.readFileSync(guide, 'utf-8')
check('the guide documents what the validator knows', ['widget', 'rules', 'blocks', 'presets', 'overrides', 'checkpoints', 'memory', 'install', 'check-card'].every(w => guideText.includes(w)))

// ----- the generated skill -----
const home = path.join(tmp, 'home')
const machine = { cardsDir: '/data/engine-cards', enginesDir: '/data/engines', platform: 'linux' }
let r = Skill.writeCardSkill({ skillSourceDir: skillSrc, guidePath: guide }, machine, home)
const dir = Skill.cardSkillDir(home)
check('writes the skill under ~/.agents/skills/xlm-studio-engine-card', r.success && dir.endsWith(path.join('.agents', 'skills', 'xlm-studio-engine-card')), r.error)
check('writes SKILL.md, guide.md, the checker and the examples', ['SKILL.md', 'guide.md', 'check-card.cjs', 'examples/example-engine.json', 'examples/example-fork.json'].every(f => fs.existsSync(path.join(dir, f))))
const written = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8')
check('keeps the front matter first', written.startsWith('---\nname: xlm-studio-engine-card\n'))
check('names this machine\'s cards and engines folders', written.includes('/data/engine-cards') && written.includes('/data/engines'))
check('gives the checker command with its real path', written.includes(path.join(dir, 'check-card.cjs')))
check('keeps the instructions of the repository', written.includes('## Steps') && written.includes('Report back'))
check('is detected as installed', Skill.cardSkillInstalled(home) === true)
check('the guide is the repository guide', fs.readFileSync(path.join(dir, 'guide.md'), 'utf-8') === guideText)

fs.writeFileSync(path.join(dir, 'stale.txt'), 'x')
r = Skill.writeCardSkill({ skillSourceDir: skillSrc, guidePath: guide }, machine, home)
check('adding again rewrites the folder cleanly', r.success && !fs.existsSync(path.join(dir, 'stale.txt')))
r = Skill.writeCardSkill({ skillSourceDir: path.join(tmp, 'nowhere'), guidePath: guide }, machine, home)
check('missing source files are reported, not thrown', !r.success && /not found/.test(r.error))
Skill.removeCardSkill(home)
check('removing deletes the folder', !fs.existsSync(dir) && Skill.cardSkillInstalled(home) === false)
Skill.removeCardSkill(home)
check('removing twice is harmless', true)
check('front matter is added when the source has none', Skill.buildCardSkillMd('# Title\n', machine, '/s').startsWith('## This machine'))
check('a Windows machine is named as such', /Windows/.test(Skill.buildCardSkillMd(skillMd, { ...machine, platform: 'win32' }, 'C:\\skill')))

// ----- the checker as an agent runs it -----
const good = path.join(skillSrc, 'examples', 'example-engine.json')
let c = checker([good])
check('checker: a good card exits 0 and shows launchers and command lines', c.status === 0 && /Launcher candidates/.test(c.stdout) && /preset "Fast"/.test(c.stdout), c.stdout + c.stderr)
c = checker([good, '--json'])
let j; try { j = JSON.parse(c.stdout) } catch { j = null }
check('checker: --json is machine readable', !!j && j.valid === true && Array.isArray(j.samples) && j.samples.length === 3)
const badFile = path.join(tmp, 'bad.json')
fs.writeFileSync(badFile, JSON.stringify({ cardVersion: 1, id: 'Bad Id', label: 'x', engine: { folder: 'X' }, launch: { file: 'a.sh', argv: ['{params}'] } }))
c = checker([badFile])
check('checker: an invalid card exits 1 and lists the error', c.status === 1 && /INVALID/.test(c.stdout) && /id/.test(c.stdout), c.stdout)
fs.writeFileSync(badFile, '{ not json')
c = checker([badFile])
check('checker: unreadable JSON exits 2', c.status === 2 && /Cannot read/.test(c.stderr), c.stderr)
c = checker([])
check('checker: no arguments prints usage', c.status === 2 && /Usage/.test(c.stdout))
c = checker(['--help'])
check('checker: --help exits 0', c.status === 0 && /Usage/.test(c.stdout))
const warnFile = path.join(tmp, 'warn.json')
fs.writeFileSync(warnFile, JSON.stringify({ cardVersion: 1, id: 'warny', label: 'W', engine: { folder: 'W' }, launch: { file: 'start.bat', argv: ['--model', '{model}', '{params}'] }, params: { categories: [{ name: 'A', commands: [{ arg: '--x', label: 'X', type: 'boolean' }] }] } }))
c = checker([warnFile])
check('checker: lints a card that loads but cannot work', c.status === 0 && /never pass \{port\}/.test(c.stdout) && /only exists on Windows/.test(c.stdout) && /no description/.test(c.stdout), c.stdout)
c = checker([warnFile, '--strict'])
check('checker: --strict fails on warnings', c.status === 1)
const helpFile = path.join(tmp, 'help.txt')
fs.writeFileSync(helpFile, 'usage: engine\n  --x   do x\n')
c = checker([warnFile, '--help-file', helpFile])
check('checker: a flag found in the help text is not reported', !/Not found in/.test(c.stdout), c.stdout)
fs.writeFileSync(helpFile, 'usage: engine\n  --y   do y\n')
c = checker([warnFile, '--help-file', helpFile])
check('checker: a flag missing from the help text is reported', /Not found in .*--x/.test(c.stdout), c.stdout)
const fakeBin = path.join(tmp, 'fake-engine.js')
fs.writeFileSync(fakeBin, `#!${node}\nconsole.error('options:\\n  --x  thing')\nprocess.exit(1)\n`, { mode: 0o755 })
c = checker([warnFile, '--binary', fakeBin])
check('checker: --binary reads help from stderr even when the program exits non-zero', /Checked 1 parameter\(s\) against .*all found/.test(c.stdout), c.stdout)
c = checker([warnFile, '--binary', path.join(tmp, 'no-such-binary')])
check('checker: a program that cannot run is a warning, not a crash', c.status === 0 && /skipped/.test(c.stdout), c.stdout)
check('the standalone checker has no dependencies', !/require\("(?!fs|child_process|path|os)/.test(fs.readFileSync(path.join(skillSrc, 'check-card.cjs'), 'utf-8').replace(/require\("(fs|child_process|path|os)"\)/g, '')))

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)

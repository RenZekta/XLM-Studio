// Verifies the engine card format: validation, argument building, the engine
// registry and the card loader.
//
//   node scripts/engine-card-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-verify-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error', external: ['electron'] })
  return require(out)
}
const C = bundle('src/shared/engineCard.ts', 'card')
const E = bundle('src/shared/engines.ts', 'engines')
const L = bundle('src/main/engineCards.ts', 'loader')
const TM = bundle('src/shared/trackedMerge.ts', 'merge')

const base = () => ({
  cardVersion: 1, id: 'my-engine', label: 'My Engine', engine: { folder: 'MyEngine' },
  launch: {
    file: { windows: 'start.bat', default: 'start.sh' },
    argv: ['--model', '{model}', '--port', '{port}', ['--host', '{host}'], ['--api-key', '{apiKey}'], '{params}']
  },
  params: { categories: [{ name: 'Generation', commands: [
    { arg: '--context', label: 'Context', description: 'Tokens kept in context.', type: 'number', min: 256, max: 4096 },
    { arg: '--fa', label: 'Flash attention', description: 'Faster attention.', type: 'boolean', offArg: '--no-fa' },
    { arg: '--warm', label: 'Warm up', description: 'Warm up at start.', type: 'boolean' },
    { arg: '--kv', label: 'KV', description: 'Cache type.', type: 'select', options: ['f16', 'q8_0'], format: 'equals' }
  ] }] }
})
const errorsOf = mutate => { const c = base(); mutate(c); return C.validateEngineCard(c).errors }
const forkBase = () => ({ cardVersion: 1, id: 'my-fork', label: 'My Fork', extends: 'llama.cpp', source: { repo: 'someone/llama.cpp', branch: 'main' },
  params: { categories: [{ name: 'Fork', commands: [{ arg: '--fork-flag', label: 'Fork flag', type: 'boolean' }] }] } })

// ----- validation -----
const ok = C.validateEngineCard(base())
check('a complete card is valid', ok.card && ok.errors.length === 0, ok.errors.join('; '))
const noDesc = base(); delete noDesc.params.categories[0].commands[0].description
check('a missing field description is filled in', C.validateEngineCard(noDesc).card.params.categories[0].commands[0].description === '')
check('not an object', C.validateEngineCard([]).card === null)
check('cardVersion from a newer app is refused', errorsOf(c => { c.cardVersion = 2 }).some(e => /newer/.test(e)))
check('built-in id is refused', errorsOf(c => { c.id = 'strata' }).some(e => /built-in/.test(e)))
check('bad id characters are refused', errorsOf(c => { c.id = 'My Engine' }).length > 0)
check('absolute launcher is refused', errorsOf(c => { c.launch.file = 'C:\\x\\start.bat' }).length > 0)
check('launcher outside the folder is refused', errorsOf(c => { c.launch.file = '../start.bat' }).length > 0)
check('unknown placeholder is refused', errorsOf(c => { c.launch.argv.push('{nope}') }).some(e => /nope/.test(e)))
check('{params} inside a larger argument is refused', errorsOf(c => { c.launch.argv.push('x{params}') }).length > 0)
check('bad ready regex is refused', errorsOf(c => { c.launch.ready = { log: '(' } }).length > 0)
check('ready path must start with /', errorsOf(c => { c.launch.ready = { http: 'health' } }).length > 0)
check('json metrics are not offered', errorsOf(c => { c.launch.metrics = { format: 'json' } }).length > 0)
check('duplicate parameter is refused', errorsOf(c => { c.params.categories[0].commands.push({ arg: '--fa', label: 'x', type: 'boolean' }) }).some(e => /twice/.test(e)))
check('reserved __ parameter is refused', errorsOf(c => { c.params.categories[0].commands.push({ arg: '__x', label: 'x', type: 'string' }) }).length > 0)
check('select needs options', errorsOf(c => { c.params.categories[0].commands.push({ arg: '--s', label: 's', type: 'select' }) }).length > 0)
check('offArg is for booleans only', errorsOf(c => { c.params.categories[0].commands[0].offArg = '--x' }).length > 0)
check('reserved folder is refused', errorsOf(c => { c.engine.folder = 'Strata-data' }).length > 0)
check('folder with a path separator is refused', errorsOf(c => { c.engine.folder = 'a/b' }).length > 0)
const warned = (() => { const c = base(); c.extra = 1; return C.validateEngineCard(c) })()
check('an unknown key warns but loads', warned.card && warned.warnings.length === 1)

// ----- launcher file -----
const card = ok.card
check('windows launcher', C.cardLauncherFile(card, 'win32') === 'start.bat')
check('linux falls back to default', C.cardLauncherFile(card, 'linux') === 'start.sh')
check('a string launcher serves every platform', C.cardLauncherFile({ launch: { file: 'run' } }, 'darwin') === 'run')

// ----- arguments -----
const input = { modelPath: 'D:\\m\\a.gguf', port: 8081, engineDir: 'E', args: {} }
let built = C.buildCardArgv(card, input)
check('unset host and key groups are left out', JSON.stringify(built.argv) === JSON.stringify(['--model', 'D:\\m\\a.gguf', '--port', '8081']), JSON.stringify(built))
built = C.buildCardArgv(card, { ...input, host: '0.0.0.0', apiKey: 'k' })
check('set host and key groups are kept', built.argv.join(' ') === '--model D:\\m\\a.gguf --port 8081 --host 0.0.0.0 --api-key k')
built = C.buildCardArgv(card, { ...input, args: { '--host': '127.0.0.1', '--context': 4096, '--fa': false, '--warm': true, '--kv': 'q8_0' } })
check('Template host feeds {host}', built.argv.includes('127.0.0.1'))
check('params expand in card order with offArg, bare flags and =', built.argv.slice(-5).join(' ') === '--context 4096 --no-fa --warm --kv=q8_0', built.argv.join(' '))
built = C.buildCardArgv(card, { ...input, args: { '--warm': false, '--context': '' } })
check('false without offArg and empty values send nothing', !built.argv.includes('--warm') && !built.argv.includes('--context'))
check('a missing model is reported', 'error' in C.buildCardArgv(card, { ...input, modelPath: '' }))
const noModel = { ...card, launch: { ...card.launch, argv: ['--port', '{port}'] } }
check('a card that never uses the model does not need one', !('error' in C.buildCardArgv(noModel, { ...input, modelPath: '' })))
check('env placeholders fill', C.cardEnv({ launch: { env: { A: '{modelDir}|{port}' } } }, input).A === 'D:\\m|8081')

// ----- registry -----
E.registerCardEngines([C.cardToEngineDef(card)])
check('a card engine is registered', E.isEngineId('my-engine') && E.ENGINE_IDS.includes('my-engine'))
check('a card engine is generic and local', E.ENGINES['my-engine'].kind === 'generic' && E.ENGINES['my-engine'].install === 'local')
check('built-ins stay', E.ENGINE_IDS[0] === 'llama.cpp' && E.ENGINE_IDS[1] === 'strata')
check('an unknown id is kept, not turned into llama.cpp', E.engineOf({ engine: 'gone' }) === 'gone')
check('an unknown id reads as missing', E.engineDef('gone').missing === true)
check('no engine means llama.cpp', E.engineOf({}) === 'llama.cpp')
check('generic engines accept any model', E.engineAcceptsModel('my-engine', null))
E.registerCardEngines([])
check('registering again removes old card engines', !E.isEngineId('my-engine') && E.ENGINE_IDS.length === 2)
E.registerCardEngines([C.cardToEngineDef({ ...card, id: 'llama.cpp' })])
check('a card cannot take a built-in id', E.ENGINE_IDS.length === 2)

// ----- fork cards -----
const fErr = m => { const c = forkBase(); m(c); return C.validateEngineCard(c).errors }
const fv = C.validateEngineCard(forkBase())
check('a fork card is valid and is not an engine card', fv.fork && !fv.card && fv.errors.length === 0, fv.errors.join('; '))
check('fork: only llama.cpp can be extended', fErr(c => { c.extends = 'vllm' }).length > 0)
check('fork: source is required', fErr(c => { delete c.source }).length > 0)
check('fork: repo must be owner/repo', fErr(c => { c.source.repo = 'nope' }).length > 0)
check('fork: a branch cannot hold spaces', fErr(c => { c.source.branch = 'a b' }).length > 0)
check('fork: launch is refused', fErr(c => { c.launch = {} }).some(e => /launch/.test(e)))
check('fork: engine is refused', fErr(c => { c.engine = { folder: 'x' } }).some(e => /engine/.test(e)))
check('fork: parameters are checked like an engine card', fErr(c => { c.params.categories[0].commands.push({ arg: '--fork-flag', label: 'x', type: 'boolean' }) }).some(e => /twice/.test(e)))
check('fork: a built-in id is refused', fErr(c => { c.id = 'strata' }).length > 0)
check('fork: defaultOptions must be lists of strings', fErr(c => { c.defaultOptions = { '--x': 'q4' } }).length > 0)
check('fork: params and defaultOptions are optional', C.validateEngineCard({ cardVersion: 1, id: 'f', label: 'F', extends: 'llama.cpp', source: { repo: 'a/b' } }).errors.length === 0)

const folderFor = (repo, taken, branch) => { let n = repo.split('/')[1] + (branch ? '@' + branch : ''); while (taken.has(n.toLowerCase())) n += '_'; return n }
const f1 = fv.fork
let m = TM.mergeCardForks([], [f1], folderFor)
check('merge: a fork card adds a tracker entry', m.length === 1 && m[0].id === 'card-my-fork' && m[0].fromCard === 'my-fork' && m[0].repo === 'someone/llama.cpp' && m[0].branch === 'main' && m[0].isDefault === false && m[0].extraCommands[0].name === 'Fork', JSON.stringify(m))
check('merge: the folder comes from the repo and branch', m[0].folderName === 'llama.cpp@main', m[0].folderName)
check('merge: running it again changes nothing', JSON.stringify(TM.mergeCardForks(m, [f1], folderFor)) === JSON.stringify(m))
const user = { id: 'user-1', repo: 'Someone/Llama.cpp', branch: 'main', name: 'mine', folderName: 'my-folder', isDefault: false }
m = TM.mergeCardForks([user], [f1], folderFor)
check('merge: a hand-made entry for the same repo and branch is taken over in place', m.length === 1 && m[0].id === 'user-1' && m[0].folderName === 'my-folder' && m[0].fromCard === 'my-fork')
check('merge: an entry follows its card away', TM.mergeCardForks([{ ...user, fromCard: 'my-fork' }], [], folderFor).length === 0)
m = TM.mergeCardForks(TM.mergeCardForks([], [f1], folderFor), [{ ...f1, label: 'Renamed', source: { repo: f1.source.repo }, params: undefined }], folderFor)
check('merge: a changed card updates the entry (name, no branch, no parameters)', m.length === 1 && m[0].name === 'Renamed' && m[0].branch === undefined && m[0].extraCommands === undefined && m[0].id === 'card-my-fork', JSON.stringify(m))
const builtIn = { id: 'llama-cpp', repo: 'ggml-org/llama.cpp', name: 'llama.cpp', folderName: 'llama.cpp', isDefault: true }
m = TM.mergeCardForks([builtIn], [{ ...f1, source: { repo: 'ggml-org/llama.cpp' } }], folderFor)
check('merge: a card for a built-in entry is left out', m.length === 1 && m[0].id === 'llama-cpp')
m = TM.mergeCardForks([{ id: 'x', repo: 'a/b', name: 'b', folderName: 'llama.cpp@main', isDefault: false }], [f1], folderFor)
check('merge: a new entry gets a free folder name', m.length === 2 && m[1].folderName === 'llama.cpp@main_', m.map(t => t.folderName).join())

// ----- loader -----
const builtinDir = path.join(tmp, 'builtin')
const customDir = path.join(tmp, 'custom')
const engines = path.join(tmp, 'engines')
fs.mkdirSync(builtinDir, { recursive: true })
fs.mkdirSync(path.join(engines, 'MyEngine', 'v1'), { recursive: true })
fs.mkdirSync(path.join(engines, 'MyEngine', 'v2'), { recursive: true })
const launcher = process.platform === 'win32' ? 'start.bat' : 'start.sh'
fs.writeFileSync(path.join(engines, 'MyEngine', 'v1', launcher), '')
fs.writeFileSync(path.join(engines, 'MyEngine', 'v2', launcher), '')
fs.mkdirSync(customDir, { recursive: true })
fs.writeFileSync(path.join(customDir, 'my-engine.json'), JSON.stringify(base()))
fs.writeFileSync(path.join(customDir, 'broken.json'), JSON.stringify({ cardVersion: 1, id: 'broken' }))
fs.writeFileSync(path.join(customDir, 'syntax.json'), '{ nope')
fs.writeFileSync(path.join(builtinDir, 'shipped.json'), JSON.stringify({ ...base(), id: 'shipped', label: 'Shipped', engine: { folder: 'Shipped' } }))
fs.writeFileSync(path.join(customDir, 'shipped.json'), JSON.stringify({ ...base(), id: 'shipped', label: 'Mine', engine: { folder: 'Shipped' } }))
fs.writeFileSync(path.join(customDir, 'my-fork.json'), JSON.stringify({ ...forkBase(), params: { categories: [{ name: 'Fork', commands: [{ arg: '--fork-flag', label: 'Fork flag', type: 'boolean' }, { arg: '--ctx-size', label: 'Context', type: 'number' }] }] } }))
fs.writeFileSync(path.join(customDir, 'bad-fork.json'), JSON.stringify({ ...forkBase(), id: 'bad-fork', launch: {} }))
L.initEngineCards(builtinDir, customDir, () => {}, () => ['--ctx-size', '--parallel'])
const list = L.listLoadedCards()
check('valid custom card loads', L.engineCardOf('my-engine')?.label === 'My Engine')
check('invalid card does not load', !L.engineCardOf('broken') && list.find(c => c.id === 'broken').errors.length > 0)
check('invalid JSON is reported', list.find(c => c.file.endsWith('syntax.json')).errors[0].startsWith('Not valid JSON'))
check('errors file is written beside the card', fs.existsSync(path.join(customDir, 'broken.errors.txt')))
check('a valid card has no errors file', !fs.existsSync(path.join(customDir, 'my-engine.errors.txt')))
{
  // A card that loads but has something to say gets the resolved launcher and sample command lines in its report.
  const lintCard = { ...base(), id: 'lint-card', label: 'Lint', engine: { folder: 'Lint' }, launch: { file: 'run.bat', argv: ['--model', '{model}', '{params}'] } }
  fs.writeFileSync(path.join(customDir, 'lint-card.json'), JSON.stringify(lintCard))
  L.refreshEngineCards()
  const rep = fs.existsSync(path.join(customDir, 'lint-card.errors.txt')) ? fs.readFileSync(path.join(customDir, 'lint-card.errors.txt'), 'utf-8') : ''
  check('the report of a loadable card names lints, launchers and a sample command line', /never pass \{port\}/.test(rep) && /Launcher candidates/.test(rep) && /--model \/models\/example\.gguf/.test(rep), rep)
  fs.unlinkSync(path.join(customDir, 'lint-card.json'))
  L.refreshEngineCards()
}
check('a custom card replaces the built-in one', L.engineCardOf('shipped').label === 'Mine' && list.some(c => c.replaces))
fs.writeFileSync(path.join(customDir, 'broken.json'), JSON.stringify({ ...base(), id: 'broken', label: 'Fixed', engine: { folder: 'Broken' } }))
L.refreshEngineCards()
check('fixing a card removes its errors file and loads it', !fs.existsSync(path.join(customDir, 'broken.errors.txt')) && L.engineCardOf('broken')?.label === 'Fixed')
check('folder lookup is case-insensitive', L.cardForFolder('myengine')?.id === 'my-engine')
const found = L.scanCardEngine(L.engineCardOf('my-engine'), path.join(engines, 'MyEngine'), 'MyEngine', engines, 0, false)
check('each version folder with the launcher is one install, newest first', found.map(b => b.name).join() === 'v2,v1', found.map(b => b.name).join())
check('installs carry the card engine id', found.every(b => b.engine === 'my-engine' && b.exe === launcher))
fs.mkdirSync(path.join(engines, 'Flat'), { recursive: true })
fs.writeFileSync(path.join(engines, 'Flat', launcher), '')
const flat = L.scanCardEngine(L.engineCardOf('my-engine'), path.join(engines, 'Flat'), 'Flat', engines, 0, false)
check('a launcher directly in the folder is one local install', flat.length === 1 && flat[0].name === 'local' && flat[0].path === path.join(engines, 'Flat'))
const spawnSpec = L.buildCardSpawn(path.join(engines, 'a', 'run.sh'), ['--x'], { K: 'v' })
check('.sh launchers run through bash', process.platform === 'win32' || (spawnSpec.command === 'bash' && spawnSpec.args[1] === '--x' && spawnSpec.options.env.K === 'v'))
check('a direct launcher runs as itself', L.buildCardSpawn('/x/engine', ['-a'], {}).command === '/x/engine')

const forkInfo = L.listLoadedCards().find(c => c.id === 'my-fork')
check('fork loader: it is listed as a fork and is not an engine', forkInfo?.kind === 'fork' && !L.engineCardOf('my-fork'))
check('fork loader: it is active for the tracker', L.activeForkCards().some(f => f.id === 'my-fork'))
check('fork loader: a copy of a built-in parameter is warned about', forkInfo.warnings.some(w => /--ctx-size/.test(w)) && !forkInfo.warnings.some(w => /--fork-flag/.test(w)), JSON.stringify(forkInfo.warnings))
check('fork loader: the warning is written beside the card', /Warnings:/.test(fs.readFileSync(path.join(customDir, 'my-fork.errors.txt'), 'utf8')))
check('fork loader: a refused fork card is not active', !L.activeForkCards().some(f => f.id === 'bad-fork') && L.listLoadedCards().find(c => c.id === 'bad-fork').errors.length > 0)
check('fork loader: a refused fork card gets an errors file', /Errors/.test(fs.readFileSync(path.join(customDir, 'bad-fork.errors.txt'), 'utf8')))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

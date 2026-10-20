// Verifies the server parameters (port, host, API key): how a pasted command
// is split, which of them a global Base URL Override takes over, and that the
// Strata launch keeps the Template's own host and key.
//
//   node scripts/server-params-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-params-verify-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
  return require(out)
}
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}

const I = bundle('src/shared/importCommand.ts', 'import')
const P = bundle('src/renderer/src/utils/templatePort.ts', 'port')
const S = bundle('src/shared/strata.ts', 'strata')

// -- pasted command -------------------------------------------------------------
const a = I.parseServerCommand('llama-server -m "C:\\m x\\a.gguf" --port 9001 --host 0.0.0.0 --api-key sk-abc --ctx-size 4096 --jinja')
check('model, port and flags are split', a.modelPath === 'C:\\m x\\a.gguf' && a.serverPort === 9001 && a.args['--ctx-size'] === 4096 && a.args['--jinja'] === true, JSON.stringify(a))
check('host and API key stay in args, the port does not', a.args['--host'] === '0.0.0.0' && a.args['--api-key'] === 'sk-abc' && !('--port' in a.args))
const b = I.parseServerCommand('llama-server -m a.gguf --port=8123 --host=192.168.1.5 --api-key=12345')
check('--flag=value spelling is read', b.serverPort === 8123 && b.args['--host'] === '192.168.1.5' && b.args['--api-key'] === '12345', JSON.stringify(b))
check('a digits-only API key stays a string', typeof b.args['--api-key'] === 'string')
check('no --port leaves the Template port alone', I.parseServerCommand('llama-server -m a.gguf').serverPort === null)
check('an invalid port is ignored', I.parseServerCommand('llama-server --port 99999').serverPort === null && I.parseServerCommand('llama-server --port abc').serverPort === null)
check('normalizing keeps host and key', (() => {
  const n = I.normalizeImportedArgs(a.args, null)
  return n['--host'] === '0.0.0.0' && n['--api-key'] === 'sk-abc'
})())

// -- Strata launch command -------------------------------------------------------
const st = I.parseStrataCommand('START-HERE.bat --yes --no-browser --family qwen --model IQ3_S --gguf-dir "D:\\my models\\qwen" --port 9100 --host 0.0.0.0 --api-key 12345 --context 65536 --parallel 2 --vision yes --future-flag')
check('Strata: the launcher is skipped, port and folder are split off', st.serverPort === 9100 && st.ggufDir === 'D:\\my models\\qwen' && !('--port' in st.args) && !('--gguf-dir' in st.args), JSON.stringify(st))
check('Strata: --model and --family stay as the variant and family', st.args['--family'] === 'qwen' && st.args['--model'] === 'IQ3_S')
check('Strata: host and key stay in args, the key as text', st.args['--host'] === '0.0.0.0' && st.args['--api-key'] === '12345')
check('Strata: the other flags are typed', st.args['--context'] === 65536 && st.args['--parallel'] === 2 && st.args['--vision'] === 'yes' && st.args['--future-flag'] === true)
check('Strata: the flags the launch adds itself are reported, not kept', st.ignored.join() === '--yes,--no-browser' && !('--yes' in st.args) && !('--no-browser' in st.args))
const st2 = I.parseStrataCommand('python setup.py --data-dir D:\\data --port=7000 --model=Gyro-S --family=gyro')
check('Strata: python setup.py, = spelling and a managed value are read', st2.serverPort === 7000 && st2.args['--model'] === 'Gyro-S' && st2.args['--family'] === 'gyro' && st2.ignored[0] === '--data-dir' && !('--data-dir' in st2.args) && !Object.values(st2.args).includes('D:\\data'), JSON.stringify(st2))
const st3 = I.parseStrataCommand('./setup.sh \\\n  --family glm \\\n  --model Maya-S \\\n  --gguf-dir /models/glm\n')
check('Strata: bash line continuations are joined', st3.args['--family'] === 'glm' && st3.args['--model'] === 'Maya-S' && st3.ggufDir === '/models/glm' && Object.keys(st3.args).length === 2, JSON.stringify(st3))
const ll = I.parseServerCommand('llama-server -m a.gguf --jinja \\\n --ctx-size 4096')
check('llama.cpp: a continuation after a switch does not become its value', ll.args['--jinja'] === true && ll.args['--ctx-size'] === 4096, JSON.stringify(ll))
check('Strata: a command with no flags gives nothing', Object.keys(I.parseStrataCommand('START-HERE.bat').args).length === 0 && I.parseStrataCommand('').serverPort === null)

// -- global override --------------------------------------------------------------
const none = { port: null, host: null, apiKey: null }
const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y)
check('override off overrides nothing', eq(P.activeServerOverrides({ enabled: false, port: 1234, serveOnLocalNetwork: true, apiKeyEnabled: true, apiKey: 'k' }, false), none))
check('no override object overrides nothing', eq(P.activeServerOverrides(undefined, false), none))
check('override on takes the port only', eq(P.activeServerOverrides({ enabled: true, port: 1234 }, false), { port: 1234, host: null, apiKey: null }))
check('serve on network takes the host', P.activeServerOverrides({ enabled: true, port: 1234, serveOnLocalNetwork: true }, false).host === '0.0.0.0')
check('an API key needs its switch and a value',
  P.activeServerOverrides({ enabled: true, port: 1234, apiKeyEnabled: true, apiKey: '' }, false).apiKey === null &&
  P.activeServerOverrides({ enabled: true, port: 1234, apiKeyEnabled: false, apiKey: 'k' }, false).apiKey === null &&
  P.activeServerOverrides({ enabled: true, port: 1234, apiKeyEnabled: true, apiKey: 'k' }, false).apiKey === 'k')
check('a Template that ignores the override keeps its own', eq(P.activeServerOverrides({ enabled: true, port: 1234, serveOnLocalNetwork: true, apiKeyEnabled: true, apiKey: 'k' }, true), none))
check('override port falls back to 1234', P.activeServerOverrides({ enabled: true, port: 0 }, false).port === 1234)
const cards = [{ template: { id: 'a', name: 'A', serverPort: 8080 } }, { template: { id: 'b', name: 'B', serverPort: 8081 } }]
check('a port clash names the other Template', P.findPortConflict(cards, 8081, 'a') === 'B')
check('a Template never clashes with itself', P.findPortConflict(cards, 8080, 'a') === null)

// -- Strata launch -------------------------------------------------------------------
const base = { ggufDir: 'A:\\m', family: 'qwen', model: 'IQ3_S', port: 8080 }
const own = S.buildStrataArgv({ ...base, args: { '--host': '0.0.0.0', '--api-key': 'mine' } }).argv.join(' ')
check('Strata sends the Template host and key', own.includes('--host 0.0.0.0') && own.includes('--api-key mine'), own)
const ovr = S.buildStrataArgv({ ...base, args: { '--host': '0.0.0.0', '--api-key': 'mine' }, host: '127.0.0.1', apiKey: 'global' }).argv.join(' ')
check('Strata override host and key win over the Template', ovr.includes('--host 127.0.0.1') && ovr.includes('--api-key global') && !ovr.includes('mine'), ovr)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

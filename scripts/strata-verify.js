// Verifies the Strata integration: the pure TS modules (argv builder, memory
// estimator, verdict, GGUF header reader, line assembler) and, when a Strata
// clone is available, that the constants and flags we mirror still match it.
//
//   node scripts/strata-verify.js [path/to/Strata]
//
// The clone path may also come from STRATA_DIR. Without one, the checks that
// need Strata's own files are skipped.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const strataDir = process.argv[2] || process.env.STRATA_DIR || ''
const hasStrata = strataDir && fs.existsSync(path.join(strataDir, 'setup.py'))

let failed = 0
const tasks = []
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
function skip(name) { console.log(`SKIP  ${name} (no Strata clone)`) }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-verify-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
  return require(out)
}
const S = bundle('src/shared/strata.ts', 'strata')
const G = bundle('src/main/ggufTensors.ts', 'gguf')
const L = bundle('src/main/lineAssembler.ts', 'lines')
const E = bundle('src/shared/engines.ts', 'engines')

// -- engine registry ---------------------------------------------------------
check('engineOf defaults legacy records to llama.cpp', E.engineOf({}) === 'llama.cpp' && E.engineOf(undefined) === 'llama.cpp' && E.engineOf('bogus') === 'llama.cpp')
check('engineOf resolves strata', E.engineOf({ engine: 'strata' }) === 'strata')
check('strata is the only model-specific engine', E.modelSpecificEngines().map(e => e.id).join() === 'strata')

// -- renderer-side engine/backend resolution ---------------------------------
const R = bundle('src/renderer/src/utils/engineBackends.ts', 'resolver')
const mk = (id, key, type, engine, name) => ({ id, name: name || id, displayName: key + ' ' + (type || ''), backendKey: key, backendType: type, version: 'v1', path: '/' + id, exe: 'x', hasCommands: false, rootDir: '/', engine })
const builds = [
  mk('a', 'llama.cpp', 'cuda-12.4'), mk('b', 'llama.cpp', 'vulkan'), mk('c', 'beellama', 'cuda-12.4'),
  mk('s1', 'Strata', null, 'strata', 'Strata'), mk('s2', 'strata-fork', null, 'strata', 'Strata')
]
{
  const active = builds[0]
  check('llama global selection is the active backend', R.globalBackendOf('llama.cpp', builds, active, {}).id === 'a')
  check('strata global defaults to the first strata install', R.globalBackendOf('strata', builds, active, {}).id === 's1')
  check('strata global follows the per-engine selection', R.globalBackendOf('strata', builds, active, { strata: { backendKey: 'strata-fork' } }).id === 's2')
  check('an active llama backend never leaks into another engine', R.globalBackendOf('strata', builds, active, {}).engine === 'strata')
  check('pin by repo and backend picks that build', R.resolveEngineBackend('llama.cpp', { backendKey: 'llama.cpp', backendType: 'vulkan' }, builds, active, {}).id === 'b')
  check('a stale pinned version falls back to the same repo and backend',
    R.resolveEngineBackend('llama.cpp', { backendKey: 'beellama', backendType: 'cuda-12.4', backendVersion: 'gone' }, builds, active, {}).id === 'c')
  check('an unknown pinned repo falls back to the global selection', R.resolveEngineBackend('llama.cpp', { backendKey: 'removed' }, builds, active, {}).id === 'a')
  check('a pin never selects another engine\'s install', R.resolveEngineBackend('strata', { backendKey: 'llama.cpp' }, builds, active, {}).engine === 'strata')
  check('no pin follows the global selection', R.resolveEngineBackend('strata', null, builds, active, { strata: { backendKey: 'strata-fork' } }).id === 's2')
  const known = { strata: { kind: 'known' } }, layout = { strata: { kind: 'layout' } }, no = { strata: { kind: 'no' } }
  check('auto picks strata for a known or same-layout file when installed',
    R.autoEngineFor(known, builds) === 'strata' && R.autoEngineFor(layout, builds) === 'strata')
  check('auto stays on llama.cpp for untested, unknown or unvalidated files',
    R.autoEngineFor({ strata: { kind: 'untested' } }, builds) === 'llama.cpp' && R.autoEngineFor(no, builds) === 'llama.cpp' && R.autoEngineFor(undefined, builds) === 'llama.cpp')
  const noStrata = builds.filter(b => b.engine !== 'strata')
  check('auto falls back to llama.cpp when strata is not installed, and reports it missing',
    R.autoEngineFor(known, noStrata) === 'llama.cpp' && R.missingEngineFor(known, noStrata) === 'strata' && R.missingEngineFor(known, builds) === null)
}

// -- strata metrics -----------------------------------------------------------
const M = bundle('src/main/strataMetrics.ts', 'metrics')
{
  const m = M.parseStrataMetrics(JSON.stringify({ totals: { prompt_tokens: 1000, reused: 400, prompt_ms: 2000, output_tokens: 50, decode_ms: 5000 } }))
  check('metrics: cached prompt tokens are excluded and ms become seconds',
    m['llamacpp:prompt_tokens_total'] === 600 && m['llamacpp:prompt_seconds_total'] === 2 && m['llamacpp:tokens_predicted_total'] === 50 && m['llamacpp:tokens_predicted_seconds_total'] === 5, JSON.stringify(m))
  check('metrics: junk and missing totals are rejected', M.parseStrataMetrics('not json') === null && M.parseStrataMetrics('{}') === null)
  check('metrics: reused above prompt never goes negative', M.parseStrataMetrics(JSON.stringify({ totals: { prompt_tokens: 1, reused: 5 } }))['llamacpp:prompt_tokens_total'] === 0)
}

// -- defaults and Common flags ------------------------------------------------
{
  const d = S.strataDefaults({ variant: 'IQ3_S', family: 'qwen', vramTotalGb: 24, ramTotalGb: 64 })
  check('defaults show the real values, not placeholders', d['--kv'] === 'int8' && d['--parallel'] === 1 && d['--draft-vocab'] === 'cjk' && d['--host'] === '127.0.0.1' &&
    d['--vram-reserve-mib'] === 700 && d['--vision'] === 'no' && d['--low-ram'] === 'auto' && d['--model'] === 'IQ3_S' && d['--family'] === 'qwen')
  check('rope defaults follow the context (yarn only beyond the trained 262144)',
    S.strataDefaults({ variant: 'IQ3_S', vramTotalGb: 24, ramTotalGb: 64, context: 262144 })['--rope-scaling'] === 'none' &&
    S.strataDefaults({ variant: 'IQ3_S', vramTotalGb: 24, ramTotalGb: 64, context: 524288 })['--rope-scaling'] === 'yarn' &&
    S.strataDefaults({ variant: 'IQ3_S', vramTotalGb: 24, ramTotalGb: 64, context: 524288 })['--rope-scale'] === 2)
  check('image tokens default depends on where the encoder runs', S.strataDefaults({ vramTotalGb: 24, ramTotalGb: 64, vision: 'cpu' })['--vision-tokens'] === 300 && d['--vision-tokens'] === 1024)
  check('the resident budget default exists only for the Unsloth variants', S.strataDefaults({ variant: 'UD-IQ4_XS', vramTotalGb: 24, ramTotalGb: 64 })['--resident-budget-gib'] === 40 && d['--resident-budget-gib'] === undefined)
  check('Server flags are not in the Common view and context is', !S.STRATA_COMMON_FLAGS.has('--host') && !S.STRATA_COMMON_FLAGS.has('--api-key') && S.STRATA_COMMON_FLAGS.has('--context') && S.STRATA_COMMON_FLAGS.has('--kv'))
}

// -- argv builder ------------------------------------------------------------
const base = { ggufDir: 'A:\\m', port: 1234, family: 'coder', model: 'IQ1_M', args: {} }
let r = S.buildStrataArgv(base)
check('argv has identity flags and sticky resets', r.argv && r.argv.join(' ') ===
  '--yes --no-browser --family coder --model IQ1_M --gguf-dir A:\\m --port 1234 --parallel 1 --draft-vocab cjk', r.argv && r.argv.join(' '))
r = S.buildStrataArgv({ ...base, args: { '--context': 65536, '--kv': 'q4_0', '--parallel': 3, '--vision': '', '--low-ram': null, '__lastPreset': 'quick', '--flag-on': true, '--flag-off': false } })
const joined = r.argv.join(' ')
check('argv carries set flags, skips empty/internal/false', joined.includes('--context 65536') && joined.includes('--kv q4_0') && joined.includes('--parallel 3') &&
  !joined.includes('--vision') && !joined.includes('--low-ram') && !joined.includes('__lastPreset') && joined.includes('--flag-on') && !joined.includes('--flag-off'), joined)
check('explicit parallel replaces the sticky reset', (joined.match(/--parallel/g) || []).length === 1)
r = S.buildStrataArgv({ ...base, host: '0.0.0.0', apiKey: 'k1', dataDir: 'D:\\data', args: { '--host': '127.0.0.1' } })
check('overrides win for host/api-key and data dir is passed', r.argv.join(' ').includes('--host 0.0.0.0') && !r.argv.join(' ').includes('127.0.0.1') &&
  r.argv.join(' ').includes('--api-key k1') && r.argv.join(' ').includes('--data-dir D:\\data'))
check('template family/model args beat detected values', S.buildStrataArgv({ ...base, args: { '--family': 'qwen', '--model': 'IQ3_S' } }).argv.join(' ').includes('--family qwen --model IQ3_S'))
check('missing family is an error', 'error' in S.buildStrataArgv({ ...base, family: null, model: null }))
const q = S.buildStrataQuickBaseline({ contextLength: 262144, hasVision: true })
check('quick baseline caps context at 32768, int8, vision', q['--context'] === 32768 && q['--kv'] === 'int8' && q['--vision'] === 'yes')

// -- memory estimator vs the reference formulas -------------------------------
function ref(model, vram, ctx, kv) {
  const arena = S.STRATA_VARIANTS[model].arenaGb
  const kvTok = 13 * (S.STRATA_KV_CELL_BYTES[kv] || 1056)
  return Math.max(0, Math.min(arena, vram - 5 - Math.max(0, ctx - 32768) * kvTok / 1e9))
}
let worst = 0
for (const model of Object.keys(S.STRATA_VARIANTS)) for (const vram of [8, 12, 16, 24, 32]) for (const ctx of [8192, 32768, 131072, 262144]) for (const kv of ['int8', 'q4_0', 'k8v4']) {
  const e = S.estimateStrataMemory({ variant: model, context: ctx, kv, lowRam: 'on', kvStreaming: 'off', reserveMib: 0, vramGb: vram, ramGb: 64 })
  worst = Math.max(worst, Math.abs(e.expertCacheGb - ref(model, vram, ctx, kv)))
}
check('expert cache matches low_ram_gpu_gb formula', worst < 1e-9, 'max diff ' + worst)
const ram = S.estimateStrataMemory({ variant: 'IQ3_S', context: 262144, kv: 'int8', lowRam: 'off', kvStreaming: 'on', vramGb: 24, ramGb: 128 })
check('IQ3 RAM need matches ctx_ram_need', Math.abs(ram.ramNeedGb - (50.3 + 262144 * 13 * 1056 / 1e9 + 24)) < 1e-9, String(ram.ramNeedGb))
check('low-RAM mode auto-detected when RAM is short', S.estimateStrataMemory({ variant: 'IQ3_S', context: 32768, vramGb: 24, ramGb: 48 }).lowRam === true)

// -- line assembler ----------------------------------------------------------
{
  const a = new L.LineAssembler(1000)
  const euro = Buffer.from('cost: \u20ac5\n')
  const out = [...a.push(euro.subarray(0, 8)), ...a.push(euro.subarray(8))]
  check('multi-byte character split across chunks survives', out.join('|') === 'cost: \u20ac5', JSON.stringify(out))
  const b = new L.LineAssembler(1000)
  const lines = [...b.push('a\r\nb\nc', 0), ...b.push('d\n', 0)]
  check('CRLF and partial lines assemble', lines.join('|') === 'a|b|cd', JSON.stringify(lines))
  const c = new L.LineAssembler(1000)
  const got = []
  got.push(...c.push('dl 1%\rdl 2%', 0))
  got.push(...c.push('\rdl 3%', 100))
  got.push(...c.push('\rdl 4%', 1200))
  got.push(...c.push('\rdl 100%\nnext\n', 1300))
  check('progress rewrites are throttled and end on the final state', got.join('|') === 'dl 2%|dl 4%|dl 100%|next', JSON.stringify(got))
}

// -- git install/update helpers -----------------------------------------------
const SE = bundle('src/main/strataEngine.ts', 'engine')
check('compareTags orders numerically', SE.compareTags('v0.1.9', 'v0.1.41') < 0 && SE.compareTags('v1.0', 'v0.9.9') > 0 && SE.compareTags('v0.1.41', '0.1.41') === 0)
check('baseTagOf strips describe suffix', SE.baseTagOf('v0.1.41-12-gabc1234') === 'v0.1.41' && SE.baseTagOf('v0.1.41') === 'v0.1.41' && SE.baseTagOf('abc1234') === null)
check('only GitHub owner/repo slugs make clone URLs', SE.githubCloneUrl('Niko1221/Strata') === 'https://github.com/Niko1221/Strata.git' &&
  SE.githubCloneUrl('--upload-pack=x/y') === null && SE.githubCloneUrl('ext::sh -c x/y') === null && SE.githubCloneUrl('a/b/c') === null)
check('cleanPathArg strips trailing separators', SE.cleanPathArg('A:\\m\\x\\') === 'A:\\m\\x' && SE.cleanPathArg('A:\\') === 'A:\\.' && SE.cleanPathArg('/a/b/') === '/a/b')
{
  const g = SE.resolveStrataData({ mode: 'global', dataDir: null, isolatedDir: null }, '/b')
  const g2 = SE.resolveStrataData({ mode: 'global', dataDir: '/d', isolatedDir: null }, '/b')
  const iso = SE.resolveStrataData({ mode: 'isolated', dataDir: null, isolatedDir: '/iso' }, '/b')
  const cfgVar = process.platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME'
  check('global data defaults to <backends>/Strata-data with no env change', g.dataDir === path.join('/b', 'Strata-data') && Object.keys(g.env).length === 0 && g2.dataDir === '/d')
  check('isolated data redirects Strata settings into its folder', iso.dataDir === '/iso' && String(iso.env[cfgVar]).startsWith(path.join('/iso')))
}
if (process.platform !== 'win32') {
  const spec = SE.buildStrataSpawn('/clone', ['--yes', '--port', '1234'], { FOO: 'bar' })
  check('posix spawn runs setup.sh via bash with stdin closed and a process group',
    spec.command === 'bash' && spec.args[0] === path.join('/clone', 'setup.sh') && spec.options.detached === true &&
    spec.options.stdio[0] === 'ignore' && spec.options.env.PYTHONUNBUFFERED === '1' && spec.options.env.PYTHONUTF8 === '1' && spec.options.env.FOO === 'bar')
}
{
  // Windows quoting is built from the same function; exercise it by faking the platform.
  const real = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const spec = SE.buildStrataSpawn('C:\\b\\Strata\\Strata', ['--gguf-dir', 'A:\\My Models\\x', '--port', '1234'], {})
  const bad = SE.buildStrataSpawn('C:\\b', ['--gguf-dir', 'A:\\100%\\x'], {})
  Object.defineProperty(process, 'platform', real)
  check('windows spawn quotes every argument for cmd /d /s /c', !('error' in spec) && spec.args[3] === '"' + ['"' + path.join('C:\\b\\Strata\\Strata', 'START-HERE.bat') + '"', '"--gguf-dir"', '"A:\\My Models\\x"', '"--port"', '"1234"'].join(' ') + '"' &&
    spec.options.windowsVerbatimArguments === true, JSON.stringify(spec.args))
  check('windows spawn refuses a percent sign in an argument', 'error' in bad)
}
const { execFileSync: run } = require('child_process')
let haveGit = true
try { run('git', ['--version'], { stdio: 'ignore' }) } catch { haveGit = false }
if (!haveGit) {
  skip('git update policy (git missing)')
} else {
  const g = (cwd, ...a) => run('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  const sh = (cwd, ...a) => run('git', a, { cwd, env, stdio: 'pipe', encoding: 'utf8' }).trim()
  const origin = path.join(tmp, 'origin.git'), work = path.join(tmp, 'work'), user = path.join(tmp, 'user')
  fs.mkdirSync(origin); sh(origin, 'init', '-q', '--bare', '-b', 'main')
  sh(tmp, 'clone', '-q', origin, work)
  fs.writeFileSync(path.join(work, 'setup.py'), 'v1'); fs.mkdirSync(path.join(work, 'serve')); fs.writeFileSync(path.join(work, 'serve', 'server.py'), '')
  fs.writeFileSync(path.join(work, '.gitignore'), 'local.cfg\n')
  sh(work, 'add', '-A'); sh(work, 'commit', '-qm', 'c1'); sh(work, 'tag', 'v0.1.1'); sh(work, 'push', '-q', 'origin', 'main', '--tags')
  sh(tmp, 'clone', '-q', origin, user)
  fs.writeFileSync(path.join(user, 'local.cfg'), 'mine')
  check('looksLikeStrataClone sees the marker files', SE.looksLikeStrataClone(user) && !SE.looksLikeStrataClone(tmp))
  tasks.push((async () => {
    check('version label is the tag', (await SE.gitVersionLabel(user)) === 'v0.1.1')
    fs.writeFileSync(path.join(work, 'setup.py'), 'v2'); sh(work, 'commit', '-qam', 'c2'); sh(work, 'tag', 'v0.1.2'); sh(work, 'push', '-q', 'origin', 'main', '--tags')
    check('latestRemoteTag finds the newest tag', (await SE.latestRemoteTag(origin)) === 'v0.1.2')
    let r = await SE.updateGitEngine(user)
    check('fast-forward update', r.updated === true && fs.readFileSync(path.join(user, 'setup.py'), 'utf8') === 'v2', JSON.stringify(r))
    check('update keeps untracked and ignored files', fs.readFileSync(path.join(user, 'local.cfg'), 'utf8') === 'mine')
    // rewrite upstream history
    sh(work, 'checkout', '-q', '--orphan', 'new'); sh(work, 'add', '-A'); sh(work, 'commit', '-qm', 'rewritten'); sh(work, 'branch', '-M', 'main')
    fs.writeFileSync(path.join(work, 'setup.py'), 'v3'); sh(work, 'commit', '-qam', 'c3'); sh(work, 'push', '-q', '-f', 'origin', 'main')
    r = await SE.updateGitEngine(user)
    check('rewritten history falls back to reset', r.updated === true && !r.error && fs.readFileSync(path.join(user, 'setup.py'), 'utf8') === 'v3', JSON.stringify(r))
    check('reset keeps ignored files', fs.readFileSync(path.join(user, 'local.cfg'), 'utf8') === 'mine')
    sh(user, 'checkout', '-q', '-b', 'my-pr')
    r = await SE.updateGitEngine(user)
    check('a branch without upstream is left alone', r.updated === false && /no upstream/.test(r.skipped || ''), JSON.stringify(r))
    sh(user, 'checkout', '-q', '--detach')
    r = await SE.updateGitEngine(user)
    check('detached HEAD is left alone', r.updated === false && r.skipped === 'detached HEAD', JSON.stringify(r))
  })().catch(e => { console.log('FAIL  git section threw: ' + e.message); failed++ }))
}

// -- GGUF reader, against Strata's own quantscope when available ---------------
const gen = path.join(tmp, 'gen.py')
fs.writeFileSync(gen, `
import struct, sys
def s(x): b=x.encode(); return struct.pack('<Q',len(b))+b
def kv(k,t,p): return s(k)+struct.pack('<I',t)+p
def make(path, arch, tensors, align=64):
    kvs=[kv('general.architecture',8,s(arch)), kv('general.alignment',4,struct.pack('<I',align)),
         kv('tokenizer.ggml.tokens',9,struct.pack('<IQ',8,300)+b''.join(s('tok%d'%i) for i in range(300))),
         kv('tokenizer.ggml.scores',9,struct.pack('<IQ',6,300)+b'\\0'*1200)]
    head=b'GGUF'+struct.pack('<I',3)+struct.pack('<Q',len(tensors))+struct.pack('<Q',len(kvs))+b''.join(kvs)
    infos=b''; off=0; blobs=[]
    for name,dims,tt,nb in tensors:
        infos+=s(name)+struct.pack('<I',len(dims))+b''.join(struct.pack('<Q',d) for d in dims)+struct.pack('<I',tt)+struct.pack('<Q',off)
        pad=(nb+align-1)//align*align; blobs.append(b'\\0'*pad); off+=pad
    hdr=head+infos; pad=(align-len(hdr)%align)%align
    open(path,'wb').write(hdr+b'\\0'*pad+b''.join(blobs))
d=sys.argv[1]
make(d+'/m-00001-of-00002.gguf','qwen4exp',[('blk.0.ffn_down_exps.weight',[256,64,8],21,110*256*64*8//256),('blk.0.attn_norm_exps.weight',[256],0,1024),('blk.0.attn_q.weight',[256,256],8,34*256*256//32)])
make(d+'/m-00002-of-00002.gguf','qwen4exp',[('blk.1.ffn_up_exps.weight',[256,64,8],42,66*256*64*8//256),('blk.1.hc_mix.weight',[64],1,128),('output.weight',[256,256],8,34*256*256//32)])
make(d+'/lone-00001-of-00002.gguf','qwen4exp',[('blk.0.ffn_down_exps.weight',[256,64,8],21,1000)])
make(d+'/other.gguf','llama',[('blk.0.ffn_down.weight',[256,256],12,144*256*256//256)])
`)
let pythonOk = true
try { execFileSync('python3', [gen, tmp]) } catch { pythonOk = false }
if (!pythonOk) {
  skip('GGUF reader checks (python3 missing)')
} else {
  tasks.push((async () => {
    const multi = await G.fingerprintGguf(path.join(tmp, 'm-00001-of-00002.gguf'))
    check('reader sums both shards and skips the norm-named tensor',
      multi.arch === 'qwen4exp' && multi.tensors === 6 && multi.expertBytes.IQ3_S === 56320 && multi.expertBytes.Q2_0 === 33792, JSON.stringify(multi))
    check('incomplete shard set yields null', (await G.fingerprintGguf(path.join(tmp, 'lone-00001-of-00002.gguf'))) === null)
    const other = await G.fingerprintGguf(path.join(tmp, 'other.gguf'))
    check('non-Strata architecture is reported', other.arch === 'llama' && S.strataVerdict(other, {}).kind === 'no')
    if (hasStrata) {
      const py = JSON.parse(execFileSync('python3', ['-c', `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(path.join(strataDir, 'tools'))})
import strata_inspect as si, quantscope as qs
def src(p): return qs.Source(os.path.basename(p), os.path.getsize(p), path=p)
d=${JSON.stringify(tmp)}
arch,ts=si.read_headers([src(d+'/m-00001-of-00002.gguf'), src(d+'/m-00002-of-00002.gguf')])
fp=si.fingerprint(arch,ts)
print(json.dumps({k:fp[k] for k in ('arch','tensors','bytes','expert_bytes')}))
`]).toString())
      check('reader agrees with strata_inspect.py', py.arch === multi.arch && py.tensors === multi.tensors && py.bytes === multi.bytes &&
        JSON.stringify(py.expert_bytes) === JSON.stringify(multi.expertBytes), JSON.stringify(py))
    } else skip('reader parity with strata_inspect.py')
  })().catch(e => { console.log('FAIL  reader threw: ' + e.message); failed++ }))
}

// -- mirrored constants and flags vs a Strata clone ---------------------------
if (hasStrata) {
  const setup = fs.readFileSync(path.join(strataDir, 'setup.py'), 'utf8')
  const table = JSON.parse(fs.readFileSync(path.join(strataDir, 'data', 'gguf_fingerprints.json'), 'utf8'))
  const bundled = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'strata-fingerprints.json'), 'utf8'))
  check('bundled fingerprint table matches the clone (refresh resources/strata-fingerprints.json if not)',
    S.strataTableHash(table) === S.strataTableHash(bundled), `${S.strataTableHash(table)} vs ${S.strataTableHash(bundled)}`)
  const num = (re) => { const m = setup.match(re); return m ? parseFloat(m[1]) : NaN }
  check('LOW_RAM_HEADROOM_GB', num(/^LOW_RAM_HEADROOM_GB = ([0-9.]+)/m) === S.STRATA_LOW_RAM_HEADROOM_GB)
  check('KV cell bytes (q4_0, k8v4)', num(/KV_CELL_BYTES = \{"q4_0": (\d+)/) === S.STRATA_KV_CELL_BYTES.q4_0 && num(/"k8v4": (\d+)\}/) === S.STRATA_KV_CELL_BYTES.k8v4)
  check('13 KV cells per token and ~5 GB base VRAM', /kv_tok = 13 \* KV_CELL_BYTES/.test(setup) && /vram_gb - 5 - longer/.test(setup))
  check('IQ3 RAM headroom of 24 GB', /ctx \* 13 \* 1056 \/ 1e9 \+ 24/.test(setup))
  const mi = setup.indexOf('MODELS = {'), mj = setup.indexOf('\n}\n', mi)
  const block = setup.slice(mi, mj)
  let tableOk = true
  for (const [name, v] of Object.entries(S.STRATA_VARIANTS)) {
    const m = block.match(new RegExp('"' + name + '": \\{[\\s\\S]*?"ram_gb": (\\d+)[\\s\\S]*?"arena_gb": ([0-9.]+)'))
    if (!m || parseFloat(m[2]) !== v.arenaGb || parseInt(m[1], 10) !== v.ramGb) { tableOk = false; console.log('      variant differs: ' + name) }
  }
  check('variant table (arena GB, RAM GB)', tableOk)
  // The recommended context against Strata's own ram_ctx / low_ram_wanted.
  const expected = JSON.parse(execFileSync('python3', ['-c', `
import sys, json
sys.path.insert(0, ${JSON.stringify(strataDir)})
import setup
out = []
for model in setup.MODELS:
    for vram in (8, 12, 16, 22, 24, 32):
        for ram in range(16, 201, 4):
            small = vram
            rec = 32768 if small < 14 else 65536 if small < 20 else 131072
            if setup.MODELS[model].get("budget"):
                rec = 8192 if small < 14 else 32768
            lr = setup.low_ram_wanted(model, ram, "auto")
            rec = min(rec, setup.ram_ctx(model, ram, lr))
            out.append([model, vram, ram, rec])
print(json.dumps(out))
`]).toString())
  const wrong = expected.filter(([model, vram, ram, rec]) => S.strataRecommendedContext({ variant: model, vramTotalGb: vram, ramTotalGb: ram }) !== rec)
  check(`recommended context agrees with setup.py (${expected.length} cases)`, wrong.length === 0, JSON.stringify(wrong.slice(0, 3)))
  let help = ''
  try { help = execFileSync('python3', [path.join(strataDir, 'setup.py'), '--help'], { encoding: 'utf8' }) } catch (e) { help = String(e.stdout || '') }
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'commands.strata.json'), 'utf8'))
  const missing = []
  for (const c of schema.categories) for (const p of c.commands) if (!help.includes(p.arg)) missing.push(p.arg)
  check('every schema flag exists in setup.py --help', missing.length === 0, missing.join(' '))
  const drafts = (setup.match(/^DRAFT_VOCABS = \{([^}]*)\}/m) || [])[1] || ''
  const schemaDrafts = schema.categories.flatMap(c => c.commands).find(p => p.arg === '--draft-vocab').options
  check('draft-vocab choices', schemaDrafts.every(o => drafts.includes('"' + o + '"')) && (drafts.match(/"draft_vocab/g) || []).length === schemaDrafts.length)
} else {
  skip('mirrored constants, variant table and schema flags')
}

function finish() {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
}
Promise.all(tasks).then(finish)

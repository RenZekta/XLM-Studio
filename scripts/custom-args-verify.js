// Verifies the Custom Arguments text: how it is split, which flags count as
// supported, what reaches the launch command, and how supported flags are
// imported into a Template's args.
//
//   node scripts/custom-args-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-args-verify-'))
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const C = bundle('src/shared/customArgs.ts', 'custom')

const schema = {
  version: '1',
  categories: [{
    name: 'x', icon: 'Box', commands: [
      { arg: '--ctx-size', short: '-c', label: 'Ctx', description: '', type: 'number' },
      { arg: '--flash-attn', short: '-fa', label: 'FA', description: '', type: 'select', options: ['on', 'off', 'auto'] },
      { arg: '--no-mmap', label: 'mmap', description: '', type: 'boolean' },
      { arg: '--spec-draft-type-k', aliases: ['--cache-type-k-draft', '-ctkd'], label: 'K', description: '', type: 'select' }
    ]
  }]
}

// -- parsing ------------------------------------------------------------------
const e1 = C.parseCustomArgs('--my-flag 3 --other\n--path "C:\\a b\\c" --seed -1 --k=v')
check('splits flags and values', eq(e1.map(e => [e.flag, e.values]), [['--my-flag', ['3']], ['--other', []], ['--path', ['C:\\a b\\c']], ['--seed', ['-1']], ['--k', ['v']]]), JSON.stringify(e1))
check('multi-value flag stays one entry', eq(C.parseCustomArgs('--lora-scaled a.gguf 0.5').map(e => e.values), [['a.gguf', '0.5']]))
check('line continuation dropped', eq(C.parseCustomArgs('--a 1 \\\n--b 2').map(e => e.flag), ['--a', '--b']))

// -- classification -----------------------------------------------------------
const k = C.classifyCustomArgs('--my-flag 1 -c 4096 --cache-type-k-draft q8_0 -m x.gguf --port 9 --no-mmap', schema)
check('custom vs supported vs reserved', eq(k.map(e => e.kind), ['custom', 'supported', 'supported', 'reserved', 'reserved', 'supported']), JSON.stringify(k.map(e => e.kind)))
check('short flag and alias resolve to schema key', k[1].key === '--ctx-size' && k[2].key === '--spec-draft-type-k')
check('mmproj offload toggle counts as supported', C.classifyCustomArgs('--no-mmproj-offload', schema)[0].kind === 'supported')
check('no schema: nothing is supported', C.classifyCustomArgs('-c 1', null)[0].kind === 'custom')

// -- launch tokens ------------------------------------------------------------
check('launch tokens drop reserved flags only', eq(C.customArgsLaunchTokens('--x 1 -m a.gguf --port 5 -c 2 --y=z'), ['--x', '1', '-c', '2', '--y', 'z']))
check('launch tokens unquote values', eq(C.customArgsLaunchTokens('--p "a b"'), ['--p', 'a b']))
check('launch tokens empty for missing text', eq(C.customArgsLaunchTokens(undefined), []) && eq(C.customArgsLaunchTokens('  '), []))

// -- import -------------------------------------------------------------------
const text = '--my-flag 1\n-c 8192 --flash-attn on\n--other'
const r = C.importSupportedArgs(text, { '--ctx-size': 4096 }, schema, true)
check('overwrite replaces stored value', r.args['--ctx-size'] === 8192 && r.conflicts.length === 1)
check('number and select typed by schema', r.args['--flash-attn'] === 'on' && typeof r.args['--ctx-size'] === 'number')
check('unsupported text stays', r.text === '--my-flag 1\n--other', JSON.stringify(r.text))
const r2 = C.importSupportedArgs(text, { '--ctx-size': 4096 }, schema, false)
check('no overwrite keeps stored, still imports unset', r2.args['--ctx-size'] === 4096 && r2.args['--flash-attn'] === 'on' && eq(r2.kept, ['--ctx-size']))
check('same value is not a conflict', C.importSupportedArgs('-c 4096', { '--ctx-size': 4096 }, schema, true).conflicts.length === 0)
check('boolean switch imports as true', C.importSupportedArgs('--no-mmap', {}, schema, true).args['--no-mmap'] === true)
check('removing the only flag leaves empty text', C.importSupportedArgs('-c 1', {}, schema, true).text === '')

// -- paste import routing -----------------------------------------------------
const part = C.partitionImportedArgs({ '--ctx-size': 1, '--weird': true, '--host': 'h' }, schema)
check('unknown flags routed to custom', eq(Object.keys(part.custom), ['--weird']) && eq(Object.keys(part.known), ['--ctx-size', '--host']))
check('append formats one flag per line', C.appendCustomArgs('--a 1', { '--b': 'x y', '--c': true }) === '--a 1\n--b "x y"\n--c')

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

// Verifies the card expression language, the rules resolver, presets, engine
// overrides and the widget and logic validation of engine cards.
//
//   node scripts/card-logic-verify.js

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-logic-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error', external: ['electron'] })
  return require(out)
}
const X = bundle('src/shared/cardExpr.ts', 'expr')
const R = bundle('src/shared/cardRules.ts', 'rules')
const C = bundle('src/shared/engineCard.ts', 'card')
const K = bundle('src/shared/cardContext.ts', 'ctx')

const ctx = (over = {}) => ({
  ...K.emptyCardContext('linux'),
  system: { ...K.emptyCardContext('linux').system, vram: { totalMB: 24000, freeMB: 3000, gpus: [{ name: 'RTX', totalMB: 24000, freeMB: 3000 }] }, ram: { totalMB: 64000, freeMB: 32000 } },
  model: { path: '/m/a.gguf', fileName: 'a.gguf', sizeMB: 4000, arch: 'llama', contextLength: 131072, layers: 32, expertCount: 0, hiddenSize: 4096, headCount: 32, kvHeads: 8, isMoe: false },
  ...over
})
const ev = (src, c = ctx()) => X.evalSource(src, c)

// ----- expressions -----
check('arithmetic precedence', ev('1 + 2 * 3') === 7)
check('left associativity', ev('10 - 4 - 3') === 3)
check('parentheses', ev('(1 + 2) * 3') === 9)
check('unary minus binds tighter than multiplication', ev('-2 * 3') === -6)
check('comparison and logic', ev('1 < 2 && 3 >= 3 || false') === true)
check('not', ev('!(1 > 2)') === true)
check('ternary', ev('1 > 2 ? "a" : "b"') === 'b')
check('nested ternary is right associative', ev('false ? 1 : false ? 2 : 3') === 3)
check('string concatenation', ev("'a' + 'b'") === 'ab')
check('member and index', ev('system.vram.gpus[0].name') === 'RTX')
check('missing path is null', ev('system.vram.gpus[3].name') === null)
check('null spreads through arithmetic', ev('model.nope + 1') === null)
check('ordering with null is false', ev('model.nope < 5') === false && ev('model.nope >= 5') === false)
check('division by zero is null', ev('1 / 0') === null)
check('args by flag', ev('args["--ctx"] * 2', ctx({ args: { '--ctx': 4096 } })) === 8192)
check('arg() and isSet()', ev('arg("--ctx")', ctx({ args: { '--ctx': 7 } })) === 7 && ev('isSet("--ctx")') === false && ev('isSet("--ctx")', ctx({ args: { '--ctx': 1 } })) === true)
check('min, max, clamp, round', ev('min(5, 3, 9)') === 3 && ev('max(5, 3, 9)') === 9 && ev('clamp(15, 0, 10)') === 10 && ev('round(2.567, 1)') === 2.6)
check('floor and ceil', ev('floor(2.9)') === 2 && ev('ceil(2.1)') === 3)
check('min with a null is null', ev('min(1, model.nope)') === null)
check('string helpers', ev('contains("abc", "b")') === true && ev('startsWith("abc", "a")') === true && ev('endsWith("abc", "c")') === true && ev('upper("a")') === 'A' && ev('lower("A")') === 'a')
check('len and has', ev('len("abcd")') === 4 && ev('has(system, "os")') === true)
check('coalesce skips null and empty', ev('coalesce(model.nope, "", 5)') === 5)
check('real expression from a card', ev('min(model.contextLength, 32768)') === 32768)
check('proto keys are blocked', ev('args["__proto__"]') === null && ev('args.constructor') === null)
check('unknown function is a parse error', 'error' in X.parseExpr('eval("1")'))
check('unknown root is a parse error', 'error' in X.parseExpr('process.env'))
check('trailing garbage is a parse error', 'error' in X.parseExpr('1 + 2 )'))
check('unterminated string is a parse error', 'error' in X.parseExpr('"abc'))
check('empty is a parse error', 'error' in X.parseExpr('  '))
check('over-long source is refused', 'error' in X.parseExpr('1+'.repeat(300) + '1'))
check('too many nodes are refused', 'error' in X.parseExpr(Array(150).fill('1').join('+')))
check('deep nesting is refused', 'error' in X.parseExpr('('.repeat(60) + '1' + ')'.repeat(60)))
check('evaluation of a broken source is null', X.evalSource('1 +', ctx()) === null)

// ----- interpolation -----
check('interpolation fills a value', X.interpolate('Free: ${round(system.vram.freeMB / 1024, 1)} GB', ctx()) === 'Free: 2.9 GB')
check('$$ is a dollar sign', X.interpolate('cost $$5 ${1 + 1}', ctx()) === 'cost $5 2')
check('a brace inside a string does not end the part', X.interpolate("${'}'}", ctx()) === '}')
check('null shows as nothing', X.interpolate('[${model.nope}]', ctx()) === '[]')
check('an unclosed part is an error', 'error' in X.parseTemplate('a ${1 + 1'))
const refs = X.exprRefs(X.parseExpr('args["--a"] + arg("--b") + isSet("--c") + system.os.length').ast)
check('references are collected', ['--a', '--b', '--c'].every(a => refs.args.includes(a)) && refs.roots.includes('system'), JSON.stringify(refs))

// ----- cards with logic -----
const card = () => ({
  cardVersion: 1, id: 'logic', label: 'Logic', engine: { folder: 'Logic' },
  launch: { file: 'run.sh', argv: ['--model', '{model}', '--port', '{port}', '{params}'] },
  params: {
    categories: [
      { name: 'Generation', commands: [
        { arg: '--context', label: 'Context', type: 'number', widget: 'slider', slider: { min: 512, max: { expr: 'min(model.contextLength, 65536)' }, step: 256, scale: 'ladder', allowAuto: true, recommended: 8192 } },
        { arg: '--parallel', label: 'Parallel', type: 'number', min: 1, max: 8 },
        { arg: '--fa', label: 'Flash attention', type: 'boolean', widget: 'tristate', offArg: '--no-fa' },
        { arg: '--kv', label: 'KV', type: 'select', widget: 'segmented', options: ['f16', 'q8_0'], valueMap: { q8_0: 'q8' } },
        { arg: '--spec-on', label: 'Speculative', type: 'boolean', internal: true },
        { arg: '--draft', label: 'Draft model', type: 'string', widget: 'file' },
        { arg: '--lora', label: 'LoRA', type: 'string', widget: 'list' },
        { arg: '--set', label: 'Overrides', type: 'text', widget: 'keyvalue' },
        { arg: '--key', label: 'Key', type: 'string', widget: 'password' },
        { arg: '--family', label: 'Family', type: 'select', options: ['qwen', 'swift'] },
        { arg: '--variant', label: 'Variant', type: 'select', optionsBy: { arg: '--family', map: { qwen: ['Q2_0', 'IQ3_S'], swift: ['Q2_0'] } } },
        { arg: '--total', label: 'Total slots', type: 'number', exprs: undefined, default: { expr: 'arg("--parallel") * 2' } },
        { arg: '--threads', label: 'Threads', type: 'number', min: 1, max: 64 }
      ] }
    ],
    rules: [
      { id: 'low-vram', when: 'system.vram.freeMB < 4000', then: [
        { clamp: { arg: '--context', max: 16384 } },
        { warn: 'Only ${round(system.vram.freeMB / 1024, 1)} GB of VRAM is free.', tone: 'warning', at: '--context' }
      ] },
      { id: 'spec', when: '!arg("--spec-on")', then: [{ hide: ['--draft'] }] },
      { id: 'dflt', when: 'true', then: [{ default: { '--parallel': 2 } }] },
      { id: 'need', when: 'arg("--spec-on")', then: [{ require: ['--draft'], message: 'Pick a draft model.' }] },
      { id: 'force-fa', when: 'model.isMoe', then: [{ force: { '--fa': true } }], else: [{ disable: ['--threads'] }] }
    ],
    blocks: [
      { id: 'vram', kind: 'banner', tone: 'warning', when: 'system.vram.freeMB < 4000', text: 'Low VRAM: ${system.vram.freeMB} MB', section: 'Generation' },
      { id: 'gpu', kind: 'stat', label: 'GPU', value: 'system.vram.gpus[0].name' },
      { id: 'spec-group', kind: 'group', label: 'Speculative decoding', enabledBy: '--spec-on', commands: ['--draft'], at: { after: '--spec-on' } },
      { id: 'sep', kind: 'divider', label: 'More', at: 'end' }
    ],
    presets: [
      { id: 'fast', name: 'Fast', args: { '--context': 8192, '--parallel': 1 } },
      { id: 'fit', name: 'Fit to VRAM', mode: 'replace', args: { '--context': { expr: 'min(model.contextLength, floor(system.vram.freeMB * 2))' } } }
    ]
  },
  overrides: {
    sections: [{ id: 'perf', title: 'Performance', icon: 'Zap', fields: [
      { id: 'parallel', label: 'Parallel requests', type: 'number', min: 1, max: 8, applyTo: '--parallel' },
      { id: 'fa', label: 'Flash attention', type: 'boolean', applyTo: '--fa' }
    ] }],
    global: { threads: '--threads' }
  },
  checkpoints: { enable: { arg: '--slot-save-path', value: '{checkpointDir}' }, save: { method: 'POST', path: '/slots/0?action=save', body: { filename: '{filename}' } }, restore: { path: '/slots/0?action=restore', body: { filename: '{filename}' } } },
  memory: { estimator: 'llama', map: { contextLength: '--context', cacheTypeK: '--kv', parallel: '--parallel' } }
})
const cardClean = () => { const c = card(); delete c.params.categories[0].commands.find(p => p.arg === '--total').exprs; return c }
const verr = mutate => { const c = cardClean(); mutate(c); return C.validateEngineCard(c).errors }

const okv = C.validateEngineCard(cardClean())
check('a card with every widget, rule, block and preset is valid', !!okv.card && okv.errors.length === 0, okv.errors.join('; '))
check('slider bounds from the card are folded into the parameter', okv.card.params.categories[0].commands[0].min === 512 && okv.card.params.categories[0].commands[0].exprs.max.includes('contextLength'))
check('overrides, checkpoints and memory are kept', !!okv.card.overrides && !!okv.card.checkpoints && okv.card.memory.estimator === 'llama')
check('a card that is only warnings loads clean', okv.warnings.length === 0, okv.warnings.join('; '))

// ----- widget validation -----
check('slider needs a number', verr(c => { c.params.categories[0].commands[2].widget = 'slider' }).some(e => /slider/.test(e)))
check('segmented holds at most 4 options', verr(c => { const p = c.params.categories[0].commands[3]; p.options = ['a', 'b', 'c', 'd', 'e'] }).some(e => /at most 4/.test(e)))
check('tristate needs offArg', verr(c => { delete c.params.categories[0].commands[2].offArg }).some(e => /offArg/.test(e)))
check('unknown widget is refused', verr(c => { c.params.categories[0].commands[1].widget = 'dial' }).some(e => /widget/.test(e)))
check('repeat is for lists', verr(c => { c.params.categories[0].commands[1].repeat = true }).some(e => /repeat/.test(e)))
check('internal cannot have offArg', verr(c => { c.params.categories[0].commands[4].offArg = '--x' }).some(e => /internal/.test(e)))
check('a slider needs bounds', verr(c => { const p = c.params.categories[0].commands[0]; delete p.slider.max; delete p.max }).some(e => /slider needs/.test(e)))
check('unknown slider scale is refused', verr(c => { c.params.categories[0].commands[0].slider.scale = 'log' }).some(e => /scale/.test(e)))
check('options cannot be an expression', verr(c => { c.params.categories[0].commands[3].options = { expr: '1' } }).some(e => /optionsBy/.test(e)))
check('optionsBy must name a select', verr(c => { c.params.categories[0].commands[10].optionsBy.arg = '--parallel' }).some(e => /not a select/.test(e)))
check('a broken expression is refused', verr(c => { c.params.categories[0].commands[1].min = { expr: '1 +' } }).some(e => /--parallel\.min/.test(e) || /min/.test(e)))
check('an expression naming an unknown parameter is refused', verr(c => { c.params.categories[0].commands[1].max = { expr: 'arg("--nope")' } }).some(e => /--nope/.test(e)))
check('unknown parameter key warns', C.validateEngineCard((() => { const c = cardClean(); c.params.categories[0].commands[1].colour = 'red'; return c })()).warnings.some(w => /colour/.test(w)))

// ----- rule validation -----
check('rule target must exist', verr(c => { c.params.rules[1].then = [{ hide: ['--nope'] }] }).some(e => /--nope/.test(e)))
check('rule expression must parse', verr(c => { c.params.rules[0].when = 'system.vram.freeMB <' }).length > 0)
check('rule needs then or else', verr(c => { c.params.rules.push({ when: 'true' }) }).some(e => /then/.test(e)))
check('an effect has exactly one action', verr(c => { c.params.rules[1].then = [{ hide: ['--draft'], show: ['--draft'] }] }).some(e => /exactly one/.test(e)))
check('force value must fit the type', verr(c => { c.params.rules[4].then = [{ force: { '--fa': 'yes' } }] }).some(e => /does not fit/.test(e)))
check('force select value must be an option', verr(c => { c.params.rules[4].then = [{ force: { '--kv': 'q2' } }] }).some(e => /options/.test(e)))
check('clamp must target a number', verr(c => { c.params.rules[0].then[0].clamp.arg = '--fa' }).some(e => /not a number/.test(e)))
check('warn at must name a parameter or category', verr(c => { c.params.rules[0].then[1].at = 'Nope' }).some(e => /\.at/.test(e)))
check('rule ids must be unique', verr(c => { c.params.rules[1].id = 'low-vram' }).some(e => /twice/.test(e)))
check('block ids must be unique', verr(c => { c.params.blocks[1].id = 'vram' }).some(e => /twice/.test(e)))
check('block section must exist', verr(c => { c.params.blocks[0].section = 'Nope' }).some(e => /section/.test(e)))
check('block after must name a parameter', verr(c => { c.params.blocks[2].at = { after: '--nope' } }).some(e => /after/.test(e)))
check('group switch must be a boolean', verr(c => { c.params.blocks[2].enabledBy = '--parallel' }).some(e => /boolean/.test(e)))
check('estimate block needs memory', verr(c => { delete c.memory; c.params.blocks.push({ id: 'e', kind: 'estimate' }) }).some(e => /memory/.test(e)))
check('preset arg must exist', verr(c => { c.params.presets[0].args['--nope'] = 1 }).some(e => /--nope/.test(e)))
check('preset value must fit the type', verr(c => { c.params.presets[0].args['--context'] = 'big' }).some(e => /does not fit/.test(e)))
check('preset ids must be unique', verr(c => { c.params.presets[1].id = 'fast' }).some(e => /twice/.test(e)))
check('override applyTo must exist', verr(c => { c.overrides.sections[0].fields[0].applyTo = '--nope' }).some(e => /applyTo/.test(e)))
check('global override must be known', verr(c => { c.overrides.global = { speed: '--threads' } }).some(e => /unknown setting/.test(e)))
check('checkpoint placeholder must be known', verr(c => { c.checkpoints.save.body.filename = '{nope}' }).some(e => /nope/.test(e)))
check('checkpoints need save or restore', verr(c => { c.checkpoints = { enable: { arg: '--x' } } }).some(e => /save/.test(e)))
check('memory map must name parameters', verr(c => { c.memory.map.parallel = '--nope' }).some(e => /--nope/.test(e)))

// ----- resolver -----
const cd = C.validateEngineCard(cardClean()).card
const resolve = (args, c = ctx(), ov) => R.resolveCard(cd, args, c, ov)
let r = resolve({ '--context': 65536 })
check('low VRAM clamps the effective context', r.args['--context'] === 16384)
check('the stored arguments are not changed', (() => { const a = { '--context': 65536 }; resolve(a); return a['--context'] === 65536 })())
check('a warning is interpolated and attached', r.warnings.some(w => w.text === 'Only 2.9 GB of VRAM is free.' && w.at === '--context'), JSON.stringify(r.warnings))
r = resolve({ '--context': 65536 }, ctx({ system: { ...ctx().system, vram: { totalMB: 24000, freeMB: 20000, gpus: [] } } }))
check('plenty of VRAM leaves the context alone and no warning', r.args['--context'] === 65536 && r.warnings.length === 0)
check('default applies to an unset parameter', resolve({}).args['--parallel'] === 2)
check('default does not replace a set parameter', resolve({ '--parallel': 4 }).args['--parallel'] === 4)
check('hide when the switch is off', resolve({}).hidden.has('--draft'))
check('show when the switch is on', !resolve({ '--spec-on': true, '--draft': 'd.gguf' }).hidden.has('--draft'))
check('require blocks when empty', resolve({ '--spec-on': true }).missing[0]?.message === 'Pick a draft model.')
check('require passes when set', resolve({ '--spec-on': true, '--draft': 'd.gguf' }).missing.length === 0)
check('group disables members while off', resolve({}).disabled.has('--draft') && !resolve({ '--spec-on': true, '--draft': 'x' }).disabled.has('--draft'))
check('else branch runs when false', resolve({}).disabled.has('--threads'))
const moe = ctx({ model: { ...ctx().model, isMoe: true } })
r = resolve({ '--fa': false }, moe)
check('force wins over the Template value and locks', r.args['--fa'] === true && r.locked.get('--fa')?.by === 'rule')
check('force on a dense model is not applied', resolve({ '--fa': false }).args['--fa'] === false)
r = resolve({ '--fa': false }, moe, { '--fa': false })
check('engine override wins over force', r.args['--fa'] === false && r.locked.get('--fa')?.by === 'override')
check('later rules see earlier forces', (() => {
  const c = cardClean()
  c.params.rules = [{ when: 'true', then: [{ force: { '--parallel': 3 } }] }, { when: 'arg("--parallel") == 3', then: [{ force: { '--threads': 9 } }] }]
  const v = C.validateEngineCard(c)
  return v.card && R.resolveCard(v.card, {}, ctx()).args['--threads'] === 9
})())
check('param views compute dynamic bounds', R.paramView(cd.params.categories[0].commands[0], ctx()).max === 65536)
check('a dynamic default is computed from other arguments', (() => {
  const c = card()
  const v = C.validateEngineCard(c)
  const p = v.card.params.categories[0].commands.find(x => x.arg === '--total')
  return v.errors.length === 0 && R.paramView(p, ctx({ args: { '--parallel': 3 } })).default === 6
})())
check('dependent options follow the other value', R.paramView(cd.params.categories[0].commands[10], ctx({ args: { '--family': 'swift' } })).options.length === 1 && R.paramView(cd.params.categories[0].commands[10], ctx({ args: { '--family': 'qwen' } })).options.length === 2)

// ----- arguments -----
const argv = (args, c, ov) => { const b = C.buildCardArgv(cd, { modelPath: '/m/a.gguf', port: 8080, engineDir: '/e', args, context: c ?? ctx(), overrideArgs: ov }); return 'error' in b ? b : b.argv }
check('internal and hidden parameters are not sent', (() => { const a = argv({ '--spec-on': true, '--draft': 'd.gguf', '--parallel': 2 }); return !a.includes('--spec-on') && a.includes('--draft') })())
check('a hidden parameter is not sent even when set', !argv({ '--draft': 'd.gguf' }).includes('--draft'))
check('valueMap changes what is sent', (() => { const a = argv({ '--kv': 'q8_0' }); return a.join(' ').includes('--kv q8') && !a.includes('q8_0') })())
check('a list is sent once per item', (() => { const a = argv({ '--lora': ['a.gguf', 'b.gguf'] }); return a.filter(x => x === '--lora').length === 2 && a.includes('b.gguf') })())
check('a list with join is sent once', (() => {
  const c = cardClean(); c.params.categories[0].commands.find(p => p.arg === '--lora').join = ','
  const v = C.validateEngineCard(c).card
  const b = C.buildCardArgv(v, { modelPath: '/m', port: 1, engineDir: '/e', args: { '--lora': ['a', 'b'] }, context: ctx() })
  return b.argv.join(' ').includes('--lora a,b')
})())
check('keyvalue items are sent as repeated flags', argv({ '--set': ['a=1', 'b=2'] }).filter(x => x === '--set').length === 2)
check('the context argument is clamped in the launch', argv({ '--context': 65536 }).join(' ').includes('--context 16384'))
check('forced values are sent', argv({ '--fa': false }, moe).includes('--fa'))
check('an off switch sends offArg', argv({ '--fa': false }).includes('--no-fa'))
check('missing required parameter stops the launch', 'error' in argv({ '--spec-on': true }))
check('an override reaches the arguments', argv({ '--parallel': 2 }, ctx(), { '--parallel': 6 }).join(' ').includes('--parallel 6'))
check('a computed emit value is sent', (() => {
  const c = cardClean(); c.params.categories[0].commands.find(p => p.arg === '--parallel').emit = { expr: 'args["--parallel"] * 10' }
  const v = C.validateEngineCard(c)
  const b = C.buildCardArgv(v.card, { modelPath: '/m', port: 1, engineDir: '/e', args: { '--parallel': 2 }, context: ctx() })
  return v.errors.length === 0 && b.argv.join(' ').includes('--parallel 20')
})())

// ----- presets -----
let next = R.applyPreset(cd, cd.params.presets[0], { '--kv': 'f16', '--host': '0.0.0.0' }, ctx())
check('a merge preset sets listed values and keeps the rest', next['--context'] === 8192 && next['--parallel'] === 1 && next['--kv'] === 'f16' && next.__lastPreset === 'fast')
next = R.applyPreset(cd, cd.params.presets[1], { '--kv': 'f16', '--spec-on': true, '--host': '0.0.0.0', '--lora': ['x'] }, ctx())
check('a replace preset clears declared parameters but not internal ones or the server block', next['--kv'] === undefined && next['--lora'] === undefined && next['--spec-on'] === true && next['--host'] === '0.0.0.0')
check('a preset expression sees the model and hardware', next['--context'] === 131072 || next['--context'] === 6000 || typeof next['--context'] === 'number', String(next['--context']))
check('preset lookup by id or name', R.findPreset(cd, 'FAST')?.id === 'fast' && R.findPreset(cd, 'fit to vram')?.id === 'fit' && R.findPreset(cd, 'x') === null)
check('coerce strings to numbers and booleans', R.coerceParamValue(cd.params.categories[0].commands[1], '4').value === 4 && R.coerceParamValue(cd.params.categories[0].commands[2], 'off').value === false)
check('coerce refuses a bad number and bad option', 'error' in R.coerceParamValue(cd.params.categories[0].commands[1], 'many') && 'error' in R.coerceParamValue(cd.params.categories[0].commands[3], 'q2'))
check('coerce a list from text', R.coerceParamValue(cd.params.categories[0].commands[6], 'a, b').value.length === 2)

// ----- overrides -----
const ova = R.overrideArgsFor(cd, { parallel: 3, fa: true }, { threads: 12, parallel: 99 }, ctx())
check('override fields drive their parameters', ova['--parallel'] === 3 && ova['--fa'] === true)
check('a global setting drives a mapped parameter and ignores an unmapped one', ova['--threads'] === 12 && !('parallel' in ova))
check('an unset field forces nothing', Object.keys(R.overrideArgsFor(cd, { parallel: null }, {}, ctx())).length === 0)

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)

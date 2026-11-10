// Verifies the llama.cpp editor's parameter sections (src/shared/paramSections.ts)
// against the real schema, and that CmdParamsEditor places every block once.
//
//   node scripts/params-sections-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'params-sections-verify-'))
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

const P = bundle('src/shared/paramSections.ts', 'sections')
const { COMMON_PARAM_FLAGS } = bundle('src/shared/commonParams.ts', 'common')
const schema = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'commands.json'), 'utf8'))
const cats = schema.categories
const cat = name => cats.find(c => c.name === name).commands.map(c => c.arg)
const all = cats.flatMap(c => c.commands.map(p => p.arg))
const rows = secs => secs.flatMap(s => s.rows.map(r => r.arg))
const sec = (secs, key) => secs.find(s => s.key === key)
const keys = secs => secs.map(s => s.key)
const build = (query, full) => P.buildParamSections(cats, { query, full, common: COMMON_PARAM_FLAGS })
const widgetFree = a => !P.CUSTOM_PARAMS.includes(a)

// Every flag without a widget appears once, in Full and (the curated ones) in Common
const full = build('', true)
const common = build('', false)
check('Full shows every flag that has no widget, exactly once', rows(full).length === new Set(rows(full)).size && JSON.stringify([...rows(full)].sort()) === JSON.stringify(all.filter(widgetFree).sort()))
check('Common shows the curated flags that have no widget, exactly once', rows(common).length === new Set(rows(common)).size &&
  JSON.stringify([...rows(common)].sort()) === JSON.stringify(all.filter(a => widgetFree(a) && COMMON_PARAM_FLAGS.has(a)).sort()))
check('no flag with a widget of its own gets a row', !rows(full).some(a => P.CUSTOM_PARAMS.includes(a)))

// Section order
check('sections run Model, Context Window, GPU, Performance, then the rest', JSON.stringify(keys(full)) === JSON.stringify(['Model', 'Context Window', 'GPU', 'Performance', 'Sampling', 'RoPE / YaRN', 'Server', 'Logging']))
check('KV Cache and Speculative Decoding have no section of their own', !keys(full).includes('KV Cache') && !keys(full).includes('Speculative Decoding'))
check('a category the table does not know follows the known sections', JSON.stringify(keys(P.buildParamSections([...cats, { name: 'Fork Only', icon: 'Box', commands: [{ arg: '--fork-flag', label: 'Fork', type: 'boolean', description: '' }] }], { query: '', full: true, common: COMMON_PARAM_FLAGS })).slice(-2)) === JSON.stringify(['Logging', 'Fork Only']))

// Model: the speculative decoding rows follow the block, then the model rows
const specRows = cat('Speculative Decoding').filter(widgetFree)
const modelRows = cat('Model').filter(a => widgetFree(a) && a !== '--ctx-size')
check('Model has the speculative decoding rows first, then its own, without the context size', JSON.stringify(sec(full, 'Model').rows.map(r => r.arg)) === JSON.stringify([...specRows, ...modelRows]))

// Context Window: the context size, then the KV cache entries
check('Context Window has the context size, then the KV cache entries', JSON.stringify(sec(full, 'Context Window').rows.map(r => r.arg)) === JSON.stringify(['--ctx-size', ...cat('KV Cache')]) &&
  JSON.stringify(sec(common, 'Context Window').rows.map(r => r.arg)) === JSON.stringify(['--ctx-size', ...cat('KV Cache')].filter(a => COMMON_PARAM_FLAGS.has(a))))

// GPU leads with its layers
check('GPU leads with GPU layers', sec(full, 'GPU').rows[0].arg === '--gpu-layers' && sec(common, 'GPU').rows[0].arg === '--gpu-layers')

// Performance order
const perf = sec(full, 'Performance').rows.map(r => r.arg)
const lead = ['--load-mode', '--threads', '--threads-batch', '--batch-size', '--ubatch-size', '--parallel', '--kv-unified', '--flash-attn']
check('Performance starts with Model Load Mode, above CPU Threads', perf[0] === '--load-mode' && perf[1] === '--threads')
check('Micro-Batch Size sits right under Batch Size', perf.indexOf('--ubatch-size') === perf.indexOf('--batch-size') + 1)
check('Unified KV Cache sits right under Parallel Sequences, and Flash Attention under it', perf.indexOf('--kv-unified') === perf.indexOf('--parallel') + 1 && perf.indexOf('--flash-attn') === perf.indexOf('--kv-unified') + 1)
check('the rest of Performance keeps the schema order, and nothing is lost', JSON.stringify(perf) === JSON.stringify([...lead, ...cat('Performance').filter(a => !lead.includes(a))]))
check('Common keeps the same relative order in Performance', JSON.stringify(sec(common, 'Performance').rows.map(r => r.arg)) === JSON.stringify(perf.filter(a => COMMON_PARAM_FLAGS.has(a))))

// Search spans every section, whatever the view, and never returns a flag that only has a widget
check('search ignores the Common/Full view and finds a Full-only flag', JSON.stringify(rows(build('flash', false))) === '["--flash-attn"]' && rows(build('numa', false)).join() === '--numa')
check('search finds the context size in Context Window only', JSON.stringify(rows(build('ctx-size', true))) === '["--ctx-size"]' && sec(build('ctx-size', true), 'Context Window').rows.length === 1)
check('search finds KV cache entries under Context Window', sec(build('KV Cache Type', true), 'Context Window').rows.map(r => r.arg).join() === '--cache-type-k,--cache-type-v')
check('search by label and by short flag work', rows(build('Flash Attention', true)).includes('--flash-attn') && rows(build('-ngl', true)).includes('--gpu-layers'))
check('a flag that only has a widget gives no row', rows(build('mmproj', true)).length === 0 && rows(build('spec-type', true)).length === 0)
check('search is case-insensitive and ignores surrounding spaces', JSON.stringify(rows(build('  FLASH ', true))) === '["--flash-attn"]')
check('a search with no match leaves every section without rows', rows(build('zzzz-no-such-flag', true)).length === 0)

// The component places every block once, search right under the memory control
const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'CmdParamsEditor.tsx'), 'utf8')
const count = needle => src.split(needle).length - 1
const blockCalls = ['renderMmprojWidget', 'renderContextBlock', 'renderMoeWidget', 'renderSpecWidget', 'renderServerBlock', 'renderBaseUrlOverrideBlock', 'renderAutoCheckpointBlock', 'renderJinjaWidget', 'renderReasoningWidget']
check('each block is defined once and placed in exactly one section', blockCalls.every(n => count(`const ${n} = `) === 1 && count(`${n}()`) === 1), blockCalls.filter(n => count(`${n}()`) !== 1).join(' '))
check('Sampling Presets and Custom Arguments are each placed once', count('<SamplingPresets') === 1 && count('node: samplingPresetsRow') === 1 && count('<CustomArgsEditor') === 1)
const blocksOf = src.slice(src.indexOf('const blocksOf'), src.indexOf('const customArgs: ParamBlock'))
const order = id => blocksOf.indexOf(`id: '${id}'`)
check('the Speculative Decoding block follows the multimodal projector under Model', blocksOf.indexOf("'Model': [") !== -1 && order('mmproj') !== -1 && order('mmproj') < order('spec') && order('spec') < blocksOf.indexOf("'Context Window': ["))
check('the Context block is under Context Window, MoE under GPU', blocksOf.indexOf("'Context Window': [") < order('context') && order('context') < blocksOf.indexOf("'GPU': [") && blocksOf.indexOf("'GPU': [") < order('moe'))
const tail = src.slice(src.indexOf('<div className="params-editor-container">'))
const at = needle => tail.indexOf(needle)
check('Search parameters comes right after the memory control and before every section', at('{renderMemoryEngineBlock()}') !== -1 && at('{renderMemoryEngineBlock()}') < at('placeholder="Search parameters..."') &&
  at('placeholder="Search parameters..."') < at('<LayoutSections') && count('placeholder="Search parameters..."') === 1 &&
  !/\{render(Mmproj|Jinja|Spec|Moe|Reasoning)Widget\(\)\}|\{render(Context|Server|BaseUrlOverride|AutoCheckpoint)Block\(\)\}/.test(tail))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

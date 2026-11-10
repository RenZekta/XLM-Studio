// Verifies the pure arrangement and preset helpers behind Edit Layout of the parameter lists, and
// that both parameter editors render through the shared layout component.
//
//   node scripts/param-layout-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'param-layout-verify-'))
const out = path.join(tmp, 'layout.js')
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/paramLayout.ts')], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
const L = require(out)

let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ----- Arranging over what the editor offers -----
check('no saved order keeps the default', eq(L.arrangeOrder(['a', 'b', 'c'], undefined), ['a', 'b', 'c']))
check('saved order wins', eq(L.arrangeOrder(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b']))
check('new ids follow the saved ones', eq(L.arrangeOrder(['a', 'b', 'c', 'd'], ['c', 'a']), ['c', 'a', 'b', 'd']))
check('vanished ids are dropped', eq(L.arrangeOrder(['a', 'b'], ['x', 'b', 'a']), ['b', 'a']))
check('a repeated id appears once', eq(L.arrangeOrder(['a', 'b'], ['b', 'b', 'a']), ['b', 'a']))

const defaults = { S1: ['p', 'q'], S2: ['r'] }
check('placement without a layout is the default', eq(L.arrangePlacement(defaults, undefined), defaults))
check('a row moved to another group stays there', eq(L.arrangePlacement(defaults, { S2: ['q', 'r'], S1: ['p'] }), { S1: ['p'], S2: ['q', 'r'] }))
check('a row in a vanished group returns home', eq(L.arrangePlacement(defaults, { GONE: ['p'], S1: ['q'] }), { S1: ['q', 'p'], S2: ['r'] }))
check('a row saved twice is placed once', eq(L.arrangePlacement(defaults, { S1: ['p'], S2: ['p', 'r'] }), { S1: ['p', 'q'], S2: ['r'] }))

// ----- Moves -----
check('move down within a list', eq(L.movePlacement({ A: ['1', '2', '3'] }, '1', 'A', 3), { A: ['2', '3', '1'] }))
check('move up within a list', eq(L.movePlacement({ A: ['1', '2', '3'] }, '3', 'A', 0), { A: ['3', '1', '2'] }))
check('slot beside itself changes nothing', eq(L.movePlacement({ A: ['1', '2', '3'] }, '2', 'A', 2), { A: ['1', '2', '3'] }))
check('move across lists', eq(L.movePlacement({ A: ['1', '2'], B: ['3'] }, '1', 'B', 1), { A: ['2'], B: ['3', '1'] }))
check('move into an empty list', eq(L.movePlacement({ A: ['1'], B: [] }, '1', 'B', 0), { A: [], B: ['1'] }))
check('moveOrder', eq(L.moveOrder(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']))

// ----- Stored layout shape -----
check('empty layout is empty', L.isEmptyLayout(L.EMPTY_LAYOUT))
check('garbage is ignored', L.parseParamLayout('{"sections":1}') === null && L.parseParamLayout('nope') === null && L.parseParamLayout(null) === null)
check('an empty stored layout is ignored', L.parseParamLayout('{"sections":[],"blocks":{},"rows":{}}') === null)
check('a valid stored layout is read', L.parseParamLayout('{"sections":["a"],"blocks":{},"rows":{}}')?.sections[0] === 'a')

// ----- Presets of an engine -----
const lay = (...sections) => ({ sections, blocks: {}, rows: {} })
let lib = L.EMPTY_LIBRARY
check('Default exists per engine', L.layoutPresetsOf(lib, 'llama.cpp')[0].id === 'default:llama.cpp' && L.layoutPresetsOf(lib, 'strata')[0].id === 'default:strata')
check('nothing active means the Default', L.activeLayoutPreset(lib, 'strata').id === 'default:strata')
check('Default is the editor order', L.isEmptyLayout(L.defaultLayoutPreset('strata').layout))

lib = L.addLayoutPreset(lib, { id: 'u1', name: 'Mine', engine: 'llama.cpp', layout: lay('b', 'a') })
check('presets belong to their engine', L.layoutPresetsOf(lib, 'llama.cpp').length === 2 && L.layoutPresetsOf(lib, 'strata').length === 1)
lib = L.setActiveLayout(lib, 'llama.cpp', 'u1')
check('active preset is found', L.activeLayoutPreset(lib, 'llama.cpp').id === 'u1')
check('the other engine is unaffected', L.activeLayoutPreset(lib, 'strata').id === 'default:strata')
check('shown layout outside editing is the active preset', eq(L.shownLayout(lib, 'llama.cpp', null), lay('b', 'a')))
check('shown layout while editing is the draft', eq(L.shownLayout(lib, 'llama.cpp', { presetId: 'u1', draft: lay('c') }), lay('c')))
check('without a draft it is the preset being edited', eq(L.shownLayout(lib, 'llama.cpp', { presetId: 'default:llama.cpp', draft: null }), L.EMPTY_LAYOUT))

check('rename keeps the layout', (() => {
  const next = L.updateLayoutPreset(lib, 'u1', { name: 'Renamed' })
  return next.presets[0].name === 'Renamed' && eq(next.presets[0].layout, lay('b', 'a'))
})())
check('the Default cannot be updated', L.updateLayoutPreset(lib, 'default:llama.cpp', { name: 'X' }) === lib)
check('the Default cannot be deleted', L.deleteLayoutPreset(lib, 'default:llama.cpp') === lib)
check('choosing the Default clears the active entry', L.setActiveLayout(lib, 'llama.cpp', 'default:llama.cpp').active['llama.cpp'] === undefined)
const dropped = L.deleteLayoutPreset(lib, 'u1')
check('deleting a preset removes it and its active mark', dropped.presets.length === 0 && dropped.active['llama.cpp'] === undefined)
check('an unknown preset id falls back to the Default', L.findLayoutPreset(lib, 'llama.cpp', 'nope').id === 'default:llama.cpp')

// ----- Stored library -----
const stored = JSON.stringify(lib)
check('the library round-trips', eq(L.parseLayoutLibrary(stored, null), lib))
check('Default ids in storage are dropped', L.parseLayoutLibrary(JSON.stringify({ presets: [{ id: 'default:strata', name: 'D', engine: 'strata', layout: lay('a') }], active: {} }), null).presets.length === 0)
check('an unknown engine is dropped', L.parseLayoutLibrary(JSON.stringify({ presets: [{ id: 'x', name: 'X', engine: 'nope', layout: lay('a') }], active: {} }), null).presets.length === 0)
check('a duplicate id is read once', L.parseLayoutLibrary(JSON.stringify({ presets: [lib.presets[0], lib.presets[0]], active: {} }), null).presets.length === 1)
check('an active mark of another engine is dropped', Object.keys(L.parseLayoutLibrary(JSON.stringify({ presets: lib.presets, active: { strata: 'u1' } }), null).active).length === 0)
check('garbage storage gives an empty library', eq(L.parseLayoutLibrary('{{', null), L.EMPTY_LIBRARY))
const migrated = L.parseLayoutLibrary(null, '{"sections":["a"],"blocks":{},"rows":{}}')
check('the earlier single layout becomes a llama.cpp preset in use',
  migrated.presets.length === 1 && migrated.presets[0].engine === 'llama.cpp' && migrated.active['llama.cpp'] === migrated.presets[0].id)

// ----- Wiring -----
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const sections = read('src/renderer/src/components/LayoutSections.tsx')
check('the shared renderer arranges groups, blocks and rows', /arrangeOrder\(/.test(sections) && /arrangePlacement\(/.test(sections) && sections.includes('data-layout-kind="section"') && sections.includes('data-layout-kind="block"') && sections.includes('data-layout-kind="row"'))
check('llama.cpp editor renders through it', /<LayoutSections/.test(read('src/renderer/src/components/CmdParamsEditor.tsx')))
check('Strata editor renders through it', /<LayoutSections/.test(read('src/renderer/src/components/EngineParamsEditor.tsx')))

fs.rmSync(tmp, { recursive: true, force: true })
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')

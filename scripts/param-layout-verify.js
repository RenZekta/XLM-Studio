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
// A slot counts the items of the list left once the moved ones are out.
check('move down within a list', eq(L.movePlacement({ A: ['1', '2', '3'] }, ['1'], 'A', 2), { A: ['2', '3', '1'] }))
check('move up within a list', eq(L.movePlacement({ A: ['1', '2', '3'] }, ['3'], 'A', 0), { A: ['3', '1', '2'] }))
check('the slot it came from changes nothing', eq(L.movePlacement({ A: ['1', '2', '3'] }, ['2'], 'A', 1), { A: ['1', '2', '3'] }))
check('move across lists', eq(L.movePlacement({ A: ['1', '2'], B: ['3'] }, ['1'], 'B', 1), { A: ['2'], B: ['3', '1'] }))
check('move into an empty list', eq(L.movePlacement({ A: ['1'], B: [] }, ['1'], 'B', 0), { A: [], B: ['1'] }))
check('several ids keep their order', eq(L.movePlacement({ A: ['1', '2', '3', '4'] }, ['4', '2'], 'A', 1), { A: ['1', '4', '2', '3'] }))
check('moving nothing returns the placement', (() => { const p = { A: ['1'] }; return L.movePlacement(p, [], 'B', 0) === p })())
check('a slot skips items that are not shown', eq(L.movePlacement({ A: ['1', 'h', '2'] }, ['3'], 'A', 1, id => id !== 'h'), { A: ['1', 'h', '3', '2'] }))
check('a slot past the shown items goes last', eq(L.movePlacement({ A: ['1', 'h'] }, ['3'], 'A', 1, id => id !== 'h'), { A: ['1', 'h', '3'] }))
check('moveOrder', eq(L.moveOrder(['a', 'b', 'c'], ['c'], 0), ['c', 'a', 'b']))
check('moveOrder with several', eq(L.moveOrder(['a', 'b', 'c', 'd'], ['a', 'c'], 2), ['b', 'd', 'a', 'c']))

// ----- Headers moved on their own -----
const hb = { A: ['b1'], B: [], C: ['b2'] }
const hr = { A: ['r1', 'r2'], B: ['r3'], C: [] }
const shownAll = () => true
check('flat order is header, blocks, rows per group', eq(L.flattenSections(['A', 'B'], hb, hr).map(e => e.id), ['A', 'b1', 'r1', 'r2', 'B', 'r3']))
{
  // Moving B between r1 and r2 splits A: r2 now belongs to B along with r3.
  const res = L.moveHeaders(['A', 'B', 'C'], hb, hr, ['B'], 3, shownAll)
  check('a header dropped inside a group splits it', eq(res.sections, ['A', 'B', 'C']) && eq(res.rows, { A: ['r1'], B: ['r2', 'r3'], C: [] }) && eq(res.blocks, { A: ['b1'], B: [], C: ['b2'] }))
}
{
  const res = L.moveHeaders(['A', 'B', 'C'], hb, hr, ['B'], 0, shownAll)
  check('a header moved to the top takes the first slot', eq(res.sections, ['B', 'A', 'C']) && eq(res.rows.B, []) && eq(res.rows.A, ['r1', 'r2', 'r3']))
}
{
  const res = L.moveHeaders(['A', 'B', 'C'], hb, hr, ['A'], 2, shownAll)
  check('the first header moved down is joined by what was ahead of it', eq(res.sections, ['A', 'B', 'C']) && eq(res.blocks.A, ['b1']) && eq(res.rows.A, ['r1', 'r2']))
}
{
  const res = L.moveHeaders(['A', 'B', 'C'], hb, hr, ['A', 'C'], 99, shownAll)
  // What was ahead of the remaining first header joins it.
  check('several headers move together to the end', eq(res.sections, ['B', 'A', 'C']) && eq(res.rows.B, ['r1', 'r2', 'r3']) && eq(res.blocks.B, ['b1', 'b2']) && eq(res.rows.A, []) && eq(res.rows.C, []))
}
{
  // r2 is not shown: slot 3 is the one before r3, so r2 stays in A.
  const res = L.moveHeaders(['A', 'B'], { A: ['b1'], B: [] }, { A: ['r1', 'r2'], B: ['r3'] }, ['B'], 3, e => e.id !== 'r2')
  check('a header slot skips entries that are not shown', eq(res.rows, { A: ['r1', 'r2'], B: ['r3'] }) && eq(res.sections, ['A', 'B']))
}

// ----- Groups -----
{
  const base = { sections: ['a', 'b'], blocks: {}, rows: { a: ['x'] } }
  const added = L.insertGroup(base, 'custom:1', { title: 'New Group', icon: 'Layers' }, 'b')
  check('a group is inserted before another', eq(added.sections, ['a', 'custom:1', 'b']) && added.groups['custom:1'].title === 'New Group')
  check('a group with no target goes last', eq(L.insertGroup(base, 'custom:1', { title: 'N' }, null).sections, ['a', 'b', 'custom:1']))
  check('custom keys are recognised', L.isCustomGroupKey(L.newGroupKey()) && !L.isCustomGroupKey('Model'))
  const renamed = L.setGroupMeta(base, 'a', { title: 'Mine', icon: 'Cpu' })
  check('a title and icon are stored per group', renamed.groups.a.title === 'Mine' && renamed.groups.a.icon === 'Cpu')
  const reset = L.setGroupMeta(renamed, 'a', { title: '', icon: '' })
  check('clearing both drops the entry of an editor group', reset.groups.a === undefined)
  check('a custom group keeps its entry', L.setGroupMeta(added, 'custom:1', { icon: '' }).groups['custom:1'].title === 'New Group')
  const removed = L.removeGroup(L.insertGroup({ ...base, rows: { a: ['x'], 'custom:1': ['y'] } }, 'custom:1', { title: 'N' }, null), 'custom:1')
  check('removing a group drops its lists and entry', !removed.sections.includes('custom:1') && !('custom:1' in removed.rows) && !('custom:1' in removed.groups))
  check('a layout with only group titles is not empty', !L.isEmptyLayout({ sections: [], blocks: {}, rows: {}, groups: { a: { title: 'x' } } }))
  check('stored group metadata is read', L.parseParamLayout('{"sections":[],"blocks":{},"rows":{},"groups":{"a":{"title":"x"}}}')?.groups.a.title === 'x')
  check('malformed group metadata is ignored', L.parseParamLayout('{"sections":["a"],"blocks":{},"rows":{},"groups":{"a":{"title":3}}}') === null)
}

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
check('the shared renderer arranges groups, blocks and rows', /arrangeOrder\(/.test(sections) && /arrangePlacement\(/.test(sections) && sections.includes('data-layout-section=') && sections.includes('data-layout-kind="header"') && sections.includes('data-layout-kind="block"') && sections.includes('data-layout-kind="row"'))
check('llama.cpp editor renders through it', /<LayoutSections/.test(read('src/renderer/src/components/CmdParamsEditor.tsx')))
check('Strata editor renders through it', /<LayoutSections/.test(read('src/renderer/src/components/EngineParamsEditor.tsx')))

fs.rmSync(tmp, { recursive: true, force: true })
if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1) }
console.log('\nall checks passed')

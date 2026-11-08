// Verifies Automatic YaRN scaling control (src/shared/yarnAuto.ts): the flags it writes while it is
// on, and that they are cleared when it is off or the context is back at the native size.
//
//   node scripts/yarn-auto-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yarn-auto-verify-'))
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/yarnAuto.ts')], bundle: true, platform: 'node', outfile: path.join(tmp, 'y.js'), logLevel: 'error' })
const { syncYarnAuto, YARN_MANAGED_KEY } = require(path.join(tmp, 'y.js'))

let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}

const NATIVE = 262144
const FLAGS = ['--rope-scaling', '--rope-scale', '--yarn-orig-ctx']
const has = (a, f) => Object.prototype.hasOwnProperty.call(a, f)
const noYarn = a => FLAGS.every(f => !has(a, f))
const on = (args, target, extra = {}) => syncYarnAuto(args, { active: true, target, native: NATIVE, origCtxFlag: true, ...extra }) ?? args
const off = args => syncYarnAuto(args, { active: false, target: 0, native: NATIVE, origCtxFlag: true }) ?? args
const base = { '--ctx-size': 262144, '--threads': 8, __yarnAutoScale: true }

// On, past the native context
const over = on(base, 524288)
check('past the native context it writes yarn, the scale and the original context', over['--rope-scaling'] === 'yarn' && over['--rope-scale'] === 2 && over['--yarn-orig-ctx'] === NATIVE && over[YARN_MANAGED_KEY] === true)
check('the scale is rounded to two decimals', on(base, 400000)['--rope-scale'] === 1.53)

// Back at the native size with the control still on: nothing in the command
const back = on(over, NATIVE)
check('back at the native context the three flags are gone while the control is on', noYarn(back) && back[YARN_MANAGED_KEY] === true)
check('below the native context there are none either', noYarn(on(over, 65536)))
check('a context barely past native that rounds to scale 1 writes none', noYarn(on(base, NATIVE + 100)))

// Off
check('turning it off after an overclock clears the flags and the marker', noYarn(off(over)) && !has(off(over), YARN_MANAGED_KEY))
check('on, overclock, back to native, off leaves no yarn flags', noYarn(off(back)) && !has(off(back), YARN_MANAGED_KEY))
check('turning it off keeps every other arg', (() => { const r = off(over); return r['--ctx-size'] === 262144 && r['--threads'] === 8 && r.__yarnAutoScale === true })())

// Flags the control did not write
const manual = { '--rope-scaling': 'yarn', '--rope-scale': 4, '--yarn-orig-ctx': 32768, '--ctx-size': 131072 }
check('with the control off and never on, hand-set flags are left alone', syncYarnAuto(manual, { active: false, target: 0, native: NATIVE, origCtxFlag: true }) === null)
check('a template saved before the marker existed is cleaned once the control runs on it', noYarn(on({ ...base, '--rope-scaling': 'yarn', '--rope-scale': 1, '--yarn-orig-ctx': NATIVE }, NATIVE)))

// Loops and unknowns
check('a second pass changes nothing, so an effect cannot loop', syncYarnAuto(over, { active: true, target: 524288, native: NATIVE, origCtxFlag: true }) === null && syncYarnAuto(off(over), { active: false, target: 0, native: NATIVE, origCtxFlag: true }) === null)
check('with the native context unknown nothing is written, but turning it off still clears', syncYarnAuto(base, { active: true, target: 524288, native: 0, origCtxFlag: true }) === null && noYarn(syncYarnAuto(over, { active: false, target: 0, native: 0, origCtxFlag: true })))
check('the input is not modified', (() => { const a = Object.freeze({ ...over }); try { syncYarnAuto(a, { active: false, target: 0, native: NATIVE, origCtxFlag: true }); return true } catch { return false } })())

// Strata has no --yarn-orig-ctx
const sBase = { '--context': 262144, __yarnAutoScale: true }
const sOver = syncYarnAuto(sBase, { active: true, target: 524288, native: NATIVE, origCtxFlag: false })
check('Strata gets yarn and the scale but no original context', sOver['--rope-scaling'] === 'yarn' && sOver['--rope-scale'] === 2 && !has(sOver, '--yarn-orig-ctx'))
check('Strata clears both on switching off and back at native', !has(syncYarnAuto(sOver, { active: false, target: 0, native: NATIVE, origCtxFlag: false }), '--rope-scaling') &&
  !has(syncYarnAuto(sOver, { active: true, target: NATIVE, native: NATIVE, origCtxFlag: false }), '--rope-scale'))

// Both editors and the MCP edit use it, and the old inline writes are gone
const read = f => fs.readFileSync(path.join(root, f), 'utf8')
const llama = read('src/renderer/src/components/CmdParamsEditor.tsx')
const strata = read('src/renderer/src/components/EngineParamsEditor.tsx')
const mcp = read('src/main/mcpControl.ts')
check('the llama.cpp editor, the Strata editor and MCP all go through syncYarnAuto', /syncYarnAuto\(argsRef\.current/.test(llama) && /syncYarnAuto\(cur/.test(strata) && /syncYarnAuto\(newArgs/.test(mcp))
check('no editor writes the YaRN flags itself any more', !/'--rope-scaling': 'yarn'/.test(llama) && !/next\['--rope-scaling'\] = 'yarn'/.test(strata))
check('the effects run whether or not the control is on, so switching it off clears', !/if \(disabled \|\| !effectiveYarnAutoScale\) return/.test(llama) && !/if \(disabled \|\| !yarnAuto\) return/.test(strata))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

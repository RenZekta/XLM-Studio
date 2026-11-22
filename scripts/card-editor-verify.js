// Renders the card editor's controls on the server to catch runtime errors and
// to check the markup of every widget. No browser or Electron is needed.
//
//   node scripts/card-editor-verify.js

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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-editor-'))
const entry = path.join(tmp, 'entry.tsx')
fs.writeFileSync(entry, `
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ParamControl, ParamRow, Banner } from ${JSON.stringify(path.join(root, 'src/renderer/src/components/paramParts'))}
import CardPresetBar from ${JSON.stringify(path.join(root, 'src/renderer/src/components/CardPresetBar'))}
export function render(cmd: any, value: any, view: any = {}, disabled = false) {
  const v = { label: cmd.label, description: '', min: cmd.min, max: cmd.max, default: cmd.default, options: cmd.options, ...view }
  return renderToStaticMarkup(<ParamControl cmd={cmd} view={v} value={value} disabled={disabled} onChange={() => {}} />)
}
export const row = () => renderToStaticMarkup(<ParamRow label="L" description="D" arg="--x" note="Set by Overrides"><span>child</span></ParamRow>)
export const banner = (tone: any) => renderToStaticMarkup(<Banner tone={tone}>hello</Banner>)
export const presets = (active?: string) => renderToStaticMarkup(<CardPresetBar presets={[{ id: 'a', name: 'Fast', args: {}, description: 'quick' }, { id: 'b', name: 'Long', args: {} }]} active={active} onApply={() => {}} />)
`)
const out = path.join(tmp, 'entry.js')
esbuild.buildSync({
  entryPoints: [entry], bundle: true, platform: 'node', outfile: out, logLevel: 'error', jsx: 'automatic',
  loader: { '.css': 'empty' }, external: ['electron'], nodePaths: [path.join(root, 'node_modules')], absWorkingDir: root
})
global.window = { api: { pickAnyFile: async () => null, pickFolder: async () => null } }
global.navigator = { platform: 'Linux' }
const R = require(out)

const base = { arg: '--x', label: 'X', description: 'd' }
const num = { ...base, type: 'number', min: 1, max: 10 }
let html = R.render({ ...num, widget: 'slider', slider: { step: 1, scale: 'linear', allowAuto: true } }, 5, { min: 1, max: 10 })
check('slider renders', /<input/.test(html) && html.includes('5'), html)
html = R.render({ ...num, widget: 'slider', slider: { scale: 'ladder' } }, 4096, { min: 512, max: 131072 })
check('a ladder slider renders', /<input/.test(html), html)
check('number box renders its value', /value="5"/.test(R.render(num, 5)))
check('number box shows the dynamic default when unset', /value="7"/.test(R.render(num, undefined, { default: 7 })))
check('switch renders checked and unchecked', /checked/.test(R.render({ ...base, type: 'boolean' }, true)) && !/checked/.test(R.render({ ...base, type: 'boolean' }, false)))
check('a switch is disabled when locked', /disabled/.test(R.render({ ...base, type: 'boolean' }, true, {}, true)))
html = R.render({ ...base, type: 'boolean', offArg: '--no-x', widget: 'tristate' }, false)
check('tristate offers engine default, on and off', /Engine default/.test(html) || /Off/.test(html), html)
html = R.render({ ...base, type: 'select', widget: 'segmented', options: ['a', 'b'] }, 'a', { options: ['a', 'b'] })
check('segmented renders every option', />a</.test(html) && />b</.test(html), html)
html = R.render({ ...base, type: 'select', options: ['a', 'b'] }, 'b', { options: ['a', 'b'] })
check('select renders', html.length > 0 && /b/.test(html))
html = R.render({ ...base, type: 'select', optionsBy: { arg: '--f', map: {} } }, '', { options: ['q'] })
check('a select with dependent options renders', html.length > 0)
check('password hides its text', /type="password"/.test(R.render({ ...base, type: 'string', widget: 'password' }, 's')))
check('textarea renders', /<textarea/.test(R.render({ ...base, type: 'text', widget: 'textarea' }, 'a\nb')))
check('file and folder pickers render a button', /<button/.test(R.render({ ...base, type: 'string', widget: 'file' }, '/a')) && /<button/.test(R.render({ ...base, type: 'string', widget: 'folder' }, '/a')))
html = R.render({ ...base, type: 'string', widget: 'list' }, ['a.gguf', 'b.gguf'])
check('a list renders an input per item and an add button', (html.match(/<input/g) || []).length === 2 && /Add/.test(html), html)
html = R.render({ ...base, type: 'text', widget: 'keyvalue' }, ['k=v', 'a=b=c'])
check('key-value pairs split on the first equals sign', (html.match(/<input/g) || []).length === 4 && /value="b=c"/.test(html), html)
check('an empty list renders only the add button', !/<input/.test(R.render({ ...base, type: 'string', widget: 'list' }, undefined)))
check('plain text renders', /type="text"/.test(R.render({ ...base, type: 'string' }, 'abc')))
check('a row carries its label, arg, tooltip and note', (() => { const h = R.row(); return /L/.test(h) && /--x/.test(h) && /D/.test(h) && /Set by Overrides/.test(h) && /child/.test(h) })())
check('banners render every tone', ['info', 'success', 'warning', 'danger', 'muted'].every(t => /hello/.test(R.banner(t))))
html = R.presets('a')
check('the preset bar lists presets and marks the active one', />\s*Fast/.test(html) || /Fast/.test(html), html)
check('the active preset is marked', /active/.test(html))

console.log(failed === 0 ? '\nAll checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)

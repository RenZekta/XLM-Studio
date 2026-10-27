// Verifies the pure folder helpers behind the Templates page: names for new
// folders and copies, folder paths, subtrees, and shift-click ranges.
//
//   node scripts/template-folders-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'template-folders-verify-'))
const out = path.join(tmp, 'folders.js')
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/templateFolders.ts')], bundle: true, platform: 'node', outfile: out, logLevel: 'error' })
const F = require(out)

let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

check('first folder is "Folder"', F.nextFolderName([]) === 'Folder')
check('then "Folder 1"', F.nextFolderName(['Folder']) === 'Folder 1')
check('then "Folder 2"', F.nextFolderName(['Folder', 'Folder 1']) === 'Folder 2')
check('fills the lowest gap', F.nextFolderName(['Folder', 'Folder 2']) === 'Folder 1')
check('ignores case', F.nextFolderName(['folder']) === 'Folder 1')
check('other names do not count', F.nextFolderName(['Models', 'Work']) === 'Folder')

check('copy name', F.copyName('Qwen', ['Qwen']) === 'Qwen (Copy)')
check('copy of a copy stays one level', F.copyName('Qwen (Copy)', ['Qwen', 'Qwen (Copy)']) === 'Qwen (Copy 2)')
check('copy numbers climb', F.copyName('Qwen', ['Qwen', 'Qwen (Copy)', 'Qwen (Copy 2)']) === 'Qwen (Copy 3)')

const folders = [
  { id: 'a', name: 'A', parentId: null },
  { id: 'b', name: 'B', parentId: 'a' },
  { id: 'c', name: 'C', parentId: 'b' },
  { id: 'd', name: 'D', parentId: null }
]
check('path from top to folder', eq(F.folderPath(folders, 'c').map(f => f.name), ['A', 'B', 'C']))
check('top level has an empty path', F.folderPath(folders, null).length === 0)
check('unknown folder has an empty path', F.folderPath(folders, 'zzz').length === 0)
check('a parent loop does not hang', F.folderPath([{ id: 'x', name: 'X', parentId: 'y' }, { id: 'y', name: 'Y', parentId: 'x' }], 'x').length === 2)
check('subtree includes itself and descendants', eq([...F.folderSubtree(folders, 'a')].sort(), ['a', 'b', 'c']))
check('subtree of a leaf is itself', eq([...F.folderSubtree(folders, 'd')], ['d']))
check('siblings by parent', eq(F.siblingFolders(folders, null).map(f => f.id), ['a', 'd']) && eq(F.siblingFolders(folders, 'a').map(f => f.id), ['b']))

const ids = new Set(['a', 'b'])
check('template in an existing folder', F.folderOfTemplate({ folderId: 'a' }, ids) === 'a')
check('missing folder reads as top level', F.folderOfTemplate({ folderId: 'gone' }, ids) === null)
check('no folder reads as top level', F.folderOfTemplate({}, ids) === null && F.folderOfTemplate({ folderId: null }, ids) === null)

const order = ['f1', 'f2', 't1', 't2', 't3', 't4']
check('range forward', eq(F.idRange(order, 't1', 't3'), ['t1', 't2', 't3']))
check('range backward', eq(F.idRange(order, 't3', 't1'), ['t1', 't2', 't3']))
check('range spans folders and templates', eq(F.idRange(order, 'f2', 't2'), ['f2', 't1', 't2']))
check('range with unknown anchor selects the target', eq(F.idRange(order, 'nope', 't2'), ['t2']))
check('new folder ids are distinct', F.newFolderId() !== F.newFolderId())

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

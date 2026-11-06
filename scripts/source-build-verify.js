// Verifies link/branch parsing, build argument handling and the source build
// pipeline (clone state -> configure -> build -> install -> status).
//
//   node scripts/source-build-verify.js
//
// The pipeline runs against a tiny local CMake project standing in for
// llama.cpp, so git and CMake plus a C++ compiler must be on PATH; that part
// is skipped (not failed) when they are not.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-build-verify-'))
function bundle(entry, name) {
  const out = path.join(tmp, name + '.js')
  esbuild.buildSync({ entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', outfile: out, logLevel: 'error', external: ['electron'] })
  return require(out)
}
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const S = bundle('src/shared/sourceBuild.ts', 'shared')
const R2 = S

// -- links ---------------------------------------------------------------------
check('plain repo link', same(S.parseRepoLink('https://github.com/ggml-org/llama.cpp'), { repo: 'ggml-org/llama.cpp' }))
check('owner/repo shorthand', same(S.parseRepoLink('Anbeeld/beellama.cpp'), { repo: 'Anbeeld/beellama.cpp' }))
check('.git suffix and trailing slash are dropped', same(S.parseRepoLink('https://github.com/a/b.git/'), { repo: 'a/b' }))
check('/tree/ link carries its branch path', same(S.parseRepoLink('https://github.com/a/b/tree/feature/x'), { repo: 'a/b', branchPath: 'feature/x' }))
check('owner/repo@branch', same(S.parseRepoLink('a/b@dev'), { repo: 'a/b', branchPath: 'dev' }))
check('query and fragment are ignored', same(S.parseRepoLink('https://github.com/a/b/tree/dev?tab=readme#x'), { repo: 'a/b', branchPath: 'dev' }))
check('a releases link names no branch', same(S.parseRepoLink('https://github.com/a/b/releases'), { repo: 'a/b' }))
check('garbage is rejected', S.parseRepoLink('not a link') === null)

// -- branches ------------------------------------------------------------------
const heads = ['main', 'feature', 'feature/x', 'dev']
check('longest matching branch wins', S.pickBranch('feature/x', heads) === 'feature/x')
check('a path under a branch resolves to the branch', S.pickBranch('dev/src/foo', heads) === 'dev')
check('unknown branch is null', S.pickBranch('nope', heads) === null)
check('a prefix that is not a whole segment does not match', S.pickBranch('developer', heads) === null)
const ls = S.parseLsRemote('ref: refs/heads/main\tHEAD\n' + 'a'.repeat(40) + '\tHEAD\n' + 'a'.repeat(40) + '\trefs/heads/main\n' + 'b'.repeat(40) + '\trefs/heads/feature/x\n')
check('ls-remote output is parsed', ls.defaultBranch === 'main' && ls.headCommit === 'a'.repeat(40) && same(ls.heads, ['main', 'feature/x']))
check('branch slug is filesystem safe', S.branchSlug('Feature/Foo_Bar') === 'feature-foo-bar')
check('branch is part of the display name', S.trackedDisplayName('llama.cpp', 'dev') === 'llama.cpp (dev)' && S.trackedDisplayName('llama.cpp') === 'llama.cpp')

// -- build arguments and output ------------------------------------------------
check('extra args split with quotes', same(S.splitBuildArgs('-DA=1 "-DB=two words" -G'), { args: ['-DA=1', '-DB=two words', '-G'] }))
check('a bare word is refused', 'error' in S.splitBuildArgs('-DA=1 rm'))
check('an open quote is refused', 'error' in S.splitBuildArgs('-DA="1'))
check('empty args are fine', same(S.splitBuildArgs('  '), { args: [] }))
check('makefile progress', S.parseBuildProgress('[ 42%] Building CXX object x.o') === 42)
check('ninja progress', S.parseBuildProgress('[12/48] Building CXX object x.o') === 25)
check('other lines have no progress', S.parseBuildProgress('-- Configuring done') === null)
check('describe label with a slash is a safe folder name', S.sourceVersionName('release/1.0-3-gabc') === 'release-1.0-3-gabc-src')
check('platform filter', S.sourceBuildTypesFor('darwin').some(t => t.id === 'metal') && !S.sourceBuildTypesFor('linux').some(t => t.id === 'metal'))
check('the beellama fork key still matches with a branch', bundle('src/shared/backendForks.ts', 'forks').isBeeLlamaBackendKey('beellama.cpp-anbeeld@dev'))


// -- build tools: what gets installed or updated, and how -----------------------
const T = bundle('src/shared/buildTools.ts', 'tools')
check('a vulkan build needs the SDK and the base tools', same(T.requiredToolsFor('vulkan'), ['git', 'cmake', 'compiler', 'vulkan']) && same(T.requiredToolsFor('cpu'), ['git', 'cmake', 'compiler']))
const aptInstall = T.planTools(['git', 'vulkan'], 'install', 'linux', 'apt')
check('apt: tools are merged into one elevated command', aptInstall.commands.length === 1 && aptInstall.commands[0].elevate && /apt-get install -y git libvulkan-dev glslc/.test(aptInstall.commands[0].args[1]) && /apt-get update/.test(aptInstall.commands[0].args[1]))
check('every Linux package manager installs the SPIR-V headers with Vulkan', [['apt', /spirv-headers\b/], ['dnf', /spirv-headers-devel/], ['pacman', /spirv-headers\b/], ['zypper', /spirv-headers\b/]].every(([pm, re]) => { const c = T.planTools(['vulkan'], 'install', 'linux', pm).commands; return c.length === 1 && re.test(c[0].args.join(' ')) }))
const aptUpdate = T.planTools(['cmake'], 'update', 'linux', 'apt')
check('apt: update only upgrades what is installed', /--only-upgrade cmake/.test(aptUpdate.commands[0].args[1]))
check('apt: CUDA is installed by the package manager', T.planTools(['cuda'], 'install', 'linux', 'apt').commands.length === 1)
check('dnf: CUDA is a manual step with a reason', (() => { const p = T.planTools(['cuda'], 'install', 'linux', 'dnf'); return p.commands.length === 0 && /repository/.test(p.manual[0].reason) })())
const pacUpdate = T.planTools(['git'], 'update', 'linux', 'pacman')
check('pacman: no partial upgrades', pacUpdate.commands.length === 0 && pacUpdate.skipped.length === 1)
const wCompiler = T.planTools(['compiler'], 'install', 'win32', 'winget')
check('winget: the compiler workload is selected on install', wCompiler.commands[0].args.includes('--override') && /VCTools/.test(wCompiler.commands[0].args.join(' ')) && wCompiler.commands[0].args[0] === 'install')
const wUpdate = T.planTools(['cmake'], 'update', 'win32', 'winget')
check('winget: update uses upgrade', wUpdate.commands[0].args[0] === 'upgrade' && wUpdate.commands[0].args.includes('Kitware.CMake'))
check('HIP is downloaded by the app on Windows and Linux, never by a package manager', ['win32', 'linux'].every(pl => { const p = T.planTools(['hip'], 'install', pl, pl === 'win32' ? 'winget' : 'apt'); return same(p.managed, ['hip']) && p.commands.length === 0 && p.manual.length === 0 }))
check('HIP has no install on macOS', T.planTools(['hip'], 'install', 'darwin', 'brew').manual.length === 1)
check('a ROCm build on Windows also needs Ninja', same(T.requiredToolsFor('rocm', 'win32'), ['git', 'cmake', 'compiler', 'ninja', 'hip']) && same(T.requiredToolsFor('rocm', 'linux'), ['git', 'cmake', 'compiler', 'hip']))
check('Ninja comes from winget on Windows', T.planTools(['ninja'], 'install', 'win32', 'winget').commands[0].args.includes('Ninja-build.Ninja'))
check('macOS: cmake through brew, compiler by hand', T.planTools(['cmake'], 'install', 'darwin', 'brew').commands[0].args.join(' ') === 'install cmake' && T.planTools(['compiler'], 'install', 'darwin', 'brew').manual.length === 1)
check('no package manager: everything is manual', T.planTools(['git', 'cmake'], 'install', 'linux', null).manual.length === 2)
check('winget "nothing to do" exit codes are known', T.WINGET_NOTHING_TO_DO.has(-1978335189))


// -- ROCm SDK: GPUs, tarball names, listings -------------------------------------
const R = bundle('src/shared/rocm.ts', 'rocm')
const gpuNames = {
  'AMD Radeon RX 7900 XTX': 'gfx1100', 'AMD Radeon RX 7900 GRE': 'gfx1100', 'Radeon PRO W7900': 'gfx1100',
  'AMD Radeon RX 7800 XT': 'gfx1101', 'AMD Radeon RX 7700 XT': 'gfx1101', 'AMD Radeon RX 7600': 'gfx1102',
  'AMD Radeon 780M Graphics': 'gfx1103', 'AMD Radeon(TM) 890M Graphics': 'gfx1150', 'AMD Radeon(TM) 8060S Graphics': 'gfx1151',
  'AMD Radeon RX 9070 XT': 'gfx1201', 'AMD Radeon RX 9060 XT': 'gfx1200', 'AMD Radeon RX 6800 XT': 'gfx1030', 'AMD Radeon RX 6900 XT': 'gfx1030',
  'AMD Radeon RX 6700 XT': 'gfx1031', 'AMD Radeon RX 6600': 'gfx1032', 'AMD Radeon RX 5700 XT': 'gfx1010',
  'AMD Instinct MI300X': 'gfx942', 'AMD Instinct MI350X': 'gfx950', 'AMD Instinct MI250X': 'gfx90a', 'AMD Instinct MI100': 'gfx908', 'AMD Radeon VII': 'gfx906',
  'NVIDIA GeForce RTX 4090': null, 'Intel(R) Arc(TM) A770': null
}
for (const [name, gfx] of Object.entries(gpuNames)) check(`GPU "${name}" is ${gfx}`, R.gfxForGpuName(name) === gfx, String(R.gfxForGpuName(name)))
check('every GPU target has a family', R.ROCM_GPUS.every(g => /^gfx[0-9a-fA-FX]+$/.test(g.family)))
check('tarball names are parsed', same(R.parseRocmTarball('therock-dist-windows-gfx110X-all-7.14.0a20260612.tar.gz'), { name: 'therock-dist-windows-gfx110X-all-7.14.0a20260612.tar.gz', os: 'windows', family: 'gfx110X', suffix: 'all', version: '7.14.0a20260612' }))
check('a single-arch name has no suffix', R.parseRocmTarball('therock-dist-linux-gfx1153-10.1.0.tar.gz').suffix === '' && R.parseRocmTarball('therock-dist-linux-gfx1153-10.1.0.tar.gz').family === 'gfx1153')
check('ad hoc and multi-arch builds are not family tarballs', R.parseRocmTarball('therock-dist-linux-gfx94X-dcgpu-ADHOCBUILD-7.0.0rc20250625.tar.gz') === null && R.parseRocmTarball('therock-dist-linux-multiarch-10.1.0.tar.gz') === null)
check('a release is newer than its nightlies', R.compareRocmVersions('10.1.0', '10.1.0a20260823') > 0 && R.compareRocmVersions('10.1.0a20260823', '7.14.0a20260612') > 0 && R.compareRocmVersions('7.14.0a20260612', '7.14.0a20260611') > 0 && R.compareRocmVersions('10.2.0', '10.10.0') < 0)
const names = ['therock-dist-linux-gfx110X-all-7.14.0a20260611.tar.gz', 'therock-dist-linux-gfx110X-all-7.14.0a20260612.tar.gz', 'therock-dist-windows-gfx110X-all-7.14.0a20260612.tar.gz', 'therock-dist-linux-gfx120X-all-7.14.0a20260612.tar.gz', 'therock-dist-linux-gfx110X-dgpu-7.14.0a20260612.tar.gz']
check('the newest "all" tarball for the OS and family is picked', R.pickRocmTarball(names, 'linux', 'gfx110X').name === 'therock-dist-linux-gfx110X-all-7.14.0a20260612.tar.gz' && R.pickRocmTarball(names, 'windows', 'gfx110X').os === 'windows')
check('no tarball for a family is null', R.pickRocmTarball(names, 'linux', 'gfx1151') === null)
check('S3 listing keys and continuation are read', (() => { const l = R.parseS3Listing('<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a.tar.gz</Key></Contents><Contents><Key>b.tar.gz</Key></Contents><NextContinuationToken>tok1</NextContinuationToken></ListBucketResult>'); return same(l.keys, ['a.tar.gz', 'b.tar.gz']) && l.nextToken === 'tok1' })())
check('HTML listing names are found in links and text', same(R.parseHtmlListing('<a href="therock-dist-linux-gfx1151-10.1.0.tar.gz">x</a> therock-dist-windows-gfx1151-10.1.0.tar.gz'), ['therock-dist-linux-gfx1151-10.1.0.tar.gz', 'therock-dist-windows-gfx1151-10.1.0.tar.gz']))
check('extras for a GPU with its own device package', R.rocmPipExtras('gfx1100') === 'devel,libraries,device-gfx1100')
check('extras for a GPU without one use device-all', R.rocmPipExtras('gfx1153') === 'devel,libraries,device-all')
check('release versions are read from a PEP 503 index, newest first', same(R.parsePipIndexVersions('<a href="../f/rocm-10.1.0-py3-none-any.whl#sha256=ab">x</a><a href="rocm-10.2.0.tar.gz">y</a><a href="rocm-9.9.9-py3-none-any.whl">z</a><a href="rocm_sdk_core-10.5.0-py3-none-any.whl">no</a><a href="rocm-10.3.0a2026-py3-none-any.whl">pre</a>'), ['10.2.0', '10.1.0', '9.9.9']))
check('a pip ROCm build needs Python, a tarball one does not', T.requiredToolsFor('rocm', 'linux', 'pip').includes('python') && !T.requiredToolsFor('rocm', 'linux', 'tarball').includes('python'))
check('Python is installed through the package manager', T.planTools(['python'], 'install', 'linux', 'apt').commands[0].args[1].includes('python3 python3-venv') && T.planTools(['python'], 'install', 'win32', 'winget').commands[0].args.includes('Python.Python.3.12'))
const X = bundle('src/shared/exitCodes.ts', 'exitcodes')
check('a missing DLL is explained, as the unsigned or the signed exit code', /DLL the program needs was not found/.test(X.explainExitCode(3221225781)) && /DLL the program needs was not found/.test(X.explainExitCode(-1073741515)))
check('other loader failures are explained', /wrong architecture/.test(X.explainExitCode(0xC000007B)) && /version mismatch/.test(X.explainExitCode(0xC0000139)) && /access violation/.test(X.explainExitCode(0xC0000005)))
check('an ordinary exit code has no explanation', X.explainExitCode(1) === '' && X.explainExitCode(0) === '')
check('CUDA 12.4 is a build type of its own, with the toolkit series it needs', R2.sourceBuildTypesFor('linux').some(t => t.id === 'cuda-12.4') && R2.cudaTypeVersion('cuda-12.4') === '12.4' && R2.cudaTypeVersion('cuda') === undefined && R2.isCudaType('cuda-12.4') && R2.isCudaType('cuda') && !R2.isCudaType('vulkan'))
check('a CUDA 12.4 build needs the toolkit (and Ninja on Windows)', T.requiredToolsFor('cuda-12.4', 'win32').includes('cuda') && T.requiredToolsFor('cuda-12.4', 'win32').includes('ninja') && !T.requiredToolsFor('cuda-12.4', 'linux').includes('ninja'))
check('on Windows the CUDA Toolkit is installed by the app, on Linux by the package manager', same(T.planTools(['cuda'], 'install', 'win32', 'winget').managed, ['cuda']) && T.planTools(['cuda'], 'install', 'linux', 'apt').managed.length === 0 && T.planTools(['cuda'], 'install', 'linux', 'apt').commands.length === 1)
// -- which build a Template runs on -----------------------------------------------
const P = bundle('src/shared/backendPin.ts', 'pin')
const be = (backendKey, backendType, name) => ({ id: `${backendKey}|${backendType}|${name}`, backendKey, backendType, name, version: name, exe: 'llama-server' })
const llVk = be('llama.cpp', 'vulkan', 'b12032-src'), llRocm = be('llama.cpp', 'rocm', 'b12032-src'), tqVk = be('atomic-llama-cpp-turboquant', 'vulkan', 'b10298-2.1.0-src'), tqRocm = be('atomic-llama-cpp-turboquant', 'rocm', 'b10298-2.1.0-src')
const installed = [tqVk, tqRocm, llVk, llRocm]
const noGlobals = {}
const pinVk = { backendKey: 'llama.cpp', backendType: 'vulkan', backendVersion: 'b11988-windows' }
check('a pin whose version folder was replaced still resolves to its repo and backend type, not the global backend', P.resolveLlamaTarget(pinVk, installed, tqVk, noGlobals).build === llVk)
check('whatever the global backend is switched to (turboquant Vulkan or ROCm, llama.cpp ROCm)', [tqVk, tqRocm, llRocm].every(g => P.resolveLlamaTarget(pinVk, installed, g, noGlobals).build === llVk))
check('a pin keeps its version while that version exists', P.resolveLlamaTarget({ ...pinVk, backendVersion: 'b12032-src' }, installed, tqVk, noGlobals).build === llVk)
check('with several versions the pinned one is used, else the newest of that type', (() => { const old = be('llama.cpp', 'vulkan', 'b11000-windows'); const list = [llVk, old, llRocm]; return P.resolveLlamaTarget({ ...pinVk, backendVersion: 'b11000-windows' }, list, tqVk, noGlobals).build === old && P.resolveLlamaTarget(pinVk, list, tqVk, noGlobals).build === llVk })())
const r1 = P.resolveLlamaTarget(pinVk, [tqVk, llRocm], tqVk, noGlobals)
check('a pin whose backend type is gone is reported, not answered with another type of the repo', !r1.build && /no vulkan build installed/.test(r1.missing), JSON.stringify(r1))
const r2 = P.resolveLlamaTarget(pinVk, [tqVk, tqRocm], tqVk, noGlobals)
check('a pin whose repo is not installed is reported, not answered with the global backend', !r2.build && /llama\.cpp is not installed/.test(r2.missing))
check('a Template without a pin follows the global backend', P.resolveLlamaTarget({}, installed, tqRocm, noGlobals).build === tqRocm && P.resolveLlamaTarget(null, installed, llRocm, noGlobals).build === llRocm)
check('a pin from before backend types existed takes any build of its repo', P.resolveLlamaTarget({ backendKey: 'llama.cpp' }, installed, tqVk, noGlobals).build?.backendKey === 'llama.cpp')
check('a version-only pin from an old Template is found by its version', P.resolveLlamaTarget({ backendVersion: 'b10298-2.1.0-src' }, installed, llVk, noGlobals).build?.backendKey === 'atomic-llama-cpp-turboquant')
check('and follows the global backend when that version is gone', P.resolveLlamaTarget({ backendVersion: 'b1-gone' }, installed, llRocm, noGlobals).build === llRocm)
check('showing a pin whose type is gone falls back to its own repo, never to the global backend', P.resolveEngineBackend('llama.cpp', pinVk, [tqVk, llRocm], tqVk, noGlobals) === llRocm)
check('a null backend type is a type of its own (an install made before types existed)', (() => { const legacy = be('llama.cpp', null, 'b9000'); return P.resolveLlamaTarget({ backendKey: 'llama.cpp', backendType: null }, [llVk, legacy], tqVk, noGlobals).build === legacy })())

// -- the 2x context ladder ----------------------------------------------------------
const CF = bundle('src/renderer/src/utils/contextFormat.ts', 'ctxformat')
check('a model limit that is not a power of two is the last stop of the ladder', same(CF.ladderUpTo(128000).slice(-3), [32768, 65536, 128000]) && CF.snapToNearestPowerOfTwo(128000, CF.ladderUpTo(128000)) === 128000)
check('a limit that is a power of two is not listed twice', CF.ladderUpTo(131072).filter(v => v === 131072).length === 1 && CF.ladderUpTo(131072).slice(-1)[0] === 131072)
check('a large limit between two powers keeps all the smaller stops', CF.ladderUpTo(1000000).includes(524288) && CF.ladderUpTo(1000000).slice(-1)[0] === 1000000 && CF.ladderUpTo(1000000).length === CF.ladderUpTo(524288).length + 1)
check('values near the limit snap to it, not to the stop below', CF.snapToNearestPowerOfTwo(120000, CF.ladderUpTo(128000)) === 128000 && CF.snapToNearestPowerOfTwo(70000, CF.ladderUpTo(128000)) === 65536)
check('the ladder stays sorted and unique', (() => { const l = CF.ladderUpTo(100000); return l.every((v, i) => i === 0 || v > l[i - 1]) })())
// -- tracker entries: the same repo tracked twice ---------------------------------
const TM = bundle('src/shared/trackedMerge.ts', 'trackedmerge')
const defBee = { id: 'beellama-cpp', repo: 'Anbeeld/beellama.cpp', name: 'beellama.cpp', folderName: 'beellama.cpp', isDefault: true, extraCommands: ['x'] }
const defLlama = { id: 'llama-cpp', repo: 'ggml-org/llama.cpp', name: 'llama.cpp', folderName: 'llama.cpp', isDefault: true }
const customBee = { id: 'beellama-cpp-anbeeld-abc', repo: 'anbeeld/BeeLlama.cpp', name: 'beellama.cpp', folderName: 'beellama.cpp-anbeeld', isDefault: false }
const m1 = TM.mergeDefaultTracked([defLlama, defBee, customBee], [defLlama, defBee])
check('a repo tracked twice becomes the built-in entry', m1.filter(t => t.repo.toLowerCase() === 'anbeeld/beellama.cpp').length === 1 && m1.find(t => t.id === 'beellama-cpp').isDefault && m1.find(t => t.id === 'beellama-cpp').folderName === 'beellama.cpp')
check('with the other folder listed to be moved in', same(m1.find(t => t.id === 'beellama-cpp').legacyFolders, ['beellama.cpp-anbeeld']))
const m2 = TM.mergeDefaultTracked([customBee, defLlama, defBee], [defLlama, defBee])
check('whichever of the two comes first in the saved list', m2.filter(t => t.repo.toLowerCase() === 'anbeeld/beellama.cpp').length === 1 && m2.find(t => t.id === 'beellama-cpp').folderName === 'beellama.cpp' && same(m2.find(t => t.id === 'beellama-cpp').legacyFolders, ['beellama.cpp-anbeeld']))
const m3 = TM.mergeDefaultTracked(m1, [defLlama, defBee])
check('the aliases survive the next load', same(m3.find(t => t.id === 'beellama-cpp').legacyFolders, ['beellama.cpp-anbeeld']) && m3.length === m1.length)
const m4 = TM.mergeDefaultTracked([defLlama, customBee], [defLlama, defBee])
check('a single custom entry for the repo is promoted in place and keeps its folder', m4.filter(t => t.repo.toLowerCase() === 'anbeeld/beellama.cpp').length === 1 && m4.find(t => t.repo.toLowerCase() === 'anbeeld/beellama.cpp').folderName === 'beellama.cpp-anbeeld' && m4.find(t => t.id === customBee.id).isDefault)
const branchEntry = { id: 'bee-dev', repo: 'Anbeeld/beellama.cpp', name: 'beellama.cpp (dev)', folderName: 'beellama.cpp@dev', branch: 'dev', isDefault: false }
const m5 = TM.mergeDefaultTracked([defBee, branchEntry], [defBee])
check('a branch of the same repo is its own entry and is left alone', m5.length === 2 && m5.some(t => t.branch === 'dev'))
const m6 = TM.mergeDefaultTracked([], [defLlama, defBee])
check('the built-in entries exist on a fresh install', m6.length === 2)
// a Template pinned to the old folder still means the merged repo
P.setBackendKeyAliases(m1)
check('a Template pinned to the old folder name resolves to the merged one', P.resolveLlamaTarget({ backendKey: 'beellama.cpp-anbeeld', backendType: 'vulkan' }, [be('beellama.cpp', 'vulkan', 'v0.4.9-src')], null, {}).build?.backendKey === 'beellama.cpp')
P.setBackendKeyAliases([])
// -- several mmproj files in one model folder ---------------------------------------
const MM = bundle('src/shared/mmprojRank.ts', 'mmprojrank')
const mmNames = ['mmproj-Q4_0.gguf', 'mmproj-F16.gguf', 'gemma-mmproj-Q4_K_M.gguf', 'mmproj.gguf', 'mmproj-Q8_0.gguf', 'model_mmproj_BF16.gguf', 'mmproj-F32.gguf']
const mmSorted = MM.sortMmprojs(mmNames.map(name => ({ name, size: 100 }))).map(f => f.name)
check('projectors are ranked bf16 > f16 > q8 > q4_K_M > q4_0, the unlabelled one last', same(mmSorted.filter(n => n !== 'mmproj-F32.gguf'), ['model_mmproj_BF16.gguf', 'mmproj-F16.gguf', 'mmproj-Q8_0.gguf', 'gemma-mmproj-Q4_K_M.gguf', 'mmproj-Q4_0.gguf', 'mmproj.gguf']), mmSorted.join(', '))
check('f32 sits between f16 and q8', mmSorted.indexOf('mmproj-F32.gguf') === mmSorted.indexOf('mmproj-F16.gguf') + 1)
check('the order does not depend on the order the folder was read in', same(MM.sortMmprojs([...mmNames].reverse().map(name => ({ name, size: 100 }))).map(f => f.name), mmSorted))
check('bf16 is not read as f16, nor q4_K_M as q4_0', MM.mmprojQuant('mmproj-bf16.gguf') === 'BF16' && MM.mmprojQuant('mmproj-f16.gguf') === 'F16' && MM.mmprojQuant('mmproj-Q4_K_M.gguf') === 'Q4_K_M' && MM.mmprojQuant('mmproj-q4_0.gguf') === 'Q4_0')
check('the precision is read in any case and with any separator', MM.mmprojQuant('MMPROJ_Q8_0.GGUF') === 'Q8_0' && MM.mmprojQuant('model.mmproj.F16.gguf') === 'F16' && MM.mmprojQuant('mmproj.gguf') === null)
check('two files of the same precision: the larger one first', MM.sortMmprojs([{ name: 'a-F16.gguf', size: 1 }, { name: 'b-F16.gguf', size: 9 }])[0].name === 'b-F16.gguf')
check('probe candidates cover the naming variants', R.rocmTarballCandidates('linux', 'gfx110X', '10.1.0').includes('therock-dist-linux-gfx110X-all-10.1.0.tar.gz') && R.rocmTarballCandidates('linux', 'gfx1153', '10.1.0').includes('therock-dist-linux-gfx1153-10.1.0.tar.gz'))

// -- pipeline ------------------------------------------------------------------
function have(cmd) { try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true } catch { return false } }
async function pipeline() {
  if (!have('git') || !have('cmake') || !(have('c++') || have('g++') || have('clang++'))) {
    console.log('SKIP  pipeline (git, cmake and a C++ compiler are needed)')
    return
  }
  const B = bundle('src/main/sourceBuild.ts', 'build')
  const M2 = bundle('src/main/rocmSdk.ts', 'rocmsdk2')
  const engines = path.join(tmp, 'engines')
  const forkDir = path.join(engines, 'fake-repo')
  const src = path.join(forkDir, B.SOURCE_DIRNAME)
  fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.10)\nproject(fake CXX)\nmessage(STATUS "SEEN CUDAROOT=${CUDAToolkit_ROOT}")\nmessage(STATUS "SEEN CUDAENV=$ENV{CUDA_PATH}")\nadd_executable(llama-server main.cpp)\n' +
    'set_target_properties(llama-server PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)\n')
  fs.writeFileSync(path.join(src, 'main.cpp'), 'int main() { return 0; }\n')
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src, stdio: 'ignore' })
  git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'init'); git('tag', 'b1000')

  // Downloaded builds of the same type: older or same-tag ones are superseded by
  // a build from source, newer ones and those made for another OS are not.
  const seedDir = (name, file) => { const d = path.join(forkDir, 'cpu', name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, file), '') }
  fs.mkdirSync(path.join(forkDir, 'cpu'), { recursive: true })
  fs.writeFileSync(path.join(forkDir, 'cpu', '.xlm-backend-type'), '')
  seedDir('b500-linux', 'llama-server'); seedDir('b1000-linux', 'llama-server'); seedDir('b9999-linux', 'llama-server'); seedDir('b1000-windows', 'llama-server.exe')

  const lines = []
  const phases = []
  const hooks = (signal) => ({
    log: (l, app) => lines.push((app ? 'A ' : 'O ') + l),
    progress: (p) => phases.push(p),
    killTree: async (proc) => { try { process.kill(-proc.pid, 'SIGKILL') } catch { proc.kill('SIGKILL') } },
    signal
  })
  const job = { repo: 'fake/repo', folderName: 'fake-repo', type: 'cpu', extraArgs: ['-DFOO=bar'], rootDir: engines }

  const res = await B.buildFromSource(job, hooks(new AbortController().signal))
  check('build succeeds', res.ok, res.error)
  if (!res.ok) { console.log(lines.slice(-15).join('\n')); return }
  check('version folder is the describe label plus -src', res.version === 'b1000-src', res.version)
  const exe = path.join(res.versionDir, 'llama-server')
  check('binary is installed next to its marker files', fs.existsSync(exe) && fs.existsSync(path.join(forkDir, 'cpu', '.xlm-backend-type')) && B.isSourceBuildDir(res.versionDir))
  check('marker records commit, type and arguments', (() => { const m = B.readSourceMarker(res.versionDir); return m && m.commit === res.commit && m.type === 'cpu' && same(m.extraArgs, ['-DFOO=bar']) })())
  check('CMake saw the extra argument', fs.readFileSync(path.join(forkDir, B.BUILD_DIRNAME, 'cpu', 'CMakeCache.txt'), 'utf8').includes('FOO:UNINITIALIZED=bar'))
  const cpuDir = path.join(forkDir, 'cpu')
  check('an older downloaded build is removed', !fs.existsSync(path.join(cpuDir, 'b500-linux')))
  check('a downloaded build of the same tag is removed', !fs.existsSync(path.join(cpuDir, 'b1000-linux')))
  check('a newer downloaded build is kept', fs.existsSync(path.join(cpuDir, 'b9999-linux')))
  check('a build for another OS is kept', fs.existsSync(path.join(cpuDir, 'b1000-windows')))
  check('output and app messages are both logged', lines.some(l => l.startsWith('O ')) && lines.some(l => l.startsWith('A Installed')))
  check('phases are reported in order', ['configuring', 'building', 'installing'].every(p => phases.includes(p)) && phases.indexOf('configuring') < phases.indexOf('building'))

  const before = B.scanSourceBuilds([engines], 'fake-repo', res.commit)
  check('status: up to date at the same commit', before.length === 1 && before[0].type === 'cpu' && !before[0].outdated && same(before[0].args, ['-DFOO=bar']))
  const behind = B.scanSourceBuilds([engines], 'fake-repo', 'f'.repeat(40))
  check('status: outdated when the branch moved', behind.length === 1 && behind[0].outdated)

  // A second commit, rebuilt with the stored arguments: the old build is superseded.
  fs.appendFileSync(path.join(src, 'main.cpp'), '// change\n')
  git('commit', '-q', '-am', 'second')
  const res2 = await B.buildFromSource({ ...job, extraArgs: behind[0].args }, hooks(new AbortController().signal))
  check('rebuild succeeds', res2.ok, res2.error)
  check('rebuild replaces the superseded build', res2.ok && res2.commit !== res.commit && !fs.existsSync(res.versionDir) && fs.existsSync(res2.versionDir))

  // No update to build: a downloaded binary that is already there is still superseded.
  seedDir('b800-linux', 'llama-server'); seedDir('b9998-linux', 'llama-server')
  await B.pruneSupersededBuilds([engines], 'fake-repo')
  check('a leftover older download is removed without a rebuild', !fs.existsSync(path.join(cpuDir, 'b800-linux')))
  check('a newer download is still kept', fs.existsSync(path.join(cpuDir, 'b9998-linux')) && fs.existsSync(path.join(cpuDir, 'b9999-linux')))
  check('the compiled build itself is kept', fs.existsSync(res2.versionDir))
  check('pruning again changes nothing', (await B.pruneSupersededBuilds([engines], 'fake-repo'), fs.existsSync(res2.versionDir)))

  // ---- Which release a build is called after, and which downloads it replaces ----
  // Release tags (b10298-2.1.0, v0.4.9) count; CI and moving tags do not.
  const SH = bundle('src/shared/sourceBuild.ts', 'sharedsb')
  check('release tags are recognised', ['b10298-2.1.0', 'b9584', 'v0.4.9', '2.1.0', 'v1.2.0-rc1'].every(SH.isReleaseTag))
  check('CI and moving tags are not releases', ['dev-latest', 'nightly', 'turboquant-windows-x64-cuda-12.4-066cc29', 'turboquant-macos-arm64-e381dc9', 'latest'].every(t => !SH.isReleaseTag(t)))
  check('a build folder name reduces to its release', SH.releaseBaseOf('b10298-2.1.0-g8d935078-src') === 'b10298-2.1.0' && SH.releaseBaseOf('b10298-2.1.0-4-g8d935078-src') === 'b10298-2.1.0' && SH.releaseBaseOf('v0.4.8-450-g1a2b3c4-src') === 'v0.4.8' && SH.releaseBaseOf('b1000-src') === 'b1000' && SH.releaseBaseOf('b1000-linux') === 'b1000')
  check('a name that is not a version gives none', SH.releaseBaseOf('dev-latest-src') === null && SH.releaseBaseOf('b46c53e-src') === null)

  // TurboQuant's shape: the release is tagged on a side branch that is not in the history of dev.
  const tq = path.join(tmp, 'tq-src'); fs.mkdirSync(tq, { recursive: true })
  const tg = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: tq, encoding: 'utf8' }).trim()
  let n = 0
  const commit = () => { fs.writeFileSync(path.join(tq, 'f.txt'), String(++n)); tg('add', '.'); tg('commit', '-q', '-m', 'c' + n); return tg('rev-parse', 'HEAD') }
  tg('init', '-q', '-b', 'dev'); commit(); tg('tag', 'b100-1.5.1')
  for (let i = 0; i < 8; i++) commit()
  const mergeBase = commit()
  tg('checkout', '-q', '-b', 'release'); commit(); commit(); tg('tag', 'b200-2.1.0')
  tg('checkout', '-q', 'dev')
  tg('tag', 'turboquant-windows-x64-cuda-12.4-066cc29'); tg('tag', 'dev-latest')
  for (let i = 0; i < 4; i++) commit()
  const tqHead = tg('rev-parse', 'HEAD'), tqShort = tg('rev-parse', '--short', 'HEAD')
  check('git describe alone would name the old ancestor tag', /^b100-1\.5\.1-\d+-g/.test(tg('describe', '--tags', '--match', 'b[0-9]*')))
  const tqLabel = await B.sourceVersionLabel(tq)
  check('a release cut on a side branch is the nearest release', tqLabel === `b200-2.1.0-g${tqShort}`, tqLabel)
  check('the commits before the release was cut are named after the older tag', (await B.sourceVersionLabel(tq, mergeBase)).startsWith('b100-1.5.1-g'))
  tg('tag', 'b300-3.0.0', tqHead)
  check('a release tag on the commit itself is its version', await B.sourceVersionLabel(tq) === 'b300-3.0.0')
  tg('tag', '-d', 'b300-3.0.0')

  // Cleanup of downloads: decided from the commit as well as from the folder name.
  const tqEngines = path.join(tmp, 'engines-tq'); const tqFork = path.join(tqEngines, 'tq')
  fs.mkdirSync(tqFork, { recursive: true }); fs.cpSync(tq, path.join(tqFork, B.SOURCE_DIRNAME), { recursive: true })
  const tqType = path.join(tqFork, 'vulkan'); fs.mkdirSync(tqType, { recursive: true }); fs.writeFileSync(path.join(tqType, '.xlm-backend-type'), '')
  const seedVer = (name, marker) => { const d = path.join(tqType, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'llama-server'), ''); if (marker) fs.writeFileSync(path.join(d, B.SOURCE_MARKER), JSON.stringify({ repo: 'a/b', branch: null, commit: marker, type: 'vulkan', extraArgs: [], builtAt: Date.now() })) }
  // The build as an older version of the app named it, and the downloads around it.
  seedVer(`b100-1.5.1-9-g${tqShort}-src`, tqHead)
  seedVer('b200-2.1.0'); seedVer('b200-2.0.0'); seedVer('b300-3.0.0'); seedVer('weird-name')
  const pruneLines = []
  await B.pruneSupersededBuilds([tqEngines], 'tq', l => pruneLines.push(l), true)
  check('the download of the release the build is made from is removed', !fs.existsSync(path.join(tqType, 'b200-2.1.0')) && pruneLines.some(l => /Removed vulkan\/b200-2\.1\.0/.test(l)), pruneLines.join(' | '))
  check('an older download is removed too', !fs.existsSync(path.join(tqType, 'b200-2.0.0')))
  check('a newer download is kept and the log says why', fs.existsSync(path.join(tqType, 'b300-3.0.0')) && pruneLines.some(l => /Kept the download vulkan\/b300-3\.0\.0: it is newer/.test(l)))
  check('a folder that is not a version is left alone', fs.existsSync(path.join(tqType, 'weird-name')))
  // A build from an old app version whose name says nothing at all.
  fs.rmSync(path.join(tqType, `b100-1.5.1-9-g${tqShort}-src`), { recursive: true })
  seedVer('dev-latest-src', tqHead); seedVer('b150-1.6.0')
  await B.pruneSupersededBuilds([tqEngines], 'tq')
  check('a build named "dev-latest-src" still replaces the downloads its commit makes redundant', !fs.existsSync(path.join(tqType, 'b150-1.6.0')) && fs.existsSync(path.join(tqType, 'dev-latest-src')))
  // BeeLlama's shape: plain semver tags, HEAD tagged with the release.
  check('a build of a tagged release replaces its download', await (async () => {
    const bee = path.join(tmp, 'bee-src'); fs.mkdirSync(bee, { recursive: true })
    const bg = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: bee, encoding: 'utf8' }).trim()
    bg('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(bee, 'a'), '1'); bg('add', '.'); bg('commit', '-q', '-m', 'one'); bg('tag', 'v0.4.8'); fs.writeFileSync(path.join(bee, 'a'), '2'); bg('commit', '-q', '-am', 'two'); bg('tag', 'v0.4.9')
    const e = path.join(tmp, 'engines-bee'); const f = path.join(e, 'bee'); const t = path.join(f, 'vulkan')
    fs.mkdirSync(t, { recursive: true }); fs.cpSync(bee, path.join(f, B.SOURCE_DIRNAME), { recursive: true }); fs.writeFileSync(path.join(t, '.xlm-backend-type'), '')
    const mk = (name, commit) => { const d = path.join(t, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'llama-server'), ''); if (commit) fs.writeFileSync(path.join(d, B.SOURCE_MARKER), JSON.stringify({ repo: 'a/b', branch: null, commit, type: 'vulkan', extraArgs: [], builtAt: Date.now() })) }
    mk('v0.4.9'); mk('v0.4.7'); mk('b46c53e-src', bg('rev-parse', 'HEAD'))
    await B.pruneSupersededBuilds([e], 'bee')
    return !fs.existsSync(path.join(t, 'v0.4.9')) && !fs.existsSync(path.join(t, 'v0.4.7')) && fs.existsSync(path.join(t, 'b46c53e-src'))
  })())

  // ---- CMake's remembered state outliving the CMake that made it ----
  const lineA = 'CUSTOMBUILD : CMake error : File C:/Program Files/CMake/share/cmake-4.3/Modules/CMakeSystem.cmake.in does not exist. [A:\\x\\vulkan-shaders-gen.vcxproj]'
  check('the errors of a stale sub-build are recognised', [lineA, '  CMake Configure step failed.  Build files cannot be regenerated correctly.', '    include could not find requested file:', 'CMake Error: The current CMakeCache.txt directory /a/CMakeCache.txt is different than the directory /b where CMakeCache.txt was created.'].every(B.isStaleCmakeLine))
  check('compile and ordinary configure errors are not', ['main.cpp(3): error C2065: x: undeclared identifier', "CMake Error at CMakeLists.txt:4 (find_package): Could not find package Vulkan", 'ld: undefined reference to foo'].every(l => !B.isStaleCmakeLine(l)))
  check('the CMake version is read from its first line', B.cmakeMajorMinor('cmake version 4.4.0') === '4.4' && B.cmakeMajorMinor(null) === null)
  const staleRoot = path.join(tmp, 'stale-tree')
  const plant = (rel, cache) => { const d = path.join(staleRoot, ...rel.split('/'), 'src', 'x-build'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'CMakeCache.txt'), cache) }
  plant('ggml/vulkan/gone-prefix'.replace('gone', 'a'), 'CMAKE_ROOT:INTERNAL=/nonexistent/share/cmake-4.3\nCMAKE_CACHE_MAJOR_VERSION:INTERNAL=4\nCMAKE_CACHE_MINOR_VERSION:INTERNAL=3\n')
  plant('b-prefix', `CMAKE_ROOT:INTERNAL=${tmp}\nCMAKE_CACHE_MAJOR_VERSION:INTERNAL=4\nCMAKE_CACHE_MINOR_VERSION:INTERNAL=3\n`)
  plant('c-prefix', `CMAKE_ROOT:INTERNAL=${tmp}\nCMAKE_CACHE_MAJOR_VERSION:INTERNAL=4\nCMAKE_CACHE_MINOR_VERSION:INTERNAL=4\n`)
  const stale1 = B.findStaleCmakeSubbuilds(staleRoot, '4.4').map(p => path.relative(staleRoot, p).replace(/\\/g, '/')).sort()
  check('a sub-build whose CMake is gone, or another version, is found', same(stale1, ['b-prefix', 'ggml/vulkan/a-prefix'].sort()), stale1.join(','))
  check('without a known version only a missing CMake counts', same(B.findStaleCmakeSubbuilds(staleRoot, null).map(p => path.basename(p)), ['a-prefix']))

  // The build itself: a fake repo that fails the way a stale tree does, or the way a real error does.
  const rp = path.join(tmp, 'repair-src'); fs.mkdirSync(rp, { recursive: true })
  fs.writeFileSync(path.join(rp, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.10)\nproject(fake CXX)\n' +
    'if(EXISTS "${CMAKE_BINARY_DIR}/ext-prefix")\n  message(FATAL_ERROR "Build files cannot be regenerated correctly")\nendif()\n' +
    'if(EXISTS "${CMAKE_BINARY_DIR}/poison")\n  message(FATAL_ERROR "Build files cannot be regenerated correctly")\nendif()\n' +
    'if(EXISTS "${CMAKE_BINARY_DIR}/broken")\n  message(FATAL_ERROR "a genuine configure problem")\nendif()\n' +
    'add_executable(llama-server main.cpp)\nset_target_properties(llama-server PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)\n')
  fs.writeFileSync(path.join(rp, 'main.cpp'), 'int main() { return 0; }\n')
  const rg = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: rp, stdio: 'ignore' })
  rg('init', '-q'); rg('add', '.'); rg('commit', '-q', '-m', 'init'); rg('tag', 'b1000')
  const repEngines = path.join(tmp, 'engines-repair'); fs.mkdirSync(path.join(repEngines, 'rp'), { recursive: true })
  fs.cpSync(rp, path.join(repEngines, 'rp', B.SOURCE_DIRNAME), { recursive: true })
  const repJob = { repo: 'fake/rp', folderName: 'rp', type: 'cpu', extraArgs: [], rootDir: repEngines, pull: false }
  const repBuild = path.join(repEngines, 'rp', B.BUILD_DIRNAME, 'cpu')
  const repRun = async () => { lines.length = 0; return B.buildFromSource(repJob, hooks(new AbortController().signal)) }
  check('the repair fixture builds', (await repRun()).ok)
  fs.writeFileSync(path.join(repBuild, 'keep.txt'), 'x')
  // 1) a stale sub-build: only that folder goes, the rest of the build tree stays.
  const extCache = path.join(repBuild, 'ext-prefix', 'src', 'ext-build'); fs.mkdirSync(extCache, { recursive: true })
  fs.writeFileSync(path.join(extCache, 'CMakeCache.txt'), `CMAKE_ROOT:INTERNAL=${tmp}\n`)
  const r1 = await repRun()
  check('a stale sub-build is removed and the build retried', r1.ok && !fs.existsSync(path.join(repBuild, 'ext-prefix')) && lines.some(l => /Removed ext-prefix and trying again/.test(l)), (r1.error || '') + lines.slice(-6).join(' | '))
  check('the rest of the build folder is kept', fs.existsSync(path.join(repBuild, 'keep.txt')))
  // 2) a sub-build whose CMake is gone is removed before anything fails.
  fs.mkdirSync(extCache, { recursive: true }); fs.writeFileSync(path.join(extCache, 'CMakeCache.txt'), 'CMAKE_ROOT:INTERNAL=/nonexistent/share/cmake-4.3\n')
  const r2 = await repRun()
  check('a sub-build made by a CMake that is gone is removed up front', r2.ok && lines.some(l => /Removed ext-prefix, made by a CMake that is no longer there/.test(l)) && !lines.some(l => /trying again/.test(l)), r2.error)
  // 3) nothing to remove: the whole folder starts again.
  fs.writeFileSync(path.join(repBuild, 'poison'), '')
  const r3 = await repRun()
  check('without sub-builds to remove the whole build folder is started again', r3.ok && !fs.existsSync(path.join(repBuild, 'keep.txt')) && lines.some(l => /Starting the build folder again from scratch/.test(l)), r3.error)
  // 4) a real error is neither retried nor wipes anything.
  fs.writeFileSync(path.join(repBuild, 'keep.txt'), 'x'); fs.writeFileSync(path.join(repBuild, 'broken'), '')
  const r4 = await repRun()
  check('a genuine configure error fails once and keeps the build folder', !r4.ok && fs.existsSync(path.join(repBuild, 'keep.txt')) && !lines.some(l => /again from scratch|trying again/.test(l)))
  fs.rmSync(path.join(repBuild, 'broken'))

  // ---- Source and build folders are kept per OS ----
  const gitCfg = (text) => text
  const mkClone = (dir, flavour) => {
    fs.cpSync(rp, dir, { recursive: true })
    const cfgPath = path.join(dir, '.git', 'config')
    let cfg = fs.readFileSync(cfgPath, 'utf8').replace(/^\s*(filemode|symlinks|ignorecase|precomposeunicode)\s*=.*$/gmi, '')
    const core = { linux: '\tfilemode = true\n', windows: '\tfilemode = false\n\tsymlinks = false\n\tignorecase = true\n', macos: '\tfilemode = true\n\tignorecase = true\n\tprecomposeunicode = true\n', unknown: '' }[flavour]
    cfg = cfg.replace(/\[core\]\n/, '[core]\n' + core)
    fs.writeFileSync(cfgPath, cfg)
  }
  const cl = (flavour) => { const d = path.join(tmp, 'clone-' + flavour); mkClone(d, flavour); return d }
  check('the OS that made a clone is read from its git config', B.cloneOsOf(cl('linux')) === 'linux' && B.cloneOsOf(cl('windows')) === 'windows' && B.cloneOsOf(cl('macos')) === 'macos' && B.cloneOsOf(cl('unknown')) === null && B.cloneOsOf(path.join(tmp, 'no-such-clone')) === null)

  const osFork = path.join(tmp, 'engines-os', 'osrepo')
  fs.mkdirSync(osFork, { recursive: true })
  check('with no clone yet each OS gets its own folders', (() => { const l = B.workDirs(osFork, 'linux'), w = B.workDirs(osFork, 'windows'); return !l.legacy && l.source === path.join(osFork, '.work', 'linux', 'source') && l.build('vulkan') === path.join(osFork, '.work', 'linux', 'build', 'vulkan') && w.source === path.join(osFork, '.work', 'windows', 'source') })())
  // A clone from before builds were kept per OS belongs to the OS that made it (here Windows).
  mkClone(path.join(osFork, '.source'), 'windows')
  fs.mkdirSync(path.join(osFork, '.build', 'cpu'), { recursive: true })
  fs.writeFileSync(path.join(osFork, '.build', 'cpu', 'CMakeCache.txt'), 'CMAKE_HOME_DIRECTORY:INTERNAL=A:/AI/Engines/osrepo/.source\n')
  fs.writeFileSync(path.join(osFork, '.build', 'cpu', 'keep.txt'), 'windows build')
  check('an old-style clone stays with the OS that made it', (() => { const w = B.workDirs(osFork, 'windows'); return w.legacy && w.source === path.join(osFork, '.source') && w.build('cpu') === path.join(osFork, '.build', 'cpu') })())
  check('and the other OS does not use it', (() => { const l = B.workDirs(osFork, 'linux'); return !l.legacy && l.source === path.join(osFork, '.work', 'linux', 'source') && l.build('cpu') === path.join(osFork, '.work', 'linux', 'build', 'cpu') })())
  check('a clone that cannot be placed is taken to be the asker\'s', B.workDirs(path.join(tmp, 'clone-unknown', '..', 'engines-os-u'), 'linux').legacy === false && (() => { const f = path.join(tmp, 'engines-os-u2'); fs.mkdirSync(f, { recursive: true }); mkClone(path.join(f, '.source'), 'unknown'); return B.workDirs(f, 'linux').legacy && B.workDirs(f, 'windows').legacy })())

  // What Linux needs for the Vulkan backend beyond glslc.
  const haveAll = new Set(['/usr/include/vulkan/vulkan.h', '/usr/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake'])
  check('a complete Linux Vulkan setup lacks nothing', same(B.linuxVulkanGaps(true, p => haveAll.has(p), {}), []))
  check('glslc alone is not enough (the Fedora failure)', same(B.linuxVulkanGaps(true, p => p === '/usr/include/vulkan/vulkan.h', {}), ['the SPIR-V headers']))
  check('each missing part is named', same(B.linuxVulkanGaps(false, () => false, {}), ['the shader compiler (glslc)', 'the Vulkan headers', 'the SPIR-V headers']))
  check('the SPIR-V package is found in the other places distributions put it', ['/usr/lib64/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake', '/usr/local/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake', '/usr/lib/x86_64-linux-gnu/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake'].every(cfg => !B.linuxVulkanGaps(true, p => p === cfg || p === '/usr/include/vulkan/vulkan.h', {}).includes('the SPIR-V headers')))
  check('a prefix named in CMAKE_PREFIX_PATH counts', same(B.linuxVulkanGaps(true, p => ['/opt/sdk/include/vulkan/vulkan.h', '/opt/sdk/share/cmake/SPIRV-Headers/SPIRV-HeadersConfig.cmake'].includes(p), { CMAKE_PREFIX_PATH: '/opt/sdk' }), []))
  check('the LunarG SDK brings everything', same(B.linuxVulkanGaps(false, () => false, { VULKAN_SDK: '/opt/vulkan' }), []))
  check('the missing SPIR-V package gets a hint naming the packages', /spirv-headers-devel.*spirv-headers/.test(B.configureHint('  Could not find a package configuration file provided by "SPIRV-Headers"') || '') && B.configureHint('error C2065: x') === null)

  // A Linux build in that folder: its own clone and tree, the Windows ones untouched.
  mkClone(path.join(osFork, '.work', 'linux', 'source'), 'linux')
  fs.writeFileSync(path.join(osFork, '.source', 'windows-only.txt'), 'x')
  const osEngines = path.join(tmp, 'engines-os')
  const osLines = []
  const osRes = await B.buildFromSource({ repo: 'fake/osrepo', folderName: 'osrepo', type: 'cpu', extraArgs: [], rootDir: osEngines, pull: false }, { ...hooks(new AbortController().signal), log: (l, app) => osLines.push(l) })
  check('a build uses this OS\'s own clone and build tree', osRes.ok && fs.existsSync(path.join(osFork, '.work', 'linux', 'build', 'cpu', 'CMakeCache.txt')), osRes.error)
  check('the other OS\'s clone and build tree are left alone', fs.existsSync(path.join(osFork, '.source', 'windows-only.txt')) && fs.readFileSync(path.join(osFork, '.build', 'cpu', 'keep.txt'), 'utf8') === 'windows build' && !osLines.some(l => /from scratch|trying again/.test(l)))
  check('the installed build is shared and named for its OS-neutral version', osRes.ok && fs.existsSync(path.join(osFork, 'cpu', osRes.version, 'llama-server')))
  // Looking for the tools: one probe shared by everyone asking at once.
  const [tc1, tc2] = await Promise.all([B.detectToolchain(), B.detectToolchain()])
  check('simultaneous tool checks share one probe', tc1 === tc2)
  check('the shared probe is reused briefly', (await B.detectToolchain()) === tc1)
  B.invalidateToolchain()
  check('and looked up again after an install', (await B.detectToolchain()) !== tc1)

  // winget is an app execution alias on Windows: it is found by running it.
  if (process.platform !== 'win32') {
    const BT = bundle('src/main/buildTools.ts', 'buildtools')
    const fakeBin = path.join(tmp, 'fakebin')
    fs.mkdirSync(fakeBin, { recursive: true })
    fs.writeFileSync(path.join(fakeBin, 'winget'), '#!/bin/sh\necho v1.29.380\n', { mode: 0o755 })
    const realPath = process.env.PATH
    process.env.PATH = fakeBin + path.delimiter + realPath
    check('winget on the PATH is found by running it', (await BT.findWinget([])) === 'winget')
    process.env.PATH = realPath
    check('winget is not found when it is nowhere', (await BT.findWinget([])) === null)
    const aliasDir = path.join(tmp, 'WindowsApps')
    fs.mkdirSync(aliasDir, { recursive: true })
    const alias = path.join(aliasDir, 'winget.exe')
    fs.writeFileSync(alias, '#!/bin/sh\necho v1.29.380\n', { mode: 0o755 })
    check('winget is found in the aliases folder when the PATH lacks it', (await BT.findWinget([alias])) === alias)
    const dead = path.join(aliasDir, 'dead.exe')
    fs.writeFileSync(dead, '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    const plain = path.join(aliasDir, 'plain.exe')
    fs.writeFileSync(plain, 'not a program', { mode: 0o644 })
    // App Installer repair: tried once, only when winget cannot be found.
    const mk = (finds) => { const calls = { find: 0, repair: 0, refresh: 0 }; return { calls, deps: { find: async () => finds[Math.min(calls.find++, finds.length - 1)], repair: async () => { calls.repair++; return 'repaired' }, refreshEnv: async () => { calls.refresh++ } } } }
    let st = { repairAttempted: false, note: '' }
    let t1 = mk(['winget'])
    check('a winget that is found is used without any repair', (await BT.resolveWinget(t1.deps, st)) === 'winget' && t1.calls.repair === 0 && t1.calls.refresh === 0)
    st = { repairAttempted: false, note: '' }
    t1 = mk([null, 'winget'])
    check('a fresh environment can be enough, still without a repair', (await BT.resolveWinget(t1.deps, st)) === 'winget' && t1.calls.repair === 0 && t1.calls.refresh === 1)
    st = { repairAttempted: false, note: '' }
    t1 = mk([null, null, 'C:/WindowsApps/winget.exe'])
    check('App Installer is repaired when winget cannot be found, and winget is looked for again', (await BT.resolveWinget(t1.deps, st)) === 'C:/WindowsApps/winget.exe' && t1.calls.repair === 1 && st.note === 'repaired')
    st = { repairAttempted: false, note: '' }
    t1 = mk([null])
    check('winget that stays missing after the repair is reported missing', (await BT.resolveWinget(t1.deps, st)) === null && t1.calls.repair === 1)
    check('the repair is not attempted a second time', (await BT.resolveWinget(t1.deps, st)) === null && t1.calls.repair === 1)
    const seen = []
    const note = await BT.repairWinget(async (cmd, args) => { seen.push([cmd, args]); return { code: 0, stdout: '' } })
    check('the repair registers Microsoft.DesktopAppInstaller by family name', seen.length === 1 && seen[0][0] === 'powershell' && seen[0][1].includes('Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe') && /registered again/.test(note))
    // A command that goes quiet is reported as still running, and winget's download file shows what it is doing.
    const RL = bundle('src/main/runLogged.ts', 'runlogged')
    const hb = []
    const hbHooks = { log: l => hb.push(l), killTree: async () => {}, signal: new AbortController().signal }
    await RL.run('sh', ['-c', 'echo start; sleep 1.3; echo end'], hbHooks, { quiet: false, heartbeat: { everyMs: 400, describe: () => 'busy with X' } })
    check('a quiet command is reported as still running, with what it is doing', hb.filter(l => /^Still running after 0:0\d: busy with X$/.test(l)).length >= 2)
    check('its own output is still passed on', hb.includes('start') && hb.includes('end'))
    hb.length = 0
    await RL.run('sh', ['-c', 'for i in 1 2 3 4 5; do echo x; sleep 0.2; done'], hbHooks, { heartbeat: { everyMs: 600 } })
    check('a command that keeps printing is not reported', !hb.some(l => /Still running/.test(l)))
    hb.length = 0
    await RL.run('sh', ['-c', 'sleep 0.8'], hbHooks, { heartbeat: { everyMs: 300 } })
    check('without a description it says the command prints nothing while it works', hb.some(l => /Still running after 0:0\d \(it prints nothing while it works\)/.test(l)))
    const wingetTmp = path.join(tmp, 'wingettemp')
    const reporter = BT.wingetActivityReporter(wingetTmp)
    check('no download folder means nothing to report', reporter() === null)
    const installerDir = path.join(wingetTmp, 'WinGet', 'Nvidia.CUDA.13.4')
    fs.mkdirSync(installerDir, { recursive: true })
    const installerFile = path.join(installerDir, 'cuda.exe')
    fs.writeFileSync(installerFile, Buffer.alloc(5_000_000))
    check('the first look reports the size', /installer file is 0\.01 GB so far/.test(reporter()))
    fs.appendFileSync(installerFile, Buffer.alloc(3_000_000))
    check('a growing file is reported as downloading', /download is at 0\.01 GB \(3 MB more/.test(reporter()))
    check('a file that stopped growing is reported as the installer running, with the administrator prompt hint', /no longer growing.*installer itself is running.*administrator prompt/.test(reporter()))
    check('a failed repair says so with the reason', /failed \(exit code 1\).*not recognized/.test(await BT.repairWinget(async () => ({ code: 1, stdout: 'The term is not recognized' }))))
    check('a program that fails or cannot run is not taken for winget', (await BT.findWinget([dead, plain])) === null)
  }

  // A build folder made with another generator is started again, not an error.
  check('the requested generator is read from the arguments', B.requestedGenerator(['-DA=1', '-G', 'Ninja']) === 'Ninja' && B.requestedGenerator(['-GUnix Makefiles']) === 'Unix Makefiles' && B.requestedGenerator(['-DA=1']) === null)
  const cacheFile = path.join(forkDir, B.BUILD_DIRNAME, 'cpu', 'CMakeCache.txt')
  const madeWith = B.cachedGenerator(path.join(forkDir, B.BUILD_DIRNAME, 'cpu'))
  check('the generator of an existing build folder is read', typeof madeWith === 'string' && madeWith.length > 0, String(madeWith))
  fs.writeFileSync(cacheFile, fs.readFileSync(cacheFile, 'utf8').replace(/^CMAKE_GENERATOR:INTERNAL=.*$/m, 'CMAKE_GENERATOR:INTERNAL=Visual Studio 17 2022'))
  lines.length = 0
  const resGen = await B.buildFromSource({ ...job, extraArgs: ['-G', madeWith] }, hooks(new AbortController().signal))
  check('a folder made with another generator is started again and builds', resGen.ok && lines.some(l => /starting it again/.test(l)), resGen.error)
  lines.length = 0
  const resSame = await B.buildFromSource({ ...job, extraArgs: ['-G', madeWith] }, hooks(new AbortController().signal))
  check('the same generator keeps the folder (an incremental rebuild)', resSame.ok && !lines.some(l => /starting it again/.test(l)), resSame.error)

  // Ninja with clang on Windows runs inside the Visual Studio environment.
  const dump = ['=C:=C:\\work', 'ALLUSERSPROFILE=C:\\ProgramData', 'Path=C:\\Windows\\System32;C:\\VS\\bin', 'INCLUDE=C:\\SDK\\include', 'LIB=C:\\SDK\\lib', '', 'EMPTY=', 'no equals here'].join('\r\n')
  const parsed = B.parseSetOutput(dump)
  check('the output of set is read into variables', parsed.Path === 'C:\\Windows\\System32;C:\\VS\\bin' && parsed.INCLUDE === 'C:\\SDK\\include' && parsed.EMPTY === '' && Object.keys(parsed).every(k => !k.startsWith('=')) && !('no equals here' in parsed))
  const tool = { env: { HIP_PATH: 'R', ROCM_PATH: 'R', PATH: 'R/bin' + path.delimiter + 'process-path' }, pathDirs: ['R/bin', 'R/lib/llvm/bin'], cmakeArgs: [] }
  const merged = B.mergeBuildEnv(parsed, tool)
  check('the SDK folders go in front of the Visual Studio PATH, under its own spelling of the name', merged.Path === ['R/bin', 'R/lib/llvm/bin', 'C:\\Windows\\System32;C:\\VS\\bin'].join(path.delimiter) && !('PATH' in merged))
  check('the Visual Studio variables and the SDK ones are both there, without the process PATH', merged.INCLUDE === 'C:\\SDK\\include' && merged.LIB === 'C:\\SDK\\lib' && merged.HIP_PATH === 'R' && !merged.Path.includes('process-path'))
  const noPath = B.mergeBuildEnv({ INCLUDE: 'i' }, tool)
  check('a Visual Studio environment without a PATH still gets one', noPath.PATH === ['R/bin', 'R/lib/llvm/bin'].join(path.delimiter))
  check('the SDK toolchain reports its PATH folders', (() => { const t = M2.rocmToolchain(path.join(tmp, 'sys-full'), 'linux'); return t.pathDirs[0] === path.join(tmp, 'sys-full', 'bin') && t.env.PATH.startsWith(t.pathDirs.join(path.delimiter)) })())

  // The version of a build is a version tag, not a moving tag such as dev-latest.
  const labelRepo = path.join(tmp, 'label-repo')
  fs.mkdirSync(labelRepo, { recursive: true })
  const lg = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: labelRepo, stdio: 'ignore' })
  lg('init', '-q'); fs.writeFileSync(path.join(labelRepo, 'f'), '1'); lg('add', '.'); lg('commit', '-q', '-m', 'one')
  lg('tag', 'dev-latest')
  check('with only a moving tag the label falls back to it', (await B.sourceVersionLabel(labelRepo)) === 'dev-latest')
  lg('tag', 'b4000'); fs.writeFileSync(path.join(labelRepo, 'f'), '2'); lg('commit', '-q', '-am', 'two'); lg('tag', '-f', 'dev-latest')
  check('a moving tag on the newest commit does not hide the version tag behind it', /^b4000-g[0-9a-f]+$/.test(await B.sourceVersionLabel(labelRepo)), await B.sourceVersionLabel(labelRepo))
  lg('tag', 'b5000-2.1.0')
  check('a version tag on the commit itself is the label, even beside dev-latest', (await B.sourceVersionLabel(labelRepo)) === 'b5000-2.1.0')
  lg('tag', 'nightly'); lg('tag', 'b4999-9.9.9')
  check('of several version tags on the commit the highest is the label', (await B.sourceVersionLabel(labelRepo)) === 'b5000-2.1.0')
  // ... and the download of the same release is replaced by the build.
  const swapType = path.join(tmp, 'engines-swap', 'repo', 'rocm')
  fs.mkdirSync(path.join(swapType, 'b5000-2.1.0'), { recursive: true }); fs.mkdirSync(path.join(swapType, 'b5000-2.1.0-src'), { recursive: true })
  fs.writeFileSync(path.join(swapType, '.xlm-backend-type'), '')
  fs.writeFileSync(path.join(swapType, 'b5000-2.1.0-src', '.xlm-source.json'), JSON.stringify({ repo: 'x/y', branch: null, commit: 'c', type: 'rocm', extraArgs: [], builtAt: 5 }))
  await B.pruneSupersededBuilds([path.join(tmp, 'engines-swap')], 'repo')
  check('the downloaded binary of the same version is deleted when it was built locally', !fs.existsSync(path.join(swapType, 'b5000-2.1.0')) && fs.existsSync(path.join(swapType, 'b5000-2.1.0-src')))

  // Update pulls the branch; Rebuild compiles the source as it is.
  lines.length = 0
  const resNoPull = await B.buildFromSource({ ...job, extraArgs: [], pull: false }, hooks(new AbortController().signal))
  check('a rebuild does not pull the branch', resNoPull.ok && lines.some(l => /not pulled/.test(l)) && !lines.some(l => /Updating the source/.test(l)), resNoPull.error)
  lines.length = 0
  const resPull = await B.buildFromSource({ ...job, extraArgs: [] }, hooks(new AbortController().signal))
  check('an update pulls the branch first', resPull.ok && lines.some(l => /Updating the source/.test(l)) && !lines.some(l => /not pulled/.test(l)), resPull.error)

  // A build for a specific CUDA toolkit is told which one, and remembers it.
  const pipeCuda = path.join(tmp, 'pipe-cuda-12.4')
  fs.mkdirSync(path.join(pipeCuda, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(pipeCuda, 'bin', 'nvcc'), '')
  lines.length = 0
  // A downloaded CUDA installer is only kept until a build has worked.
  const leftInstaller = path.join(job.rootDir, '.sdk', 'cuda', 'cuda_12.4.1_windows_x86_64.exe')
  fs.mkdirSync(path.dirname(leftInstaller), { recursive: true }); fs.writeFileSync(leftInstaller, 'installer')
  const resCuda = await B.buildFromSource({ ...job, type: 'cuda-12.4', extraArgs: [], cudaRoot: pipeCuda }, hooks(new AbortController().signal))
  check('a successful CUDA build removes the downloaded installer', resCuda.ok && !fs.existsSync(leftInstaller))
  const seenCuda = k => lines.find(l => l.includes(`SEEN ${k}=`)) || ''
  check('a CUDA 12.4 build installs under its own type folder', resCuda.ok && resCuda.versionDir.includes(`${path.sep}cuda-12.4${path.sep}`), resCuda.error)
  check('CMake is told the toolkit root and the environment names it', seenCuda('CUDAROOT').endsWith(pipeCuda) && seenCuda('CUDAENV').endsWith(pipeCuda))
  check('the compiler argument names that toolkit\'s nvcc', lines.some(l => l.startsWith('A $ cmake') && l.includes(`-DCMAKE_CUDA_COMPILER=${path.join(pipeCuda, 'bin', 'nvcc')}`)))
  check('the toolkit is recorded for launch', resCuda.ok && B.readSourceMarker(resCuda.versionDir).cudaRoot === pipeCuda)

  // Cancelling kills the running tool and reports it.
  const ac = new AbortController()
  const h = hooks(ac.signal)
  const origProgress = h.progress
  h.progress = p => { origProgress(p); if (p === 'configuring') setTimeout(() => ac.abort(), 5) }
  fs.rmSync(path.join(forkDir, B.BUILD_DIRNAME), { recursive: true, force: true })
  const res3 = await B.buildFromSource({ ...job, type: 'cpu' }, h)
  check('a cancelled build reports cancelled and installs nothing new', !res3.ok && res3.cancelled === true)

  // A failing configure is reported, with the tool output in the log.
  lines.length = 0
  fs.writeFileSync(path.join(src, 'CMakeLists.txt'), 'this is not cmake\n')
  git('commit', '-q', '-am', 'break')
  const res4 = await B.buildFromSource(job, hooks(new AbortController().signal))
  check('a failed configure is an error naming the step', !res4.ok && /Configuring failed/.test(res4.error), res4.error)
  check('the failing output is in the log', lines.some(l => l.startsWith('O ') && /CMake Error/i.test(l)))
}


// -- ROCm SDK download and use, against a local server ----------------------------
async function rocmFlow() {
  if (process.platform !== 'linux' || !have('tar')) { console.log('SKIP  ROCm SDK flow (needs Linux and tar)'); return }
  const http = require('http')
  const M = bundle('src/main/rocmSdk.ts', 'rocmsdk')
  const files = {} // name -> Buffer, served under /stable/ and /nightly/

  // A tiny SDK: bin/hipcc and lib/llvm/bin/clang, inside a top folder like the real ones.
  const makeTarball = (name, topDir) => {
    const src = fs.mkdtempSync(path.join(tmp, 'sdk-src-'))
    const base = path.join(src, topDir)
    fs.mkdirSync(path.join(base, 'bin'), { recursive: true })
    fs.mkdirSync(path.join(base, 'lib', 'llvm', 'bin'), { recursive: true })
    for (const f of ['bin/hipcc', 'lib/llvm/bin/clang', 'lib/llvm/bin/clang++']) fs.writeFileSync(path.join(base, f), '#!/bin/sh\n', { mode: 0o755 })
    fs.writeFileSync(path.join(base, 'padding.bin'), Buffer.alloc(200000, 7))
    const out = path.join(tmp, name)
    execFileSync('tar', ['-czf', out, '-C', src, topDir])
    files[name] = fs.readFileSync(out)
  }
  makeTarball('therock-dist-linux-gfx110X-all-10.1.0.tar.gz', 'therock-dist')
  makeTarball('therock-dist-linux-gfx1151-10.1.0.tar.gz', '.')
  makeTarball('therock-dist-linux-gfx120X-all-7.14.0a20260612.tar.gz', 'therock-dist')

  let nightlyPages = 0
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/stable/') {
      // An index page that lists only the 110X release.
      res.setHeader('content-type', 'text/html')
      return res.end('<html><a href="therock-dist-linux-gfx110X-all-10.1.0.tar.gz">x</a></html>')
    }
    if (u.pathname === '/nightly/' && u.searchParams.get('list-type') === '2') {
      // Two pages of results, the second reached by the continuation token.
      nightlyPages++
      const prefix = u.searchParams.get('prefix')
      const all = Object.keys(files).filter(n => n.startsWith(prefix))
      const second = u.searchParams.get('continuation-token') === 'next'
      const keys = all.length > 1 && !second ? [all[0]] : all.length > 1 ? all.slice(1) : all
      res.setHeader('content-type', 'application/xml')
      return res.end(`<ListBucketResult><IsTruncated>${all.length > 1 && !second}</IsTruncated>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}${all.length > 1 && !second ? '<NextContinuationToken>next</NextContinuationToken>' : ''}</ListBucketResult>`)
    }
    const m = /^\/(stable|nightly)\/(therock-dist-[^/]+)$/.exec(u.pathname)
    const body = m && files[m[2]]
    if (!body) { res.statusCode = 404; return res.end('no') }
    res.setHeader('content-length', body.length)
    if (req.method === 'HEAD') return res.end()
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  const sources = { stable: [{ kind: 'html', base: `${base}/stable/`, probeVersions: ['10.1.0'] }], nightly: [{ kind: 's3', base: `${base}/nightly/` }] }
  const notes = []

  const a = await M.resolveRocmTarball('stable', 'linux', 'gfx110X', { sources })
  check('stable: the index page is read and the release resolved with its size', a && a.tarball.version === '10.1.0' && a.channel === 'stable' && a.size === files['therock-dist-linux-gfx110X-all-10.1.0.tar.gz'].length)
  const b = await M.resolveRocmTarball('stable', 'linux', 'gfx1151', { sources })
  check('stable: a name missing from the index is found by asking for it', b && b.tarball.name === 'therock-dist-linux-gfx1151-10.1.0.tar.gz' && b.channel === 'stable')
  const c = await M.resolveRocmTarball('stable', 'linux', 'gfx120X', { sources, note: l => notes.push(l) })
  check('stable: a family with no release falls back to the nightlies and says so', c && c.channel === 'nightly' && c.tarball.version === '7.14.0a20260612' && notes.some(n => /nightly/.test(n)))
  const d = await M.resolveRocmTarball('nightly', 'windows', 'gfx110X', { sources })
  check('nothing for another OS is null', d === null)
  check('the S3 listing was asked for with a prefix and paged', nightlyPages >= 1)

  // Install
  const rootDir = path.join(tmp, 'engines-rocm')
  const logs = []
  let lastPct = -1
  const hooks = { log: l => logs.push(l), killTree: async () => {}, signal: new AbortController().signal, progress: p => { lastPct = p } }
  const r1 = await M.installRocmSdk({ rootDir, family: 'gfx110X', channel: 'stable', os: 'linux', sources }, hooks)
  check('install succeeds and reports progress to 100', r1.ok && r1.changed && lastPct === 100, r1.error)
  const inst = M.findInstalledRocm(rootDir, 'gfx110X')
  check('the SDK root is found inside the top folder', inst && inst.version === '10.1.0' && fs.existsSync(path.join(inst.root, 'bin', 'hipcc')) && inst.root.endsWith('therock-dist'))
  check('the archive is removed after unpacking', !fs.existsSync(path.join(rootDir, '.sdk', 'rocm', '.download', 'therock-dist-linux-gfx110X-all-10.1.0.tar.gz')))
  check('a family that is not installed is not found', M.findInstalledRocm(rootDir, 'gfx1151') === null)
  const r2 = await M.installRocmSdk({ rootDir, family: 'gfx110X', channel: 'stable', os: 'linux', sources }, hooks)
  check('installing again is a no-op', r2.ok && r2.changed === false)
  check('no update is offered at the newest version', (await M.rocmUpdateAvailable(rootDir, 'gfx110X', 'stable', 'linux', { sources })) === false)

  // An SDK with no top folder
  const r3 = await M.installRocmSdk({ rootDir, family: 'gfx1151', channel: 'stable', os: 'linux', sources }, hooks)
  const inst3 = M.findInstalledRocm(rootDir, 'gfx1151')
  check('an archive without a top folder installs too', r3.ok && inst3 && fs.existsSync(path.join(inst3.root, 'bin', 'hipcc')))

  // A newer release appears on the nightly channel
  makeTarball('therock-dist-linux-gfx110X-all-10.2.0.tar.gz', 'therock-dist')
  check('an update is offered when a channel has a newer SDK', (await M.rocmUpdateAvailable(rootDir, 'gfx110X', 'nightly', 'linux', { sources })) === true)
  check('the listing is trusted when readable: the stable index still offers 10.1.0', (await M.resolveRocmTarball('stable', 'linux', 'gfx110X', { sources })).tarball.version === '10.1.0')
  // Another system sharing the engines folder has an SDK of its own there (made before the OS was recorded).
  const winSdk = path.join(rootDir, '.sdk', 'rocm', '9.5.0-gfx110X')
  fs.mkdirSync(path.join(winSdk, 'bin'), { recursive: true }); fs.writeFileSync(path.join(winSdk, 'bin', 'hipcc.exe'), '')
  fs.writeFileSync(path.join(winSdk, '.xlm-rocm.json'), JSON.stringify({ version: '9.5.0', family: 'gfx110X', source: 'tarball', rootRel: '.', channel: 'stable' }))
  check('an SDK with Windows tools is a Windows SDK, not a Linux one', M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', 'windows')?.dir === winSdk && M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', 'linux')?.version !== '9.5.0')
  check('an install records the OS and names its folder for it', JSON.parse(fs.readFileSync(path.join(M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', 'linux').dir, '.xlm-rocm.json'), 'utf8')).os === 'linux' && /-gfx110X-linux$/.test(M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', 'linux').dir))
  check('no SDK is found for an OS ROCm does not exist for', M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', null) === null)
  const r4 = await M.installRocmSdk({ rootDir, family: 'gfx110X', channel: 'nightly', os: 'linux', sources }, hooks)
  check('updating installs the newer SDK', r4.ok && r4.changed && M.findInstalledRocm(rootDir, 'gfx110X').version === '10.2.0', r4.error)
  check('installing for one OS leaves the other OS\'s SDK alone, whatever the versions', fs.existsSync(path.join(winSdk, 'bin', 'hipcc.exe')) && M.findInstalledRocm(rootDir, 'gfx110X', 'tarball', 'windows')?.version === '9.5.0')
  check('and removes the superseded one', !fs.existsSync(inst.dir))

  // Cancelled before the download starts
  const ac = new AbortController(); ac.abort()
  const r5 = await M.installRocmSdk({ rootDir: path.join(tmp, 'engines-cancel'), family: 'gfx110X', channel: 'stable', os: 'linux', sources }, { ...hooks, signal: ac.signal })
  check('a cancelled install reports it and leaves nothing installed', !r5.ok && r5.error === 'Cancelled' && M.findInstalledRocm(path.join(tmp, 'engines-cancel')) === null)
  // Nothing found
  const r6 = await M.installRocmSdk({ rootDir: path.join(tmp, 'engines-none'), family: 'gfx900', channel: 'stable', os: 'linux', sources }, hooks)
  check('no SDK for the family is a clear error', !r6.ok && /No ROCm SDK for gfx900/.test(r6.error))

  // How a build uses it
  const tcLinux = M.rocmToolchain(inst3.root, 'linux')
  check('Linux: HIPCXX, HIP_PATH and PATH point at the SDK', tcLinux.env.HIPCXX === path.join(inst3.root, 'lib', 'llvm', 'bin', 'clang') && tcLinux.env.HIP_PATH === inst3.root && tcLinux.env.PATH.startsWith(path.join(inst3.root, 'bin')) && tcLinux.cmakeArgs.includes(`-DCMAKE_PREFIX_PATH=${inst3.root}`))
  fs.writeFileSync(path.join(inst3.root, 'lib', 'llvm', 'bin', 'clang.exe'), '')
  const tcWin = M.rocmToolchain(inst3.root, 'win32')
  check('Windows: Ninja and the SDK clang are the generator and compilers', tcWin.cmakeArgs.includes('Ninja') && tcWin.cmakeArgs.some(a => a.startsWith('-DCMAKE_CXX_COMPILER=') && a.endsWith('clang++.exe')) && !('HIPCXX' in tcWin.env))

  // A ROCm build: the target and the SDK environment reach CMake.
  if (have('git') && have('cmake') && (have('c++') || have('g++'))) {
    const B = bundle('src/main/sourceBuild.ts', 'build3')
    const engines = rootDir
    const sdk110 = M.findInstalledRocm(rootDir, 'gfx110X')
    const src = path.join(engines, 'fake-rocm', B.SOURCE_DIRNAME)
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'CMakeLists.txt'),
      'cmake_minimum_required(VERSION 3.10)\nproject(fake CXX)\n' +
      'message(STATUS "SEEN HIPCXX=$ENV{HIPCXX}")\nmessage(STATUS "SEEN HIP_PATH=$ENV{HIP_PATH}")\nmessage(STATUS "SEEN AMDGPU_TARGETS=${AMDGPU_TARGETS}")\nmessage(STATUS "SEEN PREFIX=${CMAKE_PREFIX_PATH}")\n' +
      'add_executable(llama-server main.cpp)\nset_target_properties(llama-server PROPERTIES RUNTIME_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/bin)\n')
    fs.writeFileSync(path.join(src, 'main.cpp'), 'int main() { return 0; }\n')
    const g = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src, stdio: 'ignore' })
    g('init', '-q'); g('add', '.'); g('commit', '-q', '-m', 'init'); g('tag', 'b2000')
    const lines = []
    const res = await B.buildFromSource(
      { repo: 'fake/rocm', folderName: 'fake-rocm', type: 'rocm', extraArgs: [], gpuTarget: 'gfx1100', rocmRoot: sdk110.root, rootDir: engines },
      { log: l => lines.push(l), progress: () => {}, killTree: async () => {}, signal: new AbortController().signal }
    )
    check('a ROCm build succeeds', res.ok, res.error)
    const seen = k => lines.find(l => l.includes(`SEEN ${k}=`)) || ''
    check('the build saw the SDK compiler, HIP_PATH and prefix', seen('HIPCXX').endsWith(path.join(sdk110.root, 'lib', 'llvm', 'bin', 'clang')) && seen('HIP_PATH').endsWith(sdk110.root) && seen('PREFIX').endsWith(sdk110.root))
    check('the build saw the GPU target', seen('AMDGPU_TARGETS').endsWith('gfx1100'))
    const runEnv = res.ok ? B.engineRuntimeEnv(res.versionDir) : undefined
    check('the built engine starts with the SDK libraries on its library path', runEnv && runEnv.LD_LIBRARY_PATH.split(path.delimiter).includes(path.join(sdk110.root, 'lib')) && runEnv.HIP_PATH === sdk110.root)
    check('an engine that is not a ROCm build needs nothing extra', B.engineRuntimeEnv(path.join(tmp, 'nowhere')) === undefined)
    // The SDK a build needs at launch: the one it was built against, else an installed one, else one found on the machine.
    const fakeVersion = (name, marker) => {
      const dir = path.join(rootDir, name, 'rocm', 'b1-src')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, '.xlm-source.json'), JSON.stringify({ repo: 'x/y', branch: null, commit: 'c', type: 'rocm', extraArgs: [], builtAt: 1, ...marker }))
      return dir
    }
    const saved = process.env.HIP_PATH
    const mkDirs = (name, files) => { const d = path.join(tmp, name); for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), '') } return d }
    const rtBuilt = mkDirs('rt-built-sdk', ['lib/libamdhip64.so', 'bin/amdhip64.dll'])
    const sysFull = mkDirs('rt-system-sdk', ['lib/cmake/hip/hip-config.cmake', 'lib/llvm/bin/clang', 'bin/clang.exe'])
    const built = fakeVersion('built-against', { gpuTarget: 'gfx1201', rocmRoot: rtBuilt })
    check('an engine is started with the SDK it was built against on its library path', B.engineRuntimeEnv(built).HIP_PATH === rtBuilt && B.engineRuntimeEnv(built).LD_LIBRARY_PATH.split(path.delimiter).includes(path.join(rtBuilt, 'lib')))
    const legacy = fakeVersion('built-before-recording', { gpuTarget: 'gfx1201' })
    process.env.HIP_PATH = sysFull
    check('an older build without the SDK recorded falls back to the one found on the machine', B.engineRuntimeEnv(legacy).HIP_PATH === sysFull)
    const gone = fakeVersion('sdk-removed', { gpuTarget: 'gfx1201', rocmRoot: path.join(tmp, 'no-such-sdk') })
    check('a recorded SDK that is gone is replaced by the one found on the machine', B.engineRuntimeEnv(gone).HIP_PATH === sysFull)
    delete process.env.HIP_PATH
    process.env.PATH = (process.env.PATH || '').split(path.delimiter).filter(d => !fs.existsSync(path.join(d, 'hipcc'))).join(path.delimiter)
    check('with no SDK known the environment is left alone', B.engineRuntimeEnv(gone) === undefined)
    if (saved !== undefined) process.env.HIP_PATH = saved
    check('the SDK the build used is recorded for launch', res.ok && (() => { try { return JSON.parse(fs.readFileSync(path.join(res.versionDir, '.xlm-source.json'), 'utf8')).rocmRoot === sdk110.root } catch { return false } })())
    // CUDA: where the toolkit is, how a Windows build is generated, what a launch needs.
    const CU = bundle('src/main/cudaSdk.ts', 'cudasdk')
    const cudaA = mkDirs('rt-cuda-a', ['bin/nvcc', 'bin/nvcc.exe', 'lib64/libcudart.so', 'bin/x64/cudart64_13.dll'])
    const cudaB = mkDirs('rt-cuda-b', ['bin/nvcc', 'bin/nvcc.exe', 'bin/cudart64_12.dll', 'lib/x64/cudart.lib'])
    const keepEnv = { CUDA_PATH: process.env.CUDA_PATH, CUDA_HOME: process.env.CUDA_HOME, PATH: process.env.PATH }
    delete process.env.CUDA_HOME
    process.env.CUDA_PATH = cudaA + '/'
    check('the CUDA Toolkit is found from CUDA_PATH', CU.systemCudaRoot() === cudaA)
    process.env.CUDA_PATH = path.join(tmp, 'rt-no-cuda')
    process.env.PATH = path.join(cudaB, 'bin') + path.delimiter + keepEnv.PATH
    check('or from the nvcc on the PATH, when CUDA_PATH points nowhere', CU.systemCudaRoot() === cudaB)
    check('Windows CUDA builds use Ninja unless the user chose a generator', same(CU.cudaGeneratorArgs('win32', []), ['-G', 'Ninja']) && same(CU.cudaGeneratorArgs('win32', ['-G', 'Visual Studio 17 2022']), []) && same(CU.cudaGeneratorArgs('linux', []), []))
    check('a CUDA 13 toolkit on Windows gets its bin\\x64 and bin on the PATH', (() => { const e = CU.cudaRuntimeEnv(cudaA, 'win32'); const k = Object.keys(e).find(x => x.toLowerCase() === 'path'); return e[k].startsWith(path.join(cudaA, 'bin', 'x64') + path.delimiter + path.join(cudaA, 'bin')) && e.CUDA_PATH === cudaA })())
    check('on Linux lib64 goes on the library path', CU.cudaRuntimeEnv(cudaA, 'linux').LD_LIBRARY_PATH.split(path.delimiter)[0] === path.join(cudaA, 'lib64'))
    const cudaBuilt = fakeVersion('cuda-built', { type: 'cuda', cudaRoot: cudaA })
    check('a CUDA engine is started with the toolkit it was built against', B.engineRuntimeEnv(cudaBuilt).CUDA_PATH === cudaA && B.engineRuntimeEnv(cudaBuilt).LD_LIBRARY_PATH.split(path.delimiter).includes(path.join(cudaA, 'lib64')))
    const cudaOld = fakeVersion('cuda-built-before', { type: 'cuda' })
    check('an older CUDA build uses the toolkit found on the machine', B.engineRuntimeEnv(cudaOld).CUDA_PATH === cudaB)
    for (const [k, v] of Object.entries(keepEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    check('a CUDA build on Windows needs Ninja, on Linux not', T.requiredToolsFor('cuda', 'win32').includes('ninja') && !T.requiredToolsFor('cuda', 'linux').includes('ninja'))
    check('the GPU target is remembered for rebuilds', res.ok && B.scanSourceBuilds([engines], 'fake-rocm', null)[0].gpuTarget === 'gfx1100')
  }

  // -- the pip route, against a local index with stand-in wheels --------------------
  const pyOk = have('python3') && (() => { try { execFileSync('python3', ['-c', 'import venv, ensurepip'], { stdio: 'ignore' }); return true } catch { return false } })()
  if (pyOk) {
    const makeWheel = (version, withCompilers) => {
      const out = path.join(tmp, `rocm-${version}-${withCompilers ? 'ok' : 'nocc'}-py3-none-any.whl`)
      execFileSync('python3', ['-c', `
import zipfile, sys
out, ver, cc = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
cli = "import sys, os\\ndef main():\\n    here = os.path.dirname(os.path.abspath(__file__))\\n    a = sys.argv[1:]\\n    if a[:1] == ['path'] and '--root' in a: print(os.path.join(here, '_rocm_sdk_core'))\\n    elif a[:1] == ['init']: print('init ok')\\n"
dist = 'rocm-%s.dist-info' % ver
files = {'rocm_cli.py': cli,
  '_rocm_sdk_core/lib/libamdhip64.so': 'x',
  dist + '/METADATA': 'Metadata-Version: 2.1\\nName: rocm\\nVersion: %s\\nProvides-Extra: devel\\nProvides-Extra: libraries\\nProvides-Extra: device-gfx1100\\nProvides-Extra: device-all\\n' % ver,
  dist + '/WHEEL': 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n',
  dist + '/entry_points.txt': '[console_scripts]\\nrocm-sdk = rocm_cli:main\\n'}
if cc:
    for f in ['bin/hipcc', 'lib/llvm/bin/clang', 'lib/llvm/bin/clang++']: files['_rocm_sdk_core/' + f] = '#!/bin/sh\\n'
files[dist + '/RECORD'] = ''.join(n + ',,\\n' for n in files) + dist + '/RECORD,,\\n'
with zipfile.ZipFile(out, 'w') as z:
    for n, c in files.items():
        zi = zipfile.ZipInfo(n); zi.external_attr = 0o755 << 16
        z.writestr(zi, c)
`, out, version, withCompilers ? '1' : '0'])
      return out
    }
    const wheels = { '10.1.0': makeWheel('10.1.0', true), '10.2.0': makeWheel('10.2.0', true), '9.0.0-broken': null }
    wheels['9.0.0'] = makeWheel('9.0.0', false)
    let pipVersions = ['10.1.0']
    const requests = []
    const previous = server.listeners('request')[0]
    server.removeAllListeners('request')
    server.on('request', (req, res) => {
      const u = new URL(req.url, 'http://x')
      requests.push(u.pathname)
      if (!/^\/(whl|whl-broken|files)\//.test(u.pathname)) return previous(req, res)
      const m = /^\/(whl|whl-broken)\/rocm\/$/.exec(u.pathname)
      if (m) {
        const vs = m[1] === 'whl' ? pipVersions : ['9.0.0']
        res.setHeader('content-type', 'text/html')
        const hash = v => require('crypto').createHash('sha256').update(fs.readFileSync(wheels[v])).digest('hex')
        return res.end('<html><body>' + vs.map(v => `<a href="/files/${m[1]}/rocm-${v}-py3-none-any.whl#sha256=${hash(v)}">rocm-${v}-py3-none-any.whl</a>`).join('<br>') + '</body></html>')
      }
      const f = /^\/files\/(whl|whl-broken)\/rocm-([0-9.]+)-py3-none-any\.whl$/.exec(u.pathname)
      if (f && wheels[f[2]]) { const b = fs.readFileSync(wheels[f[2]]); res.setHeader('content-length', b.length); return res.end(b) }
      res.statusCode = 404; res.end('no')
    })
    const index = `${base}/whl/`
    const python = await M.findPython()
    check('a supported Python is found', python && /^3\.(11|12|13|14)$/.test(python.version))
    check('the newest release is read from the index', (await M.latestPipVersion(M.defaultHttp, index)) === '10.1.0')

    const pipRoot = path.join(tmp, 'engines-pip')
    const pipLogs = []
    const pipHooks = { log: l => pipLogs.push(l), killTree: async () => {}, signal: new AbortController().signal }
    const p1 = await M.installRocmSdk({ rootDir: pipRoot, family: 'gfx110X', gfx: 'gfx1100', channel: 'stable', os: 'linux', source: 'pip', pipIndex: index, python }, pipHooks)
    if (!p1.ok) console.log(pipLogs.slice(-25).join('\n'))
    check('pip install succeeds', p1.ok && p1.changed, p1.error)
    const pipInst = M.findInstalledRocm(pipRoot, 'gfx110X', 'pip')
    check('the SDK root is found through rocm-sdk, with compilers', pipInst && pipInst.source === 'pip' && pipInst.version === '10.1.0' && fs.existsSync(path.join(pipInst.root, 'bin', 'hipcc')) && fs.existsSync(path.join(pipInst.root, 'lib', 'llvm', 'bin', 'clang++')), JSON.stringify(pipInst))
    check('the install folder is named for version, family and source', pipInst && path.basename(pipInst.dir) === '10.1.0-gfx110X-pip-linux')
    check('the extra for the GPU was asked for', pipLogs.join('\n').includes('rocm[devel,libraries,device-gfx1100]') || pipLogs.some(l => /rocm\[devel,libraries,device-gfx1100\]==10\.1\.0/.test(l)))
    check('looking for a tarball SDK does not find the pip one', M.findInstalledRocm(pipRoot, 'gfx110X', 'tarball') === null && M.findInstalledRocm(pipRoot, 'gfx110X') !== null)
    const p2 = await M.installRocmSdk({ rootDir: pipRoot, family: 'gfx110X', gfx: 'gfx1100', channel: 'stable', os: 'linux', source: 'pip', pipIndex: index, python }, pipHooks)
    check('installing again is a no-op', p2.ok && p2.changed === false)
    check('no update is offered at the newest version', (await M.rocmUpdateAvailable(pipRoot, 'gfx110X', 'stable', 'linux', { source: 'pip', pipIndex: index })) === false)
    pipVersions = ['10.1.0', '10.2.0']
    check('an update is offered when the index has a newer release', (await M.rocmUpdateAvailable(pipRoot, 'gfx110X', 'stable', 'linux', { source: 'pip', pipIndex: index })) === true)
    const p3 = await M.installRocmSdk({ rootDir: pipRoot, family: 'gfx110X', gfx: 'gfx1100', channel: 'stable', os: 'linux', source: 'pip', pipIndex: index, python }, pipHooks)
    check('updating installs the newer wheels and removes the old environment', p3.ok && p3.changed && M.findInstalledRocm(pipRoot, 'gfx110X', 'pip').version === '10.2.0' && !fs.existsSync(pipInst.dir), p3.error)

    // Switching to the tarball replaces the pip install, and the other way round.
    const sw = await M.installRocmSdk({ rootDir: pipRoot, family: 'gfx110X', channel: 'stable', os: 'linux', source: 'tarball', sources }, hooks)
    check('switching to the tarball replaces the pip SDK', sw.ok && M.findInstalledRocm(pipRoot, 'gfx110X', 'pip') === null && M.findInstalledRocm(pipRoot, 'gfx110X', 'tarball') !== null, sw.error)

    // Wheels without compilers: a clear error pointing at the tarball, and nothing left behind.
    const broken = await M.installRocmSdk({ rootDir: path.join(tmp, 'engines-pip-broken'), family: 'gfx110X', gfx: 'gfx1100', channel: 'stable', os: 'linux', source: 'pip', pipIndex: `${base}/whl-broken/`, python }, pipHooks)
    check('wheels without compilers are an error that names the tarball', !broken.ok && /tarball/.test(broken.error) && /rocm\[devel\]/.test(broken.error), broken.error)
    check('a failed pip install leaves no environment behind', !fs.existsSync(path.join(tmp, 'engines-pip-broken', '.sdk', 'rocm', '9.0.0-gfx110X-pip-linux')))
    // No GPU chosen
    const noGpu = await M.installRocmSdk({ rootDir: path.join(tmp, 'engines-pip-none'), family: 'gfx110X', channel: 'stable', os: 'linux', source: 'pip', pipIndex: index, python }, pipHooks)
    check('pip needs a GPU to pick the device extra', !noGpu.ok && /Choose your GPU/.test(noGpu.error))
  } else {
    console.log('SKIP  pip route (needs python3 with venv and ensurepip)')
  }

  // -- an SDK that is already on the machine ----------------------------------------
  const mkSdk = (name, files) => {
    const d = path.join(tmp, name)
    for (const f of files) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), '') }
    return d
  }
  const hipEnv = { HIP_PATH: process.env.HIP_PATH, ROCM_PATH: process.env.ROCM_PATH, PATH: process.env.PATH }
  const restoreEnv = () => { for (const [k, v] of Object.entries(hipEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
  const full = mkSdk('sys-full', ['lib/cmake/hip/hip-config.cmake', 'lib/llvm/bin/clang', 'bin/hipcc'])
  const classic = mkSdk('sys-classic', ['lib/cmake/hip/hip-config.cmake', 'bin/clang', 'bin/clang.exe', 'bin/hipcc', 'bin/hipcc.exe'])
  const runtimeOnly = mkSdk('sys-runtime', ['bin/hipcc', 'bin/hipcc.exe', 'bin/amdhip64.dll'])
  delete process.env.ROCM_PATH
  process.env.HIP_PATH = full + '/'
  check('a complete SDK named by HIP_PATH is found (trailing slash ignored)', M.systemHipRoot() === full)
  process.env.HIP_PATH = runtimeOnly
  process.env.PATH = path.join(runtimeOnly, 'bin') + path.delimiter + hipEnv.PATH
  check('hipcc without the HIP CMake package is not a usable SDK', M.systemHipRoot() === null && !M.isUsableSdkRoot(runtimeOnly))
  delete process.env.HIP_PATH
  process.env.PATH = path.join(classic, 'bin') + path.delimiter + hipEnv.PATH
  check('an SDK is found from the hipcc on the PATH, with clang beside it', M.systemHipRoot() === classic)
  restoreEnv()
  // The device libraries clang needs are searched for, wherever the SDK keeps them.
  const withLibs = mkSdk('sdk-libs', ['lib/llvm/bin/clang', 'lib/llvm/amdgcn/bitcode/ocml.bc', 'lib/llvm/amdgcn/bitcode/ockl.bc'])
  const deepLibs = mkSdk('sdk-deep', ['lib/llvm/bin/clang', 'lib/llvm/lib/clang/23/lib/amdgcn/bitcode/ocml.bc'])
  const noLibs = mkSdk('sdk-nolibs', ['lib/llvm/bin/clang', 'bin/hipcc', 'lib/libamdhip64.so'])
  check('device libraries are found next to clang', M.findDeviceLibDir(withLibs) === path.join(withLibs, 'lib', 'llvm', 'amdgcn', 'bitcode'))
  check('and deeper, in the clang resource folder', M.findDeviceLibDir(deepLibs) === path.join(deepLibs, 'lib', 'llvm', 'lib', 'clang', '23', 'lib', 'amdgcn', 'bitcode'))
  check('an SDK without them has none', M.findDeviceLibDir(noLibs) === null)
  const tcLibs = M.rocmToolchain(withLibs, 'linux')
  check('clang is told where they are, by environment and by flag', tcLibs.deviceLibDir === path.join(withLibs, 'lib', 'llvm', 'amdgcn', 'bitcode') && tcLibs.env.HIP_DEVICE_LIB_PATH === tcLibs.deviceLibDir && tcLibs.cmakeArgs.some(a => a.startsWith('-DCMAKE_CXX_FLAGS=--rocm-device-lib-path=') && a.includes('-Wno-unused-command-line-argument')) && tcLibs.cmakeArgs.some(a => a.startsWith('-DCMAKE_HIP_FLAGS=--rocm-device-lib-path=')))
  const tcNone = M.rocmToolchain(noLibs, 'linux')
  check('nothing is passed when the SDK has none', tcNone.deviceLibDir === null && !('HIP_DEVICE_LIB_PATH' in tcNone.env) && !tcNone.cmakeArgs.some(a => a.includes('device-lib-path')))
  const tcClassic = M.rocmToolchain(classic, 'win32')
  check("AMD's classic Windows layout (clang in bin) gets Ninja and that clang", tcClassic.cmakeArgs.includes('Ninja') && tcClassic.cmakeArgs.some(a => a === `-DCMAKE_CXX_COMPILER=${path.join(classic, 'bin', 'clang++.exe')}`))

  // -- the CUDA Toolkit: toolkits side by side, and the installer fetched by the app ---
  const CU2 = bundle('src/main/cudaSdk.ts', 'cudasdk2')
  const CI = bundle('src/main/cudaInstaller.ts', 'cudainstaller')
  const mkToolkit = (name, version, withJson = true) => {
    const d = path.join(tmp, name)
    fs.mkdirSync(path.join(d, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(d, 'bin', 'nvcc'), ''); fs.writeFileSync(path.join(d, 'bin', 'nvcc.exe'), '')
    if (withJson) fs.writeFileSync(path.join(d, 'version.json'), JSON.stringify({ cuda: { name: 'CUDA SDK', version } }))
    return d
  }
  const tk124 = mkToolkit('CUDA-v12.4', '12.4.1')
  const tk134 = mkToolkit('CUDA-v13.4', '13.4.1')
  const tkOld = mkToolkit('cuda-11.8', '', false)
  const cudaEnvKeep = { CUDA_PATH: process.env.CUDA_PATH, CUDA_HOME: process.env.CUDA_HOME, PATH: process.env.PATH, a: process.env.CUDA_PATH_V12_4, b: process.env.CUDA_PATH_V13_4, c: process.env.CUDA_PATH_V11_8 }
  const setCudaEnv = (env) => { for (const k of ['CUDA_PATH', 'CUDA_HOME', 'CUDA_PATH_V12_4', 'CUDA_PATH_V13_4', 'CUDA_PATH_V11_8']) delete process.env[k]; Object.assign(process.env, env) }
  setCudaEnv({ CUDA_PATH: tk124, CUDA_PATH_V12_4: tk124, CUDA_PATH_V13_4: tk134 })
  check('a toolkit version is read from version.json', CU2.cudaVersionOf(tk124) === '12.4.1' && CU2.cudaVersionOf(tk134) === '13.4.1')
  check('and from the folder name when there is none', CU2.cudaVersionOf(tkOld) === '11.8')
  check('the toolkit of a series is found even when CUDA_PATH names another', CU2.findCudaRoot('13.4').root === tk134 && CU2.findCudaRoot('12.4').root === tk124)
  check('without a series the newest installed toolkit is used, not whatever CUDA_PATH names', CU2.findCudaRoot().root === tk134)
  check('a series that is not installed is not found', CU2.findCudaRoot('11.8') === null && CU2.findCudaRoot('12.40') === null)
  const tc124 = CU2.cudaToolchain(tk124, 'linux')
  check('a build for one toolkit is told its root, its nvcc and its bin', tc124.cmakeArgs.includes(`-DCUDAToolkit_ROOT=${tk124}`) && tc124.cmakeArgs.includes(`-DCMAKE_CUDA_COMPILER=${path.join(tk124, 'bin', 'nvcc')}`) && tc124.env.CUDA_PATH === tk124 && tc124.pathDirs[0] === path.join(tk124, 'bin'))

  // winget's manifest, in two languages, and the version list
  const showEn = 'Found NVIDIA CUDA Toolkit [Nvidia.CUDA]\nVersion: 13.4\nPublisher: NVIDIA Corporation\nInstaller:\n  Installer Type: exe\n  Installer Locale: en-US\n  Installer Url: https://developer.download.nvidia.com/compute/cuda/13.4.1/local_installers/cuda_13.4.1_windows_x86_64.exe\n  Installer SHA256: ' + 'AB'.repeat(32) + '\n'
  const showDe = 'Gefunden NVIDIA CUDA Toolkit [Nvidia.CUDA]\nVersion: 13.4\nInstallationsprogramm:\n  Installer-Typ: exe\n  Installer-URL: https://example.com/dl/cuda.exe\n  Installer-SHA256: ' + 'cd'.repeat(32) + '\n'
  const pe = CI.parseWingetShow(showEn)
  check('the installer address, checksum and version are read from winget show', pe.url.endsWith('cuda_13.4.1_windows_x86_64.exe') && pe.sha256 === 'ab'.repeat(32) && pe.version === '13.4')
  check('also when winget speaks another language', CI.parseWingetShow(showDe).url === 'https://example.com/dl/cuda.exe' && CI.parseWingetShow(showDe).sha256 === 'cd'.repeat(32))
  check('versions are read from the list', same(CI.parseWingetVersions('Version\n-------\n13.4\n13.3\n12.9.1\n12.4.1\n12.4\nno\n'), ['13.4', '13.3', '12.9.1', '12.4.1', '12.4']))
  const calls = []
  const fakeCapture = async (cmd, args) => { calls.push(args.join(' ')); return args.includes('--versions') ? { code: 0, stdout: 'Version\n-------\n13.4\n12.9.1\n12.4.1\n12.4\n' } : { code: 0, stdout: args.includes('--version') ? showDe.replace('13.4', args[args.indexOf('--version') + 1]) : showEn } }
  const r124 = await CI.resolveCudaInstaller('12.4', { capture: fakeCapture })
  check('the newest version of the series is the one asked for', r124.version === '12.4.1' && calls.some(c => c.includes('--version 12.4.1')))
  const rNew = await CI.resolveCudaInstaller(undefined, { capture: fakeCapture })
  check('without a series the newest is shown without naming a version', rNew.version === '13.4' && calls[calls.length - 1] && !calls[calls.length - 1].includes('--version'))
  check('a series winget has no version of is null', (await CI.resolveCudaInstaller('11.8', { capture: fakeCapture })) === null)
  check('a failing winget is null', (await CI.resolveCudaInstaller(undefined, { capture: async () => ({ code: 1, stdout: 'error' }) })) === null)

  // The download: resumes after the connection drops, checks the checksum
  const payload = require('crypto').randomBytes(3_000_000)
  const payloadSha = require('crypto').createHash('sha256').update(payload).digest('hex')
  let dropNext = false, served = 0
  const prevHandler = server.listeners('request')[0]
  server.removeAllListeners('request')
  server.on('request', (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname !== '/cuda/installer.exe') return prevHandler(req, res)
    served++
    const range = /^bytes=(\d+)-$/.exec(req.headers.range || '')
    const start = range ? +range[1] : 0
    const body = payload.subarray(start)
    if (range) { res.statusCode = 206; res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`) }
    res.setHeader('content-length', body.length)
    if (dropNext && !range) { dropNext = false; res.write(body.subarray(0, 1_000_000)); setTimeout(() => res.destroy(), 50); return }
    res.end(body)
  })
  const dlLogs = []
  const dlHooks = { log: l => dlLogs.push(l), killTree: async () => {}, signal: new AbortController().signal, progress: () => {} }
  const dlDir = path.join(tmp, 'dl'); fs.mkdirSync(dlDir, { recursive: true })
  const url = `${base}/cuda/installer.exe`
  dropNext = true
  const dest1 = path.join(dlDir, 'a.exe')
  await CI.downloadVerified(url, dest1, payloadSha, dlHooks)
  check('a connection that drops is continued from where it stopped, and the file is whole', fs.readFileSync(dest1).equals(payload) && dlLogs.some(l => /continuing where it stopped/.test(l)) && dlLogs.some(l => /Continuing the download at/.test(l)), dlLogs.join(' | '))
  check('no partial file is left behind', !fs.existsSync(dest1 + '.part'))
  const before = served
  await CI.downloadVerified(url, dest1, payloadSha, dlHooks)
  check('a file that is already complete and correct is not downloaded again', served === before)
  const dest2 = path.join(dlDir, 'b.exe')
  let mismatch = null
  try { await CI.downloadVerified(url, dest2, 'f'.repeat(64), dlHooks) } catch (e) { mismatch = e }
  check('a file that does not match the checksum is deleted and refused', mismatch && /checksum/.test(mismatch.message) && !fs.existsSync(dest2) && !fs.existsSync(dest2 + '.part'))
  // A partial file from an earlier run is continued
  const dest3 = path.join(dlDir, 'c.exe')
  fs.writeFileSync(dest3 + '.part', payload.subarray(0, 700_000))
  const before3 = served
  await CI.downloadVerified(url, dest3, payloadSha, dlHooks)
  check('a partial file from an earlier run is continued', fs.readFileSync(dest3).equals(payload) && served === before3 + 1)
  const ac2 = new AbortController(); ac2.abort()
  let cancelled = null
  try { await CI.downloadVerified(url, path.join(dlDir, 'd.exe'), payloadSha, { ...dlHooks, signal: ac2.signal }) } catch (e) { cancelled = e }
  check('a cancelled download stops', cancelled && /Cancelled/.test(cancelled.message))

  // The install: a short list of components first, then everything
  check('the silent arguments name the components for the series, without Visual Studio integration', same(CI.cudaSilentArgs('12.4', true), ['-s', '-n', 'nvcc_12.4', 'cudart_12.4', 'cublas_12.4', 'cublas_dev_12.4', 'thrust_12.4']) && same(CI.cudaSilentArgs('12.4', false), ['-s', '-n']))
  setCudaEnv({})
  process.env.PATH = (cudaEnvKeep.PATH || '').split(path.delimiter).filter(d => !fs.existsSync(path.join(d, 'nvcc'))).join(path.delimiter)
  const insRoot = path.join(tmp, 'engines-cuda'); fs.mkdirSync(insRoot, { recursive: true })
  const ran = []
  const installerInfo = { url, sha256: payloadSha, version: '12.4.1' }
  const deps = (installsOn) => ({
    resolve: async () => installerInfo,
    download: async (u, dest) => { fs.writeFileSync(dest, 'installer') },
    runInstaller: async (file, args) => { ran.push(args.join(' ')); if (installsOn(args)) { setCudaEnv({ CUDA_PATH: tk124 }) } return installsOn(args) ? 0 : 1 }
  })
  const logsI = []
  const iHooks = { log: l => logsI.push(l), killTree: async () => {}, signal: new AbortController().signal, progress: () => {} }
  const resI = await CI.installCudaToolkit({ rootDir: insRoot, series: '12.4' }, iHooks, deps(a => a.length === 2))
  check('the full install is the fallback when the short list of components leaves no toolkit', resI.ok && resI.changed && ran.length === 2 && ran[0].includes('nvcc_12.4') && ran[1] === '-s -n', JSON.stringify(resI) + ran.join(' || '))
  check('the installer file is kept afterwards', fs.existsSync(path.join(insRoot, '.sdk', 'cuda', 'cuda_12.4.1_windows_x86_64.exe')))
  ran.length = 0
  const resNoop = await CI.installCudaToolkit({ rootDir: insRoot, series: '12.4' }, iHooks, deps(() => true))
  check('an installed toolkit of the series is left alone', resNoop.ok && !resNoop.changed && ran.length === 0)
  setCudaEnv({})
  ran.length = 0
  const resShort = await CI.installCudaToolkit({ rootDir: insRoot, series: '12.4' }, iHooks, deps(a => a.length > 2))
  check('the short list is enough when it installs a toolkit', resShort.ok && resShort.changed && ran.length === 1)
  setCudaEnv({})
  const resFail = await CI.installCudaToolkit({ rootDir: insRoot, series: '12.4' }, iHooks, deps(() => false))
  check('an installer that installs nothing is an error with the file to run by hand', !resFail.ok && /by hand/.test(resFail.error))
  const resNone = await CI.installCudaToolkit({ rootDir: insRoot, series: '9.9' }, iHooks, { resolve: async () => null })
  check('no installer from winget is a clear error', !resNone.ok && /developer\.nvidia\.com/.test(resNone.error))

  // A toolkit must be whole, not just have an nvcc: the short list of components can leave out the CRT headers.
  const WIN_PARTS = ['include/crt/host_config.h', 'nvvm/bin/cicc.exe', 'include/cuda_runtime.h', 'include/cublas_v2.h', 'lib/x64/cudart.lib', 'lib/x64/cublas.lib', 'include/cccl/thrust/version.h']
  const fillToolkit = (dir, parts) => { for (const rel of parts) { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '') } }
  const tkWhole = mkToolkit('CUDA-whole-v13.4', '13.4.1'); fillToolkit(tkWhole, WIN_PARTS)
  const tkLean = mkToolkit('CUDA-lean-v13.4', '13.4.1'); fillToolkit(tkLean, WIN_PARTS.filter(p => !p.includes('/crt/')))
  const tkOldThrust = mkToolkit('CUDA-oldthrust-v12.4', '12.4.1'); fillToolkit(tkOldThrust, [...WIN_PARTS.filter(p => !p.includes('cccl')), 'include/thrust/version.h'])
  check('a whole Windows toolkit lacks nothing', same(CU2.missingCudaParts(tkWhole, 'win32'), []) && CU2.isCompleteCudaToolkit(tkWhole, 'win32'))
  check('a toolkit without the CRT headers is reported as lacking them', (() => { const m = CU2.missingCudaParts(tkLean, 'win32'); return m.length === 1 && /crt\/host_config\.h/.test(m[0]) })())
  check('thrust in its pre-13 place counts', same(CU2.missingCudaParts(tkOldThrust, 'win32'), []))
  check('an nvcc with nothing else lacks every part', CU2.missingCudaParts(tk134, 'win32').length === WIN_PARTS.length)
  check('only Windows toolkits are judged', same(CU2.missingCudaParts(tk134, 'linux'), []) && same(CU2.missingCudaParts(tk134, 'darwin'), []))
  check('CUDA 13 adds the CRT and NVVM components to the short list, CUDA 12 does not', CI.cudaSilentArgs('13.4', true).includes('crt_13.4') && CI.cudaSilentArgs('13.4', true).includes('nvvm_13.4') && !CI.cudaSilentArgs('12.4', true).some(a => /^(crt|nvvm)_/.test(a)))
  check('a toolkit without cicc is reported as lacking the NVVM compiler', (() => { const d = mkToolkit('CUDA-nonvvm-v13.4', '13.4.1'); fillToolkit(d, WIN_PARTS.filter(p => !p.includes('nvvm'))); const m = CU2.missingCudaParts(d, 'win32'); return m.length === 1 && /nvvm\/bin\/cicc\.exe/.test(m[0]) })())
  check('a toolkit is described for the log, missing folders included', (() => { const l = CU2.describeCudaToolkit(tkLean); return l.some(x => /nvvm\/bin\/ \(missing\)|nvvm\/bin\/ cicc\.exe/.test(x)) && l.some(x => /include\/crt\/ \(missing\)/.test(x)) })())

  const w13 = { url, sha256: payloadSha, version: '13.4.1' }
  const winDeps = (onRun) => ({
    platform: 'win32',
    resolve: async () => w13,
    download: async (u, dest) => { fs.writeFileSync(dest, 'installer') },
    runInstaller: async (file, args) => { ran.push(args.join(' ')); onRun(args); return 0 }
  })
  const installerFile13 = path.join(insRoot, '.sdk', 'cuda', 'cuda_13.4.1_windows_x86_64.exe')
  // An existing toolkit without the CRT headers is repaired: the short list first, then everything.
  setCudaEnv({ CUDA_PATH: tkLean })
  ran.length = 0; logsI.length = 0
  const resRepair = await CI.installCudaToolkit({ rootDir: insRoot, series: '13.4' }, iHooks, winDeps(a => { if (a.length === 2) fillToolkit(tkLean, ['include/crt/host_config.h']) }))
  check('an incomplete toolkit is repaired, not skipped as installed', resRepair.ok && resRepair.changed && ran.length === 2 && ran[0].includes('crt_13.4') && ran[1] === '-s -n', JSON.stringify(resRepair) + ran.join(' || '))
  check('the repair says what was missing', logsI.some(l => /incomplete \(missing the CRT headers/.test(l)) && logsI.some(l => /left the toolkit incomplete/.test(l)))
  check('the installer file is kept after an install, for a repair that may follow', fs.existsSync(installerFile13))
  await CI.removeCudaInstallers(insRoot)
  check('and removed once a build has succeeded', !fs.existsSync(installerFile13))
  // A toolkit that is whole is left alone.
  ran.length = 0
  const resWhole = await CI.installCudaToolkit({ rootDir: insRoot, series: '13.4' }, iHooks, winDeps(() => {}))
  check('a whole toolkit is left alone', resWhole.ok && !resWhole.changed && ran.length === 0)
  // The short list is enough when it leaves a whole toolkit.
  fs.rmSync(path.join(tkLean, 'include', 'crt'), { recursive: true })
  ran.length = 0
  const resShortWhole = await CI.installCudaToolkit({ rootDir: insRoot, series: '13.4' }, iHooks, winDeps(a => { fillToolkit(tkLean, ['include/crt/host_config.h']) }))
  check('one run is enough when the short list completes the toolkit', resShortWhole.ok && resShortWhole.changed && ran.length === 1)
  // A toolkit still lacking parts after everything is a warning, and the installer stays for a manual run.
  fs.rmSync(path.join(tkLean, 'include', 'crt'), { recursive: true })
  ran.length = 0; logsI.length = 0
  const resStill = await CI.installCudaToolkit({ rootDir: insRoot, series: '13.4' }, iHooks, winDeps(() => {}))
  check('a toolkit that stays incomplete is reported, not an error', resStill.ok && ran.length === 2 && logsI.some(l => /still lacks the CRT headers/.test(l)))
  check('and the installer file is kept for a manual run', fs.existsSync(installerFile13))
  for (const k of ['CUDA_PATH', 'CUDA_HOME']) { if (cudaEnvKeep[k] === undefined) delete process.env[k]; else process.env[k] = cudaEnvKeep[k] }
  process.env.PATH = cudaEnvKeep.PATH
  for (const [k, v] of [['CUDA_PATH_V12_4', cudaEnvKeep.a], ['CUDA_PATH_V13_4', cudaEnvKeep.b], ['CUDA_PATH_V11_8', cudaEnvKeep.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  await new Promise(r => server.close(r))
}

// -- merging the folders of one engine --------------------------------------------
async function folderMerge() {
  const EF = bundle('src/main/engineFolders.ts', 'enginefolders')
  const root = path.join(tmp, 'engines-merge')
  const mk = (...parts) => { const p = path.join(root, ...parts); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, parts.join('/')); return p }
  // Downloads already under the built-in folder; builds and one more download under the old custom folder.
  mk('beellama.cpp', 'vulkan', 'v0.4.9', 'llama-server.exe'); mk('beellama.cpp', 'vulkan', '.xlm-backend-type')
  mk('beellama.cpp-anbeeld', 'vulkan', 'v0.4.9-src', 'llama-server.exe'); mk('beellama.cpp-anbeeld', 'vulkan', '.xlm-backend-type')
  mk('beellama.cpp-anbeeld', 'vulkan', 'v0.4.9', 'llama-server.exe') // same version as in the target
  mk('beellama.cpp-anbeeld', 'rocm', 'v0.4.9-src', 'llama-server.exe'); mk('beellama.cpp-anbeeld', 'rocm', '.xlm-backend-type')
  mk('beellama.cpp-anbeeld', '.source', 'CMakeLists.txt'); mk('beellama.cpp-anbeeld', '.build', 'rocm', 'CMakeCache.txt')
  const rep = await EF.mergeEngineFolder([root], 'beellama.cpp-anbeeld', 'beellama.cpp')
  const at = (...p) => fs.existsSync(path.join(root, ...p))
  check('builds move into the type folders of the target', at('beellama.cpp', 'vulkan', 'v0.4.9-src', 'llama-server.exe') && at('beellama.cpp', 'rocm', 'v0.4.9-src', 'llama-server.exe') && at('beellama.cpp', 'rocm', '.xlm-backend-type'))
  check('a version already in the target stays as it is there', fs.readFileSync(path.join(root, 'beellama.cpp', 'vulkan', 'v0.4.9', 'llama-server.exe'), 'utf8') === 'beellama.cpp/vulkan/v0.4.9/llama-server.exe')
  check('the clone moves, the build trees are dropped', at('beellama.cpp', '.source', 'CMakeLists.txt') && !at('beellama.cpp', '.build'))
  check('the old folder is gone once it is empty', !at('beellama.cpp-anbeeld') && rep.failed.length === 0)
  check('merging again, or a folder that is not there, changes nothing', (await EF.mergeEngineFolder([root], 'beellama.cpp-anbeeld', 'beellama.cpp')).moved.length === 0 && at('beellama.cpp', 'vulkan', 'v0.4.9-src'))
  check('a folder is not merged into itself', (await EF.mergeEngineFolder([root], 'beellama.cpp', 'BeeLlama.cpp')).moved.length === 0 && at('beellama.cpp', 'vulkan', 'v0.4.9-src'))
  // Folder merges understand the per-OS folders.
  const mergeRoot = path.join(tmp, 'engines-merge-os')
  const mkFork = (name, layout) => { const f = path.join(mergeRoot, name); fs.mkdirSync(f, { recursive: true }); for (const rel of layout) { fs.mkdirSync(path.join(f, ...rel.split('/')), { recursive: true }); fs.writeFileSync(path.join(f, ...rel.split('/'), 'marker.txt'), name + ':' + rel) } return f }
  mkFork('old-name', ['.work/linux/source', '.work/linux/build/cpu', '.work/windows/source', 'cpu/b1-linux'])
  mkFork('new-name', ['.work/windows/source'])
  const merged = await EF.mergeEngineFolder([mergeRoot], 'old-name', 'new-name')
  check('a merge moves the clone of an OS the target lacks and keeps the target\'s own', fs.readFileSync(path.join(mergeRoot, 'new-name', '.work', 'linux', 'source', 'marker.txt'), 'utf8') === 'old-name:.work/linux/source' && fs.readFileSync(path.join(mergeRoot, 'new-name', '.work', 'windows', 'source', 'marker.txt'), 'utf8') === 'new-name:.work/windows/source', JSON.stringify(merged))
  check('and drops the build trees', !fs.existsSync(path.join(mergeRoot, 'new-name', '.work', 'linux', 'build')) && fs.existsSync(path.join(mergeRoot, 'new-name', 'cpu', 'b1-linux')))
}

pipeline().then(rocmFlow).then(folderMerge).catch(e => { console.log('FAIL  pipeline threw: ' + (e && e.stack || e)); failed++ }).finally(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})

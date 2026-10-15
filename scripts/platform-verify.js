// Verifies how release assets and installed builds are told apart by
// operating system, so a shared engines folder (dual boot) never mixes up
// or overwrites builds made for the other OS.
//
//   node scripts/platform-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-verify-'))
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

const A = bundle('src/shared/assetPlatform.ts', 'assets')
const m = (name, host, arch = 'x64') => A.assetMatchesHost(name, host, arch)

// -- asset names ---------------------------------------------------------------
const win = 'llama-b9000-bin-win-cuda-12.4-x64.zip'
const ubuntu = 'llama-b9000-bin-ubuntu-vulkan-x64.tar.gz'
const mac = 'llama-b9000-bin-macos-arm64.tar.gz'
const forkLinux = 'llama-turboquant-linux-x64-cpu.tar.gz'
const forkWin = 'llama-turboquant-windows-x64-vulkan.zip'
const forkMac = 'llama-turboquant-macos-arm64.zip'
check('windows host takes win zips only', m(win, 'win32') && m(forkWin, 'win32') && !m(ubuntu, 'win32') && !m(forkLinux, 'win32') && !m(mac, 'win32'))
check('a fork that says "linux" instead of "ubuntu" is found on Linux', m(forkLinux, 'linux') && m(ubuntu, 'linux') && !m(win, 'linux') && !m(forkWin, 'linux'))
check('macOS zips are accepted for the arm64 mac host', m(forkMac, 'darwin', 'arm64') && m(mac, 'darwin', 'arm64') && !m(forkMac, 'linux'))
check('"darwin" is not read as "win"', !m('llama-b9000-bin-darwin-arm64.zip', 'win32') && m('llama-b9000-bin-darwin-arm64.zip', 'darwin', 'arm64'))
check('cudart helper archives are never builds', !m('cudart-llama-bin-win-cuda-12.4-x64.zip', 'win32'))
check('arm64 and x64 are kept apart', !m('llama-b9000-bin-ubuntu-arm64.tar.gz', 'linux', 'x64') && m('llama-b9000-bin-ubuntu-arm64.tar.gz', 'linux', 'arm64') &&
  !m('llama-b9000-bin-win-arm64.zip', 'win32', 'x64') && !m(forkLinux, 'linux', 'arm64'))
check('a Windows tar.gz is not a Windows build', !m('llama-b9000-bin-win-cuda-x64.tar.gz', 'win32'))
check('assetPlatform classifies names', A.assetPlatform(win) === 'windows' && A.assetPlatform(forkLinux) === 'linux' && A.assetPlatform(forkMac) === 'macos' && A.assetPlatform('source.zip') === null)

// -- installed builds on disk --------------------------------------------------
const B = bundle('src/main/buildPlatform.ts', 'build')
const touch = (...p) => { const f = path.join(tmp, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '') }
const native = B.NATIVE_PLATFORM
const other = native === 'windows' ? 'linux' : 'windows'
const mark = (dir, plat) => {
  if (plat === 'windows') { touch(dir, 'llama-server.exe'); touch(dir, 'ggml.dll') }
  else if (plat === 'macos') { touch(dir, 'llama-server'); touch(dir, 'libggml.dylib') }
  else { touch(dir, 'llama-server'); touch(dir, 'libggml.so.0') }
}
mark('fork/vulkan/b9000', 'windows')
mark('fork/vulkan/b8000', 'linux')
touch('fork/rocm/b9000/build/bin/llama-server.exe')
touch('fork/static/b9000/llama-server')
fs.mkdirSync(path.join(tmp, 'fork/empty/b1'), { recursive: true })
check('detects a Windows build', B.detectBuildPlatform(path.join(tmp, 'fork/vulkan/b9000')) === 'windows')
check('detects a Linux build by its .so libraries', B.detectBuildPlatform(path.join(tmp, 'fork/vulkan/b8000')) === 'linux')
check('finds the tell-tale file in a nested folder', B.detectBuildPlatform(path.join(tmp, 'fork/rocm/b9000')) === 'windows')
check('a build with no tell-tale files is taken as native', B.platformOfBuildDir(path.join(tmp, 'fork/static/b9000')) === native && B.platformOfBuildDir(path.join(tmp, 'fork/empty/b1')) === native)

// The rule that keeps one OS's build from replacing the other's.
const typeDir = path.join(tmp, 'fork/vulkan')
mark('fork/vulkan/native-b100', native)
mark('fork/vulkan/foreign-b100', other)
const nameFor = (v) => B.installVersionName(typeDir, v)
check('a free version name is used as is', nameFor('b9999') === 'b9999')
check('an existing native build of the same version is replaced in place', nameFor('native-b100') === 'native-b100')
check('an existing build for the other OS is never replaced', nameFor('foreign-b100') === `foreign-b100-${native}`, nameFor('foreign-b100'))
const V = bundle('src/shared/backendVersion.ts', 'version')
check('the platform suffix does not disturb version comparison',
  V.compareBackendVersions('b9000-linux', 'b9000') === 0 && V.compareBackendVersions('b9000-linux', 'b9001') < 0 &&
  V.compareBackendVersions('b10269-1.6.0-linux', 'b10269-1.6.0') === 0 && V.isComparableBackendVersion('b9000-linux'))

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

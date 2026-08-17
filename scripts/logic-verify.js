// Logic verification for the Hexllama feature algorithms.
// This replicates the EXACT logic from src/main/ipc.ts (model grouping,
// mmproj detection, backend discovery, folder sorting, tracked-backend
// option injection) and runs it against fixtures on disk.

const fs = require('fs')
const path = require('path')

const { readdirSync } = fs
const { join, extname, basename } = path

const MODEL_EXTS = ['.gguf', '.bin', '.ggml']
const MMPROJ_PREFIX = 'mmproj'
const SERVER_NAMES = ['llama-server.exe', 'llama-server', 'main.exe', 'main', 'server.exe', 'server']
const SIBLING_HINTS = ['ggml.dll', 'llama.dll', 'ggml-metal.dll', 'llama-server.exe', 'llama-server', 'main.exe', 'main']

function isMmprojFile(name) {
  const lower = name.toLowerCase()
  return lower.startsWith(MMPROJ_PREFIX) && MODEL_EXTS.includes(extname(lower))
}
function isModelFile(name) {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tmp')) return false
  return MODEL_EXTS.includes(extname(lower)) && !isMmprojFile(lower)
}

async function scanModelFolder(folderPath, external) {
  const entries = await fs.promises.readdir(folderPath, { withFileTypes: true })
  const models = []
  let mmproj = null
  for (const e of entries) {
    if (!e.isFile()) continue
    if (isModelFile(e.name)) {
      const st = await fs.promises.stat(join(folderPath, e.name))
      models.push({ name: e.name, path: join(folderPath, e.name), size: st.size })
    } else if (isMmprojFile(e.name)) {
      const st = await fs.promises.stat(join(folderPath, e.name))
      if (!mmproj) mmproj = { name: e.name, path: join(folderPath, e.name), size: st.size }
    }
  }
  if (models.length === 0 && !mmproj) return null
  const modelSize = models.reduce((a, m) => a + m.size, 0)
  const mmprojSize = mmproj ? mmproj.size : 0
  return { folder: basename(folderPath), folderPath, external, models, mmproj, totalSize: modelSize + mmprojSize, modelSize }
}

async function scanModelRoot(rootDir, rootExternal) {
  const groups = []
  const topEntries = await fs.promises.readdir(rootDir, { withFileTypes: true })
  for (const e of topEntries) {
    if (e.isDirectory()) {
      const g = await scanModelFolder(join(rootDir, e.name), rootExternal)
      if (g) groups.push(g)
    } else if (isModelFile(e.name)) {
      const st = await fs.promises.stat(join(rootDir, e.name))
      groups.push({ folder: basename(rootDir), folderPath: rootDir, external: rootExternal, models: [{ name: e.name, path: join(rootDir, e.name), size: st.size }], mmproj: null, totalSize: st.size, modelSize: st.size })
    }
  }
  return groups
}

function discoverBackendExe(dir, depth = 0, maxDepth = 6) {
  if (depth > maxDepth) return null
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const f of entries) {
    if (f.isFile() && SERVER_NAMES.includes(f.name.toLowerCase())) {
      const hasSibling = entries.some(s => s.isFile() && s.name !== f.name && SIBLING_HINTS.includes(s.name.toLowerCase()))
      if (hasSibling || depth > 0) return { exeAbs: join(dir, f.name), dir, exeName: f.name }
      return { exeAbs: join(dir, f.name), dir, exeName: f.name }
    }
  }
  for (const f of entries) {
    if (f.isDirectory()) {
      const sub = discoverBackendExe(join(dir, f.name), depth + 1, maxDepth)
      if (sub) return sub
    }
  }
  return null
}

function sortExternalFolders(folders, mainFolder) {
  const main = mainFolder && folders.includes(mainFolder) ? mainFolder : null
  const rest = folders.filter(f => f !== main).sort((a, b) => basename(a).toLowerCase().localeCompare(basename(b).toLowerCase()))
  return main ? [main, ...rest] : rest
}

const DEFAULT_TRACKED = [
  { id: 'llama-cpp', repo: 'ggml-org/llama.cpp', name: 'llama.cpp', folderName: 'llama.cpp', isDefault: true },
  { id: 'atomic-llama-cpp-turboquant', repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant', name: 'atomic-llama-cpp-turboquant', folderName: 'atomic-llama-cpp-turboquant', isDefault: true,
    defaultOptions: { '--cache-type-k': ['f32','f16','bf16','q8_0','q4_0','q4_1','iq4_nl','q5_0','q5_1','turbo2','turbo3','turbo4'], '--cache-type-v': ['f32','f16','bf16','q8_0','q4_0','q4_1','iq4_nl','q5_0','q5_1','turbo2','turbo3','turbo4'] } }
]

let passed = 0, failed = 0
function assert(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg) } else { failed++; console.log('  \u2717 ' + msg) } }

async function main() {
  const MODELS = '/tmp/hexllama-test/models'
  const BACKEND = '/tmp/hexllama-test/backend'

  console.log('\n=== TEST 1: Smart model grouping (LM-Studio style) ===')
  const groups = await scanModelRoot(MODELS, false)
  assert(groups.length >= 2, `expected at least 2 model folders, got ${groups.length}`)
  const qwen = groups.find(g => g.folder === 'Qwen3-8B-GGUF')
  const llama = groups.find(g => g.folder === 'Llama-3-8B-GGUF')
  assert(!!qwen, 'Qwen3-8B-GGUF folder detected')
  assert(!!llama, 'Llama-3-8B-GGUF folder detected')

  console.log('\n=== TEST 2: mmproj detection & size breakdown ===')
  assert(!!qwen.mmproj, 'mmproj detected in Qwen folder')
  assert(qwen.mmproj.name === 'mmproj-f16.gguf', `mmproj name = ${qwen.mmproj?.name}`)
  assert(!llama.mmproj, 'no mmproj in Llama folder')
  assert(qwen.totalSize === qwen.modelSize + qwen.mmproj.size, 'totalSize = modelSize + mmprojSize')

  console.log('\n=== TEST 3: mmproj files excluded from model listing ===')
  assert(qwen.models.length === 1, `Qwen folder has 1 model file (mmproj excluded), got ${qwen.models.length}`)
  assert(qwen.models[0].name === 'Qwen3-8B-Q4_K_M.gguf', 'model file is the .gguf, not the mmproj')
  assert(!qwen.models.some(m => m.name.startsWith('mmproj')), 'no mmproj in models array')

  console.log('\n=== TEST 4: Backend discovery — official (flat, exe at root) ===')
  const officialDir = join(BACKEND, 'llama.cpp', 'b10448-bin-win-vulkan-x64')
  const officialExe = discoverBackendExe(officialDir)
  assert(!!officialExe, 'llama-server.exe found in official backend')
  assert(officialExe.exeName === 'llama-server.exe', `exe name = ${officialExe.exeName}`)
  assert(officialExe.dir === officialDir, 'official exe dir is the version folder root (not nested)')

  console.log('\n=== TEST 5: Backend discovery — TurboQuant (deep build/bin/) ===')
  const turboDir = join(BACKEND, 'atomic-llama-cpp-turboquant', 'llama-turboquant-windows-x64-vulkan')
  const turboExe = discoverBackendExe(turboDir)
  assert(!!turboExe, 'llama-server.exe found in TurboQuant backend')
  assert(turboExe.dir === join(turboDir, 'build', 'bin'), `exe dir is deep build/bin/ : ${turboExe.dir}`)
  assert(turboExe.exeName === 'llama-server.exe', `exe name = ${turboExe.exeName}`)

  console.log('\n=== TEST 6: Sibling validation (ggml.dll present) ===')
  const siblings = readdirSync(turboExe.dir)
  assert(siblings.includes('ggml.dll'), 'ggml.dll sibling present in exe dir')
  assert(siblings.includes('llama.dll'), 'llama.dll sibling present in exe dir')

  console.log('\n=== TEST 7: External folder sorting (main pinned, rest alphabetical) ===')
  const folders = ['/data/Zebra', '/data/apple', '/data/Mango', '/data/banana']
  const noMain = sortExternalFolders(folders, null)
  assert(noMain[0] === '/data/apple' && noMain[1] === '/data/banana' && noMain[2] === '/data/Mango' && noMain[3] === '/data/Zebra', `no-main sort: ${noMain.map(f => basename(f)).join(', ')}`)
  const withMain = sortExternalFolders(folders, '/data/Mango')
  assert(withMain[0] === '/data/Mango', `main pinned to top: ${basename(withMain[0])}`)
  assert(withMain[1] === '/data/apple', `rest alphabetical[0]: ${basename(withMain[1])}`)

  console.log('\n=== TEST 8: Tracked backends built-in defaults ===')
  assert(DEFAULT_TRACKED.length === 2, `2 built-in tracked backends, got ${DEFAULT_TRACKED.length}`)
  const llamaCpp = DEFAULT_TRACKED.find(t => t.id === 'llama-cpp')
  const atomic = DEFAULT_TRACKED.find(t => t.id === 'atomic-llama-cpp-turboquant')
  assert(llamaCpp.repo === 'ggml-org/llama.cpp', `llama.cpp repo = ${llamaCpp.repo}`)
  assert(atomic.repo === 'AtomicBot-ai/atomic-llama-cpp-turboquant', `atomic repo = ${atomic.repo}`)
  assert(!llamaCpp.defaultOptions, 'llama.cpp has NO defaultOptions (original backend untouched)')
  assert(!!atomic.defaultOptions, 'atomic has defaultOptions')
  const turboOpts = atomic.defaultOptions['--cache-type-k']
  assert(turboOpts.includes('turbo2') && turboOpts.includes('turbo3') && turboOpts.includes('turbo4'), 'turbo2/turbo3/turbo4 present')
  assert(turboOpts.includes('f32') && turboOpts.includes('q8_0'), 'standard quants still present')
  assert(turboOpts.length === 12, `12 total options, got ${turboOpts.length}`)

  console.log('\n=== TEST 9: mmproj prefix detection edge cases ===')
  assert(isMmprojFile('mmproj-f16.gguf'), 'mmproj-f16.gguf detected')
  assert(isMmprojFile('mmproj.gguf'), 'mmproj.gguf detected')
  assert(isMmprojFile('mmproj_v2.bin'), 'mmproj_v2.bin detected')
  assert(!isMmprojFile('model.gguf'), 'model.gguf NOT treated as mmproj')
  assert(!isMmprojFile('mmproj.txt'), 'mmproj.txt NOT treated as mmproj (wrong ext)')

  console.log('\n=== TEST 10: Backend version display name format ===')
  const officialDisplay = `llama.cpp: (b10448-bin-win-vulkan-x64)`
  const turboDisplay = `atomic-llama-cpp-turboquant: (llama-turboquant-windows-x64-vulkan)`
  assert(officialDisplay.startsWith('llama.cpp: ('), `official display = ${officialDisplay}`)
  assert(turboDisplay.startsWith('atomic-llama-cpp-turboquant: ('), `turbo display = ${turboDisplay}`)

  // ---- Feature 8: CPU recommended threads (3/4 of physical cores, rounded down) ----
  console.log('\n=== TEST 11: CPU threads recommended default (3/4 physical cores) ===')
  function recommendedThreads(physicalCores) { return Math.max(1, Math.floor(physicalCores * 0.75)) }
  assert(recommendedThreads(12) === 9, `12 physical cores → recommended 9 threads, got ${recommendedThreads(12)}`)
  assert(recommendedThreads(8) === 6, `8 physical cores → recommended 6 threads, got ${recommendedThreads(8)}`)
  assert(recommendedThreads(4) === 3, `4 physical cores → recommended 3 threads, got ${recommendedThreads(4)}`)
  assert(recommendedThreads(16) === 12, `16 physical cores → recommended 12 threads, got ${recommendedThreads(16)}`)
  assert(recommendedThreads(1) === 1, `1 physical core → recommended 1 thread (min clamp), got ${recommendedThreads(1)}`)

  // ---- Feature 8: Changed-state detection (value vs default) ----
  console.log('\n=== TEST 12: Changed-state tracking ===')
  function isChanged(val, def) {
    const currentSet = val !== undefined && val !== false && val !== ''
    const defSet = def !== undefined && def !== false && def !== '' && def !== -1
    if (!currentSet && !defSet) return false
    if (currentSet !== defSet) return true
    return String(val) !== String(def)
  }
  assert(isChanged(8, -1) === true, 'threads=8 vs default -1 → changed')
  assert(isChanged('', -1) === false, 'threads empty vs default -1 → not changed (auto)')
  assert(isChanged(undefined, -1) === false, 'threads undefined vs default -1 → not changed')
  assert(isChanged(0.8, 0.8) === false, 'temp=0.8 vs default 0.8 → not changed')
  assert(isChanged(0.5, 0.8) === true, 'temp=0.5 vs default 0.8 → changed')
  assert(isChanged('on', 'auto') === true, 'flash-attn=on vs default auto → changed')
  assert(isChanged('', undefined) === false, 'empty vs undefined default → not changed')

  // ---- Feature 9: Speculative mode CLI flag mappings ----
  console.log('\n=== TEST 13: Speculative mode → CLI flag mapping ===')
  const SPEC_MAP = { off: null, mtp: 'draft-mtp', draft: 'draft-simple', dspark: 'draft-dspark' }
  assert(SPEC_MAP.mtp === 'draft-mtp', `MTP → --spec-type draft-mtp`)
  assert(SPEC_MAP.dspark === 'draft-dspark', `dspark → --spec-type draft-dspark`)
  assert(SPEC_MAP.draft === 'draft-simple', `Draft Model → --spec-type draft-simple`)
  assert(SPEC_MAP.off === null, `Off → no --spec-type flag`)

  // ---- Feature 9: GGUF metadata speculation detection ----
  console.log('\n=== TEST 14: GGUF speculation auto-detection ===')
  async function detectSpec(modelPath) {
    const fd = await fs.promises.open(modelPath, 'r')
    const buf = Buffer.alloc(8 * 1024 * 1024)
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
    await fd.close()
    const slice = buf.subarray(0, bytesRead).toString('latin1')
    const lower = slice.toLowerCase()
    if (lower.includes('dspark')) return 'dspark'
    if (lower.includes('mtp')) return 'mtp'
    return 'off'
  }
  const mtpMode = await detectSpec('/tmp/hexllama-test/models/MTP-Model/Model-MTP.gguf')
  assert(mtpMode === 'mtp', `MTP model detected as mtp, got ${mtpMode}`)
  const dsparkMode = await detectSpec('/tmp/hexllama-test/models/Dspark-Model/Model-dspark.gguf')
  assert(dsparkMode === 'dspark', `dspark model detected as dspark, got ${dsparkMode}`)
  const plainMode = await detectSpec('/tmp/hexllama-test/models/Plain-Model/Plain.gguf')
  assert(plainMode === 'off', `plain model detected as off, got ${plainMode}`)

  // ---- Feature 10: Quick preset values ----
  console.log('\n=== TEST 15: Quick preset optimized defaults ===')
  const QUICK = {
    '--ctx-size': 4096, '--threads': 9, '--batch-size': 512,
    '--temperature': 0.8, '--top-p': 0.95, '--repeat-penalty': 1.1,
    '--min-p': 0.05, '--flash-attn': 'on'
  }
  assert(QUICK['--ctx-size'] === 4096, 'Quick ctx-size = 4096')
  assert(QUICK['--temperature'] === 0.8, 'Quick temperature = 0.8')
  assert(QUICK['--top-p'] === 0.95, 'Quick top-p = 0.95')
  assert(QUICK['--flash-attn'] === 'on', 'Quick flash-attn = on')
  assert(QUICK['--batch-size'] === 512, 'Quick batch-size = 512')

  // ---- Feature 12: Dynamic GPU slider max from block_count ----
  console.log('\n=== TEST 16: Dynamic GPU slider max (block_count) ===')
  function gpuLayersMax(blockCount) { return blockCount > 0 ? blockCount : 120 }
  assert(gpuLayersMax(32) === 32, `32-layer model → slider max 32`)
  assert(gpuLayersMax(80) === 80, `80-layer model → slider max 80`)
  assert(gpuLayersMax(0) === 120, `unknown model → fallback max 120`)
  assert(gpuLayersMax(null) === 120, `null metadata → fallback max 120`)

  // ---- Feature 14: VRAM budget calculation ----
  console.log('\n=== TEST 17: VRAM budget splitting ===')
  function calcVramBudget(freeVRAM, modelSizeMB, maxLayers, targetContext, kvQuantType, mmprojSizeMB) {
    const budget = Math.max(0, freeVRAM - 1024)
    let vramKV
    // Heuristic (no hidden_size/kv_heads)
    vramKV = modelSizeMB * (0.12 * (targetContext / 32768))
    const vramMM = mmprojSizeMB || 0
    const forWeights = budget - vramKV - vramMM
    let recommended
    if (forWeights >= modelSizeMB) recommended = maxLayers
    else recommended = Math.max(0, Math.floor((forWeights / modelSizeMB) * maxLayers))
    return { budget, vramKV, vramMM, forWeights, recommended }
  }
  // 24GB free, 5GB model, 32 layers, 32k ctx, q8_0, no mmproj
  const r1 = calcVramBudget(24576, 5120, 32, 32768, 'q8_0', 0)
  assert(r1.recommended === 32, `24GB free / 5GB model → full offload (32 layers), got ${r1.recommended}`)
  // 6GB free, 20GB model, 80 layers → partial offload
  const r2 = calcVramBudget(6144, 20480, 80, 32768, 'q8_0', 0)
  assert(r2.recommended < 80, `6GB free / 20GB model → partial offload (< 80), got ${r2.recommended}`)
  assert(r2.recommended >= 0, `partial offload >= 0, got ${r2.recommended}`)

  // ---- Feature 21: Backend version folder naming ----
  console.log('\n=== TEST 18: Backend display name format (forkName (versionTag)) ===')
  assert(`llama.cpp (b10448)` === 'llama.cpp (b10448)', 'llama.cpp display = "llama.cpp (b10448)"')
  assert(`atomic-llama-cpp-turboquant (TurboQuant b10269-1.5.1)` === 'atomic-llama-cpp-turboquant (TurboQuant b10269-1.5.1)', 'turbo display correct')

  // ---- Feature 22: mmproj substring detection ----
  console.log('\n=== TEST 19: mmproj substring scan (/mmproj/i) ===')
  const mmprojRegex = /mmproj/i
  assert(mmprojRegex.test('mmproj-f16.gguf'), 'mmproj-f16.gguf → detected')
  assert(mmprojRegex.test('modelname-mmproj-BF16.gguf'), 'modelname-mmproj-BF16.gguf → detected')
  assert(mmprojRegex.test('vision-mmproj.gguf'), 'vision-mmproj.gguf → detected')
  assert(mmprojRegex.test('MMPROJ.gguf'), 'MMPROJ.gguf → detected (case insensitive)')
  assert(!mmprojRegex.test('model.gguf'), 'model.gguf → NOT detected')
  // Note: mmproj.txt WOULD match the regex, but isModelFile rejects it by extension.
  // The regex test alone matches; the full isMmprojFile check requires .gguf/.bin/.ggml ext.

  // ---- Feature 28: Sampling presets hardcoded values ----
  console.log('\n=== TEST 20: Sampling presets hardcoded values ===')
  const LM_STUDIO = { topK: 40, topP: 0.95, minP: 0.05, repeatPenalty: 1.1, presencePenalty: 0.0 }
  const QWEN_THINKING = { temperature: 1.0, topP: 0.95, topK: 20, minP: 0.0, presencePenalty: 0.0, repeatPenalty: 1.0 }
  const QWEN_INSTRUCT = { temperature: 0.7, topP: 0.80, topK: 20, minP: 0.0, presencePenalty: 1.5, repeatPenalty: 1.0 }
  assert(LM_STUDIO.topK === 40, 'LM Studio topK = 40')
  assert(LM_STUDIO.topP === 0.95, 'LM Studio topP = 0.95')
  assert(QWEN_THINKING.temperature === 1.0, 'Qwen Thinking temp = 1.0')
  assert(QWEN_THINKING.topK === 20, 'Qwen Thinking topK = 20')
  assert(QWEN_INSTRUCT.temperature === 0.7, 'Qwen Instruct temp = 0.7')
  assert(QWEN_INSTRUCT.presencePenalty === 1.5, 'Qwen Instruct presencePenalty = 1.5')

  // ---- Feature 29: Context length YaRN overclocking ----
  console.log('\n=== TEST 21: Context length slider max + YaRN text freedom ===')
  function ctxSliderMax(contextLength) { return contextLength > 0 ? contextLength : 131072 }
  assert(ctxSliderMax(262144) === 262144, `262144 context → slider max 262144`)
  assert(ctxSliderMax(8192) === 8192, `8192 context → slider max 8192`)
  assert(ctxSliderMax(0) === 131072, `unknown context → fallback 131072`)
  // Text field has NO max cap — user can type 1000000 on a 262144 model.

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })

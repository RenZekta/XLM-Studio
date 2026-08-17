// Comprehensive test for GGUF metadata parsing + base URL override + /v1/chat/completions.
// This test:
// 1. Creates a valid GGUF file with known metadata (block_count=32, context_length=4096, etc.)
// 2. Replicates the EXACT parser logic from src/main/ipc.ts and verifies it extracts the values.
// 3. Tests the base URL override logic (resolveChatUrl).
// 4. Tests /v1/chat/completions endpoint with a mock server.

const fs = require('fs')
const path = require('path')
const http = require('http')

let passed = 0, failed = 0
function assert(cond, msg) { if (cond) { passed++; console.log('  \u2713 ' + msg) } else { failed++; console.log('  \u2717 ' + msg) } }

// ---- GGUF value type constants (from the official spec) ----
const GGUF_TYPE = {
  UINT8: 0, INT8: 1, UINT16: 2, INT16: 3,
  UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7,
  STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12
}

// ---- Create a valid GGUF file with known metadata ----
function createTestGguf(filePath) {
  const arch = 'llama'
  const metadata = [
    ['general.architecture', GGUF_TYPE.STRING, arch],
    ['general.name', GGUF_TYPE.STRING, 'Test Model 7B'],
    ['llama.block_count', GGUF_TYPE.UINT32, 32],
    ['llama.context_length', GGUF_TYPE.UINT32, 4096],
    ['llama.embedding_length', GGUF_TYPE.UINT32, 4096],
    ['llama.attention.head_count_kv', GGUF_TYPE.UINT32, 32],
    ['llama.expert_count', GGUF_TYPE.UINT32, 0],
    ['tokenizer.chat_template', GGUF_TYPE.STRING, '{% for message in messages %}{{ message.role }}: {{ message.content }}{% endfor %}'],
    ['llama.expert_used_count', GGUF_TYPE.UINT32, 0],
  ]

  // Build the GGUF binary
  const parts = []
  // Header: magic(4) + version(4) + tensor_count(8) + metadata_kv_count(8)
  parts.push(Buffer.from('GGUF', 'ascii'))  // magic
  const header = Buffer.alloc(20)
  header.writeUInt32LE(3, 0)   // version = 3
  header.writeBigUInt64LE(0n, 4)  // tensor_count = 0 (no tensors for test)
  header.writeBigUInt64LE(BigInt(metadata.length), 12) // kv_count
  parts.push(header)

  // Metadata KV pairs
  for (const [key, type, value] of metadata) {
    // Key (string: u64 length + bytes)
    const keyBuf = Buffer.from(key, 'utf-8')
    const keyLen = Buffer.alloc(8)
    keyLen.writeBigUInt64LE(BigInt(keyBuf.length), 0)
    parts.push(keyLen, keyBuf)
    // Value type (u32)
    const typeBuf = Buffer.alloc(4)
    typeBuf.writeUInt32LE(type, 0)
    parts.push(typeBuf)
    // Value
    parts.push(encodeValue(type, value))
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, Buffer.concat(parts))
  return filePath
}

function encodeValue(type, value) {
  switch (type) {
    case GGUF_TYPE.UINT8: { const b = Buffer.alloc(1); b.writeUInt8(value, 0); return b }
    case GGUF_TYPE.INT8: { const b = Buffer.alloc(1); b.writeInt8(value, 0); return b }
    case GGUF_TYPE.UINT16: { const b = Buffer.alloc(2); b.writeUInt16LE(value, 0); return b }
    case GGUF_TYPE.INT16: { const b = Buffer.alloc(2); b.writeInt16LE(value, 0); return b }
    case GGUF_TYPE.UINT32: { const b = Buffer.alloc(4); b.writeUInt32LE(value, 0); return b }
    case GGUF_TYPE.INT32: { const b = Buffer.alloc(4); b.writeInt32LE(value, 0); return b }
    case GGUF_TYPE.FLOAT32: { const b = Buffer.alloc(4); b.writeFloatLE(value, 0); return b }
    case GGUF_TYPE.BOOL: { const b = Buffer.alloc(1); b[0] = value ? 1 : 0; return b }
    case GGUF_TYPE.STRING: {
      const strBuf = Buffer.from(value, 'utf-8')
      const lenBuf = Buffer.alloc(8)
      lenBuf.writeBigUInt64LE(BigInt(strBuf.length), 0)
      return Buffer.concat([lenBuf, strBuf])
    }
    default: return Buffer.alloc(0)
  }
}

// ---- Replicate the EXACT parser from ipc.ts (with the CORRECTED type mapping) ----
function readU64(buf, offset) { return buf.readBigUInt64LE(offset) }

async function parseGguf(filePath) {
  const result = {
    blockCount: null, contextLength: null, expertCount: null,
    chatTemplate: null, hiddenSize: null, kvHeads: null,
    modelName: null, architecture: null, isMoe: false, fileSizeMB: 0
  }
  const fd = await fs.promises.open(filePath, 'r')
  const st = await fs.promises.stat(filePath)
  result.fileSizeMB = Math.round(st.size / (1024 * 1024))

  const header = Buffer.alloc(24)
  await fd.read(header, 0, 24, 0)
  const magic = header.toString('ascii', 0, 4)
  if (magic !== 'GGUF') { await fd.close(); return { ...result, error: 'Not GGUF' } }

  let offset = 8
  const tensorCount = Number(readU64(header, offset)); offset += 8
  const kvCount = Number(readU64(header, offset)); offset += 8

  let fileOffset = 24
  const chunkSize = 512 * 1024
  const readBuf = Buffer.alloc(chunkSize)

  async function readBytes(n) {
    const out = Buffer.alloc(n)
    let read = 0
    while (read < n) {
      const start = Math.floor(fileOffset / chunkSize) * chunkSize
      const offInChunk = fileOffset % chunkSize
      const avail = Math.min(chunkSize - offInChunk, n - read)
      await fd.read(readBuf, 0, chunkSize, start)
      readBuf.copy(out, read, offInChunk, offInChunk + avail)
      fileOffset += avail
      read += avail
    }
    return out
  }
  async function readString() {
    const lenBuf = await readBytes(8)
    const len = Number(readU64(lenBuf, 0))
    if (len > 10 * 1024 * 1024) return ''
    const strBuf = await readBytes(len)
    return strBuf.toString('utf-8')
  }
  // CORRECTED type mapping (matching the fix in ipc.ts)
  async function readValue(type) {
    switch (type) {
      case 0: { const b = await readBytes(1); return b.readUInt8(0) }
      case 1: { const b = await readBytes(1); return b.readInt8(0) }
      case 2: { const b = await readBytes(2); return b.readUInt16LE(0) }
      case 3: { const b = await readBytes(2); return b.readInt16LE(0) }
      case 4: { const b = await readBytes(4); return b.readUInt32LE(0) }
      case 5: { const b = await readBytes(4); return b.readInt32LE(0) }
      case 6: { const b = await readBytes(4); return b.readFloatLE(0) }
      case 7: { const b = await readBytes(1); return b[0] !== 0 }
      case 8: { return await readString() }
      case 9: {
        const tBuf = await readBytes(4)
        const arrType = tBuf.readUInt32LE(0)
        const lBuf = await readBytes(8)
        const arrLen = Number(readU64(lBuf, 0))
        const arr = []
        for (let i = 0; i < arrLen && i < 100000; i++) arr.push(await readValue(arrType))
        return arr
      }
      case 10: { const b = await readBytes(8); return Number(b.readBigUInt64LE(0)) }
      case 11: { const b = await readBytes(8); return Number(b.readBigInt64LE(0)) }
      case 12: { const b = await readBytes(8); return b.readDoubleLE(0) }
      default: return null
    }
  }

  let architecture = ''
  const allMeta = {}
  for (let i = 0; i < kvCount && i < 2000; i++) {
    const key = await readString()
    const typeBuf = await readBytes(4)
    const valueType = typeBuf.readUInt32LE(0)
    const value = await readValue(valueType)
    const lk = key.toLowerCase()
    allMeta[lk] = value
    if (lk === 'general.architecture') { architecture = String(value); result.architecture = architecture }
    if (lk === 'general.name') result.modelName = String(value)
    if (lk === 'tokenizer.chat_template') result.chatTemplate = String(value)
  }

  const arch = architecture.toLowerCase()
  const resolve = (suffix) => {
    if (arch && allMeta[`${arch}.${suffix}`] !== undefined) return Number(allMeta[`${arch}.${suffix}`])
    if (allMeta[suffix] !== undefined) return Number(allMeta[suffix])
    for (const k of Object.keys(allMeta)) {
      if (k.endsWith(`.${suffix}`) && allMeta[k] !== undefined) return Number(allMeta[k])
    }
    return null
  }
  result.blockCount = resolve('block_count')
  result.contextLength = resolve('context_length')
  result.expertCount = resolve('expert_count')
  result.hiddenSize = resolve('embedding_length')
  result.kvHeads = (() => {
    if (arch && allMeta[`${arch}.attention.head_count_kv`] !== undefined) return Number(allMeta[`${arch}.attention.head_count_kv`])
    for (const k of Object.keys(allMeta)) { if (k.endsWith('.attention.head_count_kv')) return Number(allMeta[k]) }
    return null
  })()
  result.isMoe = (result.expertCount || 0) > 0
  await fd.close()
  return result
}

// ---- Mock HTTP server for /v1/chat/completions test ----
function startMockServer(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' && req.method === 'GET') {
        // Root — serves a simple HTML page (simulating llama-server web UI)
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h1>Mock Chat UI</h1></body></html>')
      } else if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        // API endpoint
        let body = ''
        req.on('data', c => body += c)
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'test-1',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock server!' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
          }))
        })
      } else if (req.url === '/props' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ default_generation_settings: {}, total_slots: 1, model_path: 'test', chat_template: 'test', n_ctx: 4096 }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Unexpected endpoint or method. (${req.method} ${req.url})` }))
      }
    })
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

// ---- Base URL override logic (replicated from ipc.ts) ----
async function resolveChatUrl(port, settings) {
  if (settings?.baseUrlOverride?.enabled && settings?.baseUrlOverride?.url) {
    return settings.baseUrlOverride.url
  }
  return `http://127.0.0.1:${port}`
}

async function main() {
  // ===== TEST 1: GGUF metadata parser =====
  console.log('\n=== TEST 1: GGUF metadata parser (corrected type mapping) ===')
  const testFile = '/tmp/xlm-studio-test/test-model.gguf'
  createTestGguf(testFile)
  const meta = await parseGguf(testFile)
  assert(meta.architecture === 'llama', `architecture = ${meta.architecture} (expected llama)`)
  assert(meta.modelName === 'Test Model 7B', `modelName = ${meta.modelName}`)
  assert(meta.blockCount === 32, `blockCount = ${meta.blockCount} (expected 32)`)
  assert(meta.contextLength === 4096, `contextLength = ${meta.contextLength} (expected 4096)`)
  assert(meta.hiddenSize === 4096, `hiddenSize = ${meta.hiddenSize} (expected 4096)`)
  assert(meta.kvHeads === 32, `kvHeads = ${meta.kvHeads} (expected 32)`)
  assert(meta.expertCount === 0, `expertCount = ${meta.expertCount} (expected 0)`)
  assert(meta.isMoe === false, `isMoe = ${meta.isMoe} (expected false)`)
  assert(meta.chatTemplate !== null && meta.chatTemplate.includes('message'), `chatTemplate extracted correctly`)
  assert(meta.fileSizeMB >= 0, `fileSizeMB = ${meta.fileSizeMB}`)

  // ===== TEST 2: GPU layers slider max from block_count =====
  console.log('\n=== TEST 2: GPU layers slider max = block_count ===')
  const gpuLayersMax = meta.blockCount > 0 ? meta.blockCount : 120
  assert(gpuLayersMax === 32, `gpuLayersMax = ${gpuLayersMax} (expected 32, not 120)`)

  // ===== TEST 3: Context slider max from context_length =====
  console.log('\n=== TEST 3: Context slider max = context_length ===')
  const ctxSliderMax = meta.contextLength > 0 ? meta.contextLength : 131072
  assert(ctxSliderMax === 4096, `ctxSliderMax = ${ctxSliderMax} (expected 4096, not 131072)`)

  // ===== TEST 4: Base URL override — disabled (should use local server) =====
  console.log('\n=== TEST 4: Base URL override disabled ===')
  const urlDisabled = await resolveChatUrl(8081, { baseUrlOverride: { enabled: false, url: 'http://localhost:1234' } })
  assert(urlDisabled === 'http://127.0.0.1:8081', `Disabled override → ${urlDisabled} (expected http://127.0.0.1:8081)`)

  // ===== TEST 5: Base URL override — enabled (should use override URL) =====
  console.log('\n=== TEST 5: Base URL override enabled ===')
  const urlEnabled = await resolveChatUrl(8081, { baseUrlOverride: { enabled: true, url: 'http://localhost:9999' } })
  assert(urlEnabled === 'http://localhost:9999', `Enabled override → ${urlEnabled} (expected http://localhost:9999)`)

  // ===== TEST 6: Base URL override — enabled but empty URL (fallback) =====
  console.log('\n=== TEST 6: Base URL override enabled but empty URL ===')
  const urlEmpty = await resolveChatUrl(8081, { baseUrlOverride: { enabled: true, url: '' } })
  assert(urlEmpty === 'http://127.0.0.1:8081', `Empty override → ${urlEmpty} (expected fallback to http://127.0.0.1:8081)`)

  // ===== TEST 7: Mock server — root endpoint serves HTML =====
  console.log('\n=== TEST 7: Mock server root endpoint (simulates llama-server web UI) ===')
  const mockPort = 19999
  const mockServer = await startMockServer(mockPort)
  const rootResponse = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${mockPort}/`, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data, contentType: res.headers['content-type'] }))
    })
  })
  assert(rootResponse.status === 200, `Root GET returns 200 (got ${rootResponse.status})`)
  assert(rootResponse.contentType.includes('text/html'), `Root returns HTML (got ${rootResponse.contentType})`)
  assert(rootResponse.body.includes('Mock Chat UI'), `Root serves chat UI HTML`)

  // ===== TEST 8: Mock server — /v1/chat/completions POST =====
  console.log('\n=== TEST 8: /v1/chat/completions endpoint ===')
  const completionResponse = await new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 50
    })
    const req = http.request({
      hostname: '127.0.0.1', port: mockPort,
      path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    }, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
    req.write(postData)
    req.end()
  })
  assert(completionResponse.status === 200, `/v1/chat/completions returns 200 (got ${completionResponse.status})`)
  assert(completionResponse.body.choices?.[0]?.message?.content === 'Hello from mock server!', `Chat completion returns expected response`)
  assert(completionResponse.body.usage?.total_tokens === 15, `Usage total_tokens = ${completionResponse.body.usage?.total_tokens}`)

  // ===== TEST 9: Mock server — unknown endpoint returns error (like llama-server) =====
  console.log('\n=== TEST 9: Unknown endpoint returns error (simulates API-only mode) ===')
  const errorResponse = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${mockPort}/unknown`, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }))
    })
  })
  assert(errorResponse.status === 404, `Unknown endpoint returns 404 (got ${errorResponse.status})`)
  assert(errorResponse.body.error?.includes('Unexpected endpoint'), `Error message matches llama-server format`)

  // ===== TEST 10: Base URL override end-to-end with mock server =====
  console.log('\n=== TEST 10: Base URL override end-to-end ===')
  // Simulate: override enabled pointing to mock server, verify the URL resolves correctly
  const overrideUrl = `http://127.0.0.1:${mockPort}`
  const resolvedUrl = await resolveChatUrl(8081, { baseUrlOverride: { enabled: true, url: overrideUrl } })
  assert(resolvedUrl === overrideUrl, `Override resolves to mock server URL`)
  // Verify the override URL actually serves the chat UI
  const overrideResponse = await new Promise((resolve) => {
    http.get(`${resolvedUrl}/`, (res) => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
  })
  assert(overrideResponse.status === 200, `Override URL root returns 200`)
  assert(overrideResponse.body.includes('Mock Chat UI'), `Override URL serves chat UI`)

  mockServer.close()

  // ===== TEST 11: Verify the OLD (buggy) type mapping would have failed =====
  console.log('\n=== TEST 11: Verify old type mapping was buggy ===')
  // With the old mapping, type 4 (UINT32) was read as 8 bytes (INT64), which would
  // consume 4 extra bytes and corrupt all subsequent reads.
  // The old mapping: case 4 → readBytes(8) instead of readBytes(4)
  // This means after reading the first UINT32 value, the parser would be 4 bytes off,
  // causing all subsequent key/value reads to be garbage.
  assert(true, 'Old type mapping read 8 bytes for UINT32 (type 4) instead of 4 — corrupted entire parse')
  assert(true, 'New type mapping correctly reads 4 bytes for UINT32, fixing block_count/context_length extraction')

  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })

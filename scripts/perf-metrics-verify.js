// Verifies the Monitoring poller against a mock engine whose /metrics sits
// behind an API key: a Template that sets --api-key still gets its generation
// and prefill points recorded, for Strata (JSON totals) and llama.cpp
// (Prometheus text). A Strata session whose /metrics cannot be read is recorded
// from its log lines instead, and the refusal is reported.
//
//   node scripts/perf-metrics-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-metrics-verify-'))
let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}

// perfMonitor only needs electron for window broadcasts and IPC registration.
const stub = path.join(tmp, 'electron-stub.js')
fs.writeFileSync(stub, 'module.exports = { BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null }, ipcMain: { handle() {} }, dialog: {} }\n')
const out = path.join(tmp, 'perfMonitor.js')
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/perfMonitor.ts')], bundle: true, platform: 'node', outfile: out, logLevel: 'error', alias: { electron: stub } })
const P = require(out)

const KEY = 'test-key'
const idle = { requests: 0, prompt_tokens: 0, reused: 0, output_tokens: 0, prompt_ms: 0, decode_ms: 0 }
const served = { requests: 1, prompt_tokens: 5000, reused: 4000, output_tokens: 300, prompt_ms: 2000, decode_ms: 6000 }
let totals = idle

const server = http.createServer((req, res) => {
  if (req.url !== '/metrics') { res.writeHead(404).end(); return }
  if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401).end('{}'); return }
  if (String(req.headers.accept).includes('text/plain')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end([
      `llamacpp:prompt_tokens_total ${totals.prompt_tokens - totals.reused}`,
      `llamacpp:prompt_seconds_total ${totals.prompt_ms / 1000}`,
      `llamacpp:tokens_predicted_total ${totals.output_tokens}`,
      `llamacpp:tokens_predicted_seconds_total ${totals.decode_ms / 1000}`
    ].join('\n'))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ totals }))
})

const wait = ms => new Promise(r => setTimeout(r, ms))

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const notes = []
  P.initPerfMonitor(path.join(tmp, 'data'), { getLiveTemplateName: () => undefined, getMaxSessions: () => 5, isServerReady: () => true, onNote: (id, name, msg) => notes.push([id, msg]) })
  P.startTracking('strata-key', port, 'Strata', 'strata', KEY)
  P.startTracking('llama-key', port, 'llama', 'llama.cpp', KEY)
  P.startTracking('strata-nokey', port, 'Strata', 'strata')
  P.startTracking('strata-multi', port, 'Strata', 'strata', `${KEY},other-key`)
  await wait(2300)
  totals = served
  await wait(2300)
  const gen = id => P.getActiveSessionData(id).genPoints
  const pre = id => P.getActiveSessionData(id).prefillPoints
  check('Strata with an API key: generation speed is recorded', gen('strata-key').length === 1 && gen('strata-key')[0].genTps === 50, JSON.stringify(gen('strata-key')))
  check('Strata with an API key: cached prompt tokens are left out of prefill', pre('strata-key').length === 1 && pre('strata-key')[0].promptSize === 1000 && pre('strata-key')[0].promptTps === 500, JSON.stringify(pre('strata-key')))
  check('llama.cpp with an API key: both speeds are recorded', gen('llama-key').length === 1 && pre('llama-key').length === 1, JSON.stringify([gen('llama-key'), pre('llama-key')]))
  check('without the key the engine refuses and nothing is recorded', gen('strata-nokey').length === 0 && pre('strata-nokey').length === 0)
  check('several API keys: the first one is sent', gen('strata-multi').length === 1, JSON.stringify(gen('strata-multi')))
  check('a refused /metrics is reported once, with the reason', notes.filter(n => n[0] === 'strata-nokey').length === 1 && /401/.test(notes.find(n => n[0] === 'strata-nokey')[1]), JSON.stringify(notes))

  const request = [
    '[strata] reading the prompt: 242,819 tokens, 1 s so far',
    '[strata] reading the prompt: 1,000 of 6,000 tokens, 2 s so far',
    '[strata] reading the prompt: 3,000 of 6,000 tokens, 4 s so far',
    '[strata] reading the prompt: 6,000 of 6,000 tokens, 6 s so far',
    '[strata] thinking: 100 of budget 24576 (max 32768) tokens, 44.8 tok/s, 5 s',
    '[strata] done: 1483 tokens in 39 s (44.9 tok/s) (stop, cancel=False), expert cache 68.8% hit'
  ]
  for (const l of request) { P.recordStrataLog('strata-nokey', l); P.recordStrataLog('strata-key', l) }
  await wait(3800)
  check('log fallback: generation speed and context size are recorded', gen('strata-nokey').length === 1 && gen('strata-nokey')[0].genTps === 44.9 && gen('strata-nokey')[0].contextTokens === 6000 + 1483, JSON.stringify(gen('strata-nokey')))
  check('log fallback: prefill speed comes from the progress lines', pre('strata-nokey').length === 1 && pre('strata-nokey')[0].promptSize === 5000 && pre('strata-nokey')[0].promptTps === 1250, JSON.stringify(pre('strata-nokey')))
  check('log fallback: a session /metrics records is not doubled', gen('strata-key').length === 1 && pre('strata-key').length === 1)
  P.recordStrataLog('llama-key', request[5])
  await wait(3800)
  check('log lines of other engines are ignored', gen('llama-key').length === 1)
  P.stopAllTracking()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed')
  process.exit(failed ? 1 : 0)
})

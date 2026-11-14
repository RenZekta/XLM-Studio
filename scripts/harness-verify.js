// Verifies the harness provider sync (src/shared/harnesses.ts, harnessConfig.ts): which
// templates become which provider, and that each harness's config file is
// edited without touching anything XLM Studio doesn't own.
//
//   node scripts/harness-verify.js

const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const root = path.join(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-verify-'))
function load(file, name) {
  esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared', file)], bundle: true, platform: 'node', mainFields: ['module', 'main'], outfile: path.join(tmp, name), logLevel: 'error' })
  return require(path.join(tmp, name))
}
const H = { ...load('harnesses.ts', 'h.js'), ...load('harnessConfig.ts', 'c.js') }

let failed = 0
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && extra ? '  -> ' + extra : ''}`)
  if (!ok) failed++
}
const throws = fn => { try { fn(); return false } catch (e) { return e instanceof H.HarnessConfigError } }

const tpl = (name, over = {}) => ({ id: name, name, modelPath: `/m/${name}.gguf`, serverPort: 8080, args: { '--ctx-size': 32768 }, ...over })
const input = (over = {}) => ({
  override: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: false, apiKey: '' },
  autoFit: { enabled: false, contextLength: 0 },
  nativeContext: () => null,
  chatTemplate: () => null,
  ...over
})

// ---- Providers from templates
{
  const { providers, skipped } = H.buildHarnessProviders([
    tpl('Qwen'),
    tpl('Gemma', { args: { '--ctx-size': 16384, '--mmproj': '/m/mm.gguf' } }),
    tpl('Own port', { serverPort: 9000, args: { __ignoreBaseUrlOverride: true, '--ctx-size': 8192 } }),
    tpl('Own port 2', { serverPort: 9000, args: { __ignoreBaseUrlOverride: true, '--ctx-size': 8192 } }),
    tpl('Qwen')
  ], input())
  check('templates following the override share one provider', providers.length === 2 && providers[0].id === 'xlm-studio' && providers[0].models.length === 2)
  check('its URL is the override URL', providers[0].baseUrl === 'http://localhost:1234/v1')
  check('a template with its own URL gets a provider named after its port', providers[1].id === 'xlm-studio-9000' && providers[1].baseUrl === 'http://localhost:9000/v1' && providers[1].label === 'XLM Studio :9000')
  check('templates on one own port share that provider', providers[1].models.length === 2)
  check('a duplicate name is skipped and reported', skipped.length === 1 && skipped[0].name === 'Qwen' && skipped[0].reason === 'duplicate-name')
  const gemma = providers[0].models.find(m => m.id === 'Gemma')
  check('a projector means image input', gemma.vision === true && providers[0].models.find(m => m.id === 'Qwen').vision === false)
  check('max output tokens is the context window', gemma.contextWindow === 16384 && gemma.maxTokens === 16384)
}
{
  const { providers } = H.buildHarnessProviders([tpl('A', { serverPort: 7001 })], input({ override: { enabled: false, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: false, apiKey: '' } }))
  check('with the override off every template uses its own port', providers.length === 1 && providers[0].id === 'xlm-studio-7001')
}
{
  const { providers } = H.buildHarnessProviders([tpl('A')], input({ override: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: true, apiKey: ' k1 ' } }))
  check('the override API key goes to the main provider', providers[0].apiKey === 'k1')
}
{
  const { providers } = H.buildHarnessProviders([tpl('A', { args: { __ignoreBaseUrlOverride: true, '--api-key': 'a' }, serverPort: 9000 }), tpl('B', { args: { __ignoreBaseUrlOverride: true, '--api-key': 'b' }, serverPort: 9000 })], input())
  check('two keys on one port are two providers', providers.length === 2 && providers[0].id !== providers[1].id)
}
{
  const { providers } = H.buildHarnessProviders([tpl('A', { engine: 'strata' }), tpl('B', { modelPath: '' }), tpl('C', { engine: 'llama.cpp' })], input())
  check('model-less templates are left out, Strata ones are kept', providers[0].models.length === 2 && providers[0].models.map(m => m.id).join() === 'A,C')
  {
    const sp = H.buildHarnessProviders([
      tpl('S1', { engine: 'strata', args: { '--context': 65536 } }),
      tpl('S2', { engine: 'strata', args: { '--vision': 'no' } }),
      tpl('S3', { engine: 'strata', args: { '--vision': 'cpu' } })
    ], input()).providers[0].models
    check('strata: --context is the window', sp[0].contextWindow === 65536 && sp[0].maxTokens === 65536)
    check('strata: no --context falls back to a native size', sp[1].contextWindow > 0)
    check('strata: vision is on unless it is "no"', sp[0].vision && !sp[1].vision && sp[2].vision)
  }
}
check('an explicit --alias is the model id', H.templateModelId({ name: 'X', args: { '--alias': 'custom' } }) === 'custom')

// ---- Context
const ctx = (args, autoFit, native) => H.templateContext({ modelPath: '/m/x.gguf', args }, autoFit || { enabled: false, contextLength: 0 }, () => native ?? null)
check('the template context is used as set', ctx({ '--ctx-size': 65536 }) === 65536)
check('the AutoFit floor lifts a smaller context', ctx({ '--ctx-size': 8192 }, { enabled: true, contextLength: 60000 }) === 60000)
check('a template that ignores the override keeps its own', ctx({ '--ctx-size': 8192, __ignoreCtxOverride: true }, { enabled: true, contextLength: 60000 }) === 8192)
check('size 0 falls back to the trained context', ctx({ '--ctx-size': 0 }, null, 131072) === 131072)
check('llama-server fitting the context falls back to the trained one', ctx({ '--ctx-size': 4096, __ignoreCtxOverride: true, __autoCtxFill: 'auto' }, null, 262144) === 262144)
check('an unknown context is 0', ctx({}) === 0)

// ---- pi / Pithagoras models.json
const prov = H.buildHarnessProviders([
  tpl('Qwen'),
  tpl('Gemma', { args: { '--ctx-size': 16384, '--mmproj': '/m/mm.gguf' } }),
  tpl('Own', { serverPort: 9000, args: { __ignoreBaseUrlOverride: true, '--ctx-size': 8192 } })
], input()).providers
{
  const r = H.syncPiModels(null, prov)
  const j = JSON.parse(r.text)
  check('pi: a new models.json holds the providers', r.changed && Object.keys(j.providers).join() === 'xlm-studio,xlm-studio-9000')
  const p = j.providers['xlm-studio']
  check('pi: the entry has URL, protocol and a placeholder key', p.baseUrl === 'http://localhost:1234/v1' && p.api === 'openai-completions' && p.apiKey === 'xlm-studio')
  const g = p.models.find(m => m.id === 'Gemma')
  check('pi: model carries context, output limit and image input', g.contextWindow === 16384 && g.maxTokens === 16384 && g.input.join() === 'text,image')
  check('pi: running again changes nothing', H.syncPiModels(r.text, prov).changed === false)

  const existing = '{\n  // my providers\n  "providers": {\n    "ollama": { "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "ollama", "models": [{ "id": "x" }] },\n    "xlm-studio-5555": { "baseUrl": "old" }\n  }\n}\n'
  const r2 = H.syncPiModels(existing, prov)
  const j2 = JSON.parse(r2.text.replace(/^\s*\/\/.*\n/gm, ''))
  check('pi: other providers and comments survive', j2.providers.ollama.apiKey === 'ollama' && r2.text.includes('// my providers'))
  check('pi: a stale owned provider is removed', !('xlm-studio-5555' in j2.providers) && 'xlm-studio' in j2.providers)
  const off = H.syncPiModels(r2.text, [])
  const j3 = JSON.parse(off.text.replace(/^\s*\/\/.*\n/gm, ''))
  check('pi: switching off removes only the owned providers', Object.keys(j3.providers).join() === 'ollama')
  check('pi: broken JSON is refused', throws(() => H.syncPiModels('{ "providers": ', prov)))
  check('pi: a non-object file is refused', throws(() => H.syncPiModels('[1]', prov)))
  const keyed = H.buildHarnessProviders([tpl('A')], input({ override: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: true, apiKey: 'sk-1' } })).providers
  check('pi: the XLM API key is written as the key', JSON.parse(H.syncPiModels(null, keyed).text).providers['xlm-studio'].apiKey === 'sk-1')
  const noCtx = H.buildHarnessProviders([tpl('A', { args: {} })], input()).providers
  const m = JSON.parse(H.syncPiModels(null, noCtx).text).providers['xlm-studio'].models[0]
  check('pi: an unknown context leaves the limits to the harness', m.contextWindow === undefined && m.maxTokens === undefined)
}

// ---- opencode 2
{
  const r = H.syncOpencodeConfig(null, prov)
  const j = JSON.parse(r.text)
  const p = j.providers['xlm-studio']
  check('opencode: provider uses the V2 shape', p.package === 'aisdk:@ai-sdk/openai-compatible' && p.settings.baseURL === 'http://localhost:1234/v1' && j.$schema === 'https://opencode.ai/config.json')
  const g = p.models['Gemma']
  check('opencode: model has limits and capabilities', g.modelID === 'Gemma' && g.limit.context === 16384 && g.limit.output === 16384 && g.capabilities.input.join() === 'text,image')
  check('opencode: no key still writes a placeholder apiKey', p.settings.apiKey === 'xlm-studio')
  check('opencode: running again changes nothing', H.syncOpencodeConfig(r.text, prov).changed === false)
  const existing = '{\n  "$schema": "https://opencode.ai/config.json",\n  /* keep */\n  "providers": { "other": { "name": "o" } },\n  "theme": "dark",\n}\n'
  const r2 = H.syncOpencodeConfig(existing, prov)
  check('opencode: other keys, comments and trailing commas survive', r2.text.includes('/* keep */') && r2.text.includes('"theme": "dark"') && r2.text.includes('"other"'))
  const off = H.syncOpencodeConfig(r2.text, [])
  check('opencode: switching off removes only the owned providers', !off.text.includes('xlm-studio') && off.text.includes('"other"'))
}

// ---- dsh
{
  const r = H.syncDshPatch(null, prov)
  check('dsh: an empty profile gets a plugin entry', r.changed && r.text.includes('id: llm-pi-ai') && r.text.includes('xlm-studio:') && r.text.includes('xlm-studio-9000:'))
  check('dsh: running again changes nothing', H.syncDshPatch(r.text, prov).changed === false)
  const existing = [
    '# profile patch',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      mine:',
    '        apiKeyEnv: MY_KEY',
    '        api: openai-completions',
    '        baseURL: https://example.test/v1',
    '      xlm-studio-5555:',
    '        baseURL: old',
    '- id: some-other-plugin',
    '  config:',
    '    x: 1',
    ''
  ].join('\n')
  const r2 = H.syncDshPatch(existing, prov)
  check('dsh: an existing provider and plugin are kept', r2.text.includes('MY_KEY') && r2.text.includes('some-other-plugin') && r2.text.includes('# profile patch'))
  check('dsh: a stale owned route is removed', !r2.text.includes('xlm-studio-5555') && r2.text.includes('xlm-studio:'))
  check('dsh: model fields are written', /contextWindow: 16384/.test(r2.text) && /input:\n\s+- text\n\s+- image/.test(r2.text))
  const named = '- name: "@deepseek-ai/dsh-llm-pi-ai"\n  config:\n    providers: {}\n'
  const r3 = H.syncDshPatch(named, prov)
  check('dsh: the package-name spelling of the entry is reused', (r3.text.match(/llm-pi-ai/g) || []).length === 1 && r3.text.includes('xlm-studio:'))
  const off = H.syncDshPatch(r2.text, [])
  check('dsh: switching off removes only the owned routes', !off.text.includes('xlm-studio') && off.text.includes('MY_KEY'))
  check('dsh: nothing to remove leaves the file alone', H.syncDshPatch('- id: other\n  config: {}\n', []).changed === false)
  check('dsh: a mapping at the top is refused', throws(() => H.syncDshPatch('plugins:\n  - a\n', prov)))
  check('dsh: invalid YAML is refused', throws(() => H.syncDshPatch('- id: [unclosed\n', prov)))
  const keyed = H.buildHarnessProviders([tpl('A')], input({ override: { enabled: true, port: 1234, serveOnLocalNetwork: false, apiKeyEnabled: true, apiKey: 'sk-1' } })).providers
  check('dsh: the XLM API key goes in an Authorization header', H.syncDshPatch(null, keyed).text.includes('Authorization: Bearer sk-1'))
}

// ---- Versions
check('0.2.1-rc.2 is older than 0.2.1', H.compareVersions('0.2.1-rc.2', '0.2.1') < 0)
check('0.2.1-rc.10 is newer than 0.2.1-rc.2', H.compareVersions('0.2.1-rc.10', '0.2.1-rc.2') > 0)
check('1.19.5 is newer than 1.9.20', H.compareVersions('1.19.5', '1.9.20') > 0)
check('equal versions compare equal', H.compareVersions('v1.5.2', '1.5.2') === 0)
check('a version is found in command output', H.extractVersion('pi coding agent v1.5.2 (node 22)') === '1.5.2' && H.extractVersion('0.2.1-rc.2\n') === '0.2.1-rc.2')

// ---- Settings
{
  const s = H.migrateHarnessSettings({ syncOn: ['pi', 'bogus', 'pi', 'dsh'], configDirs: { dsh: ' /h ', x: '/y' }, pithagorasDir: ' /p ' })
  {
    const legacy = H.migrateHarnessSettings({ syncEnabled: true, syncOff: ['pi'] })
    check('settings: the old master switch becomes per-harness switches', legacy.syncOn.join() === 'dsh,opencode,pithagoras' && H.migrateHarnessSettings({ syncEnabled: false }).syncOn.length === 0)
  }
  check('settings: junk is dropped and values trimmed', s.syncOn.join() === 'dsh,pi' && s.configDirs.dsh === '/h' && !('x' in s.configDirs) && s.pithagorasDir === '/p' && s.autoUpdate === false)
}

// ---- Reasoning
{
  const think = () => '{% if enable_thinking %}<think>{% endif %}'
  const t = args => ({ modelPath: '/m/a.gguf', args })
  check('reasoning: a thinking chat template means a reasoning model', H.templateReasoning(t({}), think) === true && H.templateReasoning(t({}), () => '{{ messages }}') === false && H.templateReasoning(t({}), () => null) === false)
  check('reasoning: --reasoning off wins over the template, on over its absence', H.templateReasoning(t({ '--reasoning': 'off' }), think) === false && H.templateReasoning(t({ '--reasoning': 'on' }), () => null) === true)
  check('reasoning: a zero budget turns it off', H.templateReasoning(t({ '--reasoning-budget': 0 }), think) === false && H.templateReasoning(t({ '--reasoning-budget': -1 }), think) === true)
  check('reasoning: enable_thinking false in the kwargs turns it off', H.templateReasoning(t({ '--chat-template-kwargs': '{"enable_thinking": false}' }), think) === false && H.templateReasoning(t({ '--chat-template-kwargs': 'junk' }), think) === true)
  check('reasoning: a template given inline is read instead of the model\'s', H.templateReasoning(t({ '--chat-template': '<think>{{ x }}' }), () => '{{ messages }}') === true && H.templateReasoning(t({ '--chat-template': 'chatml' }), think) === true)
  const prov = H.buildHarnessProviders([tpl('A')], { ...input(), chatTemplate: think }).providers
  check('reasoning: the flag reaches the provider models', prov[0].models[0].reasoning === true)
  check('pi: a reasoning model is marked', JSON.parse(H.syncPiModels(null, prov).text).providers['xlm-studio'].models[0].reasoning === true)
  check('pi: a plain model carries no flag', !('reasoning' in JSON.parse(H.syncPiModels(null, H.buildHarnessProviders([tpl('A')], input()).providers).text).providers['xlm-studio'].models[0]))
  check('opencode: a reasoning model has capabilities.reasoning.supported', JSON.parse(H.syncOpencodeConfig(null, prov).text).providers['xlm-studio'].models.A.capabilities.reasoning.supported === true)
}

// ---- MCP entries
{
  const mcp = { url: 'http://127.0.0.1:7777/mcp', token: 'tok' }
  const provs = H.buildHarnessProviders([tpl('A')], input()).providers
  const oc = H.syncOpencodeConfig(null, provs, mcp)
  const j = JSON.parse(oc.text)
  check('opencode mcp: a remote server under mcp.servers', j.mcp.servers['xlm-studio'].type === 'remote' && j.mcp.servers['xlm-studio'].url === mcp.url && j.mcp.servers['xlm-studio'].headers.Authorization === 'Bearer tok' && j.mcp.servers['xlm-studio'].oauth === false)
  check('opencode mcp: nothing to change the second time', !H.syncOpencodeConfig(oc.text, provs, mcp).changed)
  const jc = t => JSON.parse(t.replace(/^\s*\/\/.*\n/gm, ''))
  const own = '{\n  // mine\n  "mcp": { "servers": { "other": { "type": "remote", "url": "http://x" } } }\n}\n'
  const added = H.syncOpencodeConfig(own, provs, mcp)
  check('opencode mcp: other servers and comments survive', jc(added.text).mcp.servers.other.url === 'http://x' && added.text.includes('// mine'))
  const gone = H.syncOpencodeConfig(added.text, provs, null)
  check('opencode mcp: removal takes only the xlm-studio entry', jc(gone.text).mcp.servers.other && !jc(gone.text).mcp.servers['xlm-studio'])
  const clean = H.syncOpencodeConfig(oc.text, [], null)
  check('opencode mcp: a container the removal empties is removed', !('mcp' in JSON.parse(clean.text)) && !('providers' in JSON.parse(clean.text)) || !JSON.parse(clean.text).mcp)
  check('opencode mcp: no mcp and no file means no file', H.syncOpencodeConfig(null, [], null).text === '')

  const dsh = H.syncDshPatch('- id: other\n  config:\n    a: 1\n', provs, mcp)
  check('dsh mcp: an mcp-client entry with streamable-http', dsh.text.includes('id: xlm-studio-mcp') && /name: ["']@deepseek-ai\/dsh-mcp-client["']/.test(dsh.text) && dsh.text.includes('transport: streamable-http') && dsh.text.includes('url: http://127.0.0.1:7777/mcp') && dsh.text.includes('Authorization: Bearer tok'))
  check('dsh mcp: the other entry stays', dsh.text.includes('id: other') && dsh.text.includes('a: 1'))
  check('dsh mcp: unchanged the second time', !H.syncDshPatch(dsh.text, provs, mcp).changed)
  const moved = H.syncDshPatch(dsh.text, provs, { ...mcp, token: 'new' })
  check('dsh mcp: a new token replaces the entry, not adds one', (moved.text.match(/xlm-studio-mcp/g) || []).length === 1 && moved.text.includes('Bearer new'))
  const off = H.syncDshPatch(dsh.text, provs, null)
  check('dsh mcp: removed, providers kept', !off.text.includes('xlm-studio-mcp') && off.text.includes('xlm-studio') && off.text.includes('id: other'))
  check('dsh mcp: mcp alone works without providers', H.syncDshPatch(null, [], mcp).text.includes('xlm-studio-mcp') && !H.syncDshPatch(null, [], mcp).text.includes('llm-pi-ai'))
}

// ---- The newer harnesses
{
  const { spawnSync } = require('child_process')
  const jc = t => JSON.parse(t.replace(/^\s*\/\/.*\n/gm, '').replace(/\s\/\/ .*$/gm, ''))
  const mcp = { url: 'http://127.0.0.1:7777/mcp', token: 'tok' }
  const provs = H.buildHarnessProviders([
    tpl('A', { args: { '--ctx-size': 32768, '--mmproj': '/m/mm.gguf' } }),
    tpl('B "q"', { serverPort: 9000, args: { __ignoreBaseUrlOverride: true, '--ctx-size': 8192, '--api-key': 'secret$1' } }),
    tpl('C', { args: { '--reasoning': 'on' } })
  ], input()).providers
  const toml = text => {
    const r = spawnSync('python3', ['-c', 'import tomllib,sys,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: text, encoding: 'utf-8' })
    return r.error ? null : r.status === 0 ? JSON.parse(r.stdout) : { error: r.stderr }
  }

  check('every harness is listed once, Pithagoras last', H.HARNESS_ORDER.length === Object.keys(H.HARNESSES).length && new Set(H.HARNESS_ORDER).size === H.HARNESS_ORDER.length && H.HARNESS_ORDER[H.HARNESS_ORDER.length - 1] === 'pithagoras')
  check('the new harnesses are known and sync settings keep them in order', ['kimi', 'qwen', 'crush', 'goose'].every(H.isHarnessId) && JSON.stringify(H.migrateHarnessSettings({ syncOn: ['goose', 'nope', 'kimi'] }).syncOn) === '["kimi","goose"]')
  check('MCP goes to the harnesses with an MCP client only', ['dsh', 'opencode', 'kimi', 'qwen', 'crush', 'goose'].every(H.hasMcpClient) && !H.hasMcpClient('pi') && !H.hasMcpClient('pithagoras'))

  // --- Kimi Code
  const k0 = '# my settings\ndefault_model = "kimi-code/k3"\nnotes = [\n  ["xlm-studio"]\n]\n\n[providers."managed:kimi-code"]\ntype = "kimi"\napi_key = ""\n\n# the k3 model\n[models."kimi-code/k3"]\nprovider = "managed:kimi-code"\nmodel = "k3"\nmax_context_size = 1048576\ncapabilities = [\n  "thinking",\n  "image_in",\n]\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "x"\n'
  const k1 = H.syncKimiConfig(k0, provs)
  check('kimi: the file keeps every line it had, ours come after', k1.changed && k1.text.startsWith(k0.trimEnd()) && k1.text.includes('# the k3 model\n[models."kimi-code/k3"]'))
  check('kimi: a provider per endpoint and a model alias per template', /\[providers\.xlm-studio\]/.test(k1.text) && /\[providers\.xlm-studio-9000\]/.test(k1.text) && k1.text.includes('[models."xlm-studio/A"]') && k1.text.includes('[models."xlm-studio/B \\"q\\""]'))
  check('kimi: nothing to change the second time', !H.syncKimiConfig(k1.text, provs).changed)
  const parsed = toml(k1.text)
  if (parsed === null) console.log('SKIP  kimi: python3 is not here to parse the TOML')
  else {
    const m = parsed.models?.['xlm-studio/A']
    check('kimi: the output is valid TOML with the fields Kimi needs', !parsed.error && parsed.providers['xlm-studio'].type === 'openai' && parsed.providers['xlm-studio'].base_url === 'http://localhost:1234/v1' && m.provider === 'xlm-studio' && m.model === 'A' && m.max_context_size === 32768, parsed.error)
    check('kimi: vision, thinking and tools are capability tags', !parsed.error && m.capabilities.includes('image_in') && !m.capabilities.includes('thinking') && parsed.models['xlm-studio/C'].capabilities.includes('thinking') && m.capabilities.includes('tool_use'))
    check('kimi: the user tables and arrays are untouched', !parsed.error && parsed.default_model === 'kimi-code/k3' && parsed.models['kimi-code/k3'].capabilities.length === 2 && parsed.hooks.length === 1 && parsed.notes[0][0] === 'xlm-studio')
    check('kimi: a real key is written as it is', !parsed.error && parsed.providers['xlm-studio-9000'].api_key === 'secret$1' && parsed.providers['xlm-studio'].api_key === 'xlm-studio')
  }
  const k2 = H.syncKimiConfig(k1.text, provs.slice(1))
  check('kimi: a provider that is gone leaves with its models', !k2.text.includes('"xlm-studio/A"') && !/\[providers\.xlm-studio\]/.test(k2.text) && /\[providers\.xlm-studio-9000\]/.test(k2.text))
  check('kimi: removal gives the original file back', H.syncKimiConfig(k1.text, []).text === k0)
  check('kimi: removal leaves a file without our tables untouched', !H.syncKimiConfig('a = 1', []).changed && !H.syncKimiConfig(null, []).changed)
  check('kimi: a model that changed is replaced, not repeated', (H.syncKimiConfig(k1.text, H.buildHarnessProviders([tpl('A', { args: { '--ctx-size': 4096 } })], input()).providers).text.match(/\[models\."xlm-studio\/A"\]/g) || []).length === 1)
  const km = H.syncKimiMcp(null, mcp)
  check('kimi mcp: an HTTP server under mcpServers', JSON.parse(km.text).mcpServers['xlm-studio'].url === mcp.url && JSON.parse(km.text).mcpServers['xlm-studio'].headers.Authorization === 'Bearer tok' && !('transport' in JSON.parse(km.text).mcpServers['xlm-studio']))
  check('kimi mcp: other servers survive, removal empties nothing else', (() => {
    const own = H.syncKimiMcp('{"mcpServers":{"fs":{"command":"npx"}}}', mcp).text
    const back = JSON.parse(H.syncKimiMcp(own, null).text)
    return JSON.parse(own).mcpServers.fs.command === 'npx' && back.mcpServers.fs.command === 'npx' && !('xlm-studio' in back.mcpServers) && !H.syncKimiMcp(null, null).changed && JSON.stringify(JSON.parse(H.syncKimiMcp(km.text, null).text)) === '{}'
  })())

  // --- Qwen Code
  const q0 = '{\n  // my theme\n  "ui": { "theme": "dark" },\n  "env": { "MY_KEY": "k" },\n  "modelProviders": {\n    "openai": [\n      // mine\n      { "id": "gpt-4o", "envKey": "OPENAI_API_KEY", "baseUrl": "https://api.openai.com/v1" }\n    ]\n  },\n  "mcpServers": { "other": { "httpUrl": "http://x/mcp" } }\n}\n'
  const q1 = H.syncQwenSettings(q0, provs, mcp)
  const qj = jc(q1.text)
  const ours = qj.modelProviders.openai.filter(e => e.envKey.startsWith('XLM_STUDIO_API_KEY'))
  check('qwen: one entry per model, the user entry first and intact', q1.changed && qj.modelProviders.openai.length === 4 && qj.modelProviders.openai[0].id === 'gpt-4o' && ours.length === 3)
  check('qwen: comments and other settings survive', q1.text.includes('// my theme') && q1.text.includes('// mine') && qj.ui.theme === 'dark' && qj.env.MY_KEY === 'k' && qj.mcpServers.other.httpUrl === 'http://x/mcp')
  check('qwen: the key comes from the env block, one variable per endpoint', qj.env.XLM_STUDIO_API_KEY === 'xlm-studio' && qj.env.XLM_STUDIO_API_KEY_9000 === 'secret$1' && ours.find(e => e.id === 'A').envKey === 'XLM_STUDIO_API_KEY' && ours.find(e => e.id === 'B "q"').envKey === 'XLM_STUDIO_API_KEY_9000')
  check('qwen: context, image input and thinking are per model', ours.find(e => e.id === 'A').generationConfig.contextWindowSize === 32768 && ours.find(e => e.id === 'A').generationConfig.modalities.image === true && ours.find(e => e.id === 'C').capabilities.reasoning.profile === 'qwen-chat-template' && !ours.find(e => e.id === 'A').capabilities && ours.find(e => e.id === 'A').baseUrl === 'http://localhost:1234/v1')
  check('qwen: MCP is a streamable HTTP server', qj.mcpServers['xlm-studio'].httpUrl === mcp.url && qj.mcpServers['xlm-studio'].headers.Authorization === 'Bearer tok' && !('url' in qj.mcpServers['xlm-studio']))
  check('qwen: nothing to change the second time', !H.syncQwenSettings(q1.text, provs, mcp).changed)
  const q2 = H.syncQwenSettings(q1.text, provs.slice(0, 1), null)
  check('qwen: a stale entry, its key and the MCP server are removed', jc(q2.text).modelProviders.openai.filter(e => e.envKey.startsWith('XLM')).every(e => e.id !== 'B "q"') && !('XLM_STUDIO_API_KEY_9000' in jc(q2.text).env) && !('xlm-studio' in jc(q2.text).mcpServers))
  const q3 = H.syncQwenSettings(q1.text, [], null)
  check('qwen: removal gives back the user settings', q3.text.includes('// my theme') && q3.text.includes('// mine') && !q3.text.includes('xlm-studio') && !q3.text.includes('XLM_STUDIO') && jc(q3.text).modelProviders.openai.length === 1 && Object.keys(jc(q3.text).env).join() === 'MY_KEY')
  check('qwen: an empty settings file gets the entries and no empty containers are left on removal', (() => {
    const made = H.syncQwenSettings(null, provs, mcp)
    const gone = jc(H.syncQwenSettings(made.text, [], null).text)
    return made.changed && jc(made.text).modelProviders.openai.length === 3 && Object.keys(gone).length === 0
  })())
  check('qwen: no file is made for nothing', !H.syncQwenSettings(null, [], null).changed && H.syncQwenSettings(null, [], null).text === '' && !H.syncQwenSettings('{"a":1}', [], null).changed)
  check('qwen: a modelProviders.openai that is not a list is left alone', throws(() => H.syncQwenSettings('{"modelProviders":{"openai":{}}}', provs, null)))

  // --- Crush
  const c0 = '{\n  "$schema": "https://charm.land/crush.json",\n  "providers": { "mine": { "type": "completions", "base_url": "http://x/v1", "models": [] } },\n  "mcp": { "other": { "type": "http", "url": "http://x/mcp" } }\n}\n'
  const c1 = H.syncCrushConfig(c0, provs, mcp)
  const cj = JSON.parse(c1.text)
  check('crush: a provider per endpoint beside the user ones', c1.changed && cj.providers.mine.base_url === 'http://x/v1' && cj.providers['xlm-studio'].base_url === 'http://localhost:1234/v1' && cj.providers['xlm-studio-9000'].base_url === 'http://localhost:9000/v1')
  check('crush: chat completions, a key, no model discovery', cj.providers['xlm-studio'].type === 'completions' && cj.providers['xlm-studio'].api_key === 'xlm-studio' && cj.providers['xlm-studio'].discover_models === false)
  check('crush: a key goes through a shell, so $ is escaped', cj.providers['xlm-studio-9000'].api_key === 'secret\\$1')
  const cm = cj.providers['xlm-studio'].models
  check('crush: context, vision and thinking are per model', cm.find(m => m.id === 'A').context_window === 32768 && cm.find(m => m.id === 'A').default_max_tokens === 32768 && cm.find(m => m.id === 'A').capabilities.vision === true && cm.find(m => m.id === 'C').reasoning.thinking === 'toggleable' && cm.find(m => m.id === 'A').reasoning.thinking === 'never')
  check('crush: MCP is an http server', cj.mcp['xlm-studio'].type === 'http' && cj.mcp['xlm-studio'].url === mcp.url && cj.mcp['xlm-studio'].headers.Authorization === 'Bearer tok' && cj.mcp.other.url === 'http://x/mcp')
  check('crush: nothing to change the second time', !H.syncCrushConfig(c1.text, provs, mcp).changed)
  const c2 = JSON.parse(H.syncCrushConfig(c1.text, [], null).text)
  check('crush: removal keeps the user entries only', Object.keys(c2.providers).join() === 'mine' && Object.keys(c2.mcp).join() === 'other')
  check('crush: a new file has the schema; nothing is made for nothing', JSON.parse(H.syncCrushConfig(null, provs, null).text).$schema === 'https://charm.land/crush.json' && !H.syncCrushConfig(null, [], null).changed)

  // --- Goose
  const g0 = '# goose\nGOOSE_PROVIDER: openai\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n    name: developer\n'
  const g1 = H.syncGooseConfig(g0, mcp)
  check('goose: an extension beside the existing ones', g1.changed && g1.text.includes('# goose') && g1.text.includes('developer:') && /xlm-studio:\n/.test(g1.text) && g1.text.includes('type: streamable_http') && g1.text.includes(`uri: ${mcp.url}`) && g1.text.includes('Authorization: Bearer tok'))
  check('goose: nothing to change the second time', !H.syncGooseConfig(g1.text, mcp).changed)
  check('goose: a switch the user turned off stays off', (() => {
    const off = g1.text.replace(/(xlm-studio:\n\s+enabled: )true/, '$1false')
    return off !== g1.text && !H.syncGooseConfig(off, mcp).changed && /enabled: false/.test(H.syncGooseConfig(off.replace('Bearer tok', 'Bearer old'), mcp).text)
  })())
  check('goose: removal takes our extension only', H.syncGooseConfig(g1.text, null).text === g0)
  check('goose: removal empties nothing else, and the key goes with its last extension', !/extensions/.test(H.syncGooseConfig('a: 1\nextensions:\n  xlm-studio:\n    enabled: true\n    name: xlm-studio\n', null).text))
  check('goose: the file is never made', !H.syncGooseConfig(null, mcp).changed && H.syncGooseConfig(null, mcp).text === '' && !H.syncGooseConfig('', mcp).changed)
  check('goose: a file with no extensions gets the key', /extensions:\n  xlm-studio:/.test(H.syncGooseConfig('GOOSE_PROVIDER: x\n', mcp).text))
  check('goose: a file that is not YAML is left alone', throws(() => H.syncGooseConfig('a: [1\n', mcp)))

  const gp = H.planGooseProviders({}, provs)
  const gMain = JSON.parse(gp.write.find(f => f.name === 'xlm-studio.json').text)
  const gOwn = JSON.parse(gp.write.find(f => f.name === 'xlm-studio-9000.json').text)
  check('goose providers: one file per endpoint named after the provider id', gp.write.length === 2 && gp.remove.length === 0 && gMain.name === 'xlm-studio' && gOwn.name === 'xlm-studio-9000')
  check('goose providers: an OpenAI engine, the base URL, a static model list', gMain.engine === 'openai' && gMain.base_url === 'http://localhost:1234/v1' && gMain.dynamic_models === false && gMain.models.map(m => m.name).join() === 'A,C' && gMain.display_name === 'XLM Studio')
  check('goose providers: no key needed when there is none', gMain.requires_auth === false && gMain.api_key_env === '' && gOwn.requires_auth === true && gOwn.api_key_env === 'XLM_STUDIO_API_KEY_9000')
  check('goose providers: context and vision per model; thinking is not switched on', gMain.models[0].context_limit === 32768 && gMain.models[0].supports_vision === true && gMain.models[1].supports_vision === false && gMain.models.every(m => m.reasoning === false))
  const onDisk = Object.fromEntries(gp.write.map(f => [f.name, f.text]))
  check('goose providers: nothing to do when the files are current', H.planGooseProviders(onDisk, provs).write.length === 0 && H.planGooseProviders(onDisk, provs).remove.length === 0)
  const stale = { ...onDisk, 'xlm-studio-7001.json': JSON.stringify({ name: 'xlm-studio-7001' }), 'xlm-studio-notes.json': JSON.stringify({ name: 'something else' }), 'mine.json': JSON.stringify({ name: 'mine' }) }
  const swept = H.planGooseProviders(stale, provs.slice(0, 1))
  check('goose providers: a stale file of ours goes, a lookalike or user file stays', swept.remove.sort().join() === 'xlm-studio-7001.json,xlm-studio-9000.json' && swept.write.length === 0)
  check('goose providers: removing everything takes our files only', H.planGooseProviders(stale, []).remove.sort().join() === 'xlm-studio-7001.json,xlm-studio-9000.json,xlm-studio.json')
}

// ---- .env
{
  const example = '# Required\nPORTAL_PASSWORD=change-me\nPORTAL_SECRET=\n# WORKSPACES_DIR=/root/repos\nEXECUTOR=host\n'
  check('env: a commented key is switched on', H.setEnvKey(example, 'WORKSPACES_DIR', 'C:/Users/me/repos').includes('\nWORKSPACES_DIR=C:/Users/me/repos\n') && !H.setEnvKey(example, 'WORKSPACES_DIR', '/r').includes('# WORKSPACES_DIR'))
  check('env: a set key is replaced, not repeated', (H.setEnvKey(example, 'PORTAL_PASSWORD', 'pw1').match(/PORTAL_PASSWORD/g) || []).length === 1 && H.setEnvKey(example, 'PORTAL_PASSWORD', 'pw1').includes('PORTAL_PASSWORD=pw1'))
  check('env: a missing key is appended', H.setEnvKey('A=1', 'B', '2') === 'A=1\nB=2\n')
  check('env: spaces get single quotes', H.setEnvKey('', 'W', 'C:/My Repos') === "W='C:/My Repos'\n")
  check('env: an active line beats a commented one', H.setEnvKey('# W=old\nW=a\n', 'W', 'b') === '# W=old\nW=b\n')
  check('env: a value is told from an empty or commented key', H.envHasValue(example, 'PORTAL_PASSWORD') && !H.envHasValue(example, 'PORTAL_SECRET') && !H.envHasValue(example, 'WORKSPACES_DIR'))
  check('settings: the workspaces folder is kept trimmed', H.migrateHarnessSettings({ pithagorasWorkspacesDir: ' /w ' }).pithagorasWorkspacesDir === '/w')
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed')
process.exit(failed ? 1 : 0)

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

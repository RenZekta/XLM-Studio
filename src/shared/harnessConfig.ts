import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { MCP_ENTRY_NAME, PLACEHOLDER_API_KEY, XLM_PROVIDER_PREFIX, type HarnessMcp, type HarnessModel, type HarnessProvider } from './harnesses'

// How each harness's provider config is edited: only the entries XLM Studio
// owns change, everything else (other keys, comments) is left as it was.

export class HarnessConfigError extends Error {}

export interface SyncResult {
  text: string
  changed: boolean
}

function ownedKeys(map: Record<string, unknown> | undefined): string[] {
  return Object.keys(map || {}).filter(k => k === XLM_PROVIDER_PREFIX || k.startsWith(`${XLM_PROVIDER_PREFIX}-`))
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  return ka.every(k => sameJson((a as any)[k], (b as any)[k]))
}

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } }

function parseJsonc(text: string, what: string): Record<string, any> {
  if (!text.trim()) return {}
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length) throw new HarnessConfigError(`${what} is not valid JSON, so it was left unchanged`)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HarnessConfigError(`${what} does not hold a JSON object, so it was left unchanged`)
  return value
}

// Sets or removes (value undefined) the owned provider entries under
// `rootKey`, leaving every other key and the file's comments alone.
function syncJsoncProviders(text: string | null, rootKey: string, entries: Record<string, unknown>, what: string, seed: Record<string, unknown>): SyncResult {
  const original = text ?? ''
  const root = parseJsonc(original, what)
  const existing = (root[rootKey] && typeof root[rootKey] === 'object' ? root[rootKey] : undefined) as Record<string, unknown> | undefined
  let out = original.trim() ? original : '{}\n'
  const stale = ownedKeys(existing).filter(k => !(k in entries))
  const todo = Object.entries(entries).filter(([k, v]) => !sameJson(existing?.[k], v))
  if (!todo.length && !stale.length) return { text: original, changed: false }
  if (!original.trim()) {
    for (const [k, v] of Object.entries(seed)) out = applyEdits(out, modify(out, [k], v, JSON_FORMAT))
  }
  for (const k of stale) out = applyEdits(out, modify(out, [rootKey, k], undefined, JSON_FORMAT))
  for (const [k, v] of todo) out = applyEdits(out, modify(out, [rootKey, k], v, JSON_FORMAT))
  if (!out.endsWith('\n')) out += '\n'
  return { text: out, changed: out !== original }
}

const LLAMA_COMPAT = { supportsDeveloperRole: false, maxTokensField: 'max_tokens' }

function imageInput(m: HarnessModel): string[] {
  return m.vision ? ['text', 'image'] : ['text']
}

// pi and Pithagoras: <agent dir>/models.json.
export function syncPiModels(text: string | null, providers: HarnessProvider[]): SyncResult {
  const entries: Record<string, unknown> = {}
  for (const p of providers) {
    entries[p.id] = {
      name: p.label,
      baseUrl: p.baseUrl,
      api: 'openai-completions',
      // pi needs a key to list a provider's models; a keyless server ignores it.
      apiKey: p.apiKey || PLACEHOLDER_API_KEY,
      compat: LLAMA_COMPAT,
      models: p.models.map(m => ({
        id: m.id,
        name: m.name,
        input: imageInput(m),
        ...(m.reasoning ? { reasoning: true } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow, maxTokens: m.maxTokens } : {})
      }))
    }
  }
  return syncJsoncProviders(text, 'providers', entries, 'models.json', { $schema: 'https://pi.dev/schemas/models.schema.json' })
}

function valueAt(root: unknown, path: string[]): unknown {
  return path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), root)
}

// Sets or removes (want undefined) the one entry at `path`, leaving the rest of
// the file alone. A container this removal empties is removed too.
function syncJsoncEntry(text: string, path: string[], want: unknown, what: string, seed: Record<string, unknown>): SyncResult {
  const root = parseJsonc(text, what)
  if (sameJson(valueAt(root, path), want)) return { text, changed: false }
  let out = text.trim() ? text : '{}\n'
  if (!text.trim()) for (const [k, v] of Object.entries(seed)) out = applyEdits(out, modify(out, [k], v, JSON_FORMAT))
  out = applyEdits(out, modify(out, path, want, JSON_FORMAT))
  if (want === undefined) {
    for (let n = path.length - 1; n >= 1; n--) {
      const holder = valueAt(parseJsonc(out, what), path.slice(0, n))
      if (!holder || typeof holder !== 'object' || Array.isArray(holder) || Object.keys(holder).length) break
      out = applyEdits(out, modify(out, path.slice(0, n), undefined, JSON_FORMAT))
    }
  }
  if (!out.endsWith('\n')) out += '\n'
  return { text: out, changed: out !== text }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

// opencode: XLM Studio's entry under mcp.servers.
function syncJsoncMcp(text: string, mcp: HarnessMcp | null, what: string, seed: Record<string, unknown>): SyncResult {
  const want = mcp ? { type: 'remote', url: mcp.url, headers: bearer(mcp.token), oauth: false } : undefined
  return syncJsoncEntry(text, ['mcp', 'servers', MCP_ENTRY_NAME], want, what, seed)
}

// opencode 2: opencode.json(c) in its config folder.
export function syncOpencodeConfig(text: string | null, providers: HarnessProvider[], mcp: HarnessMcp | null = null): SyncResult {
  const entries: Record<string, unknown> = {}
  for (const p of providers) {
    const models: Record<string, unknown> = {}
    for (const m of p.models) {
      models[m.id] = {
        modelID: m.id,
        name: m.name,
        ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens } } : {}),
        capabilities: { tools: true, input: imageInput(m), output: ['text'], ...(m.reasoning ? { reasoning: { supported: true } } : {}) }
      }
    }
    entries[p.id] = {
      name: p.label,
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: p.baseUrl, apiKey: p.apiKey || PLACEHOLDER_API_KEY },
      models
    }
  }
  const seed = { $schema: 'https://opencode.ai/config.json' }
  const a = syncJsoncProviders(text, 'providers', entries, 'opencode.json', seed)
  const b = syncJsoncMcp(a.text, mcp, 'opencode.json', seed)
  return { text: b.text, changed: a.changed || b.changed }
}

// dsh: <DSH_HOME>/profiles/<profile>/cordis.patch.yml. A plugin entry is a
// full replacement of that plugin's config, so the owned routes are merged
// into the providers the entry already has and nothing else is touched.
const DSH_PLUGIN_IDS = ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai']

function dshEntry(items: unknown[]): YAMLMap | null {
  for (const item of items) {
    if (!isMap(item)) continue
    const id = item.get('id')
    const name = item.get('name')
    if ((typeof id === 'string' && DSH_PLUGIN_IDS.includes(id)) || (typeof name === 'string' && DSH_PLUGIN_IDS.includes(name))) return item
  }
  return null
}

function childMap(parent: YAMLMap, key: string): YAMLMap {
  const existing = parent.get(key, true)
  if (isMap(existing)) return existing
  const created = new YAMLMap()
  parent.set(key, created)
  return created
}

const DSH_MCP_ID = 'xlm-studio-mcp'

// A plugin entry of the MCP client, one per server, found by its id.
function dshMcpIndex(items: unknown[]): number {
  return items.findIndex(item => isMap(item) && item.get('id') === DSH_MCP_ID)
}

export function syncDshPatch(text: string | null, providers: HarnessProvider[], mcp: HarnessMcp | null = null): SyncResult {
  const original = text ?? ''
  const doc = original.trim() ? parseDocument(original) : new Document(new YAMLSeq())
  if (doc.errors.length) throw new HarnessConfigError('cordis.patch.yml is not valid YAML, so it was left unchanged')
  if (doc.contents === null) doc.contents = new YAMLSeq()
  if (!isSeq(doc.contents)) throw new HarnessConfigError('cordis.patch.yml has an unexpected layout, so it was left unchanged')
  const seq = doc.contents

  const entries: Record<string, unknown> = {}
  for (const p of providers) {
    entries[p.id] = {
      displayName: p.label,
      api: 'openai-completions',
      baseURL: p.baseUrl,
      headers: { Authorization: `Bearer ${p.apiKey || PLACEHOLDER_API_KEY}` },
      compat: LLAMA_COMPAT,
      models: p.models.map(m => ({
        id: m.id,
        name: m.name,
        input: imageInput(m),
        ...(m.contextWindow ? { contextWindow: m.contextWindow, maxTokens: m.maxTokens } : {})
      }))
    }
  }

  let touched = false
  let entry = dshEntry(seq.items)
  if (!entry && providers.length) {
    entry = doc.createNode({ id: DSH_PLUGIN_IDS[0], config: { providers: {} } }) as YAMLMap
    seq.items.push(entry)
  }
  if (entry) {
    const map = childMap(childMap(entry, 'config'), 'providers')
    const existing = (map.toJSON() || {}) as Record<string, unknown>
    for (const k of ownedKeys(existing)) if (!(k in entries)) { map.delete(k); touched = true }
    for (const [k, v] of Object.entries(entries)) {
      if (!sameJson(existing[k], v)) { map.set(k, doc.createNode(v)); touched = true }
    }
  }

  // XLM Studio's MCP server: a plugin entry of the generic MCP client.
  const at = dshMcpIndex(seq.items)
  if (!mcp) {
    if (at >= 0) { seq.items.splice(at, 1); touched = true }
  } else {
    const want = {
      id: DSH_MCP_ID,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: MCP_ENTRY_NAME,
        transport: 'streamable-http',
        url: mcp.url,
        headers: { Authorization: `Bearer ${mcp.token}` },
        // Starting and benchmarking a model can take minutes.
        toolCallTimeoutMs: 300000
      }
    }
    if (at < 0) { seq.items.push(doc.createNode(want)); touched = true } else if (!sameJson((seq.items[at] as YAMLMap).toJSON(), want)) {
      seq.items[at] = doc.createNode(want)
      touched = true
    }
  }

  if (!touched) return { text: original, changed: false }
  const out = doc.toString({ lineWidth: 0 })
  return { text: out, changed: out !== original }
}

// ---------------------------------------------------------------------------
// Kimi Code: ~/.kimi-code/config.toml (providers, models) and mcp.json
// ---------------------------------------------------------------------------

// max_context_size is required there; a model whose size can't be told gets this.
export const KIMI_FALLBACK_CONTEXT = 131072

// TOML basic string. JSON escaping is valid TOML except for DEL.
function tomlStr(s: string): string {
  return JSON.stringify(s).replace(/\x7f/g, '\\u007f')
}

function tomlKey(s: string): string {
  return /^[A-Za-z0-9_-]+$/.test(s) ? s : tomlStr(s)
}

interface TomlScan { ml: string | null; depth: number }

// Tracks what the end of a line leaves open: a multi-line string, or an array.
// A line that starts inside either is never a table header.
function scanToml(line: string, st: TomlScan): void {
  let i = 0
  const n = line.length
  while (i < n) {
    const c = line[i]
    if (st.ml) {
      if (st.ml === '"""' && c === '\\') { i += 2; continue }
      if (line.startsWith(st.ml, i)) {
        i += 3
        while (line[i] === st.ml[0]) i++
        st.ml = null
        continue
      }
      i++
      continue
    }
    if (c === '#') break
    if (line.startsWith('"""', i)) { st.ml = '"""'; i += 3; continue }
    if (line.startsWith("'''", i)) { st.ml = "'''"; i += 3; continue }
    if (c === '"') { i++; while (i < n && line[i] !== '"') { if (line[i] === '\\') i++; i++ } i++; continue }
    if (c === "'") { i++; while (i < n && line[i] !== "'") i++; i++; continue }
    if (c === '[') st.depth++
    else if (c === ']') st.depth = Math.max(0, st.depth - 1)
    i++
  }
}

// The key path of a [table] or [[array]] header line, or null when the line is not one.
function tomlHeaderPath(line: string): string[] | null {
  const m = /^\s*(\[\[?)/.exec(line)
  if (!m) return null
  const array = m[1] === '[['
  let i = m[0].length
  const parts: string[] = []
  const n = line.length
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t') i++
    let part = ''
    if (line[i] === '"') {
      i++
      while (i < n && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < n) { part += line[i + 1]; i += 2 } else part += line[i++]
      }
      if (line[i] !== '"') return null
      i++
    } else if (line[i] === "'") {
      i++
      while (i < n && line[i] !== "'") part += line[i++]
      if (line[i] !== "'") return null
      i++
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(i))
      if (!bare) return null
      part = bare[0]
      i += part.length
    }
    parts.push(part)
    while (line[i] === ' ' || line[i] === '\t') i++
    if (line[i] === '.') { i++; continue }
    break
  }
  if (line[i] !== ']') return null
  i++
  if (array) { if (line[i] !== ']') return null; i++ }
  return /^\s*(#.*)?$/.test(line.slice(i)) ? parts : null
}

interface TomlBlock { path: string[] | null; lines: string[] }

// Splits a file into its preamble and one block per table header. Comment
// lines directly above a header belong to that header's block.
function tomlBlocks(text: string): TomlBlock[] {
  const lines = text.split(/(?<=\n)/)
  const st: TomlScan = { ml: null, depth: 0 }
  const headers: Array<{ at: number; path: string[] }> = []
  lines.forEach((line, at) => {
    if (!st.ml && st.depth === 0) {
      const path = tomlHeaderPath(line)
      if (path) headers.push({ at, path })
    }
    scanToml(line, st)
  })
  if (!headers.length) return [{ path: null, lines }]
  const starts = headers.map((h, i) => {
    let start = h.at
    const floor = i > 0 ? headers[i - 1].at + 1 : 0
    while (start > floor && /^\s*#/.test(lines[start - 1])) start--
    return start
  })
  const blocks: TomlBlock[] = []
  if (starts[0] > 0) blocks.push({ path: null, lines: lines.slice(0, starts[0]) })
  headers.forEach((h, i) => blocks.push({ path: h.path, lines: lines.slice(starts[i], i + 1 < headers.length ? starts[i + 1] : lines.length) }))
  return blocks
}

function kimiOwned(path: string[] | null): boolean {
  if (!path || path.length < 2) return false
  if (path[0] === 'providers') return path[1] === XLM_PROVIDER_PREFIX || path[1].startsWith(`${XLM_PROVIDER_PREFIX}-`)
  if (path[0] === 'models') return path[1].startsWith(`${XLM_PROVIDER_PREFIX}/`)
  return false
}

function kimiTables(providers: HarnessProvider[]): string {
  const out: string[] = []
  for (const p of providers) {
    out.push(...(out.length ? [''] : ['# XLM Studio keeps the providers and models below in step with its templates.']))
    out.push(`[providers.${tomlKey(p.id)}]`, 'type = "openai"', `base_url = ${tomlStr(p.baseUrl)}`, `api_key = ${tomlStr(p.apiKey || PLACEHOLDER_API_KEY)}`)
    for (const m of p.models) {
      const caps = ['tool_use', ...(m.vision ? ['image_in'] : []), ...(m.reasoning ? ['thinking'] : [])]
      out.push('', `[models.${tomlStr(`${XLM_PROVIDER_PREFIX}/${m.id}`)}]`, `provider = ${tomlStr(p.id)}`, `model = ${tomlStr(m.id)}`,
        `max_context_size = ${m.contextWindow || KIMI_FALLBACK_CONTEXT}`, `capabilities = [${caps.map(tomlStr).join(', ')}]`, `display_name = ${tomlStr(m.name)}`)
    }
  }
  return out.length ? out.join('\n') + '\n' : ''
}

// Replaces the owned tables and leaves every other line as it was.
export function syncKimiConfig(text: string | null, providers: HarnessProvider[]): SyncResult {
  const original = text ?? ''
  const blocks = tomlBlocks(original)
  const tables = kimiTables(providers)
  if (!tables && !blocks.some(b => kimiOwned(b.path))) return { text: original, changed: false }
  const base = blocks.filter(b => !kimiOwned(b.path)).map(b => b.lines.join('')).join('').replace(/\s+$/, '')
  let out = base ? `${base}\n` : ''
  if (tables) out += `${out ? '\n' : ''}${tables}`
  return { text: out, changed: out !== original }
}

// mcp.json: XLM Studio's entry under mcpServers. No transport field means HTTP.
export function syncKimiMcp(text: string | null, mcp: HarnessMcp | null): SyncResult {
  const want = mcp ? { url: mcp.url, headers: bearer(mcp.token) } : undefined
  return syncJsoncEntry(text ?? '', ['mcpServers', MCP_ENTRY_NAME], want, 'mcp.json', {})
}

// ---------------------------------------------------------------------------
// Qwen Code: ~/.qwen/settings.json
// ---------------------------------------------------------------------------

// Qwen never stores a key in a model entry: it names an environment variable,
// which the settings file's own env block can supply. Entries are ours by that
// name. Goose reads a real key from one too.
export const XLM_KEY_PREFIX = 'XLM_STUDIO_API_KEY'

export function xlmKeyName(providerId: string): string {
  const rest = providerId.slice(XLM_PROVIDER_PREFIX.length).toUpperCase().replace(/[^A-Z0-9]+/g, '_')
  return `${XLM_KEY_PREFIX}${rest}`
}

function qwenOwnedEntry(e: unknown): boolean {
  return !!e && typeof e === 'object' && typeof (e as any).envKey === 'string' && (e as any).envKey.startsWith(XLM_KEY_PREFIX)
}

export function syncQwenSettings(text: string | null, providers: HarnessProvider[], mcp: HarnessMcp | null = null): SyncResult {
  const original = text ?? ''
  const root = parseJsonc(original, 'settings.json')
  const wanted: unknown[] = []
  const env: Record<string, string> = {}
  for (const p of providers) {
    const envKey = xlmKeyName(p.id)
    env[envKey] = p.apiKey || PLACEHOLDER_API_KEY
    for (const m of p.models) {
      const generation: Record<string, unknown> = {}
      if (m.contextWindow) generation.contextWindowSize = m.contextWindow
      if (m.vision) generation.modalities = { image: true }
      wanted.push({
        id: m.id,
        name: `${m.name} (${p.label})`,
        envKey,
        baseUrl: p.baseUrl,
        ...(Object.keys(generation).length ? { generationConfig: generation } : {}),
        // A switch for thinking through the chat template (enable_thinking), which llama-server reads.
        ...(m.reasoning ? { capabilities: { reasoning: { profile: 'qwen-chat-template' } } } : {})
      })
    }
  }

  const start = original.trim() ? original : '{}\n'
  let out = start
  const edit = (path: Array<string | number>, value: unknown, insert = false) => {
    out = applyEdits(out, modify(out, path, value, { ...JSON_FORMAT, ...(insert ? { isArrayInsertion: true } : {}) }))
  }
  const reparse = () => parseJsonc(out, 'settings.json')

  const listed = root.modelProviders?.openai
  if (listed !== undefined && !Array.isArray(listed)) throw new HarnessConfigError('settings.json has modelProviders.openai that is not a list, so it was left unchanged')
  const have = (listed ?? []) as unknown[]
  const mine = have.filter(qwenOwnedEntry)
  if (!sameJson(mine, wanted)) {
    // Highest index first, so the others keep theirs.
    for (let i = have.length - 1; i >= 0; i--) if (qwenOwnedEntry(have[i])) edit(['modelProviders', 'openai', i], undefined)
    for (const w of wanted) edit(['modelProviders', 'openai', -1], w, true)
    const after = reparse()
    if (Array.isArray(after.modelProviders?.openai) && !after.modelProviders.openai.length) edit(['modelProviders', 'openai'], undefined)
    const left = reparse()
    if (left.modelProviders && typeof left.modelProviders === 'object' && !Object.keys(left.modelProviders).length) edit(['modelProviders'], undefined)
  }

  const haveEnv = (root.env && typeof root.env === 'object' ? root.env : {}) as Record<string, unknown>
  for (const k of Object.keys(haveEnv)) if (k.startsWith(XLM_KEY_PREFIX) && !(k in env)) edit(['env', k], undefined)
  for (const [k, v] of Object.entries(env)) if (haveEnv[k] !== v) edit(['env', k], v)
  const afterEnv = reparse()
  if (afterEnv.env && typeof afterEnv.env === 'object' && !Object.keys(afterEnv.env).length) edit(['env'], undefined)

  // streamable HTTP is httpUrl; url alone would mean the old SSE transport.
  const wantMcp = mcp ? { httpUrl: mcp.url, headers: bearer(mcp.token) } : undefined
  if (!sameJson(reparse().mcpServers?.[MCP_ENTRY_NAME], wantMcp)) {
    out = syncJsoncEntry(out, ['mcpServers', MCP_ENTRY_NAME], wantMcp, 'settings.json', {}).text
  }

  if (out === start) return { text: original, changed: false }
  if (!out.endsWith('\n')) out += '\n'
  // Nothing to say and nothing there: no file.
  if (!original.trim() && !Object.keys(reparse()).length) return { text: original, changed: false }
  return { text: out, changed: out !== original }
}

// ---------------------------------------------------------------------------
// Crush: ~/.config/crush/crush.json
// ---------------------------------------------------------------------------

// A model's context_window and default_max_tokens must be set for Crush to budget with.
export const CRUSH_FALLBACK_CONTEXT = 131072

// api_key in this file goes through a shell, so $ and ` would be read as code.
function crushKey(key: string): string {
  return key.replace(/[\\$`]/g, '\\$&')
}

export function syncCrushConfig(text: string | null, providers: HarnessProvider[], mcp: HarnessMcp | null = null): SyncResult {
  const entries: Record<string, unknown> = {}
  for (const p of providers) {
    entries[p.id] = {
      name: p.label,
      type: 'completions',
      base_url: p.baseUrl,
      api_key: crushKey(p.apiKey || PLACEHOLDER_API_KEY),
      // The models are listed below; asking /v1/models would only repeat them.
      discover_models: false,
      models: p.models.map(m => ({
        id: m.id,
        name: m.name,
        context_window: m.contextWindow || CRUSH_FALLBACK_CONTEXT,
        default_max_tokens: m.maxTokens || CRUSH_FALLBACK_CONTEXT,
        reasoning: { thinking: m.reasoning ? 'toggleable' : 'never' },
        capabilities: { vision: m.vision, audio: false }
      }))
    }
  }
  const seed = { $schema: 'https://charm.land/crush.json' }
  const a = syncJsoncProviders(text, 'providers', entries, 'crush.json', seed)
  const want = mcp ? { type: 'http', url: mcp.url, headers: bearer(mcp.token), timeout: 300 } : undefined
  const b = syncJsoncEntry(a.text, ['mcp', MCP_ENTRY_NAME], want, 'crush.json', seed)
  return { text: b.text, changed: a.changed || b.changed }
}

// ---------------------------------------------------------------------------
// Goose: custom_providers/<id>.json (one file per provider) and config.yaml
// ---------------------------------------------------------------------------

// Goose reads every .json in custom_providers and refuses the folder when one is
// bad, so a file is only ever written whole. Ours are named after the provider id.
export function gooseProviderFile(id: string): string {
  return `${id}.json`
}

export function isGooseOwnedFile(name: string, text: string | null): boolean {
  const m = /^(.+)\.json$/.exec(name)
  if (!m || !(m[1] === XLM_PROVIDER_PREFIX || m[1].startsWith(`${XLM_PROVIDER_PREFIX}-`))) return false
  if (text === null) return true
  try { return JSON.parse(text)?.name === m[1] } catch { return false }
}

export function gooseProviderJson(p: HarnessProvider): string {
  // A key that is not the placeholder is read by Goose from this variable.
  const real = !!p.apiKey && p.apiKey !== PLACEHOLDER_API_KEY
  return JSON.stringify({
    name: p.id,
    engine: 'openai',
    display_name: p.label,
    description: 'Models served by XLM Studio',
    api_key_env: real ? xlmKeyName(p.id) : '',
    base_url: p.baseUrl,
    models: p.models.map(m => ({
      name: m.id,
      context_limit: m.contextWindow || null,
      input_token_cost: null,
      output_token_cost: null,
      currency: null,
      supports_cache_control: null,
      // Not set even for a thinking model: on an OpenAI model it makes Goose send
      // the system prompt as a "developer" message, which llama.cpp templates reject.
      reasoning: false,
      supports_vision: m.vision
    })),
    supports_streaming: true,
    requires_auth: real,
    // The list above is the list; no /v1/models call.
    dynamic_models: false,
    skip_canonical_filtering: true
  }, null, 2) + '\n'
}

export interface GooseFilePlan {
  write: Array<{ name: string; text: string }>
  remove: string[]
}

// What to do to the custom_providers folder, given the files it holds (name -> text).
export function planGooseProviders(files: Record<string, string>, providers: HarnessProvider[]): GooseFilePlan {
  const wanted = new Map(providers.map(p => [gooseProviderFile(p.id), gooseProviderJson(p)]))
  const write = [...wanted].filter(([name, text]) => files[name] !== text).map(([name, text]) => ({ name, text }))
  const remove = Object.keys(files).filter(name => !wanted.has(name) && isGooseOwnedFile(name, files[name]))
  return { write, remove }
}

// config.yaml: XLM Studio's extension. The file is only edited, never created:
// Goose adds its default extensions when it makes the file itself.
export function syncGooseConfig(text: string | null, mcp: HarnessMcp | null): SyncResult {
  if (text === null || !text.trim()) return { text: text ?? '', changed: false }
  const doc = parseDocument(text)
  if (doc.errors.length) throw new HarnessConfigError('config.yaml is not valid YAML, so it was left unchanged')
  if (!isMap(doc.contents)) throw new HarnessConfigError('config.yaml has an unexpected layout, so it was left unchanged')
  const root = doc.contents as unknown as YAMLMap
  const holder: unknown = root.get('extensions', true)
  const extensions: YAMLMap | null = isMap(holder) ? (holder as YAMLMap) : null
  const current: unknown = extensions?.get(MCP_ENTRY_NAME)
  const existing = current && typeof (current as YAMLMap).toJSON === 'function' ? (current as YAMLMap).toJSON() : undefined
  if (!mcp) {
    if (!extensions || existing === undefined) return { text, changed: false }
    extensions.delete(MCP_ENTRY_NAME)
    if (!extensions.items.length) root.delete('extensions')
  } else {
    const want = {
      // Goose's own switch for it stays as the user left it.
      enabled: typeof existing?.enabled === 'boolean' ? existing.enabled : true,
      type: 'streamable_http',
      name: MCP_ENTRY_NAME,
      description: 'XLM Studio: models, benchmarks and engines',
      uri: mcp.url,
      headers: bearer(mcp.token),
      // Starting and benchmarking a model can take minutes.
      timeout: 600
    }
    if (sameJson(existing, want)) return { text, changed: false }
    let target: YAMLMap | null = extensions
    if (!target) {
      target = new YAMLMap()
      root.set('extensions', target)
    }
    target.set(MCP_ENTRY_NAME, doc.createNode(want))
  }
  const out = doc.toString({ lineWidth: 0 })
  return { text: out, changed: out !== text }
}

// ---------------------------------------------------------------------------
// .env files (Pithagoras reads its settings from one)
// ---------------------------------------------------------------------------

function envLine(key: string): RegExp {
  return new RegExp(`^[ \\t]*(?:#[ \\t]*)?${key}[ \\t]*=.*$`, 'm')
}

// Whether the file sets this key to something (a commented-out line doesn't).
export function envHasValue(text: string, key: string): boolean {
  return new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*[^ \\t\\r\\n#]`, 'm').test(text)
}

// Compose reads plain values as they are and single quotes literally.
function envValue(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]*$/.test(value) ? value : `'${value.replace(/'/g, '')}'`
}

// Sets KEY=value: uncomments the first line for the key, or appends one.
export function setEnvKey(text: string, key: string, value: string): string {
  const line = `${key}=${envValue(value)}`
  // An active line is the one that counts; otherwise a commented example is switched on.
  const active = new RegExp(`^[ \\t]*${key}[ \\t]*=.*$`, 'm')
  const re = active.test(text) ? active : envLine(key)
  if (re.test(text)) return text.replace(re, () => line)
  const sep = text.length && !text.endsWith('\n') ? '\n' : ''
  return `${text}${sep}${line}\n`
}

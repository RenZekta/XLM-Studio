import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { Document, isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { PLACEHOLDER_API_KEY, XLM_PROVIDER_PREFIX, type HarnessModel, type HarnessProvider } from './harnesses'

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
        ...(m.contextWindow ? { contextWindow: m.contextWindow, maxTokens: m.maxTokens } : {})
      }))
    }
  }
  return syncJsoncProviders(text, 'providers', entries, 'models.json', { $schema: 'https://pi.dev/schemas/models.schema.json' })
}

// opencode 2: opencode.json(c) in its config folder.
export function syncOpencodeConfig(text: string | null, providers: HarnessProvider[]): SyncResult {
  const entries: Record<string, unknown> = {}
  for (const p of providers) {
    const models: Record<string, unknown> = {}
    for (const m of p.models) {
      models[m.id] = {
        modelID: m.id,
        name: m.name,
        ...(m.contextWindow ? { limit: { context: m.contextWindow, output: m.maxTokens } } : {}),
        capabilities: { tools: true, input: imageInput(m), output: ['text'] }
      }
    }
    entries[p.id] = {
      name: p.label,
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: p.baseUrl, apiKey: p.apiKey || PLACEHOLDER_API_KEY },
      models
    }
  }
  return syncJsoncProviders(text, 'providers', entries, 'opencode.json', { $schema: 'https://opencode.ai/config.json' })
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

export function syncDshPatch(text: string | null, providers: HarnessProvider[]): SyncResult {
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

  let entry = dshEntry(seq.items)
  if (!entry) {
    if (!providers.length) return { text: original, changed: false }
    entry = doc.createNode({ id: DSH_PLUGIN_IDS[0], config: { providers: {} } }) as YAMLMap
    seq.items.push(entry)
  }
  const map = childMap(childMap(entry, 'config'), 'providers')

  const existing = (map.toJSON() || {}) as Record<string, unknown>
  let touched = false
  for (const k of ownedKeys(existing)) if (!(k in entries)) { map.delete(k); touched = true }
  for (const [k, v] of Object.entries(entries)) {
    if (!sameJson(existing[k], v)) { map.set(k, doc.createNode(v)); touched = true }
  }
  if (!touched) return { text: original, changed: false }
  const out = doc.toString({ lineWidth: 0 })
  return { text: out, changed: out !== original }
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

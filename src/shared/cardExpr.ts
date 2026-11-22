// The expression language of engine cards: a small, side-effect free subset of
// the usual operators and a fixed list of functions. A card is data, so there
// is no eval and no way to reach anything outside the context it is given.
// Evaluation never throws: a missing value is null, and null spreads through
// arithmetic and fails every ordering comparison.

import type { CardContext } from './cardContext'

export const EXPR_MAX_LENGTH = 500
export const EXPR_MAX_NODES = 200
const MAX_DEPTH = 32

export const EXPR_ROOTS = ['args', 'system', 'model', 'overrides', 'template'] as const
export const EXPR_FUNCTIONS = [
  'min', 'max', 'round', 'floor', 'ceil', 'abs', 'clamp', 'len', 'has', 'isSet', 'arg',
  'contains', 'startsWith', 'endsWith', 'lower', 'upper', 'coalesce'
] as const

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'id'; name: string }
  | { t: 'member'; obj: Ast; name: string }
  | { t: 'index'; obj: Ast; idx: Ast }
  | { t: 'call'; name: string; args: Ast[] }
  | { t: 'unary'; op: '!' | '-'; arg: Ast }
  | { t: 'bin'; op: string; l: Ast; r: Ast }
  | { t: 'cond'; test: Ast; a: Ast; b: Ast }

export type ParseResult = { ast: Ast } | { error: string; at: number }

interface Token { k: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; n?: number; at: number }

const TWO_CHAR_OPS = ['<=', '>=', '==', '!=', '&&', '||']
const ONE_CHAR_OPS = '+-*/%<>!?:()[].,'

function tokenize(src: string): Token[] | { error: string; at: number } {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i))!
      out.push({ k: 'num', v: m[0], n: Number(m[0]), at: i })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let text = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]
          text += e === 'n' ? '\n' : e === 't' ? '\t' : e
          j += 2
        } else text += src[j++]
      }
      if (j >= src.length) return { error: 'unterminated string', at: i }
      out.push({ k: 'str', v: text, at: i })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!
      out.push({ k: 'id', v: m[0], at: i })
      i += m[0].length
      continue
    }
    const two = src.slice(i, i + 2)
    if (TWO_CHAR_OPS.includes(two)) { out.push({ k: 'op', v: two, at: i }); i += 2; continue }
    if (ONE_CHAR_OPS.includes(c)) { out.push({ k: 'op', v: c, at: i }); i++; continue }
    return { error: `unexpected character "${c}"`, at: i }
  }
  out.push({ k: 'end', v: '', at: src.length })
  return out
}

// Binding power of each binary operator; the ternary binds loosest.
const BP: Record<string, number> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 }
const UNARY_BP = 7

class ParseError extends Error {
  constructor(message: string, public at: number) { super(message) }
}

class Parser {
  private pos = 0
  private nodes = 0
  constructor(private toks: Token[]) {}

  private peek(): Token { return this.toks[this.pos] }
  private next(): Token { return this.toks[this.pos++] }
  private isOp(v: string): boolean { const t = this.peek(); return t.k === 'op' && t.v === v }
  private node<T extends Ast>(n: T): T {
    if (++this.nodes > EXPR_MAX_NODES) throw new ParseError(`more than ${EXPR_MAX_NODES} parts; split it into rules`, this.peek().at)
    return n
  }
  private expectOp(v: string): void {
    if (!this.isOp(v)) throw new ParseError(`expected "${v}"`, this.peek().at)
    this.pos++
  }

  parseAll(): Ast {
    const ast = this.parseTernary(0)
    if (this.peek().k !== 'end') throw new ParseError(`unexpected "${this.peek().v}"`, this.peek().at)
    return ast
  }

  private parseTernary(depth: number): Ast {
    const test = this.parseBinary(0, depth)
    if (!this.isOp('?')) return test
    this.pos++
    const a = this.parseTernary(depth + 1)
    this.expectOp(':')
    const b = this.parseTernary(depth + 1)
    return this.node({ t: 'cond', test, a, b })
  }

  private parseBinary(minBp: number, depth: number): Ast {
    if (depth > MAX_DEPTH) throw new ParseError('nested too deeply', this.peek().at)
    let left = this.parseUnary(depth)
    for (;;) {
      const t = this.peek()
      const bp = t.k === 'op' ? BP[t.v] : undefined
      if (bp === undefined || bp <= minBp) return left
      this.pos++
      const right = this.parseBinary(bp, depth + 1)
      left = this.node({ t: 'bin', op: t.v, l: left, r: right })
    }
  }

  private parseUnary(depth: number): Ast {
    if (depth > MAX_DEPTH) throw new ParseError('nested too deeply', this.peek().at)
    const t = this.peek()
    if (t.k === 'op' && (t.v === '!' || t.v === '-')) {
      this.pos++
      return this.node({ t: 'unary', op: t.v, arg: this.parseBinary(UNARY_BP - 1, depth + 1) })
    }
    return this.parsePostfix(depth)
  }

  private parsePostfix(depth: number): Ast {
    let e = this.parsePrimary(depth)
    for (;;) {
      if (this.isOp('.')) {
        this.pos++
        const name = this.next()
        if (name.k !== 'id') throw new ParseError('expected a field name after "."', name.at)
        e = this.node({ t: 'member', obj: e, name: name.v })
      } else if (this.isOp('[')) {
        this.pos++
        const idx = this.parseTernary(depth + 1)
        this.expectOp(']')
        e = this.node({ t: 'index', obj: e, idx })
      } else return e
    }
  }

  private parsePrimary(depth: number): Ast {
    const t = this.next()
    if (t.k === 'num') return this.node({ t: 'num', v: t.n as number })
    if (t.k === 'str') return this.node({ t: 'str', v: t.v })
    if (t.k === 'op' && t.v === '(') {
      const e = this.parseTernary(depth + 1)
      this.expectOp(')')
      return e
    }
    if (t.k === 'id') {
      if (t.v === 'true' || t.v === 'false') return this.node({ t: 'bool', v: t.v === 'true' })
      if (t.v === 'null') return this.node({ t: 'null' })
      if (this.isOp('(')) {
        if (!(EXPR_FUNCTIONS as readonly string[]).includes(t.v)) throw new ParseError(`unknown function "${t.v}" (use ${EXPR_FUNCTIONS.join(', ')})`, t.at)
        this.pos++
        const args: Ast[] = []
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.parseTernary(depth + 1))
            if (this.isOp(',')) { this.pos++; continue }
            break
          }
        }
        this.expectOp(')')
        return this.node({ t: 'call', name: t.v, args })
      }
      if (!(EXPR_ROOTS as readonly string[]).includes(t.v)) throw new ParseError(`unknown name "${t.v}" (use ${EXPR_ROOTS.join(', ')})`, t.at)
      return this.node({ t: 'id', name: t.v })
    }
    throw new ParseError(t.k === 'end' ? 'the expression ends too early' : `unexpected "${t.v}"`, t.at)
  }
}

export function parseExpr(src: string): ParseResult {
  if (typeof src !== 'string' || src.trim() === '') return { error: 'the expression is empty', at: 0 }
  if (src.length > EXPR_MAX_LENGTH) return { error: `longer than ${EXPR_MAX_LENGTH} characters`, at: EXPR_MAX_LENGTH }
  const toks = tokenize(src)
  if (!Array.isArray(toks)) return toks
  try {
    return { ast: new Parser(toks).parseAll() }
  } catch (err) {
    if (err instanceof ParseError) return { error: err.message, at: err.at }
    return { error: 'cannot be parsed', at: 0 }
  }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function member(obj: unknown, key: unknown): unknown {
  if (obj === null || obj === undefined) return null
  if (Array.isArray(obj)) {
    const i = typeof key === 'number' ? key : typeof key === 'string' && /^-?\d+$/.test(key) ? Number(key) : NaN
    return Number.isInteger(i) && i >= 0 && i < obj.length ? obj[i] ?? null : null
  }
  if (typeof obj === 'object') {
    const k = typeof key === 'number' ? String(key) : key
    if (typeof k !== 'string' || BLOCKED_KEYS.has(k) || !Object.prototype.hasOwnProperty.call(obj, k)) return null
    return (obj as Record<string, unknown>)[k] ?? null
  }
  return null
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== ''

function isSetValue(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return false
  return !(Array.isArray(v) && v.length === 0)
}

function nums(args: unknown[]): number[] | null {
  const out: number[] = []
  for (const a of args) { if (!isNum(a)) return null; out.push(a) }
  return out.length > 0 ? out : null
}

function callFn(name: string, a: unknown[], ctx: CardContext): unknown {
  switch (name) {
    case 'min': { const n = nums(a); return n ? Math.min(...n) : null }
    case 'max': { const n = nums(a); return n ? Math.max(...n) : null }
    case 'round': {
      if (!isNum(a[0])) return null
      const d = isNum(a[1]) ? Math.min(Math.max(Math.trunc(a[1]), 0), 10) : 0
      const f = 10 ** d
      return Math.round(a[0] * f) / f
    }
    case 'floor': return isNum(a[0]) ? Math.floor(a[0]) : null
    case 'ceil': return isNum(a[0]) ? Math.ceil(a[0]) : null
    case 'abs': return isNum(a[0]) ? Math.abs(a[0]) : null
    case 'clamp': return isNum(a[0]) && isNum(a[1]) && isNum(a[2]) ? Math.min(Math.max(a[0], a[1]), a[2]) : null
    case 'len': {
      const v = a[0]
      if (typeof v === 'string' || Array.isArray(v)) return v.length
      return v && typeof v === 'object' ? Object.keys(v).length : null
    }
    case 'has': return typeof a[1] === 'string' && a[0] !== null && typeof a[0] === 'object' && !Array.isArray(a[0]) ? Object.prototype.hasOwnProperty.call(a[0], a[1]) && !BLOCKED_KEYS.has(a[1]) : false
    case 'isSet': return typeof a[0] === 'string' ? isSetValue(member(ctx.args, a[0])) : false
    case 'arg': return typeof a[0] === 'string' ? member(ctx.args, a[0]) : null
    case 'contains':
      if (typeof a[0] === 'string' && typeof a[1] === 'string') return a[0].includes(a[1])
      return Array.isArray(a[0]) ? a[0].some(x => x === a[1]) : false
    case 'startsWith': return typeof a[0] === 'string' && typeof a[1] === 'string' ? a[0].startsWith(a[1]) : false
    case 'endsWith': return typeof a[0] === 'string' && typeof a[1] === 'string' ? a[0].endsWith(a[1]) : false
    case 'lower': return typeof a[0] === 'string' ? a[0].toLowerCase() : null
    case 'upper': return typeof a[0] === 'string' ? a[0].toUpperCase() : null
    case 'coalesce': return a.find(x => x !== null && x !== undefined && x !== '') ?? null
    default: return null
  }
}

function evalNode(n: Ast, ctx: CardContext): unknown {
  switch (n.t) {
    case 'num': case 'str': case 'bool': return n.v
    case 'null': return null
    case 'id': return member(ctx, n.name)
    case 'member': return member(evalNode(n.obj, ctx), n.name)
    case 'index': return member(evalNode(n.obj, ctx), evalNode(n.idx, ctx))
    case 'call': return callFn(n.name, n.args.map(x => evalNode(x, ctx)), ctx)
    case 'unary': {
      const v = evalNode(n.arg, ctx)
      if (n.op === '!') return !truthy(v)
      return isNum(v) ? -v : null
    }
    case 'cond': return truthy(evalNode(n.test, ctx)) ? evalNode(n.a, ctx) : evalNode(n.b, ctx)
    case 'bin': {
      if (n.op === '&&') return truthy(evalNode(n.l, ctx)) && truthy(evalNode(n.r, ctx))
      if (n.op === '||') return truthy(evalNode(n.l, ctx)) || truthy(evalNode(n.r, ctx))
      const l = evalNode(n.l, ctx)
      const r = evalNode(n.r, ctx)
      if (n.op === '==') return l === r
      if (n.op === '!=') return l !== r
      if (n.op === '+' && (typeof l === 'string' || typeof r === 'string')) return l === null || r === null ? null : `${l}${r}`
      if (!isNum(l) || !isNum(r)) {
        // Strings still order against strings.
        if (typeof l === 'string' && typeof r === 'string') {
          if (n.op === '<') return l < r
          if (n.op === '<=') return l <= r
          if (n.op === '>') return l > r
          if (n.op === '>=') return l >= r
        }
        return ['<', '<=', '>', '>='].includes(n.op) ? false : null
      }
      switch (n.op) {
        case '+': return l + r
        case '-': return l - r
        case '*': return l * r
        case '/': return r === 0 ? null : l / r
        case '%': return r === 0 ? null : l % r
        case '<': return l < r
        case '<=': return l <= r
        case '>': return l > r
        case '>=': return l >= r
      }
      return null
    }
  }
}

export function evalExpr(ast: Ast, ctx: CardContext): unknown {
  try { return evalNode(ast, ctx) } catch { return null }
}

// Parses and evaluates in one step; null when the source does not parse.
export function evalSource(src: string, ctx: CardContext): unknown {
  const parsed = parseExpr(src)
  return 'ast' in parsed ? evalExpr(parsed.ast, ctx) : null
}

export function truthyValue(v: unknown): boolean {
  return truthy(v)
}

// ---------------------------------------------------------------------------
// Text with ${expr} parts. A literal dollar sign is written $$.
// ---------------------------------------------------------------------------

export type TemplatePart = string | Ast
export type TemplateResult = { parts: TemplatePart[] } | { error: string; at: number }

export function parseTemplate(text: string): TemplateResult {
  const parts: TemplatePart[] = []
  let lit = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '$') { lit += '$'; i += 2; continue }
    if (text[i] === '$' && text[i + 1] === '{') {
      // The expression ends at the first "}" outside a string.
      let j = i + 2
      let quote = ''
      while (j < text.length) {
        const c = text[j]
        if (quote) { if (c === '\\') j++; else if (c === quote) quote = '' }
        else if (c === '"' || c === "'") quote = c
        else if (c === '}') break
        j++
      }
      if (j >= text.length) return { error: 'a "${" is never closed', at: i }
      const parsed = parseExpr(text.slice(i + 2, j))
      if ('error' in parsed) return { error: parsed.error, at: i + 2 + parsed.at }
      if (lit) { parts.push(lit); lit = '' }
      parts.push(parsed.ast)
      i = j + 1
      continue
    }
    lit += text[i++]
  }
  if (lit) parts.push(lit)
  return { parts }
}

function show(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000)
  if (typeof v === 'object') return ''
  return String(v)
}

export function interpolate(text: string, ctx: CardContext): string {
  const t = parseTemplate(text)
  if ('error' in t) return text
  return t.parts.map(p => (typeof p === 'string' ? p : show(evalExpr(p, ctx)))).join('')
}

// ---------------------------------------------------------------------------
// References, for checking a card when it is loaded.
// ---------------------------------------------------------------------------

export function exprRefs(ast: Ast): { args: string[]; roots: string[] } {
  const args = new Set<string>()
  const roots = new Set<string>()
  const walk = (n: Ast): void => {
    switch (n.t) {
      case 'id': roots.add(n.name); break
      case 'member': walk(n.obj); break
      case 'index':
        if (n.obj.t === 'id' && n.obj.name === 'args' && n.idx.t === 'str') args.add(n.idx.v)
        walk(n.obj); walk(n.idx)
        break
      case 'call':
        if ((n.name === 'arg' || n.name === 'isSet') && n.args[0]?.t === 'str') args.add(n.args[0].v)
        n.args.forEach(walk)
        break
      case 'unary': walk(n.arg); break
      case 'bin': walk(n.l); walk(n.r); break
      case 'cond': walk(n.test); walk(n.a); walk(n.b); break
      default: break
    }
  }
  walk(ast)
  return { args: [...args], roots: [...roots] }
}

export function templateRefs(parts: TemplatePart[]): { args: string[]; roots: string[] } {
  const args = new Set<string>()
  const roots = new Set<string>()
  for (const p of parts) {
    if (typeof p === 'string') continue
    const r = exprRefs(p)
    r.args.forEach(a => args.add(a))
    r.roots.forEach(a => roots.add(a))
  }
  return { args: [...args], roots: [...roots] }
}

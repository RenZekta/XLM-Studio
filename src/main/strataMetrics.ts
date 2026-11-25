// Strata serves its own JSON at /metrics. Its running totals are mapped onto
// the llama.cpp counter names so the rate math in poll() is shared. Strata's
// prompt counter includes tokens served from its conversation cache, which
// llama.cpp's does not, so the cached part is taken out.
export function parseStrataMetrics(text: string): Record<string, number> | null {
  try {
    const t = JSON.parse(text)?.totals
    if (!t || typeof t !== 'object') return null
    const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : 0)
    return {
      'llamacpp:prompt_tokens_total': Math.max(0, num(t.prompt_tokens) - num(t.reused)),
      'llamacpp:prompt_seconds_total': num(t.prompt_ms) / 1000,
      'llamacpp:tokens_predicted_total': num(t.output_tokens),
      'llamacpp:tokens_predicted_seconds_total': num(t.decode_ms) / 1000
    }
  } catch {
    return null
  }
}

// What a request's progress and end look like in Strata's own log, which is
// what Monitoring falls back on when /metrics cannot be read. Lines look like
//   [strata] reading the prompt: 248,944 of 248,949 tokens, 1 s so far
//   [strata] reading the prompt: 242,819 tokens, 32 s so far
//   [strata] done: 1483 tokens in 39 s (44.9 tok/s) (stop, cancel=False), ...
export type StrataLogEvent =
  | { kind: 'prompt'; read: number | null; total: number; elapsed: number }
  | { kind: 'done'; tokens: number; tps: number | null }

const count = (s: string) => parseInt(s.replace(/,/g, ''), 10)

export function parseStrataLogLine(line: string): StrataLogEvent | null {
  const prompt = /^\[strata\] reading the prompt: ([\d,]+)(?: of ([\d,]+))? tokens, (\d+) s so far/.exec(line.trim())
  if (prompt) {
    // "A of B": A is the position reached (a reused prefix counts as read), B the prompt.
    // Without "of" only the prompt's size is known.
    return prompt[2]
      ? { kind: 'prompt', read: count(prompt[1]), total: count(prompt[2]), elapsed: +prompt[3] }
      : { kind: 'prompt', read: null, total: count(prompt[1]), elapsed: +prompt[3] }
  }
  const done = /^\[strata\] done: (\d+) tokens in \d+ s \((?:([\d.]+) tok\/s|no speed)\)/.exec(line.trim())
  return done ? { kind: 'done', tokens: +done[1], tps: done[2] ? parseFloat(done[2]) : null } : null
}

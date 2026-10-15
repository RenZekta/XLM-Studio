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

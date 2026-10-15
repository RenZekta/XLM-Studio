import { StringDecoder } from 'string_decoder'

// Turns raw stdout/stderr chunks into whole lines. Chunks can end mid-line or
// mid-character, so bytes go through a StringDecoder and the incomplete tail
// is held back. A bare '\r' rewrites the current line (download progress);
// only its final state is kept, and a still-open rewrite is surfaced at most
// once per progressIntervalMs so a long download does not flood the log.
export class LineAssembler {
  private decoder = new StringDecoder('utf8')
  private tail = ''
  private lastProgress = ''
  private lastProgressAt = -Infinity

  constructor(private progressIntervalMs = 1000) {}

  push(chunk: Buffer | string, now = Date.now()): string[] {
    this.tail += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const out: string[] = []
    let nl = this.tail.indexOf('\n')
    while (nl !== -1) {
      const line = this.finalState(this.tail.slice(0, nl))
      this.tail = this.tail.slice(nl + 1)
      this.lastProgress = ''
      if (line) out.push(line)
      nl = this.tail.indexOf('\n')
    }
    if (this.tail.includes('\r')) {
      const state = this.finalState(this.tail)
      if (state && state !== this.lastProgress && now - this.lastProgressAt >= this.progressIntervalMs) {
        this.lastProgress = state
        this.lastProgressAt = now
        out.push(state)
      }
    }
    return out
  }

  // Remaining text once the stream has closed.
  end(): string[] {
    const rest = this.finalState(this.tail + this.decoder.end())
    this.tail = ''
    return rest && rest !== this.lastProgress ? [rest] : []
  }

  private finalState(text: string): string {
    const parts = text.split('\r')
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim()) return parts[i].replace(/\s+$/, '')
    return ''
  }
}

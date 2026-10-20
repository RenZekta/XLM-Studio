import type { Template } from '../../../shared/types'

interface BaseUrlOverrideLike {
  enabled: boolean
  port: number
  serveOnLocalNetwork?: boolean
  apiKeyEnabled?: boolean
  apiKey?: string
}

// The server parameters the global Base URL Override forces on a launch, each
// null when it leaves that parameter to the Template. Port wins whenever the
// override is on; host and API key also need their own sub-switch. Mirrors
// the launch code in ipc.ts.
export interface ServerOverrides {
  port: number | null
  host: string | null
  apiKey: string | null
}

export function activeServerOverrides(baseUrlOverride: BaseUrlOverrideLike | null | undefined, ignore: boolean): ServerOverrides {
  if (!baseUrlOverride?.enabled || ignore) return { port: null, host: null, apiKey: null }
  return {
    port: baseUrlOverride.port || 1234,
    host: baseUrlOverride.serveOnLocalNetwork ? '0.0.0.0' : null,
    apiKey: baseUrlOverride.apiKeyEnabled && baseUrlOverride.apiKey ? baseUrlOverride.apiKey : null
  }
}

// The name of another Template saved on the same port, if any.
export function findPortConflict(cards: { template: Pick<Template, 'id' | 'name' | 'serverPort'> }[], port: number, selfId?: string): string | null {
  return cards.find(c => c.template.id !== selfId && c.template.serverPort === port)?.template.name ?? null
}

// The port a Template actually serves on. Mirrors effectiveTemplatePort in
// ipc.ts exactly -- "same port" for the one-Main-Template-per-port
// invariant means the same thing it means when the server actually
// launches, not just the raw serverPort field.
export function effectiveTemplatePort(template: Pick<Template, 'serverPort' | 'args'>, baseUrlOverride?: BaseUrlOverrideLike | null): number {
  const ignore = template.args?.['__ignoreBaseUrlOverride'] === true
  if (!ignore && baseUrlOverride?.enabled) return baseUrlOverride.port || 1234
  return template.serverPort || 8080
}

// First-starred port gets yellow; each subsequently-starred port gets the
// next color, cycling if there are more starred ports than colors.
const STAR_COLORS = ['#f5b400', '#3b82f6', '#22c55e', '#a855f7', '#ec4899', '#f97316', '#06b6d4', '#ef4444']

// Colors every currently-starred port by how long ago it was first starred
// (earliest mainStarredAt among the Main Templates sharing that port), so
// the mapping stays stable as templates come and go.
export function starColorForPort(
  port: number,
  mainTemplates: Pick<Template, 'serverPort' | 'args' | 'mainStarredAt'>[],
  baseUrlOverride?: BaseUrlOverrideLike | null
): string {
  const earliestByPort = new Map<number, number>()
  for (const t of mainTemplates) {
    const p = effectiveTemplatePort(t, baseUrlOverride)
    const at = t.mainStarredAt ?? 0
    const existing = earliestByPort.get(p)
    if (existing === undefined || at < existing) earliestByPort.set(p, at)
  }
  const orderedPorts = [...earliestByPort.entries()].sort((a, b) => a[1] - b[1]).map(([p]) => p)
  const idx = orderedPorts.indexOf(port)
  return STAR_COLORS[(idx === -1 ? 0 : idx) % STAR_COLORS.length]
}

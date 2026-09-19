import type { Template } from '../../../shared/types'

interface BaseUrlOverrideLike {
  enabled: boolean
  port: number
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

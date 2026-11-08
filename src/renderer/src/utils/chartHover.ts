// Pure helpers behind the Monitoring charts' hover windows. Recharts' own
// tooltip picks the same array index in every series, which is meaningless
// when each run has its own x positions, so hover is resolved here instead:
// find the actual point nearest the cursor, then read every other series off
// its drawn line at that x.

export interface HoverPoint<T> { x: number; y: number; data: T }

export interface SeriesSample<T> {
  y: number
  // True when y was interpolated along the drawn line rather than read from
  // a recorded point.
  approx: boolean
  point: HoverPoint<T> | null
}

function tolerance(x: number) {
  return 1e-9 * Math.max(1, Math.abs(x))
}

// Value of a series at x. `points` must be sorted ascending by x. Returns
// null outside the series' own x range: the line is not drawn there, so
// extrapolating would invent data. When several recorded points share x
// (a vertical run in the line), `rank` picks the one with the lowest score.
// With `xLog` the line is straight in log(x), matching a log-scale axis.
export function sampleSeriesAt<T>(
  points: HoverPoint<T>[],
  x: number,
  opts: { xLog?: boolean; rank?: (p: HoverPoint<T>) => number } = {}
): SeriesSample<T> | null {
  const n = points.length
  if (n === 0) return null
  const tol = tolerance(x)
  if (x < points[0].x - tol || x > points[n - 1].x + tol) return null

  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].x < x - tol) lo = mid + 1
    else hi = mid
  }

  if (lo < n && Math.abs(points[lo].x - x) <= tol) {
    let best = points[lo]
    if (opts.rank) {
      let bestScore = opts.rank(best)
      for (let j = lo + 1; j < n && Math.abs(points[j].x - x) <= tol; j++) {
        const score = opts.rank(points[j])
        if (score < bestScore) { best = points[j]; bestScore = score }
      }
    }
    return { y: best.y, approx: false, point: best }
  }

  const a = points[lo - 1]
  const b = points[lo]
  const useLog = !!opts.xLog && a.x > 0 && b.x > 0 && x > 0
  const t = useLog
    ? (Math.log(x) - Math.log(a.x)) / (Math.log(b.x) - Math.log(a.x))
    : (x - a.x) / (b.x - a.x)
  return { y: a.y + t * (b.y - a.y), approx: true, point: null }
}

// The recorded point closest to the cursor in screen space, across all
// series. `project` maps a point to pixels, or null when it has no valid
// position (e.g. zero on a log axis).
export function findNearestPoint<T, S extends { points: HoverPoint<T>[] }>(
  series: S[],
  project: (p: HoverPoint<T>) => { px: number; py: number } | null,
  mx: number,
  my: number
): { seriesIndex: number; point: HoverPoint<T>; px: number; py: number } | null {
  let best: { seriesIndex: number; point: HoverPoint<T>; px: number; py: number } | null = null
  let bestDist = Infinity
  for (let i = 0; i < series.length; i++) {
    for (const point of series[i].points) {
      const pos = project(point)
      if (!pos) continue
      const d = (pos.px - mx) * (pos.px - mx) + (pos.py - my) * (pos.py - my)
      if (d < bestDist) { bestDist = d; best = { seriesIndex: i, point, ...pos } }
    }
  }
  return best
}

// Vertical placement for a column of floating windows. Windows are ordered
// by anchorY (smallest first, so the highest point on screen sits on top),
// each is centred on its anchor where possible, and overlaps are resolved by
// pushing down, then back up if the column runs past `bottom`. Returns the
// top offset of each window in input order. If the column is taller than the
// available span, the top edge wins.
export function stackWindows(
  items: { anchorY: number; height: number }[],
  top: number,
  bottom: number,
  gap: number
): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].anchorY - items[b].anchorY || a - b)
  const tops = new Array<number>(items.length).fill(0)

  let cursor = top
  for (const i of order) {
    const desired = items[i].anchorY - items[i].height / 2
    tops[i] = Math.max(desired, cursor)
    cursor = tops[i] + items[i].height + gap
  }

  let limit = bottom
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k]
    tops[i] = Math.min(tops[i], limit - items[i].height)
    limit = tops[i] - gap
  }

  // The upward pass can push the first window above `top` when the column
  // is taller than the span; re-flow downward from `top` in that case.
  cursor = top
  for (const i of order) {
    tops[i] = Math.max(tops[i], cursor)
    cursor = tops[i] + items[i].height + gap
  }
  return tops
}

// New [lo, hi] after scaling the span by `factor` (< 1 zooms in) while the
// value under `frac` (0 at lo, 1 at hi) stays where it is on screen.
export function zoomRange(lo: number, hi: number, frac: number, factor: number): [number, number] {
  const anchor = lo + frac * (hi - lo)
  const span = (hi - lo) * factor
  return [anchor - frac * span, anchor + (1 - frac) * span]
}

// Limits a zoom factor so the resulting span stays within [minSpan, maxSpan].
export function clampZoomFactor(span: number, factor: number, minSpan: number, maxSpan: number): number {
  if (span <= 0) return 1
  return Math.min(Math.max(factor, minSpan / span), maxSpan / span)
}

// Tick values for a log axis over [lo, hi]. Prefers powers of ten, adds 2/5
// and then 1-9 multiples when the range is too narrow for enough ticks, and
// falls back to evenly spaced values for very narrow ranges.
export function logTicks(lo: number, hi: number, max = 8): number[] {
  if (!(lo > 0) || !(hi > lo)) return []
  const kLo = Math.floor(Math.log10(lo))
  const kHi = Math.ceil(Math.log10(hi))
  const levels = [[1], [1, 2, 5], [1, 2, 3, 4, 5, 6, 7, 8, 9]]
  for (const mults of levels) {
    const out: number[] = []
    for (let k = kLo; k <= kHi; k++) {
      for (const m of mults) {
        const v = m * Math.pow(10, k)
        if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) out.push(v)
      }
    }
    if (out.length >= 3 && out.length <= max) return out
  }
  const ratio = Math.pow(hi / lo, 1 / 3)
  return [lo, lo * ratio, lo * ratio * ratio, hi].map(v => Math.round(v * 100) / 100)
}

// Step sizes in seconds that read naturally on a clock-style time axis.
export const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400]

// Round tick values for a linear axis over [lo, hi], about `target` of them.
// Steps are 1, 2 or 5 times a power of ten unless `steps` is given.
export function niceTicks(lo: number, hi: number, target = 6, steps?: number[]): number[] {
  if (!isFinite(lo) || !isFinite(hi) || !(hi > lo)) return []
  const want = (hi - lo) / Math.max(1, target)
  let step: number
  if (steps) {
    step = steps.find(s => s >= want) ?? steps[steps.length - 1]
  } else {
    const pow = Math.pow(10, Math.floor(Math.log10(want)))
    step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= want) ?? 10 * pow
  }
  const out: number[] = []
  const first = Math.ceil(lo / step - 1e-9)
  for (let k = first; k * step <= hi * (1 + 1e-12) + 1e-12 && out.length < 200; k++) {
    out.push(Number((k * step).toPrecision(12)))
  }
  return out
}

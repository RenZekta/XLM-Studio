import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePlotArea, useXAxisScale, useYAxisScale, useChartWidth, useChartHeight } from 'recharts'
import {
  HoverPoint, SeriesSample, sampleSeriesAt, findNearestPoint, stackWindows
} from '../utils/chartHover'

export interface HoverSeries<T> {
  id: string
  label: string
  color: string
  // Sorted ascending by x.
  points: HoverPoint<T>[]
}

export interface HoverLine { text: string; bold?: boolean; color?: string }

const WINDOW_WIDTH = 220
const LINE_HEIGHT = 16
// 6px padding and a 1px border on both the top and bottom edge.
const WINDOW_CHROME = 14
const WINDOW_GAP = 4
const CURSOR_OFFSET = 14

interface Props<T, S extends HoverSeries<T>> {
  series: S[]
  // Interpolate in log(x) between points; must match the axis scale.
  xLog?: boolean
  // HTML layer stacked over the chart; windows are portalled into it so they
  // are not clipped by the SVG.
  windowRoot: HTMLElement | null
  // Hides the hover while the view is being dragged.
  suppress?: boolean
  describe: (series: S, sample: SeriesSample<T> & { x: number }) => HoverLine[]
}

// Rendered as a child of a recharts chart. Replaces recharts' Tooltip: the
// point nearest the cursor sets the x position, every series is read at that
// x (recorded value where one exists, otherwise interpolated along its line),
// and one window per series is stacked at that x ordered by height.
// Listeners sit on the root svg because the line paths would otherwise
// swallow events that land exactly on them.
export default function ChartHoverLayer<T, S extends HoverSeries<T>>({ series, xLog, windowRoot, suppress, describe }: Props<T, S>) {
  const plot = usePlotArea()
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const chartWidth = useChartWidth()
  const chartHeight = useChartHeight()
  const anchorRef = useRef<SVGGElement>(null)
  const plotRef = useRef(plot)
  plotRef.current = plot
  const [mouse, setMouse] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const svg = anchorRef.current?.ownerSVGElement
    if (!svg) return
    const onMove = (e: MouseEvent) => {
      const r = svg.getBoundingClientRect()
      const x = e.clientX - r.left
      const y = e.clientY - r.top
      const p = plotRef.current
      if (!p || x < p.x || x > p.x + p.width || y < p.y || y > p.y + p.height) setMouse(null)
      else setMouse({ x, y })
    }
    const onLeave = () => setMouse(null)
    svg.addEventListener('mousemove', onMove)
    svg.addEventListener('mouseleave', onLeave)
    return () => {
      svg.removeEventListener('mousemove', onMove)
      svg.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  let content: React.ReactNode = null
  if (mouse && !suppress && plot && xScale && yScale && chartWidth !== undefined && chartHeight !== undefined) {
    const project = (p: HoverPoint<T>) => {
      const px = xScale(p.x)
      const py = yScale(p.y)
      if (typeof px !== 'number' || typeof py !== 'number' || !isFinite(px) || !isFinite(py)) return null
      // Points scrolled out of a zoomed view are clipped, so they can't be hovered.
      const inPlot = px >= plot.x - 1 && px <= plot.x + plot.width + 1 && py >= plot.y - 1 && py <= plot.y + plot.height + 1
      return inPlot ? { px, py } : null
    }
    const nearest = findNearestPoint<T, S>(series, project, mouse.x, mouse.y)
    if (nearest) {
      const x = nearest.point.x
      const rows: { series: S; sample: SeriesSample<T>; py: number; lines: HoverLine[] }[] = []
      series.forEach((s, i) => {
        const sample: SeriesSample<T> | null = i === nearest.seriesIndex
          ? { y: nearest.point.y, approx: false, point: nearest.point }
          : sampleSeriesAt(s.points, x, {
              xLog,
              rank: p => { const pos = project(p); return pos ? Math.abs(pos.py - mouse.y) : Infinity }
            })
        if (!sample) return
        const py = i === nearest.seriesIndex ? nearest.py : yScale(sample.y)
        if (typeof py !== 'number' || !isFinite(py) || py < plot.y - 1 || py > plot.y + plot.height + 1) return
        rows.push({ series: s, sample, py, lines: describe(s, { ...sample, x }) })
      })

      const heights = rows.map(r => WINDOW_CHROME + r.lines.length * LINE_HEIGHT)
      const tops = stackWindows(rows.map((r, i) => ({ anchorY: r.py, height: heights[i] })), 0, chartHeight, WINDOW_GAP)
      const flip = nearest.px + CURSOR_OFFSET + WINDOW_WIDTH > chartWidth
      const left = Math.max(0, flip ? nearest.px - CURSOR_OFFSET - WINDOW_WIDTH : nearest.px + CURSOR_OFFSET)

      content = (
        <>
          <line x1={nearest.px} x2={nearest.px} y1={plot.y} y2={plot.y + plot.height} stroke="var(--text-muted)" strokeDasharray="4 3" strokeOpacity={0.8} />
          <line x1={plot.x} x2={plot.x + plot.width} y1={nearest.py} y2={nearest.py} stroke="var(--text-muted)" strokeDasharray="4 3" strokeOpacity={0.8} />
          {windowRoot && createPortal(
            <>
            {/* Markers live in the HTML layer, not the chart svg: recharts
                draws its own lines and dots above custom svg children, which
                would hide them. Other runs get a white ring and the selected
                point a white dot, each with a dark halo so they stay visible
                on any theme and on top of dense points. */}
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
              {rows.filter(r => r.series !== series[nearest.seriesIndex]).map(r => (
                <g key={r.series.id}>
                  <circle cx={nearest.px} cy={r.py} r={5} fill="none" stroke="rgba(0,0,0,0.55)" strokeWidth={4.5} />
                  <circle cx={nearest.px} cy={r.py} r={5} fill="none" stroke="#fff" strokeWidth={2} />
                </g>
              ))}
              <circle cx={nearest.px} cy={nearest.py} r={5} fill="#fff" stroke="rgba(0,0,0,0.55)" strokeWidth={1.5} />
            </svg>
            {rows.map((r, i) => (
              <div
                key={r.series.id}
                style={{
                  position: 'absolute', left, top: tops[i], width: WINDOW_WIDTH, height: heights[i],
                  boxSizing: 'border-box', padding: '6px 10px', fontSize: 12, lineHeight: `${LINE_HEIGHT}px`,
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderLeft: `3px solid ${r.series.color}`, borderRadius: 6, boxShadow: 'var(--shadow-md)'
                }}
              >
                {r.lines.map((l, j) => (
                  <div key={j} style={{ fontWeight: l.bold ? 600 : undefined, color: l.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {l.text}
                  </div>
                ))}
              </div>
            ))}
            </>,
            windowRoot
          )}
        </>
      )
    }
  }

  return <g ref={anchorRef} pointerEvents="none">{content}</g>
}

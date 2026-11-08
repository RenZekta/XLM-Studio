import React, { useEffect, useRef } from 'react'
import { usePlotArea, useXAxisInverseScale, useYAxisInverseScale } from 'recharts'
import { zoomRange, clampZoomFactor } from '../utils/chartHover'

// Visible data range of both axes. The chart passes it back to its axes as
// explicit domains; null means automatic.
export interface ChartView { x: [number, number]; y: [number, number] }

interface Props {
  view: ChartView | null
  // Zoom X in log space so it matches a log-scale axis.
  xLog?: boolean
  onView: (view: ChartView | null) => void
  onDragging: (dragging: boolean) => void
}

// Wheel zooms both axes around the cursor, Ctrl+wheel stretches only the X
// axis, dragging pans, double-click resets. Rendered as a child of a recharts
// chart so it can read the plot area and axis scales; listeners sit on the
// root svg so they also catch events that land on the line paths.
export default function ChartViewControl({ view, xLog, onView, onDragging }: Props) {
  const plot = usePlotArea()
  const xInv = useXAxisInverseScale()
  const yInv = useYAxisInverseScale()
  const anchorRef = useRef<SVGGElement>(null)
  const live = useRef({ plot, xInv, yInv, xLog, onView, onDragging })
  live.current = { plot, xInv, yInv, xLog, onView, onDragging }
  // Range before the first zoom, used to keep zooming within sane bounds.
  const home = useRef<ChartView | null>(null)
  const zoomed = useRef(false)

  // A reset from outside (the Reset button) starts a fresh zoom session.
  useEffect(() => {
    if (!view) { zoomed.current = false; home.current = null }
  }, [view])

  useEffect(() => {
    const svg = anchorRef.current?.ownerSVGElement
    if (!svg) return
    let stopDrag: (() => void) | null = null
    svg.style.cursor = 'grab'

    const readView = (): ChartView | null => {
      const { plot: p, xInv: xi, yInv: yi } = live.current
      if (!p || !xi || !yi) return null
      const x0 = Number(xi(p.x)), x1 = Number(xi(p.x + p.width))
      const y1 = Number(yi(p.y)), y0 = Number(yi(p.y + p.height))
      return [x0, x1, y0, y1].every(isFinite) && x1 > x0 && y1 > y0 ? { x: [x0, x1], y: [y0, y1] } : null
    }
    const tx = (v: number) => (live.current.xLog ? Math.log(v) : v)
    const ix = (v: number) => (live.current.xLog ? Math.exp(v) : v)
    const inside = (e: MouseEvent) => {
      const p = live.current.plot
      if (!p) return null
      const r = svg.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      return mx >= p.x && mx <= p.x + p.width && my >= p.y && my <= p.y + p.height ? { mx, my, p } : null
    }

    const onWheel = (e: WheelEvent) => {
      const hit = inside(e)
      const view = readView()
      if (!hit || !view) return
      e.preventDefault()
      if (!zoomed.current) { home.current = view; zoomed.current = true }
      const h = home.current ?? view
      const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0015)

      const xs = [tx(view.x[0]), tx(view.x[1])]
      const hxSpan = Math.abs(tx(h.x[1]) - tx(h.x[0]))
      const xMin = live.current.xLog ? 0.1 : hxSpan * 0.005
      const fx = clampZoomFactor(xs[1] - xs[0], factor, xMin, hxSpan * 20)
      const nx = zoomRange(xs[0], xs[1], (hit.mx - hit.p.x) / hit.p.width, fx)

      let ny: [number, number] = view.y
      if (!e.ctrlKey) {
        const hySpan = h.y[1] - h.y[0]
        const fy = clampZoomFactor(view.y[1] - view.y[0], factor, hySpan * 0.005, hySpan * 20)
        ny = zoomRange(view.y[0], view.y[1], 1 - (hit.my - hit.p.y) / hit.p.height, fy)
      }
      live.current.onView({ x: [ix(nx[0]), ix(nx[1])], y: ny })
    }

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return
      const hit = inside(e)
      const view = readView()
      if (!hit || !view) return
      // Keeps the browser from starting a text selection or focusing the svg.
      e.preventDefault()
      const sx = (tx(view.x[1]) - tx(view.x[0])) / hit.p.width
      const sy = (view.y[1] - view.y[0]) / hit.p.height
      const x0 = tx(view.x[0]), x1 = tx(view.x[1])
      const startX = e.clientX, startY = e.clientY
      live.current.onDragging(true)
      svg.style.cursor = 'grabbing'
      const move = (ev: MouseEvent) => {
        if (!zoomed.current) { home.current = view; zoomed.current = true }
        const dx = (ev.clientX - startX) * sx
        const dy = (ev.clientY - startY) * sy
        live.current.onView({ x: [ix(x0 - dx), ix(x1 - dx)], y: [view.y[0] + dy, view.y[1] + dy] })
      }
      const up = () => stopDrag?.()
      stopDrag = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        svg.style.cursor = 'grab'
        live.current.onDragging(false)
        stopDrag = null
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }

    const onDouble = (e: MouseEvent) => {
      if (!inside(e)) return
      zoomed.current = false
      home.current = null
      live.current.onView(null)
    }

    svg.addEventListener('wheel', onWheel, { passive: false })
    svg.addEventListener('mousedown', onDown)
    svg.addEventListener('dblclick', onDouble)
    return () => {
      svg.removeEventListener('wheel', onWheel)
      svg.removeEventListener('mousedown', onDown)
      svg.removeEventListener('dblclick', onDouble)
      stopDrag?.()
      svg.style.cursor = ''
    }
  }, [])

  return <g ref={anchorRef} />
}

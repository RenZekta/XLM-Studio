import React, { useMemo } from 'react'
import { RotateCcw } from 'lucide-react'
import { formatWithSpaces, parseSpacedNumber, snapToNearestPowerOfTwo, indexOnLadder } from '../utils/contextFormat'

interface Props {
  value: any
  min: number
  max: number
  step?: number
  onChange: (value: any) => void
  placeholder?: string
  defaultVal?: any
  allowAuto?: boolean       // when true, empty input = "auto" (no flag passed)
  recommended?: number      // recommended value to badge
  recommendedLabel?: string
  disabled?: boolean
  // When true, the text field displays/accepts space-grouped numbers
  // ("2 097 152") instead of a plain <input type="number">.
  useSpacedFormat?: boolean
  // When true, the slider snaps to the fixed 2x ladder (2k, 4k, 8k, ...
  // up to 2 097 152) instead of moving continuously by `step`. `ladderSteps`
  // lets a caller supply a different ladder; defaults to the standard context one.
  use2xIncrements?: boolean
  ladderSteps?: number[]
}

// A hybrid control: range slider + adjacent numeric text input.
// - Moving the slider updates the text, and vice-versa.
// - When allowAuto is true, clearing the text (or typing "auto") removes the
//   value entirely so the backend falls back to its native auto-detect.
// - When the value is empty/auto, the slider renders at the recommended (or
//   default) position in a dimmed "ghost" state so the user sees where it
//   would land if engaged.
export default function HybridSlider({
  value, min, max, step = 1, onChange, placeholder, defaultVal,
  allowAuto = false, recommended, recommendedLabel, disabled,
  useSpacedFormat = false, use2xIncrements = false, ladderSteps
}: Props) {
  const isAuto = allowAuto && (value === undefined || value === null || value === '' || value === 'auto')
  const numericVal = useMemo(() => {
    if (isAuto) return recommended ?? defaultVal ?? min
    const n = typeof value === 'string' ? parseFloat(value) : value
    return isNaN(n) ? min : n
  }, [value, isAuto, recommended, defaultVal, min])

  const clampedSlider = Math.min(max, Math.max(min, numericVal))
  const steps = useMemo(() => (ladderSteps || []).filter(s => s >= min && s <= max), [ladderSteps, min, max])

  function handleSlider(v: number) {
    onChange(v)
  }
  function handleLadderSlider(idx: number) {
    if (steps.length === 0) return
    onChange(steps[Math.max(0, Math.min(steps.length - 1, idx))])
  }
  function handleText(v: string) {
    if (allowAuto && (v.trim() === '' || v.trim().toLowerCase() === 'auto')) {
      onChange('')  // triggers deletion in the parent handleUpdate
      return
    }
    const n = useSpacedFormat ? parseSpacedNumber(v) : parseFloat(v)
    if (!isNaN(n) && v.trim() !== '') {
      onChange(use2xIncrements && steps.length > 0 ? snapToNearestPowerOfTwo(n, steps) : n)
    } else if (v === '') onChange('')
  }

  return (
    <div className="hybrid-slider" style={{ opacity: disabled ? 0.55 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {use2xIncrements && steps.length > 0 ? (
        <input
          type="range"
          className="hybrid-range"
          min={0}
          max={steps.length - 1}
          step={1}
          value={indexOnLadder(clampedSlider, steps)}
          onChange={e => handleLadderSlider(parseInt(e.target.value, 10))}
          disabled={disabled}
          style={isAuto ? { opacity: 0.45 } : {}}
        />
      ) : (
        <input
          type="range"
          className="hybrid-range"
          min={min}
          max={max}
          step={step}
          value={clampedSlider}
          onChange={e => handleSlider(parseFloat(e.target.value))}
          disabled={disabled}
          style={isAuto ? { opacity: 0.45 } : {}}
        />
      )}
      {useSpacedFormat ? (
        <input
          type="text"
          inputMode="numeric"
          className="hybrid-text"
          value={isAuto || value === undefined || value === null || value === '' || isNaN(Number(value)) ? '' : formatWithSpaces(Number(value))}
          placeholder={placeholder || (allowAuto ? 'auto' : undefined)}
          onChange={e => handleText(e.target.value)}
          disabled={disabled}
        />
      ) : (
        <input
          type="number"
          className="hybrid-text"
          min={min}
          max={max}
          step={step}
          value={isAuto ? '' : value}
          placeholder={placeholder || (allowAuto ? 'auto' : undefined)}
          onChange={e => handleText(e.target.value)}
          disabled={disabled}
        />
      )}
      {recommended !== undefined && (
        <button
          type="button"
          className="hybrid-recommended-btn"
          onClick={() => onChange(recommended)}
          disabled={disabled}
          title={`${recommendedLabel || 'Recommended'}: ${recommended}`}
        >
          <RotateCcw size={11} /> {recommendedLabel || 'Rec'}: {recommended}
        </button>
      )}
    </div>
  )
}

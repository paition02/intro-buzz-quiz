import { useEffect, useRef } from 'react'

function CircularValueSlider({
  value,
  min,
  max,
  step,
  label,
  unit,
  formatValue,
  onChange,
  onCommit,
}: {
  value: number
  min: number
  max: number
  step: number
  label: string
  unit: string
  formatValue: (value: number) => string
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}) {
  const radius = 78
  const center = 96
  const activePointerIdRef = useRef<number | null>(null)
  const interactionRectRef = useRef<DOMRectReadOnly | null>(null)
  const latestValueRef = useRef(value)
  const circumference = 2 * Math.PI * radius
  const progress = (value - min) / (max - min)
  const dashOffset = circumference * (1 - progress)
  const angle = progress * 360 - 90
  const knobX = center + radius * Math.cos((angle * Math.PI) / 180)
  const knobY = center + radius * Math.sin((angle * Math.PI) / 180)

  useEffect(() => {
    latestValueRef.current = value
  }, [value])

  const updateFromPoint = (clientX: number, clientY: number, rect: DOMRectReadOnly) => {
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    let degrees = (Math.atan2(y, x) * 180) / Math.PI + 90
    if (degrees < 0) degrees += 360
    const raw = min + (degrees / 360) * (max - min)
    const stepped = Math.round(raw / step) * step
    const precision = step < 1 ? 1 : 0
    const nextValue = Number(Math.min(max, Math.max(min, stepped)).toFixed(precision))
    latestValueRef.current = nextValue
    onChange(nextValue)
    return nextValue
  }

  return (
    <div className="grid place-items-center w-60 max-w-full mx-auto">
      <svg
        className="group w-56 max-w-full touch-none outline-none overflow-visible"
        viewBox="0 0 192 192"
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={(event) => {
          activePointerIdRef.current = event.pointerId
          interactionRectRef.current = event.currentTarget.getBoundingClientRect()
          event.currentTarget.setPointerCapture(event.pointerId)
          updateFromPoint(event.clientX, event.clientY, interactionRectRef.current)
        }}
        onPointerMove={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          updateFromPoint(event.clientX, event.clientY, interactionRectRef.current ?? event.currentTarget.getBoundingClientRect())
        }}
        onPointerUp={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          const nextValue = updateFromPoint(event.clientX, event.clientY, interactionRectRef.current ?? event.currentTarget.getBoundingClientRect())
          activePointerIdRef.current = null
          interactionRectRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          onCommit?.(nextValue)
        }}
        onPointerCancel={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          activePointerIdRef.current = null
          interactionRectRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          onCommit?.(latestValueRef.current)
        }}
        onKeyDown={(event) => {
          let nextValue: number | null = null
          const precision = step < 1 ? 1 : 0
          const currentValue = latestValueRef.current
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextValue = Number(Math.min(max, currentValue + step).toFixed(precision))
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextValue = Number(Math.max(min, currentValue - step).toFixed(precision))
          if (nextValue == null) return
          event.preventDefault()
          latestValueRef.current = nextValue
          onChange(nextValue)
          onCommit?.(nextValue)
        }}
      >
        <circle className="fill-none stroke-white/15" strokeWidth={18} cx={center} cy={center} r={radius} />
        <circle
          className="fill-none stroke-amber"
          strokeWidth={18}
          strokeLinecap="round"
          transform="rotate(-90 96 96)"
          cx={center}
          cy={center}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        <circle className="fill-pink stroke-cream group-focus-visible:stroke-white" strokeWidth={4} cx={knobX} cy={knobY} r="15" />
        <text className="fill-cream text-3xl font-black pointer-events-none" dominantBaseline="middle" x={center} y={center - 4} textAnchor="middle">{formatValue(value)}</text>
        <text className="fill-subtle text-sm font-bold pointer-events-none" dominantBaseline="middle" x={center} y={center + 22} textAnchor="middle">{unit}</text>
      </svg>
    </div>
  )
}

export function CircularSecondsSlider({
  value,
  onChange,
  onCommit,
}: {
  value: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}) {
  return (
    <CircularValueSlider
      value={value}
      min={0.1}
      max={30}
      step={0.1}
      label="再生秒数"
      unit="秒"
      formatValue={(nextValue) => nextValue.toFixed(1)}
      onChange={onChange}
      onCommit={onCommit}
    />
  )
}

export function CircularPercentSlider({
  value,
  label,
  onChange,
  onCommit,
}: {
  value: number
  label: string
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}) {
  return (
    <CircularValueSlider
      value={value}
      min={1}
      max={100}
      step={1}
      label={label}
      unit="%"
      formatValue={(nextValue) => String(Math.round(nextValue))}
      onChange={onChange}
      onCommit={onCommit}
    />
  )
}

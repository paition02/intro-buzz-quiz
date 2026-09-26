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
  const trackWidth = 18
  const knobRadius = 15
  const hitOuter = radius + knobRadius
  const hitInner = radius - knobRadius
  const gapDegrees = 20
  const sweepDegrees = 360 - gapDegrees * 2
  const ringPathRef = useRef<SVGPathElement>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const interactionRectRef = useRef<DOMRectReadOnly | null>(null)
  const latestValueRef = useRef(value)
  const progress = (value - min) / (max - min)
  const angle = gapDegrees + progress * sweepDegrees - 90
  const knobX = center + radius * Math.cos((angle * Math.PI) / 180)
  const knobY = center + radius * Math.sin((angle * Math.PI) / 180)

  useEffect(() => {
    latestValueRef.current = value
  }, [value])

  // ring 上で始まった touch だけ page scroll を止める (React の onTouchStart は passive なので直接登録)
  useEffect(() => {
    const ringPath = ringPathRef.current
    if (!ringPath) return
    const preventScroll = (event: TouchEvent) => event.preventDefault()
    ringPath.addEventListener('touchstart', preventScroll, { passive: false })
    return () => ringPath.removeEventListener('touchstart', preventScroll)
  }, [])

  const ringHitPath = [
    `M ${center - hitOuter} ${center}`,
    `a ${hitOuter} ${hitOuter} 0 1 0 ${hitOuter * 2} 0`,
    `a ${hitOuter} ${hitOuter} 0 1 0 ${-hitOuter * 2} 0`,
    `M ${center - hitInner} ${center}`,
    `a ${hitInner} ${hitInner} 0 1 0 ${hitInner * 2} 0`,
    `a ${hitInner} ${hitInner} 0 1 0 ${-hitInner * 2} 0`,
  ].join(' ')

  const pointAt = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180
    return `${center + radius * Math.cos(radians)} ${center + radius * Math.sin(radians)}`
  }
  const trackPath = `M ${pointAt(gapDegrees)} A ${radius} ${radius} 0 1 1 ${pointAt(360 - gapDegrees)}`

  const updateFromPoint = (clientX: number, clientY: number, rect: DOMRectReadOnly) => {
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    let degrees = (Math.atan2(y, x) * 180) / Math.PI + 90
    if (degrees < 0) degrees += 360
    const inGap = degrees < gapDegrees || degrees > 360 - gapDegrees
    const nearerEnd = latestValueRef.current - min < max - latestValueRef.current ? min : max
    const raw = inGap ? nearerEnd : min + ((degrees - gapDegrees) / sweepDegrees) * (max - min)
    const stepped = Math.round(raw / step) * step
    const precision = step < 1 ? 1 : 0
    const nextValue = Number(Math.min(max, Math.max(min, stepped)).toFixed(precision))
    latestValueRef.current = nextValue
    onChange(nextValue)
    return nextValue
  }

  return (
    <div className="grid place-items-center w-60 max-w-full mx-auto">
      <svg className="w-56 max-w-full overflow-visible pointer-events-none" viewBox="0 0 192 192">
        <path
          ref={ringPathRef}
          className="peer pointer-events-auto fill-transparent outline-none"
          fillRule="evenodd"
          d={ringHitPath}
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
        />
        <path className="fill-none stroke-white/15" strokeWidth={trackWidth} strokeLinecap="round" d={trackPath} />
        <path
          className="fill-none stroke-amber"
          strokeWidth={trackWidth}
          strokeLinecap="round"
          d={trackPath}
          pathLength={1}
          strokeDasharray={`${progress} 2`}
        />
        <circle className="fill-pink stroke-cream peer-focus-visible:stroke-white" strokeWidth={4} cx={knobX} cy={knobY} r={knobRadius} />
        <text className="fill-cream text-3xl font-black" dominantBaseline="middle" x={center} y={center - 4} textAnchor="middle">{formatValue(value)}</text>
        <text className="fill-subtle text-sm font-bold" dominantBaseline="middle" x={center} y={center + 22} textAnchor="middle">{unit}</text>
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

import { useRef, useState } from 'react'
import { CircularPercentSlider } from './CircularSecondsSlider'

export function JacketHintSlider({ value, onChange, onError }: {
  value: number
  onChange: (value: number) => Promise<void>
  onError: (error: unknown) => void
}) {
  const [pendingValue, setPendingValue] = useState<number | null>(null)
  const revision = useRef(0)

  const change = (nextValue: number) => {
    const requestRevision = ++revision.current
    setPendingValue(nextValue)
    void onChange(nextValue).catch(onError).finally(() => {
      // Earlier acknowledgements must not discard a newer local input.
      // The server broadcasts state before acknowledging the action.
      if (revision.current === requestRevision) setPendingValue(null)
    })
  }

  return (
    <CircularPercentSlider
      value={pendingValue ?? value}
      label="ヒントレベル"
      onChange={change}
    />
  )
}

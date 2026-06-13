import { useRef, useState, type CSSProperties } from 'react'
import { loadSessionString, playerColor, saveSessionString } from '../lib/util'
import { useScreenWakeLock } from '../useScreenWakeLock'

type ActionVisualState = 'idle' | 'pressed' | 'muted' | 'error'

function getActionActorId() {
  const storageKey = 'intro-buzz-action-actor-id'
  const stored = loadSessionString(storageKey)
  if (stored) return stored
  const id = crypto.randomUUID()
  saveSessionString(storageKey, id)
  return id
}

export function ActionPage() {
  useScreenWakeLock()

  const [actorId] = useState(getActionActorId)
  const [busy, setBusy] = useState(false)
  const [visualState, setVisualState] = useState<ActionVisualState>('idle')
  const audioContextRef = useRef<AudioContext | null>(null)
  const color = playerColor(actorId)

  const resetSoon = () => {
    window.setTimeout(() => {
      setVisualState('idle')
    }, 760)
  }

  const playActionButtonSound = async () => {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return
    audioContextRef.current ??= new AudioContextCtor()
    const audioContext = audioContextRef.current
    if (audioContext.state === 'suspended') await audioContext.resume()

    const now = audioContext.currentTime
    const master = audioContext.createGain()
    master.gain.setValueAtTime(0.58, now)
    master.connect(audioContext.destination)

    const playTone = ({
      frequency,
      offset,
      duration,
      level,
      type = 'sine',
      attack = 0.008,
      hold = 0.04,
      sustain = 0.42,
    }: {
      frequency: number
      offset: number
      duration: number
      level: number
      type?: OscillatorType
      attack?: number
      hold?: number
      sustain?: number
    }) => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      const start = now + offset
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, start)
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.exponentialRampToValueAtTime(level, start + attack)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), start + attack + hold)
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.03)
    }

    playTone({ frequency: 802.1, offset: 0, duration: 1.42, level: 0.32, attack: 0.01, hold: 0.2, sustain: 0.56 })
    playTone({ frequency: 4226, offset: 0, duration: 0.32, level: 0.18, attack: 0.006, hold: 0.04, sustain: 0.18 })
    playTone({ frequency: 2153, offset: 0.004, duration: 0.34, level: 0.06, attack: 0.008, hold: 0.06, sustain: 0.22 })

    playTone({ frequency: 636.6, offset: 0.125, duration: 1.46, level: 0.3, attack: 0.045, hold: 0.18, sustain: 0.62 })
    playTone({ frequency: 1273.2, offset: 0.12, duration: 0.42, level: 0.055, attack: 0.025, hold: 0.04, sustain: 0.2 })
    playTone({ frequency: 3354, offset: 0.118, duration: 0.34, level: 0.06, attack: 0.018, hold: 0.035, sustain: 0.18 })
    playTone({ frequency: 5645, offset: 0.13, duration: 0.24, level: 0.02, attack: 0.025, hold: 0.025, sustain: 0.14 })
    window.setTimeout(() => {
      try {
        master.disconnect()
      } catch {
        // The audio graph may already be released by the browser.
      }
    }, 1700)
  }

  const act = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/act/' + encodeURIComponent(actorId), { method: 'POST' })
      if (res.status === 200) {
        await playActionButtonSound()
        setVisualState('pressed')
        resetSoon()
      } else if (res.status === 204) {
        setVisualState('muted')
        resetSoon()
      } else if (res.status === 409) {
        setVisualState('muted')
        resetSoon()
      } else if (res.status === 429) {
        setVisualState('muted')
        resetSoon()
      } else {
        setVisualState('error')
      }
    } catch {
      setVisualState('error')
    } finally {
      window.setTimeout(() => setBusy(false), 180)
    }
  }

  const circleFx = visualState === 'pressed' ? 'animate-action-pop' : visualState === 'muted' ? 'opacity-60' : ''

  return (
    <main
      className="min-h-dvh overflow-hidden grid"
      style={{
        '--player-color-soft': color.softBackground,
        '--player-color-glow': `hsl(${color.hue} 76% 52% / 0.46)`,
      } as CSSProperties}
    >
      <button
        className="grid place-items-center text-inherit cursor-pointer transition touch-manipulation disabled:cursor-wait disabled:opacity-100"
        style={{ backgroundColor: visualState === 'pressed' ? color.softBackground : 'transparent' }}
        type="button"
        disabled={busy}
        onClick={act}
        aria-label="早押しボタン"
      >
        <span
          className={`block size-72 rounded-full ${circleFx}`}
          style={{
            backgroundColor: visualState === 'error' ? '#ff8aa3' : color.background,
            boxShadow: '0 24px 80px var(--player-color-glow), inset 0 0 0 12px rgba(255,255,255,0.22)',
          }}
          aria-hidden="true"
        />
      </button>
    </main>
  )
}

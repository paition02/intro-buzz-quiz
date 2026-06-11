export function playResultSound(kind: 'correct' | 'wrong') {
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const audioContext = new AudioContextCtor()
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
  const start = audioContext.currentTime
  const master = audioContext.createGain()
  master.gain.setValueAtTime(0.7, start)
  master.connect(audioContext.destination)

  const playTone = (frequency: number, offset: number, duration: number, type: OscillatorType = 'sine', level = 0.9, attack = 0.01, sustain = 0.18) => {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const toneStart = start + offset
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, toneStart)
    gain.gain.setValueAtTime(0.001, toneStart)
    gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), toneStart + Math.min(duration * 0.7, attack + 0.08))
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(toneStart)
    oscillator.stop(toneStart + duration + 0.03)
  }

  if (kind === 'correct') {
    const playDing = (offset: number, level: number) => {
      playTone(889.6, offset, 1.22, 'sine', level, 0.006, 0.28)
      playTone(4761, offset, 0.22, 'sine', level * 0.14, 0.004, 0.16)
      playTone(7911, offset + 0.004, 0.12, 'sine', level * 0.018, 0.003, 0.08)
    }

    const playDong = (offset: number, level: number) => {
      playTone(705.9, offset, 1.36, 'sine', level, 0.01, 0.34)
      playTone(3779, offset, 0.26, 'sine', level * 0.11, 0.005, 0.14)
      playTone(6279, offset + 0.004, 0.2, 'sine', level * 0.09, 0.004, 0.12)
    }

    playDing(0, 0.72)
    playDong(0.115, 0.34)
    playDing(0.235, 0.66)
    playDong(0.355, 0.36)
  } else {
    const playBuzzTone = (frequency: number, offset: number, duration: number, level: number, type: OscillatorType = 'sawtooth') => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      const toneStart = start + offset
      const attack = 0.012
      const release = 0.045
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, toneStart)
      gain.gain.setValueAtTime(0.001, toneStart)
      gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
      gain.gain.setValueAtTime(level, toneStart + Math.max(attack, duration - release))
      gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(toneStart)
      oscillator.stop(toneStart + duration + 0.03)
    }

    const playBuzz = (offset: number, duration: number, level: number) => {
      playBuzzTone(100.1, offset, duration, level * 0.62)
      playBuzzTone(199.9, offset, duration, level * 0.44)
      playBuzzTone(300.1, offset, duration, level * 0.68, 'square')
      playBuzzTone(400.4, offset, duration, level * 0.58, 'square')
      playBuzzTone(999.9, offset, duration, level * 0.34, 'sawtooth')
      playBuzzTone(1200.5, offset, duration, level * 0.2, 'sawtooth')
      playBuzzTone(7402, offset + 0.004, Math.max(0.05, duration - 0.02), level * 0.045, 'sine')
    }

    playBuzz(0.1, 0.14, 0.42)
    playBuzz(0.31, 0.58, 0.48)
  }

  window.setTimeout(() => void audioContext.close(), 2200)
}

export function playResultsSound() {
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const audioContext = new AudioContextCtor()
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
  const start = audioContext.currentTime
  const master = audioContext.createGain()
  master.gain.setValueAtTime(0.72, start)
  master.connect(audioContext.destination)

  const playTone = (
    frequency: number,
    offset: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
    attack = 0.024,
    sustain = 0.5,
  ) => {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const toneStart = start + offset
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, toneStart)
    gain.gain.setValueAtTime(0.001, toneStart)
    gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), toneStart + Math.min(duration * 0.64, attack + 0.18))
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(toneStart)
    oscillator.stop(toneStart + duration + 0.03)
  }

  const playSheen = () => {
    const createBuffer = (audioContext as { createBuffer?: AudioContext['createBuffer'] }).createBuffer?.bind(audioContext)
    const createBufferSource = (audioContext as { createBufferSource?: AudioContext['createBufferSource'] }).createBufferSource?.bind(audioContext)
    const createBiquadFilter = (audioContext as { createBiquadFilter?: AudioContext['createBiquadFilter'] }).createBiquadFilter?.bind(audioContext)
    if (!createBuffer || !createBufferSource || !createBiquadFilter) return

    const duration = 1.08
    const sampleRate = audioContext.sampleRate || 44100
    const buffer = createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate)
    const data = buffer.getChannelData(0)
    let seed = 0x6d2b79f5
    for (let index = 0; index < data.length; index += 1) {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507)
      seed = Math.imul(seed ^ (seed >>> 13), 3266489909)
      data[index] = (((seed >>> 0) / 4294967295) * 2 - 1) * Math.exp(-index / (sampleRate * 0.34))
    }

    const source = createBufferSource()
    const highpass = createBiquadFilter()
    const lowpass = createBiquadFilter()
    const gain = audioContext.createGain()
    source.buffer = buffer
    highpass.type = 'highpass'
    highpass.frequency.setValueAtTime(3800, start)
    lowpass.type = 'lowpass'
    lowpass.frequency.setValueAtTime(11800, start)
    gain.gain.setValueAtTime(0.001, start)
    gain.gain.exponentialRampToValueAtTime(0.085, start + 0.018)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    source.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(gain)
    gain.connect(master)
    source.start(start)
    source.stop(start + duration + 0.03)
  }

  playSheen()
  playTone(1964.2, 0, 0.62, 0.035, 'sine', 0.008, 0.16)
  playTone(2618.3, 0.004, 0.78, 0.052, 'sine', 0.008, 0.18)
  playTone(2919.8, 0.01, 0.66, 0.04, 'sine', 0.007, 0.16)
  playTone(3620.3, 0.016, 0.62, 0.038, 'sine', 0.007, 0.14)
  playTone(4069.1, 0.024, 0.54, 0.032, 'sine', 0.006, 0.12)
  playTone(4520, 0.035, 0.5, 0.026, 'sine', 0.006, 0.11)
  playTone(5517.9, 0.048, 0.48, 0.03, 'sine', 0.005, 0.1)
  playTone(6102, 0.07, 0.42, 0.02, 'sine', 0.005, 0.09)
  playTone(6815.3, 0.09, 0.34, 0.016, 'sine', 0.004, 0.08)

  window.setTimeout(() => void audioContext.close(), 2400)
}

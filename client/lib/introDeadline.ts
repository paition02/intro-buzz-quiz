// Measure media time, not time spent waiting for the network. The timeout only
// predicts the next check; the media clock decides whether the intro is over.
export function watchIntroDeadline(mk: MusicKit.MusicKitInstance, seconds: number, finish: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const cleanup = () => {
    disposed = true
    clearTimeout(timer)
    mk.removeEventListener('playbackTimeDidChange', check)
    mk.removeEventListener('playbackStateDidChange', check)
    mk.removeEventListener('playbackDurationDidChange', check)
  }
  const check = () => {
    if (disposed) return
    clearTimeout(timer)
    const duration = mk.currentPlaybackDuration
    const limit = Number.isFinite(duration) && duration > 0 ? Math.min(seconds, duration) : seconds
    const remaining = limit - mk.currentPlaybackTime
    const ended = mk.playbackState === 5 || mk.playbackState === 10
    if (remaining <= 0.000001 || ended) {
      cleanup()
      finish()
    } else {
      timer = setTimeout(check, mk.isPlaying ? Math.max(1, Math.min(remaining * 1000, 100)) : 100)
    }
  }
  mk.addEventListener('playbackTimeDidChange', check)
  mk.addEventListener('playbackStateDidChange', check)
  mk.addEventListener('playbackDurationDidChange', check)
  check()
  return cleanup
}

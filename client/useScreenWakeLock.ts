import { useEffect } from 'react'

export function useScreenWakeLock(enabled = true) {
  useEffect(() => {
    if (!enabled || !('wakeLock' in navigator)) return

    let active = true
    let requesting = false
    let wakeLock: WakeLockSentinel | null = null

    const releaseWakeLock = () => {
      const currentWakeLock = wakeLock
      wakeLock = null
      if (currentWakeLock && !currentWakeLock.released) {
        void currentWakeLock.release().catch(() => {
          // The browser may already have released the wake lock.
        })
      }
    }

    const requestWakeLock = async () => {
      if (!active || requesting || wakeLock !== null || document.visibilityState !== 'visible') return

      requesting = true
      try {
        const nextWakeLock = await navigator.wakeLock.request('screen')

        if (!active || document.visibilityState !== 'visible') {
          void nextWakeLock.release().catch(() => {
            // The browser may already have released the wake lock.
          })
          return
        }

        wakeLock = nextWakeLock
        nextWakeLock.addEventListener('release', () => {
          if (wakeLock === nextWakeLock) wakeLock = null
        }, { once: true })
      } catch (error) {
        console.info('Screen wake lock unavailable', error)
      } finally {
        requesting = false
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void requestWakeLock()
      else releaseWakeLock()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void requestWakeLock()

    return () => {
      active = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      releaseWakeLock()
    }
  }, [enabled])
}

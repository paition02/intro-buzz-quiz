// このファイルに対する変更にはユーザーの明示的な承認が必要です。

import { useCallback, useState, useSyncExternalStore } from 'react'
import { musicKitInstanceStore, musicKitAuthStore } from './musicKitStore'

export function useMusicKitInstance() {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  return useSyncExternalStore(musicKitInstanceStore.subscribe, musicKitInstanceStore.getSnapshot)
}

export function useMusicKitAuth() {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  const { instance: mk } = useMusicKitInstance()
  const authorized = useSyncExternalStore(musicKitAuthStore.subscribe, musicKitAuthStore.getSnapshot)

  const [error, setError] = useState<Error | null>(null)

  const authorize = useCallback(async () => {
    if (mk === null) {
      setError(new Error('MusicKit is not initialized'))
      return
    }

    try {
      await mk.authorize()
      setError(null)
    } catch (e) {
      const error = e instanceof Error ? e : new Error('Authorization failed')
      setError(error)
    }
  }, [mk])

  const unauthorize = useCallback(async () => {
    if (mk === null) {
      setError(new Error('MusicKit is not initialized'))
      return
    }

    try {
      await mk.unauthorize()
      setError(null)
    } catch (e) {
      const error = e instanceof Error ? e : new Error('Unauthorization failed')
      setError(error)
    }
  }, [mk])

  return {
    authorized,
    error,
    authorize,
    unauthorize,
  }
}

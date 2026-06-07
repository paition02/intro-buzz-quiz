// このファイルに対する変更にはユーザーの明示的な承認が必要です。

import { MUSIC_KIT_APP } from "./musicKitApp"

async function fetchToken(): Promise<{ token: string; expiresAt: Date }> {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  const res = await fetch('/api/token', { cache: 'no-store' })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? `Token request failed: ${res.status}`)
  return { token: data.token, expiresAt: new Date(data.expiresAt) }
}

function ensureMusicKit() {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  if (window.MusicKit) return
  return new Promise((resolve) => {
    document.addEventListener('musickitloaded', resolve, { once: true })
  })
}

let snapshot: {
  readonly instance: MusicKit.MusicKitInstance | null
  readonly error: Error | null
} = {
  instance: null,
  error: null,
} as const
const instanceListeners = new Set<() => void>()
let authListeners = new Set<() => void>()

async function initializeMusicKit() {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  try {
    const [_, { token }] =  await Promise.all([ensureMusicKit(), fetchToken()])
    const instance = await MusicKit.configure({
      developerToken: token,
      app: MUSIC_KIT_APP,
    })
    snapshot = {
      instance,
      error: null,
    } as const
  } catch (e) {
    const error = e instanceof Error ? e : new Error('MusicKit initialization failed')
    snapshot = {
      instance: null,
      error,
    } as const
    return
  }

  instanceListeners.forEach(listener => listener())
  authListeners.forEach(listener => listener())

  snapshot.instance?.addEventListener('authorizationStatusDidChange', () => {
    authListeners.forEach(listener => listener())
  })
}

initializeMusicKit()

export const musicKitInstanceStore = {
  subscribe(listener: () => void) {
    instanceListeners.add(listener)
    return () => instanceListeners.delete(listener)
  },
  getSnapshot(): { instance: MusicKit.MusicKitInstance | null, error: Error | null } {
    return snapshot
  }
}

export const musicKitAuthStore = {
  subscribe(listener: () => void) {
    authListeners.add(listener)
    return () => authListeners.delete(listener)
  },
  getSnapshot() {
    const { instance } = musicKitInstanceStore.getSnapshot()
    if (!instance) return false
    return instance.isAuthorized
  }
}

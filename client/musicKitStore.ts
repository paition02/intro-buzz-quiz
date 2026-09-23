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
const authListeners = new Set<() => void>()

async function initializeMusicKit() {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  try {
    const [, { token }] =  await Promise.all([ensureMusicKit(), fetchToken()])
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
  }

  instanceListeners.forEach(listener => listener())
  authListeners.forEach(listener => listener())

  snapshot.instance?.addEventListener('authorizationStatusDidChange', () => {
    authListeners.forEach(listener => listener())
  })
}

initializeMusicKit()

let muteDepth = 0
let finishMute: (() => void) | null = null

// SDK volume events also fire when its internal player changes. They cannot
// distinguish an explicit user write of 0 from our own temporary silence.
// Preserve public writes separately while holding the actual player at zero.
function beginTemporaryMute(instance: MusicKit.MusicKitInstance) {
  const own = Object.getOwnPropertyDescriptor(instance, 'volume')
  let descriptor = own
  for (let prototype = Object.getPrototypeOf(instance); !descriptor && prototype; prototype = Object.getPrototypeOf(prototype)) {
    descriptor = Object.getOwnPropertyDescriptor(prototype, 'volume')
  }
  let value = instance.volume
  let requested = value
  const read = descriptor?.get ? () => descriptor!.get!.call(instance) as number : () => value
  const write = descriptor?.set ? (next: number) => descriptor!.set!.call(instance, next) : (next: number) => { value = next }
  Object.defineProperty(instance, 'volume', {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get: read,
    set(next: number) {
      if (!Number.isFinite(next) || next < 0 || next > 1) throw new RangeError('音量は0から1の範囲で指定してください')
      requested = next
      write(0)
    },
  })
  const restoreProperty = () => {
    if (own) Object.defineProperty(instance, 'volume', own)
    else Reflect.deleteProperty(instance, 'volume')
  }
  try {
    write(0)
  } catch (error) {
    restoreProperty()
    throw error
  }
  return () => {
    restoreProperty()
    instance.volume = requested
  }
}

export const musicKitInstanceStore = {
  subscribe(listener: () => void) {
    instanceListeners.add(listener)
    return () => instanceListeners.delete(listener)
  },
  getSnapshot(): { instance: MusicKit.MusicKitInstance | null, error: Error | null } {
    return snapshot
  },
  async muteTemporarily(fn: () => Promise<void>) {
    const { instance } = snapshot
    if (instance === null) return

    if (muteDepth === 0) finishMute = beginTemporaryMute(instance)
    muteDepth++
    try {
      await fn()
    } finally {
      if (--muteDepth === 0) {
        const finish = finishMute
        finishMute = null
        finish?.()
      }
    }
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

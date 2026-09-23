import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMusicKitInstance } from './useMusicKit'
import { musicKitInstanceStore } from './musicKitStore'
import type { GameState } from '../type/game'
import { roundAlbumFromState, roundTrackIdFromState } from './lib/gameClient'

// 再生は「命令の列」ではなく「望ましい状態」として宣言する。reconciler は常に最新の target だけを
// MusicKit に適用し、適用中に target が差し替わったら残りの手順を捨てる。古い状態変化の命令が
// 後から実行されて次のラウンドの準備を壊す (二重 prepare、前の曲が鳴る) 事故を構造で防ぐ。
export type PlaybackTarget =
  | { kind: 'stopped' }
  // songId を頭出し済みで待機。nextSongId は MusicKit の queue に積んで先読みさせる
  | { kind: 'prepared'; songId: string; nextSongId: string | null }
  // songId を頭から再生 (イントロ)
  | { kind: 'playing'; songId: string; nextSongId: string | null }
  // songId をフル再生でループ (正解発表)
  | { kind: 'looping'; songId: string; nextSongId: string | null }
  // trackId の属するアルバム全体をリピート再生 (ジャケットの正解発表)
  | { kind: 'album'; trackId: string }

export type PlaybackStatus = {
  // 最後に宣言した target
  readonly target: PlaybackTarget | null
  // 最後に適用が完了し、その後差し替えられていない target
  readonly settled: PlaybackTarget | null
  readonly error: Error | null
}

export function playbackTargetsEqual(a: PlaybackTarget | null, b: PlaybackTarget | null) {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'stopped': return true
    case 'album': return b.kind === 'album' && a.trackId === b.trackId
    default: return b.kind !== 'stopped' && b.kind !== 'album' && a.songId === b.songId && a.nextSongId === b.nextSongId
  }
}

// ゲーム状態から望ましい再生状態を導く。`playing` ステップは再生ボタンが明示的に宣言するので
// ここでは触らない (null = 宣言しない)。reload 直後に勝手にイントロが流れ続けるのを避ける。
export function playbackTargetFromState(state: GameState): PlaybackTarget | null {
  if (state.phase !== 'game') return { kind: 'stopped' }
  if (state.quizMode === 'jacket') {
    if (state.step !== 'reveal') return { kind: 'stopped' }
    const album = roundAlbumFromState(state)
    const track = album && state.tracks.find((item) => album.trackIds.includes(item.id))
    return track ? { kind: 'album', trackId: track.id } : { kind: 'stopped' }
  }
  const songId = roundTrackIdFromState(state)
  if (songId == null || state.step === 'results' || state.step === 'idle') return { kind: 'stopped' }
  if (state.step === 'playing') return null
  return introTarget(state, state.step === 'reveal' ? 'looping' : 'prepared')
}

export function introTarget(state: GameState, kind: 'prepared' | 'playing' | 'looping'): PlaybackTarget | null {
  const songId = roundTrackIdFromState(state)
  if (state.phase !== 'game' || state.quizMode !== 'intro' || songId == null) return null
  return { kind, songId, nextSongId: state.shuffledTrackIds[state.roundIndex + 1] ?? null }
}

class SupersededError extends Error {
  constructor() {
    super('再生状態が更新されました')
    this.name = 'SupersededError'
  }
}

export function isPlaybackSuperseded(error: unknown) {
  return error instanceof SupersededError
}

// A late SDK operation cannot be cancelled inside MusicKit. Its completion must
// instead be reconciled by the current owner, including across React remounts.
const owners = new WeakMap<MusicKit.MusicKitInstance, PlaybackController>()
const lastPlaybackCallAt = new WeakMap<MusicKit.MusicKitInstance, { play: number; pause: number }>()
const PLAYBACK_DEBOUNCE_MS = 250
const STOP_FALLBACK_MS = 100
const MEDIA_OPERATION_TIMEOUT_MS = 3000

type Operation = { abort: AbortController }

class PlaybackController {
  snapshot: PlaybackStatus = { target: null, settled: null, error: null }
  listeners = new Set<() => void>()
  operation: Operation | null = null
  pending: Promise<void> | null = null
  attached = false
  repairing = false

  readonly mk: MusicKit.MusicKitInstance | null
  constructor(mk: MusicKit.MusicKitInstance | null) { this.mk = mk }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getSnapshot = () => this.snapshot
  publish(next: Partial<PlaybackStatus>) {
    this.snapshot = { ...this.snapshot, ...next }
    this.listeners.forEach(listener => listener())
  }
  attach = () => {
    this.attached = true
    if (this.mk) this.mk.addEventListener('playbackStateDidChange', this.onMediaChange)
    return () => {
      this.operation?.abort.abort()
      if (this.mk) {
        this.mk.removeEventListener('playbackStateDidChange', this.onMediaChange)
        if (owners.get(this.mk) === this) {
          // Keep a silent owner for completions delivered after unmount.
          this.setTarget({ kind: 'stopped' }).catch(() => {})
        }
      }
      this.attached = false
    }
  }
  onMediaChange = () => {
    // Preparation itself may briefly play muted to acquire the asset. Once
    // settled, however, buffer recovery must never restart a stopped intro.
    const settled = this.snapshot.settled
    if ((settled?.kind === 'stopped' || settled?.kind === 'prepared') && this.mk && owners.get(this.mk) === this) this.repair()
  }
  repair = () => {
    if (!this.mk || owners.get(this.mk) !== this || this.repairing) return
    const target = this.snapshot.target
    if (!target) return
    const silent = target.kind === 'stopped' || target.kind === 'prepared'
    const wrongSong = target.kind !== 'stopped' && target.kind !== 'album' && this.mk.nowPlayingItem?.id !== target.songId
    if (silent ? !this.mk.isPlaying && !wrongSong : this.mk.isPlaying && !wrongSong) return
    this.repairing = true
    void this.setTarget(target, true).catch(() => {}).finally(() => { this.repairing = false })
  }
  setTarget = (target: PlaybackTarget, force = false): Promise<void> => {
    if (!this.attached && !(force && target.kind === 'stopped')) return Promise.reject(new SupersededError())
    if (!force && playbackTargetsEqual(this.snapshot.target, target)) {
      if (this.snapshot.settled && !this.snapshot.error) return Promise.resolve()
      if (this.pending && !this.operation?.abort.signal.aborted) return this.pending
    }
    this.operation?.abort.abort()
    if (this.mk) {
      const previous = owners.get(this.mk)
      if (previous !== this) previous?.operation?.abort.abort()
      owners.set(this.mk, this)
    }
    const operation: Operation = { abort: new AbortController() }
    this.operation = operation
    this.publish({ target, settled: null, error: null })
    const promise = this.apply(target, operation, force).then(() => {
      this.check(operation)
      this.publish({ settled: target })
    }).catch((error: unknown) => {
      if (operation.abort.signal.aborted) throw new SupersededError()
      const problem = error instanceof Error ? error : new Error(String(error), { cause: error })
      this.publish({ target: { kind: 'stopped' }, error: problem, settled: null })
      operation.abort.abort()
      throw problem
    }).finally(() => {
      if (this.operation === operation) this.pending = null
    })
    this.pending = promise
    return promise
  }
  check(operation: Operation) {
    if (operation.abort.signal.aborted) throw new SupersededError()
    if (!this.mk) throw new Error('MusicKit is not initialized')
  }
  wait<T>(promise: Promise<T>, operation: Operation): Promise<T> {
    this.check(operation)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        operation.abort.signal.removeEventListener('abort', cancel)
        this.mk?.removeEventListener('mediaPlaybackError', failed)
      }
      const cancel = () => { cleanup(); reject(new SupersededError()) }
      const failed = (event: MusicKit.Events['mediaPlaybackError']) => { cleanup(); reject(event.error) }
      operation.abort.signal.addEventListener('abort', cancel, { once: true })
      this.mk?.addEventListener('mediaPlaybackError', failed)
      promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
    })
  }
  async call<T>(fn: () => Promise<T>, operation: Operation) {
    this.check(operation)
    const promise = fn()
    // Observe both success and rejection: a rejected call can still have applied
    // a side effect. Never report an obsolete error in the new operation.
    void promise.then(() => this.lateCompletion(operation), () => this.lateCompletion(operation))
    return this.wait(promise, operation)
  }
  lateCompletion(operation: Operation) {
    if (!operation.abort.signal.aborted || !this.mk) return
    const owner = owners.get(this.mk)
    if (owner?.pending) void owner.pending.then(owner.repair, owner.repair)
    else owner?.repair()
  }
  async playback(method: 'play' | 'pause', operation: Operation, waitForCompletion = false) {
    this.check(operation)
    const mk = this.mk!
    const times = lastPlaybackCallAt.get(mk) ?? { play: -Infinity, pause: -Infinity }
    lastPlaybackCallAt.set(mk, times)
    // Recheck after waiting; a newer owner may have called the same method.
    while (times[method] + PLAYBACK_DEBOUNCE_MS > performance.now()) {
      await this.wait(new Promise<void>(resolve => setTimeout(resolve, times[method] + PLAYBACK_DEBOUNCE_MS - performance.now())), operation)
    }
    this.check(operation)
    times[method] = performance.now()
    const wanted = method === 'play'
    let completion: Promise<void> | undefined
    await this.wait(new Promise<void>((resolve, reject) => {
      let done = false
      const cleanup = () => {
        clearTimeout(timeout)
        clearTimeout(stopFallback)
        mk.removeEventListener('playbackStateDidChange', changed)
        operation.abort.signal.removeEventListener('abort', cancelled)
      }
      const finish = (error?: unknown) => {
        if (done) return
        done = true
        cleanup()
        if (error) reject(error)
        else resolve()
      }
      const changed = () => { if (mk.isPlaying === wanted) finish() }
      const cancelled = () => finish(new SupersededError())
      let timeout: ReturnType<typeof setTimeout> | undefined
      const stopFallback = !wanted ? setTimeout(() => {
        if (mk.isPlaying && typeof mk.stop === 'function') {
          void mk.stop().then(changed, error => finish(error))
        }
      }, STOP_FALLBACK_MS) : undefined
      mk.addEventListener('playbackStateDidChange', changed)
      operation.abort.signal.addEventListener('abort', cancelled, { once: true })
      const promise = mk[method]()
      completion = promise
      void promise.then(() => {
        this.lateCompletion(operation)
        changed()
        if (!done) timeout = setTimeout(() => finish(new Error(wanted ? '再生を開始できません' : '再生を停止できません')), MEDIA_OPERATION_TIMEOUT_MS)
      }, error => {
        this.lateCompletion(operation)
        if (!done && !wanted && mk.isPlaying && typeof mk.stop === 'function') {
          void mk.stop().then(() => finish(error), () => finish(error))
        } else if (!done) finish(error)
      })
    }), operation)
    if (waitForCompletion && completion) await this.wait(completion, operation)
  }
  async apply(target: PlaybackTarget, operation: Operation, repair: boolean) {
    this.check(operation)
    const mk = this.mk!
    if (target.kind === 'stopped') {
      if (mk.isPlaying) await musicKitInstanceStore.muteTemporarily(() => this.playback('pause', operation))
      return
    }
    if (target.kind === 'album') {
      if (repair && mk.nowPlayingItem) {
        await this.playback('play', operation)
        return
      }
      const album = await this.call(() => albumIdOfTrack(mk, target.trackId), operation)
      await this.call(() => mk.setQueue({ album, repeatMode: MusicKit.PlayerRepeatMode.all, shuffleMode: MusicKit.PlayerShuffleMode.off, startPlaying: false }), operation)
      await this.playback('play', operation)
      return
    }
    if (mk.nowPlayingItem?.id !== target.songId) {
      await musicKitInstanceStore.muteTemporarily(async () => {
        if (mk.queue.items[mk.nowPlayingItemIndex + 1]?.id === target.songId) {
          mk.repeatMode = MusicKit.PlayerRepeatMode.none
          await this.call(() => mk.skipToNextItem(), operation)
        } else {
          await this.call(() => mk.setQueue({ song: target.songId, repeatMode: MusicKit.PlayerRepeatMode.one, shuffleMode: MusicKit.PlayerShuffleMode.off, startPlaying: false, startTime: 0 }), operation)
          await this.playback('play', operation, true)
        }
        await this.playback('pause', operation, true)
      })
      this.check(operation)
      if (mk.nowPlayingItem?.id !== target.songId) throw new Error('曲を読み込めません')
    }
    if (mk.isPlaying) await musicKitInstanceStore.muteTemporarily(() => this.playback('pause', operation, true))
    if ((!repair || target.kind === 'prepared') && mk.currentPlaybackTime > 0) await this.call(() => mk.seekToTime(0), operation)
    this.check(operation)
    // An intro owns a single-item queue: reaching its end must neither loop
    // nor advance to a preloaded answer. Reveals retain their repeat behavior.
    if (target.kind === 'playing' && mk.queue.items.length > 1) {
      await this.call(() => mk.setQueue({ song: target.songId, repeatMode: MusicKit.PlayerRepeatMode.none, shuffleMode: MusicKit.PlayerShuffleMode.off, startPlaying: false, startTime: 0 }), operation)
    }
    mk.repeatMode = target.kind === 'playing' ? MusicKit.PlayerRepeatMode.none : MusicKit.PlayerRepeatMode.one
    if (target.kind !== 'prepared') await this.playback('play', operation)
    this.check(operation)
    // Preloading is optional, and must never hold the current track's deadline.
    if (target.kind !== 'playing' && target.nextSongId && mk.queue.items[mk.nowPlayingItemIndex + 1]?.id !== target.nextSongId && typeof mk.playNext === 'function') {
      void mk.playNext({ song: target.nextSongId }).catch(() => {})
    }
  }
}

export function usePlaybackTarget(): { status: PlaybackStatus; setTarget(target: PlaybackTarget): Promise<void> } {
  const { instance } = useMusicKitInstance()
  const controller = useMemo(() => new PlaybackController(instance), [instance])
  useEffect(() => controller.attach(), [controller])
  const status = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  return { status, setTarget: controller.setTarget }
}

async function albumIdOfTrack(mk: MusicKit.MusicKitInstance, trackId: string) {
  if (trackId.startsWith('i.')) {
    const libraryResponse = await mk.api.music<{
      data?: Array<{ id: string }>
    }>(`/v1/me/library/songs/${encodeURIComponent(trackId)}/albums`)
    const libraryAlbumId = libraryResponse.data.data?.[0]?.id
    if (!libraryAlbumId) throw new Error('ライブラリのアルバムIDを取得できません')
    return libraryAlbumId
  }
  const response = await mk.api.music<{
    data?: Array<{ relationships?: { albums?: { data?: Array<{ id: string }> } } }>
  }>(`/v1/catalog/${mk.storefrontId}/songs/${encodeURIComponent(trackId)}`, { include: 'albums' })
  const catalogAlbumId = response.data.data?.[0]?.relationships?.albums?.data?.[0]?.id
  if (!catalogAlbumId) throw new Error('Apple MusicのアルバムIDを取得できません')
  return catalogAlbumId
}

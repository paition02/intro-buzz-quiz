import { useCallback, useRef, useSyncExternalStore } from 'react'
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

type Waiter = { resolve: () => void; reject: (error: Error) => void }

function waitFor(waiters: Map<number, Waiter>, version: number) {
  return new Promise<void>((resolve, reject) => {
    const previous = waiters.get(version)
    waiters.set(version, previous ? {
      resolve: () => { previous.resolve(); resolve() },
      reject: (error) => { previous.reject(error); reject(error) },
    } : { resolve, reject })
  })
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

export function usePlaybackTarget(): { status: PlaybackStatus; setTarget(target: PlaybackTarget): Promise<void> } {
  const { instance: mk } = useMusicKitInstance()
  const statusRef = useRef<PlaybackStatus>({ target: null, settled: null, error: null })
  const listenersRef = useRef(new Set<() => void>())
  const versionRef = useRef(0)
  const runningRef = useRef(false)
  const waitersRef = useRef(new Map<number, Waiter>())

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current.add(listener)
    return () => { listenersRef.current.delete(listener) }
  }, [])
  const status = useSyncExternalStore(subscribe, () => statusRef.current)

  const publish = useCallback((next: Partial<PlaybackStatus>) => {
    statusRef.current = { ...statusRef.current, ...next }
    listenersRef.current.forEach((listener) => listener())
  }, [])

  const settle = useCallback((version: number, error: Error | null) => {
    const waiter = waitersRef.current.get(version)
    waitersRef.current.delete(version)
    if (error === null) waiter?.resolve()
    else waiter?.reject(error)
  }, [])

  const run = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      while (true) {
        const version = versionRef.current
        const target = statusRef.current.target
        const superseded = () => versionRef.current !== version
        try {
          if (target === null) throw new Error('再生状態がありません')
          if (mk === null) throw new Error('MusicKit is not initialized')
          await applyTarget(mk, target, superseded)
          if (superseded()) throw new SupersededError()
          publish({ settled: target, error: null })
          settle(version, null)
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e))
          if (!(error instanceof SupersededError)) publish({ settled: null, error })
          settle(version, error)
        }
        if (!superseded()) return
      }
    } finally {
      runningRef.current = false
    }
  }, [mk, publish, settle])

  const setTarget = useCallback((target: PlaybackTarget) => {
    const current = statusRef.current
    if (playbackTargetsEqual(current.target, target)) {
      if (playbackTargetsEqual(current.settled, target)) return Promise.resolve()
      // 適用中なら完了を待つ。失敗済みなら下で新しい version として再適用する
      if (runningRef.current) return waitFor(waitersRef.current, versionRef.current)
    }
    const version = ++versionRef.current
    publish({ target, settled: null })
    const promise = waitFor(waitersRef.current, version)
    void run()
    return promise
  }, [publish, run])

  return { status, setTarget }
}

// MusicKit の instance.play() / pause() は 250ms の leading-edge debounce で、直前の呼び出しから
// 250ms 以内の呼び出しは無視される (resolve はする)。同じ method は 250ms 空けて呼ぶ。
const PLAYBACK_DEBOUNCE_MS = 250
const lastPlaybackCallAt = new WeakMap<MusicKit.MusicKitInstance, { play: number; pause: number }>()

async function paced(mk: MusicKit.MusicKitInstance, method: 'play' | 'pause', superseded: () => boolean = () => false) {
  const at = lastPlaybackCallAt.get(mk) ?? { play: -Infinity, pause: -Infinity }
  lastPlaybackCallAt.set(mk, at)
  const wait = at[method] + PLAYBACK_DEBOUNCE_MS - performance.now()
  if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
  if (superseded()) return
  at[method] = performance.now()
  await mk[method]()
}

async function applyTarget(mk: MusicKit.MusicKitInstance, target: PlaybackTarget, superseded: () => boolean) {
  switch (target.kind) {
    case 'stopped':
      if (mk.isPlaying) await paced(mk, 'pause')
      return
    case 'album':
      await playAlbumOfTrack(mk, target.trackId, superseded)
      return
    default:
      await loadSong(mk, target.songId)
      if (superseded()) return
      await rewind(mk)
      if (superseded()) return
      // 曲末で queue の次の曲 (次ラウンドの答え) へ進まないよう、再生中は常に 1 曲リピート
      mk.repeatMode = MusicKit.PlayerRepeatMode.one
      if (target.kind !== 'prepared') await paced(mk, 'play', superseded)
      if (superseded()) return
      await preloadNext(mk, target.nextSongId)
  }
}

// songId を nowPlayingItem にする。queue の次にあれば skip (先読み済みなら network なしで即時)、
// なければ queue を作り直して無音で再生 → 停止し asset を取得させる。
async function loadSong(mk: MusicKit.MusicKitInstance, songId: string) {
  if (mk.nowPlayingItem?.id === songId) return
  const isQueuedNext = mk.queue.items[mk.nowPlayingItemIndex + 1]?.id === songId
  await musicKitInstanceStore.muteTemporarily(async () => {
    if (isQueuedNext) {
      // repeat one のままだと skipToNextItem が進まない
      mk.repeatMode = MusicKit.PlayerRepeatMode.none
      await mk.skipToNextItem()
    } else {
      await mk.setQueue({
        song: songId,
        shuffleMode: MusicKit.PlayerShuffleMode.off,
        repeatMode: MusicKit.PlayerRepeatMode.one,
        startPlaying: false,
        startTime: 0,
      })
      await paced(mk, 'play')
    }
    await paced(mk, 'pause')
  })
  if (mk.nowPlayingItem?.id !== songId) throw new Error('曲を読み込めません')
}

// 頭出し。seekToTime は位置が 0 でも resolve に ~250ms かかるので、必要な時だけ呼ぶ
async function rewind(mk: MusicKit.MusicKitInstance) {
  if (mk.isPlaying) await paced(mk, 'pause')
  if (mk.currentPlaybackTime > 0.1) await mk.seekToTime(0)
}

// 次ラウンドの曲を queue の次に積む。MusicKit は再生中の曲がある間に次 item の manifest / license を
// 先読みする (MSE 環境)。先読みしない環境でも queue に積むだけなので害はない
async function preloadNext(mk: MusicKit.MusicKitInstance, nextSongId: string | null) {
  if (nextSongId === null) return
  if (mk.queue.items[mk.nowPlayingItemIndex + 1]?.id === nextSongId) return
  await mk.playNext({ song: nextSongId })
}

async function playAlbumOfTrack(mk: MusicKit.MusicKitInstance, trackId: string, superseded: () => boolean) {
  const albumId = await albumIdOfTrack(mk, trackId)
  if (superseded()) return
  await mk.setQueue({
    album: albumId,
    repeatMode: MusicKit.PlayerRepeatMode.all,
    shuffleMode: MusicKit.PlayerShuffleMode.off,
    startPlaying: false,
  })
  await paced(mk, 'play', superseded)
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

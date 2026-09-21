// このファイルに対する変更にはユーザーの明示的な承認が必要です。

import { useCallback, useRef } from 'react'
import { useMusicKitInstance } from './useMusicKit'
import { musicKitInstanceStore } from './musicKitStore'

type SequentialPlayback = {
  setSongIds(songIds: string[]): Promise<void>
  prepareNext(): Promise<void>
  playFromStart(): Promise<void>
  playAlbum(albumId: string): Promise<void>
  stop(): Promise<void>
}

export function useSequentialPlayback(): SequentialPlayback {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  const { instance: mk } = useMusicKitInstance()
  const ref = useRef({
    songIds: [] as string[],
    nextIndex: 0,
  })
  // 再生操作は呼び出し順に直列化する。stop() の seekToTime は MusicKit 内部で resolve まで
  // 数百 ms かかるため、並走させると次の play() が再生されないまま終わる。
  const operationsRef = useRef<Promise<void>>(Promise.resolve())

  const serialize = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = operationsRef.current.then(operation, operation)
    operationsRef.current = run.then(() => undefined, () => undefined)
    return run
  }, [])

  const setSongIds = useCallback(async (songIds: string[]) => {
    if (songIds.length === 0) throw new Error('曲がありません')
    ref.current.songIds = [...songIds]
    ref.current.nextIndex = 0
  }, [])

  const stopNow = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (mk.isPlaying) await mk.pause()
    if (mk.nowPlayingItem !== undefined) await mk.seekToTime(0)
  }, [mk])

  const stop = useCallback(() => serialize(stopNow), [serialize, stopNow])

  const prepareNext = useCallback(() => serialize(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')

    const nextSongId = ref.current.songIds[ref.current.nextIndex]
    if (nextSongId === undefined) throw new Error('曲がキューにありません')

    await mk.setQueue({
      song: nextSongId,
      shuffleMode: MusicKit.PlayerShuffleMode.off,
      repeatMode: MusicKit.PlayerRepeatMode.one,
      startPlaying: false,
      startTime: 0,
    })

    await musicKitInstanceStore.muteTemporarily(async () => {
      try {
        await mk.play()
        await new Promise<void>((resolve) => setTimeout(resolve))
      } finally {
        await stopNow()
      }
    })

    ref.current.nextIndex++
  }), [mk, serialize, stopNow])

  const playFromStart = useCallback(() => serialize(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    await stopNow()
    await mk.play()
  }), [mk, serialize, stopNow])

  const playAlbum = useCallback((albumId: string) => serialize(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    await mk.setQueue({
      album: albumId,
      repeatMode: MusicKit.PlayerRepeatMode.all,
      shuffleMode: MusicKit.PlayerShuffleMode.off,
      startPlaying: false,
    })
    await mk.play()
  }), [mk, serialize])

  return {
    setSongIds,
    prepareNext,
    playFromStart,
    playAlbum,
    stop,
  }
}

// このファイルに対する変更にはユーザーの明示的な承認が必要です。

import { useCallback, useRef } from 'react'
import { useMusicKitInstance } from './useMusicKit'

type SequentialPlayback = {
  setSongIds(songIds: string[]): Promise<void>
  prepareNext(): Promise<void>
  playFromStart(): Promise<void>
  stop(): Promise<void>
}

export function useSequentialPlayback(): SequentialPlayback {
  // この関数に対する変更にはユーザーの明示的な承認が必要です。
  const { instance: mk } = useMusicKitInstance()
  const ref = useRef({
    songIds: [] as string[],
    nextIndex: 0,
  })

  const setSongIds = useCallback(async (songIds: string[]) => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (songIds.length === 0) throw new Error('曲がありません')

    await mk.clearQueue()
    ref.current.songIds = [...songIds]
    ref.current.nextIndex = 0
  }, [mk])

  const prepareNext = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')

    const nextSongId = ref.current.songIds[ref.current.nextIndex]
    if (nextSongId === undefined) throw new Error('曲がキューにありません')

    mk.shuffleMode = MusicKit.PlayerShuffleMode.off
    mk.repeatMode = MusicKit.PlayerRepeatMode.one
    await mk.playNext({ song: nextSongId })

    ref.current.nextIndex++
  }, [mk])

  const playFromStart = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    await mk.play()
  }, [mk])

  const stop = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (mk.isPlaying) mk.pause()
  }, [mk])

  return {
    setSongIds,
    prepareNext,
    playFromStart,
    stop,
  }
}

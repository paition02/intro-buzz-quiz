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

    ref.current.songIds = [...songIds]
    ref.current.nextIndex = 0
  }, [mk])

  const prepareNext = useCallback(async () => {
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

    const previousVolume = mk.volume
    mk.volume = 0

    try {
      await mk.play()
      await new Promise<void>((resolve) => setTimeout(resolve))
    } finally {
      if (mk.isPlaying) await mk.pause()
      mk.volume = previousVolume
    }

    ref.current.nextIndex++
  }, [mk])

  const playFromStart = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (mk.isPlaying) await mk.pause()
    if (mk.nowPlayingItem !== undefined) await mk.seekToTime(0)
    await mk.play()
  }, [mk])

  const stop = useCallback(async () => {
    if (mk === null) throw new Error('MusicKit is not initialized')
    if (mk.isPlaying) await mk.pause()
  }, [mk])

  return {
    setSongIds,
    prepareNext,
    playFromStart,
    stop,
  }
}

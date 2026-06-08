import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMusicKitAuth, useMusicKitInstance } from '../useMusicKit'
import { useSequentialPlayback } from '../useSequentialPlayback'
import {
  playlistTracksQueryOptions,
  useLibraryPlaylistsQuery,
  type MusicPlaylist,
} from '../useMusicKitLibraryQueries'
import type { GameState } from '../../type/game'
import {
  consoleAction,
  consoleStatusMessage,
  latestState,
  phaseLabel,
  roundPreparationKeyFromState,
  roundTrackFromState,
  roundTrackIdFromState,
  useGameState,
} from '../lib/gameClient'
import { errorFromUnknown, uniqueTracksById } from '../lib/util'
import { playResultSound, playResultsSound } from '../lib/sounds'
import { PlaylistLibraryBrowser } from '../components/PlaylistPanel'
import { PlayerBadge } from '../components/PlayerBadge'
import { CircularSecondsSlider } from '../components/CircularSecondsSlider'
import { Glass } from '../components/Glass'
import { Button } from '../components/Button'
import { Eyebrow } from '../components/Eyebrow'

const JUDGE_RESULT_DURATION_MS = 1800

export function ConsolePage() {
  const { instance: musicKitInstance, error: musicKitInitError } = useMusicKitInstance()
  const { setSongIds, prepareNext, playFromStart, stop } = useSequentialPlayback()
  const musicKitAuth = useMusicKitAuth()
  const queryClient = useQueryClient()
  const libraryPlaylistsQuery = useLibraryPlaylistsQuery()
  const loadingLibraryPlaylists = libraryPlaylistsQuery.isPending || libraryPlaylistsQuery.isFetching
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)
  const [playbackSeconds, setPlaybackSeconds] = useState(0.5)
  const [isPreparingNext, setIsPreparingNext] = useState(false)
  const [preparedRoundKey, setPreparedRoundKey] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState<Error | null>(null)
  const autoReadyRequestedRef = useRef(false)
  const autoLoadLibraryPlaylistsRequestedRef = useRef(false)
  const playEndedTimeoutIdRef = useRef<number | null>(null)
  const feedbackEndedTimeoutIdRef = useRef<number | null>(null)
  const musicKitReady = musicKitInstance !== null
  const musicKitError = musicKitInitError ?? musicKitAuth.error ?? playbackError

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setConsoleMessage(null)
    try {
      await action()
    } catch (error) {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const report = useCallback((error: unknown) => {
    setConsoleMessage(error instanceof Error ? error.message : String(error))
  }, [])

  const loadLibraryPlaylists = useCallback(async (): Promise<MusicPlaylist[]> => {
    const result = await libraryPlaylistsQuery.refetch()
    if (result.error) throw result.error
    const playlists = result.data ?? []
    const playlistIds = new Set(playlists.map((playlist) => playlist.id))
    setExpandedPlaylistIds((current) => new Set([...current].filter((playlistId) => playlistIds.has(playlistId))))
    return playlists
  }, [libraryPlaylistsQuery])

  const clearPlayEndedTimeout = useCallback(() => {
    if (playEndedTimeoutIdRef.current === null) return
    window.clearTimeout(playEndedTimeoutIdRef.current)
    playEndedTimeoutIdRef.current = null
  }, [])

  const clearFeedbackEndedTimeout = useCallback(() => {
    if (feedbackEndedTimeoutIdRef.current === null) return
    window.clearTimeout(feedbackEndedTimeoutIdRef.current)
    feedbackEndedTimeoutIdRef.current = null
  }, [])

  const state = useGameState(useCallback(async (change: Partial<GameState>) => {
    if (musicKitInstance === null || !musicKitAuth.authorized) return

    if (change.step !== undefined && change.step !== 'playing') clearPlayEndedTimeout()
    if (change.step !== undefined && change.step !== 'correct' && change.step !== 'wrong') clearFeedbackEndedTimeout()

    if (change.step !== undefined && change.step !== 'playing' && change.step !== 'reveal') {
      try {
        await stop()
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      }
    }

    if (change.step === 'reveal') {
      try {
        await playFromStart()
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      }
    }

    if (change.roundIndex !== undefined || change.shuffledTrackIds !== undefined) {
      const nextRoundKey = roundPreparationKeyFromState(latestState)
      setPreparedRoundKey(null)

      if (latestState.roundIndex < 0 || nextRoundKey === null) {
        setIsPreparingNext(false)
        return
      }

      setIsPreparingNext(true)
      try {
        if (change.shuffledTrackIds !== undefined) {
          const songIds = latestState.shuffledTrackIds.slice(latestState.roundIndex)
          await setSongIds(songIds)
        }
        await prepareNext()
        setPreparedRoundKey(nextRoundKey)
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      } finally {
        setIsPreparingNext(false)
      }
    } else if (change.step === 'beforePlayback') {
      const nextRoundKey = roundPreparationKeyFromState(latestState)
      if (nextRoundKey !== null && preparedRoundKey !== nextRoundKey) {
        setPreparedRoundKey(null)
        setIsPreparingNext(true)
        try {
          await prepareNext()
          setPreparedRoundKey(nextRoundKey)
          setPlaybackError(null)
        } catch (error) {
          setPlaybackError(errorFromUnknown(error))
        } finally {
          setIsPreparingNext(false)
        }
      }
    }

  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout, musicKitAuth.authorized, musicKitInstance, playFromStart, prepareNext, preparedRoundKey, setSongIds, stop]))

  useEffect(() => {
    return () => {
      clearPlayEndedTimeout()
      clearFeedbackEndedTimeout()
    }
  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout])

  const participatingPlayers = state.players
  const selectedPlaylistIds = state.selectedPlaylistIds
  const selectedPlaylistIdSet = useMemo(() => new Set(selectedPlaylistIds), [selectedPlaylistIds])
  const seconds = playbackSeconds
  const statusMessage = consoleStatusMessage(state, seconds)
  const roundTrackId = roundTrackIdFromState(state)
  const roundTrack = roundTrackFromState(state)
  const roundPreparationKey = roundPreparationKeyFromState(state)
  const roundPrepared = roundPreparationKey !== null && preparedRoundKey === roundPreparationKey
  const canPlayIntro = state.step === 'beforePlayback' && roundTrackId != null && roundPrepared && !isPreparingNext && playbackError === null && musicKitReady && musicKitAuth.authorized
  const canGoNextRound = state.phase === 'game' && state.step === 'reveal' && state.roundIndex >= 0 && state.roundIndex + 1 < state.shuffledTrackIds.length
  const playButtonLabel = state.step === 'playing' ? '再生中' : state.step === 'beforePlayback' && roundTrackId != null && !roundPrepared ? 'ロード中' : '再生'

  const handlePlaybackSecondsChange = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  const handlePlaybackSecondsCommit = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  useEffect(() => {
    if (!musicKitAuth.authorized) autoLoadLibraryPlaylistsRequestedRef.current = false
    if (state.phase !== 'initialization') autoReadyRequestedRef.current = false

    if (musicKitReady && musicKitAuth.authorized && state.phase === 'initialization' && !autoReadyRequestedRef.current) {
      autoReadyRequestedRef.current = true
      void consoleAction('console:ready').catch((error) => {
        autoReadyRequestedRef.current = false
        report(error)
      })
    }

    if (
      musicKitReady &&
      musicKitAuth.authorized &&
      !loadingLibraryPlaylists &&
      (libraryPlaylistsQuery.data === undefined || libraryPlaylistsQuery.data.length === 0) &&
      !autoLoadLibraryPlaylistsRequestedRef.current
    ) {
      autoLoadLibraryPlaylistsRequestedRef.current = true
      void loadLibraryPlaylists().catch(report)
    }
  }, [
    libraryPlaylistsQuery.data,
    loadLibraryPlaylists,
    loadingLibraryPlaylists,
    musicKitAuth.authorized,
    musicKitReady,
    report,
    state.phase,
  ])

  const handleLogin = () => run(async () => {
    autoReadyRequestedRef.current = true
    autoLoadLibraryPlaylistsRequestedRef.current = true
    try {
      await musicKitAuth.authorize()
      await consoleAction('console:ready')
      const playlists = await loadLibraryPlaylists()
      setConsoleMessage(`Apple Musicにログインしました。${playlists.length}件のライブラリプレイリストを取得しました`)
    } catch (error) {
      autoReadyRequestedRef.current = false
      autoLoadLibraryPlaylistsRequestedRef.current = false
      throw error
    }
  })

  const fetchPlaylistTracks = async (playlist: MusicPlaylist) => {
    return queryClient.ensureQueryData(playlistTracksQueryOptions(musicKitInstance, musicKitAuth.authorized, playlist.id))
  }

  const togglePlaylistSelected = (playlist: MusicPlaylist) => run(async () => {
    const currentSelectedIds = new Set(state.selectedPlaylistIds)
    if (currentSelectedIds.has(playlist.id)) currentSelectedIds.delete(playlist.id)
    else currentSelectedIds.add(playlist.id)

    if (!libraryPlaylistsQuery.data) return
    const selectedPlaylists = libraryPlaylistsQuery.data.filter((libraryPlaylist) => currentSelectedIds.has(libraryPlaylist.id))
    const trackGroups = await Promise.all(selectedPlaylists.map((selectedPlaylist) => fetchPlaylistTracks(selectedPlaylist)))
    const tracks = uniqueTracksById(trackGroups.flat())

    await consoleAction('console:select-playlists', {
      selectedPlaylistIds: selectedPlaylists.map((selectedPlaylist) => selectedPlaylist.id),
      tracks,
    })

    if (selectedPlaylists.length === 0) {
      setConsoleMessage('プレイリストの選択を解除しました')
    } else {
      setConsoleMessage(`${selectedPlaylists.length}件のプレイリストから${tracks.length}曲を選択しました`)
    }
  })

  const togglePlaylistExpanded = (playlist: MusicPlaylist) => run(async () => {
    setExpandedPlaylistIds((current) => {
      const next = new Set(current)
      if (next.has(playlist.id)) next.delete(playlist.id)
      else next.add(playlist.id)
      return next
    })
  })

  // 再生操作はボタンと useGameState(onChange) からだけ useSequentialPlayback へ渡す。
  const handleStart = () => run(async () => {
    if (state.tracks.length === 0) {
      setConsoleMessage('曲を選択してから開始してください')
      return
    }
    await consoleAction('console:start')
  })

  const handlePlay = () => run(async () => {
    if (!canPlayIntro) {
      setConsoleMessage('曲の準備完了を待っています')
      return
    }
    await consoleAction('console:play')
    await playFromStart()
    setPlaybackError(null)
    clearPlayEndedTimeout()
    playEndedTimeoutIdRef.current = window.setTimeout(async () => {
      playEndedTimeoutIdRef.current = null
      try {
        await stop()
        setPlaybackError(null)
        await consoleAction('console:play-ended')
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
        report(error)
      }
    }, Math.ceil(seconds * 1000))
  })

  const handleCorrect = () => run(async () => {
    await consoleAction('console:correct')
    playResultSound('correct')
    clearFeedbackEndedTimeout()
    feedbackEndedTimeoutIdRef.current = window.setTimeout(async () => {
      feedbackEndedTimeoutIdRef.current = null
      try {
        await consoleAction('console:correct-feedback-ended')
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
        report(error)
      }
    }, JUDGE_RESULT_DURATION_MS)
  })

  const handleWrong = () => run(async () => {
    await consoleAction('console:wrong')
    playResultSound('wrong')
    clearFeedbackEndedTimeout()
    feedbackEndedTimeoutIdRef.current = window.setTimeout(() => {
      feedbackEndedTimeoutIdRef.current = null
      void consoleAction('console:wrong-feedback-ended').catch(report)
    }, JUDGE_RESULT_DURATION_MS)
  })

  const handleGiveUp = () => run(async () => {
    await consoleAction('console:give-up')
  })

  const handleNextRound = () => run(async () => {
    await consoleAction('console:next-round')
  })

  const handleShowResults = () => run(async () => {
    await consoleAction('console:show-results')
    playResultsSound()
  })

  const handleNextGame = () => run(async () => {
    await consoleAction('console:next-game')
  })

  const handleReset = () => run(async () => {
    await consoleAction('console:reset')
  })

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <Glass as="header" className="rounded-3xl p-6 flex flex-col items-stretch justify-between gap-4 mb-4 md:flex-row md:items-center">
        <div>
          <Eyebrow>Host Console</Eyebrow>
          <h1 className="m-0 text-4xl sm:text-6xl font-black tracking-tighter">早押しイントロクイズ</h1>
        </div>
      </Glass>

      <Glass as="section" className="rounded-3xl p-6 flex flex-col items-stretch justify-between gap-4 mb-4 md:flex-row md:items-center">
        <div>
          <Eyebrow>現在</Eyebrow>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">{phaseLabel(state.phase, state.step)}</h2>
          <p className="mt-0 text-subtle leading-relaxed">{statusMessage}</p>
          {consoleMessage && <p className="mt-0 leading-relaxed text-muted">{consoleMessage}</p>}
          {musicKitError && <p className="mt-0 leading-relaxed text-rose font-bold">MusicKit: <span>{musicKitError.message}</span></p>}
        </div>
        <Button variant="danger" onClick={handleReset}>リセット</Button>
      </Glass>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
        <Glass className="rounded-2xl p-6 min-w-0">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">1. 初期化</h2>
          <p className="mt-0 text-subtle leading-relaxed">Apple Musicにログインして、MusicKitで実際に再生できる状態にします。</p>
          <div className={`flex items-center gap-3 my-4 p-3.5 rounded-2xl border ${!musicKitReady ? 'bg-white/5 border-white/10' : musicKitAuth.authorized ? 'bg-mint/10 border-mint/30' : 'bg-rose/10 border-rose/30'}`}>
            <span className={`size-3.5 rounded-full shrink-0 ${!musicKitReady ? 'bg-muted animate-dot-pulse' : musicKitAuth.authorized ? 'bg-mint' : 'bg-rose'}`} />
            <div>
              <strong className="block text-cream">{musicKitReady ? (musicKitAuth.authorized ? 'Apple Music ログイン済み' : 'Apple Music 未ログイン') : 'MusicKit 準備中'}</strong>
              <p className="mt-1 mb-0 text-subtle leading-snug">{musicKitReady ? (musicKitAuth.authorized ? 'ライブラリのプレイリストを複数選択できます' : 'ログインするとライブラリのプレイリストを取得できます') : 'MusicKit JS を初期化しています'}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5 mt-3.5 max-md:[&>button]:flex-1">
            <Button disabled={busy || !musicKitReady || musicKitAuth.authorized} onClick={handleLogin}>Apple Musicにログイン</Button>
            <Button variant="ghost" disabled={busy || !musicKitAuth.authorized} onClick={() => run(musicKitAuth.unauthorize)}>ログアウト</Button>
          </div>
        </Glass>

        <Glass className="rounded-2xl p-6 min-w-0">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">2. 準備</h2>
          <div className="flex items-center justify-between gap-3 text-cream font-bold mt-4 mb-3">
            <span>ライブラリプレイリスト</span>
            <Button variant="ghostSmall" disabled={busy || loadingLibraryPlaylists || !musicKitAuth.authorized} onClick={() => run(async () => { await loadLibraryPlaylists() })}>{loadingLibraryPlaylists ? '読み込み中' : '再読み込み'}</Button>
          </div>
          {libraryPlaylistsQuery.status === 'success' && libraryPlaylistsQuery.data.length > 0 ? (
            <PlaylistLibraryBrowser
              playlists={libraryPlaylists}
              authorized={musicKitAuth.authorized}
              busy={busy}
              expandedPlaylistIds={expandedPlaylistIds}
              selectedPlaylistIdSet={selectedPlaylistIdSet}
              onSelect={togglePlaylistSelected}
              onToggleExpanded={togglePlaylistExpanded}
            />
          ) : (
            <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
              <li className="text-muted">{loadingLibraryPlaylists ? 'ライブラリのプレイリストを読み込み中...' : 'ログイン後にライブラリのプレイリストを取得します'}</li>
            </ul>
          )}
          {selectedPlaylistIds.length > 0 && (
            <p className="mt-3 mb-0 text-subtle leading-relaxed">
              {selectedPlaylistIds.length}件のプレイリスト、{state.tracks.length}曲を選択中
            </p>
          )}
          <div className="flex flex-wrap gap-2.5 mt-3.5 max-md:[&>button]:flex-1">
            <Button disabled={busy || state.phase !== 'ready' || selectedPlaylistIds.length === 0 || state.tracks.length === 0} onClick={handleStart}>ゲーム開始</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <span className="text-muted">参加中:</span>
            {participatingPlayers.length ? participatingPlayers.map((player) => (
              <PlayerBadge id={player.id} label={false} key={player.id} />
            )) : <span className="text-muted">まだいません</span>}
          </div>
        </Glass>

        </div>

        <div className="flex flex-col gap-4 min-w-0">

        <Glass className="rounded-2xl p-6 min-w-0">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">3. 進行</h2>
          <div className="grid justify-items-center gap-2.5">
            <span className="justify-self-start text-cream font-bold">再生秒数</span>
            <CircularSecondsSlider
              value={seconds}
              onChange={handlePlaybackSecondsChange}
              onCommit={handlePlaybackSecondsCommit}
            />
          </div>
          <div className="grid gap-3.5 mt-4">
            <div className="grid gap-2.5 grid-cols-1 md:grid-cols-2 [&>button]:min-h-14">
              <Button disabled={busy || !canPlayIntro} onClick={handlePlay}>{playButtonLabel}</Button>
              <Button variant="ghost" disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback' || !roundPrepared} onClick={handleGiveUp}>ギブアップ</Button>
              <Button disabled={busy || state.step !== 'answering'} onClick={handleCorrect}>正解</Button>
              <Button disabled={busy || state.step !== 'answering'} onClick={handleWrong}>不正解</Button>
            </div>
            <div className="grid gap-2.5 grid-cols-1 md:grid-cols-3 pt-3.5 border-t border-white/10 [&>button]:min-h-14">
              <Button disabled={busy || !canGoNextRound} onClick={handleNextRound}>次のラウンドへ</Button>
              <Button disabled={busy || state.step !== 'reveal'} onClick={handleShowResults}>結果発表へ</Button>
              <Button disabled={busy || state.step !== 'results'} onClick={handleNextGame}>次のゲームへ</Button>
            </div>
          </div>
        </Glass>

        <Glass className="rounded-2xl p-6 min-w-0">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">曲情報</h2>
          {roundTrack ? (
            <div className="flex items-center gap-4 rounded-2xl p-5 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10">
              {(roundTrack.artworkThumbUrl ?? roundTrack.artworkUrl) ? (
                <img
                  className="size-24 rounded-xl shrink-0 object-cover bg-linear-to-br from-pink to-amber"
                  src={roundTrack.artworkThumbUrl ?? roundTrack.artworkUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="size-24 rounded-xl shrink-0 grid place-items-center bg-linear-to-br from-pink to-amber text-cocoa text-4xl font-black" aria-hidden="true">♪</span>
              )}
              <div className="min-w-0">
                <strong className="block text-2xl font-bold leading-tight">{roundTrack.title}</strong>
                <span className="block mt-2.5 text-subtle">{roundTrack.artist}</span>
              </div>
            </div>
          ) : <p className="mt-0 text-subtle leading-relaxed">まだ曲は準備されていません。</p>}
        </Glass>
        </div>
      </section>
    </main>
  )
}

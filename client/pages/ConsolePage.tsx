import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useMusicKitAuth, useMusicKitInstance } from '../useMusicKit'
import { introTarget, isPlaybackSuperseded, playbackTargetFromState, playbackTargetsEqual, usePlaybackTarget } from '../usePlaybackTarget'
import {
  playlistTracksQueryOptions,
  useLibraryPlaylistsQuery,
  useInvalidateLibraryPlaylists,
  type MusicPlaylist,
} from '../useMusicKitLibraryQueries'
import type { GameState, JacketMode, QuizMode } from '../../type/game'
import {
  consoleAction,
  consoleStatusMessage,
  latestState,
  phaseLabel,
  roundPreparationKeyFromState,
  roundTrackFromState,
  roundAlbumFromState,
  roundTrackIdFromState,
  useGameState,
  useConnected,
} from '../lib/gameClient'
import { uniqueTracksById } from '../lib/util'
import { playResultSound, playResultsSound } from '../lib/sounds'
import { LibraryPlaylistsSection } from '../components/PlaylistPanel'
import { PlayerBadge } from '../components/PlayerBadge'
import { CircularSecondsSlider } from '../components/CircularSecondsSlider'
import { JacketHintSlider } from '../components/JacketHintSlider'
import { Glass } from '../components/Glass'
import { Button } from '../components/Button'
import { Eyebrow } from '../components/Eyebrow'
import { RoundInfoDisclosure } from '../components/RoundInfoDisclosure'
import { AnswerCard, type AnswerCandidate } from '../components/AnswerCard'
import { watchIntroDeadline } from '../lib/introDeadline'
import { isUnavailableTrack } from '../lib/unavailableTrack'

const JUDGE_RESULT_DURATION_MS = 1800
const jacketModeOptions: Array<{ value: JacketMode; label: string }> = [
  { value: 'pixelated', label: 'モザイク' },
  { value: 'missingBlocks', label: '穴あき' },
  { value: 'tileShuffle', label: 'タイルシャッフル' },
  { value: 'circleReveal', label: 'スポットライト' },
  { value: 'zoomRotateCrop', label: 'ズーム＆回転' },
  { value: 'edgeReveal', label: 'ふちから表示' },
]

export function ConsolePage() {
  const { instance: musicKitInstance, error: musicKitInitError } = useMusicKitInstance()
  const { status: playback, setTarget: setPlaybackTarget } = usePlaybackTarget()
  const musicKitAuth = useMusicKitAuth()
  const connected = useConnected()
  const actionVersionRef = useRef(0)
  const judgingRef = useRef<symbol | null>(null)
  const playRequestRef = useRef<symbol | null>(null)
  const queryClient = useQueryClient()
  const libraryPlaylistsQuery = useLibraryPlaylistsQuery()
  const loadingLibraryPlaylists = libraryPlaylistsQuery.isPending || libraryPlaylistsQuery.isFetching
  const invalidateLibraryPlaylists = useInvalidateLibraryPlaylists()
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)
  const [playbackSeconds, setPlaybackSeconds] = useState(0.5)
  const [expandedRoundKey, setExpandedRoundKey] = useState<string | null>(null)
  const autoReadyRequestedRef = useRef(false)
  const stopIntroWatchRef = useRef<(() => void) | null>(null)
  const activeIntroRef = useRef<string | null>(null)
  const recoveryRef = useRef<string | null>(null)
  const [activeSeconds, setActiveSeconds] = useState(0.5)
  const feedbackEndedTimeoutIdRef = useRef<number | null>(null)
  const musicKitReady = musicKitInstance !== null
  const playbackError = playback.error
  const musicKitError = musicKitInitError ?? musicKitAuth.error ?? playbackError

  const run = async (action: () => Promise<void>) => {
    const version = ++actionVersionRef.current
    setBusy(true)
    setConsoleMessage(null)
    try {
      await action()
    } catch (error) {
      if (version === actionVersionRef.current && !isPlaybackSuperseded(error)) setConsoleMessage(error instanceof Error ? error.message : String(error))
    } finally {
      if (version === actionVersionRef.current) setBusy(false)
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
    stopIntroWatchRef.current?.()
    stopIntroWatchRef.current = null
    activeIntroRef.current = null
  }, [])

  const clearFeedbackEndedTimeout = useCallback(() => {
    if (feedbackEndedTimeoutIdRef.current === null) return
    window.clearTimeout(feedbackEndedTimeoutIdRef.current)
    feedbackEndedTimeoutIdRef.current = null
  }, [])

  const state = useGameState(useCallback((change: Partial<GameState>) => {
    if (change.step !== undefined && change.step !== 'playing') clearPlayEndedTimeout()
    if (change.operationId !== undefined && activeIntroRef.current !== null && change.operationId !== activeIntroRef.current) clearPlayEndedTimeout()
    if (change.step !== undefined && change.step !== 'correct' && change.step !== 'wrong') clearFeedbackEndedTimeout()
  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout]))

  useEffect(() => {
    if (!musicKitInstance) return
    const failed = (event: MusicKit.Events['mediaPlaybackError']) => {
      if (!isUnavailableTrack(event.error)) return
      const current = latestState
      const trackId = musicKitInstance.nowPlayingItem?.id
      if (current.phase !== 'game' || !trackId || !current.tracks.some(track => track.id === trackId)) return
      clearPlayEndedTimeout()
      void setPlaybackTarget({ kind: 'stopped' }).catch(report)
      report('再生できない曲を除外しました')
      void consoleAction('console:exclude-track', { operationId: current.operationId, trackId }).catch(report)
    }
    musicKitInstance.addEventListener('mediaPlaybackError', failed)
    return () => musicKitInstance.removeEventListener('mediaPlaybackError', failed)
  }, [musicKitInstance, clearPlayEndedTimeout, report, setPlaybackTarget])

  // 望ましい再生状態はゲーム状態から導いて宣言するだけ。適用順序や古い状態変化の扱いは usePlaybackTarget が持つ。
  useEffect(() => {
    if (musicKitInstance === null) return
    const target = musicKitAuth.authorized ? playbackTargetFromState(state) : { kind: 'stopped' as const }
    if (target !== null) setPlaybackTarget(target).catch((error: unknown) => {
      if (!isUnavailableTrack(error) || latestState.operationId !== state.operationId) return
      const trackId = (target.kind === 'album' || target.kind === 'albumPrepared') ? target.trackId : target.kind !== 'stopped' ? target.songId : null
      if (trackId) {
        report('再生できない曲を除外しました')
        void consoleAction('console:exclude-track', { operationId: state.operationId, trackId }).catch(report)
      }
    })
  }, [musicKitAuth.authorized, musicKitInstance, report, setPlaybackTarget, state])

  // A fresh console has no owner for an interrupted intro. Reconcile the
  // shared game to waiting; never recreate playback from an old state event.
  useEffect(() => {
    if (!connected || state.step !== 'playing' || playRequestRef.current || activeIntroRef.current || recoveryRef.current === state.operationId) return
    const operationId = state.operationId
    recoveryRef.current = operationId
    void (async () => {
      if (musicKitInstance) await setPlaybackTarget({ kind: 'stopped' })
      if (latestState.operationId === operationId && latestState.step === 'playing') await consoleAction('console:play-ended', { operationId })
    })().catch(report).finally(() => { recoveryRef.current = null })
  }, [busy, connected, musicKitInstance, report, setPlaybackTarget, state])

  // Feedback must also complete when the console was reloaded or its ack was
  // lost. The state identifies the verdict, so this never scores twice.
  useEffect(() => {
    if (state.step !== 'correct' && state.step !== 'wrong') return
    const operationId = state.operationId
    const step = state.step
    clearFeedbackEndedTimeout()
    feedbackEndedTimeoutIdRef.current = window.setTimeout(() => {
      feedbackEndedTimeoutIdRef.current = null
      if (latestState.operationId === operationId && latestState.step === step) void consoleAction(`console:${step}-feedback-ended`, { operationId }).catch(report)
    }, JUDGE_RESULT_DURATION_MS)
    return clearFeedbackEndedTimeout
  }, [state.operationId, state.step, clearFeedbackEndedTimeout, report])

  const invalidatePendingActions = useCallback(() => { actionVersionRef.current++ }, [])
  useEffect(() => {
    return () => {
      invalidatePendingActions()
      clearPlayEndedTimeout()
      clearFeedbackEndedTimeout()
    }
  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout, invalidatePendingActions])

  const participatingPlayers = state.players
  const selectedPlaylistIds = state.selectedPlaylistIds
  const selectedPlaylistIdSet = useMemo(() => new Set(selectedPlaylistIds), [selectedPlaylistIds])
  const seconds = playbackSeconds
  const statusMessage = consoleStatusMessage(state, state.step === 'playing' ? activeSeconds : seconds)
  const roundTrackId = roundTrackIdFromState(state)
  const roundTrack = roundTrackFromState(state)
  const isJacket = state.quizMode === 'jacket'
  const roundAlbum = roundAlbumFromState(state)
  const roundInfo = isJacket ? roundAlbum : roundTrack
  const roundAnswerId = isJacket ? roundAlbum?.id ?? null : roundTrackId
  const answerCandidates = useMemo<AnswerCandidate[]>(() => isJacket
    ? state.albums.map((album) => ({ id: album.id, title: album.name, artist: album.artist, artworkUrl: album.artworkChipUrl }))
    : state.tracks.map((track) => ({ id: track.id, title: track.title, artist: track.artist, artworkUrl: track.artworkChipUrl })), [isJacket, state.albums, state.tracks])
  const roundPreparationKey = roundPreparationKeyFromState(state)
  const isPreparingNext = playback.target !== null && !playbackTargetsEqual(playback.target, playback.settled)
  const roundPrepared = state.quizMode === 'jacket'
    ? roundPreparationKey !== null
    : roundTrackId != null && playback.settled?.kind === 'prepared' && playback.settled.songId === roundTrackId
  const trackInfoExpanded = roundPreparationKey !== null && expandedRoundKey === roundPreparationKey
  const canPlayIntro = state.quizMode === 'intro' && state.step === 'beforePlayback' && roundTrackId != null && roundPrepared && !isPreparingNext && playbackError === null && musicKitReady && musicKitAuth.authorized
  const canGoNextRound = state.phase === 'game' && state.step === 'reveal' && (
    state.quizMode === 'jacket'
      ? state.roundAlbumIndex >= 0 && state.roundAlbumIndex + 1 < state.shuffledAlbumIds.length
      : state.roundIndex >= 0 && state.roundIndex + 1 < state.shuffledTrackIds.length
  )
  const playButtonLabel = state.step === 'playing' ? '再生中' : state.step === 'beforePlayback' && roundTrackId != null && !roundPrepared ? 'ロード中' : '再生'

  const handlePlaybackSecondsChange = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  const handlePlaybackSecondsCommit = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  const handleToggleTrackInfo = useCallback(() => {
    if (roundPreparationKey === null) return
    setExpandedRoundKey((current) => current === roundPreparationKey ? null : roundPreparationKey)
  }, [roundPreparationKey])

  useEffect(() => {
    if (state.phase !== 'initialization') autoReadyRequestedRef.current = false

    if (musicKitReady && musicKitAuth.authorized && state.phase === 'initialization' && !autoReadyRequestedRef.current) {
      autoReadyRequestedRef.current = true
      void consoleAction('console:ready').catch((error) => {
        autoReadyRequestedRef.current = false
        report(error)
      })
    }
  }, [
    musicKitAuth.authorized,
    musicKitReady,
    report,
    state.phase,
  ])

  const handleLogin = () => run(async () => {
    autoReadyRequestedRef.current = true
    try {
      await musicKitAuth.authorize()
      await consoleAction('console:ready')
      const playlists = await loadLibraryPlaylists()
      setConsoleMessage(`Apple Musicにログインしました。${playlists.length}件のライブラリプレイリストを取得しました`)
    } catch (error) {
      autoReadyRequestedRef.current = false
      throw error
    }
  })

  const fetchPlaylistTracks = async (playlist: MusicPlaylist) => {
    return queryClient.ensureQueryData(playlistTracksQueryOptions(musicKitInstance, musicKitAuth.authorized, playlist.id))
  }

  const togglePlaylistSelected = (playlist: MusicPlaylist, allPlaylists: MusicPlaylist[]) => run(async () => {
    const version = actionVersionRef.current
    const currentSelectedIds = new Set(state.selectedPlaylistIds)
    if (currentSelectedIds.has(playlist.id)) currentSelectedIds.delete(playlist.id)
    else currentSelectedIds.add(playlist.id)

    const selectedPlaylists = allPlaylists.filter((p) => currentSelectedIds.has(p.id))
    const trackGroups = await Promise.all(selectedPlaylists.map((selectedPlaylist) => fetchPlaylistTracks(selectedPlaylist)))
    if (version !== actionVersionRef.current || latestState.phase !== 'ready') return
    const tracks = uniqueTracksById(trackGroups.flatMap(group => group.tracks))

    await consoleAction('console:select-playlists', {
      selectedPlaylistIds: selectedPlaylists.map((selectedPlaylist) => selectedPlaylist.id),
      tracks,
    })

    if (selectedPlaylists.length === 0) {
      setConsoleMessage('プレイリストの選択を解除しました')
    } else {
      const unavailableCount = trackGroups.reduce((sum, group) => sum + group.unavailableCount, 0)
      setConsoleMessage(`${selectedPlaylists.length}件のプレイリストから${tracks.length}曲を選択しました${unavailableCount ? `。再生できない${unavailableCount}曲を除外しました` : ''}`)
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

  // 再生操作は state からの導出 (上の useEffect) と再生ボタンからだけ usePlaybackTarget へ宣言する。
  const handleStart = (quizMode: QuizMode) => run(async () => {
    if (state.tracks.length === 0) {
      setConsoleMessage('曲を選択してから開始してください')
      return
    }
    await consoleAction('console:start', { quizMode })
  })

  const handlePlay = () => {
    if (playRequestRef.current) return
    const request = Symbol('play')
    playRequestRef.current = request
    return run(async () => {
      const version = actionVersionRef.current
      if (!canPlayIntro) {
        setConsoleMessage('曲の準備完了を待っています')
        return
      }
      await consoleAction('console:play')
      if (version !== actionVersionRef.current) return
      setBusy(false)
      if (latestState.step !== 'playing' || roundPreparationKeyFromState(latestState) !== roundPreparationKey) return
      const playing = introTarget(latestState, 'playing')
      if (playing === null) return
      const operationId = latestState.operationId
      activeIntroRef.current = operationId
      setActiveSeconds(seconds)
      try {
        await setPlaybackTarget(playing)
      } catch (error) {
        if (!isPlaybackSuperseded(error)) {
          clearPlayEndedTimeout()
          if (latestState.operationId === operationId && latestState.step === 'playing') {
            if (isUnavailableTrack(error) && playing.kind === 'playing') await consoleAction('console:exclude-track', { operationId, trackId: playing.songId })
            else await consoleAction('console:play-ended', { operationId })
          }
          throw error
        }
        return
      }
      clearPlayEndedTimeout()
      activeIntroRef.current = operationId
      if (!musicKitInstance || latestState.operationId !== operationId || latestState.step !== 'playing') return
      stopIntroWatchRef.current = watchIntroDeadline(musicKitInstance, seconds, () => { void (async () => {
        try {
          if (latestState.operationId !== operationId || latestState.step !== 'playing') return
          const prepared = introTarget(latestState, 'prepared')
          if (prepared !== null) await setPlaybackTarget(prepared).catch((error: unknown) => { if (!isPlaybackSuperseded(error)) throw error })
          if (latestState.operationId === operationId && latestState.step === 'playing') await consoleAction('console:play-ended', { operationId })
        } catch (error) {
          if (latestState.operationId === operationId) report(error)
        }
      })() })
    }).finally(() => {
      if (playRequestRef.current === request) playRequestRef.current = null
    })
  }

  const handleJudgment = (verdict: 'correct' | 'wrong') => {
    if (judgingRef.current) return
    const request = Symbol('judgment')
    judgingRef.current = request
    return run(async () => {
      const version = actionVersionRef.current
      try {
        await consoleAction(`console:${verdict}`)
        if (version !== actionVersionRef.current || latestState.step !== verdict) return
        try { playResultSound(verdict) } catch (error) { report(error) }
      } finally {
        if (judgingRef.current === request) judgingRef.current = null
      }
    })
  }
  const handleCorrect = () => handleJudgment('correct')
  const handleWrong = () => handleJudgment('wrong')

  // 入力回答は候補の id を今ラウンドの正解と突き合わせ、host の正解 / 不正解操作と同じ経路へ流す。
  const handleAnswer = (candidate: AnswerCandidate) => {
    if (candidate.id === roundAnswerId) return handleCorrect()
    return handleWrong()
  }

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
    playRequestRef.current = null
    judgingRef.current = null
    clearPlayEndedTimeout()
    clearFeedbackEndedTimeout()
    void setPlaybackTarget({ kind: 'stopped' }).catch(report)
    await consoleAction('console:reset')
  })

  const handleJacketModeChange = (jacketMode: JacketMode) => run(async () => {
    await consoleAction('console:set-jacket-mode', { jacketMode })
  })

  const handleJacketGrayscaleChange = (jacketGrayscale: boolean) => run(async () => {
    await consoleAction('console:set-jacket-grayscale', { jacketGrayscale })
  })

  const handleJacketHintPercentChange = (jacketHintPercent: number) => {
    return consoleAction('console:set-jacket-hint-percent', { jacketHintPercent })
  }

  const progressControls = state.quizMode === 'jacket' ? (
    <>
      <div className="grid gap-4">
        <label className="grid gap-2">
          <span className="text-cream font-bold">隠し方</span>
          <select
            className="min-h-12 rounded-xl border border-white/10 bg-black/40 px-3.5 text-cream font-bold outline-none focus:border-amber"
            value={state.jacketMode}
            onChange={(event) => void handleJacketModeChange(event.currentTarget.value as JacketMode)}
            disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback'}
            aria-label="隠し方"
          >
            {jacketModeOptions.map((option) => (
              <option className="bg-ink text-cream" value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/30 px-3.5">
          <span className="text-cream font-bold">白黒</span>
          <input
            className="size-6 accent-amber"
            type="checkbox"
            checked={state.jacketGrayscale}
            onChange={(event) => void handleJacketGrayscaleChange(event.currentTarget.checked)}
            disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback'}
            aria-label="白黒"
          />
        </label>
      </div>
      <div className="grid justify-items-center gap-2.5 mt-4">
        <span className="justify-self-start text-cream font-bold">ヒントレベル</span>
        <JacketHintSlider
          key={roundPreparationKey}
          value={state.jacketHintPercent}
          onChange={handleJacketHintPercentChange}
          onError={report}
        />
      </div>
    </>
  ) : (
    <div className="grid justify-items-center gap-2.5">
      <span className="justify-self-start text-cream font-bold">再生秒数</span>
      <CircularSecondsSlider
        value={seconds}
        onChange={handlePlaybackSecondsChange}
        onCommit={handlePlaybackSecondsCommit}
      />
    </div>
  )

  const primaryProgressButtons = state.quizMode === 'jacket' ? (
    <div className="grid gap-2.5 grid-cols-1 md:grid-cols-2 [&>button]:min-h-14">
      <Button variant="ghost" disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback' || !roundPrepared} onClick={handleGiveUp}>ギブアップ</Button>
      <Button disabled={state.step !== 'answering'} onClick={handleCorrect}>正解</Button>
      <Button disabled={state.step !== 'answering'} onClick={handleWrong}>不正解</Button>
    </div>
  ) : (
    <div className="grid gap-2.5 grid-cols-1 md:grid-cols-2 [&>button]:min-h-14">
      <Button disabled={busy || !canPlayIntro} onClick={handlePlay}>{playButtonLabel}</Button>
      <Button variant="ghost" disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback' || !roundPrepared} onClick={handleGiveUp}>ギブアップ</Button>
      <Button disabled={state.step !== 'answering'} onClick={handleCorrect}>正解</Button>
      <Button disabled={state.step !== 'answering'} onClick={handleWrong}>不正解</Button>
    </div>
  )

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
          {!connected && <p role="status">接続が切れました。再接続を待っています</p>}
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
            <Button disabled={busy || !musicKitReady || musicKitAuth.authorized} onClick={handleLogin}>ログイン</Button>
            <Button variant="ghost" disabled={busy || !musicKitAuth.authorized} onClick={() => run(musicKitAuth.unauthorize)}>ログアウト</Button>
          </div>
        </Glass>

        <Glass className="rounded-2xl p-6 min-w-0">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">2. 準備</h2>
          <div className="flex items-center justify-between gap-3 text-cream font-bold mt-4 mb-3">
            <span>ライブラリプレイリスト</span>
            <Button variant="ghostSmall" disabled={busy || loadingLibraryPlaylists} onClick={invalidateLibraryPlaylists}>{loadingLibraryPlaylists ? '読み込み中' : '再読み込み'}</Button>
          </div>
          {musicKitAuth.authorized ? (
            <LibraryPlaylistsSection
              busy={busy}
              expandedPlaylistIds={expandedPlaylistIds}
              selectedPlaylistIdSet={selectedPlaylistIdSet}
              onSelect={togglePlaylistSelected}
              onToggleExpanded={togglePlaylistExpanded}
            />
          ) : (
            <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
              <li className="text-muted">ログイン後にライブラリのプレイリストを取得します</li>
            </ul>
          )}
          {selectedPlaylistIds.length > 0 && (
            <p className="mt-3 mb-0 text-subtle leading-relaxed">
              {selectedPlaylistIds.length}件のプレイリスト、{state.tracks.length}曲を選択中
            </p>
          )}
          <div className="flex flex-wrap gap-2.5 mt-3.5 max-md:[&>button]:flex-1">
            <Button disabled={busy || state.phase !== 'ready' || selectedPlaylistIds.length === 0 || state.tracks.length === 0} onClick={() => handleStart('intro')}>イントロで開始</Button>
            <Button disabled={busy || state.phase !== 'ready' || selectedPlaylistIds.length === 0 || state.tracks.length === 0} onClick={() => handleStart('jacket')}>ジャケットで開始</Button>
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
          {progressControls}
          <div className="grid gap-3.5 mt-4">
            {primaryProgressButtons}
            <div className="grid gap-2.5 grid-cols-1 pt-3.5 border-t border-white/10 [&>button]:min-h-14">
              <Button disabled={busy || !canGoNextRound} onClick={handleNextRound}>次のラウンドへ</Button>
              <Button disabled={busy || state.step !== 'reveal'} onClick={handleShowResults}>結果発表へ</Button>
              <Button disabled={busy || state.step !== 'results'} onClick={handleNextGame}>次のゲームへ</Button>
            </div>
          </div>
        </Glass>

        <Glass as="section" className="rounded-2xl p-6 min-w-0" aria-label={isJacket ? 'アルバム情報' : '曲情報'}>
          <RoundInfoDisclosure
            expanded={trackInfoExpanded}
            onToggle={handleToggleTrackInfo}
            item={roundInfo}
            kind={isJacket ? 'album' : 'track'}
          />
        </Glass>

        <Glass as="section" className="rounded-2xl p-6 min-w-0" aria-label="回答">
          <h2 className="m-0 mb-2.5 text-2xl font-bold">回答</h2>
          <AnswerCard
            key={`${roundPreparationKey}:${state.step === 'answering' ? state.answererId : 'inactive'}`}
            candidates={answerCandidates}
            disabled={state.step !== 'answering'}
            placeholder={isJacket ? 'アルバム名を入力' : '曲名を入力'}
            onAnswer={handleAnswer}
          />
        </Glass>
        </div>
      </section>
    </main>
  )
}

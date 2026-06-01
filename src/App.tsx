import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useMusicKitPlayback } from './useMusicKit'
import './App.css'

type Phase = 'initialization' | 'ready' | 'game'
type GameStep =
  | 'idle'
  | 'loading'
  | 'beforePlayback'
  | 'playing'
  | 'answering'
  | 'judging'
  | 'correct'
  | 'wrong'
  | 'reveal'
  | 'results'

type Player = {
  id: string
  joined: boolean
  lastActionAt: number | null
  score: number
}

type Track = {
  id: string
  title: string
  artist: string
  playlist: string
  artworkUrl?: string
}

type GameState = {
  phase: Phase
  step: GameStep
  hostLoggedIn: boolean
  playlists: string[]
  selectedPlaylistId: string | null
  players: Player[]
  tracks: Track[]
  gameTrackOrder: number[]
  currentGameTrackOrderIndex: number
  currentTrackIndex: number
  currentTrack: Track | null
  hasPlayedCurrentTrack: boolean
  playbackSeconds: number
  answererId: string | null
  lastResult: 'correct' | 'wrong' | null
  message: string
  updatedAt: number
}

type ActionVisualState = 'idle' | 'pressed' | 'muted' | 'error'

const initialState: GameState = {
  phase: 'initialization',
  step: 'idle',
  hostLoggedIn: false,
  playlists: [],
  selectedPlaylistId: null,
  players: [],
  tracks: [],
  gameTrackOrder: [],
  currentGameTrackOrderIndex: -1,
  currentTrackIndex: -1,
  currentTrack: null,
  hasPlayedCurrentTrack: false,
  playbackSeconds: 3,
  answererId: null,
  lastResult: null,
  message: '接続中...',
  updatedAt: Date.now(),
}

const socket: Socket = io()

function useGameState() {
  const [state, setState] = useState<GameState>(initialState)

  useEffect(() => {
    socket.on('state', setState)
    return () => {
      socket.off('state', setState)
    }
  }, [])

  return state
}

function consoleAction<T = GameState>(event: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, response?: { ok: boolean; state?: T; error?: string }) => {
      if (error) {
        reject(error)
        return
      }
      if (response?.ok && response.state) resolve(response.state)
      else reject(new Error(response?.error ?? 'Socket.IO console action failed'))
    }
    if (body === undefined) socket.timeout(5000).emit(event, callback)
    else socket.timeout(5000).emit(event, body, callback)
  })
}



function loadSessionValue<T>(key: string, fallback: T): T {
  try {
    const stored = sessionStorage.getItem(key)
    return stored == null ? fallback : JSON.parse(stored) as T
  } catch {
    return fallback
  }
}

function saveSessionValue(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // sessionStorage can be unavailable in strict privacy modes.
  }
}

function loadSessionString(key: string) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function saveSessionString(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // sessionStorage can be unavailable in strict privacy modes.
  }
}

function hashString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i) | 0
  }
  return hash >>> 0
}

function playerColor(id: string) {
  const hue = hashString(id) % 360
  return {
    hue,
    background: `hsl(${hue} 76% 42%)`,
    softBackground: `hsl(${hue} 76% 42% / 0.18)`,
    border: `hsl(${hue} 76% 64% / 0.65)`,
    text: `hsl(${hue} 90% 92%)`,
  }
}

function PlayerBadge({ id, active = false, reacting = false, label = true, score }: { id: string; active?: boolean; reacting?: boolean; label?: boolean; score?: number }) {
  const color = playerColor(id)
  return (
    <span
      className={['player', active && 'active', reacting && 'reacting'].filter(Boolean).join(' ')}
      style={{
        '--player-color': color.background,
        '--player-color-soft': color.softBackground,
        '--player-color-border': color.border,
        '--player-color-text': color.text,
      } as CSSProperties}
      aria-label={label ? '参加者' : '参加者'}
    >
      {label ? <span className="player-color-dot" /> : (
        <span className="player-figure" aria-hidden="true">
          <span className="player-figure-head" />
          <span className="player-figure-body" />
        </span>
      )}
      {label && id}
      {score != null && <span className="player-score">{score}</span>}
    </span>
  )
}

function phaseLabel(phase: Phase, step: GameStep) {
  if (phase === 'initialization') return '初期化フェーズ'
  if (phase === 'ready') return '準備フェーズ'
  const labels: Record<GameStep, string> = {
    idle: '待機中',
    loading: '初期化ステップ',
    beforePlayback: '再生前ステップ',
    playing: '再生中ステップ',
    answering: '解答ステップ',
    judging: '正誤判定ステップ',
    correct: '正答ステップ',
    wrong: '誤答ステップ',
    reveal: '正解発表ステップ',
    results: '結果発表ステップ',
  }
  return labels[step]
}


function CircularSecondsSlider({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const min = 0.1
  const max = 30
  const step = 0.1
  const radius = 78
  const center = 96
  const circumference = 2 * Math.PI * radius
  const progress = (value - min) / (max - min)
  const dashOffset = circumference * (1 - progress)
  const angle = progress * 360 - 90
  const knobX = center + radius * Math.cos((angle * Math.PI) / 180)
  const knobY = center + radius * Math.sin((angle * Math.PI) / 180)

  const updateFromPoint = (clientX: number, clientY: number, target: Element) => {
    const rect = target.getBoundingClientRect()
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    let degrees = (Math.atan2(y, x) * 180) / Math.PI + 90
    if (degrees < 0) degrees += 360
    const raw = min + (degrees / 360) * (max - min)
    const stepped = Math.round(raw / step) * step
    onChange(Number(Math.min(max, Math.max(min, stepped)).toFixed(1)))
  }

  return (
    <div className="circular-slider-wrap">
      <svg
        className="circular-slider"
        viewBox="0 0 192 192"
        role="slider"
        aria-label="再生秒数"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          updateFromPoint(event.clientX, event.clientY, event.currentTarget)
        }}
        onPointerMove={(event) => {
          if (event.buttons !== 1) return
          updateFromPoint(event.clientX, event.clientY, event.currentTarget)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') onChange(Number(Math.min(max, value + step).toFixed(1)))
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') onChange(Number(Math.max(min, value - step).toFixed(1)))
        }}
      >
        <circle className="circular-slider-track" cx={center} cy={center} r={radius} />
        <circle
          className="circular-slider-progress"
          cx={center}
          cy={center}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        <circle className="circular-slider-knob" cx={knobX} cy={knobY} r="15" />
        <text className="circular-slider-value" x={center} y={center - 4} textAnchor="middle">{value.toFixed(1)}</text>
        <text className="circular-slider-unit" x={center} y={center + 22} textAnchor="middle">秒</text>
      </svg>
    </div>
  )
}

function ConsolePage() {
  const state = useGameState()
  const musicKit = useMusicKitPlayback()
  const [libraryPlaylists, setLibraryPlaylists] = useState<{ id: string; name: string }[]>([])
  const [playlistSearch, setPlaylistSearch] = useState(() => loadSessionValue('intro-buzz-console-playlist-search', ''))
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set(loadSessionValue<string[]>('intro-buzz-console-expanded-playlist-ids', [])))
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, Track[]>>({})
  const [loadingPlaylistIds, setLoadingPlaylistIds] = useState<Set<string>>(() => new Set())
  const [playlistErrors, setPlaylistErrors] = useState<Record<string, string>>({})
  const [seconds, setSeconds] = useState(() => loadSessionValue('intro-buzz-console-seconds', 0.5))
  const [busy, setBusy] = useState(false)
  const [loadingLibraryPlaylists, setLoadingLibraryPlaylists] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)
  const preparedQueueKeyRef = useRef<string | null>(null)
  const autoLoadLibraryPlaylistsRequestedRef = useRef(false)
  const wasRevealStepRef = useRef(false)
  const getLibraryPlaylists = musicKit.getLibraryPlaylists
  const prepareQueue = musicKit.prepareQueue

  const joinedPlayers = useMemo(() => state.players.filter((player) => player.joined), [state.players])
  const selectedPlaylistId = state.selectedPlaylistId ?? ''

  useEffect(() => saveSessionValue('intro-buzz-console-playlist-search', playlistSearch), [playlistSearch])
  useEffect(() => saveSessionValue('intro-buzz-console-expanded-playlist-ids', [...expandedPlaylistIds]), [expandedPlaylistIds])
  useEffect(() => saveSessionValue('intro-buzz-console-seconds', seconds), [seconds])

  useEffect(() => {
    if (!musicKit.ready || !musicKit.authorized || state.hostLoggedIn) return
    void consoleAction('console:login').catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [musicKit.ready, musicKit.authorized, state.hostLoggedIn])

  useEffect(() => {
    if (state.step !== 'answering' || !musicKit.playing) return
    void musicKit.stop().catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [state.step, musicKit])

  useEffect(() => {
    if (state.step !== 'reveal' || state.currentTrackIndex < 0) {
      if (!wasRevealStepRef.current) return
      wasRevealStepRef.current = false
      void musicKit.stop().catch((error) => {
        setConsoleMessage(error instanceof Error ? error.message : String(error))
      })
      return
    }

    wasRevealStepRef.current = true
    void musicKit.playFullLoopTrack(state.currentTrackIndex).catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [musicKit, state.currentTrackIndex, state.step])

  const visiblePlaylists = useMemo(() => {
    const query = playlistSearch.trim().toLowerCase()
    if (!query) return libraryPlaylists
    return libraryPlaylists.filter((playlist) => playlist.name.toLowerCase().includes(query))
  }, [libraryPlaylists, playlistSearch])

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

  const loadLibraryPlaylists = useCallback(async (): Promise<{ id: string; name: string }[]> => {
    setLoadingLibraryPlaylists(true)
    try {
      const playlists = await getLibraryPlaylists() as { id: string; name: string }[]
      setLibraryPlaylists(playlists)
      return playlists
    } finally {
      setLoadingLibraryPlaylists(false)
    }
  }, [getLibraryPlaylists])

  useEffect(() => {
    if (!musicKit.authorized) autoLoadLibraryPlaylistsRequestedRef.current = false
    if (
      !musicKit.ready ||
      !musicKit.authorized ||
      loadingLibraryPlaylists ||
      libraryPlaylists.length > 0 ||
      autoLoadLibraryPlaylistsRequestedRef.current
    ) return
    autoLoadLibraryPlaylistsRequestedRef.current = true
    void loadLibraryPlaylists().catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [libraryPlaylists.length, loadLibraryPlaylists, loadingLibraryPlaylists, musicKit.authorized, musicKit.ready])

  useEffect(() => {
    if (!musicKit.ready || !musicKit.authorized || !state.selectedPlaylistId || state.tracks.length === 0) return
    const queueKey = `${state.selectedPlaylistId}:${state.tracks.map((track) => track.id).join('|')}`
    if (preparedQueueKeyRef.current === queueKey) return
    preparedQueueKeyRef.current = queueKey
    void prepareQueue(state.tracks).catch((error) => {
      preparedQueueKeyRef.current = null
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [musicKit.authorized, musicKit.ready, prepareQueue, state.selectedPlaylistId, state.tracks])

  const handleLogin = () => run(async () => {
    await musicKit.authorize()
    await consoleAction('console:login')
    const playlists = await loadLibraryPlaylists()
    setConsoleMessage(`Apple Musicにログインしました。${playlists.length}件のライブラリプレイリストを取得しました`)
  })

  const fetchPlaylistTracks = async (playlist: { id: string; name: string }) => {
    if (playlistTracks[playlist.id]) return playlistTracks[playlist.id]
    setLoadingPlaylistIds((current) => new Set(current).add(playlist.id))
    setPlaylistErrors((current) => {
      const next = { ...current }
      delete next[playlist.id]
      return next
    })
    try {
      const tracks = await musicKit.getPlaylistTracks(playlist.id, playlist.name, 'library') as Track[]
      setPlaylistTracks((current) => ({ ...current, [playlist.id]: tracks }))
      return tracks
    } catch (error) {
      setPlaylistErrors((current) => ({ ...current, [playlist.id]: error instanceof Error ? error.message : String(error) }))
      throw error
    } finally {
      setLoadingPlaylistIds((current) => {
        const next = new Set(current)
        next.delete(playlist.id)
        return next
      })
    }
  }

  const selectPlaylist = (playlist: { id: string; name: string }) => run(async () => {
    const tracks = await fetchPlaylistTracks(playlist)
    await prepareQueue(tracks)
    preparedQueueKeyRef.current = `${playlist.id}:${tracks.map((track) => track.id).join('|')}`
    await consoleAction('console:playlists', { selectedPlaylistId: playlist.id, playlists: [playlist.name], tracks })
    setConsoleMessage(`${playlist.name}: ${tracks.length}曲をMusicKitキューへ読み込みました`)
  })

  const togglePlaylistExpanded = (playlist: { id: string; name: string }) => run(async () => {
    const willExpand = !expandedPlaylistIds.has(playlist.id)
    setExpandedPlaylistIds((current) => {
      const next = new Set(current)
      if (next.has(playlist.id)) next.delete(playlist.id)
      else next.add(playlist.id)
      return next
    })
    if (willExpand) await fetchPlaylistTracks(playlist)
  })

  const handleStart = () => run(async () => {
    const nextState = await consoleAction('console:start')
    if (nextState.currentTrackIndex >= 0) await musicKit.loadTrack(nextState.currentTrackIndex)
  })

  const handlePlay = async () => {
    setBusy(true)
    setConsoleMessage(null)
    try {
      await consoleAction('console:play', { seconds })
    } catch (error) {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
      setBusy(false)
      return
    }

    setBusy(false)
    try {
      await musicKit.playIntro(seconds)
    } catch (error) {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const handleJudge = (result: 'correct' | 'wrong') => run(async () => {
    await musicKit.stop()
    await consoleAction('console:judge', { result })
  })

  const handleGiveUp = () => run(async () => {
    await musicKit.stop()
    await consoleAction('console:give-up')
  })

  const handleNextRound = () => run(async () => {
    await musicKit.stop()
    const nextState = await consoleAction('console:next-round')
    if (nextState.currentTrackIndex >= 0) await musicKit.loadTrack(nextState.currentTrackIndex)
  })

  const handleShowResults = () => run(async () => {
    await musicKit.stop()
    await consoleAction('console:show-results')
  })

  const handleNextGame = () => run(async () => {
    await musicKit.stop()
    await consoleAction('console:next-game')
  })

  return (
    <main className="shell console">
      <header className="topbar">
        <div>
          <p className="eyebrow">Host Console</p>
          <h1>早押しイントロクイズ</h1>
        </div>
      </header>

      <section className="status-card">
        <div>
          <p className="eyebrow">現在</p>
          <h2>{phaseLabel(state.phase, state.step)}</h2>
          <p>{state.message}</p>
          {consoleMessage && <p className="hint">{consoleMessage}</p>}
          {musicKit.error && <p className="error">MusicKit: {musicKit.error}</p>}
        </div>
        <button className="danger" onClick={() => consoleAction('console:reset')}>リセット</button>
      </section>

      <section className="grid console-flow">
        <div className="console-flow-column">
        <div className="panel console-panel-init">
          <h2>1. 初期化</h2>
          <p>Apple Musicにログインして、MusicKitで実際に再生できる状態にします。</p>
          <div className={musicKit.ready ? (musicKit.authorized ? 'login-status signed-in' : 'login-status signed-out') : 'login-status loading'}>
            <span className="status-dot" />
            <div>
              <strong>{musicKit.ready ? (musicKit.authorized ? 'Apple Music ログイン済み' : 'Apple Music 未ログイン') : 'MusicKit 準備中'}</strong>
              <p>{musicKit.ready ? (musicKit.authorized ? 'ライブラリのプレイリストを選択できます' : 'ログインするとライブラリのプレイリストを取得できます') : 'MusicKit JS を初期化しています'}</p>
            </div>
          </div>
          <div className="actions">
            <button disabled={busy || !musicKit.ready || musicKit.authorized} onClick={handleLogin}>Apple Musicにログイン</button>
            <button className="ghost" disabled={busy || !musicKit.authorized} onClick={() => run(musicKit.unauthorize)}>ログアウト</button>
          </div>
        </div>

        <div className="panel console-panel-setup">
          <h2>2. 準備</h2>
          <div className="field-head">
            <span>ライブラリプレイリスト</span>
            <button className="ghost small" disabled={busy || loadingLibraryPlaylists || !musicKit.authorized} onClick={() => run(async () => { await loadLibraryPlaylists() })}>{loadingLibraryPlaylists ? '読み込み中' : '再読み込み'}</button>
          </div>
          <input
            type="search"
            placeholder="プレイリスト名で検索"
            value={playlistSearch}
            onChange={(event) => setPlaylistSearch(event.target.value)}
            disabled={busy || !musicKit.authorized || libraryPlaylists.length === 0}
          />
          <ul className="playlist-list">
            {visiblePlaylists.length ? visiblePlaylists.map((playlist) => {
              const selected = playlist.id === selectedPlaylistId
              const expanded = expandedPlaylistIds.has(playlist.id)
              const loading = loadingPlaylistIds.has(playlist.id)
              const error = playlistErrors[playlist.id]
              const tracks = playlistTracks[playlist.id]
              return (
                <li className="playlist-item" key={playlist.id}>
                  <div className={selected ? 'playlist-row selected' : 'playlist-row'}>
                    <button
                      type="button"
                      className="playlist-select"
                      disabled={busy || !musicKit.authorized}
                      onClick={() => selectPlaylist(playlist)}
                      aria-pressed={selected}
                    >
                      <span className="playlist-check">{selected ? '✓' : ''}</span>
                      <span className="playlist-name">{playlist.name}</span>
                    </button>
                    <button
                      type="button"
                      className={expanded ? 'playlist-expand expanded' : 'playlist-expand'}
                      disabled={busy || !musicKit.authorized}
                      onClick={() => togglePlaylistExpanded(playlist)}
                      aria-label={expanded ? 'プレイリストを閉じる' : 'プレイリストを開く'}
                    >
                      <span className="expand-icon" />
                    </button>
                  </div>
                  {expanded && (
                    <div className="playlist-songs">
                      {loading && <p className="hint">曲を読み込み中...</p>}
                      {!loading && error && <p className="error">{error}</p>}
                      {!loading && !error && tracks?.length === 0 && <p className="hint">曲がありません</p>}
                      {!loading && !error && tracks && tracks.length > 0 && (
                        <ul className="song-list">
                          {tracks.map((track, index) => (
                            <li className="song-row" key={`${track.id}-${index}`}>
                              <span className="song-index">{index + 1}</span>
                              {track.artworkUrl && <img className="song-artwork" src={track.artworkUrl} alt="" />}
                              <span className="song-meta">
                                <span className="song-title">{track.title}</span>
                                <span className="song-artist">{track.artist}</span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              )
            }) : <li className="hint">{loadingLibraryPlaylists ? 'ライブラリのプレイリストを読み込み中...' : libraryPlaylists.length ? '一致するプレイリストがありません' : 'ログイン後にライブラリのプレイリストを取得します'}</li>}
          </ul>
          <div className="actions">
            <button disabled={busy || state.phase !== 'ready' || !selectedPlaylistId || musicKit.preparing} onClick={handleStart}>ゲーム開始</button>
          </div>
          <div className="joined-player-list">
            <span className="hint">参加中:</span>
            {joinedPlayers.length ? joinedPlayers.map((player) => (
              <PlayerBadge id={player.id} label={false} key={player.id} />
            )) : <span className="hint">まだいません</span>}
          </div>
        </div>

        </div>

        <div className="console-flow-column">

        <div className="panel console-panel-control">
          <h2>3. 進行</h2>
          <div className="seconds-control">
            <span className="seconds-label">再生秒数</span>
            <CircularSecondsSlider value={seconds} onChange={setSeconds} />
          </div>
          <div className="console-action-stack">
            <div className="console-action-grid two-columns">
              <button disabled={busy || state.step !== 'beforePlayback'} onClick={handlePlay}>{musicKit.playing ? '再生中' : '再生'}</button>
              <button className="ghost" disabled={busy || state.phase !== 'game' || !['beforePlayback', 'playing', 'answering', 'wrong'].includes(state.step)} onClick={handleGiveUp}>ギブアップ</button>
              <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('correct')}>正解</button>
              <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('wrong')}>不正解</button>
            </div>
            <div className="console-action-grid flow-actions">
              <button disabled={busy || state.step !== 'reveal'} onClick={handleNextRound}>次のラウンドへ</button>
              <button disabled={busy || state.step !== 'reveal'} onClick={handleShowResults}>結果発表へ</button>
              <button disabled={busy || state.step !== 'results'} onClick={handleNextGame}>次のゲームへ</button>
            </div>
          </div>
        </div>

        <div className="panel console-panel-track">
          <h2>曲情報</h2>
          {state.currentTrack ? (
            <div className="track-card small">
              <p>{state.currentTrack.playlist}</p>
              <strong>{state.currentTrack.title}</strong>
              <span>{state.currentTrack.artist}</span>
            </div>
          ) : <p>まだ曲はロードされていません。</p>}
        </div>
        </div>
      </section>
    </main>
  )
}


function playGameboardSound(kind: 'correct' | 'wrong') {
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const audioContext = new AudioContextCtor()
  const start = audioContext.currentTime
  const master = audioContext.createGain()
  master.gain.setValueAtTime(0.7, start)
  master.connect(audioContext.destination)

  const playTone = (frequency: number, offset: number, duration: number, type: OscillatorType = 'sine') => {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const toneStart = start + offset
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, toneStart)
    gain.gain.setValueAtTime(0.001, toneStart)
    gain.gain.exponentialRampToValueAtTime(0.9, toneStart + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(toneStart)
    oscillator.stop(toneStart + duration + 0.03)
  }

  if (kind === 'correct') {
    playTone(880, 0, 0.18)
    playTone(1174.66, 0.14, 0.18)
    playTone(880, 0.36, 0.18)
    playTone(1174.66, 0.5, 0.48)
  } else {
    playTone(160, 0, 0.62, 'sawtooth')
    playTone(110, 0.08, 0.54, 'sawtooth')
  }

  window.setTimeout(() => void audioContext.close(), 1300)
}

function GameboardPlayers({ players, answererId, isReacting }: {
  players: Player[]
  answererId: string | null
  isReacting: (player: Player) => boolean
}) {
  if (players.length === 0) return null
  return (
    <div className="players">
      <div className="player-list">
        {players.map((player) => (
          <PlayerBadge
            id={player.id}
            active={player.id === answererId}
            reacting={isReacting(player)}
            label={false}
            score={player.score}
            key={player.id}
          />
        ))}
      </div>
    </div>
  )
}

function useViewportSize() {
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }))

  useEffect(() => {
    const update = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return viewportSize
}

function TrackArtwork({ track }: { track: Track }) {
  return track.artworkUrl
    ? <img className="gameboard-track-artwork" src={track.artworkUrl} alt="" loading="lazy" />
    : <span className="gameboard-track-artwork placeholder" aria-hidden="true">♪</span>
}

function estimateTrackChipWidth(track: Track) {
  const textWidth = [...track.title].reduce((width, character) => {
    const codePoint = character.codePointAt(0) ?? 0
    const isWide = codePoint > 0x3000 || (codePoint >= 0xff00 && codePoint <= 0xffef)
    const isNarrow = /[\s!.,:;|]/u.test(character)
    if (isWide) return width + 24
    if (isNarrow) return width + 8
    return width + 18
  }, 0)
  const artworkWidth = 36
  const contentGap = 10
  const horizontalPadding = 22
  return Math.max(170, Math.ceil(artworkWidth + contentGap + horizontalPadding + textWidth))
}

function findTrackIndexAtOffset(prefixWidths: number[], offset: number) {
  let low = 0
  let high = prefixWidths.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (prefixWidths[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

function TrackLane({ tracks, laneIndex, direction }: {
  tracks: Track[]
  laneIndex: number
  direction: 'left' | 'right'
}) {
  const laneRef = useRef<HTMLDivElement>(null)
  const [laneWidth, setLaneWidth] = useState(0)
  const [offset, setOffset] = useState(0)
  const chipGap = 12
  const speed = 34 + (laneIndex % 3) * 7
  const chipWidths = useMemo(() => tracks.map(estimateTrackChipWidth), [tracks])
  const prefixWidths = useMemo(() => {
    const widths = [0]
    chipWidths.forEach((width) => widths.push(widths[widths.length - 1] + width + chipGap))
    return widths
  }, [chipWidths])
  const cycleWidth = Math.max(1, prefixWidths[prefixWidths.length - 1] ?? 1)

  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return undefined
    const update = () => setLaneWidth(lane.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(lane)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let frameId = 0
    let startTime: number | null = null
    const tick = (time: number) => {
      startTime ??= time
      setOffset(((time - startTime) / 1000 * speed) % cycleWidth)
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [cycleWidth, speed])

  const logicalOffset = direction === 'left' ? offset : (cycleWidth - offset) % cycleWidth
  const startIndex = findTrackIndexAtOffset(prefixWidths, logicalOffset)
  const visibleItems: { track: Track; x: number; virtualIndex: number; width: number }[] = []
  let cursor = prefixWidths[startIndex] - logicalOffset
  let index = startIndex
  while (visibleItems.length < tracks.length + 1 && cursor < laneWidth + chipGap) {
    const trackIndex = index % tracks.length
    const width = chipWidths[trackIndex]
    visibleItems.push({ track: tracks[trackIndex], x: cursor, virtualIndex: index, width })
    cursor += width + chipGap
    index += 1
  }

  return (
    <div className={`track-lane ${direction}`} ref={laneRef}>
      <div className="track-lane-viewport">
        {visibleItems.map(({ track, x, virtualIndex, width }) => (
          <div
            className="gameboard-track-chip"
            data-index={virtualIndex}
            style={{ transform: `translate3d(${x}px, 0, 0)`, width: `${width}px` }}
            key={`${virtualIndex}-${track.id}`}
          >
            <TrackArtwork track={track} />
            <span className="gameboard-track-title">{track.title}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ReadyTrackLanes({ tracks }: { tracks: Track[] }) {
  const viewportSize = useViewportSize()
  const laneHeight = 74
  const reservedHeight = 300
  const laneCount = Math.max(1, Math.floor((viewportSize.height - reservedHeight) / laneHeight))
  const tracksPerLane = Math.ceil(tracks.length / laneCount)
  const lanes = Array.from({ length: laneCount }, (_, index) => {
    const start = index * tracksPerLane
    return tracks.slice(start, start + tracksPerLane)
  }).filter((lane) => lane.length > 0)

  return (
    <div className="ready-track-lanes" aria-label="選択中の曲">
      <div className="track-lanes" style={{ '--lane-count': lanes.length } as CSSProperties}>
        {lanes.map((laneTracks, index) => (
          <TrackLane
            tracks={laneTracks}
            laneIndex={index}
            direction={index % 2 === 0 ? 'right' : 'left'}
            key={index}
          />
        ))}
      </div>
    </div>
  )
}

function GameboardPage() {
  const state = useGameState()
  const [now, setNow] = useState(() => Date.now())
  const joinedPlayers = state.players.filter((player) => player.joined)
  const previousStepRef = useRef<GameStep>(state.step)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120)
    return () => window.clearInterval(timer)
  }, [])

  const isReacting = (player: Player) => player.lastActionAt != null && now - player.lastActionAt < 800
  const showReadyTracks = state.phase === 'ready' && state.tracks.length > 0
  const sortedPlayers = [...joinedPlayers].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const players = <GameboardPlayers players={joinedPlayers} answererId={state.answererId} isReacting={isReacting} />

  useEffect(() => {
    if (previousStepRef.current !== state.step) {
      if (state.step === 'correct') playGameboardSound('correct')
      if (state.step === 'wrong') playGameboardSound('wrong')
      previousStepRef.current = state.step
    }
  }, [state.step])

  let content: ReactNode
  let cardClassName = 'board-card gameboard-card'

  if (state.phase === 'initialization') {
    content = <h1 className="gameboard-title">ボタンを押してご参加ください</h1>
  } else if (state.phase === 'ready') {
    cardClassName = showReadyTracks ? 'board-card gameboard-card ready-board' : 'board-card gameboard-card'
    content = (
      <>
        <h1 className="gameboard-title ready-title">ボタンを押してご参加ください</h1>
        {showReadyTracks && <ReadyTrackLanes tracks={state.tracks} />}
        {players}
      </>
    )
  } else if (state.step === 'loading') {
    content = <h1 className="gameboard-title">曲を準備中</h1>
  } else if (state.step === 'beforePlayback') {
    content = (
      <>
        <div className="gameboard-symbol waiting-symbol">♪</div>
        {players}
      </>
    )
  } else if (state.step === 'playing') {
    content = (
      <>
        <div className="gameboard-symbol playing-symbol">♪</div>
        {players}
      </>
    )
  } else if (state.step === 'answering') {
    content = (
      <>
        <h1 className="gameboard-title">解答をどうぞ！</h1>
        {state.answererId && (
          <div
            className="answerer colored"
            style={{ '--player-color': playerColor(state.answererId).background } as CSSProperties}
            title={state.answererId}
            aria-label={state.answererId}
          />
        )}
        {players}
      </>
    )
  } else if (state.step === 'correct') {
    content = (
      <>
        <div className="effect success">○</div>
        {players}
      </>
    )
  } else if (state.step === 'wrong') {
    content = (
      <>
        <div className="effect miss">×</div>
        {players}
      </>
    )
  } else if (state.step === 'reveal' && state.currentTrack) {
    content = (
      <div className="track-card reveal">
        <TrackArtwork track={state.currentTrack} />
        <strong>{state.currentTrack.title}</strong>
        <span>{state.currentTrack.artist}</span>
      </div>
    )
  } else if (state.step === 'results') {
    content = (
      <div className="results-board">
        {sortedPlayers.map((player) => (
          <div className="result-player" key={player.id}>
            <PlayerBadge id={player.id} label={false} />
            <strong>{player.score}</strong>
          </div>
        ))}
      </div>
    )
  } else {
    content = <h1 className="gameboard-title">待機中</h1>
  }

  return (
    <main className={`gameboard ${state.step} ${state.lastResult ?? ''}`}>
      <section className={cardClassName}>
        {content}
      </section>
    </main>
  )
}

function HomePage() {
  return (
    <main className="shell home">
      <h1>早押しイントロクイズ</h1>
      <p>PCでサーバーを起動し、スマホはホスト操作、スクリーンはゲームボード、物理ボタンはAPIにアクセスします。</p>
      <div className="actions">
        <a className="button" href="/console">/console</a>
        <a className="button" href="/gameboard">/gameboard</a>
        <a className="button ghost" href="/action">/action</a>
      </div>
    </main>
  )
}

function getActionActorId() {
  const storageKey = 'intro-buzz-action-actor-id'
  const stored = loadSessionString(storageKey)
  if (stored) return stored
  const id = crypto.randomUUID()
  saveSessionString(storageKey, id)
  return id
}

function ActionPage() {
  const [actorId] = useState(getActionActorId)
  const [busy, setBusy] = useState(false)
  const [visualState, setVisualState] = useState<ActionVisualState>('idle')
  const audioContextRef = useRef<AudioContext | null>(null)
  const color = playerColor(actorId)

  const resetSoon = () => {
    window.setTimeout(() => {
      setVisualState('idle')
    }, 760)
  }

  const playPingPong = async () => {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return
    audioContextRef.current ??= new AudioContextCtor()
    const audioContext = audioContextRef.current
    if (audioContext.state === 'suspended') await audioContext.resume()

    const now = audioContext.currentTime
    const master = audioContext.createGain()
    master.gain.setValueAtTime(1, now)
    master.connect(audioContext.destination)

    const playTone = (frequency: number, start: number, duration: number) => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, start)
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.exponentialRampToValueAtTime(1, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.03)
    }

    playTone(987.77, now, 0.18)
    playTone(1318.51, now + 0.28, 0.62)
  }

  const act = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/act/' + encodeURIComponent(actorId), { method: 'POST' })
      if (res.status === 200) {
        await playPingPong()
        setVisualState('pressed')
        resetSoon()
      } else if (res.status === 204) {
        setVisualState('muted')
        resetSoon()
      } else if (res.status === 409) {
        setVisualState('muted')
        resetSoon()
      } else if (res.status === 429) {
        setVisualState('muted')
        resetSoon()
      } else {
        setVisualState('error')
      }
    } catch {
      setVisualState('error')
    } finally {
      window.setTimeout(() => setBusy(false), 180)
    }
  }

  return (
    <main
      className="action-page"
      style={{
        '--player-color': color.background,
        '--player-color-text': color.text,
        '--player-color-soft': color.softBackground,
        '--player-color-glow': `hsl(${color.hue} 76% 52% / 0.46)`,
      } as CSSProperties}
    >
      <button className={`action-button ${visualState}`} type="button" disabled={busy} onClick={act} aria-label="早押しボタン">
        <span className="action-circle" aria-hidden="true" />
      </button>
    </main>
  )
}

export default function App() {
  const path = window.location.pathname
  if (path === '/console') return <ConsolePage />
  if (path === '/gameboard') return <GameboardPage />
  if (path === '/action') return <ActionPage />
  return <HomePage />
}

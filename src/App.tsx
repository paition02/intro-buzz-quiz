import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
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
  playbackSeconds: 0.5,
  answererId: null,
  lastResult: null,
  message: '接続中...',
  updatedAt: Date.now(),
}

// サーバが唯一の真実(single source of truth)。ここが肝心なんだ!
// socket と 'state' リスナーはモジュール読込時に"同期で"張る。io() の直後に on('state') を
// 張るから、接続ハンドシェイク完了(=最初の state 到着)より必ず先にリスナーが居る。
// 旧実装は useEffect(初回レンダー後)で張っていたので、接続がレンダーを追い越すと
// 初回 state を取りこぼし、gameboard が固まることがあった。それを構造ごと潰す。
const socket: Socket = io()

// 外部ストア(socket)を React に橋渡しする。useSyncExternalStore は getSnapshot を毎レンダーで
// 読むので、購読登録とレンダーの隙間に届いた分も取りこぼさない(初回 race を構造で潰す要)。
let latestState: GameState = initialState
let connected = socket.connected
const stateListeners = new Set<() => void>()
const connectedListeners = new Set<() => void>()

socket.on('state', (state: GameState) => {
  latestState = state
  stateListeners.forEach((notify) => notify())
})

function setConnected(next: boolean) {
  if (connected === next) return
  connected = next
  connectedListeners.forEach((notify) => notify())
}

// 再接続は新規 connection としてサーバ側 connection ハンドラを再発火させ、
// 接続時 emit('state') が再送される(=自動で最新へ追いつく)。ここでは表示用に状態だけ持つ。
socket.on('connect', () => setConnected(true))
socket.on('disconnect', () => setConnected(false))

function subscribeState(notify: () => void) {
  stateListeners.add(notify)
  return () => { stateListeners.delete(notify) }
}

function subscribeConnected(notify: () => void) {
  connectedListeners.add(notify)
  return () => { connectedListeners.delete(notify) }
}

function useGameState() {
  return useSyncExternalStore(subscribeState, () => latestState)
}

function useConnected() {
  return useSyncExternalStore(subscribeConnected, () => connected)
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
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set())
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, Track[]>>({})
  const [loadingPlaylistIds, setLoadingPlaylistIds] = useState<Set<string>>(() => new Set())
  const [playlistErrors, setPlaylistErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [loadingLibraryPlaylists, setLoadingLibraryPlaylists] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)
  const preparedQueueKeyRef = useRef<string | null>(null)
  const autoLoadLibraryPlaylistsRequestedRef = useRef(false)
  const wasRevealStepRef = useRef(false)
  // MusicKit の再生は state を唯一の駆動源にする(命令的ハンドラからは触らない)。
  // 二重ロード防止用の「いま読んでいる曲 index」と、playing への遷移を 1 回だけ拾うための「直前 step」。
  const loadedTrackIndexRef = useRef(-1)
  const previousStepForPlaybackRef = useRef<GameStep>(state.step)
  const getLibraryPlaylists = musicKit.getLibraryPlaylists
  const prepareQueue = musicKit.prepareQueue
  const stopPlayback = musicKit.stop
  const playFullLoopTrack = musicKit.playFullLoopTrack
  const loadTrack = musicKit.loadTrack
  const playIntro = musicKit.playIntro

  const joinedPlayers = useMemo(() => state.players.filter((player) => player.joined), [state.players])
  const selectedPlaylistId = state.selectedPlaylistId ?? ''
  const seconds = state.playbackSeconds

  const visiblePlaylists = useMemo(() => {
    const query = playlistSearch.trim().toLowerCase()
    if (!query) return libraryPlaylists
    return libraryPlaylists.filter((playlist) => playlist.name.toLowerCase().includes(query))
  }, [libraryPlaylists, playlistSearch])

  useEffect(() => {
    if (!musicKit.ready || !musicKit.authorized || state.hostLoggedIn) return
    void consoleAction('console:login').catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [musicKit.ready, musicKit.authorized, state.hostLoggedIn])

  useEffect(() => {
    if (state.step === 'playing' || state.step === 'reveal') return
    void stopPlayback().catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [state.step, stopPlayback])

  useEffect(() => {
    if (state.step !== 'reveal' || state.currentTrackIndex < 0) {
      if (!wasRevealStepRef.current) return
      wasRevealStepRef.current = false
      void stopPlayback().catch((error) => {
        setConsoleMessage(error instanceof Error ? error.message : String(error))
      })
      return
    }

    wasRevealStepRef.current = true
    void playFullLoopTrack(state.currentTrackIndex).catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [playFullLoopTrack, state.currentTrackIndex, state.step, stopPlayback])

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
      const playlistIds = new Set(playlists.map((playlist) => playlist.id))
      setLibraryPlaylists(playlists)
      setExpandedPlaylistIds((current) => new Set([...current].filter((playlistId) => playlistIds.has(playlistId))))
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
    loadedTrackIndexRef.current = -1 // キューが入れ替わったらロード済み index も無効化
    void prepareQueue(state.tracks).catch((error) => {
      preparedQueueKeyRef.current = null
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [musicKit.authorized, musicKit.ready, prepareQueue, state.selectedPlaylistId, state.tracks])

  // 曲のロードは state.currentTrackIndex に追従する(旧 handleStart/handleNextRound の命令的ロードを置換)。
  // index が変わった時だけ読み直す。playing→beforePlayback の復帰みたいな step だけの変化では読み直さない。
  useEffect(() => {
    if (!musicKit.ready || !musicKit.authorized) return
    if (state.currentTrackIndex < 0) {
      loadedTrackIndexRef.current = -1
      return
    }
    if (loadedTrackIndexRef.current === state.currentTrackIndex) return
    loadedTrackIndexRef.current = state.currentTrackIndex
    void loadTrack(state.currentTrackIndex).catch((error) => {
      setConsoleMessage(error instanceof Error ? error.message : String(error))
    })
  }, [loadTrack, musicKit.authorized, musicKit.ready, state.currentTrackIndex])

  // イントロ再生は step が playing に"入った"瞬間に 1 回だけ。停止は下の step 監視 effect が担う。
  // step 遷移(playing→beforePlayback への復帰)はサーバ所有のまま、クライアントはそれに追従する。
  useEffect(() => {
    const previousStep = previousStepForPlaybackRef.current
    previousStepForPlaybackRef.current = state.step
    if (state.step === 'playing' && previousStep !== 'playing') {
      void playIntro(state.playbackSeconds).catch((error) => {
        setConsoleMessage(error instanceof Error ? error.message : String(error))
      })
    }
  }, [playIntro, state.playbackSeconds, state.step])

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
    loadedTrackIndexRef.current = -1
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

  // ここからのハンドラは"intent を送るだけ"。MusicKit の再生/停止/ロードは上の reconciler が
  // state を見て一手に引き受ける。命令的呼び出しと effect の二重駆動をここで断ち切る。
  const handleStart = () => run(async () => {
    await consoleAction('console:start')
  })

  const handlePlay = () => run(async () => {
    await consoleAction('console:play', { seconds })
  })

  const handleJudge = (result: 'correct' | 'wrong') => run(async () => {
    await consoleAction('console:judge', { result })
  })

  const handleGiveUp = () => run(async () => {
    await consoleAction('console:give-up')
  })

  const handleNextRound = () => run(async () => {
    await consoleAction('console:next-round')
  })

  const handleShowResults = () => run(async () => {
    await consoleAction('console:show-results')
  })

  const handleNextGame = () => run(async () => {
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
            <CircularSecondsSlider
              value={seconds}
              onChange={(value) => {
                void consoleAction('console:playback-seconds', { seconds: value }).catch((error) => {
                  setConsoleMessage(error instanceof Error ? error.message : String(error))
                })
              }}
            />
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

const TRACK_CHIP_FONT = '900 16px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

// canvas / 2d コンテキストは 1 個だけ生成して使い回す(計測ごとに作らない)。
// `undefined` = 未初期化、`null` = 取得失敗(以後 fallback)。
let trackChipMeasureContext: CanvasRenderingContext2D | null | undefined

// タイトル → 実測幅のキャッシュ。同じタイトルは二度測らない(幅はタイトルの純関数)。
const trackChipWidthCache = new Map<string, number>()

function measureTrackChipWidth(track: Track) {
  const cached = trackChipWidthCache.get(track.title)
  if (cached !== undefined) return cached

  const artworkWidth = 36
  const contentGap = 10
  const horizontalPadding = 22
  const fixedWidth = artworkWidth + contentGap + horizontalPadding
  const fallback = Math.max(170, fixedWidth + track.title.length * 18)

  if (typeof document === 'undefined') return fallback

  if (trackChipMeasureContext === undefined) {
    trackChipMeasureContext = document.createElement('canvas').getContext('2d')
    if (trackChipMeasureContext) trackChipMeasureContext.font = TRACK_CHIP_FONT
  }
  if (!trackChipMeasureContext) return fallback

  const textWidth = trackChipMeasureContext.measureText(track.title).width
  const width = Math.max(170, Math.ceil(fixedWidth + textWidth))
  trackChipWidthCache.set(track.title, width) // 測ったら保持
  return width
}

type TrackChipHandle = {
  root: HTMLDivElement | null
  artwork: HTMLImageElement | null
  placeholder: HTMLSpanElement | null
  title: HTMLSpanElement | null
}

function TrackLane({ tracks, laneIndex, direction }: {
  tracks: Track[]
  laneIndex: number
  direction: 'left' | 'right'
}) {
  const laneRef = useRef<HTMLDivElement>(null)
  const handlesRef = useRef<TrackChipHandle[]>([])
  const assignedRef = useRef<(string | null)[]>([])
  const [laneWidth, setLaneWidth] = useState(0)
  const chipGap = 12
  const speed = 34 + (laneIndex % 3) * 7

  // 親(GameboardPage)は 120ms 毎に再レンダリングし、その度に tracks は中身が同じでも
  // 新しい配列参照で渡ってくる。rAF からは「参照」ではなく「最新の中身」を ref 経由で読み、
  // アニメの useEffect は参照変化では再実行させない(再実行=startTime リセット=ワープ)。
  const tracksRef = useRef(tracks)
  useEffect(() => { tracksRef.current = tracks })

  // チップ幅はタイトルごとの実寸(伸縮)。均一じゃないので位置は累積和(prefix)で持つ。
  // prefix[k] = 先頭から k 個分のスロット幅合計。cycleWidth = 1 周分の総幅。
  const layout = useMemo(() => {
    const widths = tracks.map(measureTrackChipWidth)
    const slots = widths.map((width) => width + chipGap)
    const prefix = [0]
    for (const slot of slots) prefix.push(prefix[prefix.length - 1] + slot)
    const cycleWidth = Math.max(1, prefix[prefix.length - 1])
    const minSlot = slots.length > 0 ? Math.min(...slots) : 170 + chipGap
    return { widths, slots, prefix, cycleWidth, minSlot }
  }, [tracks])

  // rAF は layout の配列を ref 経由で読む(参照変化でアニメを再実行=ワープさせないため)。
  const layoutRef = useRef(layout)
  useEffect(() => { layoutRef.current = layout })

  // 仮想化は絶対。DOM ノード数は「レーンに見える分 + 前後バッファ」だけに固定し、曲数では増やさない。
  // 可変幅なので最狭スロット基準でプール数を決める(どんなに細いチップが並んでも足りる上限)。
  const poolSize = Math.max(2, Math.ceil(laneWidth / layout.minSlot) + 2)

  // 各プールスロットの DOM 参照をまとめて掴むためのヘルパ。callback ref から呼ぶ。
  const handleAt = (index: number) => {
    const handles = handlesRef.current
    handles[index] ??= { root: null, artwork: null, placeholder: null, title: null }
    return handles[index]
  }

  useEffect(() => {
    const lane = laneRef.current
    if (!lane) return undefined
    const update = () => setLaneWidth(lane.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(lane)
    return () => observer.disconnect()
  }, [])

  // ここが要点だ！1 つの rAF の中で「位置」「幅」「中身」を全部命令的に書く。
  // 位置は prefix を辿って累積、担当トラックが変わった時だけ幅と中身を貼り替える。
  // 同フレームで原子的に更新するから、可変幅で使い回し(recycle)してもズレ・隙間が出ない。
  useEffect(() => {
    assignedRef.current = [] // プール構成が変わったら割り当てキャッシュを捨てて中身を貼り直す
    let frameId = 0
    let startTime: number | null = null
    const tick = (time: number) => {
      startTime ??= time
      const { widths, slots, prefix, cycleWidth } = layoutRef.current
      const tracks = tracksRef.current // 参照は ref から。エフェクト再実行に依存しない
      const total = tracks.length
      if (total > 0) {
        const distance = (time - startTime) / 1000 * speed
        const wrapped = ((distance % cycleWidth) + cycleWidth) % cycleWidth
        const offset = direction === 'left' ? wrapped : (cycleWidth - wrapped) % cycleWidth

        // 左端に半分隠れたチップ = prefix[start] <= offset < prefix[start+1] を二分探索で求める。
        let lo = 0
        let hi = total - 1
        let start = 0
        while (lo <= hi) {
          const mid = (lo + hi) >> 1
          if (prefix[mid] <= offset) { start = mid; lo = mid + 1 } else { hi = mid - 1 }
        }

        const handles = handlesRef.current
        const assigned = assignedRef.current
        let x = prefix[start] - offset // 左端チップの座標(0 以下から始まる)
        for (let i = 0; i < poolSize; i += 1) {
          const trackIndex = (start + i) % total
          const handle = handles[i]
          if (handle?.root) {
            // 位置は毎フレーム。幅・中身は担当トラックが変わった時だけ(毎フレーム img を触らない)。
            handle.root.style.transform = `translate3d(${x}px, 0, 0)`
            const track = tracks[trackIndex]
            if (assigned[i] !== track.id) {
              assigned[i] = track.id
              handle.root.style.width = `${widths[trackIndex]}px` // タイトル実寸に伸縮
              if (handle.title) handle.title.textContent = track.title
              if (track.artworkUrl) {
                if (handle.artwork) {
                  handle.artwork.src = track.artworkUrl
                  handle.artwork.style.display = ''
                }
                if (handle.placeholder) handle.placeholder.style.display = 'none'
              } else {
                if (handle.artwork) {
                  handle.artwork.removeAttribute('src')
                  handle.artwork.style.display = 'none'
                }
                if (handle.placeholder) handle.placeholder.style.display = ''
              }
            }
          }
          x += slots[trackIndex] // 次のチップは自分の幅 + gap ぶん右へ
        }
      }
      frameId = window.requestAnimationFrame(tick)
    }
    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [layout.cycleWidth, direction, speed, poolSize])

  return (
    <div className={`track-lane ${direction}`} ref={laneRef}>
      <div className="track-lane-viewport">
        {Array.from({ length: poolSize }).map((_, i) => (
          // プールスロット。key は物理位置に固定し、中身は rAF が差し替える(remount させない)。
          <div
            className="gameboard-track-chip"
            key={i}
            ref={(el) => { handleAt(i).root = el }}
          >
            <img
              className="gameboard-track-artwork"
              alt=""
              loading="lazy"
              style={{ display: 'none' }}
              ref={(el) => { handleAt(i).artwork = el }}
            />
            <span
              className="gameboard-track-artwork placeholder"
              aria-hidden="true"
              ref={(el) => { handleAt(i).placeholder = el }}
            >♪</span>
            <span
              className="gameboard-track-title"
              ref={(el) => { handleAt(i).title = el }}
            />
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
  const connected = useConnected()
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
    content = <h1 className="gameboard-title ready-title">ボタンを押してご参加ください</h1>
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
    cardClassName = 'board-card gameboard-card with-players'
    content = (
      <>
        <div className="gameboard-stage"><div className="gameboard-symbol waiting-symbol">♪</div></div>
        {players}
      </>
    )
  } else if (state.step === 'playing') {
    cardClassName = 'board-card gameboard-card with-players'
    content = (
      <>
        <div className="gameboard-stage"><div className="gameboard-symbol playing-symbol glow-icon playing-glow">♪</div></div>
        {players}
      </>
    )
  } else if (state.step === 'answering') {
    cardClassName = 'board-card gameboard-card with-players'
    content = (
      <>
        <div className="gameboard-stage answering-stage">
        <h1 className="gameboard-title">解答をどうぞ！</h1>
        {state.answererId && (
          <div
            className="answerer colored"
            style={{ '--player-color': playerColor(state.answererId).background } as CSSProperties}
            title={state.answererId}
            aria-label={state.answererId}
          />
        )}
        </div>
        {players}
      </>
    )
  } else if (state.step === 'correct') {
    cardClassName = 'board-card gameboard-card with-players'
    content = (
      <>
        <div className="gameboard-stage"><div className="effect success glow-icon success-glow">○</div></div>
        {players}
      </>
    )
  } else if (state.step === 'wrong') {
    cardClassName = 'board-card gameboard-card with-players'
    content = (
      <>
        <div className="gameboard-stage"><div className="effect miss glow-icon miss-glow">×</div></div>
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
    <main className={`gameboard ${state.step}`}>
      {!connected && <div className="connection-indicator" role="status">再接続中…</div>}
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

// ここが要点だ！ルートごとに表示するタイトルを 1 か所にまとめておく。
const routeTitles: Record<string, string> = {
  '/console': 'ホストコンソール | 早押しイントロクイズ',
  '/gameboard': 'ゲームボード | 早押しイントロクイズ',
  '/action': '早押しボタン | 早押しイントロクイズ',
}
const defaultTitle = '早押しイントロクイズ'

export default function App() {
  const path = window.location.pathname

  // ルートに対応する document.title をセットする。SPA だから手で切り替えないと変わらないんだ。
  useEffect(() => {
    document.title = routeTitles[path] ?? defaultTitle
  }, [path])

  if (path === '/console') return <ConsolePage />
  if (path === '/gameboard') return <GameboardPage />
  if (path === '/action') return <ActionPage />
  return <HomePage />
}

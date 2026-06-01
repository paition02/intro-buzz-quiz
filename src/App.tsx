import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
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

type Player = {
  id: string
  joined: boolean
  lastActionAt: number | null
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
  players: Player[]
  tracks: Track[]
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
  players: [],
  tracks: [],
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

function PlayerBadge({ id, active = false, reacting = false, label = true }: { id: string; active?: boolean; reacting?: boolean; label?: boolean }) {
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
  const [selectedPlaylistId, setSelectedPlaylistId] = useState(() => loadSessionValue('intro-buzz-console-selected-playlist-id', ''))
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set(loadSessionValue<string[]>('intro-buzz-console-expanded-playlist-ids', [])))
  const [playlistTracks, setPlaylistTracks] = useState<Record<string, Track[]>>({})
  const [loadingPlaylistIds, setLoadingPlaylistIds] = useState<Set<string>>(() => new Set())
  const [playlistErrors, setPlaylistErrors] = useState<Record<string, string>>({})
  const [seconds, setSeconds] = useState(() => loadSessionValue('intro-buzz-console-seconds', 0.5))
  const [busy, setBusy] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)

  const joinedPlayers = useMemo(() => state.players.filter((player) => player.joined), [state.players])

  useEffect(() => saveSessionValue('intro-buzz-console-playlist-search', playlistSearch), [playlistSearch])
  useEffect(() => saveSessionValue('intro-buzz-console-selected-playlist-id', selectedPlaylistId), [selectedPlaylistId])
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

  const loadLibraryPlaylists = async (): Promise<{ id: string; name: string }[]> => {
    const playlists = await musicKit.getLibraryPlaylists() as { id: string; name: string }[]
    setLibraryPlaylists(playlists)
    setSelectedPlaylistId((current) => playlists.some((playlist) => playlist.id === current) ? current : '')
    return playlists
  }

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
    setSelectedPlaylistId(playlist.id)
    const tracks = await fetchPlaylistTracks(playlist)
    await musicKit.prepareQueue(tracks)
    await consoleAction('console:playlists', { playlists: [playlist.name], tracks })
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

  const handleNextRound = () => run(async () => {
    const nextState = await consoleAction('console:next-round')
    if (nextState.currentTrackIndex >= 0) await musicKit.loadTrack(nextState.currentTrackIndex)
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

      <section className="grid">
        <div className="panel">
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

        <div className="panel">
          <h2>2. 準備</h2>
          <div className="field-head">
            <span>ライブラリプレイリスト</span>
            <button className="ghost small" disabled={busy || !musicKit.authorized} onClick={() => run(async () => { await loadLibraryPlaylists() })}>再読み込み</button>
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
            }) : <li className="hint">{libraryPlaylists.length ? '一致するプレイリストがありません' : 'ログイン後にライブラリのプレイリストを取得します'}</li>}
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

        <div className="panel">
          <h2>3. 進行</h2>
          <div className="seconds-control">
            <span className="seconds-label">再生秒数</span>
            <CircularSecondsSlider value={seconds} onChange={setSeconds} />
          </div>
          <div className="actions">
            <button disabled={busy || state.step !== 'beforePlayback'} onClick={handlePlay}>{musicKit.playing ? '再生中' : '再生'}</button>
            <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('correct')}>正解</button>
            <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('wrong')}>不正解</button>
          </div>
          <div className="actions">
            <button disabled={busy || state.step !== 'reveal'} onClick={handleNextRound}>次のラウンドへ</button>
            <button disabled={busy || state.phase !== 'game'} onClick={() => consoleAction('console:next-game')}>次のゲームへ</button>
          </div>
        </div>

        <div className="panel">
          <h2>曲情報</h2>
          {state.currentTrack ? (
            <div className="track-card small">
              <p>{state.currentTrack.playlist}</p>
              <strong>{state.currentTrack.title}</strong>
              <span>{state.currentTrack.artist}</span>
            </div>
          ) : <p>まだ曲はロードされていません。</p>}
        </div>
      </section>
    </main>
  )
}


function gameboardMessage(state: GameState) {
  if (state.phase === 'initialization' || state.phase === 'ready') return '準備中'
  if (state.step === 'loading') return '曲を準備中'
  if (state.step === 'beforePlayback') return '次のイントロを待っています'
  if (state.step === 'playing') return '早押し！'
  if (state.step === 'answering') return '解答中'
  if (state.step === 'correct') return '正解！'
  if (state.step === 'wrong') return '不正解'
  if (state.step === 'reveal') return '正解発表'
  return phaseLabel(state.phase, state.step)
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

function TrackLane({ tracks, laneIndex, direction }: {
  tracks: Track[]
  laneIndex: number
  direction: 'left' | 'right'
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualCycleCount = 1000
  const virtualCount = Math.max(tracks.length, tracks.length * virtualCycleCount)
  const middleIndex = Math.floor(virtualCount / 2 / tracks.length) * tracks.length
  const speed = 34 + (laneIndex % 3) * 7
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is intentionally used for variable-width horizontal lanes.
  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 280,
    horizontal: true,
    overscan: 8,
    gap: 12,
  })

  useEffect(() => {
    virtualizer.scrollToIndex(middleIndex, { align: 'start' })
  }, [middleIndex, virtualizer])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return undefined

    let frameId = 0
    let previousTime: number | null = null
    const tick = (time: number) => {
      if (previousTime !== null) {
        const deltaSeconds = (time - previousTime) / 1000
        const delta = speed * deltaSeconds * (direction === 'left' ? 1 : -1)
        scrollElement.scrollLeft += delta

        if (scrollElement.scrollLeft < scrollElement.clientWidth) {
          virtualizer.scrollToIndex(middleIndex, { align: 'start' })
        } else if (scrollElement.scrollLeft > scrollElement.scrollWidth - scrollElement.clientWidth * 2) {
          virtualizer.scrollToIndex(middleIndex, { align: 'end' })
        }
      }
      previousTime = time
      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frameId)
  }, [direction, middleIndex, speed, virtualizer])

  return (
    <div className={`track-lane ${direction}`} ref={scrollRef}>
      <div className="track-lane-spacer" style={{ width: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const trackIndex = virtualItem.index % tracks.length
          const track = tracks[trackIndex]
          return (
            <div
              className="gameboard-track-chip"
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{ transform: `translate3d(${virtualItem.start}px, 0, 0)` }}
              key={virtualItem.key}
            >
              <TrackArtwork track={track} />
              <span className="gameboard-track-title">{track.title}</span>
            </div>
          )
        })}
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
      <div className="ready-track-lanes-head">
        <span>選択中の曲</span>
        <strong>{tracks.length}曲</strong>
      </div>
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

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 120)
    return () => window.clearInterval(timer)
  }, [])

  const isReacting = (player: Player) => player.lastActionAt != null && now - player.lastActionAt < 800
  const showReadyTracks = state.phase === 'ready' && state.tracks.length > 0

  return (
    <main className={`gameboard ${state.step} ${state.lastResult ?? ''}`}>
      <section className={showReadyTracks ? 'board-card ready-board' : 'board-card'}>
        <p className="eyebrow">{phaseLabel(state.phase, state.step)}</p>
        <h1>{gameboardMessage(state)}</h1>

        {showReadyTracks && <ReadyTrackLanes tracks={state.tracks} />}

        {state.step === 'playing' && <div className="pulse">♪</div>}
        {state.step === 'answering' && state.answererId && (
          <div
            className="answerer colored"
            style={{ '--player-color': playerColor(state.answererId).background } as CSSProperties}
            title={state.answererId}
            aria-label={state.answererId}
          />
        )}
        {state.step === 'correct' && <div className="effect success">正解！</div>}
        {state.step === 'wrong' && <div className="effect miss">不正解</div>}

        {state.step === 'reveal' && state.currentTrack && (
          <div className="track-card reveal">
            <p>正解</p>
            <strong>{state.currentTrack.title}</strong>
            <span>{state.currentTrack.artist}</span>
          </div>
        )}

        <div className="players">
          <h2>Players</h2>
          <div className="player-list">
            {joinedPlayers.length ? joinedPlayers.map((player) => (
              <PlayerBadge id={player.id} active={player.id === state.answererId} reacting={isReacting(player)} label={false} key={player.id} />
            )) : <span className="hint">準備フェーズでボタンを押すと参加できます</span>}
          </div>
        </div>
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
      gain.gain.setValueAtTime(0, start)
      gain.gain.linearRampToValueAtTime(1, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.02)
    }

    playTone(880, now, 0.18)
    playTone(1174.66, now + 0.16, 0.24)
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

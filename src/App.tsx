import { useEffect, useMemo, useState } from 'react'
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
}

type GameState = {
  phase: Phase
  step: GameStep
  hostLoggedIn: boolean
  playlists: string[]
  players: Player[]
  currentTrackIndex: number
  currentTrack: Track | null
  playbackSeconds: number
  answererId: string | null
  lastResult: 'correct' | 'wrong' | null
  message: string
  updatedAt: number
}

const initialState: GameState = {
  phase: 'initialization',
  step: 'idle',
  hostLoggedIn: false,
  playlists: [],
  players: [],
  currentTrackIndex: -1,
  currentTrack: null,
  playbackSeconds: 3,
  answererId: null,
  lastResult: null,
  message: '接続中...',
  updatedAt: Date.now(),
}

function useGameState() {
  const [state, setState] = useState<GameState>(initialState)

  useEffect(() => {
    fetch('/api/state')
      .then((res) => res.json())
      .then(setState)
      .catch(() => undefined)

    const events = new EventSource('/api/events')
    events.addEventListener('state', (event) => setState(JSON.parse((event as MessageEvent).data)))
    return () => events.close()
  }, [])

  return state
}

async function post<T = GameState>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json() as Promise<T>
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

function ConsolePage() {
  const state = useGameState()
  const musicKit = useMusicKitPlayback()
  const [libraryPlaylists, setLibraryPlaylists] = useState<{ id: string; name: string }[]>([])
  const [selectedPlaylistId, setSelectedPlaylistId] = useState('')
  const [seconds, setSeconds] = useState(0.5)
  const [busy, setBusy] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)

  const joinedPlayers = useMemo(() => state.players.filter((player) => player.joined), [state.players])

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
    setSelectedPlaylistId((current) => current || playlists[0]?.id || '')
    return playlists
  }

  const handleLogin = () => run(async () => {
    await musicKit.authorize()
    await post('/api/console/login')
    const playlists = await loadLibraryPlaylists()
    setConsoleMessage(`Apple Musicにログインしました。${playlists.length}件のライブラリプレイリストを取得しました`)
  })

  const handleSelectTracks = () => run(async () => {
    const playlists = libraryPlaylists.length > 0 ? libraryPlaylists : await loadLibraryPlaylists()
    const selected = playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? playlists[0]
    if (!selected) throw new Error('ライブラリにプレイリストが見つかりません')

    const tracks = await musicKit.getPlaylistTracks(selected.id, selected.name, 'library')
    await musicKit.prepareQueue(tracks)
    await post('/api/console/playlists', { playlists: [selected.name], tracks })
    setConsoleMessage(`${selected.name}: ${tracks.length}曲をMusicKitキューへ読み込みました`)
  })

  const handleStart = () => run(async () => {
    const nextState = await post('/api/console/start')
    if (nextState.currentTrackIndex >= 0) await musicKit.loadTrack(nextState.currentTrackIndex)
  })

  const handlePlay = () => run(async () => {
    await musicKit.playIntro(seconds)
    await post('/api/console/play', { seconds })
  })

  const handleJudge = (result: 'correct' | 'wrong') => run(async () => {
    await musicKit.stop()
    await post('/api/console/judge', { result })
  })

  const handleNextRound = () => run(async () => {
    const nextState = await post('/api/console/next-round')
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
        <button className="danger" onClick={() => post('/api/console/reset')}>リセット</button>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>1. 初期化</h2>
          <p>Apple Musicにログインして、MusicKitで実際に再生できる状態にします。</p>
          <div className="actions">
            <button disabled={busy || !musicKit.ready || musicKit.authorized} onClick={handleLogin}>Apple Musicにログイン</button>
            <button className="ghost" disabled={busy || !musicKit.authorized} onClick={() => run(musicKit.unauthorize)}>ログアウト</button>
          </div>
          <p className="hint">MusicKit: {musicKit.ready ? (musicKit.authorized ? 'ログイン済み' : '未ログイン') : '準備中'}</p>
        </div>

        <div className="panel">
          <h2>2. 準備</h2>
          <div className="field-head">
            <span>ライブラリプレイリスト</span>
            <button className="ghost small" disabled={busy || !musicKit.authorized} onClick={() => run(async () => { await loadLibraryPlaylists() })}>再読み込み</button>
          </div>
          <ul className="playlist-list">
            {libraryPlaylists.length ? libraryPlaylists.map((playlist) => {
              const selected = playlist.id === selectedPlaylistId
              return (
                <li key={playlist.id}>
                  <button
                    type="button"
                    className={selected ? 'playlist-row selected' : 'playlist-row'}
                    disabled={busy || !musicKit.authorized}
                    onClick={() => setSelectedPlaylistId(playlist.id)}
                    aria-pressed={selected}
                  >
                    <span className="playlist-check">{selected ? '✓' : ''}</span>
                    <span className="playlist-name">{playlist.name}</span>
                  </button>
                </li>
              )
            }) : <li className="hint">ログイン後にライブラリのプレイリストを取得します</li>}
          </ul>
          <div className="actions">
            <button disabled={busy || !musicKit.authorized || !selectedPlaylistId || musicKit.preparing} onClick={handleSelectTracks}>曲を選択</button>
            <button disabled={busy || state.phase !== 'ready'} onClick={handleStart}>ゲーム開始</button>
          </div>
          <p className="hint">参加中: {joinedPlayers.length ? joinedPlayers.map((p) => p.id).join(', ') : 'まだいません'}</p>
        </div>

        <div className="panel">
          <h2>3. 進行</h2>
          <label>
            再生秒数: {seconds.toFixed(1)}秒
            <input type="range" min="0.1" max="30" step="0.1" value={seconds} onChange={(event) => setSeconds(Number(event.target.value))} />
          </label>
          <div className="actions">
            <button disabled={busy || state.step !== 'beforePlayback'} onClick={handlePlay}>{musicKit.playing ? '再生中' : '再生'}</button>
            <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('correct')}>正解</button>
            <button disabled={busy || state.step !== 'answering'} onClick={() => handleJudge('wrong')}>不正解</button>
          </div>
          <div className="actions">
            <button disabled={busy || state.step !== 'reveal'} onClick={handleNextRound}>次のラウンドへ</button>
            <button disabled={busy || state.phase !== 'game'} onClick={() => post('/api/console/next-game')}>次のゲームへ</button>
          </div>
        </div>

        <div className="panel">
          <h2>曲情報</h2>
          {state.currentTrack ? (
            <div className="track-card small">
              <p>{state.currentTrack.playlist}</p>
              <strong>{state.step === 'reveal' ? state.currentTrack.title : '???'}</strong>
              <span>{state.step === 'reveal' ? state.currentTrack.artist : '正解発表まで伏せています'}</span>
            </div>
          ) : <p>まだ曲はロードされていません。</p>}
        </div>
      </section>
    </main>
  )
}

function GameboardPage() {
  const state = useGameState()
  const joinedPlayers = state.players.filter((player) => player.joined)

  return (
    <main className={`gameboard ${state.step} ${state.lastResult ?? ''}`}>
      <section className="board-card">
        <p className="eyebrow">{phaseLabel(state.phase, state.step)}</p>
        <h1>{state.message}</h1>

        {state.step === 'playing' && <div className="pulse">♪</div>}
        {state.step === 'answering' && <div className="answerer">{state.answererId}</div>}
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
              <span className={player.id === state.answererId ? 'player active' : 'player'} key={player.id}>{player.id}</span>
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
        <a className="button ghost" href="/debug/action">/debug/action</a>
      </div>
    </main>
  )
}

export default function App() {
  const path = window.location.pathname
  if (path === '/console') return <ConsolePage />
  if (path === '/gameboard') return <GameboardPage />
  return <HomePage />
}

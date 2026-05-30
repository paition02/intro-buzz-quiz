import { useEffect, useMemo, useState } from 'react'
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

async function post(path: string, body?: unknown) {
  await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
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
  const [playlistText, setPlaylistText] = useState('Sample LoveLive!')
  const [seconds, setSeconds] = useState(3)

  const joinedPlayers = useMemo(() => state.players.filter((player) => player.joined), [state.players])

  return (
    <main className="shell console">
      <header className="topbar">
        <div>
          <p className="eyebrow">Host Console</p>
          <h1>早押しイントロクイズ</h1>
        </div>
        <a className="ghost" href="/gameboard" target="_blank">Gameboard</a>
      </header>

      <section className="status-card">
        <div>
          <p className="eyebrow">現在</p>
          <h2>{phaseLabel(state.phase, state.step)}</h2>
          <p>{state.message}</p>
        </div>
        <button className="danger" onClick={() => post('/api/console/reset')}>リセット</button>
      </section>

      <section className="grid">
        <div className="panel">
          <h2>1. 初期化</h2>
          <p>現時点ではApple Music連携の差し込み口。MVPではログイン済みとして先へ進みます。</p>
          <button disabled={state.hostLoggedIn} onClick={() => post('/api/console/login')}>Apple Musicにログイン</button>
        </div>

        <div className="panel">
          <h2>2. 準備</h2>
          <label>
            プレイリスト（1行1件）
            <textarea value={playlistText} onChange={(event) => setPlaylistText(event.target.value)} />
          </label>
          <div className="actions">
            <button onClick={() => post('/api/console/playlists', { playlists: playlistText.split('\n').map((line) => line.trim()).filter(Boolean) })}>曲を選択</button>
            <button disabled={state.phase !== 'ready'} onClick={() => post('/api/console/start')}>ゲーム開始</button>
          </div>
          <p className="hint">参加中: {joinedPlayers.length ? joinedPlayers.map((p) => p.id).join(', ') : 'まだいません'}</p>
        </div>

        <div className="panel">
          <h2>3. 進行</h2>
          <label>
            再生秒数
            <input type="number" min="0.1" max="30" step="0.1" value={seconds} onChange={(event) => setSeconds(Number(event.target.value))} />
          </label>
          <div className="actions">
            <button disabled={state.step !== 'beforePlayback'} onClick={() => post('/api/console/play', { seconds })}>再生</button>
            <button disabled={state.step !== 'answering'} onClick={() => post('/api/console/judge', { result: 'correct' })}>正解</button>
            <button disabled={state.step !== 'answering'} onClick={() => post('/api/console/judge', { result: 'wrong' })}>不正解</button>
          </div>
          <div className="actions">
            <button disabled={state.step !== 'reveal'} onClick={() => post('/api/console/next-round')}>次のラウンドへ</button>
            <button disabled={state.phase !== 'game'} onClick={() => post('/api/console/next-game')}>次のゲームへ</button>
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
          <p className="hint">Debug: <a href="/debug/action" target="_blank">/debug/action</a></p>
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

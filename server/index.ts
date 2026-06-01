import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SignJWT, importPKCS8 } from 'jose'
import { Server } from 'socket.io'
import dotenv from 'dotenv'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
dotenv.config({ path: path.join(rootDir, '.env') })

const isProduction = process.env.NODE_ENV === 'production'

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
  players: Record<string, Player>
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

const sampleTracks: Track[] = [
  { id: 'sample-1', title: '青空Jumping Heart', artist: 'Aqours', playlist: 'Sample LoveLive!' },
  { id: 'sample-2', title: 'Snow halation', artist: 'μ\'s', playlist: 'Sample LoveLive!' },
  { id: 'sample-3', title: 'CHASE!', artist: '優木せつ菜', playlist: 'Sample LoveLive!' },
]

let state: GameState = {
  phase: 'initialization',
  step: 'idle',
  hostLoggedIn: false,
  playlists: [],
  players: {},
  tracks: [],
  currentTrackIndex: -1,
  currentTrack: null,
  hasPlayedCurrentTrack: false,
  playbackSeconds: 3,
  answererId: null,
  lastResult: null,
  message: 'ホストがApple Musicへログインするのを待っています',
  updatedAt: Date.now(),
}

let playbackSequence = 0
const actionCooldownMs = 250

const appleTeamId = process.env.APPLE_TEAM_ID ?? ''
const appleKeyId = process.env.APPLE_KEY_ID ?? ''
const applePrivateKey = (process.env.APPLE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n')

function hasAppleMusicCredentials() {
  return Boolean(appleTeamId && appleKeyId && applePrivateKey)
}

async function generateAppleMusicToken(expiresInSeconds = 60 * 60 * 24) {
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + expiresInSeconds
  const key = await importPKCS8(applePrivateKey, 'ES256')
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: appleKeyId })
    .setIssuer(appleTeamId)
    .setIssuedAt(now)
    .setExpirationTime(expiresAt)
    .sign(key)
  return { token, expiresAt: new Date(expiresAt * 1000) }
}

function publicState() {
  return {
    ...state,
    players: Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function emitState() {
  state.updatedAt = Date.now()
  io.emit('state', publicState())
}

function update(mutator: () => void) {
  mutator()
  emitState()
}

function ensurePlayer(actorId: string) {
  const id = actorId.trim() || 'anonymous'
  state.players[id] ??= { id, joined: false, lastActionAt: null }
  return state.players[id]
}

function loadCurrentTrack() {
  if (state.tracks.length === 0) state.tracks = sampleTracks
  const nextIndex = state.currentTrackIndex + 1 >= state.tracks.length ? 0 : state.currentTrackIndex + 1
  state.currentTrackIndex = nextIndex
  state.currentTrack = state.tracks[nextIndex]
  state.hasPlayedCurrentTrack = false
  state.step = 'beforePlayback'
  state.answererId = null
  state.lastResult = null
  state.message = '再生秒数を指定して、再生ボタンを押してください'
}


type ConsolePlaylistPayload = {
  playlists?: unknown
  tracks?: Partial<Track>[]
}

function consoleLogin() {
  update(() => {
    state.hostLoggedIn = true
    state.phase = 'ready'
    state.step = 'idle'
    state.message = 'プレイリストを選んで、プレイヤーの参加を待っています'
  })
  return publicState()
}

function consoleSetPlaylists(payload: ConsolePlaylistPayload = {}) {
  const playlists = Array.isArray(payload.playlists) ? payload.playlists.map(String).filter(Boolean) : []
  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks.map((track: Partial<Track>) => ({
      id: String(track.id ?? ''),
      title: String(track.title ?? ''),
      artist: String(track.artist ?? ''),
      playlist: String(track.playlist ?? playlists[0] ?? ''),
      artworkUrl: typeof track.artworkUrl === 'string' ? track.artworkUrl : undefined,
    })).filter((track: Track) => track.id && track.title)
    : []
  update(() => {
    state.playlists = playlists
    state.tracks = tracks.length > 0
      ? tracks
      : playlists.length > 0
        ? playlists.flatMap((playlist, i) => sampleTracks.map((track) => ({ ...track, id: `${i}-${track.id}`, playlist })))
        : sampleTracks
    state.message = `${state.tracks.length}曲を選択中。開始できます`
  })
  return publicState()
}

function consoleStart() {
  update(() => {
    state.phase = 'game'
    state.step = 'loading'
    state.currentTrackIndex = -1
    state.message = '曲をロードしています'
    loadCurrentTrack()
  })
  return publicState()
}

function consolePlay(payload: { seconds?: unknown } = {}) {
  const seconds = Number(payload.seconds)
  let playbackToken: number | null = null
  let playbackDurationMs = 0
  update(() => {
    if (Number.isFinite(seconds) && seconds > 0) state.playbackSeconds = Math.min(30, Math.max(0.1, seconds))
    if (state.phase === 'game' && state.step === 'beforePlayback') {
      playbackToken = ++playbackSequence
      playbackDurationMs = Math.ceil(state.playbackSeconds * 1000)
      state.step = 'playing'
      state.answererId = null
      state.hasPlayedCurrentTrack = true
      state.message = `${state.playbackSeconds}秒再生中。早押し待ちです`
    }
  })

  if (playbackToken != null) {
    setTimeout(() => {
      update(() => {
        if (
          state.phase === 'game' &&
          state.step === 'playing' &&
          state.answererId === null &&
          playbackSequence === playbackToken
        ) {
          state.step = 'beforePlayback'
          state.message = 'もう一度再生できます'
        }
      })
    }, playbackDurationMs)
  }

  return publicState()
}

function consoleJudge(payload: { result?: unknown } = {}) {
  const result = payload.result === 'correct' ? 'correct' : 'wrong'
  update(() => {
    if (state.phase !== 'game' || state.step !== 'answering') return
    state.lastResult = result
    state.step = result
    state.message = result === 'correct' ? '正解！' : '残念、不正解'
  })
  setTimeout(() => {
    update(() => {
      if (result === 'correct' && state.step === 'correct') {
        state.step = 'reveal'
        state.message = '正解発表中です'
      } else if (result === 'wrong' && state.step === 'wrong') {
        state.step = 'beforePlayback'
        state.answererId = null
        state.message = 'もう一度再生できます'
      }
    })
  }, 1800)
  return publicState()
}

function consoleNextRound() {
  update(() => {
    if (state.phase === 'game') {
      state.step = 'loading'
      state.message = '次の曲をロードしています'
      loadCurrentTrack()
    }
  })
  return publicState()
}

function consoleNextGame() {
  update(() => {
    state.phase = 'ready'
    state.step = 'idle'
    state.currentTrack = null
    state.currentTrackIndex = -1
    state.hasPlayedCurrentTrack = false
    state.answererId = null
    state.lastResult = null
    state.message = '次のゲームの準備中です'
  })
  return publicState()
}

function consoleReset() {
  update(() => {
    state = {
      phase: 'initialization',
      step: 'idle',
      hostLoggedIn: false,
      playlists: [],
      players: {},
      tracks: [],
      currentTrackIndex: -1,
      currentTrack: null,
      hasPlayedCurrentTrack: false,
      playbackSeconds: 3,
      answererId: null,
      lastResult: null,
      message: 'ホストがApple Musicへログインするのを待っています',
      updatedAt: Date.now(),
    }
  })
  return publicState()
}

function acknowledge<T>(callback: unknown, action: () => T) {
  try {
    const state = action()
    if (typeof callback === 'function') callback({ ok: true, state })
  } catch (error) {
    if (typeof callback === 'function') callback({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

const app = express()
const server = createServer(app)
const io = new Server(server, {
  cors: { origin: true },
})

io.on('connection', (socket) => {
  socket.emit('state', publicState())
  socket.on('console:login', (callback) => acknowledge(callback, consoleLogin))
  socket.on('console:playlists', (payload, callback) => acknowledge(callback, () => consoleSetPlaylists(payload)))
  socket.on('console:start', (callback) => acknowledge(callback, consoleStart))
  socket.on('console:play', (payload, callback) => acknowledge(callback, () => consolePlay(payload)))
  socket.on('console:judge', (payload, callback) => acknowledge(callback, () => consoleJudge(payload)))
  socket.on('console:next-round', (callback) => acknowledge(callback, consoleNextRound))
  socket.on('console:next-game', (callback) => acknowledge(callback, consoleNextGame))
  socket.on('console:reset', (callback) => acknowledge(callback, consoleReset))
})

app.use(express.json())


app.get('/api/token', async (_req, res) => {
  if (!hasAppleMusicCredentials()) {
    res.status(401).json({ error: 'Apple Music credentials are not configured' })
    return
  }
  try {
    const { token, expiresAt } = await generateAppleMusicToken()
    res.json({ token, expiresAt: expiresAt.toISOString() })
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Token generation failed' })
  }
})


app.post('/api/act/:actorId', (req, res) => {
  const now = Date.now()
  const actorId = req.params.actorId.trim()

  if (!actorId) {
    res.status(400).end()
    return
  }

  const player = ensurePlayer(actorId)

  if (player.lastActionAt !== null && now - player.lastActionAt < actionCooldownMs) {
    res.set('Retry-After', '1').status(429).end()
    return
  }

  let status: 200 | 204 | 409 = 409

  update(() => {
    player.lastActionAt = now

    if (state.phase === 'initialization' || state.phase === 'ready') {
      player.joined = !player.joined
      state.message = `参加者が${player.joined ? '参加' : '退出'}しました`
      status = 200
      return
    }

    const canAnswer = state.step === 'playing' || (state.step === 'beforePlayback' && state.hasPlayedCurrentTrack)

    if (state.phase === 'game' && canAnswer) {
      if (!player.joined) {
        status = 409
        return
      }

      if (state.answererId !== null) {
        status = 204
        return
      }

      state.answererId = player.id
      state.step = 'answering'
      state.message = '解答権が取られました'
      status = 200
      return
    }

    status = 409
  })

  res.status(status).end()
})


app.get('/action', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <title>早押しボタン</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #16131d; color: #f7f2ea; }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; }
    html, body { margin: 0; min-width: 320px; min-height: 100%; overscroll-behavior: none; touch-action: manipulation; }
    body {
      min-height: 100vh;
      min-height: 100svh;
      overflow: hidden;
      background:
        radial-gradient(circle at 20% 10%, rgba(255, 78, 119, 0.28), transparent 28rem),
        radial-gradient(circle at 80% 20%, rgba(255, 177, 78, 0.2), transparent 26rem),
        #16131d;
    }
    button {
      width: 100vw;
      min-height: 100vh;
      min-height: 100svh;
      border: 0;
      padding: max(18px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(18px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      display: grid;
      place-items: center;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font: inherit;
      transition: transform 0.08s ease, filter 0.16s ease, background 0.16s ease;
    }
    button:disabled { cursor: wait; }
    .content { display: grid; justify-items: center; gap: clamp(10px, 2.6svh, 18px); text-align: center; max-width: min(92vw, 560px); }
    .eyebrow { color: #ffb14e; text-transform: uppercase; letter-spacing: 0.16em; font-size: 0.78rem; font-weight: 1000; }
    .circle {
      width: min(68vw, 42svh, 320px);
      aspect-ratio: 1;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: linear-gradient(135deg, #ff4e77, #ffb14e);
      color: #21131a;
      box-shadow: 0 24px 80px rgba(255, 78, 119, 0.36), inset 0 0 0 12px rgba(255,255,255,0.22);
      font-size: clamp(4rem, 24vw, 8rem);
      font-weight: 1000;
    }
    h1 { margin: 0; font-size: clamp(2.2rem, 12vw, 5.8rem); line-height: 0.95; letter-spacing: -0.07em; }
    p { margin: 0; color: #d4c8ce; font-weight: 800; line-height: 1.5; }
    .pressed .circle { animation: pop 0.62s ease-out both; }
    .pressed { background: rgba(255, 177, 78, 0.12); }
    .idle .circle { filter: saturate(1); }
    .muted .circle { filter: saturate(0.72) brightness(0.82); }
    .error .circle { background: linear-gradient(135deg, #ff8aa3, #7c2438); color: #fff; }
    @keyframes pop {
      0% { transform: scale(1); box-shadow: 0 24px 80px rgba(255, 78, 119, 0.36), inset 0 0 0 12px rgba(255,255,255,0.22); }
      22% { transform: scale(1.12); box-shadow: 0 0 0 36px rgba(255, 177, 78, 0.18), 0 30px 90px rgba(255, 177, 78, 0.52), inset 0 0 0 12px rgba(255,255,255,0.28); }
      100% { transform: scale(1); box-shadow: 0 24px 80px rgba(255, 78, 119, 0.36), inset 0 0 0 12px rgba(255,255,255,0.22); }
    }
  </style>
</head>
<body>
  <button id="action" class="idle" type="button" aria-label="早押しボタン">
    <span class="content">
      <span class="eyebrow">Intro Buzz Button</span>
      <span class="circle" aria-hidden="true">!</span>
      <h1 id="title">押す</h1>
      <p id="status">スマホ全体が早押しボタンです</p>
    </span>
  </button>
  <script>
    const storageKey = 'intro-buzz-action-actor-id'
    const action = document.querySelector('#action')
    const title = document.querySelector('#title')
    const status = document.querySelector('#status')
    const createActorId = () => crypto.randomUUID()
    const getActorId = () => {
      const stored = sessionStorage.getItem(storageKey)
      if (stored) return stored
      const id = createActorId()
      sessionStorage.setItem(storageKey, id)
      return id
    }

    const actorId = getActorId()
    let audioContext = null

    const setState = (className, titleText, statusText) => {
      action.className = className
      title.textContent = titleText
      status.textContent = statusText
    }

    const playPingPong = async () => {
      const AudioContext = window.AudioContext || window.webkitAudioContext
      if (!AudioContext) return
      audioContext ??= new AudioContext()
      if (audioContext.state === 'suspended') await audioContext.resume()

      const now = audioContext.currentTime
      const master = audioContext.createGain()
      master.gain.setValueAtTime(1, now)
      master.connect(audioContext.destination)

      const playTone = (frequency, start, duration) => {
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
      if (action.disabled) return
      action.disabled = true
      try {
        const res = await fetch('/api/act/' + encodeURIComponent(actorId), { method: 'POST' })
        if (res.status === 200) {
          await playPingPong()
          setState('pressed', 'ピンポーン！', '反応しました')
          window.setTimeout(() => setState('idle', '押す', 'スマホ全体が早押しボタンです'), 760)
        } else if (res.status === 204) {
          setState('muted', '反応なし', '押せましたが、反応はありません')
          window.setTimeout(() => setState('idle', '押す', 'スマホ全体が早押しボタンです'), 760)
        } else if (res.status === 409) {
          setState('muted', '待って', '今は押せません')
          window.setTimeout(() => setState('idle', '押す', 'スマホ全体が早押しボタンです'), 760)
        } else if (res.status === 429) {
          setState('muted', '少し待って', '連打はクールダウン中です')
          window.setTimeout(() => setState('idle', '押す', 'スマホ全体が早押しボタンです'), 760)
        } else {
          setState('error', 'エラー', '送信に失敗しました: ' + res.status)
        }
      } catch (error) {
        setState('error', 'エラー', '接続できませんでした')
      } finally {
        window.setTimeout(() => { action.disabled = false }, 180)
      }
    }

    action.addEventListener('click', () => { void act() })
  </script>
</body>
</html>`)
})

if (isProduction) {
  app.use(express.static(path.join(rootDir, 'dist')))
  app.get(['/gameboard', '/console'], (_req, res) => res.sendFile(path.join(rootDir, 'dist', 'index.html')))
} else {
  const { createServer: createViteServer } = await import('vite')
  const vite = await createViteServer({
    root: rootDir,
    server: {
      middlewareMode: true,
      allowedHosts: ['.lhr.life'],
    },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

const port = Number(process.env.PORT ?? 5173)
server.listen(port, '0.0.0.0', () => {
  console.log(`Intro Buzz Quiz server listening on http://localhost:${port}`)
})

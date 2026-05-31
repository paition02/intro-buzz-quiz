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

    if (state.phase === 'game' && state.step === 'playing') {
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


app.get('/debug/action', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Debug Action</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #16131d; color: #f7f2ea; }
    body { margin: 0; padding: 24px; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { margin: 0 0 8px; }
    p { color: #d4c8ce; line-height: 1.6; }
    button { border: 0; border-radius: 999px; padding: 12px 18px; font-weight: 800; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #add { background: linear-gradient(135deg, #ff4e77, #ffb14e); color: #21131a; }
    .actor-list { display: grid; gap: 12px; margin-top: 20px; padding: 0; list-style: none; }
    .actor-item { display: flex; gap: 12px; align-items: center; justify-content: space-between; padding: 14px; border-radius: 18px; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); transition: border-color 0.16s ease, background 0.16s ease, transform 0.16s ease; }
    .actor-item.pressed { background: rgba(255, 177, 78, 0.14); border-color: rgba(255, 177, 78, 0.7); transform: scale(1.015); }
    .actor-item.error { background: rgba(255, 138, 163, 0.12); border-color: rgba(255, 138, 163, 0.65); }
    .act { background: #f7f2ea; color: #21131a; min-width: 96px; }
    .meta { color: #a99ca4; font-size: 0.9rem; }
    .actor-main { min-width: 0; }
  </style>
</head>
<body>
  <main>
    <h1>早押しボタン Debug</h1>
    <p>「ボタン追加」で早押しボタンをリストに追加します。各リストアイテムの ACT が物理ボタン1個分です。同じタブのセッション中だけ保持します。</p>
    <button id="add">ボタン追加</button>
    <ul id="actors" class="actor-list"></ul>
  </main>
  <script>
    const storageKey = 'intro-buzz-debug-actors'
    const actorsEl = document.querySelector('#actors')
    const loadActors = () => {
      try {
        const parsed = JSON.parse(sessionStorage.getItem(storageKey) || '[]')
        return Array.isArray(parsed) ? parsed.filter((value) => typeof value === 'string') : []
      } catch {
        return []
      }
    }

    const saveActors = (actors) => sessionStorage.setItem(storageKey, JSON.stringify(actors))
    const createActorId = () => 'actor-' + (crypto.randomUUID?.() || Math.random().toString(36).slice(2))

    let actors = loadActors()

    function render() {
      actorsEl.textContent = ''
      if (actors.length === 0) {
        const empty = document.createElement('li')
        empty.className = 'meta'
        empty.textContent = 'まだボタンがありません'
        actorsEl.append(empty)
        return
      }

      for (const [index, actorId] of actors.entries()) {
        const item = document.createElement('li')
        item.className = 'actor-item'

        const info = document.createElement('div')
        info.className = 'actor-main'
        const label = document.createElement('div')
        label.className = 'meta'
        label.textContent = 'ボタン ' + (index + 1)
        info.append(label)

        const button = document.createElement('button')
        button.className = 'act'
        button.textContent = 'ACT'
        button.addEventListener('click', async () => {
          button.disabled = true
          try {
            const res = await fetch('/api/act/' + encodeURIComponent(actorId), { method: 'POST' })
            item.classList.remove('pressed', 'error')
            if (res.status === 200) {
              item.classList.add('pressed')
              setTimeout(() => item.classList.remove('pressed'), 650)
            } else if (!res.ok && res.status !== 409 && res.status !== 429) {
              item.classList.add('error')
              setTimeout(() => item.classList.remove('error'), 650)
            }
          } catch (error) {
            item.classList.remove('pressed')
            item.classList.add('error')
            setTimeout(() => item.classList.remove('error'), 650)
          } finally {
            button.disabled = false
          }
        })

        item.append(info, button)
        actorsEl.append(item)
      }
    }

    document.querySelector('#add').addEventListener('click', () => {
      actors = [...actors, createActorId()]
      saveActors(actors)
      render()
    })

    render()
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

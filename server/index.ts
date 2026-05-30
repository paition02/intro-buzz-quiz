import express from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Response } from 'express'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
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

const clients = new Set<Response>()

function publicState() {
  return {
    ...state,
    players: Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function emitState() {
  state.updatedAt = Date.now()
  const payload = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`
  for (const client of clients) client.write(payload)
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

const app = express()
const server = createServer(app)
app.use(express.json())

app.get('/api/state', (_req, res) => res.json(publicState()))

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`)
  clients.add(res)
  req.on('close', () => clients.delete(res))
})

app.post('/api/act/:actorId', (req, res) => {
  const now = Date.now()
  let shouldReact = false

  update(() => {
    const player = ensurePlayer(req.params.actorId)
    player.lastActionAt = now

    if (state.phase === 'ready') {
      player.joined = !player.joined
      shouldReact = true
      state.message = `${player.id} が${player.joined ? '参加' : '退出'}しました`
      return
    }

    if (state.phase === 'game' && state.step === 'playing' && state.answererId === null && player.joined) {
      state.answererId = player.id
      state.step = 'answering'
      state.message = `${player.id} に解答権があります`
      shouldReact = true
      return
    }

    shouldReact = false
  })

  res.json({ shouldReact })
})

app.post('/api/console/login', (_req, res) => {
  update(() => {
    state.hostLoggedIn = true
    state.phase = 'ready'
    state.step = 'idle'
    state.message = 'プレイリストを選んで、プレイヤーの参加を待っています'
  })
  res.json(publicState())
})

app.post('/api/console/playlists', (req, res) => {
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists.map(String).filter(Boolean) : []
  update(() => {
    state.playlists = playlists
    state.tracks = playlists.length > 0
      ? playlists.flatMap((playlist, i) => sampleTracks.map((track) => ({ ...track, id: `${i}-${track.id}`, playlist })))
      : sampleTracks
    state.message = `${state.playlists.length || 1}件のプレイリストを選択中。開始できます`
  })
  res.json(publicState())
})

app.post('/api/console/start', (_req, res) => {
  update(() => {
    state.phase = 'game'
    state.step = 'loading'
    state.currentTrackIndex = -1
    state.message = '曲をロードしています'
    loadCurrentTrack()
  })
  res.json(publicState())
})

app.post('/api/console/play', (req, res) => {
  const seconds = Number(req.body?.seconds)
  update(() => {
    if (Number.isFinite(seconds) && seconds > 0) state.playbackSeconds = Math.min(30, Math.max(0.1, seconds))
    if (state.phase === 'game' && state.step === 'beforePlayback') {
      state.step = 'playing'
      state.answererId = null
      state.message = `${state.playbackSeconds}秒再生中。早押し待ちです`
    }
  })
  res.json(publicState())
})

app.post('/api/console/judge', (req, res) => {
  const result = req.body?.result === 'correct' ? 'correct' : 'wrong'
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
  res.json(publicState())
})

app.post('/api/console/next-round', (_req, res) => {
  update(() => {
    if (state.phase === 'game') {
      state.step = 'loading'
      state.message = '次の曲をロードしています'
      loadCurrentTrack()
    }
  })
  res.json(publicState())
})

app.post('/api/console/next-game', (_req, res) => {
  update(() => {
    state.phase = 'ready'
    state.step = 'idle'
    state.currentTrack = null
    state.currentTrackIndex = -1
    state.answererId = null
    state.lastResult = null
    state.message = '次のゲームの準備中です'
  })
  res.json(publicState())
})

app.post('/api/console/reset', (_req, res) => {
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
  res.json(publicState())
})

app.get('/debug/action', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Debug Action</title></head>
<body style="font-family: system-ui; padding: 24px;">
<h1>早押しボタン Debug</h1>
<label>actor_id <input id="actor" value="player-1" /></label>
<button id="send" style="font-size: 24px; padding: 16px 24px; display: block; margin-top: 16px;">ACT</button>
<pre id="result"></pre>
<script>
document.querySelector('#send').addEventListener('click', async () => {
  const actor = encodeURIComponent(document.querySelector('#actor').value || 'player-1')
  const res = await fetch('/api/act/' + actor, { method: 'POST' })
  document.querySelector('#result').textContent = JSON.stringify(await res.json(), null, 2)
})
</script>
</body></html>`)
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

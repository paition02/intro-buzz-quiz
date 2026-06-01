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
  playlistSearch: string
  expandedPlaylistIds: string[]
  players: Record<string, Player>
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

let state: GameState = {
  phase: 'initialization',
  step: 'idle',
  hostLoggedIn: false,
  playlists: [],
  selectedPlaylistId: null,
  playlistSearch: '',
  expandedPlaylistIds: [],
  players: {},
  tracks: [],
  gameTrackOrder: [],
  currentGameTrackOrderIndex: -1,
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
  state.players[id] ??= { id, joined: false, lastActionAt: null, score: 0 }
  return state.players[id]
}

function shuffledIndices(length: number) {
  const indices = Array.from({ length }, (_, index) => index)
  for (let i = indices.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[indices[i], indices[j]] = [indices[j], indices[i]]
  }
  return indices
}

function resetGameTrackOrder() {
  state.gameTrackOrder = shuffledIndices(state.tracks.length)
  state.currentGameTrackOrderIndex = -1
}

function loadCurrentTrack() {
  if (state.tracks.length === 0) {
    state.step = 'idle'
    state.currentGameTrackOrderIndex = -1
    state.currentTrackIndex = -1
    state.currentTrack = null
    state.message = '曲が選択されていません'
    return
  }
  if (state.gameTrackOrder.length !== state.tracks.length) resetGameTrackOrder()
  const nextOrderIndex = state.currentGameTrackOrderIndex + 1 >= state.gameTrackOrder.length ? 0 : state.currentGameTrackOrderIndex + 1
  const nextTrackIndex = state.gameTrackOrder[nextOrderIndex] ?? 0
  state.currentGameTrackOrderIndex = nextOrderIndex
  state.currentTrackIndex = nextTrackIndex
  state.currentTrack = state.tracks[nextTrackIndex]
  state.hasPlayedCurrentTrack = false
  state.step = 'beforePlayback'
  state.answererId = null
  state.lastResult = null
  state.message = '再生秒数を指定して、再生ボタンを押してください'
}


type ConsolePlaylistPayload = {
  playlists?: unknown
  selectedPlaylistId?: unknown
  tracks?: Partial<Track>[]
}

function normalizePlaybackSeconds(seconds: unknown) {
  const value = Number(seconds)
  return Number.isFinite(value) && value > 0 ? Math.min(30, Math.max(0.1, value)) : null
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
  const selectedPlaylistId = typeof payload.selectedPlaylistId === 'string' && payload.selectedPlaylistId.trim()
    ? payload.selectedPlaylistId.trim()
    : null
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
    state.selectedPlaylistId = selectedPlaylistId
    state.expandedPlaylistIds = state.expandedPlaylistIds.filter((playlistId) => playlistId === selectedPlaylistId)
    state.tracks = tracks.length > 0
      ? tracks
      : []
    state.gameTrackOrder = []
    state.currentGameTrackOrderIndex = -1
    state.currentTrackIndex = -1
    state.currentTrack = null
    state.hasPlayedCurrentTrack = false
    state.message = state.tracks.length > 0 ? `${state.tracks.length}曲を選択中。開始できます` : '曲がありません'
  })
  return publicState()
}

function consoleSetPlaylistSearch(payload: { search?: unknown } = {}) {
  update(() => {
    state.playlistSearch = typeof payload.search === 'string' ? payload.search : ''
  })
  return publicState()
}

function consoleSetExpandedPlaylists(payload: { playlistIds?: unknown } = {}) {
  update(() => {
    state.expandedPlaylistIds = Array.isArray(payload.playlistIds) ? payload.playlistIds.map(String).filter(Boolean) : []
  })
  return publicState()
}

function consoleSetPlaybackSeconds(payload: { seconds?: unknown } = {}) {
  update(() => {
    const seconds = normalizePlaybackSeconds(payload.seconds)
    if (seconds != null) state.playbackSeconds = seconds
  })
  return publicState()
}

function consoleStart() {
  update(() => {
    if (state.tracks.length === 0) {
      state.message = '曲を選択してから開始してください'
      return
    }
    state.phase = 'game'
    state.step = 'loading'
    state.currentTrackIndex = -1
    Object.values(state.players).forEach((player) => { player.score = 0 })
    resetGameTrackOrder()
    state.message = '曲をロードしています'
    loadCurrentTrack()
  })
  return publicState()
}

function consolePlay(payload: { seconds?: unknown } = {}) {
  let playbackToken: number | null = null
  let playbackDurationMs = 0
  update(() => {
    const seconds = normalizePlaybackSeconds(payload.seconds)
    if (seconds != null) state.playbackSeconds = seconds
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
    if (result === 'correct' && state.answererId) state.players[state.answererId].score += 1
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

function consoleGiveUp() {
  update(() => {
    if (state.phase !== 'game') return
    if (!['beforePlayback', 'playing', 'answering', 'wrong'].includes(state.step)) return
    playbackSequence += 1
    state.step = 'reveal'
    state.answererId = null
    state.lastResult = null
    state.message = '正解発表中です'
  })
  return publicState()
}

function consoleShowResults() {
  update(() => {
    if (state.phase !== 'game' || state.step !== 'reveal') return
    state.step = 'results'
    state.currentTrack = null
    state.currentTrackIndex = -1
    state.answererId = null
    state.lastResult = null
    state.message = '結果発表です'
  })
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
    state.gameTrackOrder = []
    state.currentGameTrackOrderIndex = -1
    state.hasPlayedCurrentTrack = false
    state.answererId = null
    state.lastResult = null
    state.players = {}
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
      selectedPlaylistId: null,
      playlistSearch: '',
      expandedPlaylistIds: [],
      players: {},
      tracks: [],
      gameTrackOrder: [],
      currentGameTrackOrderIndex: -1,
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
  socket.on('console:playlist-search', (payload, callback) => acknowledge(callback, () => consoleSetPlaylistSearch(payload)))
  socket.on('console:expanded-playlists', (payload, callback) => acknowledge(callback, () => consoleSetExpandedPlaylists(payload)))
  socket.on('console:playback-seconds', (payload, callback) => acknowledge(callback, () => consoleSetPlaybackSeconds(payload)))
  socket.on('console:start', (callback) => acknowledge(callback, consoleStart))
  socket.on('console:play', (payload, callback) => acknowledge(callback, () => consolePlay(payload)))
  socket.on('console:judge', (payload, callback) => acknowledge(callback, () => consoleJudge(payload)))
  socket.on('console:give-up', (callback) => acknowledge(callback, consoleGiveUp))
  socket.on('console:next-round', (callback) => acknowledge(callback, consoleNextRound))
  socket.on('console:show-results', (callback) => acknowledge(callback, consoleShowResults))
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


if (isProduction) {
  app.use(express.static(path.join(rootDir, 'dist')))
  app.get(['/gameboard', '/console', '/action'], (_req, res) => res.sendFile(path.join(rootDir, 'dist', 'index.html')))
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

import { SignJWT, importPKCS8 } from 'jose'
import { Server } from 'socket.io'
import { Server as Engine } from '@socket.io/bun-engine'
import { networkInterfaces } from 'node:os'
import homeHtml from '../client/index.html'
import consoleHtml from '../client/console.html'
import gameboardHtml from '../client/gameboard.html'
import actionHtml from '../client/action.html'
import type { Album, GameState, JacketMode, Player, QuizMode, Track } from '../type/game'

// Bun が cwd の .env を読む。PORT は数値として渡す。
const isDevelopment = process.env.NODE_ENV !== 'production'

type InternalGameState = Omit<GameState, 'players'> & {
  players: Record<string, Player>
}

let state: InternalGameState = {
  operationId: 'initial',
  phase: 'initialization',
  step: 'idle',
  quizMode: null,
  selectedPlaylistIds: [],
  players: {},
  tracks: [],
  albums: [],
  shuffledTrackIds: [],
  shuffledAlbumIds: [],
  roundIndex: -1,
  roundAlbumIndex: -1,
  answererId: null,
  jacketMode: 'pixelated',
  jacketGrayscale: true,
  jacketHintPercent: 1,
}

const actionCooldownMs = 250
let lastAcceptedActionAtByActorId: Record<string, number> = {}
let roundIntroPlayed = false
const invalidStateError = 'この操作は現在の状態では実行できません'
type ConsoleActionResult = true | string
const quizModes = ['intro', 'jacket'] as const satisfies readonly QuizMode[]
const jacketModes = ['pixelated', 'missingBlocks', 'tileShuffle', 'circleReveal', 'zoomRotateCrop', 'edgeReveal'] as const satisfies readonly JacketMode[]

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

function publicState(): GameState {
  return {
    ...state,
    players: Object.values(state.players).sort((a, b) => a.id.localeCompare(b.id)),
  }
}

function emitState() {
  io.emit('state', publicState())
}

function update(mutator: () => void) {
  const before = [state.phase, state.step, state.roundIndex, state.roundAlbumIndex, state.answererId].join(':')
  mutator()
  const after = [state.phase, state.step, state.roundIndex, state.roundAlbumIndex, state.answererId].join(':')
  if (before !== after) state.operationId = crypto.randomUUID()
  emitState()
}

function uniqueTracksById(tracks: Track[]) {
  const seenTrackIds = new Set<string>()
  return tracks.filter((track) => {
    if (seenTrackIds.has(track.id)) return false
    seenTrackIds.add(track.id)
    return true
  })
}

function normalizedAlbumText(value: string) {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

// Albums are identified the way people recognize them: title and album
// artist. Library album IDs split the same album across releases and
// artwork differs across remasters, so neither takes part in the key.
function albumIdFromTrack(track: Track) {
  return [
    normalizedAlbumText(track.albumName),
    normalizedAlbumText(track.albumArtist ?? track.artist),
  ].join('\u001f')
}

function albumsFromTracks(tracks: Track[]) {
  const albums = new Map<string, Album>()
  for (const track of tracks) {
    if (!track.albumName.trim()) continue
    const id = albumIdFromTrack(track)
    const album = albums.get(id)
    if (album) {
      album.trackIds.push(track.id)
      continue
    }
    albums.set(id, {
      id,
      name: track.albumName,
      artist: track.albumArtist ?? track.artist,
      artworkChipUrl: track.artworkChipUrl,
      artworkInfoUrl: track.artworkInfoUrl,
      artworkRevealUrl: track.artworkRevealUrl,
      trackIds: [track.id],
    })
  }
  return [...albums.values()]
}

function shuffledValues<T>(values: T[]) {
  const shuffled = [...values]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

function hasSameSongIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return left.every((songId) => rightIds.has(songId))
}

function hasSameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false
  const rightIds = new Set(right)
  return left.every((id) => rightIds.has(id))
}

function resetShuffledTrackIds() {
  state.shuffledTrackIds = shuffledValues(state.tracks.map((track) => track.id))
  state.roundIndex = -1
}

function resetShuffledAlbumIds() {
  state.shuffledAlbumIds = shuffledValues(state.albums.map((album) => album.id))
  state.roundAlbumIndex = -1
}

function loadCurrentTrack() {
  if (state.tracks.length === 0) {
    state.step = 'idle'
    state.roundIndex = -1
    return
  }
  const selectedSongIds = state.tracks.map((track) => track.id)
  if (!hasSameSongIds(state.shuffledTrackIds, selectedSongIds)) resetShuffledTrackIds()
  state.roundIndex = state.roundIndex + 1 >= state.shuffledTrackIds.length ? 0 : state.roundIndex + 1
  roundIntroPlayed = false
  state.step = 'beforePlayback'
  state.answererId = null
}

function loadCurrentAlbum() {
  if (state.albums.length === 0) {
    state.step = 'idle'
    state.roundAlbumIndex = -1
    return
  }
  const selectedAlbumIds = state.albums.map((album) => album.id)
  if (!hasSameIds(state.shuffledAlbumIds, selectedAlbumIds)) resetShuffledAlbumIds()
  state.roundAlbumIndex = state.roundAlbumIndex + 1 >= state.shuffledAlbumIds.length ? 0 : state.roundAlbumIndex + 1
  state.jacketHintPercent = 1
  roundIntroPlayed = false
  state.step = 'beforePlayback'
  state.answererId = null
}

function loadCurrentRound() {
  if (state.quizMode === 'jacket') loadCurrentAlbum()
  else loadCurrentTrack()
}

function isQuizMode(value: unknown): value is QuizMode {
  return typeof value === 'string' && quizModes.includes(value as QuizMode)
}

function isJacketMode(value: unknown): value is JacketMode {
  return typeof value === 'string' && jacketModes.includes(value as JacketMode)
}


type ConsoleSelectPlaylistsPayload = {
  selectedPlaylistIds?: unknown
  tracks?: Partial<Track>[]
}

type ConsoleStartPayload = {
  quizMode?: unknown
}

type ConsoleSetJacketModePayload = {
  jacketMode?: unknown
}

type ConsoleSetJacketGrayscalePayload = {
  jacketGrayscale?: unknown
}

type ConsoleSetJacketHintPercentPayload = {
  jacketHintPercent?: unknown
}

function consoleReady(): ConsoleActionResult {
  if (state.phase !== 'initialization') return invalidStateError
  update(() => {
    state.phase = 'ready'
    state.step = 'idle'
  })
  return true
}

function consoleSelectPlaylists(payload: ConsoleSelectPlaylistsPayload = {}): ConsoleActionResult {
  if (state.phase !== 'ready') return invalidStateError

  const selectedPlaylistIds = Array.isArray(payload.selectedPlaylistIds)
    ? payload.selectedPlaylistIds.map(String).map((id) => id.trim()).filter(Boolean)
    : []
  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks.map((track: Partial<Track>) => ({
      id: String(track.id ?? ''),
      title: String(track.title ?? ''),
      artist: String(track.artist ?? ''),
      albumName: String(track.albumName ?? ''),
      albumArtist: typeof track.albumArtist === 'string' && track.albumArtist ? track.albumArtist : undefined,
      artworkChipUrl: typeof track.artworkChipUrl === 'string' ? track.artworkChipUrl : undefined,
      artworkInfoUrl: typeof track.artworkInfoUrl === 'string' ? track.artworkInfoUrl : undefined,
      artworkRevealUrl: typeof track.artworkRevealUrl === 'string' ? track.artworkRevealUrl : undefined,
    })).filter((track: Track) => track.id && track.title)
    : []
  const uniqueTracks = uniqueTracksById(tracks)
  const uniqueAlbums = albumsFromTracks(uniqueTracks)
  update(() => {
    state.selectedPlaylistIds = selectedPlaylistIds
    state.tracks = uniqueTracks.length > 0
      ? uniqueTracks
      : []
    state.albums = uniqueAlbums
    state.shuffledTrackIds = []
    state.shuffledAlbumIds = []
    state.roundIndex = -1
    state.roundAlbumIndex = -1
    state.quizMode = null
    roundIntroPlayed = false
  })
  return true
}

function consoleStart(payload: ConsoleStartPayload | null = {}): ConsoleActionResult {
  if (state.phase !== 'ready') return invalidStateError
  const quizMode = payload?.quizMode
  if (!isQuizMode(quizMode)) return '開始するゲームモードを選択してください'
  if (state.tracks.length === 0) return '曲を選択してから開始してください'
  if (quizMode === 'jacket' && state.albums.length === 0) return 'アルバム名のある曲を選択してから開始してください'

  update(() => {
    state.phase = 'game'
    state.step = 'loading'
    state.quizMode = quizMode
    Object.values(state.players).forEach((player) => { player.score = 0 })
    resetShuffledTrackIds()
    resetShuffledAlbumIds()
    loadCurrentRound()
  })
  return true
}

function consolePlay(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'beforePlayback') return invalidStateError
  if (state.quizMode !== 'intro') return invalidStateError

  update(() => {
    state.step = 'playing'
    state.answererId = null
    roundIntroPlayed = true
  })

  return true
}

function consolePlayEnded(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'playing') return invalidStateError
  if (state.quizMode !== 'intro') return invalidStateError

  update(() => {
    state.step = 'beforePlayback'
  })

  return true
}

function consoleExcludeTrack(payload: unknown): ConsoleActionResult {
  if (!payload || typeof payload !== 'object' || !('operationId' in payload) || payload.operationId !== state.operationId || !('trackId' in payload)) return invalidStateError
  const trackId = payload.trackId
  if (state.phase !== 'game' || !state.tracks.some(track => track.id === trackId)) return invalidStateError
  const currentTrack = state.shuffledTrackIds[state.roundIndex]
  const currentAlbum = state.shuffledAlbumIds[state.roundAlbumIndex]
  update(() => {
    state.tracks = state.tracks.filter(track => track.id !== trackId)
    state.albums = albumsFromTracks(state.tracks)
    state.shuffledTrackIds = state.shuffledTrackIds.filter(id => id !== trackId)
    state.shuffledAlbumIds = state.shuffledAlbumIds.filter(id => state.albums.some(album => album.id === id))
    if (state.quizMode === 'intro') {
      if (currentTrack !== trackId) state.roundIndex = state.shuffledTrackIds.indexOf(currentTrack!)
      else {
        state.answererId = null
        roundIntroPlayed = false
        state.step = state.roundIndex < state.shuffledTrackIds.length ? 'beforePlayback' : 'results'
      }
    } else if (!state.shuffledAlbumIds.includes(currentAlbum!)) {
      state.answererId = null
      state.step = state.roundAlbumIndex < state.shuffledAlbumIds.length ? 'beforePlayback' : 'results'
    } else state.roundAlbumIndex = state.shuffledAlbumIds.indexOf(currentAlbum!)
    // Replacing the current item can leave the same numeric index and step.
    state.operationId = crypto.randomUUID()
  })
  return true
}

function consoleCorrect(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'answering') return invalidStateError

  update(() => {
    state.step = 'correct'
    if (state.answererId) state.players[state.answererId].score += 1
  })
  return true
}

function consoleWrong(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'answering') return invalidStateError

  update(() => {
    state.step = 'wrong'
  })
  return true
}

function consoleCorrectFeedbackEnded(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'correct') return invalidStateError

  update(() => {
    state.step = 'reveal'
  })
  return true
}

function consoleGiveUp(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'beforePlayback') return invalidStateError

  update(() => {
    state.step = 'reveal'
    state.answererId = null
  })
  return true
}

function consoleSetJacketMode(payload: ConsoleSetJacketModePayload | null = {}): ConsoleActionResult {
  if (state.phase !== 'game' || state.quizMode !== 'jacket' || state.step !== 'beforePlayback') return invalidStateError
  const jacketMode = payload?.jacketMode
  if (!isJacketMode(jacketMode)) return 'ジャケットの隠し方を選択してください'

  update(() => {
    state.jacketMode = jacketMode
  })
  return true
}

function consoleSetJacketGrayscale(payload: ConsoleSetJacketGrayscalePayload | null = {}): ConsoleActionResult {
  if (state.phase !== 'game' || state.quizMode !== 'jacket' || state.step !== 'beforePlayback') return invalidStateError
  const jacketGrayscale = payload?.jacketGrayscale
  if (typeof jacketGrayscale !== 'boolean') return '白黒設定が不正です'

  update(() => {
    state.jacketGrayscale = jacketGrayscale
  })
  return true
}

function consoleSetJacketHintPercent(payload: ConsoleSetJacketHintPercentPayload | null = {}): ConsoleActionResult {
  if (state.phase !== 'game' || state.quizMode !== 'jacket' || state.step !== 'beforePlayback') return invalidStateError
  if (typeof payload?.jacketHintPercent !== 'number' || !Number.isFinite(payload.jacketHintPercent)) return 'ヒントレベルが不正です'
  const nextPercent = Math.round(payload.jacketHintPercent)
  if (nextPercent < 1 || nextPercent > 100) return 'ヒントレベルは1〜100%で指定してください'

  update(() => {
    state.jacketHintPercent = nextPercent
  })
  return true
}

function consoleWrongFeedbackEnded(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'wrong') return invalidStateError

  update(() => {
    state.step = 'beforePlayback'
    state.answererId = null
  })
  return true
}

function consoleShowResults(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'reveal') return invalidStateError

  update(() => {
    state.step = 'results'
    state.roundIndex = -1
    state.roundAlbumIndex = -1
    roundIntroPlayed = false
    state.answererId = null
  })
  return true
}

function consoleNextRound(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'reveal') return invalidStateError
  if (state.quizMode === 'jacket') {
    if (state.roundAlbumIndex < 0 || state.roundAlbumIndex + 1 >= state.shuffledAlbumIds.length) return invalidStateError
  } else if (state.roundIndex < 0 || state.roundIndex + 1 >= state.shuffledTrackIds.length) return invalidStateError

  update(() => {
    state.step = 'loading'
    loadCurrentRound()
  })
  return true
}

function consoleNextGame(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'results') return invalidStateError

  update(() => {
    state.phase = 'ready'
    state.step = 'idle'
    state.quizMode = null
    state.shuffledTrackIds = []
    state.shuffledAlbumIds = []
    state.roundIndex = -1
    state.roundAlbumIndex = -1
    roundIntroPlayed = false
    state.answererId = null
    state.jacketMode = 'pixelated'
    state.jacketGrayscale = true
    state.jacketHintPercent = 1
    state.players = {}
    lastAcceptedActionAtByActorId = {}
  })
  return true
}

function consoleReset(): ConsoleActionResult {
  update(() => {
    lastAcceptedActionAtByActorId = {}
    state = {
      operationId: crypto.randomUUID(),
      phase: 'initialization',
      step: 'idle',
      quizMode: null,
      selectedPlaylistIds: [],
      players: {},
      tracks: [],
      albums: [],
      shuffledTrackIds: [],
      shuffledAlbumIds: [],
      roundIndex: -1,
      roundAlbumIndex: -1,
      answererId: null,
      jacketMode: 'pixelated',
      jacketGrayscale: true,
      jacketHintPercent: 1,
    }
  })
  return true
}

function acknowledge(callback: unknown, action: () => ConsoleActionResult) {
  try {
    const result = action()
    if (typeof callback === 'function') {
      if (result === true) callback({ ok: true })
      else callback({ ok: false, error: result })
    }
  } catch (error) {
    if (typeof callback === 'function') callback({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

function eventPayloadAndCallback(first: unknown, second: unknown) {
  if (typeof first === 'function') return { payload: null, callback: first }
  return { payload: first, callback: second }
}

// socket.io を Bun ネイティブの engine に bind する。
// engine.handler() が Bun.serve 用の websocket / idleTimeout 等を返し、
// /socket.io/ への HTTP・WS アップグレードは engine.handleRequest が一手に引き受ける。
const io = new Server()
const engine = new Engine({
  path: '/socket.io/',
  cors: { origin: true },
})
io.bind(engine)

io.on('connection', (socket) => {
  socket.emit('state', publicState())
  socket.on('console:ready', (callback) => acknowledge(callback, consoleReady))
  socket.on('console:select-playlists', (payload, callback) => acknowledge(callback, () => consoleSelectPlaylists(payload)))
  socket.on('console:start', (payloadOrCallback, maybeCallback) => {
    const { payload, callback } = eventPayloadAndCallback(payloadOrCallback, maybeCallback)
    acknowledge(callback, () => consoleStart(payload as ConsoleStartPayload | null))
  })
  socket.on('console:play', (callback) => acknowledge(callback, consolePlay))
  socket.on('console:exclude-track', (payload, callback) => acknowledge(callback, () => consoleExcludeTrack(payload)))
  socket.on('console:play-ended', (payloadOrCallback, maybeCallback) => {
    const { payload, callback } = eventPayloadAndCallback(payloadOrCallback, maybeCallback)
    acknowledge(callback, () => {
      if (!payload || typeof payload !== 'object' || !('operationId' in payload) || payload.operationId !== state.operationId) return '古い操作の終了通知です'
      return consolePlayEnded()
    })
  })
  socket.on('console:correct', (callback) => acknowledge(callback, consoleCorrect))
  socket.on('console:wrong', (callback) => acknowledge(callback, consoleWrong))
  socket.on('console:correct-feedback-ended', (payloadOrCallback, maybeCallback) => {
    const { payload, callback } = eventPayloadAndCallback(payloadOrCallback, maybeCallback)
    acknowledge(callback, () => {
      if (!payload || typeof payload !== 'object' || !('operationId' in payload) || payload.operationId !== state.operationId) return '古い操作の終了通知です'
      return consoleCorrectFeedbackEnded()
    })
  })
  socket.on('console:wrong-feedback-ended', (payloadOrCallback, maybeCallback) => {
    const { payload, callback } = eventPayloadAndCallback(payloadOrCallback, maybeCallback)
    acknowledge(callback, () => {
      if (!payload || typeof payload !== 'object' || !('operationId' in payload) || payload.operationId !== state.operationId) return '古い操作の終了通知です'
      return consoleWrongFeedbackEnded()
    })
  })
  socket.on('console:give-up', (callback) => acknowledge(callback, consoleGiveUp))
  socket.on('console:set-jacket-mode', (payload, callback) => acknowledge(callback, () => consoleSetJacketMode(payload)))
  socket.on('console:set-jacket-grayscale', (payload, callback) => acknowledge(callback, () => consoleSetJacketGrayscale(payload)))
  socket.on('console:set-jacket-hint-percent', (payload, callback) => acknowledge(callback, () => consoleSetJacketHintPercent(payload)))
  socket.on('console:next-round', (callback) => acknowledge(callback, consoleNextRound))
  socket.on('console:show-results', (callback) => acknowledge(callback, consoleShowResults))
  socket.on('console:next-game', (callback) => acknowledge(callback, consoleNextGame))
  socket.on('console:reset', (callback) => acknowledge(callback, consoleReset))
})

async function handleToken() {
  if (!hasAppleMusicCredentials()) {
    return Response.json({ error: 'Apple Music credentials are not configured' }, { status: 401 })
  }
  try {
    const { token, expiresAt } = await generateAppleMusicToken()
    return Response.json({ token, expiresAt: expiresAt.toISOString() })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Token generation failed' }, { status: 500 })
  }
}

// アクション API はボディではなくステータスコードで反応有無を示す(レスポンスボディは空)。
function handleAct(req: Bun.BunRequest<'/api/act/:actorId'>) {
  const now = Date.now()
  const actorId = req.params.actorId.trim()

  if (!actorId) return new Response(null, { status: 400 })

  const lastAcceptedActionAt = lastAcceptedActionAtByActorId[actorId] ?? null
  if (lastAcceptedActionAt !== null && now - lastAcceptedActionAt < actionCooldownMs) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
  }

  const player = state.players[actorId]

  if (state.phase === 'initialization' || state.phase === 'ready') {
    update(() => {
      if (player) {
        delete state.players[actorId]
      } else {
        state.players[actorId] = { id: actorId, score: 0 }
      }
    })
    lastAcceptedActionAtByActorId[actorId] = now
    return new Response(null, { status: 200 })
  }

  if (state.phase === 'game' && state.answererId !== null) {
    return new Response(null, { status: 204 })
  }

  const canAnswerIntro = state.quizMode === 'intro' && (state.step === 'playing' || (state.step === 'beforePlayback' && roundIntroPlayed))
  const canAnswerJacket = state.quizMode === 'jacket' && state.step === 'beforePlayback' && state.roundAlbumIndex >= 0
  const canAnswer = canAnswerIntro || canAnswerJacket

  if (state.phase === 'game' && canAnswer) {
    if (!player) return new Response(null, { status: 409 })

    update(() => {
      state.answererId = player.id
      state.step = 'answering'
    })
    lastAcceptedActionAtByActorId[actorId] = now
    return new Response(null, { status: 200 })
  }

  return new Response(null, { status: 409 })
}

function readPort(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return port
}

// engine.handler() から Bun.serve 用の websocket / idleTimeout / maxRequestBodySize を取り出す。
const { websocket, idleTimeout, maxRequestBodySize } = engine.handler()
const port = readPort('PORT')

const appRoutes = {
  // ルートごとに専用の HTML エントリポイントを持つ MPA 構成。
  '/': homeHtml,
  '/console': consoleHtml,
  '/gameboard': gameboardHtml,
  '/action': actionHtml,
  '/api/token': { GET: handleToken },
  '/api/act/:actorId': { POST: handleAct },
}

function handleAppRequest(req: Request, server: Parameters<typeof engine.handleRequest>[1]) {
  if (new URL(req.url).pathname.startsWith('/socket.io/')) return engine.handleRequest(req, server)
  return new Response('Not Found', { status: 404 })
}

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  development: isDevelopment,
  idleTimeout,
  maxRequestBodySize,
  routes: appRoutes,
  // routes に無いものだけここに落ちる。/socket.io/ は engine に丸ごと委ねる(HTTP も WS アップグレードも)。
  fetch: handleAppRequest,
  websocket,
})

const actualPort = server.port ?? port

console.log('Intro Buzz Quiz server listening')
console.log('')
console.log('Local URL:')
console.log(`  http://localhost:${actualPort}/`)

let loggedLanHeader = false
for (const [name, entries] of Object.entries(networkInterfaces())) {
  for (const entry of entries ?? []) {
    if (entry.internal || entry.family !== 'IPv4') continue
    if (!loggedLanHeader) {
      console.log('')
      console.log('LAN URLs:')
      loggedLanHeader = true
    }
    console.log(`  ${name}: http://${entry.address}:${actualPort}/`)
  }
}

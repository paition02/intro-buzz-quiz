import { SignJWT, importPKCS8 } from 'jose'
import { Server } from 'socket.io'
import { Server as Engine } from '@socket.io/bun-engine'
import { networkInterfaces } from 'node:os'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import index from '../index.html'

// Bun は cwd の .env を自動で読むので dotenv は不要。
const isDevelopment = process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test'

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
  artworkThumbUrl?: string
}

type GameState = {
  phase: Phase
  step: GameStep
  hostLoggedIn: boolean
  playlists: string[]
  selectedPlaylistIds: string[]
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
  selectedPlaylistIds: [],
  players: {},
  tracks: [],
  gameTrackOrder: [],
  currentGameTrackOrderIndex: -1,
  currentTrackIndex: -1,
  currentTrack: null,
  hasPlayedCurrentTrack: false,
  playbackSeconds: 0.5,
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

function lanIpv4Addresses() {
  const addresses = new Set<string>()
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue
      addresses.add(entry.address)
    }
  }
  return [...addresses].sort()
}

function runOpenSsl(args: string[], cwd: string) {
  const openSslBin = existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl'
  const result = spawnSync(openSslBin, args, { cwd, encoding: 'utf8' })
  if (result.status === 0) return result.stdout
  const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
  throw new Error(`${openSslBin} ${args.join(' ')} failed${details ? `:\n${details}` : ''}`)
}

function chmodIfExists(path: string, mode: number) {
  if (existsSync(path)) chmodSync(path, mode)
}

function certificateIncludes(path: string, cwd: string, required: string[]) {
  if (!existsSync(path)) return false
  const text = runOpenSsl(['x509', '-in', path, '-text', '-noout'], cwd)
  return required.every((value) => text.includes(value))
}

function ensureHttpsCertificate() {
  const certDir = resolve(process.cwd(), '.certs')
  const caKey = join(certDir, 'intro-buzz-ca.key')
  const caCert = join(certDir, 'intro-buzz-ca.crt')
  const caSerial = join(certDir, 'intro-buzz-ca.srl')
  const caConfig = join(certDir, 'intro-buzz-ca-openssl.cnf')
  const serverKey = join(certDir, 'localhost.key')
  const serverCsr = join(certDir, 'localhost.csr')
  const serverCert = join(certDir, 'localhost.crt')
  const chainCert = join(certDir, 'localhost-chain.crt')
  const opensslConfig = join(certDir, 'localhost-openssl.cnf')

  mkdirSync(certDir, { recursive: true, mode: 0o700 })
  chmodSync(certDir, 0o700)

  if (!existsSync(caKey)) {
    runOpenSsl(['genrsa', '-out', caKey, '4096'], certDir)
    chmodSync(caKey, 0o600)
  }
  chmodIfExists(caKey, 0o600)

  writeFileSync(caConfig, [
    '[req]',
    'prompt = no',
    'distinguished_name = req_distinguished_name',
    'x509_extensions = v3_ca',
    '',
    '[req_distinguished_name]',
    'CN = Intro Buzz Quiz Local CA',
    '',
    '[v3_ca]',
    'basicConstraints = critical, CA:TRUE',
    'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always,issuer:always',
    '',
  ].join('\n'))

  if (!certificateIncludes(caCert, certDir, ['X509v3 Basic Constraints', 'CA:TRUE', 'X509v3 Authority Key Identifier'])) {
    runOpenSsl([
      'req',
      '-x509',
      '-new',
      '-nodes',
      '-key',
      caKey,
      '-sha256',
      '-days',
      '3650',
      '-out',
      caCert,
      '-config',
      caConfig,
    ], certDir)
  }

  if (!existsSync(serverKey)) {
    runOpenSsl(['genrsa', '-out', serverKey, '2048'], certDir)
    chmodSync(serverKey, 0o600)
  }
  chmodIfExists(serverKey, 0o600)

  const ipAddresses = ['127.0.0.1', '::1', ...lanIpv4Addresses()]
  const altNames = [
    'DNS.1 = localhost',
    ...ipAddresses.map((address, index) => `IP.${index + 1} = ${address}`),
  ].join('\n')

  writeFileSync(opensslConfig, [
    '[req]',
    'prompt = no',
    'distinguished_name = req_distinguished_name',
    'req_extensions = req_ext',
    '',
    '[req_distinguished_name]',
    'CN = localhost',
    '',
    '[req_ext]',
    'subjectAltName = @alt_names',
    '',
    '[v3_req]',
    'basicConstraints = CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid,issuer',
    'subjectAltName = @alt_names',
    '',
    '[alt_names]',
    altNames,
    '',
  ].join('\n'))

  runOpenSsl(['req', '-new', '-key', serverKey, '-out', serverCsr, '-config', opensslConfig], certDir)
  runOpenSsl([
    'x509',
    '-req',
    '-in',
    serverCsr,
    '-CA',
    caCert,
    '-CAkey',
    caKey,
    '-CAserial',
    caSerial,
    '-CAcreateserial',
    '-out',
    serverCert,
    '-days',
    '825',
    '-sha256',
    '-extensions',
    'v3_req',
    '-extfile',
    opensslConfig,
  ], certDir)

  writeFileSync(chainCert, `${readFileSync(serverCert, 'utf8')}\n${readFileSync(caCert, 'utf8')}`)

  return { certFile: chainCert, keyFile: serverKey, caCert }
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
  selectedPlaylistIds?: unknown
  tracks?: Partial<Track>[]
}

function normalizePlaybackSeconds(seconds: unknown) {
  const value = Number(seconds)
  return Number.isFinite(value) && value >= 0.1 && value <= 30 ? value : null
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
  const selectedPlaylistIds = Array.isArray(payload.selectedPlaylistIds)
    ? payload.selectedPlaylistIds.map(String).map((id) => id.trim()).filter(Boolean)
    : []
  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks.map((track: Partial<Track>) => ({
      id: String(track.id ?? ''),
      title: String(track.title ?? ''),
      artist: String(track.artist ?? ''),
      playlist: String(track.playlist ?? playlists[0] ?? ''),
      artworkUrl: typeof track.artworkUrl === 'string' ? track.artworkUrl : undefined,
      artworkThumbUrl: typeof track.artworkThumbUrl === 'string' ? track.artworkThumbUrl : undefined,
    })).filter((track: Track) => track.id && track.title)
    : []
  update(() => {
    state.playlists = playlists
    state.selectedPlaylistIds = selectedPlaylistIds
    state.tracks = tracks.length > 0
      ? tracks
      : []
    state.gameTrackOrder = []
    state.currentGameTrackOrderIndex = -1
    state.currentTrackIndex = -1
    state.currentTrack = null
    state.hasPlayedCurrentTrack = false
    state.message = state.tracks.length > 0 ? `${playlists.length}件のプレイリストから${state.tracks.length}曲を選択中。開始できます` : '曲がありません'
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
  if (payload.result !== 'correct' && payload.result !== 'wrong') return publicState()
  const result = payload.result
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
    if (state.phase === 'game' && state.step === 'reveal') {
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
      selectedPlaylistIds: [],
      players: {},
      tracks: [],
      gameTrackOrder: [],
      currentGameTrackOrderIndex: -1,
      currentTrackIndex: -1,
      currentTrack: null,
      hasPlayedCurrentTrack: false,
      playbackSeconds: 0.5,
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
  socket.on('console:login', (callback) => acknowledge(callback, consoleLogin))
  socket.on('console:playlists', (payload, callback) => acknowledge(callback, () => consoleSetPlaylists(payload)))
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

  const player = ensurePlayer(actorId)

  if (player.lastActionAt !== null && now - player.lastActionAt < actionCooldownMs) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '1' } })
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

    if (state.phase === 'game' && state.answererId !== null) {
      status = 204
      return
    }

    const canAnswer = state.step === 'playing' || (state.step === 'beforePlayback' && state.hasPlayedCurrentTrack)

    if (state.phase === 'game' && canAnswer) {
      if (!player.joined) {
        status = 409
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

  return new Response(null, { status })
}

// engine.handler() から Bun.serve 用の websocket / idleTimeout / maxRequestBodySize を取り出す。
const { websocket, idleTimeout, maxRequestBodySize } = engine.handler()
const portEnv = process.env.PORT?.trim()

if (!portEnv) {
  throw new Error('PORT is required')
}

const port = Number(portEnv)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535')
}

const httpsCertificate = ensureHttpsCertificate()

const server = Bun.serve({
  port,
  hostname: '0.0.0.0',
  development: isDevelopment,
  idleTimeout,
  maxRequestBodySize,
  tls: {
    cert: readFileSync(httpsCertificate.certFile, 'utf8'),
    key: readFileSync(httpsCertificate.keyFile, 'utf8'),
  },
  routes: {
    // SPA は単一の index.html。表示の出し分けはクライアント側が pathname で行う。
    '/': index,
    '/console': index,
    '/gameboard': index,
    '/action': index,
    '/api/token': { GET: handleToken },
    '/api/act/:actorId': { POST: handleAct },
  },
  // routes に無いものだけここに落ちる。/socket.io/ は engine に丸ごと委ねる(HTTP も WS アップグレードも)。
  fetch(req, server) {
    if (new URL(req.url).pathname.startsWith('/socket.io/')) return engine.handleRequest(req, server)
    return new Response('Not Found', { status: 404 })
  },
  websocket,
})

const actualPort = server.port ?? port

console.log('Intro Buzz Quiz server listening')
console.log('')
console.log('Local CA certificate:')
console.log(`  ${httpsCertificate.caCert}`)
console.log('')
console.log('Local URL:')
console.log(`  https://localhost:${actualPort}/`)

let loggedLanHeader = false
for (const [name, entries] of Object.entries(networkInterfaces())) {
  for (const entry of entries ?? []) {
    if (entry.internal || entry.family !== 'IPv4') continue
    if (!loggedLanHeader) {
      console.log('')
      console.log('LAN URLs:')
      loggedLanHeader = true
    }
    console.log(`  ${name}: https://${entry.address}:${actualPort}/`)
  }
}

import { SignJWT, importPKCS8 } from 'jose'
import { Server } from 'socket.io'
import { Server as Engine } from '@socket.io/bun-engine'
import { networkInterfaces } from 'node:os'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import homeHtml from '../client/index.html'
import consoleHtml from '../client/console.html'
import gameboardHtml from '../client/gameboard.html'
import actionHtml from '../client/action.html'
import type { GameState, Player, Track } from '../type/game'

// Bun が cwd の .env を読む。HTTP_PORT / HTTPS_PORT は数値として渡す。
const isDevelopment = process.env.NODE_ENV !== 'production'

type InternalGameState = Omit<GameState, 'players'> & {
  players: Record<string, Player>
}

let state: InternalGameState = {
  phase: 'initialization',
  step: 'idle',
  selectedPlaylistIds: [],
  players: {},
  tracks: [],
  shuffledTrackIds: [],
  roundIndex: -1,
  answererId: null,
}

const actionCooldownMs = 250
let lastAcceptedActionAtByActorId: Record<string, number> = {}
let roundIntroPlayed = false
const invalidStateError = 'この操作は現在の状態では実行できません'
type ConsoleActionResult = true | string

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
  mutator()
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

function resetShuffledTrackIds() {
  state.shuffledTrackIds = shuffledValues(state.tracks.map((track) => track.id))
  state.roundIndex = -1
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


type ConsoleSelectPlaylistsPayload = {
  selectedPlaylistIds?: unknown
  tracks?: Partial<Track>[]
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
      artworkUrl: typeof track.artworkUrl === 'string' ? track.artworkUrl : undefined,
      artworkThumbUrl: typeof track.artworkThumbUrl === 'string' ? track.artworkThumbUrl : undefined,
    })).filter((track: Track) => track.id && track.title)
    : []
  const uniqueTracks = uniqueTracksById(tracks)
  update(() => {
    state.selectedPlaylistIds = selectedPlaylistIds
    state.tracks = uniqueTracks.length > 0
      ? uniqueTracks
      : []
    state.shuffledTrackIds = []
    state.roundIndex = -1
    roundIntroPlayed = false
  })
  return true
}

function consoleStart(): ConsoleActionResult {
  if (state.phase !== 'ready') return invalidStateError
  if (state.tracks.length === 0) return '曲を選択してから開始してください'

  update(() => {
    state.phase = 'game'
    state.step = 'loading'
    Object.values(state.players).forEach((player) => { player.score = 0 })
    resetShuffledTrackIds()
    loadCurrentTrack()
  })
  return true
}

function consolePlay(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'beforePlayback') return invalidStateError

  update(() => {
    state.step = 'playing'
    state.answererId = null
    roundIntroPlayed = true
  })

  return true
}

function consolePlayEnded(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'playing') return invalidStateError

  update(() => {
    state.step = 'beforePlayback'
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
    roundIntroPlayed = false
    state.answererId = null
  })
  return true
}

function consoleNextRound(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'reveal') return invalidStateError
  if (state.roundIndex < 0 || state.roundIndex + 1 >= state.shuffledTrackIds.length) return invalidStateError

  update(() => {
    state.step = 'loading'
    loadCurrentTrack()
  })
  return true
}

function consoleNextGame(): ConsoleActionResult {
  if (state.phase !== 'game' || state.step !== 'results') return invalidStateError

  update(() => {
    state.phase = 'ready'
    state.step = 'idle'
    state.shuffledTrackIds = []
    state.roundIndex = -1
    roundIntroPlayed = false
    state.answererId = null
    state.players = {}
    lastAcceptedActionAtByActorId = {}
  })
  return true
}

function consoleReset(): ConsoleActionResult {
  update(() => {
    lastAcceptedActionAtByActorId = {}
    state = {
      phase: 'initialization',
      step: 'idle',
      selectedPlaylistIds: [],
      players: {},
      tracks: [],
      shuffledTrackIds: [],
      roundIndex: -1,
      answererId: null,
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
  socket.on('console:start', (callback) => acknowledge(callback, consoleStart))
  socket.on('console:play', (callback) => acknowledge(callback, consolePlay))
  socket.on('console:play-ended', (callback) => acknowledge(callback, consolePlayEnded))
  socket.on('console:correct', (callback) => acknowledge(callback, consoleCorrect))
  socket.on('console:wrong', (callback) => acknowledge(callback, consoleWrong))
  socket.on('console:correct-feedback-ended', (callback) => acknowledge(callback, consoleCorrectFeedbackEnded))
  socket.on('console:wrong-feedback-ended', (callback) => acknowledge(callback, consoleWrongFeedbackEnded))
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

  const canAnswer = state.step === 'playing' || (state.step === 'beforePlayback' && roundIntroPlayed)

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
const httpPort = readPort('HTTP_PORT')
const httpsPort = readPort('HTTPS_PORT')

if (httpPort === httpsPort) {
  throw new Error('HTTP_PORT and HTTPS_PORT must be different')
}

const httpsCertificate = ensureHttpsCertificate()

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

const httpServer = Bun.serve({
  port: httpPort,
  hostname: '0.0.0.0',
  development: isDevelopment,
  idleTimeout,
  maxRequestBodySize,
  routes: appRoutes,
  // routes に無いものだけここに落ちる。/socket.io/ は engine に丸ごと委ねる(HTTP も WS アップグレードも)。
  fetch: handleAppRequest,
  websocket,
})

const httpsServer = Bun.serve({
  port: httpsPort,
  hostname: '0.0.0.0',
  development: isDevelopment,
  idleTimeout,
  maxRequestBodySize,
  tls: {
    cert: readFileSync(httpsCertificate.certFile, 'utf8'),
    key: readFileSync(httpsCertificate.keyFile, 'utf8'),
  },
  routes: appRoutes,
  // routes に無いものだけここに落ちる。/socket.io/ は engine に丸ごと委ねる(HTTP も WS アップグレードも)。
  fetch: handleAppRequest,
  websocket,
})

const actualHttpPort = httpServer.port ?? httpPort
const actualHttpsPort = httpsServer.port ?? httpsPort

console.log('Intro Buzz Quiz server listening')
console.log('')
console.log('Local CA certificate:')
console.log(`  ${httpsCertificate.caCert}`)
console.log('')
console.log('Local URLs:')
console.log(`  HTTP:  http://localhost:${actualHttpPort}/`)
console.log(`  HTTPS: https://localhost:${actualHttpsPort}/`)

let loggedLanHeader = false
for (const [name, entries] of Object.entries(networkInterfaces())) {
  for (const entry of entries ?? []) {
    if (entry.internal || entry.family !== 'IPv4') continue
    if (!loggedLanHeader) {
      console.log('')
      console.log('LAN URLs:')
      loggedLanHeader = true
    }
    console.log(`  ${name} HTTP:  http://${entry.address}:${actualHttpPort}/`)
    console.log(`  ${name} HTTPS: https://${entry.address}:${actualHttpsPort}/`)
  }
}

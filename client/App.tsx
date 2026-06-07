import { Activity, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import { useMusicKitAuth, useMusicKitInstance } from './useMusicKit'
import { useSequentialPlayback } from './useSequentialPlayback'
import type { GameState, GameStep, Phase, Player, Track } from '../type/game'
import {
  playlistTracksQueryOptions,
  useLibraryPlaylistsQuery,
  usePlaylistTracksQuery,
  type MusicPlaylist,
} from './useMusicKitLibraryQueries'

type ActionVisualState = 'idle' | 'pressed' | 'muted' | 'error'

const initialState: GameState = {
  phase: 'initialization',
  step: 'idle',
  selectedPlaylistIds: [],
  players: [],
  tracks: [],
  shuffledTrackIds: [],
  roundIndex: -1,
  answererId: null,
}

const GAME_STATE_KEYS = Object.keys(initialState) as Array<keyof GameState>

function roundTrackIdFromState(state: GameState) {
  return state.roundIndex >= 0 ? state.shuffledTrackIds[state.roundIndex] ?? null : null
}

function roundTrackFromState(state: GameState) {
  const trackId = roundTrackIdFromState(state)
  if (trackId == null) return null
  return state.tracks.find((track) => track.id === trackId) ?? null
}

function roundPreparationKeyFromState(state: GameState) {
  const trackId = roundTrackIdFromState(state)
  if (state.phase !== 'game' || state.roundIndex < 0 || trackId == null) return null
  return `${state.shuffledTrackIds.join('\u001f')}#${state.roundIndex}#${trackId}`
}

function gameStateChange(previous: GameState, next: GameState): Partial<GameState> {
  const change: Partial<GameState> = {}
  for (const key of GAME_STATE_KEYS) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      Object.assign(change, { [key]: next[key] })
    }
  }
  return change
}

function consoleStatusMessage(state: GameState, playbackSeconds: number) {
  if (state.phase === 'initialization') return 'Apple Musicへログインしてください'
  if (state.phase === 'ready') {
    if (state.tracks.length > 0) return `${state.selectedPlaylistIds.length}件のプレイリストから${state.tracks.length}曲を選択中。開始できます`
    return 'プレイリストを選んで、プレイヤーの参加を待っています'
  }
  if (state.step === 'loading') return '曲を準備しています'
  if (state.step === 'beforePlayback') return '再生秒数を指定して、再生ボタンを押してください'
  if (state.step === 'playing') return `${playbackSeconds}秒再生中。早押し待ちです`
  if (state.step === 'answering') return '解答権が取られました'
  if (state.step === 'correct') return '正解！'
  if (state.step === 'wrong') return '残念、不正解'
  if (state.step === 'reveal') return '正解発表中です'
  if (state.step === 'results') return '結果発表です'
  return ''
}

// サーバが唯一の真実(single source of truth)。ここが肝心なんだ!
// socket と 'state' リスナーはモジュール読込時に"同期で"張る。io() の直後に on('state') を
// 張るから、接続ハンドシェイク完了(=最初の state 到着)より必ず先にリスナーが居る。
// 旧実装は初回レンダー後に張っていたので、接続がレンダーを追い越すと
// 初回 state を取りこぼし、gameboard が固まることがあった。それを構造ごと潰す。
const socket: Socket = io()

// socket から届いた最新 state はモジュールで保持し、useGameState が React state として返す。
// onChange には前回から変わった GameState の key だけを渡す。
let latestState: GameState = initialState
let connected = socket.connected
const stateListeners = new Set<() => void>()
const connectedListeners = new Set<() => void>()

socket.on('state', (nextState: GameState) => {
  latestState = nextState
  stateListeners.forEach((notify) => notify())
})

function setConnected(next: boolean) {
  if (connected === next) return
  connected = next
  connectedListeners.forEach((notify) => notify())
}

// 再接続は新規 connection としてサーバ側 connection ハンドラを再発火させ、
// 接続時 emit('state') が再送される(=自動で最新へ追いつく)。ここでは表示用に状態だけ持つ。
socket.on('connect', () => setConnected(true))
socket.on('disconnect', () => setConnected(false))

window.addEventListener('offline', () => setConnected(false))
window.addEventListener('online', () => {
  if (!socket.connected) socket.connect()
  setConnected(socket.connected)
})

function subscribeState(notify: () => void) {
  stateListeners.add(notify)
  return () => { stateListeners.delete(notify) }
}

function subscribeConnected(notify: () => void) {
  connectedListeners.add(notify)
  return () => { connectedListeners.delete(notify) }
}

function useGameState(onChange?: (change: Partial<GameState>) => void | Promise<void>) {
  const previousStateRef = useRef(latestState)

  const subscribe = useCallback((notify: () => void) => {
    return subscribeState(() => {
      const change = gameStateChange(previousStateRef.current, latestState)
      previousStateRef.current = latestState
      void onChange?.(change)
      notify()
    })
  }, [onChange])

  return useSyncExternalStore(subscribe, () => latestState)
}

function useConnected() {
  return useSyncExternalStore(subscribeConnected, () => connected)
}

function consoleAction(event: string, body?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, response?: { ok: boolean; error?: string }) => {
      if (error) {
        reject(error)
        return
      }
      if (response?.ok) resolve()
      else reject(new Error(response?.error ?? 'Socket.IO console action failed'))
    }
    if (body === undefined) socket.timeout(5000).emit(event, callback)
    else socket.timeout(5000).emit(event, body, callback)
  })
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

function uniqueTracksById(tracks: Track[]) {
  const seenTrackIds = new Set<string>()
  return tracks.filter((track) => {
    if (seenTrackIds.has(track.id)) return false
    seenTrackIds.add(track.id)
    return true
  })
}

function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

// 共通の className 束。Tailwind ユーティリティを React 側でまとめて DRY に保つ。
const GLASS = 'bg-white/5 border border-white/10 shadow-2xl backdrop-blur-lg'
const BTN = 'inline-flex items-center justify-center rounded-full font-bold cursor-pointer no-underline transition disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none'
const BTN_PRIMARY = `${BTN} px-5 py-3 text-cocoa bg-linear-to-br from-pink to-amber shadow-lg`
const BTN_GHOST = `${BTN} px-5 py-3 text-cream bg-white/10 border border-white/10`
const BTN_GHOST_SMALL = `${BTN} px-3 py-1.5 text-sm text-cream bg-white/10 border border-white/10`
const BTN_DANGER = `${BTN} px-5 py-3 text-rose bg-rose/10`
const INPUT_BASE = 'w-full rounded-2xl border border-white/10 bg-black/20 text-white px-4 py-3 disabled:opacity-60'
const HINT = 'text-muted'
const EYEBROW = 'text-amber uppercase tracking-widest text-xs font-black mb-2'
const JUDGE_RESULT_DURATION_MS = 1800

// CSS の ::before/::after で描いていた形は inline SVG コンポーネントにした。
// inline なら fill / stroke / currentColor がそのまま効く(外部ファイル参照だとホスト CSS が
// 中に届かないので不可)。塗り = プレイヤー色、白縁 = stroke、グロー = style の filter で出す。
// viewBox は stroke がはみ出ても切れないよう周囲に 2 単位の余白を持たせている。
function PersonGlyph({ color, className, style, label }: { color: string; className?: string; style?: CSSProperties; label?: string }) {
  return (
    <svg
      viewBox="-2 -2 40 56"
      className={className}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <g fill={color} stroke="rgba(255,255,255,0.5)" strokeWidth={2.5} strokeLinejoin="round">
        {/* 胴体を先、顔を後に描いて顔(head)を前面に出す */}
        <path d="M0,40 A18,18 0 0 1 36,40 L36,42 A10,10 0 0 1 26,52 L10,52 A10,10 0 0 1 0,42 Z" />
        <circle cx="18" cy="12" r="12" />
      </g>
    </svg>
  )
}

function ChevronGlyph({ color, className }: { color?: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke={color ?? 'currentColor'} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9 L12 15 L18 9" />
    </svg>
  )
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5 L9.3 16.5 L19 7.5" />
    </svg>
  )
}

function PlayerBadge({ id, active = false, entering = false, label = true, score, variant = 'console', size = 'normal' }: { id: string; active?: boolean; entering?: boolean; label?: boolean; score?: number; variant?: 'console' | 'gameboard'; size?: 'normal' | 'large' }) {
  const color = playerColor(id)

  if (!label && variant === 'gameboard') {
    const large = size === 'large'
    // ゲームボード上はプレイヤーを人型シルエットで表示。正解者は拡大 + 白縁グロー。
    return (
      <span className={['relative flex flex-col items-center transition-transform', large ? 'w-28' : 'w-14', active && (large ? 'scale-110' : 'scale-125')].filter(Boolean).join(' ')} aria-label={id}>
        <PersonGlyph
          color={color.background}
          className={['block', large ? 'w-20 h-28' : 'w-9 h-12', entering && 'animate-participant-enter'].filter(Boolean).join(' ')}
          style={{ filter: active ? `drop-shadow(0 0 36px ${color.background}) drop-shadow(0 0 10px white)` : `drop-shadow(0 0 18px ${color.background})` }}
        />
        {score != null && <span className="mt-2 text-amber text-2xl leading-none font-black">{score}</span>}
      </span>
    )
  }

  if (!label) {
    // コンソールの参加者一覧。プレイヤー色のソフトな pill にシルエットを収める。
    return (
      <span
        className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 border"
        style={{ backgroundColor: color.softBackground, borderColor: color.border, color: color.text }}
        aria-label={id}
      >
        <PersonGlyph color={color.background} className="block w-6 h-9" style={{ filter: `drop-shadow(0 0 10px ${color.background})` }} />
        {score != null && <span>{score}</span>}
      </span>
    )
  }

  // label 付き: 色ドット + ID テキスト。
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-4 py-2.5 border font-bold"
      style={active
        ? { backgroundColor: color.background, color: '#fff', borderColor: 'rgba(255,255,255,0.52)' }
        : { backgroundColor: color.softBackground, color: color.text, borderColor: color.border }}
      aria-label="参加者"
    >
      <span className="size-2.5 rounded-full shrink-0 ring-4 ring-white/20" style={{ backgroundColor: active ? '#fff' : color.background }} />
      {id}
      {score != null && <span>{score}</span>}
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
    results: '結果発表ステップ',
  }
  return labels[step]
}

function CircularSecondsSlider({
  value,
  onChange,
  onCommit,
}: {
  value: number
  onChange: (value: number) => void
  onCommit?: (value: number) => void
}) {
  const min = 0.1
  const max = 30
  const step = 0.1
  const radius = 78
  const center = 96
  const activePointerIdRef = useRef<number | null>(null)
  const interactionRectRef = useRef<DOMRectReadOnly | null>(null)
  const latestValueRef = useRef(value)
  const circumference = 2 * Math.PI * radius
  const progress = (value - min) / (max - min)
  const dashOffset = circumference * (1 - progress)
  const angle = progress * 360 - 90
  const knobX = center + radius * Math.cos((angle * Math.PI) / 180)
  const knobY = center + radius * Math.sin((angle * Math.PI) / 180)

  useEffect(() => {
    latestValueRef.current = value
  }, [value])

  const updateFromPoint = (clientX: number, clientY: number, rect: DOMRectReadOnly) => {
    const x = clientX - rect.left - rect.width / 2
    const y = clientY - rect.top - rect.height / 2
    let degrees = (Math.atan2(y, x) * 180) / Math.PI + 90
    if (degrees < 0) degrees += 360
    const raw = min + (degrees / 360) * (max - min)
    const stepped = Math.round(raw / step) * step
    const nextValue = Number(Math.min(max, Math.max(min, stepped)).toFixed(1))
    latestValueRef.current = nextValue
    onChange(nextValue)
    return nextValue
  }

  return (
    <div className="grid place-items-center w-60 max-w-full mx-auto">
      <svg
        className="group w-56 max-w-full touch-none outline-none overflow-visible"
        viewBox="0 0 192 192"
        role="slider"
        aria-label="再生秒数"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={(event) => {
          activePointerIdRef.current = event.pointerId
          interactionRectRef.current = event.currentTarget.getBoundingClientRect()
          event.currentTarget.setPointerCapture(event.pointerId)
          updateFromPoint(event.clientX, event.clientY, interactionRectRef.current)
        }}
        onPointerMove={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          updateFromPoint(event.clientX, event.clientY, interactionRectRef.current ?? event.currentTarget.getBoundingClientRect())
        }}
        onPointerUp={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          const nextValue = updateFromPoint(event.clientX, event.clientY, interactionRectRef.current ?? event.currentTarget.getBoundingClientRect())
          activePointerIdRef.current = null
          interactionRectRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          onCommit?.(nextValue)
        }}
        onPointerCancel={(event) => {
          if (activePointerIdRef.current !== event.pointerId) return
          activePointerIdRef.current = null
          interactionRectRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
          onCommit?.(latestValueRef.current)
        }}
        onKeyDown={(event) => {
          let nextValue: number | null = null
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextValue = Number(Math.min(max, value + step).toFixed(1))
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextValue = Number(Math.max(min, value - step).toFixed(1))
          if (nextValue == null) return
          event.preventDefault()
          latestValueRef.current = nextValue
          onChange(nextValue)
          onCommit?.(nextValue)
        }}
      >
        <circle className="fill-none stroke-white/15" strokeWidth={18} cx={center} cy={center} r={radius} />
        <circle
          className="fill-none stroke-amber"
          strokeWidth={18}
          strokeLinecap="round"
          transform="rotate(-90 96 96)"
          cx={center}
          cy={center}
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
        <circle className="fill-pink stroke-cream group-focus-visible:stroke-white" strokeWidth={4} cx={knobX} cy={knobY} r="15" />
        <text className="fill-cream text-3xl font-black pointer-events-none" dominantBaseline="middle" x={center} y={center - 4} textAnchor="middle">{value.toFixed(1)}</text>
        <text className="fill-subtle text-sm font-bold pointer-events-none" dominantBaseline="middle" x={center} y={center + 22} textAnchor="middle">秒</text>
      </svg>
    </div>
  )
}

function PlaylistTracksPanel({ playlistId }: { playlistId: string }) {
  const tracksQuery = usePlaylistTracksQuery(playlistId)
  const tracks = tracksQuery.data
  const error = tracksQuery.error
  const loading = tracksQuery.isPending || tracksQuery.isFetching

  return (
    <div className="mt-2 p-2.5 rounded-xl bg-black/20 border border-white/10 max-h-72 overflow-y-auto">
      {loading && <p className={HINT}>曲を読み込み中...</p>}
      {!loading && error && <p className="text-rose font-bold">{error instanceof Error ? error.message : String(error)}</p>}
      {!loading && !error && tracks?.length === 0 && <p className={HINT}>曲がありません</p>}
      {!loading && !error && tracks && tracks.length > 0 && (
        <ul className="list-none m-0 p-0 grid gap-2">
          {tracks.map((track, index) => (
            <li className="flex items-center gap-2.5 min-w-0 text-cream" key={`${track.id}-${index}`}>
              <span className="w-7 shrink-0 text-right text-muted tabular-nums">{index + 1}</span>
              {(track.artworkThumbUrl ?? track.artworkUrl) && <img className="size-9 rounded-lg shrink-0" src={track.artworkThumbUrl ?? track.artworkUrl} alt="" />}
              <span className="min-w-0 grid">
                <span className="overflow-hidden text-ellipsis whitespace-nowrap font-bold">{track.title}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted text-sm">{track.artist}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlaylistListItem({
  playlist,
  selected,
  expanded,
  busy,
  authorized,
  onSelect,
  onToggleExpanded,
}: {
  playlist: MusicPlaylist
  selected: boolean
  expanded: boolean
  busy: boolean
  authorized: boolean
  onSelect: (playlist: MusicPlaylist) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}) {
  return (
    <li className="rounded-2xl bg-white/5" key={playlist.id}>
      <div className={`w-full rounded-2xl border flex items-stretch overflow-hidden text-cream ${selected ? 'bg-amber/20 border-amber/50' : 'bg-white/5 border-white/10'}`}>
        <button
          type="button"
          className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-inherit border-0 flex justify-start items-center gap-2.5 text-left cursor-pointer disabled:cursor-not-allowed"
          disabled={busy || !authorized}
          onClick={() => onSelect(playlist)}
          aria-pressed={selected}
        >
          <span className={`size-5 rounded-full border-2 inline-grid place-items-center shrink-0 ${selected ? 'bg-amber border-amber text-cocoa' : 'bg-white/10 border-white/40'}`}>
            {selected && <CheckGlyph className="size-3.5" />}
          </span>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{playlist.name}</span>
        </button>
        <button
          type="button"
          className={`w-12 grid place-items-center border-0 border-l border-white/10 cursor-pointer disabled:cursor-not-allowed ${expanded ? 'bg-white/5 text-amber' : 'bg-transparent text-cream'}`}
          disabled={busy || !authorized}
          onClick={() => onToggleExpanded(playlist)}
          aria-label={expanded ? 'プレイリストを閉じる' : 'プレイリストを開く'}
        >
          <ChevronGlyph color={expanded ? '#ffb14e' : '#f7f2ea'} className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
      </div>
      <Activity mode={expanded ? 'visible' : 'hidden'}>
        <PlaylistTracksPanel playlistId={playlist.id} />
      </Activity>
    </li>
  )
}

function ConsolePage() {
  const { instance: musicKitInstance, error: musicKitInitError } = useMusicKitInstance()
  const { setSongIds, prepareNext, playFromStart, stop } = useSequentialPlayback()
  const musicKitAuth = useMusicKitAuth()
  const queryClient = useQueryClient()
  const libraryPlaylistsQuery = useLibraryPlaylistsQuery()
  const libraryPlaylists = libraryPlaylistsQuery.data ?? []
  const loadingLibraryPlaylists = libraryPlaylistsQuery.isPending || libraryPlaylistsQuery.isFetching
  const [playlistSearch, setPlaylistSearch] = useState('')
  const [expandedPlaylistIds, setExpandedPlaylistIds] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [consoleMessage, setConsoleMessage] = useState<string | null>(null)
  const [playbackSeconds, setPlaybackSeconds] = useState(0.5)
  const [isPreparingNext, setIsPreparingNext] = useState(false)
  const [preparedRoundKey, setPreparedRoundKey] = useState<string | null>(null)
  const [playbackError, setPlaybackError] = useState<Error | null>(null)
  const autoReadyRequestedRef = useRef(false)
  const autoLoadLibraryPlaylistsRequestedRef = useRef(false)
  const playEndedTimeoutIdRef = useRef<number | null>(null)
  const feedbackEndedTimeoutIdRef = useRef<number | null>(null)
  const musicKitReady = musicKitInstance !== null
  const musicKitError = musicKitInitError ?? musicKitAuth.error ?? playbackError

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

  const report = useCallback((error: unknown) => {
    setConsoleMessage(error instanceof Error ? error.message : String(error))
  }, [])

  const loadLibraryPlaylists = useCallback(async (): Promise<MusicPlaylist[]> => {
    const result = await libraryPlaylistsQuery.refetch()
    if (result.error) throw result.error
    const playlists = result.data ?? []
    const playlistIds = new Set(playlists.map((playlist) => playlist.id))
    setExpandedPlaylistIds((current) => new Set([...current].filter((playlistId) => playlistIds.has(playlistId))))
    return playlists
  }, [libraryPlaylistsQuery])

  const clearPlayEndedTimeout = useCallback(() => {
    if (playEndedTimeoutIdRef.current === null) return
    window.clearTimeout(playEndedTimeoutIdRef.current)
    playEndedTimeoutIdRef.current = null
  }, [])

  const clearFeedbackEndedTimeout = useCallback(() => {
    if (feedbackEndedTimeoutIdRef.current === null) return
    window.clearTimeout(feedbackEndedTimeoutIdRef.current)
    feedbackEndedTimeoutIdRef.current = null
  }, [])

  const state = useGameState(useCallback(async (change: Partial<GameState>) => {
    if (musicKitInstance === null || !musicKitAuth.authorized) return

    if (change.step !== undefined && change.step !== 'playing') clearPlayEndedTimeout()
    if (change.step !== undefined && change.step !== 'correct' && change.step !== 'wrong') clearFeedbackEndedTimeout()

    if (change.step !== undefined && change.step !== 'playing' && change.step !== 'reveal') {
      try {
        await stop()
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      }
    }

    if (change.step === 'reveal') {
      try {
        await playFromStart()
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      }
    }

    if (change.roundIndex !== undefined || change.shuffledTrackIds !== undefined) {
      const nextRoundKey = roundPreparationKeyFromState(latestState)
      setPreparedRoundKey(null)

      if (latestState.roundIndex < 0 || nextRoundKey === null) {
        setIsPreparingNext(false)
        return
      }

      setIsPreparingNext(true)
      try {
        if (change.shuffledTrackIds !== undefined) {
          const songIds = latestState.shuffledTrackIds.slice(latestState.roundIndex)
          await setSongIds(songIds)
        }
        await prepareNext()
        setPreparedRoundKey(nextRoundKey)
        setPlaybackError(null)
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
      } finally {
        setIsPreparingNext(false)
      }
    } else if (change.step === 'beforePlayback') {
      const nextRoundKey = roundPreparationKeyFromState(latestState)
      if (nextRoundKey !== null && preparedRoundKey !== nextRoundKey) {
        setPreparedRoundKey(null)
        setIsPreparingNext(true)
        try {
          await prepareNext()
          setPreparedRoundKey(nextRoundKey)
          setPlaybackError(null)
        } catch (error) {
          setPlaybackError(errorFromUnknown(error))
        } finally {
          setIsPreparingNext(false)
        }
      }
    }

  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout, musicKitAuth.authorized, musicKitInstance, playFromStart, prepareNext, preparedRoundKey, setSongIds, stop]))

  useEffect(() => {
    return () => {
      clearPlayEndedTimeout()
      clearFeedbackEndedTimeout()
    }
  }, [clearFeedbackEndedTimeout, clearPlayEndedTimeout])

  const participatingPlayers = state.players
  const selectedPlaylistIds = state.selectedPlaylistIds
  const selectedPlaylistIdSet = useMemo(() => new Set(selectedPlaylistIds), [selectedPlaylistIds])
  const seconds = playbackSeconds
  const statusMessage = consoleStatusMessage(state, seconds)
  const roundTrackId = roundTrackIdFromState(state)
  const roundTrack = roundTrackFromState(state)
  const roundPreparationKey = roundPreparationKeyFromState(state)
  const roundPrepared = roundPreparationKey !== null && preparedRoundKey === roundPreparationKey
  const canPlayIntro = state.step === 'beforePlayback' && roundTrackId != null && roundPrepared && !isPreparingNext && playbackError === null && musicKitReady && musicKitAuth.authorized
  const canGoNextRound = state.phase === 'game' && state.step === 'reveal' && state.roundIndex >= 0 && state.roundIndex + 1 < state.shuffledTrackIds.length
  const playButtonLabel = state.step === 'playing' ? '再生中' : state.step === 'beforePlayback' && roundTrackId != null && !roundPrepared ? 'ロード中' : '再生'

  const visiblePlaylists = useMemo(() => {
    const query = playlistSearch.trim().toLowerCase()
    if (!query) return libraryPlaylists
    return libraryPlaylists.filter((playlist) => playlist.name.toLowerCase().includes(query))
  }, [libraryPlaylists, playlistSearch])

  const handlePlaybackSecondsChange = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  const handlePlaybackSecondsCommit = useCallback((value: number) => {
    setPlaybackSeconds(value)
  }, [])

  useEffect(() => {
    if (!musicKitAuth.authorized) autoLoadLibraryPlaylistsRequestedRef.current = false
    if (state.phase !== 'initialization') autoReadyRequestedRef.current = false

    if (musicKitReady && musicKitAuth.authorized && state.phase === 'initialization' && !autoReadyRequestedRef.current) {
      autoReadyRequestedRef.current = true
      void consoleAction('console:ready').catch((error) => {
        autoReadyRequestedRef.current = false
        report(error)
      })
    }

    if (
      musicKitReady &&
      musicKitAuth.authorized &&
      !loadingLibraryPlaylists &&
      libraryPlaylists.length === 0 &&
      !autoLoadLibraryPlaylistsRequestedRef.current
    ) {
      autoLoadLibraryPlaylistsRequestedRef.current = true
      void loadLibraryPlaylists().catch(report)
    }
  }, [
    libraryPlaylists.length,
    loadLibraryPlaylists,
    loadingLibraryPlaylists,
    musicKitAuth.authorized,
    musicKitReady,
    report,
    state.phase,
  ])

  const handleLogin = () => run(async () => {
    autoReadyRequestedRef.current = true
    autoLoadLibraryPlaylistsRequestedRef.current = true
    try {
      await musicKitAuth.authorize()
      await consoleAction('console:ready')
      const playlists = await loadLibraryPlaylists()
      setConsoleMessage(`Apple Musicにログインしました。${playlists.length}件のライブラリプレイリストを取得しました`)
    } catch (error) {
      autoReadyRequestedRef.current = false
      autoLoadLibraryPlaylistsRequestedRef.current = false
      throw error
    }
  })

  const fetchPlaylistTracks = async (playlist: MusicPlaylist) => {
    return queryClient.ensureQueryData(playlistTracksQueryOptions(musicKitInstance, musicKitAuth.authorized, playlist.id))
  }

  const togglePlaylistSelected = (playlist: MusicPlaylist) => run(async () => {
    const currentSelectedIds = new Set(state.selectedPlaylistIds)
    if (currentSelectedIds.has(playlist.id)) currentSelectedIds.delete(playlist.id)
    else currentSelectedIds.add(playlist.id)

    const selectedPlaylists = libraryPlaylists.filter((libraryPlaylist) => currentSelectedIds.has(libraryPlaylist.id))
    const trackGroups = await Promise.all(selectedPlaylists.map((selectedPlaylist) => fetchPlaylistTracks(selectedPlaylist)))
    const tracks = uniqueTracksById(trackGroups.flat())

    await consoleAction('console:select-playlists', {
      selectedPlaylistIds: selectedPlaylists.map((selectedPlaylist) => selectedPlaylist.id),
      tracks,
    })

    if (selectedPlaylists.length === 0) {
      setConsoleMessage('プレイリストの選択を解除しました')
    } else {
      setConsoleMessage(`${selectedPlaylists.length}件のプレイリストから${tracks.length}曲を選択しました`)
    }
  })

  const togglePlaylistExpanded = (playlist: MusicPlaylist) => run(async () => {
    setExpandedPlaylistIds((current) => {
      const next = new Set(current)
      if (next.has(playlist.id)) next.delete(playlist.id)
      else next.add(playlist.id)
      return next
    })
  })

  // 再生操作はボタンと useGameState(onChange) からだけ useSequentialPlayback へ渡す。
  const handleStart = () => run(async () => {
    if (state.tracks.length === 0) {
      setConsoleMessage('曲を選択してから開始してください')
      return
    }
    await consoleAction('console:start')
  })

  const handlePlay = () => run(async () => {
    if (!canPlayIntro) {
      setConsoleMessage('曲の準備完了を待っています')
      return
    }
    await consoleAction('console:play')
    await playFromStart()
    setPlaybackError(null)
    clearPlayEndedTimeout()
    playEndedTimeoutIdRef.current = window.setTimeout(async () => {
      playEndedTimeoutIdRef.current = null
      try {
        await stop()
        setPlaybackError(null)
        await consoleAction('console:play-ended')
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
        report(error)
      }
    }, Math.ceil(seconds * 1000))
  })

  const handleCorrect = () => run(async () => {
    await consoleAction('console:correct')
    playResultSound('correct')
    clearFeedbackEndedTimeout()
    feedbackEndedTimeoutIdRef.current = window.setTimeout(async () => {
      feedbackEndedTimeoutIdRef.current = null
      try {
        await consoleAction('console:correct-feedback-ended')
      } catch (error) {
        setPlaybackError(errorFromUnknown(error))
        report(error)
      }
    }, JUDGE_RESULT_DURATION_MS)
  })

  const handleWrong = () => run(async () => {
    await consoleAction('console:wrong')
    playResultSound('wrong')
    clearFeedbackEndedTimeout()
    feedbackEndedTimeoutIdRef.current = window.setTimeout(() => {
      feedbackEndedTimeoutIdRef.current = null
      void consoleAction('console:wrong-feedback-ended').catch(report)
    }, JUDGE_RESULT_DURATION_MS)
  })

  const handleGiveUp = () => run(async () => {
    await consoleAction('console:give-up')
  })

  const handleNextRound = () => run(async () => {
    await consoleAction('console:next-round')
  })

  const handleShowResults = () => run(async () => {
    await consoleAction('console:show-results')
    playResultsSound()
  })

  const handleNextGame = () => run(async () => {
    await consoleAction('console:next-game')
  })

  const handleReset = () => run(async () => {
    await consoleAction('console:reset')
  })

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
      <header className={`${GLASS} rounded-3xl p-6 flex flex-col items-stretch justify-between gap-4 mb-4 md:flex-row md:items-center`}>
        <div>
          <p className={EYEBROW}>Host Console</p>
          <h1 className="m-0 text-4xl sm:text-6xl font-black tracking-tighter">早押しイントロクイズ</h1>
        </div>
      </header>

      <section className={`${GLASS} rounded-3xl p-6 flex flex-col items-stretch justify-between gap-4 mb-4 md:flex-row md:items-center`}>
        <div>
          <p className={EYEBROW}>現在</p>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">{phaseLabel(state.phase, state.step)}</h2>
          <p className="mt-0 text-subtle leading-relaxed">{statusMessage}</p>
          {consoleMessage && <p className={`mt-0 leading-relaxed ${HINT}`}>{consoleMessage}</p>}
          {musicKitError && <p className="mt-0 leading-relaxed text-rose font-bold">MusicKit: <span>{musicKitError.message}</span></p>}
        </div>
        <button className={BTN_DANGER} onClick={handleReset}>リセット</button>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
        <div className={`${GLASS} rounded-2xl p-6 min-w-0`}>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">1. 初期化</h2>
          <p className="mt-0 text-subtle leading-relaxed">Apple Musicにログインして、MusicKitで実際に再生できる状態にします。</p>
          <div className={`flex items-center gap-3 my-4 p-3.5 rounded-2xl border ${!musicKitReady ? 'bg-white/5 border-white/10' : musicKitAuth.authorized ? 'bg-mint/10 border-mint/30' : 'bg-rose/10 border-rose/30'}`}>
            <span className={`size-3.5 rounded-full shrink-0 ${!musicKitReady ? 'bg-muted animate-dot-pulse' : musicKitAuth.authorized ? 'bg-mint' : 'bg-rose'}`} />
            <div>
              <strong className="block text-cream">{musicKitReady ? (musicKitAuth.authorized ? 'Apple Music ログイン済み' : 'Apple Music 未ログイン') : 'MusicKit 準備中'}</strong>
              <p className="mt-1 mb-0 text-subtle leading-snug">{musicKitReady ? (musicKitAuth.authorized ? 'ライブラリのプレイリストを複数選択できます' : 'ログインするとライブラリのプレイリストを取得できます') : 'MusicKit JS を初期化しています'}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5 mt-3.5 max-md:[&>button]:flex-1">
            <button className={BTN_PRIMARY} disabled={busy || !musicKitReady || musicKitAuth.authorized} onClick={handleLogin}>Apple Musicにログイン</button>
            <button className={BTN_GHOST} disabled={busy || !musicKitAuth.authorized} onClick={() => run(musicKitAuth.unauthorize)}>ログアウト</button>
          </div>
        </div>

        <div className={`${GLASS} rounded-2xl p-6 min-w-0`}>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">2. 準備</h2>
          <div className="flex items-center justify-between gap-3 text-cream font-bold mt-4 mb-3">
            <span>ライブラリプレイリスト</span>
            <button className={BTN_GHOST_SMALL} disabled={busy || loadingLibraryPlaylists || !musicKitAuth.authorized} onClick={() => run(async () => { await loadLibraryPlaylists() })}>{loadingLibraryPlaylists ? '読み込み中' : '再読み込み'}</button>
          </div>
          <input
            type="search"
            className={INPUT_BASE}
            placeholder="プレイリスト名で検索"
            value={playlistSearch}
            onChange={(event) => setPlaylistSearch(event.target.value)}
            disabled={busy || !musicKitAuth.authorized || libraryPlaylists.length === 0}
          />
          <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
            {visiblePlaylists.length ? visiblePlaylists.map((playlist) => {
              return (
                <PlaylistListItem
                  authorized={musicKitAuth.authorized}
                  busy={busy}
                  expanded={expandedPlaylistIds.has(playlist.id)}
                  key={playlist.id}
                  onSelect={togglePlaylistSelected}
                  onToggleExpanded={togglePlaylistExpanded}
                  playlist={playlist}
                  selected={selectedPlaylistIdSet.has(playlist.id)}
                />
              )
            }) : <li className={HINT}>{loadingLibraryPlaylists ? 'ライブラリのプレイリストを読み込み中...' : libraryPlaylists.length ? '一致するプレイリストがありません' : 'ログイン後にライブラリのプレイリストを取得します'}</li>}
          </ul>
          {selectedPlaylistIds.length > 0 && (
            <p className="mt-3 mb-0 text-subtle leading-relaxed">
              {selectedPlaylistIds.length}件のプレイリスト、{state.tracks.length}曲を選択中
            </p>
          )}
          <div className="flex flex-wrap gap-2.5 mt-3.5 max-md:[&>button]:flex-1">
            <button className={BTN_PRIMARY} disabled={busy || state.phase !== 'ready' || selectedPlaylistIds.length === 0 || state.tracks.length === 0} onClick={handleStart}>ゲーム開始</button>
          </div>
          <div className="flex items-center gap-2 flex-wrap mt-3">
            <span className={HINT}>参加中:</span>
            {participatingPlayers.length ? participatingPlayers.map((player) => (
              <PlayerBadge id={player.id} label={false} key={player.id} />
            )) : <span className={HINT}>まだいません</span>}
          </div>
        </div>

        </div>

        <div className="flex flex-col gap-4 min-w-0">

        <div className={`${GLASS} rounded-2xl p-6 min-w-0`}>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">3. 進行</h2>
          <div className="grid justify-items-center gap-2.5">
            <span className="justify-self-start text-cream font-bold">再生秒数</span>
            <CircularSecondsSlider
              value={seconds}
              onChange={handlePlaybackSecondsChange}
              onCommit={handlePlaybackSecondsCommit}
            />
          </div>
          <div className="grid gap-3.5 mt-4">
            <div className="grid gap-2.5 grid-cols-1 md:grid-cols-2 [&>button]:min-h-14">
              <button className={BTN_PRIMARY} disabled={busy || !canPlayIntro} onClick={handlePlay}>{playButtonLabel}</button>
              <button className={BTN_GHOST} disabled={busy || state.phase !== 'game' || state.step !== 'beforePlayback' || !roundPrepared} onClick={handleGiveUp}>ギブアップ</button>
              <button className={BTN_PRIMARY} disabled={busy || state.step !== 'answering'} onClick={handleCorrect}>正解</button>
              <button className={BTN_PRIMARY} disabled={busy || state.step !== 'answering'} onClick={handleWrong}>不正解</button>
            </div>
            <div className="grid gap-2.5 grid-cols-1 md:grid-cols-3 pt-3.5 border-t border-white/10 [&>button]:min-h-14">
              <button className={BTN_PRIMARY} disabled={busy || !canGoNextRound} onClick={handleNextRound}>次のラウンドへ</button>
              <button className={BTN_PRIMARY} disabled={busy || state.step !== 'reveal'} onClick={handleShowResults}>結果発表へ</button>
              <button className={BTN_PRIMARY} disabled={busy || state.step !== 'results'} onClick={handleNextGame}>次のゲームへ</button>
            </div>
          </div>
        </div>

        <div className={`${GLASS} rounded-2xl p-6 min-w-0`}>
          <h2 className="m-0 mb-2.5 text-2xl font-bold">曲情報</h2>
          {roundTrack ? (
            <div className="flex items-center gap-4 rounded-2xl p-5 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10">
              {(roundTrack.artworkThumbUrl ?? roundTrack.artworkUrl) ? (
                <img
                  className="size-24 rounded-xl shrink-0 object-cover bg-linear-to-br from-pink to-amber"
                  src={roundTrack.artworkThumbUrl ?? roundTrack.artworkUrl}
                  alt=""
                  loading="lazy"
                />
              ) : (
                <span className="size-24 rounded-xl shrink-0 grid place-items-center bg-linear-to-br from-pink to-amber text-cocoa text-4xl font-black" aria-hidden="true">♪</span>
              )}
              <div className="min-w-0">
                <strong className="block text-2xl font-bold leading-tight">{roundTrack.title}</strong>
                <span className="block mt-2.5 text-subtle">{roundTrack.artist}</span>
              </div>
            </div>
          ) : <p className="mt-0 text-subtle leading-relaxed">まだ曲は準備されていません。</p>}
        </div>
        </div>
      </section>
    </main>
  )
}


function playResultSound(kind: 'correct' | 'wrong') {
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const audioContext = new AudioContextCtor()
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
  const start = audioContext.currentTime
  const master = audioContext.createGain()
  master.gain.setValueAtTime(0.7, start)
  master.connect(audioContext.destination)

  const playTone = (frequency: number, offset: number, duration: number, type: OscillatorType = 'sine', level = 0.9, attack = 0.01, sustain = 0.18) => {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const toneStart = start + offset
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, toneStart)
    gain.gain.setValueAtTime(0.001, toneStart)
    gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), toneStart + Math.min(duration * 0.7, attack + 0.08))
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(toneStart)
    oscillator.stop(toneStart + duration + 0.03)
  }

  if (kind === 'correct') {
    const playDing = (offset: number, level: number) => {
      playTone(889.6, offset, 1.22, 'sine', level, 0.006, 0.28)
      playTone(4761, offset, 0.22, 'sine', level * 0.14, 0.004, 0.16)
      playTone(7911, offset + 0.004, 0.12, 'sine', level * 0.018, 0.003, 0.08)
    }

    const playDong = (offset: number, level: number) => {
      playTone(705.9, offset, 1.36, 'sine', level, 0.01, 0.34)
      playTone(3779, offset, 0.26, 'sine', level * 0.11, 0.005, 0.14)
      playTone(6279, offset + 0.004, 0.2, 'sine', level * 0.09, 0.004, 0.12)
    }

    playDing(0, 0.72)
    playDong(0.115, 0.34)
    playDing(0.235, 0.66)
    playDong(0.355, 0.36)
  } else {
    const playBuzzTone = (frequency: number, offset: number, duration: number, level: number, type: OscillatorType = 'sawtooth') => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      const toneStart = start + offset
      const attack = 0.012
      const release = 0.045
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, toneStart)
      gain.gain.setValueAtTime(0.001, toneStart)
      gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
      gain.gain.setValueAtTime(level, toneStart + Math.max(attack, duration - release))
      gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(toneStart)
      oscillator.stop(toneStart + duration + 0.03)
    }

    const playBuzz = (offset: number, duration: number, level: number) => {
      playBuzzTone(100.1, offset, duration, level * 0.62)
      playBuzzTone(199.9, offset, duration, level * 0.44)
      playBuzzTone(300.1, offset, duration, level * 0.68, 'square')
      playBuzzTone(400.4, offset, duration, level * 0.58, 'square')
      playBuzzTone(999.9, offset, duration, level * 0.34, 'sawtooth')
      playBuzzTone(1200.5, offset, duration, level * 0.2, 'sawtooth')
      playBuzzTone(7402, offset + 0.004, Math.max(0.05, duration - 0.02), level * 0.045, 'sine')
    }

    playBuzz(0.1, 0.14, 0.42)
    playBuzz(0.31, 0.58, 0.48)
  }

  window.setTimeout(() => void audioContext.close(), 2200)
}

function playResultsSound() {
  const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return
  const audioContext = new AudioContextCtor()
  if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
  const start = audioContext.currentTime
  const master = audioContext.createGain()
  master.gain.setValueAtTime(0.72, start)
  master.connect(audioContext.destination)

  const playTone = (
    frequency: number,
    offset: number,
    duration: number,
    level: number,
    type: OscillatorType = 'sine',
    attack = 0.024,
    sustain = 0.5,
  ) => {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    const toneStart = start + offset
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, toneStart)
    gain.gain.setValueAtTime(0.001, toneStart)
    gain.gain.exponentialRampToValueAtTime(level, toneStart + attack)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), toneStart + Math.min(duration * 0.64, attack + 0.18))
    gain.gain.exponentialRampToValueAtTime(0.001, toneStart + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(toneStart)
    oscillator.stop(toneStart + duration + 0.03)
  }

  const playSheen = () => {
    const createBuffer = (audioContext as { createBuffer?: AudioContext['createBuffer'] }).createBuffer?.bind(audioContext)
    const createBufferSource = (audioContext as { createBufferSource?: AudioContext['createBufferSource'] }).createBufferSource?.bind(audioContext)
    const createBiquadFilter = (audioContext as { createBiquadFilter?: AudioContext['createBiquadFilter'] }).createBiquadFilter?.bind(audioContext)
    if (!createBuffer || !createBufferSource || !createBiquadFilter) return

    const duration = 1.08
    const sampleRate = audioContext.sampleRate || 44100
    const buffer = createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate)
    const data = buffer.getChannelData(0)
    let seed = 0x6d2b79f5
    for (let index = 0; index < data.length; index += 1) {
      seed = Math.imul(seed ^ (seed >>> 15), 2246822507)
      seed = Math.imul(seed ^ (seed >>> 13), 3266489909)
      data[index] = (((seed >>> 0) / 4294967295) * 2 - 1) * Math.exp(-index / (sampleRate * 0.34))
    }

    const source = createBufferSource()
    const highpass = createBiquadFilter()
    const lowpass = createBiquadFilter()
    const gain = audioContext.createGain()
    source.buffer = buffer
    highpass.type = 'highpass'
    highpass.frequency.setValueAtTime(3800, start)
    lowpass.type = 'lowpass'
    lowpass.frequency.setValueAtTime(11800, start)
    gain.gain.setValueAtTime(0.001, start)
    gain.gain.exponentialRampToValueAtTime(0.085, start + 0.018)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    source.connect(highpass)
    highpass.connect(lowpass)
    lowpass.connect(gain)
    gain.connect(master)
    source.start(start)
    source.stop(start + duration + 0.03)
  }

  playSheen()
  playTone(1964.2, 0, 0.62, 0.035, 'sine', 0.008, 0.16)
  playTone(2618.3, 0.004, 0.78, 0.052, 'sine', 0.008, 0.18)
  playTone(2919.8, 0.01, 0.66, 0.04, 'sine', 0.007, 0.16)
  playTone(3620.3, 0.016, 0.62, 0.038, 'sine', 0.007, 0.14)
  playTone(4069.1, 0.024, 0.54, 0.032, 'sine', 0.006, 0.12)
  playTone(4520, 0.035, 0.5, 0.026, 'sine', 0.006, 0.11)
  playTone(5517.9, 0.048, 0.48, 0.03, 'sine', 0.005, 0.1)
  playTone(6102, 0.07, 0.42, 0.02, 'sine', 0.005, 0.09)
  playTone(6815.3, 0.09, 0.34, 0.016, 'sine', 0.004, 0.08)

  window.setTimeout(() => void audioContext.close(), 2400)
}

function GameboardPlayers({ players, answererId }: {
  players: Player[]
  answererId: string | null
}) {
  const previousPlayerIdsRef = useRef<Set<string> | null>(null)
  const [enteringPlayerIds, setEnteringPlayerIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const currentPlayerIds = new Set(players.map((player) => player.id))
    const previousPlayerIds = previousPlayerIdsRef.current
    previousPlayerIdsRef.current = currentPlayerIds
    if (previousPlayerIds == null) return

    const enteredPlayerIds = players.map((player) => player.id).filter((id) => !previousPlayerIds.has(id))
    if (enteredPlayerIds.length === 0) return

    setEnteringPlayerIds((ids) => new Set([...ids, ...enteredPlayerIds]))
    const timeoutIds = enteredPlayerIds.map((id) => window.setTimeout(() => {
      setEnteringPlayerIds((ids) => {
        if (!ids.has(id)) return ids
        const next = new Set(ids)
        next.delete(id)
        return next
      })
    }, 800))

    return () => {
      timeoutIds.forEach(window.clearTimeout)
    }
  }, [players])

  if (players.length === 0) return null
  return (
    <div className="w-full pt-5 border-t border-white/10">
      <div className="flex justify-center gap-2.5 flex-wrap">
        {players.map((player) => (
          <PlayerBadge
            id={player.id}
            active={player.id === answererId}
            entering={enteringPlayerIds.has(player.id)}
            label={false}
            score={player.score}
            variant="gameboard"
            key={player.id}
          />
        ))}
      </div>
    </div>
  )
}

let viewportSizeSnapshot = {
  width: window.innerWidth,
  height: window.innerHeight,
}

function getViewportSizeSnapshot() {
  const width = window.innerWidth
  const height = window.innerHeight
  if (viewportSizeSnapshot.width === width && viewportSizeSnapshot.height === height) return viewportSizeSnapshot
  viewportSizeSnapshot = { width, height }
  return viewportSizeSnapshot
}

function subscribeViewportSize(notify: () => void) {
  const update = () => {
    const previous = viewportSizeSnapshot
    if (getViewportSizeSnapshot() !== previous) notify()
  }
  window.addEventListener('resize', update)
  return () => window.removeEventListener('resize', update)
}

function useViewportSize() {
  return useSyncExternalStore(subscribeViewportSize, getViewportSizeSnapshot)
}

function TrackArtwork({ track }: { track: Track }) {
  // 正解発表カードの大きいアートワーク。チップ内の小さいものとは別サイズ。
  const base = 'size-64 sm:size-72 rounded-3xl shrink-0 object-cover bg-linear-to-br from-pink to-amber'
  return track.artworkUrl
    ? <img className={base} src={track.artworkUrl} alt="" loading="lazy" />
    : <span className={`${base} grid place-items-center text-cocoa font-black`} aria-hidden="true">♪</span>
}

const TRACK_CHIP_FONT = '900 16px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

// canvas / 2d コンテキストは 1 個だけ生成して使い回す(計測ごとに作らない)。
// `undefined` = 未初期化、`null` = 取得失敗(以後 fallback)。
let trackChipMeasureContext: CanvasRenderingContext2D | null | undefined

// タイトル → 実測幅のキャッシュ。同じタイトルは二度測らない(幅はタイトルの純関数)。
const trackChipWidthCache = new Map<string, number>()

function measureTrackChipWidth(track: Track) {
  const cached = trackChipWidthCache.get(track.title)
  if (cached !== undefined) return cached

  const artworkWidth = 36
  const contentGap = 10
  const horizontalPadding = 22
  const fixedWidth = artworkWidth + contentGap + horizontalPadding
  const fallback = Math.max(170, fixedWidth + track.title.length * 18)

  if (typeof document === 'undefined') return fallback

  if (trackChipMeasureContext === undefined) {
    trackChipMeasureContext = document.createElement('canvas').getContext('2d')
    if (trackChipMeasureContext) trackChipMeasureContext.font = TRACK_CHIP_FONT
  }
  if (!trackChipMeasureContext) return fallback

  const textWidth = trackChipMeasureContext.measureText(track.title).width
  const width = Math.max(170, Math.ceil(fixedWidth + textWidth))
  trackChipWidthCache.set(track.title, width) // 測ったら保持
  return width
}

function useElementClientWidth<T extends HTMLElement>() {
  const [element, setElement] = useState<T | null>(null)
  const subscribe = useCallback((notify: () => void) => {
    if (!element) return () => {}
    const observer = new ResizeObserver(notify)
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  const getSnapshot = useCallback(() => element?.clientWidth ?? 0, [element])
  const width = useSyncExternalStore(subscribe, getSnapshot)
  return [setElement, width] as const
}

function TrackLane({ tracks, laneIndex, direction }: {
  tracks: Track[]
  laneIndex: number
  direction: 'left' | 'right'
}) {
  const [setLaneElement, laneWidth] = useElementClientWidth<HTMLDivElement>()
  const [startIndex, setStartIndex] = useState(0)
  const [animationRun, setAnimationRun] = useState(0)
  const chipGap = 12
  const speed = 34 + (laneIndex % 3) * 7

  const slotWidths = useMemo(() => tracks.map((track) => measureTrackChipWidth(track) + chipGap), [tracks])
  const minSlotWidth = Math.max(1, slotWidths.length > 0 ? Math.min(...slotWidths) : 170 + chipGap)
  const visibleSlotCount = Math.max(2, Math.ceil(laneWidth / minSlotWidth) + 2)
  const normalizedStart = tracks.length > 0 ? ((startIndex % tracks.length) + tracks.length) % tracks.length
    : 0

  const laneTracks = useMemo(() => {
    if (tracks.length === 0 || visibleSlotCount === 0) return []
    const firstIndex = direction === 'right'
      ? (normalizedStart - 1 + tracks.length) % tracks.length
      : normalizedStart
    return Array.from({ length: visibleSlotCount + 1 }, (_, index) => tracks[(firstIndex + index) % tracks.length])
  }, [direction, normalizedStart, tracks, visibleSlotCount])

  const stepTrack = tracks.length === 0 ? null : direction === 'right'
    ? tracks[(normalizedStart - 1 + tracks.length) % tracks.length]
    : tracks[normalizedStart]
  const stepWidth = stepTrack ? measureTrackChipWidth(stepTrack) + chipGap : minSlotWidth

  const durationSeconds = Math.max(0.1, stepWidth / speed)

  const handleAnimationEnd = () => {
    if (tracks.length === 0) return
    setStartIndex((current) => direction === 'right' ? current - 1 : current + 1)
    setAnimationRun((current) => current + 1)
  }

  return (
    <div
      className={`relative min-h-16 overflow-hidden rounded-2xl border border-white/10 ${direction === 'right' ? 'bg-linear-to-r from-sky/5 to-white/5' : 'bg-linear-to-r from-white/5 to-amber/5'}`}
      ref={setLaneElement}
    >
      <div
        className={`track-lane-strip track-lane-strip-${direction}-${animationRun % 2 === 0 ? 'a' : 'b'} flex h-full`}
        onAnimationEnd={handleAnimationEnd}
        style={{
          '--track-lane-duration': `${durationSeconds}s`,
          '--track-lane-step': `${stepWidth}px`,
        } as CSSProperties}
      >
        <TrackLaneGroup tracks={laneTracks} />
      </div>
    </div>
  )
}

function TrackLaneGroup({ tracks, ariaHidden = false }: { tracks: Track[]; ariaHidden?: boolean }) {
  return (
    <div className="flex shrink-0 gap-3 py-2 pr-3" aria-hidden={ariaHidden}>
      {tracks.map((track, index) => (
        <TrackChip track={track} key={`${track.id}:${index}`} />
      ))}
    </div>
  )
}

function TrackChip({ track }: { track: Track }) {
  const artworkUrl = track.artworkThumbUrl ?? track.artworkUrl
  return (
    <div
      className="w-max h-12 flex shrink-0 items-center gap-2.5 py-1.5 pr-3.5 pl-2 overflow-hidden rounded-xl bg-black/70 border border-white/10 shadow-lg whitespace-nowrap"
      style={{ width: `${measureTrackChipWidth(track)}px` }}
    >
      <img
        className="size-9 rounded-lg shrink-0 object-cover bg-linear-to-br from-pink to-amber"
        src={artworkUrl}
        alt=""
        loading="lazy"
        style={{ display: artworkUrl ? undefined : 'none' }}
      />
      <span
        className="size-9 rounded-lg shrink-0 bg-linear-to-br from-pink to-amber grid place-items-center text-cocoa font-black"
        aria-hidden="true"
        style={{ display: artworkUrl ? 'none' : undefined }}
      >♪</span>
      <span className="min-w-0 overflow-hidden whitespace-nowrap text-cream font-black text-base text-left">{track.title}</span>
    </div>
  )
}

function ReadyTrackLanes({ tracks }: { tracks: Track[] }) {
  const viewportSize = useViewportSize()
  const laneHeight = 72
  const reservedHeight = 300
  const laneCount = Math.max(1, Math.floor((viewportSize.height - reservedHeight) / laneHeight))
  const lanes = useMemo(() => {
    const tracksPerLane = Math.ceil(tracks.length / laneCount)
    return Array.from({ length: laneCount }, (_, index) => {
      const start = index * tracksPerLane
      return tracks.slice(start, start + tracksPerLane)
    }).filter((lane) => lane.length > 0)
  }, [laneCount, tracks])

  return (
    <div className="w-full shrink-0" aria-label="選択中の曲">
      <div
        className="w-full min-h-0 grid grid-rows-[repeat(var(--lane-count),64px)] gap-2 overflow-hidden mask-x-from-92% mask-x-to-100%"
        style={{ '--lane-count': lanes.length } as CSSProperties}
      >
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
  const connected = useConnected()
  const participatingPlayers = state.players
  const roundTrack = roundTrackFromState(state)

  const showReadyTracks = state.phase === 'ready' && state.tracks.length > 0
  const sortedPlayers = [...participatingPlayers].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const players = <GameboardPlayers players={participatingPlayers} answererId={state.answererId} />

  // ボード上の共通レイアウトはユーティリティ束を定数化して step ごとに付け替える。
  const TITLE = 'text-5xl sm:text-7xl font-black leading-none tracking-tighter mx-auto'
  const READY_TITLE = 'text-4xl sm:text-6xl font-black leading-none tracking-tighter mx-auto text-center'
  const CARD = `${GLASS} w-full max-w-5xl rounded-3xl text-center p-6 sm:p-12`
  // gameboard のカードは常に親 main の高さへ広げる。STAGE 側を flex-1 で伸ばし、players は下に自然に積む(grid テンプレ不要)。
  const CARD_GB = `${CARD} flex-1 min-h-0 flex flex-col items-center justify-center gap-6`
  const CARD_PLAYERS = CARD_GB
  // ready 盤は親 main の flex-col 内で flex-1 して縦いっぱいに伸びる(明示高さ不要)。
  const CARD_READY = `${GLASS} text-center w-full max-w-7xl rounded-3xl flex flex-col items-center justify-center gap-6 overflow-hidden p-4 sm:p-8 flex-1 min-h-0`
  const STAGE = 'w-full min-h-0 flex-1 grid place-items-center'
  const SYMBOL = 'text-9xl font-black leading-none'
  // glow-icon::before を before: ユーティリティで再現。色は使用箇所で before:bg-... を足す。
  const GLOW = "relative isolate before:content-[''] before:absolute before:-z-10 before:left-1/2 before:top-1/2 before:-translate-x-1/2 before:-translate-y-1/2 before:size-80 before:rounded-full before:blur-3xl before:pointer-events-none"
  const EFFECT = 'text-9xl font-black tracking-tighter mb-8'

  let content: ReactNode
  let cardClassName = CARD_GB

  if (state.phase === 'initialization') {
    content = (
      <>
        <h1 className={READY_TITLE}>ボタンを押してご参加ください</h1>
        {players}
      </>
    )
  } else if (state.phase === 'ready') {
    cardClassName = showReadyTracks ? CARD_READY : CARD_GB
    content = (
      <>
        <h1 className={READY_TITLE}>ボタンを押してご参加ください</h1>
        {showReadyTracks && <ReadyTrackLanes tracks={state.tracks} />}
        {players}
      </>
    )
  } else if (state.step === 'loading') {
    content = <h1 className={TITLE}>曲を準備中</h1>
  } else if (state.step === 'beforePlayback') {
    cardClassName = CARD_PLAYERS
    content = (
      <>
        <div className={STAGE}><div className={`${SYMBOL} text-cream/30`}>♪</div></div>
        {players}
      </>
    )
  } else if (state.step === 'playing') {
    cardClassName = CARD_PLAYERS
    content = (
      <>
        <div className={STAGE}><div className={`${SYMBOL} text-amber animate-symbol-pulse ${GLOW} before:bg-amber/30`}>♪</div></div>
        {players}
      </>
    )
  } else if (state.step === 'answering') {
    cardClassName = CARD_PLAYERS
    const answererColor = state.answererId ? playerColor(state.answererId).background : null
    content = (
      <>
        <div className={`${STAGE} content-center gap-8`}>
          <h1 className={TITLE}>解答をどうぞ！</h1>
          {state.answererId && answererColor && (
            <PersonGlyph
              color={answererColor}
              className="w-40 h-56 mx-auto"
              style={{ filter: `drop-shadow(0 0 72px ${answererColor})` }}
              label={state.answererId}
            />
          )}
        </div>
        {players}
      </>
    )
  } else if (state.step === 'correct') {
    cardClassName = CARD_PLAYERS
    content = (
      <>
        <div className={STAGE}><div className={`${EFFECT} text-mint ${GLOW} before:bg-mint/30`}>○</div></div>
        {players}
      </>
    )
  } else if (state.step === 'wrong') {
    cardClassName = CARD_PLAYERS
    content = (
      <>
        <div className={STAGE}><div className={`${EFFECT} text-rose ${GLOW} before:bg-pink/30`}>×</div></div>
        {players}
      </>
    )
  } else if (state.step === 'reveal' && roundTrack) {
    content = (
      <div className="rounded-3xl p-5 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10 grid justify-items-center gap-4">
        <TrackArtwork track={roundTrack} />
        <strong className="block text-3xl sm:text-5xl font-bold leading-tight">{roundTrack.title}</strong>
        <span className="block mt-2.5 text-subtle">{roundTrack.artist}</span>
      </div>
    )
  } else if (state.step === 'results') {
    content = (
      <>
        <h1 className="text-5xl sm:text-7xl font-black leading-none mx-auto text-center">結果発表！</h1>
        <div className="flex justify-center items-end gap-8 sm:gap-16 flex-wrap">
          {sortedPlayers.map((player) => (
            <div className="grid justify-items-center gap-4" key={player.id}>
              <div className="m-8">
                <PlayerBadge id={player.id} label={false} variant="gameboard" size="large" />
              </div>
              <strong className="text-6xl sm:text-7xl font-black text-amber leading-none">{player.score}</strong>
            </div>
          ))}
        </div>
      </>
    )
  } else {
    content = <h1 className={TITLE}>待機中</h1>
  }

  // playing / correct / wrong だけ背景色を切り替える。他 step は body のグラデを透かす。
  const stepBg = state.step === 'correct' ? 'bg-board-correct' : state.step === 'wrong' ? 'bg-board-wrong' : state.step === 'playing' ? 'bg-ink' : ''

  return (
    <main className={`min-h-svh flex flex-col items-center justify-center p-4 sm:p-6 transition-colors duration-300 ${stepBg}`}>
      {!connected && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 rounded-full text-sm font-bold tracking-wide text-amber bg-ink/90 shadow-lg ring-1 ring-amber/40" role="status">再接続中…</div>}
      <section className={cardClassName}>
        {content}
      </section>
    </main>
  )
}

const homeLinks = [
  { path: '/console', label: 'ホストコンソール', eyebrow: 'Host' },
  { path: '/gameboard', label: 'ゲームボード', eyebrow: 'Screen' },
  { path: '/action', label: '早押しボタン', eyebrow: 'Player' },
] as const

function HomePage() {
  const links = homeLinks.map((link) => ({
    ...link,
    url: new URL(link.path, window.location.origin).toString(),
  }))

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 min-h-svh grid content-center gap-6">
      <header className="grid gap-3">
        <h1 className="m-0 text-4xl sm:text-6xl font-black tracking-tighter">早押しイントロクイズ</h1>
        <p className="m-0 text-subtle leading-loose">PCでサーバーを起動し、スマホはホスト操作、スクリーンはゲームボード、物理ボタンはAPIにアクセスします。</p>
      </header>
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4" aria-label="各ページへのリンク">
        {links.map((link) => (
          <article className={`${GLASS} rounded-2xl p-5 min-w-0`} key={link.path}>
            <div className="min-w-0">
              <p className={EYEBROW}>{link.eyebrow}</p>
              <h2 className="m-0 text-2xl font-black leading-tight">
                <a className="text-cream underline underline-offset-4 decoration-white/45 outline-none transition hover:text-amber hover:decoration-amber focus-visible:text-amber focus-visible:decoration-amber" href={link.path} target="_blank" rel="noreferrer">{link.label}</a>
              </h2>
            </div>
            <div className="mt-5 grid place-items-center rounded-2xl border border-white/10 bg-black/40 p-4 shadow-inner shadow-black/30">
              <QRCodeSVG
                className="block h-auto drop-shadow-[0_0_18px_rgba(247,242,234,0.14)]"
                value={link.url}
                size={176}
                level="M"
                bgColor="transparent"
                fgColor="#f7f2ea"
                marginSize={4}
                title={`${link.label} ${link.url}`}
              />
            </div>
            <p className="mt-4 mb-0 min-h-10 select-text break-all text-xs leading-relaxed text-muted">{link.url}</p>
          </article>
        ))}
      </section>
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

  const playActionButtonSound = async () => {
    const AudioContextCtor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return
    audioContextRef.current ??= new AudioContextCtor()
    const audioContext = audioContextRef.current
    if (audioContext.state === 'suspended') await audioContext.resume()

    const now = audioContext.currentTime
    const master = audioContext.createGain()
    master.gain.setValueAtTime(0.58, now)
    master.connect(audioContext.destination)

    const playTone = ({
      frequency,
      offset,
      duration,
      level,
      type = 'sine',
      attack = 0.008,
      hold = 0.04,
      sustain = 0.42,
    }: {
      frequency: number
      offset: number
      duration: number
      level: number
      type?: OscillatorType
      attack?: number
      hold?: number
      sustain?: number
    }) => {
      const oscillator = audioContext.createOscillator()
      const gain = audioContext.createGain()
      const start = now + offset
      oscillator.type = type
      oscillator.frequency.setValueAtTime(frequency, start)
      gain.gain.setValueAtTime(0.001, start)
      gain.gain.exponentialRampToValueAtTime(level, start + attack)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level * sustain), start + attack + hold)
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
      oscillator.connect(gain)
      gain.connect(master)
      oscillator.start(start)
      oscillator.stop(start + duration + 0.03)
    }

    playTone({ frequency: 802.1, offset: 0, duration: 1.42, level: 0.32, attack: 0.01, hold: 0.2, sustain: 0.56 })
    playTone({ frequency: 4226, offset: 0, duration: 0.32, level: 0.18, attack: 0.006, hold: 0.04, sustain: 0.18 })
    playTone({ frequency: 2153, offset: 0.004, duration: 0.34, level: 0.06, attack: 0.008, hold: 0.06, sustain: 0.22 })

    playTone({ frequency: 636.6, offset: 0.125, duration: 1.46, level: 0.3, attack: 0.045, hold: 0.18, sustain: 0.62 })
    playTone({ frequency: 1273.2, offset: 0.12, duration: 0.42, level: 0.055, attack: 0.025, hold: 0.04, sustain: 0.2 })
    playTone({ frequency: 3354, offset: 0.118, duration: 0.34, level: 0.06, attack: 0.018, hold: 0.035, sustain: 0.18 })
    playTone({ frequency: 5645, offset: 0.13, duration: 0.24, level: 0.02, attack: 0.025, hold: 0.025, sustain: 0.14 })
    window.setTimeout(() => {
      try {
        master.disconnect()
      } catch {
        // The audio graph may already be released by the browser.
      }
    }, 1700)
  }

  const act = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/act/' + encodeURIComponent(actorId), { method: 'POST' })
      if (res.status === 200) {
        await playActionButtonSound()
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

  const circleFx = visualState === 'pressed' ? 'animate-action-pop' : visualState === 'muted' ? 'opacity-60' : ''

  return (
    <main
      className="min-h-dvh overflow-hidden grid"
      style={{
        '--player-color-soft': color.softBackground,
        '--player-color-glow': `hsl(${color.hue} 76% 52% / 0.46)`,
      } as CSSProperties}
    >
      <button
        className="grid place-items-center text-inherit cursor-pointer transition touch-manipulation disabled:cursor-wait disabled:opacity-100"
        style={{ backgroundColor: visualState === 'pressed' ? color.softBackground : 'transparent' }}
        type="button"
        disabled={busy}
        onClick={act}
        aria-label="早押しボタン"
      >
        <span
          className={`block size-72 rounded-full ${circleFx}`}
          style={{
            backgroundColor: visualState === 'error' ? '#ff8aa3' : color.background,
            boxShadow: '0 24px 80px var(--player-color-glow), inset 0 0 0 12px rgba(255,255,255,0.22)',
          }}
          aria-hidden="true"
        />
      </button>
    </main>
  )
}

// ここが要点だ！ルートごとに表示するタイトルを 1 か所にまとめておく。
const routeTitles: Record<string, string> = {
  '/console': 'ホストコンソール | 早押しイントロクイズ',
  '/gameboard': 'ゲームボード | 早押しイントロクイズ',
  '/action': '早押しボタン | 早押しイントロクイズ',
}
const defaultTitle = '早押しイントロクイズ'

export default function App() {
  const path = window.location.pathname
  const pageTitle = routeTitles[path] ?? defaultTitle

  let page: ReactNode
  if (path === '/console') page = <ConsolePage />
  else if (path === '/gameboard') page = <GameboardPage />
  else if (path === '/action') page = <ActionPage />
  else page = <HomePage />

  return (
    <>
      <title>{pageTitle}</title>
      {page}
    </>
  )
}

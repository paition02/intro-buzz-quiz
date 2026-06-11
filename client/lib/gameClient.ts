import { useCallback, useRef, useSyncExternalStore } from 'react'
import { io } from 'socket.io-client'
import type { Socket } from 'socket.io-client'
import type { GameState, GameStep, Phase } from '../../type/game'

export const initialState: GameState = {
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

export function roundTrackIdFromState(state: GameState) {
  return state.roundIndex >= 0 ? state.shuffledTrackIds[state.roundIndex] ?? null : null
}

export function roundTrackFromState(state: GameState) {
  const trackId = roundTrackIdFromState(state)
  if (trackId == null) return null
  return state.tracks.find((track) => track.id === trackId) ?? null
}

export function roundPreparationKeyFromState(state: GameState) {
  const trackId = roundTrackIdFromState(state)
  if (state.phase !== 'game' || state.roundIndex < 0 || trackId == null) return null
  return `${state.shuffledTrackIds.join('')}#${state.roundIndex}#${trackId}`
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

export function consoleStatusMessage(state: GameState, playbackSeconds: number) {
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

export function phaseLabel(phase: Phase, step: GameStep) {
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

// サーバが唯一の真実(single source of truth)。ここが肝心なんだ!
// socket と 'state' リスナーはモジュール読込時に"同期で"張る。io() の直後に on('state') を
// 張るから、接続ハンドシェイク完了(=最初の state 到着)より必ず先にリスナーが居る。
// 旧実装は初回レンダー後に張っていたので、接続がレンダーを追い越すと
// 初回 state を取りこぼし、gameboard が固まることがあった。それを構造ごと潰す。
const socket: Socket = io()

// socket から届いた最新 state はモジュールで保持し、useGameState が React state として返す。
// onChange には前回から変わった GameState の key だけを渡す。
export let latestState: GameState = initialState
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

export function useGameState(onChange?: (change: Partial<GameState>) => void | Promise<void>) {
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

export function useConnected() {
  return useSyncExternalStore(subscribeConnected, () => connected)
}

export function consoleAction(event: string, body?: unknown): Promise<void> {
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

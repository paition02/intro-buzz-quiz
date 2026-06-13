import { useEffect, useRef, useState, type ReactNode } from 'react'
import { roundTrackFromState, useConnected, useGameState } from '../lib/gameClient'
import { useScreenWakeLock } from '../useScreenWakeLock'
import { playerColor } from '../lib/util'
import { Glass } from '../components/Glass'
import { PersonGlyph } from '../components/Glyphs'
import { PlayerBadge } from '../components/PlayerBadge'
import { GameboardPlayers } from '../components/GameboardPlayers'
import { ReadyTrackLanes, TrackArtwork } from '../components/TrackDisplay'

export function GameboardPage() {
  useScreenWakeLock()

  const state = useGameState()
  const connected = useConnected()
  const boardRef = useRef<HTMLElement>(null)
  const hideFullscreenButtonRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const [fullscreenButtonVisible, setFullscreenButtonVisible] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const participatingPlayers = state.players
  const roundTrack = roundTrackFromState(state)

  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    handleFullscreenChange()

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (hideFullscreenButtonRef.current) window.clearTimeout(hideFullscreenButtonRef.current)
    }
  }, [])

  const revealFullscreenButton = () => {
    setFullscreenButtonVisible(true)
    if (hideFullscreenButtonRef.current) window.clearTimeout(hideFullscreenButtonRef.current)
    hideFullscreenButtonRef.current = window.setTimeout(() => {
      setFullscreenButtonVisible(false)
      hideFullscreenButtonRef.current = null
    }, 1800)
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await boardRef.current?.requestFullscreen({ navigationUI: 'hide' })
      }
    } catch (error) {
      console.warn('Fullscreen toggle failed', error)
    }
  }

  const showReadyTracks = state.phase === 'ready' && state.tracks.length > 0
  const sortedPlayers = [...participatingPlayers].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const players = <GameboardPlayers players={participatingPlayers} answererId={state.answererId} />

  // ボード上の共通レイアウトはユーティリティ束を定数化して step ごとに付け替える。
  const TITLE = 'text-5xl sm:text-7xl font-black leading-none tracking-tighter mx-auto'
  const READY_TITLE = 'text-4xl sm:text-6xl font-black leading-none tracking-tighter mx-auto text-center'
  const CARD = 'w-full rounded-3xl text-center p-6 sm:p-12'
  // gameboard のカードは常に親 main の高さへ広げる。STAGE 側を flex-1 で伸ばし、players は下に自然に積む(grid テンプレ不要)。
  const CARD_GB = `${CARD} flex-1 min-h-0 flex flex-col items-center justify-center gap-6`
  const CARD_PLAYERS = CARD_GB
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
      <div className="rounded-3xl p-7 sm:p-10 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10 grid justify-items-center gap-4">
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

  // playing / correct / wrong だけ背景色を切り替える。他 step は gameboard 自体のグラデを使う。
  const boardTone = state.step === 'correct' ? 'correct' : state.step === 'wrong' ? 'wrong' : state.step === 'playing' ? 'playing' : 'default'

  return (
    <main
      ref={boardRef}
      className="gameboard-screen min-h-svh flex flex-col items-center justify-center p-4 sm:p-6 xl:p-10 2xl:p-14 transition-colors duration-300"
      data-board-tone={boardTone}
      onPointerEnter={revealFullscreenButton}
      onPointerMove={revealFullscreenButton}
    >
      {!connected && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 rounded-full text-sm font-bold tracking-wide text-amber bg-ink/90 shadow-lg ring-1 ring-amber/40" role="status">再接続中…</div>}
      <button
        type="button"
        className={`fixed top-4 right-4 z-20 grid size-11 place-items-center rounded-full border border-white/10 bg-ink/60 text-cream/75 shadow-lg shadow-black/20 backdrop-blur-md transition duration-300 hover:bg-white/10 hover:text-cream focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber ${fullscreenButtonVisible ? 'opacity-80 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        aria-label={isFullscreen ? 'フルスクリーンを解除' : 'フルスクリーンにする'}
        title={isFullscreen ? 'フルスクリーンを解除' : 'フルスクリーンにする'}
        onClick={toggleFullscreen}
        onFocus={revealFullscreenButton}
      >
        <FullscreenGlyph active={isFullscreen} />
      </button>
      <Glass as="section" className={cardClassName}>
        {content}
      </Glass>
    </main>
  )
}

function FullscreenGlyph({ active }: { active: boolean }) {
  if (active) {
    return (
      <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 3v6H3" />
        <path d="M15 3v6h6" />
        <path d="M9 21v-6H3" />
        <path d="M15 21v-6h6" />
      </svg>
    )
  }

  return (
    <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3H3v5" />
      <path d="M16 3h5v5" />
      <path d="M8 21H3v-5" />
      <path d="M16 21h5v-5" />
    </svg>
  )
}

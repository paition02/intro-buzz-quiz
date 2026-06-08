import type { ReactNode } from 'react'
import { roundTrackFromState, useConnected, useGameState } from '../lib/gameClient'
import { playerColor } from '../lib/util'
import { GLASS } from '../lib/styles'
import { PersonGlyph } from '../components/Glyphs'
import { PlayerBadge } from '../components/PlayerBadge'
import { GameboardPlayers } from '../components/GameboardPlayers'
import { ReadyTrackLanes, TrackArtwork } from '../components/TrackDisplay'

export function GameboardPage() {
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

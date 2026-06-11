import { playerColor } from '../lib/util'
import { PersonGlyph } from './Glyphs'

export function PlayerBadge({ id, active = false, entering = false, label = true, score, variant = 'console', size = 'normal' }: { id: string; active?: boolean; entering?: boolean; label?: boolean; score?: number; variant?: 'console' | 'gameboard'; size?: 'normal' | 'large' }) {
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

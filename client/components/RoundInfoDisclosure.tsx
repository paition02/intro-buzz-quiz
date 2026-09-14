import type { Album, Track } from '../../type/game'
import { ChevronGlyph } from './Glyphs'

const PANEL_ID = 'console-round-info'

export function RoundInfoDisclosure({
  expanded,
  onToggle,
  item,
  kind,
}: {
  expanded: boolean
  onToggle: () => void
  item: Track | Album | null
  kind: 'track' | 'album'
}) {
  const label = kind === 'album' ? 'アルバム情報' : '曲情報'
  const emptyMessage = kind === 'album' ? 'まだアルバムは準備されていません。' : 'まだ曲は準備されていません。'
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-2xl font-bold">{label}</h2>
        {item && (
          <button
            type="button"
            className={`size-10 shrink-0 grid place-items-center rounded-full border border-white/10 cursor-pointer transition ${expanded ? 'bg-white/10 text-amber' : 'bg-white/5 text-cream'}`}
            onClick={onToggle}
            aria-controls={PANEL_ID}
            aria-expanded={expanded}
            aria-label={`${label}を${expanded ? '閉じる' : '開く'}`}
            title={`${label}を${expanded ? '閉じる' : '開く'}`}
          >
            <ChevronGlyph color={expanded ? '#ffb14e' : '#f7f2ea'} className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {item ? (
        expanded && (
          <div id={PANEL_ID} className="flex items-center gap-4 mt-2.5 rounded-2xl p-5 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10">
            {(item.artworkInfoUrl ?? item.artworkRevealUrl ?? item.artworkChipUrl) ? (
              <img
                className="size-24 rounded-xl shrink-0 object-cover bg-linear-to-br from-pink to-amber"
                src={item.artworkInfoUrl ?? item.artworkRevealUrl ?? item.artworkChipUrl}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="size-24 rounded-xl shrink-0 grid place-items-center bg-linear-to-br from-pink to-amber text-cocoa text-4xl font-black" aria-hidden="true">♪</span>
            )}
            <div className="min-w-0 break-words">
              <strong className="block text-2xl font-bold leading-tight">{'name' in item ? item.name : item.title}</strong>
              <span className="block mt-2.5 text-subtle">{item.artist}</span>
            </div>
          </div>
        )
      ) : <p className="mt-2.5 text-subtle leading-relaxed">{emptyMessage}</p>}
    </>
  )
}

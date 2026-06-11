import type { Track } from '../../type/game'
import { ChevronGlyph } from './Glyphs'

const PANEL_ID = 'console-round-track-info'

export function RoundTrackDisclosure({
  expanded,
  onToggle,
  track,
}: {
  expanded: boolean
  onToggle: () => void
  track: Track | null
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-2xl font-bold">曲情報</h2>
        {track && (
          <button
            type="button"
            className={`size-10 shrink-0 grid place-items-center rounded-full border border-white/10 cursor-pointer transition ${expanded ? 'bg-white/10 text-amber' : 'bg-white/5 text-cream'}`}
            onClick={onToggle}
            aria-controls={PANEL_ID}
            aria-expanded={expanded}
            aria-label={expanded ? '曲情報を閉じる' : '曲情報を開く'}
            title={expanded ? '曲情報を閉じる' : '曲情報を開く'}
          >
            <ChevronGlyph color={expanded ? '#ffb14e' : '#f7f2ea'} className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
      {track ? (
        expanded && (
          <div id={PANEL_ID} className="flex items-center gap-4 mt-2.5 rounded-2xl p-5 bg-linear-to-br from-pink/20 to-sky/20 border border-white/10">
            {(track.artworkInfoUrl ?? track.artworkRevealUrl ?? track.artworkChipUrl) ? (
              <img
                className="size-24 rounded-xl shrink-0 object-cover bg-linear-to-br from-pink to-amber"
                src={track.artworkInfoUrl ?? track.artworkRevealUrl ?? track.artworkChipUrl}
                alt=""
                loading="lazy"
              />
            ) : (
              <span className="size-24 rounded-xl shrink-0 grid place-items-center bg-linear-to-br from-pink to-amber text-cocoa text-4xl font-black" aria-hidden="true">♪</span>
            )}
            <div className="min-w-0">
              <strong className="block text-2xl font-bold leading-tight">{track.title}</strong>
              <span className="block mt-2.5 text-subtle">{track.artist}</span>
            </div>
          </div>
        )
      ) : <p className="mt-2.5 text-subtle leading-relaxed">まだ曲は準備されていません。</p>}
    </>
  )
}

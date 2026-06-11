import { memo, useCallback, useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { Track } from '../../type/game'

export function TrackArtwork({ track }: { track: Track }) {
  // 正解発表カードの大きいアートワーク。チップ内の小さいものとは別サイズ。
  const base = 'size-64 sm:size-72 rounded-3xl shrink-0 object-cover bg-linear-to-br from-pink to-amber'
  const artworkUrl = track.artworkRevealUrl ?? track.artworkInfoUrl ?? track.artworkChipUrl
  return artworkUrl
    ? <img className={base} src={artworkUrl} alt="" loading="lazy" />
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

function trackChipArtworkUrl(track: Track) {
  return track.artworkChipUrl ?? track.artworkInfoUrl ?? track.artworkRevealUrl
}

function TrackChip({ track }: { track: Track }) {
  const artworkUrl = trackChipArtworkUrl(track)
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

function sameTrackChipAreaTracks(previous: Track[], next: Track[]) {
  if (previous === next) return true
  if (previous.length !== next.length) return false

  return previous.every((track, index) => {
    const nextTrack = next[index]
    return track.id === nextTrack.id
      && track.title === nextTrack.title
      && trackChipArtworkUrl(track) === trackChipArtworkUrl(nextTrack)
  })
}

function ReadyTrackLanesComponent({ tracks }: { tracks: Track[] }) {
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

// Socket.IO delivers fresh object references on every state event; compare the rendered chip data instead.
export const ReadyTrackLanes = memo(ReadyTrackLanesComponent, (previous, next) => (
  sameTrackChipAreaTracks(previous.tracks, next.tracks)
))

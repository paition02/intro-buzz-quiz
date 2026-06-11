import { useState } from 'react'
import { Activity } from 'react'
import { useLibraryPlaylistsQuery, usePlaylistTracksQuery, type MusicPlaylist } from '../useMusicKitLibraryQueries'
import { ChevronGlyph, CheckGlyph } from './Glyphs'

export function PlaylistTracksPanel({ playlistId }: { playlistId: string }) {
  const tracksQuery = usePlaylistTracksQuery(playlistId)
  const tracks = tracksQuery.data
  const error = tracksQuery.error
  const loading = tracksQuery.isPending || tracksQuery.isFetching

  return (
    <div className="mt-2 p-2.5 rounded-xl bg-black/20 border border-white/10 max-h-72 overflow-y-auto">
      {loading && <p className="text-muted">曲を読み込み中...</p>}
      {!loading && error && <p className="text-rose font-bold">{error instanceof Error ? error.message : String(error)}</p>}
      {!loading && !error && tracks?.length === 0 && <p className="text-muted">曲がありません</p>}
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

export function PlaylistListItem({
  playlist,
  selected,
  expanded,
  busy,
  onSelect,
  onToggleExpanded,
}: {
  playlist: MusicPlaylist
  selected: boolean
  expanded: boolean
  busy: boolean
  onSelect: (playlist: MusicPlaylist) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}) {
  return (
    <li className="rounded-2xl bg-white/5" key={playlist.id}>
      <div className={`w-full rounded-2xl border flex items-stretch overflow-hidden text-cream ${selected ? 'bg-amber/20 border-amber/50' : 'bg-white/5 border-white/10'}`}>
        <button
          type="button"
          className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-inherit border-0 flex justify-start items-center gap-2.5 text-left cursor-pointer disabled:cursor-not-allowed"
          disabled={busy}
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
          disabled={busy}
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

export function PlaylistLibraryBrowser({
  playlists,
  busy,
  expandedPlaylistIds,
  selectedPlaylistIdSet,
  onSelect,
  onToggleExpanded,
}: {
  playlists: MusicPlaylist[]
  busy: boolean
  expandedPlaylistIds: Set<string>
  selectedPlaylistIdSet: Set<string>
  onSelect: (playlist: MusicPlaylist) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}) {
  const [search, setSearch] = useState('')

  const normalizedSearch = search.trim().toLowerCase()
  const visiblePlaylists = normalizedSearch
    ? playlists.filter((playlist) => playlist.name.toLowerCase().includes(normalizedSearch))
    : playlists

  return (
    <>
      <input
        type="search"
        className="w-full rounded-2xl border border-white/10 bg-black/20 text-white px-4 py-3 disabled:opacity-60"
        placeholder="プレイリスト名で検索"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        disabled={busy}
      />
      <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
        {visiblePlaylists.length ? visiblePlaylists.map((playlist) => (
          <PlaylistListItem
            busy={busy}
            expanded={expandedPlaylistIds.has(playlist.id)}
            key={playlist.id}
            onSelect={onSelect}
            onToggleExpanded={onToggleExpanded}
            playlist={playlist}
            selected={selectedPlaylistIdSet.has(playlist.id)}
          />
        )) : <li className="text-muted">一致するプレイリストがありません</li>}
      </ul>
    </>
  )
}

export function LibraryPlaylistsSection({
  busy,
  expandedPlaylistIds,
  selectedPlaylistIdSet,
  onSelect,
  onToggleExpanded,
}: {
  busy: boolean
  expandedPlaylistIds: Set<string>
  selectedPlaylistIdSet: Set<string>
  onSelect: (playlist: MusicPlaylist, allPlaylists: MusicPlaylist[]) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}) {
  const query = useLibraryPlaylistsQuery()

  if (query.status !== 'success') {
    return (
      <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
        <li className="text-muted">
          {query.status === 'pending'
            ? 'ライブラリのプレイリストを読み込み中...'
            : <span className="text-rose font-bold">{query.error instanceof Error ? query.error.message : String(query.error)}</span>}
        </li>
      </ul>
    )
  }

  return (
    <PlaylistLibraryBrowser
      playlists={query.data}
      busy={busy}
      expandedPlaylistIds={expandedPlaylistIds}
      selectedPlaylistIdSet={selectedPlaylistIdSet}
      onSelect={(playlist) => onSelect(playlist, query.data)}
      onToggleExpanded={onToggleExpanded}
    />
  )
}

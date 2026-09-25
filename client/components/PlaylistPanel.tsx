import { Activity, useMemo, useState, type ReactNode } from 'react'
import {
  PLAYLIST_ROOT_FOLDER_ID,
  useLibraryPlaylistFoldersQuery,
  useLibraryPlaylistsQuery,
  usePlaylistFolderChildrenQuery,
  usePlaylistTracksQuery,
  type MusicPlaylist,
  type MusicPlaylistFolder,
} from '../useMusicKitLibraryQueries'
import { ChevronGlyph, CheckGlyph, FolderGlyph } from './Glyphs'

export function PlaylistTracksPanel({ playlistId }: { playlistId: string }) {
  const tracksQuery = usePlaylistTracksQuery(playlistId)
  const tracks = tracksQuery.data?.tracks
  const error = tracksQuery.error
  const loading = tracksQuery.isPending || tracksQuery.isFetching

  return (
    <div className="mt-2 p-2.5 rounded-xl bg-black/20 border border-white/10 max-h-72 overflow-y-auto">
      {loading && <p className="text-muted">曲を読み込み中...</p>}
      {!loading && error && <p className="text-rose font-bold">{error instanceof Error ? error.message : String(error)}</p>}
      {!loading && !error && tracks?.length === 0 && <p className="text-muted">曲がありません</p>}
      {!loading && !error && !!tracksQuery.data?.unavailableCount && <p className="text-muted">再生できない{tracksQuery.data.unavailableCount}曲を除外しました</p>}
      {!loading && !error && tracks && tracks.length > 0 && (
        <ul className="list-none m-0 p-0 grid gap-2">
          {tracks.map((track, index) => (
            <li className="flex items-center gap-2.5 min-w-0 text-cream" key={`${track.id}-${index}`}>
              <span className="w-7 shrink-0 text-right text-muted tabular-nums">{index + 1}</span>
              {(track.artworkChipUrl ?? track.artworkInfoUrl ?? track.artworkRevealUrl) && (
                <img className="size-9 rounded-lg shrink-0" src={track.artworkChipUrl ?? track.artworkInfoUrl ?? track.artworkRevealUrl} alt="" />
              )}
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

export type PlaylistView = 'list' | 'tree'

type PlaylistItemHandlers = {
  busy: boolean
  expandedPlaylistIds: Set<string>
  selectedPlaylistIdSet: Set<string>
  onSelect: (playlists: MusicPlaylist[]) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}

function PlaylistItem({ playlist, handlers }: { playlist: MusicPlaylist; handlers: PlaylistItemHandlers }) {
  return (
    <PlaylistListItem
      busy={handlers.busy}
      expanded={handlers.expandedPlaylistIds.has(playlist.id)}
      onSelect={(selectedPlaylist) => handlers.onSelect([selectedPlaylist])}
      onToggleExpanded={handlers.onToggleExpanded}
      playlist={playlist}
      selected={handlers.selectedPlaylistIdSet.has(playlist.id)}
    />
  )
}

function PlaylistList({ playlists, search, handlers }: { playlists: MusicPlaylist[]; search: string; handlers: PlaylistItemHandlers }) {
  const visiblePlaylists = search
    ? playlists.filter((playlist) => playlist.name.toLowerCase().includes(search))
    : playlists

  return (
    <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
      {visiblePlaylists.length
        ? visiblePlaylists.map((playlist) => <PlaylistItem handlers={handlers} key={playlist.id} playlist={playlist} />)
        : <li className="text-muted">一致するプレイリストがありません</li>}
    </ul>
  )
}

function PlaylistFolderItem({
  folder,
  leaves,
  open,
  onToggleOpen,
  handlers,
  children,
}: {
  folder: { id: string; name: string }
  leaves: MusicPlaylist[]
  open: boolean
  onToggleOpen: () => void
  handlers: PlaylistItemHandlers
  children: ReactNode
}) {
  const selectedCount = leaves.filter((playlist) => handlers.selectedPlaylistIdSet.has(playlist.id)).length
  const selected = leaves.length > 0 && selectedCount === leaves.length
  const mixed = selectedCount > 0 && !selected

  return (
    <li>
      <div className={`w-full rounded-2xl border flex items-stretch overflow-hidden text-cream ${selected || mixed ? 'bg-amber/20 border-amber/50' : 'bg-white/5 border-white/10'}`}>
        <button
          type="button"
          className="flex-1 min-w-0 px-3 py-2.5 bg-transparent text-inherit border-0 flex justify-start items-center gap-2.5 text-left cursor-pointer disabled:cursor-not-allowed"
          disabled={handlers.busy || leaves.length === 0}
          onClick={() => handlers.onSelect(leaves)}
          aria-pressed={mixed ? 'mixed' : selected}
        >
          <span className={`size-5 rounded-full border-2 inline-grid place-items-center shrink-0 ${selected || mixed ? 'bg-amber border-amber text-cocoa' : 'bg-white/10 border-white/40'}`}>
            {selected && <CheckGlyph className="size-3.5" />}
            {mixed && <span className="w-2.5 h-0.5 rounded-full bg-current" />}
          </span>
          <FolderGlyph className="size-5 shrink-0 text-muted" />
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{folder.name}</span>
        </button>
        <button
          type="button"
          className={`w-12 grid place-items-center border-0 border-l border-white/10 cursor-pointer ${open ? 'bg-white/5 text-amber' : 'bg-transparent text-cream'}`}
          onClick={onToggleOpen}
          aria-expanded={open}
          aria-label={open ? 'フォルダを閉じる' : 'フォルダを開く'}
        >
          <ChevronGlyph color={open ? '#ffb14e' : '#f7f2ea'} className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && (
        <ul className="list-none m-0 mt-2 ml-4 pl-3 grid gap-2 border-l border-white/10">
          {children}
        </ul>
      )}
    </li>
  )
}

type PlaylistTreeContext = {
  playlistById: Map<string, MusicPlaylist>
  folderLeaves: Map<string, MusicPlaylist[]>
  openFolderIds: Set<string>
  onToggleFolder: (folderId: string) => void
  handlers: PlaylistItemHandlers
}

// フォルダの中身は開いたときに取得する。
function PlaylistFolderChildren({ folderId, context }: { folderId: string; context: PlaylistTreeContext }) {
  const query = usePlaylistFolderChildrenQuery(folderId)
  if (query.status === 'pending') return <li className="text-muted">読み込み中...</li>
  if (query.status === 'error') return <li className="text-rose font-bold">{query.error instanceof Error ? query.error.message : String(query.error)}</li>
  if (query.data.length === 0) return <li className="text-muted">プレイリストがありません</li>

  return query.data.map((child) => {
    if (child.type === 'playlist') {
      const playlist = context.playlistById.get(child.id) ?? { id: child.id, name: child.name, parentId: folderId }
      return <PlaylistItem handlers={context.handlers} key={child.id} playlist={playlist} />
    }
    return (
      <PlaylistFolderItem
        folder={child}
        handlers={context.handlers}
        key={child.id}
        leaves={context.folderLeaves.get(child.id) ?? []}
        open={context.openFolderIds.has(child.id)}
        onToggleOpen={() => context.onToggleFolder(child.id)}
      >
        <PlaylistFolderChildren folderId={child.id} context={context} />
      </PlaylistFolderItem>
    )
  })
}

// 検索中は一覧の所属情報 (include=parent) から、一致したプレイリストとその上のフォルダだけを組み立てる。
function PlaylistSearchResults({
  parentId,
  matchedPlaylists,
  folders,
  matchedFolderIds,
  context,
}: {
  parentId: string
  matchedPlaylists: MusicPlaylist[]
  folders: MusicPlaylistFolder[]
  matchedFolderIds: Set<string>
  context: PlaylistTreeContext
}) {
  const childFolders = folders.filter((folder) => folder.parentId === parentId && matchedFolderIds.has(folder.id))
  const childPlaylists = matchedPlaylists.filter((playlist) => playlist.parentId === parentId)
  return (
    <>
      {childFolders.map((folder) => (
        <PlaylistFolderItem
          folder={folder}
          handlers={context.handlers}
          key={folder.id}
          leaves={context.folderLeaves.get(folder.id) ?? []}
          open
          onToggleOpen={() => {}}
        >
          <PlaylistSearchResults parentId={folder.id} matchedPlaylists={matchedPlaylists} folders={folders} matchedFolderIds={matchedFolderIds} context={context} />
        </PlaylistFolderItem>
      ))}
      {childPlaylists.map((playlist) => <PlaylistItem handlers={context.handlers} key={playlist.id} playlist={playlist} />)}
    </>
  )
}

function ancestorFolderIds(parentId: string, folderParentById: Map<string, string>) {
  const ids: string[] = []
  const visited = new Set<string>()
  let current = parentId
  while (current !== PLAYLIST_ROOT_FOLDER_ID && !visited.has(current)) {
    visited.add(current)
    ids.push(current)
    const next = folderParentById.get(current)
    if (next === undefined) break
    current = next
  }
  return ids
}

function PlaylistTree({
  playlists,
  folders,
  search,
  handlers,
}: {
  playlists: MusicPlaylist[]
  folders: MusicPlaylistFolder[]
  search: string
  handlers: PlaylistItemHandlers
}) {
  const [openFolderIds, setOpenFolderIds] = useState<Set<string>>(() => new Set())
  const folderParentById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder.parentId])), [folders])
  // フォルダ単位の選択は、サブフォルダも含めてフォルダ内の全プレイリストを対象にする。
  const folderLeaves = useMemo(() => {
    const leaves = new Map<string, MusicPlaylist[]>()
    for (const playlist of playlists) {
      for (const folderId of ancestorFolderIds(playlist.parentId, folderParentById)) {
        leaves.set(folderId, [...leaves.get(folderId) ?? [], playlist])
      }
    }
    return leaves
  }, [playlists, folderParentById])
  const playlistById = useMemo(() => new Map(playlists.map((playlist) => [playlist.id, playlist])), [playlists])

  const toggleFolder = (folderId: string) => setOpenFolderIds((current) => {
    const next = new Set(current)
    if (next.has(folderId)) next.delete(folderId)
    else next.add(folderId)
    return next
  })
  const context: PlaylistTreeContext = { playlistById, folderLeaves, openFolderIds, onToggleFolder: toggleFolder, handlers }

  if (!search) {
    return (
      <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
        <PlaylistFolderChildren folderId={PLAYLIST_ROOT_FOLDER_ID} context={context} />
      </ul>
    )
  }

  const matchedPlaylists = playlists.filter((playlist) => playlist.name.toLowerCase().includes(search))
  const matchedFolderIds = new Set(matchedPlaylists.flatMap((playlist) => ancestorFolderIds(playlist.parentId, folderParentById)))
  return (
    <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
      {matchedPlaylists.length
        ? <PlaylistSearchResults parentId={PLAYLIST_ROOT_FOLDER_ID} matchedPlaylists={matchedPlaylists} folders={folders} matchedFolderIds={matchedFolderIds} context={context} />
        : <li className="text-muted">一致するプレイリストがありません</li>}
    </ul>
  )
}

function PlaylistQueryPlaceholder({ status, error }: { status: 'pending' | 'error'; error: unknown }) {
  return (
    <ul className="list-none m-0 mt-2.5 p-0 grid gap-2 max-h-80 overflow-y-auto">
      <li className="text-muted">
        {status === 'pending'
          ? 'ライブラリのプレイリストを読み込み中...'
          : <span className="text-rose font-bold">{error instanceof Error ? error.message : String(error)}</span>}
      </li>
    </ul>
  )
}

type LibraryPlaylistsProps = {
  search: string
  handlers: Omit<PlaylistItemHandlers, 'onSelect'>
  onSelect: (playlists: MusicPlaylist[], allPlaylists: MusicPlaylist[]) => void
}

function LibraryPlaylistList({ search, handlers, onSelect }: LibraryPlaylistsProps) {
  const query = useLibraryPlaylistsQuery()
  if (query.status !== 'success') return <PlaylistQueryPlaceholder status={query.status} error={query.error} />
  return <PlaylistList playlists={query.data} search={search} handlers={{ ...handlers, onSelect: (playlists) => onSelect(playlists, query.data) }} />
}

function LibraryPlaylistTree({ search, handlers, onSelect }: LibraryPlaylistsProps) {
  const playlistsQuery = useLibraryPlaylistsQuery()
  const foldersQuery = useLibraryPlaylistFoldersQuery()
  if (playlistsQuery.status !== 'success') return <PlaylistQueryPlaceholder status={playlistsQuery.status} error={playlistsQuery.error} />
  if (foldersQuery.status !== 'success') return <PlaylistQueryPlaceholder status={foldersQuery.status} error={foldersQuery.error} />
  return (
    <PlaylistTree
      playlists={playlistsQuery.data}
      folders={foldersQuery.data}
      search={search}
      handlers={{ ...handlers, onSelect: (playlists) => onSelect(playlists, playlistsQuery.data) }}
    />
  )
}

export function LibraryPlaylistsSection({
  view,
  busy,
  expandedPlaylistIds,
  selectedPlaylistIdSet,
  onSelect,
  onToggleExpanded,
}: {
  view: PlaylistView
  busy: boolean
  expandedPlaylistIds: Set<string>
  selectedPlaylistIdSet: Set<string>
  onSelect: (playlists: MusicPlaylist[], allPlaylists: MusicPlaylist[]) => void
  onToggleExpanded: (playlist: MusicPlaylist) => void
}) {
  const [search, setSearch] = useState('')
  const normalizedSearch = search.trim().toLowerCase()
  const handlers = { busy, expandedPlaylistIds, selectedPlaylistIdSet, onToggleExpanded }

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
      {view === 'tree'
        ? <LibraryPlaylistTree search={normalizedSearch} handlers={handlers} onSelect={onSelect} />
        : <LibraryPlaylistList search={normalizedSearch} handlers={handlers} onSelect={onSelect} />}
    </>
  )
}

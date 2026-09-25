import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useMusicKitAuth, useMusicKitInstance } from './useMusicKit'
import type { Track } from '../type/game'

export const PLAYLIST_ROOT_FOLDER_ID = 'p.playlistsroot'

export type MusicPlaylist = {
  id: string
  name: string
  // 入っているフォルダ。フォルダに入っていなければ PLAYLIST_ROOT_FOLDER_ID。
  parentId: string
}

export type MusicPlaylistFolder = {
  id: string
  name: string
  parentId: string
}

export type MusicPlaylistFolderChild = {
  type: 'folder' | 'playlist'
  id: string
  name: string
}

type MusicApiPage<T> = {
  data?: T[]
  next?: string
  errors?: MusicApiError[]
  message?: string
}

type MusicApiError = {
  detail?: string
  title?: string
  message?: string
}

type MusicApiArtwork = {
  url?: string
}

type MusicApiAttributes = {
  name?: string
  artistName?: string
  albumName?: string
  artwork?: MusicApiArtwork
  playParams?: { id?: string } | null
}

type MusicApiParentRelationship = {
  parent?: {
    data?: Array<{ id: string }>
  }
}

type MusicApiPlaylist = {
  id: string
  attributes?: Pick<MusicApiAttributes, 'name'>
  relationships?: MusicApiParentRelationship
}

type MusicApiPlaylistFolder = {
  id: string
  type: string
  attributes?: Pick<MusicApiAttributes, 'name'>
  relationships?: MusicApiParentRelationship
}

type MusicApiTrack = {
  id: string
  attributes?: MusicApiAttributes
  relationships?: {
    catalog?: {
      data?: MusicApiTrack[]
    }
    albums?: {
      data?: Array<{ id: string; attributes?: Pick<MusicApiAttributes, 'artistName'> }>
    }
  }
}

type MusicApiParams = Record<string, string | number | string[]>

const ARTWORK_CHIP_SIZE = '48x48'
const ARTWORK_INFO_SIZE = '256x256'
const ARTWORK_REVEAL_SIZE = '1024x1024'

function artworkUrlForSize(template: string | undefined, size: string) {
  if (!template) return undefined
  return template.replace('{w}x{h}', size)
}

function musicApiErrorMessage(data: unknown) {
  if (!data || typeof data !== 'object') return null
  const envelope = data as { errors?: MusicApiError[]; message?: unknown }
  const firstError = Array.isArray(envelope.errors) ? envelope.errors[0] : undefined
  return firstError?.detail ?? firstError?.message ?? firstError?.title ?? (typeof envelope.message === 'string' ? envelope.message : null)
}

async function musicApi<T>(mk: MusicKit.MusicKitInstance, url: string, params?: MusicApiParams): Promise<T> {
  const response: { data: T } = await mk.api.music(url, params)
  const message = musicApiErrorMessage(response.data)
  if (message) throw new Error(message)
  return response.data
}

// next には offset しか残らない (limit や include は引き継がれない) ので、毎ページ params を付け直す。
async function fetchPages<T>(mk: MusicKit.MusicKitInstance, firstUrl: string, params: MusicApiParams, invalidMessage: string) {
  const items: T[] = []
  let url: string | null = firstUrl
  const visited = new Set<string>()
  while (url) {
    if (visited.has(url)) throw new Error('ページ取得が循環しています。再読み込みしてください')
    visited.add(url)
    const [path, query = ''] = url.split('?')
    const data: MusicApiPage<T> = await musicApi<MusicApiPage<T>>(mk, path, { ...Object.fromEntries(new URLSearchParams(query)), ...params })
    if (!Array.isArray(data?.data)) throw new Error(invalidMessage)
    items.push(...data.data)
    url = data?.next ?? null
  }
  return items
}

function parentIdOf(resource: { relationships?: MusicApiParentRelationship }) {
  return resource.relationships?.parent?.data?.[0]?.id ?? PLAYLIST_ROOT_FOLDER_ID
}

async function fetchLibraryPlaylists(mk: MusicKit.MusicKitInstance) {
  const playlists = await fetchPages<MusicApiPlaylist>(mk, '/v1/me/library/playlists', { limit: 100, include: 'parent' }, 'プレイリストの取得結果が不正です')
  return playlists.map((playlist): MusicPlaylist => ({
    id: playlist.id,
    name: playlist.attributes?.name ?? playlist.id,
    parentId: parentIdOf(playlist),
  }))
}

// フォルダ API は Apple の公開ドキュメントに無いが、music.apple.com が使っている。
async function fetchLibraryPlaylistFolders(mk: MusicKit.MusicKitInstance) {
  const folders = await fetchPages<MusicApiPlaylistFolder>(mk, '/v1/me/library/playlist-folders', { limit: 100, include: 'parent' }, 'プレイリストフォルダの取得結果が不正です')
  return folders.map((folder): MusicPlaylistFolder => ({
    id: folder.id,
    name: folder.attributes?.name ?? folder.id,
    parentId: parentIdOf(folder),
  }))
}

function isNotFound(error: unknown) {
  return typeof error === 'object' && error !== null && (error as { errorCode?: unknown }).errorCode === 'NOT_FOUND'
}

// フォルダ直下の中身をライブラリ順に取得し、フォルダを前に集める。
async function fetchPlaylistFolderChildren(mk: MusicKit.MusicKitInstance, folderId: string) {
  let children: MusicApiPlaylistFolder[]
  try {
    children = await fetchPages<MusicApiPlaylistFolder>(
      mk,
      `/v1/me/library/playlist-folders/${folderId}/children`,
      { limit: 100 },
      'プレイリストフォルダの取得結果が不正です',
    )
  } catch (error) {
    // 空のフォルダの children は 404 になる。
    if (isNotFound(error)) return []
    throw error
  }
  const nodes = children.flatMap((child): MusicPlaylistFolderChild[] => {
    const name = child.attributes?.name ?? child.id
    if (child.type === 'library-playlist-folders') return [{ type: 'folder', id: child.id, name }]
    if (child.type === 'library-playlists') return [{ type: 'playlist', id: child.id, name }]
    return []
  })
  return [...nodes.filter((node) => node.type === 'folder'), ...nodes.filter((node) => node.type === 'playlist')]
}

async function fetchPlaylistTracks(mk: MusicKit.MusicKitInstance, playlistId: string) {
  const allTracks = await fetchPages<MusicApiTrack>(
    mk,
    `/v1/me/library/playlists/${playlistId}/tracks`,
    { limit: 100, include: 'catalog,albums' },
    '曲の取得結果が不正です',
  )
  const availableTracks = allTracks.filter((track) => {
    const attributes = track.relationships?.catalog?.data?.[0]?.attributes ?? track.attributes
    // An explicit lack of playback parameters means this item cannot play.
    // Older/partial responses without the field do not prove unavailability.
    return !attributes || !('playParams' in attributes) || attributes.playParams != null
  })
  const tracks = availableTracks.map((track): Track => {
    const catalog = track.relationships?.catalog?.data?.[0]
    const artworkTemplate = catalog?.attributes?.artwork?.url ?? track.attributes?.artwork?.url
    return {
      id: catalog?.id ?? track.id,
      title: track.attributes?.name ?? catalog?.attributes?.name ?? '',
      artist: track.attributes?.artistName ?? catalog?.attributes?.artistName ?? '',
      albumName: catalog?.attributes?.albumName ?? track.attributes?.albumName ?? '',
      albumArtist: track.relationships?.albums?.data?.[0]?.attributes?.artistName,
      artworkChipUrl: artworkUrlForSize(artworkTemplate, ARTWORK_CHIP_SIZE),
      artworkInfoUrl: artworkUrlForSize(artworkTemplate, ARTWORK_INFO_SIZE),
      artworkRevealUrl: artworkUrlForSize(artworkTemplate, ARTWORK_REVEAL_SIZE),
    }
  }).filter((track: Track) => track.id && track.title.trim())
  return { tracks, unavailableCount: allTracks.length - availableTracks.length }
}

export function libraryPlaylistsQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean) {
  return queryOptions({
    queryKey: ['musicKit', 'libraryPlaylists', mk === null ? 'no-instance' : 'instance', authorized],
    queryFn: () => mk !== null && authorized ? fetchLibraryPlaylists(mk) : [],
  })
}

export function libraryPlaylistFoldersQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean) {
  return queryOptions({
    queryKey: ['musicKit', 'libraryPlaylists', 'folders', mk === null ? 'no-instance' : 'instance', authorized],
    queryFn: () => mk !== null && authorized ? fetchLibraryPlaylistFolders(mk) : [],
  })
}

export function playlistFolderChildrenQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean, folderId: string) {
  return queryOptions({
    queryKey: ['musicKit', 'libraryPlaylists', 'folderChildren', mk === null ? 'no-instance' : 'instance', authorized, folderId],
    queryFn: () => mk !== null && authorized ? fetchPlaylistFolderChildren(mk, folderId) : [],
  })
}

export function playlistTracksQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean, playlistId: string) {
  return queryOptions({
    queryKey: ['musicKit', 'playlistTracks', mk === null ? 'no-instance' : 'instance', authorized, playlistId],
    queryFn: () => mk !== null && authorized && playlistId.length > 0 ? fetchPlaylistTracks(mk, playlistId) : { tracks: [] as Track[], unavailableCount: 0 },
  })
}

export function useLibraryPlaylistsQuery() {
  const { instance: mk } = useMusicKitInstance()
  const { authorized } = useMusicKitAuth()
  return useQuery(libraryPlaylistsQueryOptions(mk, authorized))
}

export function useLibraryPlaylistFoldersQuery() {
  const { instance: mk } = useMusicKitInstance()
  const { authorized } = useMusicKitAuth()
  return useQuery(libraryPlaylistFoldersQueryOptions(mk, authorized))
}

export function usePlaylistFolderChildrenQuery(folderId: string) {
  const { instance: mk } = useMusicKitInstance()
  const { authorized } = useMusicKitAuth()
  return useQuery(playlistFolderChildrenQueryOptions(mk, authorized, folderId))
}

export function usePlaylistTracksQuery(playlistId: string) {
  const { instance: mk } = useMusicKitInstance()
  const { authorized } = useMusicKitAuth()
  return useQuery(playlistTracksQueryOptions(mk, authorized, playlistId))
}

export function useInvalidateLibraryPlaylists() {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: ['musicKit', 'libraryPlaylists'] }),
    [queryClient],
  )
}

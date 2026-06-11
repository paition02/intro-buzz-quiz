import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useMusicKitAuth, useMusicKitInstance } from './useMusicKit'
import type { Track } from '../type/game'

export type MusicPlaylist = {
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
  artwork?: MusicApiArtwork
}

type MusicApiPlaylist = {
  id: string
  attributes?: Pick<MusicApiAttributes, 'name'>
}

type MusicApiTrack = {
  id: string
  attributes?: MusicApiAttributes
  relationships?: {
    catalog?: {
      data?: MusicApiTrack[]
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

async function fetchLibraryPlaylists(mk: MusicKit.MusicKitInstance) {
  const allPlaylists: MusicApiPlaylist[] = []
  let url: string | null = '/v1/me/library/playlists'
  let params: MusicApiParams | undefined = { limit: 100 }
  while (url) {
    const data: MusicApiPage<MusicApiPlaylist> = await musicApi<MusicApiPage<MusicApiPlaylist>>(mk, url, params)
    allPlaylists.push(...(data?.data ?? []))
    url = data?.next ?? null
    params = undefined
  }
  return allPlaylists.map((playlist): MusicPlaylist => ({
    id: playlist.id,
    name: playlist.attributes?.name ?? playlist.id,
  }))
}

async function fetchPlaylistTracks(mk: MusicKit.MusicKitInstance, playlistId: string) {
  const allTracks: MusicApiTrack[] = []
  let url: string | null = `/v1/me/library/playlists/${playlistId}/tracks`
  let params: MusicApiParams | undefined = { limit: 100, include: 'catalog' }
  while (url) {
    const data: MusicApiPage<MusicApiTrack> = await musicApi<MusicApiPage<MusicApiTrack>>(mk, url, params)
    allTracks.push(...(data?.data ?? []))
    url = data?.next ?? null
    params = undefined
  }
  return allTracks.map((track): Track => {
    const catalog = track.relationships?.catalog?.data?.[0]
    const artworkTemplate = catalog?.attributes?.artwork?.url ?? track.attributes?.artwork?.url
    return {
      id: catalog?.id ?? track.id,
      title: track.attributes?.name ?? catalog?.attributes?.name ?? track.id,
      artist: track.attributes?.artistName ?? catalog?.attributes?.artistName ?? '',
      artworkChipUrl: artworkUrlForSize(artworkTemplate, ARTWORK_CHIP_SIZE),
      artworkInfoUrl: artworkUrlForSize(artworkTemplate, ARTWORK_INFO_SIZE),
      artworkRevealUrl: artworkUrlForSize(artworkTemplate, ARTWORK_REVEAL_SIZE),
    }
  }).filter((track: Track) => track.id)
}

export function libraryPlaylistsQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean) {
  return queryOptions({
    queryKey: ['musicKit', 'libraryPlaylists', mk === null ? 'no-instance' : 'instance', authorized],
    queryFn: () => mk !== null && authorized ? fetchLibraryPlaylists(mk) : [],
  })
}

export function playlistTracksQueryOptions(mk: MusicKit.MusicKitInstance | null, authorized: boolean, playlistId: string) {
  return queryOptions({
    queryKey: ['musicKit', 'playlistTracks', mk === null ? 'no-instance' : 'instance', authorized, playlistId],
    queryFn: () => mk !== null && authorized && playlistId.length > 0 ? fetchPlaylistTracks(mk, playlistId) : [],
  })
}

export function useLibraryPlaylistsQuery() {
  const { instance: mk } = useMusicKitInstance()
  const { authorized } = useMusicKitAuth()
  return useQuery(libraryPlaylistsQueryOptions(mk, authorized))
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

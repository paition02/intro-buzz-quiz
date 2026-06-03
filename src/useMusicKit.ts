import { useCallback, useRef, useSyncExternalStore } from 'react'

type MusicTrack = {
  id: string
  title: string
  artist: string
  playlist: string
  artworkUrl?: string
  artworkThumbUrl?: string
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

type MusicApiSearchResponse = {
  results?: {
    playlists?: MusicApiPage<MusicApiPlaylist>
  }
}

type MusicApiParams = Record<string, string | number | string[]>

const ARTWORK_THUMB_SIZE = '80x80'
const ARTWORK_FULL_SIZE = '1000x1000'
const QUEUE_CHUNK_SIZE = 50

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

async function fetchToken(): Promise<{ token: string; expiresAt: Date }> {
  const res = await fetch('/api/token', { cache: 'no-store' })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? `Token request failed: ${res.status}`)
  return { token: data.token, expiresAt: new Date(data.expiresAt) }
}

function whenMusicKitLoaded(): Promise<typeof MusicKit> {
  if (window.MusicKit) return Promise.resolve(window.MusicKit)
  return new Promise((resolve) => {
    document.addEventListener('musickitloaded', () => resolve(window.MusicKit), { once: true })
  })
}

let musicKitReady: Promise<MusicKit.MusicKitInstance> | null = null

function getMusicKit() {
  musicKitReady ??= whenMusicKitLoaded().then(async (MusicKit) => {
    const { token } = await fetchToken()
    return MusicKit.configure({
      developerToken: token,
      app: { name: 'Intro Buzz Quiz', build: '0.1.0' },
    })
  })
  return musicKitReady
}

type MusicKitStatus = {
  authorized: boolean
  ready: boolean
  error: string | null
  preparing: boolean
  playing: boolean
}

let musicKitStatus: MusicKitStatus = {
  authorized: false,
  ready: false,
  error: null,
  preparing: false,
  playing: false,
}

const musicKitStatusListeners = new Set<() => void>()
let musicKitStatusTrackingStarted = false

function setMusicKitStatus(nextStatus: Partial<MusicKitStatus>) {
  const next = { ...musicKitStatus, ...nextStatus }
  if (
    next.authorized === musicKitStatus.authorized &&
    next.ready === musicKitStatus.ready &&
    next.error === musicKitStatus.error &&
    next.preparing === musicKitStatus.preparing &&
    next.playing === musicKitStatus.playing
  ) return

  musicKitStatus = next
  musicKitStatusListeners.forEach((notify) => notify())
}

function startMusicKitStatusTracking() {
  if (musicKitStatusTrackingStarted) return
  musicKitStatusTrackingStarted = true

  getMusicKit().then((mk) => {
    setMusicKitStatus({ ready: true, authorized: mk.isAuthorized, error: null })
    const handler = () => setMusicKitStatus({ authorized: mk.isAuthorized })
    mk.addEventListener('authorizationStatusDidChange', handler)
  }).catch((e) => {
    setMusicKitStatus({ error: e instanceof Error ? e.message : 'MusicKit configuration failed' })
  })
}

function subscribeMusicKitStatus(notify: () => void) {
  musicKitStatusListeners.add(notify)
  startMusicKitStatusTracking()
  return () => { musicKitStatusListeners.delete(notify) }
}

function getMusicKitStatusSnapshot() {
  return musicKitStatus
}

export function useMusicKitPlayback() {
  const status = useSyncExternalStore(subscribeMusicKitStatus, getMusicKitStatusSnapshot)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tracksRef = useRef<MusicTrack[]>([])
  const loadPromiseRef = useRef<Promise<void>>(Promise.resolve())
  const preparePromiseRef = useRef<Promise<void>>(Promise.resolve())
  const queuedChunkStartRef = useRef<number | null>(null)
  const playbackGenerationRef = useRef(0)

  const authorize = useCallback(async () => {
    const mk = await getMusicKit()
    await mk.authorize()
    setMusicKitStatus({ authorized: mk.isAuthorized })
  }, [])

  const unauthorize = useCallback(async () => {
    const mk = await getMusicKit()
    await mk.unauthorize()
    setMusicKitStatus({ authorized: false })
  }, [])

  const getLibraryPlaylists = useCallback(async () => {
    const mk = await getMusicKit()
    const allPlaylists: MusicApiPlaylist[] = []
    let url: string | null = '/v1/me/library/playlists'
    let params: MusicApiParams | undefined = { limit: 100 }
    while (url) {
      const data: MusicApiPage<MusicApiPlaylist> = await musicApi<MusicApiPage<MusicApiPlaylist>>(mk, url, params)
      allPlaylists.push(...(data?.data ?? []))
      url = data?.next ?? null
      params = undefined
    }
    return allPlaylists.map((playlist) => ({
      id: playlist.id,
      name: playlist.attributes?.name ?? playlist.id,
    }))
  }, [])

  const searchCatalogPlaylists = useCallback(async (term: string) => {
    const mk = await getMusicKit()
    const response = await mk.api.music<MusicApiSearchResponse>('/v1/catalog/{{storefrontId}}/search', {
      term,
      types: 'playlists',
      limit: 10,
    })
    const playlists = response.data.results?.playlists?.data ?? []
    return playlists.map((playlist) => ({
      id: playlist.id,
      name: playlist.attributes?.name ?? playlist.id,
    }))
  }, [])

  const getPlaylistTracks = useCallback(async (playlistId: string, playlistName: string, source: 'library' | 'catalog') => {
    const mk = await getMusicKit()
    const allTracks: MusicApiTrack[] = []
    let url: string | null = source === 'library'
      ? `/v1/me/library/playlists/${playlistId}/tracks`
      : `/v1/catalog/{{storefrontId}}/playlists/${playlistId}/tracks`
    let params: MusicApiParams | undefined = source === 'library' ? { limit: 100, include: 'catalog' } : { limit: 100 }
    while (url) {
      const data: MusicApiPage<MusicApiTrack> = await musicApi<MusicApiPage<MusicApiTrack>>(mk, url, params)
      allTracks.push(...(data?.data ?? []))
      url = data?.next ?? null
      params = undefined
    }
    return allTracks.map((track): MusicTrack => {
      const catalog = track.relationships?.catalog?.data?.[0]
      const artworkTemplate = catalog?.attributes?.artwork?.url ?? track.attributes?.artwork?.url
      return {
        id: catalog?.id ?? track.id,
        title: track.attributes?.name ?? catalog?.attributes?.name ?? track.id,
        artist: track.attributes?.artistName ?? catalog?.attributes?.artistName ?? '',
        playlist: playlistName,
        artworkUrl: artworkUrlForSize(artworkTemplate, ARTWORK_FULL_SIZE),
        artworkThumbUrl: artworkUrlForSize(artworkTemplate, ARTWORK_THUMB_SIZE),
      }
    }).filter((track: MusicTrack) => track.id)
  }, [])

  const prepareQueue = useCallback(async (tracks: MusicTrack[]) => {
    if (tracks.length === 0) throw new Error('曲がありません')
    const mk = await getMusicKit()
    tracksRef.current = tracks
    queuedChunkStartRef.current = null
    setMusicKitStatus({ preparing: true })
    const promise = (async () => {
      try {
        const queueTracks = tracks.slice(0, QUEUE_CHUNK_SIZE)
        mk.shuffleMode = MusicKit.PlayerShuffleMode.off
        await mk.setQueue({ songs: queueTracks.map((track) => track.id), startPlaying: false })
        queuedChunkStartRef.current = 0
        mk.repeatMode = MusicKit.PlayerRepeatMode.one
        loadPromiseRef.current = Promise.resolve()
      } finally {
        setMusicKitStatus({ preparing: false })
      }
    })()
    preparePromiseRef.current = promise
    await promise
  }, [])

  const ensureTrackQueued = useCallback(async (mk: MusicKit.MusicKitInstance, trackIndex: number) => {
    const tracks = tracksRef.current
    if (trackIndex < 0 || trackIndex >= tracks.length) throw new Error('曲のインデックスが不正です')

    const chunkStart = Math.floor(trackIndex / QUEUE_CHUNK_SIZE) * QUEUE_CHUNK_SIZE
    const queueIndex = trackIndex - chunkStart
    if (queuedChunkStartRef.current !== chunkStart) {
      const queueTracks = tracks.slice(chunkStart, chunkStart + QUEUE_CHUNK_SIZE)
      mk.shuffleMode = MusicKit.PlayerShuffleMode.off
      await mk.setQueue({ songs: queueTracks.map((track) => track.id), startPlaying: false })
      queuedChunkStartRef.current = chunkStart
      mk.repeatMode = MusicKit.PlayerRepeatMode.one
    }
    if (mk.nowPlayingItemIndex !== queueIndex) await mk.changeToMediaAtIndex(queueIndex)
  }, [])

  const loadTrack = useCallback((index: number) => {
    playbackGenerationRef.current += 1
    const promise = (async () => {
      await preparePromiseRef.current
      const mk = await getMusicKit()
      await ensureTrackQueued(mk, index)
      if (mk.isPlaying) mk.pause()
      await mk.seekToTime(0)
    })()
    loadPromiseRef.current = promise
    return promise
  }, [ensureTrackQueued])

  const playIntro = useCallback(async (seconds: number) => {
    const generation = ++playbackGenerationRef.current
    const mk = await getMusicKit()
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    await loadPromiseRef.current
    if (generation !== playbackGenerationRef.current) return
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    if (generation !== playbackGenerationRef.current) return
    await mk.play()
    setMusicKitStatus({ playing: true })
    stopTimerRef.current = setTimeout(() => {
      if (generation !== playbackGenerationRef.current) return
      if (mk.isPlaying) mk.pause()
      void mk.seekToTime(0)
      setMusicKitStatus({ playing: false })
    }, seconds * 1000)
  }, [])

  const playFullLoopTrack = useCallback(async (index: number) => {
    const generation = ++playbackGenerationRef.current
    const mk = await getMusicKit()
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    await preparePromiseRef.current
    await ensureTrackQueued(mk, index)
    if (generation !== playbackGenerationRef.current) return
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    if (generation !== playbackGenerationRef.current) return
    mk.repeatMode = MusicKit.PlayerRepeatMode.one
    await mk.play()
    if (generation !== playbackGenerationRef.current) {
      if (mk.isPlaying) mk.pause()
      return
    }
    setMusicKitStatus({ playing: true })
  }, [ensureTrackQueued])

  const stop = useCallback(async () => {
    playbackGenerationRef.current += 1
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
    const mk = await getMusicKit()
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    setMusicKitStatus({ playing: false })
  }, [])

  return {
    authorized: status.authorized,
    ready: status.ready,
    error: status.error,
    preparing: status.preparing,
    playing: status.playing,
    authorize,
    unauthorize,
    getLibraryPlaylists,
    searchCatalogPlaylists,
    getPlaylistTracks,
    prepareQueue,
    loadTrack,
    playIntro,
    playFullLoopTrack,
    stop,
  }
}

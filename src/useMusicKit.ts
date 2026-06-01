import { useCallback, useEffect, useRef, useState } from 'react'

type MusicTrack = {
  id: string
  title: string
  artist: string
  playlist: string
  artworkUrl?: string
}

type MusicApiPage<T> = {
  data?: T[]
  next?: string
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

export function useMusicKitPlayback() {
  const [authorized, setAuthorized] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tracksRef = useRef<MusicTrack[]>([])
  const loadPromiseRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let cleanup: (() => void) | undefined
    getMusicKit().then((mk) => {
      setReady(true)
      setAuthorized(mk.isAuthorized)
      const handler = () => setAuthorized(mk.isAuthorized)
      mk.addEventListener('authorizationStatusDidChange', handler)
      cleanup = () => mk.removeEventListener('authorizationStatusDidChange', handler)
    }).catch((e) => setError(e instanceof Error ? e.message : 'MusicKit configuration failed'))
    return () => cleanup?.()
  }, [])

  const authorize = useCallback(async () => {
    const mk = await getMusicKit()
    await mk.authorize()
    setAuthorized(mk.isAuthorized)
  }, [])

  const unauthorize = useCallback(async () => {
    const mk = await getMusicKit()
    await mk.unauthorize()
    setAuthorized(false)
  }, [])

  const getLibraryPlaylists = useCallback(async () => {
    const mk = await getMusicKit()
    const allPlaylists: MusicApiPlaylist[] = []
    let url: string | null = '/v1/me/library/playlists'
    let params: MusicApiParams | undefined = { limit: 100 }
    while (url) {
      const response: { data: MusicApiPage<MusicApiPlaylist> } = await mk.api.music(url, params)
      const data: MusicApiPage<MusicApiPlaylist> = response.data
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
      const response: { data: MusicApiPage<MusicApiTrack> } = await mk.api.music(url, params)
      const data: MusicApiPage<MusicApiTrack> = response.data
      allTracks.push(...(data?.data ?? []))
      url = data?.next ?? null
      params = undefined
    }
    return allTracks.map((track): MusicTrack => {
      const catalog = track.relationships?.catalog?.data?.[0]
      return {
        id: catalog?.id ?? track.id,
        title: track.attributes?.name ?? catalog?.attributes?.name ?? track.id,
        artist: track.attributes?.artistName ?? catalog?.attributes?.artistName ?? '',
        playlist: playlistName,
        artworkUrl: (catalog?.attributes?.artwork?.url ?? track.attributes?.artwork?.url ?? '').replace('{w}x{h}', '80x80'),
      }
    }).filter((track: MusicTrack) => track.id)
  }, [])

  const prepareQueue = useCallback(async (tracks: MusicTrack[]) => {
    if (tracks.length === 0) throw new Error('曲がありません')
    const mk = await getMusicKit()
    setPreparing(true)
    try {
      tracksRef.current = tracks
      await mk.setQueue({ songs: tracks.map((track) => track.id), startPlaying: false })
      mk.repeatMode = MusicKit.PlayerRepeatMode.one
      loadPromiseRef.current = Promise.resolve()
    } finally {
      setPreparing(false)
    }
  }, [])

  const loadTrack = useCallback((index: number) => {
    const promise = (async () => {
      const mk = await getMusicKit()
      await mk.changeToMediaAtIndex(index)
      if (mk.isPlaying) mk.pause()
      await mk.seekToTime(0)
    })()
    loadPromiseRef.current = promise
    return promise
  }, [])

  const playIntro = useCallback(async (seconds: number) => {
    const mk = await getMusicKit()
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    await loadPromiseRef.current
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    await mk.play()
    setPlaying(true)
    stopTimerRef.current = setTimeout(() => {
      if (mk.isPlaying) mk.pause()
      void mk.seekToTime(0)
      setPlaying(false)
    }, seconds * 1000)
  }, [])

  const stop = useCallback(async () => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current)
    const mk = await getMusicKit()
    if (mk.isPlaying) mk.pause()
    await mk.seekToTime(0)
    setPlaying(false)
  }, [])

  return {
    authorized,
    ready,
    error,
    preparing,
    playing,
    authorize,
    unauthorize,
    getLibraryPlaylists,
    searchCatalogPlaylists,
    getPlaylistTracks,
    prepareQueue,
    loadTrack,
    playIntro,
    stop,
  }
}

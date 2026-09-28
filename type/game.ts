export type Phase = 'initialization' | 'ready' | 'game'

export type QuizMode = 'intro' | 'jacket'

export type JacketMode =
  | 'pixelated'
  | 'missingBlocks'
  | 'tileShuffle'
  | 'circleReveal'
  | 'zoomRotateCrop'
  | 'edgeReveal'

export type GameStep =
  | 'idle'
  | 'loading'
  | 'beforePlayback'
  | 'playing'
  | 'answering'
  | 'judging'
  | 'correct'
  | 'wrong'
  | 'reveal'
  | 'results'

export type Player = {
  id: string
  score: number
}

export type Track = {
  id: string
  title: string
  artist: string
  albumName: string
  catalogAlbumId?: string
  libraryAlbumId?: string
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
}

export type Album = {
  id: string
  name: string
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
  trackIds: string[]
}

export type GameState = {
  operationId: string
  phase: Phase
  step: GameStep
  quizMode: QuizMode | null
  selectedPlaylistIds: string[]
  players: Player[]
  tracks: Track[]
  // null: ジャケット解析中
  albums: Album[] | null
  shuffledTrackIds: string[]
  shuffledAlbumIds: string[]
  roundIndex: number
  roundAlbumIndex: number
  answererId: string | null
  jacketMode: JacketMode
  jacketGrayscale: boolean
  jacketHintPercent: number
  gameboardQr: boolean
  lanOrigin: string | null
}

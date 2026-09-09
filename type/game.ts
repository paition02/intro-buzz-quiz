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
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
}

export type Album = {
  id: string
  name: string
  artist: string
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
}

export type GameState = {
  phase: Phase
  step: GameStep
  quizMode: QuizMode | null
  selectedPlaylistIds: string[]
  players: Player[]
  tracks: Track[]
  albums: Album[]
  shuffledTrackIds: string[]
  shuffledAlbumIds: string[]
  roundIndex: number
  roundAlbumIndex: number
  answererId: string | null
  jacketMode: JacketMode
  jacketGrayscale: boolean
  jacketHintPercent: number
}

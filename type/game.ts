export type Phase = 'initialization' | 'ready' | 'game'

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
  artworkChipUrl?: string
  artworkInfoUrl?: string
  artworkRevealUrl?: string
}

export type GameState = {
  phase: Phase
  step: GameStep
  selectedPlaylistIds: string[]
  players: Player[]
  tracks: Track[]
  shuffledTrackIds: string[]
  roundIndex: number
  answererId: string | null
}

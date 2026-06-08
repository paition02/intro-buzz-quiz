import { useEffect, useRef, useState } from 'react'
import type { Player } from '../../type/game'
import { PlayerBadge } from './PlayerBadge'

export function GameboardPlayers({ players, answererId }: {
  players: Player[]
  answererId: string | null
}) {
  const previousPlayerIdsRef = useRef<Set<string> | null>(null)
  const [enteringPlayerIds, setEnteringPlayerIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const currentPlayerIds = new Set(players.map((player) => player.id))
    const previousPlayerIds = previousPlayerIdsRef.current
    previousPlayerIdsRef.current = currentPlayerIds
    if (previousPlayerIds == null) return

    const enteredPlayerIds = players.map((player) => player.id).filter((id) => !previousPlayerIds.has(id))
    if (enteredPlayerIds.length === 0) return

    setEnteringPlayerIds((ids) => new Set([...ids, ...enteredPlayerIds]))
    const timeoutIds = enteredPlayerIds.map((id) => window.setTimeout(() => {
      setEnteringPlayerIds((ids) => {
        if (!ids.has(id)) return ids
        const next = new Set(ids)
        next.delete(id)
        return next
      })
    }, 800))

    return () => {
      timeoutIds.forEach(window.clearTimeout)
    }
  }, [players])

  if (players.length === 0) return null
  return (
    <div className="w-full pt-5 border-t border-white/10">
      <div className="flex justify-center gap-2.5 flex-wrap">
        {players.map((player) => (
          <PlayerBadge
            id={player.id}
            active={player.id === answererId}
            entering={enteringPlayerIds.has(player.id)}
            label={false}
            score={player.score}
            variant="gameboard"
            key={player.id}
          />
        ))}
      </div>
    </div>
  )
}

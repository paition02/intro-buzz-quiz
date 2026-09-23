import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Fuse from 'fuse.js'

export type AnswerCandidate = {
  id: string
  title: string
  artist: string
  artworkUrl?: string
}

const SUGGESTION_LIMIT = 5

// 口頭の回答をホストが入力し、候補から選ぶと正誤判定へ渡す。
// 「回答」ラベルの右に combobox、候補はその下: ↓↑ で候補を選び、Enter で回答、Escape で入力を消す。
export function AnswerInput({
  candidates,
  disabled,
  placeholder,
  onAnswer,
}: {
  candidates: AnswerCandidate[]
  disabled: boolean
  placeholder: string
  onAnswer: (candidate: AnswerCandidate) => void
}) {
  const [query, setQuery] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const listboxId = useId()

  const fuse = useMemo(
    () => new Fuse(candidates, { keys: ['title', 'artist'], threshold: 0.4 }),
    [candidates],
  )
  const suggestions = useMemo(
    () => query.trim().length < 1 ? [] : fuse.search(query.trim(), { limit: SUGGESTION_LIMIT }).map((result) => result.item),
    [fuse, query],
  )
  const highlighted = suggestions[highlightedIndex] ?? null

  useEffect(() => {
    if (!disabled) inputRef.current?.focus()
  }, [disabled])

  const optionId = (candidate: AnswerCandidate) => `${listboxId}-${candidate.id}`

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery)
    setHighlightedIndex(0)
  }

  const handleSelect = (candidate: AnswerCandidate) => {
    if (disabled) return
    onAnswer(candidate)
    handleQueryChange('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (suggestions.length === 0) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      setHighlightedIndex((current) => (current + delta + suggestions.length) % suggestions.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlighted) handleSelect(highlighted)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      handleQueryChange('')
    }
  }

  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2.5">
      <label htmlFor={inputId} className="text-cream font-bold">回答</label>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        role="combobox"
        className="min-w-0 rounded-2xl border border-white/10 bg-black/20 text-white px-4 py-3 disabled:opacity-60"
        placeholder={disabled ? '解答権の獲得を待っています' : placeholder}
        value={query}
        onChange={(event) => handleQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={listboxId}
        aria-activedescendant={highlighted ? optionId(highlighted) : undefined}
      />
      {suggestions.length > 0 && (
        <ul id={listboxId} role="listbox" className="col-start-2 list-none m-0 p-0 grid gap-2 max-h-80 overflow-y-auto" aria-label="回答候補">
          {suggestions.map((candidate, index) => {
            const active = index === highlightedIndex
            return (
              <li
                key={candidate.id}
                id={optionId(candidate)}
                role="option"
                aria-selected={active}
                className={`w-full rounded-2xl border px-3 py-2.5 flex items-center gap-2.5 text-left text-cream cursor-pointer transition ${active ? 'bg-white/10 border-amber/50' : 'bg-white/5 border-white/10'}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handleSelect(candidate)}
              >
                {candidate.artworkUrl && <img className="size-9 rounded-lg shrink-0" src={candidate.artworkUrl} alt="" />}
                <span className="min-w-0 grid">
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap font-bold">{candidate.title}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap text-muted text-sm">{candidate.artist}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

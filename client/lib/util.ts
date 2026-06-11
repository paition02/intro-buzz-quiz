import type { Track } from '../../type/game'

export function loadSessionString(key: string) {
  try {
    return sessionStorage.getItem(key)
  } catch {
    return null
  }
}

export function saveSessionString(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value)
  } catch {
    // sessionStorage can be unavailable in strict privacy modes.
  }
}

export function hashString(value: string) {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(i) | 0
  }
  return hash >>> 0
}

export function playerColor(id: string) {
  const hue = hashString(id) % 360
  return {
    hue,
    background: `hsl(${hue} 76% 42%)`,
    softBackground: `hsl(${hue} 76% 42% / 0.18)`,
    border: `hsl(${hue} 76% 64% / 0.65)`,
    text: `hsl(${hue} 90% 92%)`,
  }
}

export function uniqueTracksById(tracks: Track[]) {
  const seenTrackIds = new Set<string>()
  return tracks.filter((track) => {
    if (seenTrackIds.has(track.id)) return false
    seenTrackIds.add(track.id)
    return true
  })
}

export function errorFromUnknown(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

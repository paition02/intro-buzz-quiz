export function isUnavailableTrack(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as { status?: number; statusCode?: number; cause?: unknown }
  // Authentication, offline and transient server failures must not discard
  // playable tracks. Only a definitive missing/deleted resource is excluded.
  return value.status === 404 || value.status === 410 || value.statusCode === 404 || value.statusCode === 410
    || (value.cause !== error && isUnavailableTrack(value.cause))
}

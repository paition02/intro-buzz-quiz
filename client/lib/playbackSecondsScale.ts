// A single exponential curve through (0, 0.1), (0.05, 1), (1, duration).
// The endpoint itself selects infinite repeat instead of a finite deadline.
export function playbackSecondsScale(duration: number) {
  const maximum = Number.isFinite(duration) && duration > 1 ? duration : 30
  const anchor = 0.05
  const exponentialRatio = (k: number, x: number) => Math.abs(k) < 1e-8 ? x / anchor : Math.expm1(k * x) / Math.expm1(k * anchor)
  let low = -100
  let high = 100
  for (let iteration = 0; iteration < 100; iteration++) {
    const middle = (low + high) / 2
    if (0.1 + 0.9 * exponentialRatio(middle, 1) < maximum) low = middle
    else high = middle
  }
  const k = (low + high) / 2
  return {
    maximum,
    fromProgress: (position: number) => position >= 1 - 1e-12 ? Infinity : 0.1 + 0.9 * exponentialRatio(k, Math.max(0, position)),
    toProgress: (seconds: number) => {
      if (seconds === Infinity) return 1
      const ratio = (Math.min(maximum, Math.max(0.1, seconds)) - 0.1) / 0.9
      return Math.abs(k) < 1e-8 ? ratio * anchor : Math.log1p(ratio * Math.expm1(k * anchor)) / k
    },
  }
}

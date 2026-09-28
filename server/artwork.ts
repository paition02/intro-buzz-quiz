import { createRequire } from 'node:module'
import sharp from 'sharp'
import type * as PdqWasm from 'pdq-wasm'

// pdq-wasm の ESM 版は Bun で WASM を読み込めないので CommonJS 版を使う。
const { PDQ } = createRequire(import.meta.url)('pdq-wasm') as typeof PdqWasm
const pdqReady = PDQ.init()

const maxConcurrentFetches = 16
const fetchTimeoutMs = 10_000

const hashesByUrl = new Map<string, Promise<string | null>>()
let activeFetches = 0
const waitingFetches: Array<() => void> = []

async function withFetchSlot<T>(task: () => Promise<T>) {
  if (activeFetches >= maxConcurrentFetches) await new Promise<void>((resolve) => waitingFetches.push(resolve))
  activeFetches += 1
  try {
    return await task()
  } finally {
    activeFetches -= 1
    waitingFetches.shift()?.()
  }
}

async function computeArtworkHash(url: string) {
  const image = await withFetchSlot(async () => {
    const response = await fetch(url, { signal: AbortSignal.timeout(fetchTimeoutMs) })
    if (!response.ok) throw new Error(`artwork fetch failed: ${response.status}`)
    return response.arrayBuffer()
  })
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  await pdqReady
  const { hash } = PDQ.hash({ data: new Uint8Array(data), width: info.width, height: info.height, channels: 3 })
  return PDQ.toHex(hash)
}

export function artworkHash(url: string) {
  const cached = hashesByUrl.get(url)
  if (cached) return cached
  const hash = computeArtworkHash(url).catch(() => {
    hashesByUrl.delete(url)
    return null
  })
  hashesByUrl.set(url, hash)
  return hash
}

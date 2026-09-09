import { useEffect, useRef } from 'react'
import type { JacketMode } from '../../type/game'

type JacketCanvasProps = {
  src: string
  mode: JacketMode
  grayscale: boolean
  hintPercent: number
  seed: string
  className?: string
}

type Rect = {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

const CANVAS_SIZE = 720

export function JacketCanvas({ src, mode, grayscale, hintPercent, seed, className }: JacketCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      if (cancelled) return
      renderJacket(canvas, image, mode, grayscale, hintPercent, seed)
    }
    image.src = src

    return () => {
      cancelled = true
    }
  }, [grayscale, hintPercent, mode, seed, src])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label="ジャケットヒント"
      role="img"
    />
  )
}

function renderJacket(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  mode: JacketMode,
  grayscale: boolean,
  hintPercent: number,
  seed: string,
) {
  const dpr = window.devicePixelRatio || 1
  const size = Math.round(CANVAS_SIZE * dpr)
  canvas.width = size
  canvas.height = size

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const percent = Math.min(100, Math.max(1, Math.round(hintPercent)))
  const progress = percent / 100
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = '#111018'
  ctx.fillRect(0, 0, size, size)
  ctx.filter = grayscale ? 'grayscale(1)' : 'none'

  if (percent >= 100) {
    drawImageCover(ctx, image, 0, 0, size, size)
  } else if (mode === 'pixelated') {
    drawPixelated(ctx, image, size, progress)
  } else if (mode === 'missingBlocks') {
    drawMissingBlocks(ctx, image, size, progress, seed)
  } else if (mode === 'tileShuffle') {
    drawTileShuffle(ctx, image, size, progress, seed)
  } else if (mode === 'circleReveal') {
    drawCircleReveal(ctx, image, size, progress, seed)
  } else if (mode === 'zoomRotateCrop') {
    drawZoomRotateCrop(ctx, image, size, progress, seed)
  } else {
    drawEdgeReveal(ctx, image, size, progress)
  }

  ctx.restore()
}

function coverRect(image: HTMLImageElement, dx: number, dy: number, dw: number, dh: number): Rect {
  const sourceRatio = image.naturalWidth / image.naturalHeight
  const targetRatio = dw / dh
  if (sourceRatio > targetRatio) {
    const sw = image.naturalHeight * targetRatio
    const sx = (image.naturalWidth - sw) / 2
    return { sx, sy: 0, sw, sh: image.naturalHeight, dx, dy, dw, dh }
  }
  const sh = image.naturalWidth / targetRatio
  const sy = (image.naturalHeight - sh) / 2
  return { sx: 0, sy, sw: image.naturalWidth, sh, dx, dy, dw, dh }
}

function drawImageCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, dx: number, dy: number, dw: number, dh: number) {
  const rect = coverRect(image, dx, dy, dw, dh)
  ctx.drawImage(image, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh)
}

function drawPixelated(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number) {
  const sampleSize = Math.round(4 + progress * progress * 124)
  const offscreen = document.createElement('canvas')
  offscreen.width = sampleSize
  offscreen.height = sampleSize
  const offscreenCtx = offscreen.getContext('2d')
  if (!offscreenCtx) return
  offscreenCtx.imageSmoothingEnabled = true
  drawImageCover(offscreenCtx, image, 0, 0, sampleSize, sampleSize)

  ctx.imageSmoothingEnabled = false
  ctx.drawImage(offscreen, 0, 0, size, size)
  ctx.imageSmoothingEnabled = true
}

function drawMissingBlocks(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number, seed: string) {
  const grid = 12
  const block = size / grid
  const order = shuffledIndexes(grid * grid, `${seed}:missingBlocks`)
  const visibleCount = Math.max(1, Math.ceil(order.length * progress))
  const visible = new Set(order.slice(0, visibleCount))
  const source = coverRect(image, 0, 0, size, size)
  for (let index = 0; index < grid * grid; index += 1) {
    if (!visible.has(index)) continue
    const col = index % grid
    const row = Math.floor(index / grid)
    const sx = source.sx + (source.sw * col) / grid
    const sy = source.sy + (source.sh * row) / grid
    const sw = source.sw / grid
    const sh = source.sh / grid
    ctx.drawImage(image, sx, sy, sw, sh, col * block, row * block, block + 0.5, block + 0.5)
  }
}

function drawTileShuffle(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number, seed: string) {
  const grid = 8
  const tile = size / grid
  const count = grid * grid
  const shuffled = shuffledIndexes(count, `${seed}:tileShuffle`)
  const restoreOrder = shuffledIndexes(count, `${seed}:tileRestore`)
  const restoredCount = Math.floor(count * progress)
  const restored = new Set(restoreOrder.slice(0, restoredCount))
  const source = coverRect(image, 0, 0, size, size)

  for (let destIndex = 0; destIndex < count; destIndex += 1) {
    const sourceIndex = restored.has(destIndex) ? destIndex : shuffled[destIndex]
    const sourceCol = sourceIndex % grid
    const sourceRow = Math.floor(sourceIndex / grid)
    const destCol = destIndex % grid
    const destRow = Math.floor(destIndex / grid)
    const sx = source.sx + (source.sw * sourceCol) / grid
    const sy = source.sy + (source.sh * sourceRow) / grid
    const sw = source.sw / grid
    const sh = source.sh / grid
    ctx.drawImage(image, sx, sy, sw, sh, destCol * tile, destRow * tile, tile + 0.5, tile + 0.5)
  }
}

function drawCircleReveal(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number, seed: string) {
  const circles = makeCircles(96, `${seed}:circleReveal`)
  const revealCount = Math.max(1, Math.ceil(circles.length * progress))
  const radiusScale = 0.65 + progress * 0.9
  ctx.save()
  ctx.beginPath()
  for (const circle of circles.slice(0, revealCount)) {
    ctx.moveTo(circle.x * size + circle.r * size * radiusScale, circle.y * size)
    ctx.arc(circle.x * size, circle.y * size, circle.r * size * radiusScale, 0, Math.PI * 2)
  }
  ctx.clip()
  drawImageCover(ctx, image, 0, 0, size, size)
  ctx.restore()
}

function drawZoomRotateCrop(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number, seed: string) {
  const random = seededRandom(`${seed}:zoomRotateCrop`)
  const maxRotation = (random() > 0.5 ? 1 : -1) * (Math.PI * (0.18 + random() * 0.32))
  const rotation = maxRotation * (1 - progress)
  const zoom = 1 + (1 - progress) * 30
  const offsetX = (random() - 0.5) * size * 0.45 * (1 - progress)
  const offsetY = (random() - 0.5) * size * 0.45 * (1 - progress)
  ctx.save()
  ctx.translate(size / 2, size / 2)
  ctx.rotate(rotation)
  ctx.scale(zoom, zoom)
  ctx.translate(-size / 2 + offsetX, -size / 2 + offsetY)
  drawImageCover(ctx, image, 0, 0, size, size)
  ctx.restore()
}

function drawEdgeReveal(ctx: CanvasRenderingContext2D, image: HTMLImageElement, size: number, progress: number) {
  const frame = Math.max(1, (size / 2) * progress)
  const source = coverRect(image, 0, 0, size, size)
  const strips = [
    { x: 0, y: 0, w: size, h: frame },
    { x: 0, y: size - frame, w: size, h: frame },
    { x: 0, y: frame, w: frame, h: size - frame * 2 },
    { x: size - frame, y: frame, w: frame, h: size - frame * 2 },
  ]
  for (const strip of strips) {
    if (strip.w <= 0 || strip.h <= 0) continue
    const sx = source.sx + (source.sw * strip.x) / size
    const sy = source.sy + (source.sh * strip.y) / size
    const sw = (source.sw * strip.w) / size
    const sh = (source.sh * strip.h) / size
    ctx.drawImage(image, sx, sy, sw, sh, strip.x, strip.y, strip.w, strip.h)
  }
}

function makeCircles(count: number, seed: string) {
  const random = seededRandom(seed)
  return Array.from({ length: count }, () => ({
    x: random(),
    y: random(),
    r: 0.025 + random() * 0.07,
  }))
}

function shuffledIndexes(count: number, seed: string) {
  const random = seededRandom(seed)
  const values = Array.from({ length: count }, (_, index) => index)
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[values[index], values[swapIndex]] = [values[swapIndex], values[index]]
  }
  return values
}

function seededRandom(seed: string) {
  let value = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return () => {
    value += 0x6D2B79F5
    let next = value
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

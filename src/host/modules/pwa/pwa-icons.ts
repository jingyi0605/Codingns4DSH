/**
 * PWA 图标生成器。
 *
 * 图标不随包分发二进制资产：Host 构建只用 tsc，没有资源加载器，而运行期从
 * `assets/` 读文件又依赖发布目录结构。这里按需程序化生成 PNG（zlib + 手写
 * PNG 编码），图形与登录页的旋转方块标记一致，任何入口读到的都是同一份字节。
 */
import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_COLOR_TYPE_RGBA = 6
const PNG_BIT_DEPTH = 8
const PNG_FILTER_NONE = 0
const SUPERSAMPLE = 2

const BACKGROUND_START = { r: 0x16, g: 0x23, b: 0x3f }
const BACKGROUND_END = { r: 0x08, g: 0x0d, b: 0x18 }
const RING_COLOR = { r: 0x60, g: 0xa5, b: 0xfa }
const CORE_START = { r: 0x3b, g: 0x82, b: 0xf6 }
const CORE_END = { r: 0x06, g: 0xb6, b: 0xd4 }

export interface PwaIconOptions {
  readonly size: number
  /** maskable 图标：背景铺满画布，标记缩进安全区。 */
  readonly maskable?: boolean
}

const iconCache = new Map<string, Uint8Array>()

/** 生成（并缓存）指定尺寸的 PNG 图标字节。 */
export function createPwaIconPng(options: PwaIconOptions): Uint8Array {
  const key = `${String(options.size)}:${options.maskable === true ? 'maskable' : 'plain'}`
  const cached = iconCache.get(key)
  if (cached !== undefined) return cached
  const bytes = renderPwaIcon(options)
  iconCache.set(key, bytes)
  return bytes
}

function renderPwaIcon(options: PwaIconOptions): Uint8Array {
  const size = Math.max(16, Math.min(1024, Math.round(options.size)))
  const maskable = options.maskable === true
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const nx = ((x + (sx + 0.5) / SUPERSAMPLE) / size) * 2 - 1
          const ny = ((y + (sy + 0.5) / SUPERSAMPLE) / size) * 2 - 1
          const sample = samplePixel(nx, ny, maskable)
          r += sample.r * sample.a
          g += sample.g * sample.a
          b += sample.b * sample.a
          a += sample.a
        }
      }
      const samples = SUPERSAMPLE * SUPERSAMPLE
      const alpha = a / samples
      const offset = (y * size + x) * 4
      pixels[offset] = alpha === 0 ? 0 : Math.round(r / a)
      pixels[offset + 1] = alpha === 0 ? 0 : Math.round(g / a)
      pixels[offset + 2] = alpha === 0 ? 0 : Math.round(b / a)
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return encodePng(size, size, pixels)
}

interface RgbaSample {
  readonly r: number
  readonly g: number
  readonly b: number
  readonly a: number
}

/** 归一化坐标（-1..1）上的单点采样：背景 + 菱形描边 + 内芯。 */
function samplePixel(x: number, y: number, maskable: boolean): RgbaSample {
  const backgroundCoverage = maskable ? 1 : roundedSquareCoverage(x, y, 0.42)
  if (backgroundCoverage <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  const tint = clamp01((x + y + 2) / 4)
  const background = mix(BACKGROUND_START, BACKGROUND_END, tint)
  const scale = maskable ? 0.72 : 0.86
  const diamond = (Math.abs(x) + Math.abs(y)) / scale
  const ring = bandCoverage(diamond, 0.66, 0.075)
  const core = 1 - smoothstep(0.3, 0.36, diamond)
  let r = background.r
  let g = background.g
  let b = background.b
  if (core > 0) {
    const coreColor = mix(CORE_START, CORE_END, clamp01((x + 1) / 2))
    r = mixChannel(r, coreColor.r, core)
    g = mixChannel(g, coreColor.g, core)
    b = mixChannel(b, coreColor.b, core)
  }
  if (ring > 0) {
    r = mixChannel(r, RING_COLOR.r, ring)
    g = mixChannel(g, RING_COLOR.g, ring)
    b = mixChannel(b, RING_COLOR.b, ring)
  }
  return { r, g, b, a: backgroundCoverage }
}

/** 圆角方块：返回 0..1 覆盖度，四角按半径裁圆。 */
function roundedSquareCoverage(x: number, y: number, radius: number): number {
  const limit = 1 - radius
  const dx = Math.max(Math.abs(x) - limit, 0)
  const dy = Math.max(Math.abs(y) - limit, 0)
  if (dx === 0 || dy === 0) return 1
  const distance = Math.hypot(dx, dy)
  return 1 - smoothstep(radius - 0.03, radius, distance)
}

/** 以中心值 ±half 的带状覆盖度，用于描边。 */
function bandCoverage(value: number, center: number, half: number): number {
  return 1 - smoothstep(half * 0.45, half, Math.abs(value - center))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function mix(left: { readonly r: number; readonly g: number; readonly b: number }, right: { readonly r: number; readonly g: number; readonly b: number }, t: number): { r: number; g: number; b: number } {
  return {
    r: mixChannel(left.r, right.r, t),
    g: mixChannel(left.g, right.g, t),
    b: mixChannel(left.b, right.b, t),
  }
}

function mixChannel(left: number, right: number, t: number): number {
  return left + (right - left) * t
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** 最小 PNG 编码器：8 位 RGBA、无隔行、逐行 filter 0。 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height * 4) throw new Error('encodePng: 像素数据长度与尺寸不匹配')
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = PNG_FILTER_NONE
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = new Uint8Array(13)
  writeUint32(ihdr, 0, width)
  writeUint32(ihdr, 4, height)
  ihdr[8] = PNG_BIT_DEPTH
  ihdr[9] = PNG_COLOR_TYPE_RGBA
  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  return concatBytes([PNG_SIGNATURE, ...chunks])
}

/** PNG 分块：长度(4) + 类型(4) + 数据 + CRC(4)，CRC 覆盖类型与数据。 */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([...type].map((char) => char.charCodeAt(0)))
  const body = concatBytes([typeBytes, data])
  const result = new Uint8Array(body.length + 12)
  writeUint32(result, 0, data.length)
  result.set(body, 4)
  writeUint32(result, 4 + body.length, crc32(body))
  return result
}

const CRC_TABLE = createCrcTable()

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of input) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

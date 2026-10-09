import { normalizePeerHostColor } from '../shared/contracts/peer-host.js'
import type { CSSProperties } from 'react'

/**
 * 工作区标签配色的推导与缓存。
 *
 * 用户在 PeerHost 管理里显式配置的颜色优先；没有配置时按 Host 名称推导一个稳定
 * 颜色，保证同一台机器在多次刷新、多个工作区之间颜色一致——颜色本身是识别手段，
 * 随机色会让标签失去意义。
 */

/** 无显式配色时使用的候选色板；与 PEER_HOST_COLOR_PRESETS 保持同一组观感。 */
const FALLBACK_PALETTE = [
  '#1677ff',
  '#722ed1',
  '#13c2c2',
  '#52c41a',
  '#fa8c16',
  '#eb2f96',
  '#f5222d',
  '#8c8c8c',
] as const

const derivedCache = new Map<string, string>()

/**
 * 解析某台 Host 的工作区标签颜色。
 *
 * @param explicit - 用户在 PeerHost 配置里保存的颜色；非法或缺省时走推导。
 * @param seed - 推导种子，通常用 PeerHost 名称；同一名称始终得到同一颜色。
 * @returns `#rrggbb` 形式的小写颜色。
 */
export function resolvePeerHostColor(explicit: string | null | undefined, seed: string): string {
  const configured = normalizePeerHostColor(explicit)
  if (configured !== null) return configured
  const key = seed.trim() === '' ? 'peer-host' : seed.trim()
  const cached = derivedCache.get(key)
  if (cached !== undefined) return cached
  const color = FALLBACK_PALETTE[hashString(key) % FALLBACK_PALETTE.length]!
  derivedCache.set(key, color)
  return color
}

/** FNV-1a 32 位哈希；只用于选色，不需要密码学强度。 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** 标签胶囊的底色：与归档面板 Agent 徽标保持同一种 `color-mix` 写法。 */
export function peerHostTagBackground(color: string): string {
  return `color-mix(in srgb, ${color} 16%, transparent)`
}

/** 标签文字色；直接使用配置色，保证明暗主题下都有足够对比。 */
export function peerHostTagForeground(color: string): string {
  return color
}

/** 工作区列表与关联项目表共用的 Host 胶囊标签基础样式。 */
export function peerHostTagStyle(color: string): CSSProperties {
  return {
    boxSizing: 'border-box',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '1px 6px',
    borderRadius: '999px',
    fontSize: '10px',
    lineHeight: '1.5',
    pointerEvents: 'none',
    color: peerHostTagForeground(color),
    background: peerHostTagBackground(color),
  }
}

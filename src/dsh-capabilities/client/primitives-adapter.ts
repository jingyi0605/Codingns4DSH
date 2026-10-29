import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import { createElement, type ComponentType, type ComponentProps, type ReactNode } from 'react'

/** 富文本菜单沿用宿主的键盘导航、焦点归还和外部点击关闭行为。 */
export { Menu as DshMenu } from '@deepseek-ai/dsh-client-ui-primitives'
export { Button as DshButton, Checkbox as DshCheckbox, Input as DshInput, Modal as DshModal } from '@deepseek-ai/dsh-client-ui-primitives'
export { FileTypeIcon as DshFileTypeIcon, classifyFileType as classifyDshFileType, IconFolderCloseRegular as DshFolderIcon } from '@deepseek-ai/dsh-client-ui-primitives'
export { PathLabel as DshPathLabel, Tooltip as DshTooltip } from '@deepseek-ai/dsh-client-ui-primitives'

/** Older primitive packages may lack Markdown delegation. Do not fail the whole footer. */
export function hasNativeMarkdown(source: object = primitives): boolean {
  const value = source as Partial<typeof primitives>
  return value.MarkdownText !== undefined && typeof value.MarkdownDelegateProvider === 'function'
}
export const DshMarkdownText = primitives.MarkdownText ?? (({ text }: ComponentProps<typeof primitives.MarkdownText>) => createElement('pre', null, text))
export const DshMarkdownDelegate = primitives.MarkdownDelegateProvider ?? (({ children }: { children: ReactNode }) => createElement('div', null, children))

type IconComponent = ComponentType<{ readonly size?: number; readonly className?: string }>
type ShortcutKeysComponent = ComponentType<{ readonly keys: readonly string[] }>
type PrimitiveExports = typeof primitives & {
  readonly IconPlusOutlineRegular?: IconComponent
  readonly IconPlusOutlineMedium?: IconComponent
  readonly IconChevronDownOutlineRegular?: IconComponent
  readonly IconChevronDownOutlineMedium?: IconComponent
  readonly IconChevronUpOutlineRegular?: IconComponent
  readonly IconChevronUpOutlineMedium?: IconComponent
  readonly IconChevronLeftOutlineRegular?: IconComponent
  readonly IconChevronLeftOutlineMedium?: IconComponent
  readonly IconChevronRightOutlineRegular?: IconComponent
  readonly IconChevronRightOutlineMedium?: IconComponent
  readonly IconRefreshOutlineRegular?: IconComponent
  readonly IconRefreshOutlineMedium?: IconComponent
  readonly IconSlidersTwoOutlineRegular?: IconComponent
  readonly IconSlidersTwoOutlineMedium?: IconComponent
  readonly IconSettingsOutlineRegular?: IconComponent
  readonly IconSettingsOutlineMedium?: IconComponent
  readonly IconPlusOutline16?: IconComponent
  readonly IconChevronDownOutline14?: IconComponent
  readonly IconDataOutlineRegular?: IconComponent
  readonly IconDataOutlineMedium?: IconComponent
  readonly IconDataOutline16?: IconComponent
  readonly IconShareOutlineRegular?: IconComponent
  readonly IconShareOutlineMedium?: IconComponent
  readonly IconSendOutlineRegular?: IconComponent
  readonly IconSendOutlineMedium?: IconComponent
  readonly IconCloseOutlineRegular?: IconComponent
  readonly IconCloseOutlineMedium?: IconComponent
  readonly IconCloseFillRegular?: IconComponent
  readonly IconCloseFillMedium?: IconComponent
  readonly IconChatOutlineRegular?: IconComponent
  readonly IconChatOutlineMedium?: IconComponent
  readonly IconStopFillRegular?: IconComponent
  readonly IconStopFillMedium?: IconComponent
  readonly IconPhoneOutlineRegular?: IconComponent
  readonly IconPhoneOutlineMedium?: IconComponent
  readonly IconWrapFillRegular?: IconComponent
  readonly IconNowrapFillRegular?: IconComponent
  readonly ShortcutKeys?: ShortcutKeysComponent
}

const unavailableIcon: IconComponent = () => null
const fallbackShortcutKeys: ShortcutKeysComponent = ({ keys }) => createElement('span', undefined, keys.join(' + '))

export type DshControlIconName = 'add' | 'phone' | 'settings' | 'close' | 'send' | 'stop' | 'chat' | 'clear'
/** Shared controls prefer Host icons and use matching local chat/phone fallbacks when absent. */
export function resolveControlIcon(name: DshControlIconName): IconComponent {
  const value = primitives as PrimitiveExports
  switch (name) {
    case 'add': return resolvePlusIcon()
    case 'clear': return resolveRefreshIcon()
    case 'settings': return value.IconSettingsOutlineRegular ?? value.IconSettingsOutlineMedium ?? resolveToolIcon()
    case 'close': return value.IconCloseOutlineRegular ?? value.IconCloseOutlineMedium ?? unavailableIcon
    case 'chat': return value.IconChatOutlineRegular ?? value.IconChatOutlineMedium ?? ChatBubbleIcon
    case 'send': return value.IconSendOutlineRegular ?? value.IconSendOutlineMedium ?? unavailableIcon
    case 'stop': return value.IconStopFillRegular ?? value.IconStopFillMedium ?? unavailableIcon
    case 'phone': return value.IconPhoneOutlineRegular ?? value.IconPhoneOutlineMedium ?? TelephoneIcon
  }
}
/** 沿用 DSH 新对话的气泡轮廓，内部使用三点表示进入已有对话。 */
function ChatBubbleIcon({ size = 20, className }: { readonly size?: number; readonly className?: string }) {
  return createElement('svg', { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: false,
    stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' },
    createElement('path', { d: 'M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337' }),
    ...[5.25, 8, 10.75].map((cx) => createElement('circle', { key: cx, cx, cy: 8, r: 0.65, fill: 'currentColor', stroke: 'none' })))
}
function TelephoneIcon({ size = 20, className }: { readonly size?: number; readonly className?: string }) {
  return createElement('svg', { width: size, height: size, className, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true,
    stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round' },
    createElement('path', { d: 'M3.1 1.8h2l1.1 3.1-1.4 1.4a10.5 10.5 0 0 0 4.9 4.9l1.4-1.4 3.1 1.1v2a1.4 1.4 0 0 1-1.6 1.4A13 13 0 0 1 1.7 3.4a1.4 1.4 0 0 1 1.4-1.6Z' }))
}

/**
 * 图标导出兼容层。0.1.7 可能改名为 Regular/Medium，运行时优先使用新导出，
 * 旧导出仍作为回退；业务组件不再直接判断 DSH 版本。
 */
export function resolvePlusIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconPlusOutlineRegular ?? value.IconPlusOutlineMedium ?? value.IconPlusOutline16 ?? unavailableIcon
}

export function resolveChevronDownIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconChevronDownOutlineRegular ?? value.IconChevronDownOutlineMedium ?? value.IconChevronDownOutline14 ?? unavailableIcon
}

/** 终端工具栏使用的原生刷新图标。 */
export function resolveRefreshIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconRefreshOutlineRegular ?? value.IconRefreshOutlineMedium ?? unavailableIcon
}

/** Document toolbar glyphs shared with the native text preview. */
export function resolveTextWrapIcon(wrapped: boolean): IconComponent {
  const value = primitives as PrimitiveExports
  return (wrapped ? value.IconNowrapFillRegular : value.IconWrapFillRegular) ?? unavailableIcon
}

/** Native viewer controls; keep optional glyph compatibility at the adapter boundary. */
export function resolveViewerIcon(name: 'edit' | 'save' | 'fullscreen' | 'restore' | 'back' | 'home'): IconComponent {
  const icons = primitives as unknown as Record<string, IconComponent | undefined>
  const key = { edit: 'IconEditOutlineRegular', save: 'IconCheckOutlineRegular', fullscreen: 'IconFullscreenOutlineRegular',
    restore: 'IconFullscreenOutlineRegular', back: 'IconChevronLeftOutlineRegular', home: 'IconFileOutlineRegular' }[name]
  return icons[key] ?? resolveRefreshIcon()
}

/** 终端工具栏入口使用的原生工具图标。 */
export function resolveToolIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconSlidersTwoOutlineRegular
    ?? value.IconSlidersTwoOutlineMedium
    ?? value.IconSettingsOutlineRegular
    ?? value.IconSettingsOutlineMedium
    ?? unavailableIcon
}

/** 终端快捷操作的方向图标。 */
export function resolveTerminalArrowIcon(direction: 'up' | 'down' | 'left' | 'right'): IconComponent {
  const value = primitives as PrimitiveExports
  if (direction === 'up') return value.IconChevronUpOutlineRegular ?? value.IconChevronUpOutlineMedium ?? unavailableIcon
  if (direction === 'down') return value.IconChevronDownOutlineRegular ?? value.IconChevronDownOutlineMedium ?? unavailableIcon
  if (direction === 'left') return value.IconChevronLeftOutlineRegular ?? value.IconChevronLeftOutlineMedium ?? unavailableIcon
  return value.IconChevronRightOutlineRegular ?? value.IconChevronRightOutlineMedium ?? unavailableIcon
}

/** 终端按键标签使用 DSH 原生 ShortcutKeys，旧版本缺失时退回纯文本。 */
export function resolveShortcutKeys(): ShortcutKeysComponent {
  const value = primitives as PrimitiveExports
  return value.ShortcutKeys ?? fallbackShortcutKeys
}

/**
 * 模型图标：DSH 原生模型选择器在紧凑状态显示的 data 图标（0.1.7 起为 Regular/Medium，
 * 0.1.6 为 16 后缀），插件模型选择器收起时与之保持一致。
 */
export function resolveDataIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconDataOutlineRegular ?? value.IconDataOutlineMedium ?? value.IconDataOutline16 ?? unavailableIcon
}

/**
 * `/委派` 菜单行图标：优先使用共享（send/share）字形，缺失时回退到插件通用的
 * data 图标，保证旧版 DSH 仍能渲染出一行可识别的委派入口。
 */
export function resolveDelegateIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconShareOutlineRegular
    ?? value.IconShareOutlineMedium
    ?? value.IconSendOutlineRegular
    ?? value.IconSendOutlineMedium
    ?? resolveDataIcon()
}

/**
 * 模型搜索框的清除按钮图标，与内置模型选择器的搜索清除按钮同一字形；
 * 旧版 DSH 缺少该导出时退化为不回退图标，清除按钮的文字标签仍然可用。
 */
export function resolveCloseFillIcon(): IconComponent {
  const value = primitives as PrimitiveExports
  return value.IconCloseFillRegular ?? value.IconCloseFillMedium ?? unavailableIcon
}

/**
 * 模型搜索的模糊排序。
 *
 * 内置模型选择器用 primitives 的 `rankByName` 排名搜索结构：查询必须是名称的
 * 大小写不敏感子序列，前缀命中优先，其次按对齐分数。插件模型选择器复用同一
 * 排序，保证同一查询在内置与外部 Agent 两个选择器里得到相同的顺序；旧版 DSH
 * 缺少该导出时退回等价的本地实现，行为不变。
 */
export type RankModelByName = <T extends { readonly name: string }>(items: readonly T[], rawQuery: string) => readonly T[]

export const rankModelByName: RankModelByName = (items, rawQuery) => {
  const exported = (primitives as Partial<typeof primitives>).rankByName
  if (typeof exported === 'function') return exported(items, rawQuery) as readonly (typeof items)[number][]
  return rankByNameFallback(items, rawQuery)
}

/** 名称起始与 `-`/`_` 分隔处额外加分，与宿主实现保持一致。 */
function boundaryBonus(name: string, index: number): number {
  return index === 0 || name.charAt(index - 1) === '-' || name.charAt(index - 1) === '_' ? 8 : 0
}

/** 有序子序列的最强对齐分数；查询不是子序列时返回 undefined。 */
function alignmentScore(name: string, query: string): number | undefined {
  if (query.length > name.length) return undefined
  const noMatch = Number.NEGATIVE_INFINITY
  let previous = Array.from({ length: name.length }, () => noMatch).map((_, index) => name.charAt(index) === query.charAt(0) ? 1 + boundaryBonus(name, index) - index : noMatch)
  for (let queryIndex = 1; queryIndex < query.length; queryIndex++) {
    const current = Array.from({ length: name.length }, () => noMatch)
    let left = noMatch
    let leftLeft = noMatch
    let bestGapped = noMatch
    for (const [index, prior] of previous.entries()) {
      if (leftLeft !== noMatch) bestGapped = Math.max(bestGapped, leftLeft + index - 2)
      if (name.charAt(index) === query.charAt(queryIndex)) {
        const bonus = 1 + boundaryBonus(name, index)
        let score = noMatch
        if (left !== noMatch) score = left + bonus + 4
        if (bestGapped !== noMatch) score = Math.max(score, bestGapped + bonus + 1 - index)
        current[index] = score
      }
      leftLeft = left
      left = prior
    }
    previous = current
  }
  let best = noMatch
  for (const score of previous) best = Math.max(best, score)
  return best === noMatch ? undefined : best
}

function rankByNameFallback<T extends { readonly name: string }>(items: readonly T[], rawQuery: string): readonly T[] {
  const query = rawQuery.toLowerCase()
  if (query === '') return items
  const ranked: Array<{ item: T; index: number; prefix: boolean; score: number }> = []
  items.forEach((item, index) => {
    const lower = item.name.toLowerCase()
    const score = alignmentScore(lower, query)
    if (score === undefined) return
    ranked.push({ item, index, prefix: lower.startsWith(query), score })
  })
  ranked.sort((left, right) => Number(right.prefix) - Number(left.prefix) || right.score - left.score || left.index - right.index)
  return ranked.map((match) => match.item)
}

/**
 * 插件界面字号与 DSH 界面字号的联动。
 *
 * DSH 0.2.1-alpha.2 起，界面字号按角色可配，正文角色的值落在 CSS 变量
 * `--dsh-content-font-size`（默认 14px）。插件界面过去写死像素值，用户在 DSH 设置里
 * 调整字号后不会跟随。
 *
 * 这里把固定像素换算成以 DSH 正文字号为基准的 CSS 表达式，因此：
 *
 * - 能力就绪时写入 `--codingns-font-base`，插件界面按同一比例缩放；
 * - 旧版本 DSH 没有该变量，`uiFontSize()` 回落到基准 14px，换算结果与原像素值完全相同。
 *
 * 表达式在模块加载期求值，因此对模块级样式常量同样安全；缩放由 CSS 变量在渲染期解析。
 */

/** DSH 正文角色的默认字号，与 `FONT_SIZE_SPECS.text.default` 一致。 */
export const CODINGNS_FONT_BASE_PX = 14

/** 插件界面字号基准变量；能力就绪时被指向 DSH 的正文字号变量。 */
const FONT_BASE_VARIABLE = '--codingns-font-base'

/** DSH 正文角色的字号变量名。 */
const DSH_CONTENT_FONT_VARIABLE = '--dsh-content-font-size'

/**
 * 把插件界面的固定像素字号换算为跟随 DSH 正文字号的 CSS 表达式。
 *
 * 变量缺失（旧版本 DSH、未安装字体能力、SSR）时回落到基准值，结果等于传入的像素值。
 */
export function uiFontSize(px: number): string {
  return `calc(var(${FONT_BASE_VARIABLE}, ${String(CODINGNS_FONT_BASE_PX)}px) / ${String(CODINGNS_FONT_BASE_PX)} * ${String(px)})`
}

export interface CodingNsFontScaleRuntime {
  /** 读取当前正文字号；DSH 未提供时返回 undefined。 */
  readonly contentFontSize?: () => number | undefined
  readonly subscribe?: (listener: () => void) => () => void
}

/**
 * 安装字号联动：把 `--codingns-font-base` 指向 DSH 的正文字号变量。
 *
 * 只写一个自定义属性，不改 DSH 自己的变量；返回 disposer 供插件停用时清理。
 * 变量在 DSH 侧缺失时由 `fontSize()` 的回落值兜底，因此这里不需要读具体数值。
 */
export function installFontScale(doc: Document | undefined = globalThis.document): () => void {
  const root = doc?.documentElement
  if (root === undefined) return () => undefined
  const previous = root.style.getPropertyValue(FONT_BASE_VARIABLE)
  root.style.setProperty(FONT_BASE_VARIABLE, `var(${DSH_CONTENT_FONT_VARIABLE}, ${String(CODINGNS_FONT_BASE_PX)}px)`)
  return () => {
    if (previous === '') root.style.removeProperty(FONT_BASE_VARIABLE)
    else root.style.setProperty(FONT_BASE_VARIABLE, previous)
  }
}

/** 读取当前生效的插件界面字号基准，供诊断输出。 */
export function readFontBase(doc: Document | undefined = globalThis.document): string | undefined {
  const root = doc?.documentElement
  if (root === undefined) return undefined
  const value = root.style.getPropertyValue(FONT_BASE_VARIABLE).trim()
  return value === '' ? undefined : value
}

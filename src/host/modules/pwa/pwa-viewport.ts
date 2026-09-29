/**
 * 启动页 viewport 改写。
 *
 * 上游 `<meta name="viewport" content="width=device-width, initial-scale=1">` 缺少
 * `viewport-fit=cover`，iOS 独立窗口下会留下安全区黑边。这里只做“就地追加”：不新增
 * 第二个 viewport meta（多标签行为依浏览器而异），已经包含 `viewport-fit` 时保持原样。
 */

const META_TAG_PATTERN = /<meta\b[^>]*>/giu
const NAME_VIEWPORT_PATTERN = /name\s*=\s*["']?viewport["']?/iu
const CONTENT_PATTERN = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu
const VIEWPORT_FIT_PATTERN = /viewport-fit\s*=/iu

/** 幂等地把 `viewport-fit=cover` 合并进已有 viewport meta；失败时原样返回。 */
export function applyViewportFitTap(html: string): string {
  if (typeof html !== 'string' || html === '') return html
  try {
    return html.replace(META_TAG_PATTERN, (tag) => {
      if (!NAME_VIEWPORT_PATTERN.test(tag)) return tag
      const match = CONTENT_PATTERN.exec(tag)
      if (match === null) return tag
      const quote = match[1] !== undefined ? '"' : match[2] !== undefined ? "'" : ''
      const value = match[1] ?? match[2] ?? match[3] ?? ''
      if (VIEWPORT_FIT_PATTERN.test(value)) return tag
      const separator = value.trim().endsWith(',') ? ' ' : ', '
      const next = `${value.trim()}${separator}viewport-fit=cover`
      return tag.replace(CONTENT_PATTERN, `content=${quote}${next}${quote}`)
    })
  } catch {
    return html
  }
}

/** 供诊断与测试确认改写是否产生效果。 */
export function hasViewportFit(html: string): boolean {
  for (const tag of html.match(META_TAG_PATTERN) ?? []) {
    if (!NAME_VIEWPORT_PATTERN.test(tag)) continue
    const content = CONTENT_PATTERN.exec(tag)
    if (content !== null && VIEWPORT_FIT_PATTERN.test(content[1] ?? content[2] ?? content[3] ?? '')) return true
  }
  return false
}

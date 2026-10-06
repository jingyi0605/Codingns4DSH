/**
 * Skill 引用的视觉投影。
 *
 * 输入框使用 DSH 原生 ReferenceChip；已经提交到时间线的用户消息仍然是普通文本，
 * 这里把其中有效的 `/skill-name` 投影成同一套原子元素。只扫描用户气泡和提交回显，
 * 不改写助手正文、代码块或普通页面文本。
 */

export const SKILL_REFERENCE_ATTRIBUTE = 'data-codingns-skill-reference'
export const SKILL_REFERENCE_RAW_ATTRIBUTE = 'data-codingns-skill-reference-raw'
export const SKILL_REFERENCE_STYLE_ID = 'codingns4dsh-skill-reference-style'

const sessionSkillNames = new Map<string, ReadonlySet<string>>()
const catalogListeners = new Set<() => void>()

/** 把一个会话最新的 Skill 目录发布给时间线投影和输入框预热使用。 */
export function publishSkillCatalog(sessionId: string, catalog: readonly { readonly name: string; readonly enabled: boolean }[]): void {
  sessionSkillNames.set(sessionId, new Set(catalog.filter((skill) => skill.enabled).map((skill) => skill.name)))
  for (const listener of [...catalogListeners]) listener()
}

/** 返回所有已加载会话的 Skill 名称并集；名称本身区分大小写，匹配时另行兼容大小写。 */
export function getSkillNames(): ReadonlySet<string> {
  const names = new Set<string>()
  for (const sessionNames of sessionSkillNames.values()) {
    for (const name of sessionNames) names.add(name)
  }
  return names
}

export function subscribeSkillCatalog(listener: () => void): () => void {
  catalogListeners.add(listener)
  return () => catalogListeners.delete(listener)
}

export interface SkillReferenceDomController {
  refresh(): void
  dispose(): void
}

export interface SkillReferenceDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly getSkillNames?: () => ReadonlySet<string>
}

export interface SkillReferenceMention {
  readonly raw: string
  readonly name: string
  readonly start: number
  readonly end: number
}

/** 从用户消息中提取有效 Skill 指令；URL、路径中间片段和未索引名称都会被忽略。 */
export function findSkillReferenceMentions(value: string, names: ReadonlySet<string>): readonly SkillReferenceMention[] {
  const byLowerName = new Map([...names].map((name) => [name.toLocaleLowerCase(), name]))
  const matches: SkillReferenceMention[] = []
  const tokenPattern = /\/[A-Za-z0-9][A-Za-z0-9._-]*(?=\s|$)/gu
  for (const match of value.matchAll(tokenPattern)) {
    const token = match[0] ?? ''
    const start = match.index ?? -1
    const before = start > 0 ? value[start - 1] : undefined
    const name = byLowerName.get(token.slice(1).toLocaleLowerCase())
    if (start < 0 || name === undefined || (before !== undefined && !/\s/u.test(before))) continue
    matches.push({ raw: token, name, start, end: start + token.length })
  }
  return matches
}

/** 安装 Skill chip 的消息列表投影与统一样式。 */
export function startSkillReferenceDom(options: SkillReferenceDomOptions = {}): SkillReferenceDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const getNames = options.getSkillNames ?? getSkillNames
  let disposed = false
  let scanQueued = false
  let observer: MutationObserver | undefined

  const observe = (): void => {
    if (disposed || dom === undefined || observer === undefined) return
    observer.observe(dom.documentElement, { childList: true, subtree: true })
  }
  const scan = (): void => {
    if (disposed || dom === undefined) return
    observer?.disconnect()
    try {
      decorateTimelineMessages(dom, getNames())
    } finally {
      observe()
    }
  }
  const scheduleScan = (): void => {
    if (disposed || scanQueued) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  if (dom !== undefined) installSkillReferenceStyles(dom)
  observer = dom === undefined || Observer === undefined ? undefined : new Observer(scheduleScan)
  observe()
  const unsubscribeCatalog = subscribeSkillCatalog(scheduleScan)
  scan()

  return {
    refresh: scheduleScan,
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      unsubscribeCatalog()
      if (dom !== undefined) removeSkillReferenceNodes(dom)
      dom?.querySelector(`style[data-plugin-css="${SKILL_REFERENCE_STYLE_ID}"]`)?.remove()
    },
  }
}

function decorateTimelineMessages(dom: Document, names: ReadonlySet<string>): void {
  const rows = [...dom.querySelectorAll('[class*="userRow"]')]
  for (const row of dom.querySelectorAll('[data-submission-echo]')) {
    if (!rows.includes(row)) rows.push(row)
  }
  const byLowerName = new Map([...names].map((name) => [name.toLocaleLowerCase(), name]))
  if (byLowerName.size === 0) return
  for (const row of rows) {
    const bubble = row.querySelector('[class*="bubble"]') ?? row.querySelector('[class*="preview"]')
    if (bubble !== null) decorateTimelineNode(bubble, dom, byLowerName)
  }
}

function decorateTimelineNode(node: Node, dom: Document, names: ReadonlyMap<string, string>): void {
  if (node.nodeType === 3) {
    replaceSkillTextNode(node, dom, names)
    return
  }
  if (node.nodeType !== 1
    || (node as Element).hasAttribute(SKILL_REFERENCE_ATTRIBUTE)
    || (node as Element).closest('code,pre,[contenteditable="true"]') !== null) return
  for (const child of [...node.childNodes]) decorateTimelineNode(child, dom, names)
}

function replaceSkillTextNode(node: Node, dom: Document, names: ReadonlyMap<string, string>): void {
  const value = node.nodeValue ?? ''
  if (value === '' || node.parentElement?.closest('code,pre,[contenteditable="true"]') !== null) return
  const matches = findSkillReferenceMentions(value, new Set(names.values()))
  if (matches.length === 0 || node.parentNode === null) return
  const fragment = dom.createDocumentFragment()
  let cursor = 0
  for (const match of matches) {
    if (match.start < cursor) continue
    if (match.start > cursor) fragment.append(dom.createTextNode(value.slice(cursor, match.start)))
    fragment.append(buildSkillChip(dom, value.slice(match.start, match.end), match.name))
    cursor = match.end
  }
  if (cursor < value.length) fragment.append(dom.createTextNode(value.slice(cursor)))
  node.parentNode.replaceChild(fragment, node)
}

function buildSkillChip(dom: Document, raw: string, name: string): HTMLElement {
  const chip = dom.createElement('span')
  chip.setAttribute(SKILL_REFERENCE_ATTRIBUTE, name)
  chip.setAttribute(SKILL_REFERENCE_RAW_ATTRIBUTE, raw)
  chip.setAttribute('title', `/${name}`)
  chip.setAttribute('aria-label', `/${name}`)
  const icon = dom.createElement('span')
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = '✦'
  const label = dom.createElement('span')
  label.textContent = raw
  chip.append(icon, label)
  return chip
}

function removeSkillReferenceNodes(dom: Document): void {
  for (const chip of dom.querySelectorAll(`[${SKILL_REFERENCE_ATTRIBUTE}]`)) {
    const raw = chip.getAttribute(SKILL_REFERENCE_RAW_ATTRIBUTE)
    const parent = chip.parentNode
    if (raw !== null && parent !== null) parent.replaceChild(dom.createTextNode(raw), chip)
  }
}

function installSkillReferenceStyles(dom: Document): void {
  if (dom.querySelector(`style[data-plugin-css="${SKILL_REFERENCE_STYLE_ID}"]`) !== null) return
  const style = dom.createElement('style')
  style.setAttribute('data-plugin', 'codingns4dsh')
  style.setAttribute('data-plugin-css', SKILL_REFERENCE_STYLE_ID)
  style.textContent = [
    `[${SKILL_REFERENCE_ATTRIBUTE}], [data-composer-chip="codingns-skills"]{display:inline-flex;align-items:center;vertical-align:baseline;gap:4px;padding:1px 7px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary);white-space:nowrap;font-size:.94em;line-height:1.45;user-select:all}`,
    `[${SKILL_REFERENCE_ATTRIBUTE}], [data-composer-chip="codingns-skills"]{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#888) 18%,transparent);background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12)) 82%,transparent)}`,
    `[${SKILL_REFERENCE_ATTRIBUTE}]>span:first-child{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));font-size:.8em}`,
    `[${SKILL_REFERENCE_ATTRIBUTE}]{cursor:default}`,
    `[data-composer-chip="codingns-skills"]>svg{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary))}`,
  ].join('')
  dom.head.appendChild(style)
}

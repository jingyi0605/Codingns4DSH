import { composerSlotSelector } from '../dsh-capabilities/client/composer-slot-selectors.js'
import { createMagpieModelTagNode, MAGPIE_MODEL_TAG_ATTRIBUTE } from './magpie-model-tag.js'

export interface NativeModelCatalogEntry {
  readonly id: string
  readonly name: string
  readonly source?: 'magpie'
}

/**
 * DSH 模型菜单尚无扩展插槽，通过原生触发器的 aria-controls 定位当前会话菜单。
 * 只添加翻译行的 Portal 容器，原生模型选择、思考强度和菜单交互继续由 DSH 管理。
 */
export function watchNativeModelMenu(
  anchor: HTMLElement,
  onTarget: (target: HTMLElement | null) => void,
  readModels: () => readonly NativeModelCatalogEntry[] = () => [],
): () => void {
  const document = anchor.ownerDocument
  const view = document.defaultView
  const Observer = view?.MutationObserver
  if (Observer === undefined || document.body === null) return () => undefined
  const modelTriggerSelector = `${composerSlotSelector('conversation.input.model')} button[aria-haspopup="menu"]`
  let target: HTMLElement | null = null
  let trigger: HTMLButtonElement | null = null
  const resize = (): void => {
    if (view !== null) view.dispatchEvent(new view.Event('resize'))
  }
  const sizeObserver = view?.ResizeObserver === undefined ? undefined : new view.ResizeObserver(resize)
  const closeOnEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    trigger?.click()
  }
  const scan = (): void => {
    trigger = anchor.closest('[data-composer-card]')?.querySelector<HTMLButtonElement>(modelTriggerSelector) ?? null
    const menuId = trigger?.getAttribute('aria-controls')
    const menu = menuId === undefined || menuId === null ? null : document.getElementById(menuId)
    if (menu !== null && trigger?.getAttribute('aria-expanded') === 'true') {
      const models = readModels()
      if (models.length > 0 || menu.querySelector('[data-codingns-magpie-model-tag]') !== null) {
        decorateMagpieModels(menu, models, document)
      }
    }
    // 模型列表和思考档位子菜单不放翻译行，避免干扰原生键盘导航与搜索。
    const rootMenu = trigger?.getAttribute('aria-expanded') === 'true'
      && menu?.getAttribute('role') === 'menu'
      && menu.querySelector(':scope > [role="menuitem"]') !== null
      ? menu : null
    if (target !== null && target.parentElement === rootMenu && rootMenu !== null) return
    sizeObserver?.disconnect()
    target?.remove()
    target = rootMenu === null ? null : document.createElement('div')
    if (target !== null) {
      target.dataset.codingnsNativeTranslation = ''
      target.addEventListener('keydown', closeOnEscape)
      rootMenu!.prepend(target)
      sizeObserver?.observe(target)
    }
    onTarget(target)
  }
  const observer = new Observer(scan)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-controls', 'aria-expanded', 'role'] })
  scan()
  return () => {
    observer.disconnect()
    sizeObserver?.disconnect()
    target?.remove()
    resize()
  }
}

/** Decorate only exact model identities; display-name fallback requires an unambiguous label. */
export function decorateMagpieModels(menu: HTMLElement, models: readonly NativeModelCatalogEntry[], document: Document): void {
  if (typeof menu.querySelectorAll !== 'function') return
  const tags = [...menu.querySelectorAll<HTMLElement>(`[${MAGPIE_MODEL_TAG_ATTRIBUTE}]`)]
  if (models.length === 0) {
    for (const tag of tags) tag.remove()
    return
  }
  const byId = new Map(models.filter((model) => model.source === 'magpie').map((model) => [model.id, model]))
  const nameCandidates = new Map<string, NativeModelCatalogEntry[]>()
  for (const model of models) {
    const name = normalizeModelName(model.name)
    if (name === null) continue
    const sameName = nameCandidates.get(name) ?? []
    sameName.push(model)
    nameCandidates.set(name, sameName)
  }
  const byName = new Map<string, NativeModelCatalogEntry>()
  for (const [name, matches] of nameCandidates) {
    if (matches.length === 1) byName.set(name, matches[0]!)
  }
  const selector = `[role="menuitemradio"], [role="option"], [data-model-id], [data-model], [data-value]`
  const candidates = [...menu.querySelectorAll<HTMLElement>(selector)]
  const candidateSet = new Set(candidates)
  for (const row of candidates) {
    // Nested identity attributes belong to their containing option, not a second row.
    let ancestor = row.parentElement
    let nested = false
    while (ancestor !== null && ancestor !== menu) {
      if (candidateSet.has(ancestor)) { nested = true; break }
      ancestor = ancestor.parentElement
    }
    if (nested) continue

    const existing = row.querySelector<HTMLElement>(`[${MAGPIE_MODEL_TAG_ATTRIBUTE}]`)
    const marked = existing?.dataset.modelId === undefined ? undefined : byId.get(existing.dataset.modelId)
    const model = marked?.source === 'magpie' ? marked : identifyNativeModel(row, byId, byName)
    if (model?.source !== 'magpie') {
      existing?.remove()
      continue
    }
    if (existing?.dataset.modelId === model.id) continue
    existing?.remove()
    const label = findModelLabel(row, model.name)
    const tag = createMagpieModelTagNode(document, model.id)
    if (label === row) row.append(tag)
    else label.after(tag)
  }
}

function identifyNativeModel(
  row: HTMLElement,
  byId: ReadonlyMap<string, NativeModelCatalogEntry>,
  byName: ReadonlyMap<string, NativeModelCatalogEntry>,
): NativeModelCatalogEntry | undefined {
  const nodes = [row, ...row.querySelectorAll<HTMLElement>('*')]
  for (const node of nodes) {
    for (const attribute of ['data-model-id', 'data-model', 'data-value', 'value']) {
      const id = node.getAttribute(attribute)
      const match = id === null ? undefined : byId.get(id)
      if (match !== undefined) return match
    }
  }
  for (const [name, model] of byName) {
    if (model.source !== 'magpie') continue
    if (nodes.some((node) => normalizeModelName(node.textContent) === name
      || normalizeModelName(node.getAttribute('aria-label')) === name
      || normalizeModelName(node.title) === name)) {
      return model
    }
  }
  return undefined
}

function normalizeModelName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US')
  return name === '' ? null : name
}

function findModelLabel(row: HTMLElement, name: string): HTMLElement {
  const nodes = [row, ...row.querySelectorAll<HTMLElement>('*')]
  return nodes.find((node) => node.textContent?.trim() === name && node.children.length === 0) ?? row
}

import { composerSlotSelector } from '../dsh-capabilities/client/composer-slot-selectors.js'

/**
 * DSH 模型菜单尚无扩展插槽，通过原生触发器的 aria-controls 定位当前会话菜单。
 * 只添加翻译行的 Portal 容器，原生模型选择、思考强度和菜单交互继续由 DSH 管理。
 */
export function watchNativeModelMenu(anchor: HTMLElement, onTarget: (target: HTMLElement | null) => void): () => void {
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

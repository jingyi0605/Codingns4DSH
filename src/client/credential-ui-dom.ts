/**
 * Places the credential command in DSH's native Add section.
 *
 * DSH owns the slash menu markup and keeps the Add section's built-in rows in
 * a fixed list. The public command UI contract cannot assign a plugin command
 * to that section, so this layer mirrors the delegation compatibility path:
 * hide the real React row and proxy it into Add without moving React-owned DOM.
 */

export const CREDENTIAL_MENU_ROW_ATTRIBUTE = 'data-codingns-credential-row'
export const CREDENTIAL_MENU_PROXY_ATTRIBUTE = 'data-codingns-credential-proxy'

const MENU_OPTION_SELECTOR = '[role="option"]'
const MENU_LISTBOX_SELECTOR = '[role="listbox"]'
const MENU_OPTION_ID_PREFIX = 'dsh-slash-option-'
const ITEM_NAME_SELECTOR = '[class*="itemName"]'
const SECTION_TITLE_SELECTOR = '[class*="sectionTitle"]'
const DELEGATE_PROXY_SELECTOR = '[data-codingns-delegate-proxy]'

const styleText = `[${CREDENTIAL_MENU_ROW_ATTRIBUTE}]:not([${CREDENTIAL_MENU_PROXY_ATTRIBUTE}]){display:none!important}`
  + `[${CREDENTIAL_MENU_PROXY_ATTRIBUTE}][data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}`

export interface CredentialUiDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly menuLabel: () => string
  readonly popupPlaceholder: () => string
}

export function startCredentialUiDom(options: CredentialUiDomOptions): () => void {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  if (dom === undefined || Observer === undefined) return () => undefined

  let disposed = false
  let queued = false
  const inputPrototype = dom.defaultView?.HTMLInputElement?.prototype
  const originalFocus = inputPrototype?.focus
  const patchedFocus = originalFocus === undefined ? undefined : function (this: HTMLInputElement, focusOptions?: FocusOptions): void {
    sanitizeCredentialSearchInput(this, options.popupPlaceholder())
    originalFocus.call(this, focusOptions)
  }
  if (inputPrototype !== undefined && patchedFocus !== undefined) {
    inputPrototype.focus = patchedFocus as typeof inputPrototype.focus
  }
  const onFocusIn = (event: FocusEvent): void => {
    const target = event.target
    if (target instanceof Element) sanitizeCredentialSearchInput(target, options.popupPlaceholder())
  }
  const observer = new Observer(() => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(() => {
      queued = false
      if (!disposed) scan(dom, options.menuLabel(), options.popupPlaceholder())
    })
  })

  dom.addEventListener('focusin', onFocusIn, true)
  installStyles(dom)
  observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
  scan(dom, options.menuLabel(), options.popupPlaceholder())

  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    dom.removeEventListener('focusin', onFocusIn, true)
    if (inputPrototype !== undefined && originalFocus !== undefined && inputPrototype.focus === patchedFocus) {
      inputPrototype.focus = originalFocus
    }
    removeCredentialNodes(dom)
  }
}

function scan(dom: Document, label: string, popupPlaceholder: string): void {
  sanitizeCredentialSearchInputs(dom, popupPlaceholder)
  const listbox = findSlashMenuListbox(dom)
  if (listbox === undefined) return
  const row = findCredentialRow(listbox, label)
  const section = listbox.querySelectorAll(SECTION_TITLE_SELECTOR)[0]
  if (row === undefined || section === undefined) {
    removeProxies(listbox)
    if (row !== undefined) row.removeAttribute(CREDENTIAL_MENU_ROW_ATTRIBUTE)
    return
  }

  let proxy = listbox.querySelector(`[${CREDENTIAL_MENU_PROXY_ATTRIBUTE}]`)
  if (proxy !== null && proxy.getAttribute('data-codingns-credential-source') !== row.getAttribute('id')) {
    proxy.remove()
    proxy = null
  }
  if (proxy === null) {
    proxy = row.cloneNode(true) as Element
    proxy.removeAttribute(CREDENTIAL_MENU_ROW_ATTRIBUTE)
    proxy.removeAttribute('id')
    proxy.removeAttribute('aria-selected')
    proxy.setAttribute(CREDENTIAL_MENU_PROXY_ATTRIBUTE, '')
    proxy.setAttribute('data-codingns-credential-source', row.getAttribute('id') ?? '')
    proxy.setAttribute('data-active', 'false')
    forwardEvent(proxy, row, 'mousemove')
    forwardEvent(proxy, row, 'mousedown')
    proxy.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
  }

  const anchor = listbox.querySelector(DELEGATE_PROXY_SELECTOR)
  const addLast = lastAddOption(section)
  const insertionAnchor = anchor ?? addLast ?? section
  if (proxy.parentNode !== insertionAnchor.parentNode || proxy.previousElementSibling !== insertionAnchor) {
    insertionAnchor.parentNode?.insertBefore(proxy, insertionAnchor.nextSibling)
  }
  row.setAttribute(CREDENTIAL_MENU_ROW_ATTRIBUTE, '')
  syncActive(row, proxy)
}

function sanitizeCredentialSearchInputs(dom: Document, placeholder: string): void {
  if (placeholder === '') return
  for (const input of dom.querySelectorAll('input')) sanitizeCredentialSearchInput(input, placeholder)
}

function sanitizeCredentialSearchInput(target: Element, placeholder: string): void {
  if (target.tagName !== 'INPUT' || target.getAttribute('placeholder') !== placeholder) return
  target.setAttribute('type', 'text')
  target.setAttribute('autocomplete', 'off')
  target.setAttribute('name', 'codingns-credential-search')
  target.setAttribute('data-1p-ignore', 'true')
  target.setAttribute('data-1password-ignore', 'true')
  target.setAttribute('data-lpignore', 'true')
  target.setAttribute('data-bwignore', 'true')
}

function findSlashMenuListbox(dom: Document): Element | undefined {
  return [...dom.querySelectorAll(MENU_LISTBOX_SELECTOR)]
    .find((listbox) => listbox.querySelector(`[id^="${MENU_OPTION_ID_PREFIX}"]`) !== null)
}

function findCredentialRow(listbox: Element, label: string): Element | undefined {
  for (const row of listbox.querySelectorAll(MENU_OPTION_SELECTOR)) {
    if (row.hasAttribute(CREDENTIAL_MENU_PROXY_ATTRIBUTE)) continue
    if (row.getAttribute('id')?.startsWith(MENU_OPTION_ID_PREFIX) !== true) continue
    const name = row.querySelector(ITEM_NAME_SELECTOR)
    if (name !== null && (name.textContent ?? '').trim() === label) return row
  }
  return undefined
}

function lastAddOption(section: Element): Element | undefined {
  let last: Element | undefined
  let sibling = section.nextElementSibling
  while (sibling !== null && sibling.matches(MENU_OPTION_SELECTOR)) {
    last = sibling
    sibling = sibling.nextElementSibling
  }
  return last
}

function forwardEvent(proxy: Element, target: Element, type: string): void {
  proxy.addEventListener(type, (event) => {
    event.preventDefault()
    const view = target.ownerDocument.defaultView
    const eventConstructor = view?.MouseEvent ?? (typeof MouseEvent === 'undefined' ? undefined : MouseEvent)
    target.dispatchEvent(eventConstructor === undefined ? new Event(type, { bubbles: true, cancelable: true }) : new eventConstructor(type, { bubbles: true, cancelable: true }))
  })
}

function syncActive(row: Element, proxy: Element): void {
  const active = row.getAttribute('aria-selected') === 'true'
  const nextActive = String(active)
  if (proxy.getAttribute('data-active') !== nextActive) proxy.setAttribute('data-active', nextActive)
  if (active) {
    if (proxy.getAttribute('aria-selected') !== 'true') proxy.setAttribute('aria-selected', 'true')
  } else if (proxy.hasAttribute('aria-selected')) {
    proxy.removeAttribute('aria-selected')
  }
}

function installStyles(dom: Document): void {
  if (dom.querySelector('style[data-codingns-credential-ui]') !== null) return
  const style = dom.createElement('style')
  style.setAttribute('data-codingns-credential-ui', '')
  style.textContent = styleText
  dom.head.appendChild(style)
}

function removeCredentialNodes(dom: Document): void {
  for (const node of dom.querySelectorAll(`[${CREDENTIAL_MENU_PROXY_ATTRIBUTE}]`)) node.remove()
  for (const node of dom.querySelectorAll(`[${CREDENTIAL_MENU_ROW_ATTRIBUTE}]`)) node.removeAttribute(CREDENTIAL_MENU_ROW_ATTRIBUTE)
  dom.querySelector('style[data-codingns-credential-ui]')?.remove()
}

function removeProxies(listbox: Element): void {
  for (const node of listbox.querySelectorAll(`[${CREDENTIAL_MENU_PROXY_ATTRIBUTE}]`)) node.remove()
}

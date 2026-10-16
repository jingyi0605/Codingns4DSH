import { useLayoutEffect, useRef } from 'react'
import { SETTINGS_BUTTON_SELECTOR, SETTINGS_LAUNCHER_SLOT_SELECTOR } from './settings-anchor.js'

/** Shared geometry for Quick Apps and the account/connection entry beside Settings. */
export const sidebarFooterControlStyle = {
  width: '32px', height: '32px', flex: '0 0 32px', padding: 0, border: 0,
  borderRadius: 'var(--dsw-radius-sm, 6px)', boxSizing: 'border-box',
} as const

/** Account for native footer insets without changing the Host's Settings row. */
export function useSidebarFooterAlignment(wide: boolean) {
  const rail = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const element = rail.current
    if (!element) return
    const dom = element.ownerDocument
    const win = dom.defaultView
    let scope = element.parentElement
    while (scope && !scope.querySelector(SETTINGS_LAUNCHER_SLOT_SELECTOR) && !scope.querySelector(SETTINGS_BUTTON_SELECTOR)) scope = scope.parentElement
    const container = scope ?? dom.body
    let reference: HTMLElement | null = null
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => align())
    const align = () => {
      const next = container.querySelector<HTMLElement>('button[data-codingns-account-button]')
      if (next !== reference) {
        if (reference) resize?.unobserve(reference)
        reference = next
        if (reference) resize?.observe(reference)
      }
      if (!reference || !reference.getClientRects().length) {
        element.style.removeProperty('--codingns-quick-app-controls-end')
        return
      }
      const inset = element.getBoundingClientRect().right - reference.getBoundingClientRect().right
      element.style.setProperty('--codingns-quick-app-controls-end', `${inset}px`)
    }
    const changes = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(align)
    changes?.observe(container, { childList: true, subtree: true })
    resize?.observe(element)
    resize?.observe(container)
    win?.addEventListener('resize', align)
    align()
    return () => {
      changes?.disconnect()
      resize?.disconnect()
      win?.removeEventListener('resize', align)
      element.style.removeProperty('--codingns-quick-app-controls-end')
    }
  }, [wide])
  return rail
}

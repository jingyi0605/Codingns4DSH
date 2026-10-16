import { createElement, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { dshThemeColor } from './theme.js'

const styleId = 'codingns-cli-settings-dialog'

/** Native top-layer dialogs escape settings containment and isolate nested dialog focus. */
export function CliSettingsDialog({ titleId, wide = false, onClose, children }: {
  readonly titleId: string
  readonly wide?: boolean
  readonly onClose: () => void
  readonly children?: ReactNode
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = `
.codingns-cli-dialog{position:fixed;margin:auto;width:min(680px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--dsw-alias-border-l3,#d9d9d9);border-radius:14px;box-sizing:border-box;overflow:auto;overscroll-behavior:contain}
.codingns-cli-dialog[data-wide="true"]{width:min(960px,calc(100vw - 32px));height:min(820px,calc(100dvh - 32px))}
.codingns-cli-dialog[open]{display:flex;flex-direction:column}
.codingns-cli-dialog::backdrop{background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45))}
@media(max-width:600px){.codingns-cli-dialog[data-wide="true"]{width:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}`
      document.head.appendChild(style)
    }
    const opener = document.activeElement as HTMLElement | null
    const dialog = ref.current
    dialog?.showModal()
    return () => { if (dialog?.open) dialog.close(); if (opener?.isConnected) opener.focus() }
  }, [])
  const dialog = createElement('dialog', {
    ref, className: 'codingns-cli-dialog', 'data-wide': wide, 'aria-labelledby': titleId, 'aria-modal': true,
    onCancel: (event: { preventDefault(): void; stopPropagation(): void }) => { event.preventDefault(); event.stopPropagation(); onClose() },
    onKeyDown: (event: { key: string; stopPropagation(): void }) => { if (event.key === 'Escape') event.stopPropagation() },
    onPointerDown: (event: { target: unknown; currentTarget: HTMLDialogElement; clientX: number; clientY: number }) => {
      if (event.target !== event.currentTarget) return
      const box = event.currentTarget.getBoundingClientRect()
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose()
    },
    style: { color: dshThemeColor.labelPrimary, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.prominentShadow },
  }, children)
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

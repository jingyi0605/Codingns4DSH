import type { ComponentType } from 'react'

interface FooterSlots {
  inject(name: string, install: () => () => void): () => void
  register(options: { name: string; id: string; order: number }, component: ComponentType<{ wide: boolean }>): () => void
}

export function supportsQuickAppFooter(value: unknown): value is FooterSlots {
  const slots = value as Partial<FooterSlots> | undefined
  return typeof slots?.inject === 'function' && typeof slots.register === 'function'
}

/** Wait for the native declaration; releasing the module also cancels a pending registration. */
export function registerQuickAppFooter(slots: unknown, component: ComponentType<{ wide: boolean }>): () => void {
  if (!supportsQuickAppFooter(slots)) return () => undefined
  return slots.inject('sidebar.footer.action', () => slots.register({ name: 'sidebar.footer.action', id: 'codingns-quick-apps', order: 40 }, component))
}

import { createElement as h, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { DshButton, resolveTerminalArrowIcon } from '../../dsh-capabilities/client/primitives-adapter.js'

/** Content atoms follow CodingNS ModalAtoms; DSH retains the portal and focus lifecycle. */
export function QuickAppField({ id, label, help, error, children }: { id: string; label: string; help?: string | undefined; error?: string | undefined; children?: ReactNode }): ReactElement {
  return h('div', { className: 'qa-field' }, h('label', { htmlFor: id }, label), children,
    error ? h('span', { id: `${id}-help`, className: 'qa-field-error', role: 'alert' }, error) : help ? h('span', { id: `${id}-help`, className: 'qa-help' }, help) : null)
}

export function QuickAppActions({ children }: { children?: ReactNode }): ReactElement {
  return h('div', { className: 'qa-actions' }, children)
}

export function QuickAppButton({ children, danger = false, variant = 'ghost', className = '', ...props }: ComponentProps<typeof DshButton> & { danger?: boolean }): ReactElement {
  return h(DshButton, { ...props, type: props.type ?? 'button', variant,
    className: `qa-button${danger ? ' qa-danger' : ''}${variant === 'primary' ? ' qa-primary' : ''} ${className}`.trim() }, children)
}

export function QuickAppControlIcon({ icon }: { icon: 'add' | 'edit' | 'done' | 'retry' | 'collapse' | 'expand' | 'remove' }): ReactElement {
  if (icon === 'collapse' || icon === 'expand') return h(resolveTerminalArrowIcon(icon === 'collapse' ? 'down' : 'up'), { size: 16 })
  const path = { add: 'M12 5v14M5 12h14', edit: 'm16 3 5 5-12 12H4v-5L16 3ZM13 6l5 5', done: 'm5 12 4 4L19 6', retry: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5',
    collapse: 'm6 9 6 6 6-6', expand: 'm6 15 6-6 6 6', remove: 'm7 7 10 10M7 17 17 7' }[icon]
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))
}

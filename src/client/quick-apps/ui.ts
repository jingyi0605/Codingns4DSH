import { createElement as h, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { DshButton } from '../../dsh-capabilities/client/primitives-adapter.js'

/** Content atoms follow CodingNS ModalAtoms; DSH retains the portal and focus lifecycle. */
export function QuickAppField({ label, help, error, children }: { label: string; help?: string | undefined; error?: string | undefined; children?: ReactNode }): ReactElement {
  return h('label', { className: 'qa-field' }, h('span', null, label), children,
    error ? h('span', { className: 'qa-field-error', role: 'alert' }, error) : help ? h('span', { className: 'qa-help' }, help) : null)
}

export function QuickAppActions({ children }: { children?: ReactNode }): ReactElement {
  return h('div', { className: 'qa-actions' }, children)
}

export function QuickAppButton({ children, danger = false, ...props }: ComponentProps<typeof DshButton> & { danger?: boolean }): ReactElement {
  return h(DshButton, { ...props, type: props.type ?? 'button', variant: 'outline', className: danger ? 'qa-button qa-danger' : 'qa-button' }, children)
}

export function QuickAppControlIcon({ icon }: { icon: 'add' | 'edit' | 'done' | 'retry' }): ReactElement {
  const path = { add: 'M12 5v14M5 12h14', edit: 'm16 3 5 5-12 12H4v-5L16 3ZM13 6l5 5', done: 'm5 12 4 4L19 6', retry: 'M20 7v5h-5M20 12a8 8 0 1 0-2 5' }[icon]
  return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: path }))
}

import { createElement, type ComponentType } from 'react'
import { followPresentationEntry, type PresentationSlots } from './slot-presentation-mirror.js'

/** 在原生权限单席位复用已注册的组件与数据依赖，随宿主加载和卸载恢复。 */
export function registerAgentPermissionPresentation(
  value: unknown,
  component: ComponentType<any>,
  inject: (sessionId: string) => object,
): () => void {
  const slots = value as Partial<PresentationSlots> | undefined
  if (slots == null || typeof slots.entries !== 'function' || typeof slots.subscribe !== 'function') return () => undefined
  const id = 'codingns4dsh-native-approval'
  return followPresentationEntry(slots as PresentationSlots, 'conversation.input.permission',
    entry => entry.options.id !== id,
    native => slots.register!({
      name: 'conversation.input.permission', id, priority: -100,
      locale: native.locale, store: native.store, select: native.select,
      inject: (sessionId: string) => ({
        ...(typeof native.inject === 'function' ? native.inject(sessionId) : native.inject as object),
        ...inject(sessionId),
      }),
    }, props => createElement(component, { ...props, NativePermission: native.component })))
}

import { createElement, useEffect, useState } from 'react'
import type { ComponentType, ReactElement } from 'react'
import type { CodingNsTranslator } from '../locale.js'
import { dshSettingsButtonStyle, dshSettingsHelpStyle, dshThemeColor } from '../theme.js'

/** 模块只有一份缓存；失败可重试，订阅解绑后迟到的结果不能重新打开界面。 */
export function createAssistantViewLoader<T>(load: () => Promise<T>) {
  let value: T | undefined
  let pending: Promise<T> | undefined
  return {
    peek: (): T | undefined => value,
    load(): Promise<T> {
      if (value !== undefined) return Promise.resolve(value)
      pending ??= Promise.resolve().then(load).then((next) => { value = next; return next }).finally(() => { pending = undefined })
      return pending
    },
    watch(resolve: (value: T) => void, reject: (error: unknown) => void): () => void {
      let active = true
      void this.load().then((next) => { if (active) resolve(next) }, (error) => { if (active) reject(error) })
      return () => { active = false }
    },
  }
}

/** 动态模块沿用宿主 React；此边界只加载组件，不创建运行时、草稿或注册服务。 */
export function AssistantLoadedView<P extends object>({ loader, viewProps, t, onClose, overlay = false }: {
  readonly loader: ReturnType<typeof createAssistantViewLoader<ComponentType<P>>>
  readonly viewProps: P
  readonly t: CodingNsTranslator
  readonly onClose?: (() => void) | undefined
  readonly overlay?: boolean
}): ReactElement {
  const [Component, setComponent] = useState(() => loader.peek())
  const [error, setError] = useState<unknown>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setComponent(() => loader.peek())
    setError(undefined)
    return loader.watch((next) => setComponent(() => next), setError)
  }, [loader, attempt])
  useEffect(() => {
    if (Component || !onClose) return
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopImmediatePropagation(); onClose() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [Component, onClose])
  if (Component) return createElement(Component, viewProps)
  return createElement('div', { role: overlay ? 'dialog' : 'status', 'aria-modal': overlay || undefined,
    style: overlay ? { position: 'fixed', inset: 0, zIndex: 10010, display: 'grid', placeContent: 'center', background: dshThemeColor.overlay } : undefined },
    createElement('div', { style: { ...dshSettingsHelpStyle, padding: 16, borderRadius: 12, background: dshThemeColor.pageBackground } },
      error === undefined ? t('awb.loading') : createElement('div', { role: 'alert' }, error instanceof Error ? error.message : String(error)),
      error === undefined ? null : createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: () => setAttempt((value) => value + 1) }, t('awb.retry')),
      !onClose ? null : createElement('button', { type: 'button', style: dshSettingsButtonStyle, onClick: onClose }, t('awb.close'))))
}

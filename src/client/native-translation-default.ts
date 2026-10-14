/**
 * DSH 原生会话翻译开关的默认值读取器。
 *
 * 会话翻译功能模块在启动时注册读取器，模型菜单订阅变化；两个功能模块
 * （`cliAdapters` 注册槽位、`sessionTranslation` 决定默认值）不互相引用。
 */
let reader: (() => boolean) | undefined
const listeners = new Set<() => void>()

export function setNativeTranslationDefaultReader(next: (() => boolean) | undefined): void {
  reader = next
  notifyNativeTranslationDefaultChanged()
}

/** undefined 表示功能模块未启用，不应向原生模型菜单添加开关。 */
export function readNativeTranslationDefault(): boolean | undefined {
  try {
    return reader === undefined ? undefined : reader() === true
  } catch {
    return undefined
  }
}

export function subscribeNativeTranslationDefault(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function notifyNativeTranslationDefaultChanged(): void {
  for (const listener of listeners) listener()
}

/**
 * 注入 H5 iframe 的窄图片桥。函数必须自包含：调用方将函数源码写进 srcdoc，
 * 不依赖父窗口模块变量，也不增加全页面 MutationObserver。
 */
export function installProviderIconImageBridge(
  realm: Pick<typeof globalThis, 'HTMLImageElement' | 'Element' | 'document' | 'location' | 'Event'>,
  prefix: string,
  load: (path: string) => Promise<string>,
): void {
  if (typeof realm.HTMLImageElement === 'undefined' || typeof realm.Element === 'undefined') return
  const imagePrototype = realm.HTMLImageElement.prototype
  const elementPrototype = realm.Element.prototype
  const descriptor = Object.getOwnPropertyDescriptor(imagePrototype, 'src')
  if (!descriptor?.set || !descriptor.configurable) return
  const nativeSet = elementPrototype.setAttribute
  const nativeRemove = elementPrototype.removeAttribute
  const requests = new WeakMap<Element, object>()
  const loads = new Map<string, Promise<string>>()
  const assign = (node: Element, value: string): boolean => {
    // 即便换成普通 URL，也要使先前的异步图片失效。
    requests.delete(node)
    let parsed: URL
    try { parsed = new URL(value, realm.document.baseURI || 'https://dsh.remote.invalid/') } catch { return false }
    if (!parsed.pathname.startsWith(prefix) || (parsed.origin !== 'https://dsh.remote.invalid' && parsed.origin !== realm.location.origin)) return false
    const path = parsed.pathname + parsed.search
    const token = {}
    requests.set(node, token)
    // 换图片时先清掉旧图，避免网络失败后继续显示错误提供商。
    nativeRemove.call(node, 'src')
    let pending = loads.get(path)
    if (pending === undefined) {
      pending = Promise.resolve().then(() => load(path))
      loads.set(path, pending)
      void pending.catch(() => { if (loads.get(path) === pending) loads.delete(path) })
    }
    void pending.then((url) => {
      if (requests.get(node) === token) nativeSet.call(node, 'src', url)
    }, () => {
      if (requests.get(node) === token) node.dispatchEvent(new realm.Event('error'))
    })
    return true
  }
  Object.defineProperty(imagePrototype, 'src', { ...descriptor, set(value: string) {
    if (!assign(this, String(value))) descriptor.set!.call(this, value)
  } })
  elementPrototype.setAttribute = function (name: string, value: string): void {
    if (this.tagName === 'IMG' && name.toLowerCase() === 'src' && assign(this, String(value))) return
    nativeSet.call(this, name, value)
  }
  elementPrototype.removeAttribute = function (name: string): void {
    if (this.tagName === 'IMG' && name.toLowerCase() === 'src') requests.delete(this)
    nativeRemove.call(this, name)
  }
}

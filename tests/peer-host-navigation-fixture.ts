/** 模拟 DSH 原生前台选择 Store；请求回放不会自动改变它。 */
export function createNavigationFixture(initial: unknown = {}) {
  let current = initial
  const listeners = new Set<() => void>()
  const selection = {
    getSnapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(value: unknown) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
  const services = new Map<string, unknown>([['uiWorkspace', { selection }]])
  return { selection, services, context: { get: (name: string) => services.get(name) }, listeners }
}

import React from 'react'

/** 无浏览器的组件控制测试：保留 Hook 状态并执行订阅清理，不模拟 DOM 或音频设备。 */
export function createHookRenderer<P, R>(component: (props: P) => R, initialProps: P) {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const cells: any[] = []
  let cursor = 0
  let dirty = true
  let props = initialProps
  let output: R
  let effects: (() => void)[] = []
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = cursor++
    if (!cells[index] || !same(cells[index].deps, deps)) cells[index] = { deps, value: factory() }
    return cells[index].value
  }
  const effect = (factory: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = cursor++
    const old = cells[index]
    if (old && same(old.deps, deps)) return
    cells[index] = { deps, cleanup: old?.cleanup }
    effects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = factory() })
  }
  const dispatcher = {
    useState(initial: unknown) {
      const index = cursor++
      if (!cells[index]) {
        cells[index] = { value: typeof initial === 'function' ? initial() : initial,
          set: (next: any) => {
            const value = typeof next === 'function' ? next(cells[index].value) : next
            if (!Object.is(value, cells[index].value)) { cells[index].value = value; dirty = true }
          } }
      }
      return [cells[index].value, cells[index].set]
    },
    useRef(initial: unknown) { const index = cursor++; return cells[index] ??= { current: initial } },
    useMemo: memo,
    useCallback: (callback: unknown, deps: readonly unknown[]) => memo(() => callback, deps),
    useEffect: effect,
    useId: () => memo(() => `test-hook-${cursor}`, []),
    useSyncExternalStore(subscribe: (listener: () => void) => () => void, read: () => unknown) {
      effect(() => subscribe(() => { dirty = true }), [subscribe])
      return read()
    },
  }
  return {
    render(nextProps = props): R {
      props = nextProps; dirty = true
      for (let attempts = 0; dirty; attempts++) {
        if (attempts > 30) throw new Error('组件更新没有收敛')
        dirty = false; cursor = 0; effects = []
        const previous = internals.ReactCurrentDispatcher.current
        internals.ReactCurrentDispatcher.current = dispatcher
        try { output = component(props) } finally { internals.ReactCurrentDispatcher.current = previous }
        for (const run of effects) run()
      }
      return output!
    },
    dispose() { for (const cell of cells) cell?.cleanup?.() },
  }
}

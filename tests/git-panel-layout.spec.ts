import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement, ReactNode } from 'react'
import { registerGitManagementUi } from '../data/build/dist/client/git-management.js'
import { gitPanelClass, installGitPanelStyles } from '../data/build/dist/client/git-panel-styles.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elementWhere(node: ReactNode, predicate: (element: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = elementWhere(child, predicate)
      if (found !== undefined) return found
    }
  } else if (node !== null && typeof node === 'object' && 'props' in node) {
    const element = node as ReactElement<any>
    return predicate(element) ? element : elementWhere(element.props.children, predicate)
  }
  return undefined
}

test('Git layout changes preserve both column trees, draft input, and click handlers', async (t) => {
  const registered = new Map<string, { component: (props: any) => ReactElement; props: any }>()
  const snapshot = { items: [{ workspaceId: 'git-layout-workspace', sessionIds: ['git-layout-session'] }] }
  const context = {
    get: () => ({ list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } }),
    sidebarRight: {},
    sidebarRightTabs: { register: () => () => undefined },
    slots: {
      inject: (_name: string, install: () => () => void) => install(),
      register(options: any, component: (props: any) => ReactElement) {
        registered.set(options.name, { component, props: options.inject() })
        return () => undefined
      },
    },
  }
  const rpcCalls: string[] = []
  const rpc = {
    async call(_channel: string, endpoint: string) {
      rpcCalls.push(endpoint)
      const values = {
        'git/status': { snapshot: { enabled: true }, changes: [] },
        'git/history': { items: [{ commitHash: 'layout-commit', subject: 'History stays mounted' }], totalCount: 1 },
        'git/branches': { currentBranch: 'main', local: [], remote: [] },
        'git/commit-diff': { commitHash: 'layout-commit', files: [], content: '', truncated: false },
      }
      assert.ok(endpoint in values)
      return { ok: true, value: values[endpoint] }
    },
  }
  const disposeUi = registerGitManagementUi(context as never, { rpc: rpc as never })
  t.after(disposeUi)
  const panel = registered.get('sidebar.right.pane.tab')!
  const signal = new AbortController().signal
  const previous = ['getComputedStyle', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  })
  let tracks = '600px'
  let measurements = 0
  const resizeCallbacks: Array<() => void> = []
  Object.assign(globalThis, {
    getComputedStyle: () => { measurements++; return { gridTemplateColumns: tracks } },
    ResizeObserver: class {
      constructor(callback: () => void) { resizeCallbacks.push(callback) }
      observe() {}
      disconnect() {}
    },
  })
  const view = createHookRenderer((props: any) => {
    const tree = panel.component(props)
    const grid = elementWhere(tree, (element) => element.props.style?.alignItems === 'start')
    if ((grid as any)?.ref) (grid as any).ref.current = {}
    return tree
  }, { ...panel.props, sessionId: 'git-layout-session', useTabInfo: () => ({ tab: { signal } }) })
  t.after(() => view.dispose())
  view.render()
  await new Promise((resolve) => setImmediate(resolve))
  let tree = view.render()
  const input = () => elementWhere(tree, (element) => element.type === 'textarea')!
  assert.ok(input(), 'The Git status must load before exercising the controls')
  input().props.onChange({ currentTarget: { value: 'Keep this draft' } })
  tree = view.render()
  const switcher = elementWhere(tree, (element) => element.props.id === 'codingns4dsh-git-view')!
  for (const selected of ['history', 'files']) {
    switcher.props.onChange(selected)
    // Overflow and auto-fit collapsed tracks used to feed back into React state.
    for (tracks of ['600px', '620px 0px', '600px', '620px 0px']) {
      for (const callback of resizeCallbacks) callback()
      tree = view.render()
      const grid = elementWhere(tree, (element) => element.props.className === gitPanelClass.contentGrid)!
      assert.ok(grid)
      assert.equal(grid.props['data-active-column'], selected)
      assert.deepEqual(grid.props.children.map((column: ReactElement<any>) => column.props['data-git-column']), ['files', 'history'])
      assert.equal(input().props.value, 'Keep this draft')
    }
  }
  assert.equal(measurements, 0, 'Content resizing must not trigger grid reads or React layout updates')
  const beforeRefresh = rpcCalls.length
  const refresh = elementWhere(tree, (element) => element.type === 'button' && element.props.children === panel.props.t('git.refresh'))!
  assert.equal(refresh.props.disabled, false)
  refresh.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  tree = view.render()
  assert.ok(rpcCalls.length > beforeRefresh)
  assert.equal(input().props.value, 'Keep this draft')

  const history = elementWhere(tree, (element) => typeof element.props.onViewDiff === 'function')!
  history.props.onViewDiff('layout-commit')
  await new Promise((resolve) => setImmediate(resolve))
  tree = view.render()
  const panelRoot = elementWhere(tree, (element) => element.props['data-git-management-panel'] === 'true')!
  assert.ok(elementWhere(tree, (element) => element.props.diff?.commitHash === 'layout-commit'))
  assert.equal(elementWhere(panelRoot, (element) => element.props.diff !== undefined), undefined,
    'The viewport diff overlay must stay outside the query container')
})

test('Git responsive styles keep a stable scrollport and preserve the two-column breakpoint', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  let css = ''
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild: (style: { textContent: string }) => { css = style.textContent } },
  } })
  t.after(() => {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document')
    else Object.defineProperty(globalThis, 'document', previous)
  })
  const dispose = installGitPanelStyles()
  t.after(dispose)
  assert.match(css, /container-type:inline-size;container-name:codingns4dsh-git;scrollbar-gutter:stable/u)
  assert.match(css, /@container codingns4dsh-git \(min-width:612px\)/u)
  assert.match(css, /grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u)
  assert.ok(css.includes(`[data-active-column='files']>[data-git-column='history']`))
  assert.ok(css.includes(`[data-active-column='history']>[data-git-column='files']`))
  assert.ok(css.includes(`.${gitPanelClass.columnSwitch}{display:none}`))
  assert.ok(css.includes('[data-active-column]>[data-git-column]{display:flex}'))
})

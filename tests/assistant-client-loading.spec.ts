import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { readFile } from 'node:fs/promises'
import { createElement, isValidElement } from 'react'
import type { ReactElement } from 'react'
import { AssistantLoadedView, createAssistantViewLoader } from '../src/client/features/assistant-view-loader.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

test('动态模块并发只加载一次，取消订阅隔离迟到成功，重开复用缓存', async () => {
  const pending = deferred<object>(); const value = {}; let calls = 0; let closedCalls = 0; let openValue: object | undefined
  const loader = createAssistantViewLoader(() => { calls++; return pending.promise })
  assert.equal(calls, 0)
  const close = loader.watch(() => { closedCalls++ }, assert.fail)
  const release = loader.watch((next) => { openValue = next }, assert.fail)
  await setImmediate(); assert.equal(calls, 1)
  close(); pending.resolve(value); await setImmediate()
  assert.equal(closedCalls, 0); assert.equal(openValue, value); assert.equal(await loader.load(), value)
  assert.equal(calls, 1); release()
})

test('动态模块失败可重试，取消后迟到失败不修改新界面', async () => {
  let pending = deferred<string>(); let errors = 0; let loaded = ''; let calls = 0
  const loader = createAssistantViewLoader(() => { calls++; return pending.promise })
  const close = loader.watch(assert.fail, () => { errors++ })
  await setImmediate(); close(); pending.reject(new Error('首轮关闭')); await setImmediate()
  assert.equal(errors, 0)
  pending = deferred<string>()
  const dispose = loader.watch((value) => { loaded = value }, () => { errors++ })
  await setImmediate(); pending.resolve('已加载'); await setImmediate()
  assert.equal(calls, 2); assert.equal(loaded, '已加载'); assert.equal(errors, 0); dispose()
})

test('动态边界展示国际化加载、失败重试及关闭，成功保留 services 和草稿引用', async (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() })
  const t = resolveCodingNsTranslator(); const services = {}; const draft = {}; let closed = 0; let calls = 0
  const Component = (_props: { services: object; draft: object }) => createElement('div')
  const loader = createAssistantViewLoader(async () => { if (++calls === 1) throw new Error('模块下载失败'); return Component })
  const renderer = createHookRenderer(AssistantLoadedView<{ services: object; draft: object }>, { loader, viewProps: { services, draft }, t, overlay: true, onClose: () => { closed++ } })
  context.after(() => { renderer.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  let tree = renderer.render()
  assert.ok(elements(tree).some((element) => element.props.children?.includes?.(t('awb.loading'))))
  await setImmediate(); tree = renderer.render()
  assert.ok(elements(tree).some((element) => element.props.role === 'alert' && element.props.children === '模块下载失败'))
  elements(tree).find((element) => element.type === 'button' && element.props.children === t('awb.retry'))!.props.onClick()
  renderer.render(); await setImmediate(); tree = renderer.render()
  assert.equal(tree.type, Component); assert.equal(tree.props.services, services); assert.equal(tree.props.draft, draft)
  assert.equal(calls, 2); assert.equal(closed, 0)
})

test('全局入口、配置与调试具有真实动态 import 边界，配置不能静态拉入调试大界面', async () => {
  const root = new URL('../src/client/features/', import.meta.url)
  const [global, workbench, config, loader] = await Promise.all(['global-voice-assistant.ts', 'assistant-workbench.ts', 'assistant-configuration-view.ts', 'assistant-configuration-loader.ts'].map((file) => readFile(new URL(file, root), 'utf8')))
  assert.match(global, /import\('\.\/assistant-workbench\.js'\)/u)
  assert.doesNotMatch(global, /import \{ AssistantWorkbench \}/u)
  assert.match(workbench, /import\('\.\/assistant-debug-workbench\.js'\)/u)
  assert.match(loader, /import\('\.\/assistant-configuration-view\.js'\)/u)
  assert.doesNotMatch(workbench, /import \{.*\} from '\.\/assistant-debug-dialog\.js'/u)
  assert.doesNotMatch(config, /from '\.\/assistant-debug-(?:dialog|workbench)\.js'/u)
})

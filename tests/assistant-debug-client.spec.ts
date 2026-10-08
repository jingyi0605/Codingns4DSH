import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { isValidElement } from 'react'
import type { ReactElement } from 'react'
import { AssistantDebugDialog } from '../src/client/features/assistant-debug-workbench.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { CodingNsClientServices, CodingNsRpcClient } from '../src/client/features/types.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

test('调试草稿代理通过原 RPC 共用展示订阅，初次打开只有一次 debug，按钮才强制刷新', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const dom = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom })
  const payloads: unknown[] = []; const calls: string[] = []
  const rpc: CodingNsRpcClient = { call: async (_channel, endpoint, payload) => {
    calls.push(endpoint)
    if (endpoint === 'assistant/debug') {
      payloads.push(payload)
      return { ok: true, value: { index: { generation: 1, analysis: undefined }, indexState: 'ready', workspaces: [], warnings: [], scopeSessions: [], records: [] } }
    }
    return { ok: true, value: { models: [], default: null, errors: [] } }
  } }
  const t = resolveCodingNsTranslator()
  const services = { settings: { getSnapshot: () => ({ value: DEFAULT_CODINGNS_SETTINGS, status: 'ready', writable: true }), subscribe: () => () => {} }, rpc,
    locale: { bind: () => t, getSnapshot: () => ({ revision: 1 }), subscribe: () => () => {} } } as unknown as CodingNsClientServices
  const first = createHookRenderer(AssistantDebugDialog, { services, onClose() {} })
  const draft = { ...services, rpc: { call: rpc.call } }
  const second = createHookRenderer(AssistantDebugDialog, { services: draft, displayRpc: rpc, onClose() {} })
  context.after(() => { first.dispose(); second.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  assert.ok(elements(first.render()).some((element) => element.props.children === t('assistant.debug.loading')))
  second.render(); await setImmediate(); first.render(); second.render()
  assert.deepEqual(payloads, [{}])
  const button = elements(first.render()).find((element) => element.type === 'button' && element.props.children === t('assistant.debug.viewRefresh'))!
  assert.equal(button.props.disabled, false); button.props.onClick(); await setImmediate(); first.render()
  assert.deepEqual(payloads, [{}, { refresh: true }])
  dom.visibilityState = 'hidden'; dom.dispatchEvent(new Event('visibilitychange'))
  context.mock.timers.tick(30_000); await setImmediate(); assert.equal(payloads.length, 2)
  dom.visibilityState = 'visible'; dom.dispatchEvent(new Event('visibilitychange')); await setImmediate()
  assert.equal(payloads.length, 3)
  assert.ok(calls.every((endpoint) => ['assistant/debug', 'assistant/chat/models'].includes(endpoint)), '纯展示不重建索引或取消后台任务')
})

test('调试索引操作关闭后迟到完成不能再次触发强制刷新', async (context) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: new EventTarget() })
  const t = resolveCodingNsTranslator(); let complete!: () => void; let reads = 0
  const model = { provider: 'api', model: 'fixture', label: '测试模型' }
  const value = structuredClone(DEFAULT_CODINGNS_SETTINGS); value.assistant.managedWorkspaceIds = ['workspace']
  const services = {
    locale: { bind: () => t, getSnapshot: () => ({ revision: 1 }), subscribe: () => () => {} },
    settings: { getSnapshot: () => ({ value, status: 'ready', writable: true }), subscribe: () => () => {} },
    rpc: { call: async (_channel: string, endpoint: string) => {
      if (endpoint === 'assistant/index/rebuild') { await new Promise<void>((resolve) => { complete = resolve }); return { ok: true, value: {} } }
      if (endpoint === 'assistant/debug') { reads++; return { ok: true, value: { index: { generation: 1 }, indexState: 'ready', workspaces: [] } } }
      return { ok: true, value: { models: [model], default: model, errors: [] } }
    } },
  } as unknown as CodingNsClientServices
  const renderer = createHookRenderer(AssistantDebugDialog, { services, onClose() {} })
  context.after(() => { renderer.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  renderer.render(); await setImmediate()
  const button = elements(renderer.render()).find((element) => element.type === 'button' && element.props.children === t('assistant.debug.build'))!
  assert.equal(button.props.disabled, false); button.props.onClick(); await setImmediate()
  renderer.dispose(); complete(); await setImmediate()
  assert.equal(reads, 1, '关闭后只保留原始展示读取，不发起迟到刷新')
})

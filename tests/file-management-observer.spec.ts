import assert from 'node:assert/strict'
import test from 'node:test'
import { startFileManagementDom } from '../src/client/file-management-dom.js'

test('聊天增量不触发全页预览扫描，新增和局部更新只检查目标预览', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver')
  let callback!: MutationCallback
  let fullScans = 0
  let observed = 0
  let disconnected = 0
  const dom = Object.assign(new EventTarget(), { body: {}, querySelectorAll: () => { fullScans++; return [] } })
  class Observer {
    constructor(listener: MutationCallback) { callback = listener }
    observe() { observed++ }
    disconnect() { disconnected++ }
  }
  Object.defineProperty(globalThis, 'document', { value: dom, configurable: true })
  Object.defineProperty(globalThis, 'MutationObserver', { value: Observer, configurable: true })
  const controller = startFileManagementDom({ call: async () => { throw new Error('扫描不应请求 RPC') } }, { fileEditor: true, menuEnhancement: false })
  const mutate = (records: unknown[]) => callback(records as MutationRecord[], {} as MutationObserver)
  try {
    assert.equal(fullScans, 1)
    assert.equal(observed, 1)
    const chat = { nodeType: 1, closest: () => null, matches: () => false, querySelectorAll: () => [] }
    for (let index = 0; index < 100; index++) mutate([{ target: chat, addedNodes: [{ nodeType: 3 }] }])
    assert.equal(fullScans, 1, '100 次聊天增量不应增加全页扫描')
    let previewChecks = 0
    const preview = {
      nodeType: 1, isConnected: true, dataset: {},
      closest: () => preview, matches: () => true, querySelectorAll: () => [],
      getAttribute(name: string) {
        if (name === 'data-textpreview-state') previewChecks++
        return name === 'data-textpreview-state' ? 'loading' : '/test.txt'
      },
    }
    // 新增节点本身和同批次内部更新指向同一预览，只检查一次。
    mutate([{ target: chat, addedNodes: [preview] }, { target: preview, addedNodes: [] }])
    assert.equal(previewChecks, 1)
    const container = { ...chat, querySelectorAll: () => [preview] }
    mutate([{ target: chat, addedNodes: [container] }])
    assert.equal(previewChecks, 2, '预览作为新增子树的后代也能被发现')
    assert.equal(fullScans, 1)
    controller.setOptions({ fileEditor: false, menuEnhancement: false })
    assert.equal(disconnected, 1)
    mutate([{ target: preview, addedNodes: [] }])
    assert.equal(previewChecks, 2)
    controller.setOptions({ fileEditor: true, menuEnhancement: false })
    assert.equal(observed, 2)
    controller.dispose()
    const scansAfterDispose = fullScans
    mutate([{ target: preview, addedNodes: [] }])
    controller.setOptions({ fileEditor: true, menuEnhancement: false })
    assert.equal(fullScans, scansAfterDispose)
    assert.equal(observed, 2)
  } finally {
    controller.dispose()
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previousObserver) Object.defineProperty(globalThis, 'MutationObserver', previousObserver)
    else Reflect.deleteProperty(globalThis, 'MutationObserver')
  }
})

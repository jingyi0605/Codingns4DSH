import assert from 'node:assert/strict'
import test from 'node:test'
import { createPeerHostPageTransport } from '../data/build/dist/client/features/peer-host.js'
import { createPeerHostRemoteSummarySource } from '../data/build/dist/host/modules/peer-host/peer-host-remote-summary-source.js'
import { createAggregateHostSource, PeerHostAggregateService } from '../data/build/dist/host/modules/peer-host/peer-host-aggregate-service.js'
import { createVirtualSessionId } from '../data/build/dist/shared/index.js'

interface TitleBlock {
  readonly kind: 'cached' | 'sequenced'
  readonly asOfSeq: number
  readonly values: { readonly title: string | null }
}

/**
 * DSH ProjectionValueStore 的消费契约：缓存不能覆盖有序值，有序值只接受更大序号。
 * 用这个独立消费者验证完整摘要链路，避免只检查中间对象而漏掉“未命名”不更新。
 */
function nativeTitleStore() {
  let title: string | null = null
  let sequence: number | undefined
  return {
    read: () => title,
    apply(block: TitleBlock) {
      if (block.kind === 'cached' && sequence !== undefined) return
      if (block.kind === 'sequenced') {
        if (sequence !== undefined && block.asOfSeq <= sequence) return
        sequence = block.asOfSeq
      }
      title = block.values.title
    },
  }
}

test('新建远端会话的空标题可由摘要更新，无需点击加载正文，并拒绝迟到标题', async () => {
  const previousFetch = globalThis.fetch
  const requests: string[] = []
  // 本机会话目录与远端正文隔离；测试期间不允许读取 session/follow 或 session/page。
  globalThis.fetch = (async (input) => {
    requests.push(String(input))
    assert.equal(String(input), '/api/session/list')
    return Response.json({ result: { ok: true, value: { items: [{ sessionId: 'local-session' }] } } })
  }) as typeof fetch
  try {
    let block: TitleBlock = { kind: 'sequenced', asOfSeq: 2, values: { title: null } }
    const source = createPeerHostRemoteSummarySource({
      scope: { hostId: 'local-host', targetHostId: 'peer-1', workspaceId: '__aggregate__', sessionId: null, scopeGeneration: 0 },
      transport: {
        async rpc(request) {
          assert.equal(request.method, 'session/list')
          return { items: [{ sessionId: 'session-1', blank: false, running: false, updatedAt: 10, cwd: '/repo', projections: block }] }
        },
        async *stream(request) {
          assert.equal(request.method, 'workspace/follow')
          yield { type: 'baseline', value: { items: [{ workspaceId: 'workspace-1', path: '/repo', sessionIds: ['session-1'] }] } }
        },
      },
    })
    const aggregateSource = createAggregateHostSource({ hostId: 'local-host', targetHostId: 'peer-1', hostLabel: '远端', source })
    const aggregate = new PeerHostAggregateService()
    const transport = createPeerHostPageTransport()
    const store = nativeTitleStore()
    // 新建时的原生 baseline 已经登记空标题，切走之后不再读取正文。
    store.apply(block)
    const refresh = async (): Promise<boolean> => {
      const changed = transport.setAggregate(await aggregate.load([aggregateSource]))
      if (!changed) return false
      const result = await transport.hooks.rpc!<{ ok: true; value: { items: Array<{ sessionId: string; projections?: TitleBlock }> } }>({
        method: 'session/list', payload: { channel: '/api', payload: {} },
      })
      assert.deepEqual(result.value.items[0], { sessionId: 'local-session' })
      const remote = result.value.items.find((item) => item.sessionId === createVirtualSessionId('peer-1', 'session-1'))!
      store.apply(remote.projections!)
      return true
    }

    assert.equal(await refresh(), true)
    assert.equal(store.read(), null)
    block = { kind: 'sequenced', asOfSeq: 3, values: { title: '修复远程会话名称' } }
    assert.equal(await refresh(), true)
    assert.equal(store.read(), '修复远程会话名称')
    assert.equal(await refresh(), false)

    // 新序号即使标题和 updatedAt 都没变，也必须传到原生 Store，防止迟到帧回退。
    block = { ...block, asOfSeq: 5 }
    assert.equal(await refresh(), true)
    store.apply({ kind: 'sequenced', asOfSeq: 4, values: { title: '迟到的旧标题' } })
    assert.equal(store.read(), '修复远程会话名称')
    // 来源变化也要刷新，不能只比较标题和序号。
    block = { ...block, kind: 'cached' }
    assert.equal(await refresh(), true)
    // 会话卸载后的磁盘缓存不能冒充实时投影，更不能覆盖已经收到的新标题。
    block = { kind: 'cached', asOfSeq: 100, values: { title: '磁盘旧标题' } }
    await refresh()
    assert.equal(store.read(), '修复远程会话名称')
    assert.equal(requests.length, 5)
  } finally {
    globalThis.fetch = previousFetch
  }
})

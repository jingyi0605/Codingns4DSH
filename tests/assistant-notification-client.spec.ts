import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantNotificationStore } from '../src/client/features/assistant-notification-store.js'
import { AssistantNotificationBubble, assistantNotificationIsVisible, assistantNotificationTailStyle, floatingAssistantNotificationLayout } from '../src/client/avatar/notification-bubble.js'
import { AssistantNotificationCenter } from '../src/host/features/assistant-notifications.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { AssistantNotification, AssistantNotificationSnapshot, AssistantNotificationTarget } from '../src/shared/assistant-notifications.js'
import type { CodingNsRpcClient } from '../src/client/features/types.js'

const local = { hostId: 'local', workspaceId: 'project', sessionId: 'same' }
function notice(kind: AssistantNotification['kind'], createdAt = 1): AssistantNotification {
  return { noticeId: `${kind}:${createdAt}`, kind, hostLabel: '当前设备', workspaceLabel: '项目', sessionTitle: '<script>会话</script>',
    text: kind === 'completed' ? '本轮已完成' : '需要你处理', createdAt, read: false, presentation: 'queued', lifecycle: 'active', availability: 'ready' }
}
function frame(primary = notice('question')): AssistantNotificationSnapshot {
  return { generation: 1, revision: 1, serverNow: 1000, primary, items: [primary], unreadCount: 1, pendingCount: 1, cursor: null, capabilities: [] }
}
function fixture(now: () => number = Date.now) {
  const host = new AssistantNotificationCenter({ now })
  host.configure(true, ['project'])
  const calls: Array<{ endpoint: string; payload: any }> = []
  const navigated: AssistantNotificationTarget[] = []
  let failNavigation = false
  const rpc: CodingNsRpcClient = { async call(_channel, endpoint, payload: any) {
    calls.push({ endpoint, payload })
    try {
      const value = endpoint.endsWith('/read') ? host.read(payload) : endpoint.endsWith('/ack') ? host.ack(payload) : await host.target(payload)
      return { ok: true, value }
    } catch (error) { return { ok: false, error: { code: 'FAIL', message: String(error) } } }
  } }
  const store = new AssistantNotificationStore(rpc, async (target) => { if (failNavigation) throw new Error('目标不可达'); navigated.push(target) }, 750, now)
  return { host, store, calls, navigated, fail: (value: boolean) => { failNavigation = value },
    emit(kind: 'question' | 'approval', requestId: string, target = local) { host.consume({ type: 'request-opened', requestId, requestKind: kind, target, generation: host.generation }) },
    turn(kind: 'turn-completed' | 'turn-failed', turnId = 'turn') { host.consume({ type: kind, turnId, target: local, generation: host.generation }) } }
}

test('真实 Host 快照先展示待回答与待审批，同级按时间顺序，再选择错误和完成', (t) => {
  let clock = 1000
  const f = fixture(() => ++clock); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.turn('turn-completed', 'completed'); f.turn('turn-failed', 'error'); f.emit('question', 'q'); f.emit('approval', 'a')
  for (const expected of ['question', 'approval', 'error', 'completed']) {
    const snapshot = f.host.read(); assert.equal(snapshot.primary!.kind, expected)
    f.host.ack({ noticeId: snapshot.primary!.noticeId, generation: snapshot.generation, action: 'dismiss' })
  }
  assert.equal(f.host.read().pendingCount, 2)
})

test('实际展示才确认，关闭不处理请求，成功导航才已读；同会话其他请求保留', async (t) => {
  let clock = 1000
  const f = fixture(() => ++clock); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.emit('question', 'q1'); f.emit('question', 'q2')
  f.store.configure(true, 'enabled'); await f.store.refresh()
  const notice = f.store.getSnapshot().frame!.primary!
  assert.equal(notice.presentedAt, undefined)
  assert.ok(!f.calls.some((call) => call.endpoint.endsWith('/ack')))
  await f.store.acknowledge(notice.noticeId, f.host.generation, 'presented')
  assert.ok(f.store.getSnapshot().frame!.primary!.presentedAt)
  f.fail(true)
  await assert.rejects(f.store.open(notice.noticeId, f.host.generation), /目标不可达/u)
  assert.ok(!f.calls.some((call) => call.payload.action === 'read'))
  f.fail(false)
  await f.store.open(notice.noticeId, f.host.generation)
  assert.deepEqual(f.navigated, [{ ...local, requestId: 'q1', requestKind: 'question' }])
  await f.store.acknowledge(notice.noticeId, f.host.generation, 'dismiss')
  assert.equal(f.host.read().pendingCount, 2)
  assert.ok(f.host.read().items.find((item) => item.noticeId === notice.noticeId)!.read)
  assert.deepEqual(new Set(f.calls.map((call) => call.endpoint)), new Set(['assistant/notifications/read', 'assistant/notifications/ack', 'assistant/notifications/target']))
})

test('刷新与重复确认保留 Host 首展截止时间，完成10秒到期后仍未读；错误不设内置截止', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 10_000
  const f = fixture(() => now); f.turn('turn-completed'); f.store.configure(true, 'completed'); await f.store.refresh()
  const initial = f.store.getSnapshot().frame!
  assert.equal(initial.primary!.deadline, undefined)
  await f.store.acknowledge(initial.primary!.noticeId, initial.generation, 'presented')
  const deadline = now + 10_000
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, deadline)
  f.store.dispose()
  const refreshed = new AssistantNotificationStore({ async call(_channel, endpoint, payload: any) { return { ok: true, value: endpoint.endsWith('/read') ? f.host.read(payload) : f.host.ack(payload) } } }, async () => {}, 750, () => now)
  now += 1000; refreshed.configure(true, 'reload'); await refreshed.refresh()
  await refreshed.acknowledge(initial.primary!.noticeId, initial.generation, 'presented')
  assert.equal(refreshed.getSnapshot().frame!.primary!.deadline, deadline)
  now = deadline; t.mock.timers.tick(9000); await setImmediate(); await refreshed.refresh()
  assert.equal(refreshed.getSnapshot().frame!.primary, null)
  assert.equal(refreshed.getSnapshot().frame!.unreadCount, 1)
  refreshed.dispose()
  // 错误提示没有内置截止时间；自动关闭跟随助理通知设置（autoClose）。
  const failed = fixture(() => now); failed.turn('turn-failed'); failed.store.configure(true, 'error'); await failed.store.refresh()
  const errorFrame = failed.store.getSnapshot().frame!
  await failed.store.acknowledge(errorFrame.primary!.noticeId, errorFrame.generation, 'presented')
  assert.equal(failed.store.getSnapshot().frame!.primary!.deadline, undefined)
  failed.store.dispose(); f.host.dispose()
})

test('一个读取链在隐藏页面仍同步；配置撤销拒绝迟到结果与旧点击', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: () => void, calls = 0, active = 0, maxActive = 0
  const rpc: CodingNsRpcClient = { async call() {
    calls++; maxActive = Math.max(maxActive, ++active)
    await new Promise<void>((resolve) => { release = resolve }); active--
    return { ok: true, value: frame() }
  } }
  const store = new AssistantNotificationStore(rpc, async () => {})
  t.after(() => store.dispose())
  store.configure(true, 'one'); const same = store.refresh(); assert.equal(same, store.refresh())
  await setImmediate(); t.mock.timers.tick(60_000); await setImmediate(); assert.equal(calls, 1)
  const page = store.page('1:1:20'); store.configure(false, 'off'); release(); await same; await page
  assert.equal(store.getSnapshot().frame, undefined)
  assert.equal(calls, 1); assert.equal(maxActive, 1)
  await assert.rejects(store.open('question:1', 1), /失效/u)
})

test('Host 重建修订号重用时清除旧页；远端 target 携带通知的真实连接代次', async (t) => {
  const original = frame(); let replacement = false
  const calls: any[] = []
  const rpc: CodingNsRpcClient = { async call(_channel, endpoint, payload: any) {
    calls.push({ endpoint, payload })
    if (endpoint.endsWith('/target')) return { ok: true, value: { ...local, hostId: 'remote', connectionGeneration: 9 } }
    if (endpoint.endsWith('/ack')) return { ok: true, value: undefined }
    return { ok: true, value: replacement ? { ...frame({ ...notice('approval'), connectionGeneration: 9 }), generation: 2,
      unchanged: payload.revision !== undefined, items: payload.revision !== undefined ? [] : [{ ...notice('approval'), connectionGeneration: 9 }] } : original }
  } }
  const store = new AssistantNotificationStore(rpc, async () => {}); t.after(() => store.dispose())
  store.configure(true, 'same'); await store.refresh(); replacement = true; await store.refresh()
  assert.equal(store.getSnapshot().frame!.generation, 2)
  assert.equal(store.getSnapshot().frame!.items[0]!.kind, 'approval')
  // 当前主气泡与列表应采用同一连接代次；这里显式验证列表中的远端目标。
  const remote = store.getSnapshot().frame!.items[0]!
  await store.open(remote.noticeId, 2)
  assert.equal(calls.find((call) => call.endpoint.endsWith('/target')).payload.connectionGeneration, 9)
})

test('气泡共用安全单条帧和分页快照，文本转义、键盘按钮、触摸与滚动保持可用', () => {
  const snapshot = frame()
  const t = resolveCodingNsTranslator()
  for (const value of [snapshot, { noticeId: snapshot.primary!.noticeId, generation: 1, kind: 'question' as const,
    hostLabel: '远端', workspaceLabel: '项目', sessionTitle: '<script>会话</script>', text: '需要回答', availability: 'ready' as const }]) {
    const html = renderToStaticMarkup(createElement(AssistantNotificationBubble, { frame: value, t, onOpen: () => {}, onDismiss: () => {}, onPresented: () => {} }))
    assert.ok(html.includes('查看会话')); assert.ok(html.includes('收起提醒')); assert.ok(!html.includes('1 项待处理'))
    assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'))
    assert.ok(html.includes('type="button"')); assert.ok(html.includes('touch-action:manipulation')); assert.ok(html.includes('overflow-y:auto'))
    assert.ok(!html.includes('animation:'))
  }
})

test('单条未读直接展示会话卡片，多条提醒在漫画气泡内堆叠卡片和操作', () => {
  const t = resolveCodingNsTranslator()
  const single = frame()
  const singleHtml = renderToStaticMarkup(createElement(AssistantNotificationBubble, {
    frame: single, t, onOpen: () => {}, onDismiss: () => {}, onPresented: () => {},
  }))
  assert.equal((singleHtml.match(/data-codingns-notice-id=/gu) ?? []).length, 1)
  assert.ok(singleHtml.includes('border-radius:24px 24px 24px 8px'))
  assert.ok(singleHtml.includes('<svg')); assert.ok(!singleHtml.includes('clip-path'))
  assert.ok(singleHtml.includes('问题'))
  assert.ok(!singleHtml.includes('1 条未读'))
  const second = { ...notice('approval', 2), sessionTitle: '另一个会话' }
  const multiple: AssistantNotificationSnapshot = { ...single, primary: single.primary, items: [single.primary!, second], unreadCount: 2, pendingCount: 2 }
  const multipleHtml = renderToStaticMarkup(createElement(AssistantNotificationBubble, {
    frame: multiple, t, onOpen: () => {}, onDismiss: () => {}, onPresented: () => {},
  }))
  assert.equal((multipleHtml.match(/data-codingns-notice-id=/gu) ?? []).length, 2)
  assert.ok(multipleHtml.includes('另一个会话'))
  assert.equal((multipleHtml.match(/>查看会话</gu) ?? []).length, 2)
  assert.equal((multipleHtml.match(/>收起提醒</gu) ?? []).length, 2)
  assert.ok(multipleHtml.indexOf('2 条未读') < multipleHtml.indexOf('data-codingns-notice-id='))
  assert.ok(multipleHtml.includes('权限请求'))
  const tail = assistantNotificationTailStyle(96, -100, 320) as Record<string, string>
  assert.equal(tail['--codingns-assistant-tail-left'], '196px')
})

test('分页读取不丢未处理请求，修订变化后游标回到首页，关闭仅收起对应提醒', async (t) => {
  const f = fixture(); t.after(() => { f.store.dispose(); f.host.dispose() })
  for (let index = 0; index < 25; index++) f.emit('question', `request:${index}`)
  f.store.configure(true, 'pages'); await f.store.refresh()
  const first = f.store.getSnapshot().frame!
  assert.equal(first.items.length, 20); assert.equal(first.pendingCount, 25)
  await f.store.page(first.cursor!); assert.equal(f.store.getSnapshot().frame!.items.length, 5)
  f.emit('approval', 'new-request'); await f.store.page(first.cursor!)
  assert.equal(f.store.getSnapshot().frame!.reset, true)
  assert.equal(f.store.getSnapshot().frame!.items.length, 20)
  const selected = f.store.getSnapshot().frame!.primary!
  await f.store.acknowledge(selected.noticeId, f.host.generation, 'dismiss')
  assert.equal(f.store.getSnapshot().frame!.pendingCount, 26)
})

test('主页面隐藏仍保持单循环更新，实际显示确认拒绝后台/裁剪/不可见节点', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } })
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); else delete (globalThis as any).document })
  let reads = 0
  const store = new AssistantNotificationStore({ async call() { reads++; return { ok: true, value: frame() } } }, async () => {})
  t.after(() => store.dispose()); store.configure(true, 'hidden'); await store.refresh()
  t.mock.timers.tick(750); await setImmediate(); assert.equal(reads, 2)
  const dom = { visibilityState: 'visible', defaultView: { innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) } }
  let rect = { left: 50, top: 50, right: 300, bottom: 250 }
  const node = { isConnected: true, ownerDocument: dom, parentElement: null, getClientRects: () => [rect], getBoundingClientRect: () => rect } as unknown as HTMLElement
  assert.equal(assistantNotificationIsVisible(node), true)
  dom.visibilityState = 'hidden'; assert.equal(assistantNotificationIsVisible(node), false)
  dom.visibilityState = 'visible'; rect = { left: 1100, top: 50, right: 1300, bottom: 250 }
  assert.equal(assistantNotificationIsVisible(node), false)
})

test('通知 Remote 流推送初始快照与 revision 增量，不再启动 750ms 读取轮询', async (t) => {
  const initial = frame()
  const delta = { ...frame({ ...notice('approval', 2) }), generation: initial.generation, revision: initial.revision + 1 }
  let reads = 0
  let release!: (value: AssistantNotificationSnapshot | null) => void
  const rpc: CodingNsRpcClient = {
    async call() { reads++; return { ok: true, value: initial } },
    open(_channel, _endpoint, _payload, signal) {
      return (async function* () {
        yield { type: 'snapshot', snapshot: initial }
        const next = await new Promise<typeof delta | null>((resolve) => {
          release = resolve
          signal.addEventListener('abort', () => resolve(null), { once: true })
        })
        if (next !== null) yield { type: 'delta', snapshot: next }
      })()
    },
  }
  const store = new AssistantNotificationStore(rpc, async () => {})
  t.after(() => store.dispose())
  store.configure(true, 'stream')
  await setImmediate()
  assert.equal(reads, 0)
  assert.equal(store.getSnapshot().frame?.revision, initial.revision)
  release(delta)
  await setImmediate()
  assert.equal(store.getSnapshot().frame?.revision, delta.revision)
})

test('网页通知在字幕另一侧或形象旁显示，窄屏约束不移动形象锚点', () => {
  const below = floatingAssistantNotificationLayout(500, 400, 192, 208, 1024, 900, true)
  assert.equal(below.top, 218); assert.ok(Number(below.maxHeight) > 0)
  const beside = floatingAssistantNotificationLayout(600, 660, 192, 208, 1024, 900, true)
  assert.equal(beside.top, 0); assert.ok(Number(beside.left) < 0)
  assert.ok(Number(beside.maxHeight) <= 208)
  const narrow = floatingAssistantNotificationLayout(174, 450, 192, 208, 390, 844)
  assert.ok(Number(narrow.width) <= 320)
  assert.ok(174 + Number(narrow.left) >= 12)
  assert.ok(174 + Number(narrow.left) + Number(narrow.width) <= 378)
  const phone = floatingAssistantNotificationLayout(104, 536, 192, 208, 320, 768, true)
  assert.equal(phone.bottom, 408); assert.ok(Number(phone.maxHeight) >= 180)
})

test('抢占与翻页后，已显示通知的积压点击仍经 Host 校验导航，不依赖当前页', async (t) => {
  let clock = 1000
  const f = fixture(() => ++clock); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.turn('turn-completed', 'first'); f.store.configure(true, 'same'); await f.store.refresh()
  const shown = f.store.getSnapshot().frame!.primary!
  await f.store.acknowledge(shown.noticeId, f.host.generation, 'presented')
  for (let index = 0; index < 25; index++) f.emit('question', `queued:${index}`)
  await f.store.refresh()
  assert.ok(!f.store.getSnapshot().frame!.items.some((item) => item.noticeId === shown.noticeId))
  await f.store.open(shown.noticeId, f.host.generation)
  assert.deepEqual(f.navigated, [local])
  assert.equal(f.host.read().pendingCount, 25)
})

test('同轮完成升级错误重新首展，迟到的完成帧确认不能替新错误启动呈现', async (t) => {
  let clock = 1000
  const f = fixture(() => clock); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.turn('turn-completed', 'same-turn'); f.store.configure(true, 'same'); await f.store.refresh()
  const first = f.store.getSnapshot().frame!.primary!
  await f.store.acknowledge(first.noticeId, f.host.generation, 'presented', 'completed')
  clock += 100; f.turn('turn-failed', 'same-turn'); await f.store.refresh()
  assert.equal(f.store.getSnapshot().frame!.primary!.noticeId, first.noticeId)
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, undefined)
  await f.store.acknowledge(first.noticeId, f.host.generation, 'presented', 'completed')
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, undefined)
  assert.equal(f.store.getSnapshot().frame!.primary!.presentation, 'queued')
  // 错误的自动关闭跟随助理通知设置，确认后也不再有内置截止时间。
  await f.store.acknowledge(first.noticeId, f.host.generation, 'presented', 'error')
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, undefined)
  assert.equal(f.store.getSnapshot().frame!.primary!.presentation, 'shown')
})

test('Host 已升级而网页还未读取时，首展类型通过共享契约原子校验，不给新错误启动内置截止', async (t) => {
  let clock = 1000
  const f = fixture(() => clock); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.turn('turn-completed', 'same-turn'); f.store.configure(true, 'same'); await f.store.refresh()
  const first = f.store.getSnapshot().frame!.primary!
  clock += 100; f.turn('turn-failed', 'same-turn')
  await f.store.acknowledge(first.noticeId, f.host.generation, 'presented', 'completed')
  assert.equal(f.calls.find((call) => call.endpoint.endsWith('/ack'))!.payload.kind, 'completed')
  assert.equal(f.store.getSnapshot().frame!.primary!.kind, 'error')
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, undefined)
  await f.store.acknowledge(first.noticeId, f.host.generation, 'presented', 'error')
  assert.equal(f.store.getSnapshot().frame!.primary!.deadline, undefined)
  assert.equal(f.store.getSnapshot().frame!.primary!.presentation, 'shown')
})

test('旧气泡点击保留它自己的连接代次，网页已同步新连接也不能改写旧点击', async (t) => {
  const f = fixture(); t.after(() => { f.store.dispose(); f.host.dispose() })
  const remote = { hostId: 'peer', workspaceId: 'project', sessionId: 'same', connectionGeneration: 1 }
  f.emit('question', 'q', remote)
  f.store.configure(true, 'same'); await f.store.refresh()
  const shown = f.store.getSnapshot().frame!.primary!
  f.host.connection('peer', 2, true)
  await f.store.refresh()
  await assert.rejects(f.store.open(shown.noticeId, f.host.generation, 1), /连接/u)
  assert.equal(f.navigated.length, 0)
  assert.equal(f.calls.filter(call => call.endpoint.endsWith('/target')).at(-1)!.payload.connectionGeneration, 1)
  await assert.rejects(f.store.acknowledge(shown.noticeId, f.host.generation, 'dismiss', undefined, 1), /连接/u)
  assert.equal(f.host.read().primary!.presentation, 'queued', '旧连接的收起不能修改新连接的待办')
  await f.store.acknowledge(shown.noticeId, f.host.generation, 'dismiss', undefined, 2)
  assert.equal(f.host.read().primary, null)
  assert.equal(f.host.read().pendingCount, 1)
  await f.store.open(shown.noticeId, f.host.generation, 2)
  assert.equal(f.navigated[0]!.connectionGeneration, 2)
})

test('原生独立列表中尚未进入网页当前页的通知仍由认证target复核', async (t) => {
  const f = fixture(); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.store.configure(true, 'same'); await f.store.refresh()
  for (let index = 0; index < 55; index++) f.emit('question', `q:${index}`)
  const all = f.host.read({ limit: 50 })
  const page = f.host.read({ cursor: all.cursor!, limit: 50 })
  const hidden = page.items.at(-1)!
  assert.equal(f.store.getSnapshot().frame!.items.length, 0)
  await f.store.open(hidden.noticeId, f.host.generation)
  assert.equal(f.navigated.length, 1)
  assert.equal(f.host.read().pendingCount, 55)
  await assert.rejects(f.store.open('nonexistent-notice', f.host.generation), /失效/u)
})

test('页面可见时完成提示静默已读，非浏览器环境保持完成呈现', async (t) => {
  const scope = globalThis as { document?: unknown }
  const original = scope.document
  t.after(() => { if (original === undefined) delete scope.document; else scope.document = original })
  const f = fixture(); t.after(() => { f.store.dispose(); f.host.dispose() })
  f.turn('turn-completed')
  f.store.configure(true, 'hidden'); await f.store.refresh()
  assert.equal(f.store.getSnapshot().frame!.primary!.kind, 'completed')
  scope.document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const visible = new AssistantNotificationStore({ async call(_channel, endpoint, payload: any) {
    return { ok: true, value: endpoint.endsWith('/read') ? f.host.read(payload) : f.host.ack(payload) }
  } }, async () => {})
  t.after(() => visible.dispose())
  visible.configure(true, 'visible'); await visible.refresh()
  await setImmediate()
  assert.equal(visible.getSnapshot().frame!.primary, null)
  assert.equal(f.host.read().items.find((item) => item.kind === 'completed')!.read, true)
})

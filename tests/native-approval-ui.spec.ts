import assert from 'node:assert/strict'
import test from 'node:test'
import { registerCliConversationSlots } from '../src/client/cli-slots.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { createPresentationSlots } from './fixtures/presentation-slots.js'

let next = 0
const flush = () => new Promise(resolve => setImmediate(resolve))
const locale = { bind: () => resolveCodingNsTranslator(), getSnapshot: () => ({ revision: 0 }), subscribe: () => () => {}, register: () => () => {} } as never

for (const adapterId of ['codex', 'zcode']) {
  test(`${adapterId} 真实 Slot 保存审批模式，失败恢复，运行中可保存下一轮设置并清理注册`, async () => {
    const sessionId = `approval-ui-${next++}`
    let selection = { adapterId, modelId: 'existing-model', nativeApprovalMode: 'inherit' }
    let fail = false
    let running = false
    const calls: any[] = []
    const rpc = { async call(_channel: string, endpoint: string, payload: any) {
      if (endpoint === 'cli/session/set') {
        calls.push(payload)
        if (fail) return { ok: false, error: { code: 'SAVE_FAILED', message: 'fixture failure' } }
        selection = payload
      } else assert.equal(endpoint, 'cli/session/get')
      return { ok: true, value: selection }
    } }
    const slots = createPresentationSlots()
    const removeRoot = slots.register({ name: 'root', children: {
      'conversation.input.left': { kind: 'list', scope: 'session' },
      'conversation.input.right': { kind: 'list', scope: 'session' },
      'conversation.input.permission': { kind: 'single', scope: 'session' },
    } } as any, () => null)
    const NativePermission = () => null
    const removeNative = slots.register({ name: 'conversation.input.permission', locale: 'native-permission', inject: () => ({ nativeDependency: true }) } as any, NativePermission)
    const dispose = registerCliConversationSlots(slots as never, rpc as never, locale)
    const slot = slots.entries('conversation.input.permission').find(entry => entry.options.id === 'codingns4dsh-native-approval')! as any
    assert.equal(slot.locale, 'native-permission')
    const props = { ...slot.inject(sessionId), useProjection: () => ({ currentValue: 'read-only' }), t: (key: string) => key, useSession: (select: any) => select({ sessionId, blank: false, running, queue: [] }) }
    const mounted = slot.component(props)
    const renderer = createHookRenderer(mounted.type, mounted.props, { checkHookOrder: true })
    const control = () => {
      const tree = renderer.render() as any
      return tree.props.children[0] as any
    }
    try {
      renderer.render(); await flush()
      let selector = control()
      assert.equal(selector.type, NativePermission)
      assert.equal(selector.props.nativeDependency, true)
      assert.equal(selector.props.locked, false, '已有非空会话仍然能切换')
      assert.equal(selector.props.useProjection('permissions').currentValue, 'read-only', '旧只读权限保持显示，直到用户显式选择')
      assert.equal(selector.props.usePermissionCatalog((s: any) => s).value.options.some((option: any) => option.value === 'inherit'), false)
      void selector.props.select('auto')
      assert.equal(control().props.locked, true, '写入尚未完成时禁用')
      assert.equal((renderer.render() as any).props['data-codingns-approval-disabled'], 'saving')
      await flush()
      assert.equal(control().props.useProjection('permissions').currentValue, 'auto')
      assert.equal(calls.at(-1).nativeApprovalMode, 'auto-review')
      assert.equal(calls.at(-1).modelId, 'existing-model')
      assert.equal((renderer.render() as any).props['data-codingns-approval'], 'override')
      fail = true
      await control().props.select('danger-full-access'); await flush()
      assert.equal(control().props.useProjection('permissions').currentValue, 'auto', '失败不能留在宽松的乐观状态')
      assert.equal((renderer.render() as any).props.children[1].props.role, 'alert')
      running = true
      assert.equal(control().props.locked, false)
      assert.equal((renderer.render() as any).props['data-codingns-approval-applies'], 'next-turn')
      assert.equal((renderer.render() as any).props.title, undefined)
      assert.ok(!(renderer.render() as any).props.children.some((child: any) => child?.props?.['data-codingns-approval-next-turn']))
      const before = calls.length
      fail = false
      await control().props.select('manual'); await flush()
      assert.equal(calls.length, before + 1)
      assert.equal(control().props.useProjection('permissions').currentValue, 'manual')
      running = false; fail = false
      const savedCount = calls.length
      assert.equal(await control().props.select('inherit'), false)
      await flush()
      assert.equal(calls.length, savedCount, '已删除的选项不得通过 UI 写回')
      assert.equal(control().props.useProjection('permissions').currentValue, 'manual')
      assert.equal((renderer.render() as any).props['data-codingns-approval'], 'override')
      if (adapterId === 'codex') {
        const confirmation = () => (renderer.render() as any).props.children[2] as any
        const startConfirmation = () => control().props.select('full-access-confirm') as Promise<boolean>
        const initialCalls = calls.length
        let choice = startConfirmation()
        assert.equal(control().props.locked, true)
        assert.equal(confirmation().props.acknowledged, false)
        assert.match(confirmation().props.description, /不受文件沙箱限制/u)
        confirmation().props.onConfirm()
        await flush()
        assert.equal(calls.length, initialCalls, 'confirmation requires the checkbox')
        confirmation().props.onCancel()
        assert.equal(await choice, false)
        assert.equal(control().props.useProjection('permissions').currentValue, 'manual')

        choice = startConfirmation()
        confirmation().props.onAcknowledgedChange(true)
        fail = true
        confirmation().props.onConfirm()
        assert.equal(await choice, false)
        await flush()
        assert.equal(control().props.useProjection('permissions').currentValue, 'manual', 'save failure retains the old mode')

        running = true; fail = false
        choice = startConfirmation()
        assert.equal(confirmation().props.acknowledged, false, 'each attempt requires a fresh acknowledgement')
        confirmation().props.onAcknowledgedChange(true)
        confirmation().props.onConfirm()
        assert.equal(await choice, true)
        await flush()
        assert.equal(calls.at(-1).nativeApprovalMode, 'full-access-confirm')
        assert.equal(control().props.useProjection('permissions').currentValue, 'full-access-confirm')
        assert.equal((renderer.render() as any).props['data-codingns-approval-applies'], 'next-turn')

        choice = startConfirmation()
        const beforeUnmount = calls.length
        renderer.dispose()
        assert.equal(await choice, false, 'unmount cancels the pending confirmation')
        assert.equal(calls.length, beforeUnmount)
      } else {
        assert.equal(await control().props.select('full-access-confirm'), false)
      }
    } finally { renderer.dispose(); dispose() }
    assert.equal(slots.entries('conversation.input.permission').length, 1, '卸载后恢复唯一原生入口')
    removeNative(); removeRoot()
  })
}

test('permission presentation follows late native registration, replacement and unload', async () => {
  const slots = createPresentationSlots()
  const root = slots.register({ name: 'root', children: { 'conversation.input.permission': { kind: 'single', scope: 'session' } } } as any, () => null)
  const dispose = registerCliConversationSlots(slots as never, {} as never, locale)
  const wrappers = () => slots.entries('conversation.input.permission').filter(entry => entry.options.id === 'codingns4dsh-native-approval')
  assert.equal(wrappers().length, 0)
  const first = slots.register({ name: 'conversation.input.permission', locale: 'first' } as any, () => null)
  await flush()
  assert.equal(wrappers().length, 1)
  first()
  await flush()
  assert.equal(wrappers().length, 0)
  const second = slots.register({ name: 'conversation.input.permission', locale: 'second' } as any, () => null)
  await flush()
  assert.equal(wrappers()[0]?.locale, 'second')
  dispose()
  assert.equal(slots.entries('conversation.input.permission').length, 1)
  second(); root()
})

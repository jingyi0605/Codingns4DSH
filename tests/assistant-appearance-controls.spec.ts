import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantFloatingSizeControl } from '../src/client/avatar/settings-panel.js'
import { AssistantAvatarConsentPrompt, AssistantAvatarThirdPartyToggle } from '../src/client/avatar/catalog-panel.js'
import { AssistantAvatarPickerView, type AssistantAvatarChoice } from '../src/client/avatar/catalog-picker.js'
import { DshMenu } from '../src/dsh-capabilities/client/primitives-adapter.js'
import { AssistantAvatarManager } from '../src/client/avatar/manager.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import { CodingNsSettingsSchema } from '../src/host/settings.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { normalizeAssistantAppearance } from '../src/shared/assistant-avatar.js'
import { hasAssistantAvatarConsent } from '../src/shared/assistant-avatar-catalog.js'
import type { CodingNsSettingsStore } from '../src/dsh-capabilities/settings-store.js'
import type { CodingNsSettings } from '../src/shared/contracts/config.js'

const t = resolveCodingNsTranslator()
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

test('彩色形象菜单与当前项共享标签，关闭、键盘打开、选择和禁用保持一致', () => {
  const choices: readonly AssistantAvatarChoice[] = [
    { id: 'builtin', label: '内置形象', thirdParty: false },
    { id: 'third-party', label: '用户命名 · 第三方', thirdParty: true },
    { id: 'unavailable', label: '不可用形象', thirdParty: false, disabled: true },
  ]
  let expanded = false; let prevented = 0
  const selected: string[] = []
  const view = (open = false, disabled = false) => AssistantAvatarPickerView({ choices, value: 'third-party', disabled, open, id: 'avatars', t,
    onOpenChange: (next) => { expanded = next }, onChoose: (choice) => { selected.push(choice.id) } })
  const menu = (open = false, disabled = false) => elements(view(open, disabled)).find((node) => node.type === DshMenu)!
  const closed = menu()
  const trigger = closed.props.anchor
  const html = renderToStaticMarkup(view())
  assert.equal((html.match(/data-codingns-avatar-third-party-badge="true"/gu) ?? []).length, 1)
  assert.ok(html.includes('用户命名 · 第三方</span>'), '用户名称保留原样，不靠截取后缀识别来源')
  assert.ok(html.includes('background:#2563eb;color:#fff'))
  assert.equal(closed.props.portal, true)
  assert.equal(closed.props.autoFocus, true)
  assert.equal(closed.props.selectedId, 'third-party')
  assert.equal(trigger.props['aria-haspopup'], 'menu')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.ok(trigger.props['aria-label'].includes('当前形象'))
  for (const key of ['ArrowDown', 'ArrowUp']) {
    expanded = false
    trigger.props.onKeyDown({ key, preventDefault: () => { prevented++ } })
    assert.equal(expanded, true)
  }
  assert.equal(prevented, 2)
  menu(true).props.anchor.props.onKeyDown({ key: 'ArrowDown', preventDefault: () => { prevented++ } })
  assert.equal(prevented, 2, '展开后方向键交给宿主菜单，不重复处理')
  closed.props.onSelect('missing'); closed.props.onSelect('unavailable')
  assert.deepEqual(selected, [])
  closed.props.onSelect('third-party')
  assert.deepEqual(selected, ['third-party']); assert.equal(expanded, false)
  menu(true).props.onClose(); assert.equal(expanded, false)
  const disabled = menu(true, true)
  assert.equal(disabled.props.open, false)
  assert.equal(disabled.props.anchor.props.disabled, true)
  assert.ok(disabled.props.items.every((item: { disabled: boolean }) => item.disabled))
  disabled.props.anchor.props.onClick(); disabled.props.onSelect('builtin')
  assert.deepEqual(selected, ['third-party']); assert.equal(expanded, false)
})

test('迷你尺寸 72 通过 Host 写入与回读，标准 144 和旧自定义尺寸保持兼容', async () => {
  let value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  let writes = 0
  value.assistant.appearance = normalizeAssistantAppearance(value.assistant.appearance)
  value.assistant.managedWorkspaceIds = ['existing-project']
  const originalVoice = structuredClone(value.assistant.voice)
  const rpc = createCodingNsSettingsRpcHandler({ writable: true, get: () => value,
    describe: () => [{ ns: 'codingns', revision: 1, value }], mutate: async (_ns, operations) => {
      writes++; value = CodingNsSettingsSchema({ ...value, assistant: { ...value.assistant, appearance: operations[0]!.value } })
    } })
  for (const size of [72, 144, 80, 213, 320]) {
    await rpc('set', { expectedRevision: 1, ops: [{ op: 'set', path: ['assistant', 'appearance'], value: { ...value.assistant.appearance, floatingSize: size } }] })
    assert.equal(value.assistant.appearance!.floatingSize, size)
    assert.equal(normalizeAssistantAppearance(value.assistant.appearance).floatingSize, size)
    assert.deepEqual(value.assistant.voice, originalVoice)
    assert.deepEqual(value.assistant.managedWorkspaceIds, ['existing-project'])
  }
  for (const size of [71, 321]) await assert.rejects(rpc('set', { expectedRevision: 1, ops: [{ op: 'set', path: ['assistant', 'appearance'], value: { ...value.assistant.appearance, floatingSize: size } }] }), /尺寸/u)
  assert.equal(writes, 5)
})

test('尺寸控件按旧值选择档位，仅自定义显示输入，拒绝空值、越界和小数', () => {
  let changed = 0
  let preset = ''
  const control = (size: number, custom = false, disabled = false) => AssistantFloatingSizeControl({ size, custom, disabled, t,
    onPreset: (next) => { preset = next }, onSize: (next) => { changed = next } })
  for (const [size, expected] of [[72, 'mini'], [144, 'standard'], [213, 'custom']] as const) {
    const nodes = elements(control(size))
    assert.equal(nodes.find((element) => element.type === 'select')!.props.value, expected)
    assert.equal(nodes.some((element) => element.type === 'input'), expected === 'custom')
  }
  const custom = elements(control(144, true))
  custom.find((element) => element.type === 'select')!.props.onChange({ currentTarget: { value: 'mini' } })
  assert.equal(preset, 'mini')
  const input = custom.find((element) => element.type === 'input')!
  for (const invalid of ['', '71', '321', '100.5', 'invalid']) {
    const event = { currentTarget: { value: invalid } }; input.props.onBlur(event)
    assert.equal(changed, 0); assert.equal(event.currentTarget.value, '144')
  }
  input.props.onBlur({ currentTarget: { value: '200' } }); assert.equal(changed, 200)
  elements(control(144, true, true)).find((element) => element.type === 'input')!.props.onBlur({ currentTarget: { value: '150' } })
  assert.equal(changed, 200)
})

test('勾选第三方只打开协议，取消及未同意不写设置，确认后才启用且可撤销', async () => {
  let value = structuredClone(DEFAULT_CODINGNS_SETTINGS)
  let writes = 0; let opened = false; let agreed = false
  let operation: Promise<void> = Promise.resolve()
  const store = { getSnapshot: () => ({ value, status: 'ready', writable: true, revision: 1 }), subscribe: () => () => {},
    mutate: async (operations) => { writes++; value = CodingNsSettingsSchema({ ...value, assistant: { ...value.assistant, appearance: operations[0]!.value } }); return true },
  } as CodingNsSettingsStore<CodingNsSettings>
  const manager = new AssistantAvatarManager(store)
  const toggle = () => AssistantAvatarThirdPartyToggle({ accepted: hasAssistantAvatarConsent(manager.getAppearance().thirdPartyConsent), disabled: false, t,
    onRequest: () => { opened = true; agreed = false }, onDisable: () => { operation = manager.setThirdPartyEnabled(false) } })
  const prompt = () => AssistantAvatarConsentPrompt({ agreed, disabled: false, t, onChange: (next) => { agreed = next },
    onAccept: () => { operation = manager.setThirdPartyEnabled(true); opened = false }, onCancel: () => { opened = false; agreed = false } })
  const request = () => elements(toggle()).find((element) => element.type === 'input')!.props.onChange({ currentTarget: { checked: true } })
  request(); assert.equal(opened, true); assert.equal(writes, 0)
  await assert.rejects(manager.getCatalog(), /同意/u)
  const first = prompt()
  assert.ok(!renderToStaticMarkup(first).includes('checked=""'))
  const buttons = elements(first).filter((element) => element.type === 'button')
  buttons[1]!.props.onClick(); assert.equal(writes, 0); assert.equal(buttons[1]!.props.disabled, true)
  buttons[0]!.props.onClick(); assert.equal(opened, false); assert.equal(writes, 0)
  request()
  elements(prompt()).find((element) => element.type === 'input')!.props.onChange({ currentTarget: { checked: true } })
  assert.equal(writes, 0)
  elements(prompt()).filter((element) => element.type === 'button')[1]!.props.onClick(); await operation
  assert.equal(writes, 1); assert.equal(hasAssistantAvatarConsent(manager.getAppearance().thirdPartyConsent), true)
  elements(toggle()).find((element) => element.type === 'input')!.props.onChange({ currentTarget: { checked: false } }); await operation
  assert.equal(writes, 2); assert.equal(manager.getAppearance().thirdPartyConsent, undefined)
  assert.deepEqual(manager.list().map((model) => model.name), ['鱼妞', '鱼仔'])
})

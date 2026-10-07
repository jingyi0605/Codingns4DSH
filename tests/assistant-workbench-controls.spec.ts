import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantComposer, AssistantComposerView, AssistantIconButton, AssistantMaintenanceConfirmationView, AssistantMaintenanceDialog, AssistantStatusBadge,
  confirmAssistantMaintenance, resolveAssistantWorkbenchStatus, type AssistantMaintenanceConfirmation } from '../src/client/features/assistant-workbench-controls.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { readAssistantComposerCommand, isAssistantClearCommandSuggestion, resizeAssistantComposerTextarea, encodeAssistantFiles, validateAssistantFiles } from '../src/client/features/assistant-composer-input.js'
const t = resolveCodingNsTranslator()
function elements(node: unknown): ReactElement<any>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as any).children)]
}

test('状态优先反映文字和语音思考，再显示工作、关联项目认知更新或空闲', () => {
  const idle = { running: false, working: false, voiceActive: false, hasProjects: false, indexState: 'not-built' as const }
  assert.equal(resolveAssistantWorkbenchStatus(idle), 'idle')
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, hasProjects: true }), 'updating')
  for (const indexState of ['not-built', 'stale', 'building', 'incomplete'] as const) {
    assert.equal(resolveAssistantWorkbenchStatus({ ...idle, hasProjects: true, indexState }), 'updating')
  }
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, hasProjects: true, indexState: 'ready' }), 'idle')
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, running: true, working: true, hasProjects: true }), 'thinking')
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, voiceActive: true, voiceState: 'thinking', hasProjects: true }), 'thinking')
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, working: true, hasProjects: true }), 'working')
  for (const voiceState of ['listening', 'speaking', 'interrupted']) {
    assert.equal(resolveAssistantWorkbenchStatus({ ...idle, voiceActive: true, voiceState }), 'working')
  }
  assert.equal(resolveAssistantWorkbenchStatus({ ...idle, voiceState: 'thinking' }), 'idle', '已停用的语音不能保持思考状态')
  for (const [status, text] of [['thinking', '思考中'], ['updating', '认知更新'], ['working', '工作中'], ['idle', '空闲']] as const) {
    const badge = renderToStaticMarkup(createElement(AssistantStatusBadge, { status, t }))
    assert.ok(badge.includes(text)); assert.ok(badge.includes('role="status"'))
  }
})

test('生成中输入栏切换为停止按钮，停止不会提交草稿，处理中不能重复停止', () => {
  let sent = 0; let stopped = 0
  const make = (stopping = false) => AssistantComposerView({ t, value: '下一条消息', disabled: true, running: true, stopping,
    onChange() {}, onSend: () => { sent++ }, onStop: () => { stopped++ } })
  const composer = make()
  composer.props.onSubmit({ preventDefault() {} }); assert.equal(sent, 0)
  const stop = elements(composer).find((element) => element.type === 'button')!
  assert.equal(stop.props.type, 'button'); assert.equal(stop.props.disabled, false); assert.equal(stop.props['aria-label'], '停止回复')
  stop.props.onClick(); assert.equal(stopped, 1); assert.equal(sent, 0)
  const stopping = elements(make(true)).find((element) => element.type === 'button')!
  assert.equal(stopping.props.disabled, true); stopping.props.onClick(); assert.equal(stopped, 1)
})

test('电话图标使用同一实时语音启停入口，不可用时禁止启动，不输出独立按钮行或运行时错误', () => {
  let toggles = 0
  const make = (voiceActive: boolean, voiceDisabled: boolean) => AssistantComposerView({ t, value: '', disabled: false, voiceActive, voiceDisabled,
    onChange() {}, onSend() {}, onVoice: () => { toggles++ } })
  const microphone = (active: boolean, disabled: boolean) => elements(make(active, disabled)).find((element) => element.type === 'button')!
  const unavailable = microphone(false, true)
  assert.equal(unavailable.props.disabled, true); unavailable.props.onClick(); assert.equal(toggles, 0)
  assert.equal(unavailable.props.title, t('awb.voiceUnavailable'))
  const start = microphone(false, false)
  assert.equal(start.props['aria-label'], t('voice.dialog.start')); start.props.onClick(); assert.equal(toggles, 1)
  const stop = microphone(true, false)
  assert.equal(stop.props['aria-label'], t('voice.dialog.stop')); assert.equal(stop.props['aria-pressed'], true)
  stop.props.onClick(); assert.equal(toggles, 2)
  const markup = renderToStaticMarkup(make(false, true))
  assert.equal((markup.match(/<svg\b/gu) ?? []).length, 2)
  assert.ok(!markup.includes('Sherpa-ONNX')); assert.ok(!markup.includes('>开始实时对话</button>'))
})

test('设置、关闭、清理和附件按钮沿用原生字形及可访问名称，禁用时不执行', () => {
  let calls = 0
  for (const icon of ['settings', 'close', 'clear', 'add'] as const) {
    const button = AssistantIconButton({ icon, label: icon, onClick: () => calls++ })
    const markup = renderToStaticMarkup(button)
    assert.ok(markup.includes('viewBox="0 0 16 16"')); assert.ok(markup.includes(`aria-label="${icon}"`))
    button.props.onClick()
    AssistantIconButton({ icon, label: icon, disabled: true, onClick: () => calls++ }).props.onClick()
  }
  assert.equal(calls, 4)
})

test('自动高度随内容增减，达到上限才内部滚动，输入区域没有拖拽或焦点描边', () => {
  let contentHeight = 38
  const input = { style: { height: '', overflowY: '' }, get scrollHeight() { assert.equal(input.style.height, '0px'); return contentHeight },
    ownerDocument: { defaultView: { getComputedStyle: () => ({ minHeight: '38px', maxHeight: '120px' }) } } } as unknown as HTMLTextAreaElement
  resizeAssistantComposerTextarea(input); assert.equal(input.style.height, '38px'); assert.equal(input.style.overflowY, 'hidden')
  contentHeight = 78; resizeAssistantComposerTextarea(input); assert.equal(input.style.height, '78px')
  contentHeight = 260; resizeAssistantComposerTextarea(input); assert.equal(input.style.height, '120px'); assert.equal(input.style.overflowY, 'auto')
  contentHeight = 20; resizeAssistantComposerTextarea(input); assert.equal(input.style.height, '38px'); assert.equal(input.style.overflowY, 'hidden')
  const markup = renderToStaticMarkup(createElement(AssistantComposer, { t, value: '', disabled: false, onChange() {}, onSend() {} }))
  assert.ok(markup.includes('resize:none')); assert.ok(markup.includes('textarea:focus-visible{outline:none!important;box-shadow:none!important'))
  assert.ok(!markup.includes('resize:vertical'))
})

test('仅附件也可以发送，选择、移除、粘贴和编码传递真实文件字节', async () => {
  const file = new File(['测试内容'], '说明.txt', { type: 'text/plain' })
  let sent = 0; let selected = 0; let removed = -1; let pasted: readonly File[] = []
  const composer = AssistantComposerView({ t, value: '', disabled: false, files: [file], onChange() {}, onSend: () => sent++,
    onAttach: () => selected++, onRemoveFile: (index) => { removed = index }, onFiles: (files) => { pasted = files } })
  composer.props.onSubmit({ preventDefault() {} }); assert.equal(sent, 1)
  const icons = elements(composer).filter((element) => element.type === AssistantIconButton)
  icons.find((element) => element.props.icon === 'add')!.props.onClick(); assert.equal(selected, 1)
  icons.find((element) => element.props.icon === 'close')!.props.onClick(); assert.equal(removed, 0)
  let prevented = false
  elements(composer).find((element) => element.type === 'textarea')!.props.onPaste({ clipboardData: { files: [file] }, preventDefault() { prevented = true } })
  assert.equal(prevented, true); assert.equal(pasted[0], file)
  const encoded = await encodeAssistantFiles([file])
  assert.equal(encoded[0]!.name, '说明.txt'); assert.equal(Buffer.from(encoded[0]!.data, 'base64').toString(), '测试内容')
  assert.throws(() => validateAssistantFiles(Array.from({ length: 7 }, () => file)), /countError/)
  assert.throws(() => validateAssistantFiles([{ size: 11 * 1024 * 1024, type: 'text/plain' } as File]), /sizeError/)
  assert.throws(() => validateAssistantFiles([new File(['x'], 'bad.svg', { type: 'image/svg+xml' })]), /typeError/)
})

test('清理只匹配完整斜杠指令，路径和带参数消息不触发，候选选择仅填入指令', () => {
  for (const command of ['/clear', '/清理', '/reset', '/重置', ' /CLEAR ']) assert.equal(readAssistantComposerCommand(command), 'clear')
  for (const message of ['请 /clear 一下', '/clear/file', '/reset 设置', '/cle', '']) assert.equal(readAssistantComposerCommand(message), undefined)
  assert.equal(isAssistantClearCommandSuggestion('/'), true); assert.equal(isAssistantClearCommandSuggestion('/res'), true)
  assert.equal(isAssistantClearCommandSuggestion('/invalid'), false)
  let draft = ''; let sent = 0
  const view = AssistantComposerView({ t, value: '/', disabled: false, onChange: (value) => { draft = value }, onSend: () => sent++ })
  elements(view).find((element) => element.props['data-codingns-assistant-command'])!.props.onClick()
  assert.equal(draft, '/clear'); assert.equal(sent, 0, '选择候选不隐式清理或发送')
})

test('重置经过两个确认阶段，任一阶段取消均不执行，最终确认仅调用一次重置', () => {
  let stage: AssistantMaintenanceConfirmation | undefined = 'reset-first'
  const actions: string[] = []
  const view = () => AssistantMaintenanceConfirmationView({ stage: stage!, t, disabled: false,
    onCancel: () => { stage = undefined },
    onConfirm: () => confirmAssistantMaintenance(stage!, (next) => { stage = next }, (action) => { actions.push(action); stage = undefined }) })
  const buttons = () => elements(view()).filter((element) => element.type === 'button')
  buttons()[0]!.props.onClick(); assert.equal(stage, undefined); assert.deepEqual(actions, [])
  stage = 'reset-first'
  const first = buttons()
  assert.equal(first[0]!.props.autoFocus, true); assert.equal(first[1]!.props.children, '继续重置')
  first[1]!.props.onClick(); assert.equal(stage, 'reset-final'); assert.deepEqual(actions, [])
  buttons()[0]!.props.onClick(); assert.equal(stage, undefined); assert.deepEqual(actions, [])
  stage = 'reset-first'
  buttons()[1]!.props.onClick(); assert.equal(stage, 'reset-final'); assert.deepEqual(actions, [])
  const final = buttons()
  assert.equal(final[0]!.props.autoFocus, true); assert.equal(final[1]!.props.children, '确认重置')
  final[1]!.props.onClick(); assert.equal(stage, undefined); assert.deepEqual(actions, ['reset'])
})

test('清理仅需一次确认，取消不执行，执行期间按钮禁用，失败信息保留在模态框内', () => {
  const actions: string[] = []
  const view = (disabled: boolean) => AssistantMaintenanceConfirmationView({ stage: 'clear', t, disabled, error: '存储失败',
    onCancel: () => actions.push('cancel'), onConfirm: () => confirmAssistantMaintenance('clear', () => assert.fail('清理不能进入重置阶段'), (action) => actions.push(action)) })
  const disabled = elements(view(true)).filter((element) => element.type === 'button')
  disabled.forEach((button) => { assert.equal(button.props.disabled, true); button.props.onClick() })
  assert.deepEqual(actions, [])
  const enabled = elements(view(false)).filter((element) => element.type === 'button')
  enabled[0]!.props.onClick(); assert.deepEqual(actions, ['cancel'])
  actions.length = 0
  enabled[1]!.props.onClick(); assert.deepEqual(actions, ['clear'])
  for (const stage of ['clear', 'reset-first', 'reset-final'] as const) {
    const markup = renderToStaticMarkup(createElement(AssistantMaintenanceDialog, { stage, t, disabled: false, error: '存储失败', onCancel() {}, onConfirm() {} }))
    assert.ok(markup.includes(`<dialog aria-labelledby=`)); assert.ok(markup.includes(`data-codingns-assistant-confirmation="${stage}"`))
    assert.ok(markup.includes('role="alert"')); assert.ok(markup.includes('存储失败'))
  }
})

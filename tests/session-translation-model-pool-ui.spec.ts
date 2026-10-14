import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react'
import { sessionTranslationFeature } from '../src/client/features/session-translation.js'
import { SessionTranslationModelPool } from '../src/client/session-translation-model-pool.js'
import { DshButton, DshCheckbox, DshInput, DshModal } from '../src/dsh-capabilities/client/primitives-adapter.js'
import type { CodingNsClientServices, FeaturePanelProps } from '../src/client/features/types.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import { DEFAULT_SESSION_TRANSLATION_SETTINGS, type SessionTranslationSettings } from '../src/shared/contracts/session-translation.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const first = { provider: 'deepseek', model: 'first' }
const second = { provider: 'backup', model: 'second' }
const third = { provider: 'backup', model: 'third' }
const catalog = {
  models: [
    { ...first, label: 'DeepSeek / First' },
    { ...second, label: 'Backup / Second' },
    { ...third, label: 'Backup / Third' },
    { provider: 'codex', model: 'external', label: 'External Agent' },
  ],
  default: null, errors: [],
}

function elements(node: ReactNode): ReactElement<any>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return []
  if (node.type === DshModal && !(node.props as any).open) return [node]
  return [node, ...Children.toArray(node.props.children).flatMap(elements), ...elements((node.props as any).footer)]
}

// Execute the panel's hooks and render only the model controls under test.
function renderPool(props: FeaturePanelProps): ReactElement {
  const panel = sessionTranslationFeature.settingsPanel!(props)
  const field = elements(panel).find((element) => element.type === SessionTranslationModelPool)!
  assert.ok(field)
  return (field.type as (props: any) => ReactElement)(field.props)
}

function fixture(settings: SessionTranslationSettings = { ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModel: first, nativeEnabled: true }) {
  const writes: { field: string; value: SessionTranslationSettings }[] = []
  const snapshot = {
    value: { ...DEFAULT_CODINGNS_SETTINGS, sessionTranslation: settings },
    status: 'ready' as const, writable: true, revision: 1,
  }
  const services = {
    settings: {
      async set(field: string, value: SessionTranslationSettings) {
        writes.push({ field, value })
        snapshot.value = { ...snapshot.value, sessionTranslation: value }
        return true
      },
    },
    rpc: { async call() { return { ok: true, value: catalog } } },
    locale: {
      bind: () => resolveCodingNsTranslator(), subscribe: () => () => undefined,
      getSnapshot: () => ({ revision: 1 }),
    },
  } as unknown as CodingNsClientServices
  const props: FeaturePanelProps = { services, snapshot, enabled: true, notify: () => undefined }
  const renderer = createHookRenderer(renderPool, props)
  return { writes, snapshot, props, renderer }
}

function checkbox(tree: ReactElement, label: string): ReactElement<any> {
  const field = elements(tree).find((element) => element.type === DshCheckbox && element.props.label === label)
  assert.ok(field, `Missing checkbox: ${label}`)
  return field
}

function button(tree: ReactElement, label: string): ReactElement<any> {
  const field = elements(tree).find((element) => element.type === DshButton && (element.props['aria-label'] === label || element.props.children === label))
  assert.ok(field, `Missing button: ${label}`)
  return field
}

function rows(tree: ReactElement): ReactElement<any>[] {
  return elements(tree).filter((element) => element.type === 'li' && element.props['data-codingns-translation-model-key'])
}

function list(tree: ReactElement): ReactElement<any> {
  return elements(tree).find((element) => element.type === 'ol')!
}

function order(tree: ReactElement): unknown[] {
  return rows(tree).map((element) => JSON.parse(element.props['data-codingns-translation-model-key']))
}

function modal(tree: ReactElement): ReactElement<any> {
  return elements(tree).find((element) => element.type === DshModal)!
}

function resetModal(tree: ReactElement): ReactElement<any> {
  return elements(tree).find((element) => element.type === DshModal && element.props.title === resolveCodingNsTranslator()('translation.modelResetTitle'))!
}

async function loaded(f: ReturnType<typeof fixture>): Promise<ReactElement> {
  f.renderer.render()
  await setImmediate()
  return f.renderer.render()
}

function openPicker(f: ReturnType<typeof fixture>, tree: ReactElement): ReactElement {
  button(tree, resolveCodingNsTranslator()('translation.modelAdd')).props.onClick()
  const next = f.renderer.render()
  assert.equal(modal(next).props.open, true)
  return next
}

test('only pooled models appear in settings; additions are confirmed in a separate native modal', async (t) => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  const tr = resolveCodingNsTranslator()
  let tree = await loaded(f)
  assert.deepEqual(order(tree), [['deepseek', 'first']])
  assert.equal(elements(tree).some((element) => element.type === DshCheckbox), false)
  tree = openPicker(f, tree)
  assert.equal(elements(tree).some((element) => element.type === DshCheckbox && ['DeepSeek / First', 'External Agent'].includes(element.props.label)), false)
  assert.equal(button(tree, tr('translation.modelAddSelected', { count: 0 })).props.disabled, true)

  checkbox(tree, 'Backup / Third').props.onChange(true)
  tree = f.renderer.render()
  checkbox(tree, 'Backup / Second').props.onChange(true)
  tree = f.renderer.render()
  assert.equal(f.writes.length, 0)
  assert.equal(checkbox(tree, 'Backup / Second').props.checked, true)
  assert.equal(checkbox(tree, 'Backup / Third').props.checked, true)
  button(tree, tr('translation.modelAddSelected', { count: 2 })).props.onClick()
  await setImmediate()
  tree = f.renderer.render()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [first, third, second])
  assert.equal(Object.hasOwn(f.writes.at(-1)!.value, 'translationModel'), false)
  assert.equal(f.writes.at(-1)?.value.nativeEnabled, true)
  assert.equal(f.writes.at(-1)?.field, 'sessionTranslation')
  assert.equal(modal(tree).props.open, false)
  assert.deepEqual(order(tree), [['deepseek', 'first'], ['backup', 'third'], ['backup', 'second']])

  button(tree, tr('translation.modelRemove', { model: 'DeepSeek / First' })).props.onClick()
  await setImmediate()
  tree = f.renderer.render()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [third, second])

  button(tree, tr('translation.modelFollowDefault')).props.onClick()
  tree = f.renderer.render()
  assert.equal(resetModal(tree).props.open, true)
  button(tree, tr('translation.modelResetConfirm')).props.onClick()
  await setImmediate()
  tree = f.renderer.render()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [])
  assert.equal(rows(tree).length, 0)
  assert.equal(button(tree, tr('translation.modelAdd')).props.disabled, false)
})

test('following the default model requires confirmation; cancellation and dismissal preserve the pool', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [second, first] })
  t.after(() => f.renderer.dispose())
  const tr = resolveCodingNsTranslator()
  let tree = await loaded(f)
  for (const close of ['cancel', 'dismiss']) {
    button(tree, tr('translation.modelFollowDefault')).props.onClick()
    tree = f.renderer.render()
    assert.equal(resetModal(tree).props.open, true)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(order(tree), [['backup', 'second'], ['deepseek', 'first']])
    if (close === 'cancel') button(tree, tr('translation.modelCancel')).props.onClick()
    else resetModal(tree).props.onClose()
    tree = f.renderer.render()
    assert.equal(resetModal(tree).props.open, false)
    assert.equal(f.writes.length, 0)
    assert.deepEqual(f.snapshot.value.sessionTranslation.translationModels, [second, first])
  }
  button(tree, tr('translation.modelFollowDefault')).props.onClick()
  tree = f.renderer.render()
  button(tree, tr('translation.modelResetConfirm')).props.onClick()
  await setImmediate()
  tree = f.renderer.render()
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.writes[0].value.translationModels, [])
  assert.equal(resetModal(tree).props.open, false)
})

test('a rejected reset preserves models and lets the user retry in the confirmation dialog', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [second, first] })
  t.after(() => f.renderer.dispose())
  const write = f.props.services.settings.set
  let rejectWrite: (error: Error) => void = () => undefined
  f.props.services.settings.set = () => new Promise((_resolve, reject) => { rejectWrite = reject })
  const tr = resolveCodingNsTranslator()
  let tree = await loaded(f)
  button(tree, tr('translation.modelFollowDefault')).props.onClick()
  tree = f.renderer.render()
  button(tree, tr('translation.modelResetConfirm')).props.onClick()
  tree = f.renderer.render()
  assert.equal(button(tree, tr('translation.modelResetConfirm')).props.disabled, true)
  assert.equal(button(tree, tr('translation.modelCancel')).props.disabled, true)
  resetModal(tree).props.onClose()
  assert.equal(resetModal(f.renderer.render()).props.open, true)
  rejectWrite(new Error('settings write rejected'))
  await setImmediate()
  tree = f.renderer.render()
  assert.equal(resetModal(tree).props.open, true)
  assert.deepEqual(order(tree), [['backup', 'second'], ['deepseek', 'first']])
  assert.equal(elements(tree).some((element) => element.props.role === 'alert' && element.props.children === tr('translation.saveRejected')), true)
  assert.equal(f.writes.length, 0)
  f.props.services.settings.set = write
  button(tree, tr('translation.modelResetConfirm')).props.onClick()
  await setImmediate()
  tree = f.renderer.render()
  assert.equal(resetModal(tree).props.open, false)
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [])
})

test('search keeps selected models across filters and cancelling discards the selection', async (t) => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  let tree = openPicker(f, await loaded(f))
  checkbox(tree, 'Backup / Second').props.onChange(true)
  tree = f.renderer.render()
  const search = () => elements(tree).find((element) => element.type === DshInput)!
  search().props.onChange({ currentTarget: { value: 'third' } })
  tree = f.renderer.render()
  assert.equal(elements(tree).filter((element) => element.type === DshCheckbox).length, 1)
  checkbox(tree, 'Backup / Third').props.onChange(true)
  tree = f.renderer.render()
  search().props.onChange({ currentTarget: { value: 'no-such-model' } })
  tree = f.renderer.render()
  assert.equal(elements(tree).filter((element) => element.type === DshCheckbox).length, 0)
  assert.equal(button(tree, resolveCodingNsTranslator()('translation.modelAddSelected', { count: 2 })).props.disabled, false)
  modal(tree).props.onClose()
  tree = f.renderer.render()
  assert.equal(modal(tree).props.open, false)
  assert.equal(f.writes.length, 0)
  tree = openPicker(f, tree)
  assert.equal(checkbox(tree, 'Backup / Second').props.checked, false)
  assert.equal(checkbox(tree, 'Backup / Third').props.checked, false)
  assert.equal(elements(tree).find((element) => element.type === DshInput)?.props.value, '')
})

function pointerHarness(tree: ReactElement) {
  let target: any
  const targets = rows(tree).map((element) => ({
    dataset: { codingnsTranslationModelKey: element.props['data-codingns-translation-model-key'] },
    closest() { return this },
  }))
  const root = list(tree)
  const handle = { focus() {}, ownerDocument: { elementFromPoint: () => target } }
  root.ref.current = { contains: (element) => targets.includes(element), scrollTop: 0, setPointerCapture() {},
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }) }
  const event = (y = 50, type = 'mouse') => ({
    pointerId: 1, button: 0, clientX: 100, clientY: y, pointerType: type,
    currentTarget: handle, preventDefault() {},
  })
  return { event, target: (index: number) => { target = targets[index] } }
}

for (const pointerType of ['mouse', 'touch']) {
  test(`${pointerType} dragging previews priority and saves only on release`, async (t) => {
    const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [first, second, third] })
    t.after(() => f.renderer.dispose())
    let tree = await loaded(f)
    const pointer = pointerHarness(tree)
    const tr = resolveCodingNsTranslator()
    const grip = button(tree, tr('translation.modelDrag', { model: 'DeepSeek / First' }))
    grip.props.onPointerDown(pointer.event(50, pointerType))
    pointer.target(2)
    list(tree).props.onPointerMove(pointer.event(180, pointerType))
    tree = f.renderer.render()
    assert.deepEqual(order(tree), [['backup', 'second'], ['backup', 'third'], ['deepseek', 'first']])
    assert.equal(f.writes.length, 0)
    list(tree).props.onPointerUp(pointer.event(180, pointerType))
    await setImmediate()
    assert.deepEqual(f.writes.at(-1)?.value.translationModels, [second, third, first])
    assert.equal(f.writes.length, 1)
  })
}

test('cancelled drags, clicks, and drops outside the pool do not change priority', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [first, second] })
  t.after(() => f.renderer.dispose())
  let tree = await loaded(f)
  const tr = resolveCodingNsTranslator()
  const pointer = pointerHarness(tree)
  let grip = button(tree, tr('translation.modelDrag', { model: 'DeepSeek / First' }))
  grip.props.onPointerDown(pointer.event())
  pointer.target(1)
  list(tree).props.onPointerMove(pointer.event(130))
  tree = f.renderer.render()
  grip = button(tree, tr('translation.modelDrag', { model: 'DeepSeek / First' }))
  list(tree).props.onPointerCancel()
  tree = f.renderer.render()
  assert.deepEqual(order(tree), [['deepseek', 'first'], ['backup', 'second']])

  grip = button(tree, tr('translation.modelDrag', { model: 'DeepSeek / First' }))
  grip.props.onPointerDown(pointer.event())
  list(tree).props.onPointerUp(pointer.event())
  grip.props.onPointerDown(pointer.event())
  pointer.target(1)
  list(tree).props.onPointerMove(pointer.event(130))
  tree = f.renderer.render()
  pointer.target(-1)
  list(tree).props.onPointerUp(pointer.event(180))
  await setImmediate()
  assert.equal(f.writes.length, 0)
  assert.deepEqual(order(f.renderer.render()), [['deepseek', 'first'], ['backup', 'second']])
})

test('keyboard reordering works with the drag handle and respects list boundaries', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [first, second, third] })
  t.after(() => f.renderer.dispose())
  let tree = await loaded(f)
  const tr = resolveCodingNsTranslator()
  const event = (key: string) => ({ key, preventDefault() {}, stopPropagation() {} })
  button(tree, tr('translation.modelDrag', { model: 'DeepSeek / First' })).props.onKeyDown(event('ArrowUp'))
  assert.equal(f.writes.length, 0)
  button(tree, tr('translation.modelDrag', { model: 'Backup / Third' })).props.onKeyDown(event('Home'))
  await setImmediate()
  tree = f.renderer.render()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [third, first, second])
  button(tree, tr('translation.modelDrag', { model: 'Backup / Third' })).props.onKeyDown(event('ArrowDown'))
  await setImmediate()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [first, third, second])
})

test('an unavailable saved model remains visible, ordered, and removable', async (t) => {
  const missing = { provider: 'removed', model: 'missing' }
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [missing, second] })
  t.after(() => f.renderer.dispose())
  const tree = await loaded(f)
  const tr = resolveCodingNsTranslator()
  assert.deepEqual(order(tree), [['removed', 'missing'], ['backup', 'second']])
  assert.equal(elements(tree).some((element) => element.props.children === tr('translation.modelUnavailable')), true)
  assert.equal(button(tree, tr('translation.modelDrag', { model: 'removed / missing' })).props.disabled, false)
  button(tree, tr('translation.modelRemove', { model: 'removed / missing' })).props.onClick()
  await setImmediate()
  assert.deepEqual(f.writes.at(-1)?.value.translationModels, [second])
})

test('disabled modules and read-only snapshots disable pool selection and reordering', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [first, second] })
  t.after(() => f.renderer.dispose())
  f.renderer.render()
  await setImmediate()
  for (const props of [
    { ...f.props, enabled: false },
    { ...f.props, snapshot: { ...f.snapshot, writable: false } },
    { ...f.props, snapshot: { ...f.snapshot, status: 'loading' as const } },
  ]) {
    const controls = elements(f.renderer.render(props)).filter((element) => element.type === DshButton)
    assert.ok(controls.length > 0)
    assert.equal(controls.every((element) => element.props.disabled), true)
  }
  assert.equal(f.writes.length, 0)
})

test('pending additions lock the dialog and a rejected save retains the selection for retry', async (t) => {
  const f = fixture()
  t.after(() => f.renderer.dispose())
  let rejectWrite: (error: Error) => void = () => undefined
  f.props.services.settings.set = () => new Promise((_resolve, reject) => { rejectWrite = reject })
  let tree = openPicker(f, await loaded(f))
  const tr = resolveCodingNsTranslator()
  checkbox(tree, 'Backup / Second').props.onChange(true)
  tree = f.renderer.render()
  button(tree, tr('translation.modelAddSelected', { count: 1 })).props.onClick()
  tree = f.renderer.render()
  const controls = elements(tree).filter((element) => [DshButton, DshCheckbox, DshInput].includes(element.type as any))
  assert.equal(controls.every((element) => element.props.disabled), true)
  modal(tree).props.onClose()
  assert.equal(modal(f.renderer.render()).props.open, true)
  rejectWrite(new Error('settings write rejected'))
  await setImmediate()
  const recovered = f.renderer.render()
  assert.equal(checkbox(recovered, 'Backup / Second').props.disabled, false)
  assert.equal(checkbox(recovered, 'Backup / Second').props.checked, true)
  assert.equal(modal(recovered).props.open, true)
  assert.equal(elements(recovered).some((element) => element.props.role === 'alert' && element.props.children === tr('translation.saveRejected')), true)
  assert.deepEqual(order(recovered), [['deepseek', 'first']])
})

test('empty catalogues and fully populated pools do not offer invalid additions', async (t) => {
  const f = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [first, second, third] })
  t.after(() => f.renderer.dispose())
  const tree = openPicker(f, await loaded(f))
  const tr = resolveCodingNsTranslator()
  assert.equal(elements(tree).some((element) => element.type === DshCheckbox), false)
  assert.equal(elements(tree).some((element) => element.props.children === tr('translation.modelAllAdded')), true)
  assert.equal(button(tree, tr('translation.modelAddSelected', { count: 0 })).props.disabled, true)
  const empty = fixture({ ...DEFAULT_SESSION_TRANSLATION_SETTINGS, translationModels: [] })
  t.after(() => empty.renderer.dispose())
  empty.props.services.rpc.call = async () => ({ ok: true, value: { models: [], default: null, errors: [] } }) as never
  const emptyTree = openPicker(empty, await loaded(empty))
  assert.equal(elements(emptyTree).some((element) => element.props.children === tr('translation.modelEmpty')), true)
  assert.equal(button(emptyTree, tr('translation.modelAddSelected', { count: 0 })).props.disabled, true)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ASSISTANT_AVATAR_STATES, BUILTIN_ASSISTANT_AVATAR, assistantAvatarImageSource, assistantSpriteMotion, assistantSpriteReactionMotion,
  copyAssistantAvatarModel, normalizeAssistantAppearance, resolveAssistantAvatarAsset, validateAssistantAvatarModel } from '../src/shared/assistant-avatar.js'
import type { AssistantAvatarModel } from '../src/shared/assistant-avatar.js'
import { BUILTIN_ASSISTANT_AVATAR_ADAPTERS, assistantAvatarManifest } from '../src/shared/assistant-avatar-adapters.js'
import { BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS } from '../src/host/avatar/materials.js'
import { AssistantLive2dController } from '../src/client/avatar/live2d.js'
import { AssistantAvatarSlot } from '../src/client/avatar/slot.js'
import { AssistantSpriteClock } from '../src/client/avatar/spritesheet.js'
import { resolveCodingNsTranslator } from '../src/client/locale.js'
import type { CodingNsClientServices } from '../src/client/features/types.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

const image: AssistantAvatarModel = { id: 'reaction-image', name: '情绪形象', renderer: 'image', source: '/idle.png', spriteVersion: 2,
  stateSources: { speaking: '/talk.png' }, reactionSources: { success: '/success.png', concerned: '/sad.png' } }
const live2d: AssistantAvatarModel = { id: 'reaction-live2d', name: '模型', renderer: 'live2d', source: '/model.model3.json', spriteVersion: 2,
  reactionMotionGroups: { success: 'Happy', concerned: 'Missing' }, reactionExpressions: { success: 'Smile', concerned: 'Missing' } }

test('2.1 六种语音状态不扩展；情绪可选且复制、双展示与清单完整往返', () => {
  assert.deepEqual(ASSISTANT_AVATAR_STATES, ['idle', 'listening', 'thinking', 'speaking', 'waiting', 'error'])
  const { id, name, ...asset } = live2d
  const model: AssistantAvatarModel = { ...image, surfaces: { dialog: asset } }
  validateAssistantAvatarModel(model)
  const copied = copyAssistantAvatarModel(model)
  assert.notEqual(copied.reactionSources, model.reactionSources)
  assert.deepEqual(copied, model)
  assert.equal(resolveAssistantAvatarAsset(copied, 'dialog').reactionMotionGroups?.success, 'Happy')
  const manifest = assistantAvatarManifest(model)
  const adapter = BUILTIN_ASSISTANT_AVATAR_ADAPTERS.find((item) => item.id === 'codingns-pack')!
  const imported = adapter.parse(manifest, { manifestUrl: 'https://avatar.test/pack/avatar.json' })
  assert.equal(imported.reactionSources?.success, 'https://avatar.test/success.png')
  assert.deepEqual(imported.surfaces?.dialog?.reactionExpressions, live2d.reactionExpressions)
  const normalized = normalizeAssistantAppearance({ models: [BUILTIN_ASSISTANT_AVATAR, imported], selectedId: imported.id })
  assert.deepEqual(normalized.models.find((item) => item.id === imported.id)?.reactionSources, imported.reactionSources)
  validateAssistantAvatarModel({ id: 'old-image', name: '旧包', renderer: 'image', source: '/old.png', spriteVersion: 1 })
})

test('2.1 非法映射、错用渲染器与图集越界拒绝，旧九行不能凭空增加成功行', () => {
  for (const patch of [{ reactionSources: { unknown: '/a.png' } }, { reactionSources: { success: 'javascript:alert(1)' } },
    { reactionMotionGroups: { success: 'Happy' } }, { reactionExpressions: { success: 'Smile' } }]) assert.throws(() => validateAssistantAvatarModel({ ...image, ...patch }))
  const sprite = { id: 'reaction-sprite', name: '精灵', renderer: 'spritesheet', source: '/sprite.png', spriteVersion: 1 }
  for (const motion of [{ row: 9, frames: 1, interval: 100 }, { row: 0, frames: 9, interval: 100 },
    { row: 0, frames: 1, interval: 0 }, { row: 0, frames: 1, interval: 100, command: 'run' }]) {
    assert.throws(() => validateAssistantAvatarModel({ ...sprite, reactionMotionGroups: { success: motion } }))
  }
  validateAssistantAvatarModel({ ...sprite, reactionMotionGroups: { success: { row: 2, frames: 4, interval: 100 } } })
  assert.deepEqual(assistantSpriteReactionMotion(sprite as AssistantAvatarModel, 'idle', 'success'), assistantSpriteMotion('idle'))
})

test('2.1 图片情绪资源与双展示走同一安装上下文，动作和表情名不改写', async () => {
  const sources: string[] = []
  const installed = await BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS[0]!.install(image, {
    file: async (source) => { sources.push(source); return `/local${source}` }, model: async () => assert.fail('图片不应加载模型'),
  })
  assert.deepEqual(sources.sort(), ['/idle.png', '/talk.png', '/success.png', '/sad.png'].sort())
  assert.equal(installed.reactionSources?.success, '/local/success.png')
  const model = await BUILTIN_ASSISTANT_AVATAR_MATERIAL_ADAPTERS[1]!.install(live2d, {
    file: async () => assert.fail('模型依赖由模型安装器处理'), model: async () => '/local/model.model3.json',
  })
  assert.deepEqual(model.reactionExpressions, live2d.reactionExpressions)
  assert.deepEqual(model.reactionMotionGroups, live2d.reactionMotionGroups)
})

test('2.2 图片与精灵单动作通道保留语音优先，清除情绪恢复旧动作', () => {
  const sprite: AssistantAvatarModel = { ...image, renderer: 'spritesheet', reactionSources: undefined,
    reactionMotionGroups: { success: { row: 2, frames: 4, interval: 100 } } } as unknown as AssistantAvatarModel
  assert.equal(assistantAvatarImageSource(image, 'idle', 'success'), '/success.png')
  assert.equal(assistantAvatarImageSource(image, 'speaking', 'success'), '/talk.png')
  assert.equal(assistantAvatarImageSource(image, 'listening', 'success'), '/idle.png')
  assert.equal(assistantAvatarImageSource(image, 'idle'), '/idle.png')
  assert.equal(assistantSpriteReactionMotion(sprite, 'idle', 'success').row, 2)
  for (const state of ['speaking', 'listening', 'thinking'] as const) assert.deepEqual(assistantSpriteReactionMotion(sprite, state, 'success'), assistantSpriteMotion(state))
  const clock = new AssistantSpriteClock('idle')
  clock.setMotion(assistantSpriteReactionMotion(sprite, 'idle', 'success'))
  assert.deepEqual(clock.tick(0), { row: 2, frame: 0 })
  assert.deepEqual(clock.tick(100), { row: 2, frame: 1 })
  clock.setMotion(assistantSpriteReactionMotion(sprite, 'idle'))
  assert.deepEqual(clock.tick(100), { row: 0, frame: 0 })
})

test('2.2 Live2D 反应不重复加载、不重播同组；监听和说话不被抢占', async () => {
  let loads = 0
  const motions: string[] = [], expressions: string[] = []
  const controller = new AssistantLive2dController({ load: async () => { loads++ }, getMotions: () => ({ Idle: [], Talk: [], Listen: [], Happy: [] }),
    playMotion: (group) => motions.push(group), getExpressions: () => ['Smile'], setExpression: (id) => expressions.push(id), resize() {}, destroy() {} },
    undefined, undefined, undefined, 45000, live2d)
  controller.setReaction('success'); await controller.load(live2d.source)
  controller.setReaction('success'); controller.setState('speaking'); controller.setReaction('concerned')
  controller.setReaction('success'); controller.setState('listening'); controller.setState('idle'); controller.setReaction(undefined)
  assert.deepEqual(motions, ['Happy', 'Talk', 'Listen', 'Happy', 'Idle'])
  assert.equal(loads, 1)
  assert.deepEqual(expressions, [], '只有 get/set、没有清除能力的当前 l2d 不启用持续表情')
  controller.dispose(); controller.setReaction('success'); assert.equal(motions.length, 5)
})

test('2.2 完整表情能力只设置真实名称，清除与销毁复位；缺失动作回落', async () => {
  const expressions: string[] = [], motions: string[] = []
  const controller = new AssistantLive2dController({ load: async () => {}, getMotions: () => ({ Idle: [], Talk: [] }), playMotion: (group) => motions.push(group),
    getExpressions: () => ['Smile'], setExpression: (id) => expressions.push(id), clearExpression: () => expressions.push('clear'), resize() {}, destroy() {} },
    undefined, undefined, undefined, 45000, live2d)
  await controller.load(live2d.source)
  controller.setReaction('success'); controller.setState('speaking'); controller.setReaction('concerned'); controller.setReaction('success')
  controller.setState('listening'); controller.setState('thinking')
  assert.deepEqual(expressions, ['Smile', 'clear'], '语音优先期间持续表情必须复位，不能抢占监听或说话')
  controller.setState('idle'); controller.dispose()
  assert.deepEqual(expressions, ['Smile', 'clear', 'Smile', 'clear'])
  assert.deepEqual(motions, ['Idle', 'Talk', 'Idle'])
})

test('2.2 插槽的模型 key 不包含情绪；旧包有可访问角标而无需增加素材', () => {
  const services = { locale: { bind: () => resolveCodingNsTranslator(), subscribe: () => () => {}, getSnapshot: () => 'zh' } } as unknown as CodingNsClientServices
  const props = { services, model: BUILTIN_ASSISTANT_AVATAR, state: 'idle' as const, surface: 'floating' as const, size: 144 }
  const renderer = createHookRenderer(AssistantAvatarSlot, props)
  try {
    const first = renderer.render()
    const reaction = renderer.render({ ...props, reaction: 'success' } as typeof props)
    assert.equal(first.key, reaction.key)
  } finally { renderer.dispose() }
  const html = renderToStaticMarkup(createElement(AssistantAvatarSlot, { ...props, reaction: 'question' }))
  assert.ok(html.includes('data-codingns-avatar-reaction="question"'))
  assert.ok(html.includes(resolveCodingNsTranslator()('awb.notifications.question')))
})

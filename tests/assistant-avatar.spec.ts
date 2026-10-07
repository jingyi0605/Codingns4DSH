import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantSpriteMotion, BUILTIN_ASSISTANT_AVATAR, BUILTIN_ASSISTANT_AVATARS, clampAssistantAvatarPosition, DEFAULT_ASSISTANT_APPEARANCE, isAssistantAvatarSource, normalizeAssistantAppearance, resolveAssistantAvatarState, validateAssistantAppearance } from '../data/build/dist/shared/assistant-avatar.js'

test('旧设置和已删除模型回到内置角色，不改变默认入口', () => {
  assert.deepEqual(normalizeAssistantAppearance(undefined), DEFAULT_ASSISTANT_APPEARANCE)
  const value = normalizeAssistantAppearance({ selectedId: 'missing', floatingSize: Infinity, models: [{ id: 'bad', name: '坏模型', renderer: 'image', source: 'javascript:alert(1)', spriteVersion: 2 }] })
  assert.equal(value.selectedId, BUILTIN_ASSISTANT_AVATAR.id)
  assert.equal(value.models.length, 2)
  assert.equal(value.floatingEnabled, false)
})

test('素材入口拒绝脚本、文件、凭据和协议相对地址', () => {
  for (const source of ['javascript:alert(1)', 'file:///tmp/pet.png', '//evil.test/pet.png', '/\\evil.test/pet.png', 'https://user:password@test/pet.png', 'data:text/html,x']) assert.equal(isAssistantAvatarSource(source), false, source)
  for (const source of ['/pets/robot.png', 'https://cdn.test/pet.webp', 'http://localhost:3000/a.model3.json']) assert.equal(isAssistantAvatarSource(source), true, source)
})

test('持久配置严格拒绝非法模型、重复 ID 和失效选择', () => {
  validateAssistantAppearance(DEFAULT_ASSISTANT_APPEARANCE)
  const model = { id: 'my-pet', name: '我的形象', renderer: 'spritesheet', source: '/pets/pet.webp', spriteVersion: 2 as const }
  const valid = { ...DEFAULT_ASSISTANT_APPEARANCE, selectedId: model.id, models: [...BUILTIN_ASSISTANT_AVATARS, model] }
  validateAssistantAppearance(valid)
  assert.throws(() => validateAssistantAppearance({ ...valid, models: [...valid.models, model] }), /重复/u)
  assert.throws(() => validateAssistantAppearance({ ...valid, selectedId: 'gone' }), /清单/u)
  assert.throws(() => validateAssistantAppearance({ ...valid, floatingSize: 1000 }), /尺寸/u)
  assert.throws(() => validateAssistantAppearance({ ...valid, models: [model] }), /清单/u)
  assert.deepEqual(normalizeAssistantAppearance(valid), valid)
})

test('语音真实状态优先于等待标记，精灵图始终落在 v1/v2 共有动画行内', () => {
  assert.equal(resolveAssistantAvatarState('speaking', true), 'speaking')
  assert.equal(resolveAssistantAvatarState('error', true), 'error')
  assert.equal(resolveAssistantAvatarState('disabled'), 'idle')
  assert.equal(resolveAssistantAvatarState('recording'), 'listening')
  assert.equal(resolveAssistantAvatarState('loading'), 'thinking')
  for (const state of ['idle', 'listening', 'thinking', 'speaking', 'waiting', 'error'] as const) {
    const motion = assistantSpriteMotion(state)
    assert.ok(motion.row >= 0 && motion.row < 9)
    assert.ok(motion.frames > 0 && motion.frames <= 8)
  }
})

test('视口缩小、模型变大和非法旧坐标均保持可见', () => {
  assert.deepEqual(clampAssistantAvatarPosition(900, 800, 200, 300, 400, 600), { x: 200, y: 300 })
  assert.deepEqual(clampAssistantAvatarPosition(NaN, -20, 500, 500, 300, 300), { x: 0, y: 0 })
})

test('旧清单超过上限时仍保留内置角色，并产出可以重新保存的配置', () => {
  const models = Array.from({ length: 25 }, (_, index) => ({ id: `pet-${index}`, name: `形象 ${index}`, renderer: 'image', source: '/pets/a.png', spriteVersion: 2 }))
  const normalized = normalizeAssistantAppearance({ models, selectedId: 'pet-24' })
  assert.equal(normalized.models.length, 21)
  assert.equal(normalized.selectedId, BUILTIN_ASSISTANT_AVATAR.id)
  validateAssistantAppearance(normalized)
})

test('旧默认 ID 保持兼容，升级补男生形象并完整保留 19 个自定义形象', () => {
  const models = Array.from({ length: 19 }, (_, index) => ({ id: `custom-${index}`, name: `形象 ${index}`, renderer: 'image', source: '/pets/a.png', spriteVersion: 2 as const }))
  const old = { ...DEFAULT_ASSISTANT_APPEARANCE, models: [{ ...BUILTIN_ASSISTANT_AVATAR, name: 'CodingNS' }, ...models], selectedId: models[18]!.id }
  validateAssistantAppearance(old)
  const migrated = normalizeAssistantAppearance(old)
  assert.deepEqual(migrated.models.slice(2), models)
  assert.equal(migrated.selectedId, old.selectedId)
  assert.deepEqual(migrated.models.slice(0, 2), BUILTIN_ASSISTANT_AVATARS)
  assert.deepEqual(migrated.models.slice(0, 2).map((model) => model.name), ['鱼妞', '鱼仔'])
  validateAssistantAppearance(migrated)
  validateAssistantAppearance({ ...migrated, models: migrated.models.map((model) => model.id === 'codingns-basic-male' ? { ...model, name: '基础形象 · 男生' } : model) })
})

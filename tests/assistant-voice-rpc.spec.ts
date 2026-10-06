import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { provideHostVoiceAgentService } from '../data/build/dist/host/features/global-voice-rpc.js'
import { VoiceAgentService } from '../data/build/dist/host/features/voice-agent-service.js'

test('Host voiceAgent 服务按功能生命周期注册并可释放', async () => {
  const ctx = new Context()
  const agent = new VoiceAgentService()
  const dispose = provideHostVoiceAgentService(ctx, agent)
  assert.equal(ctx.get('voiceAgent'), agent)
  assert.equal(typeof dispose, 'function')
  await dispose?.()
  assert.equal(ctx.get('voiceAgent'), undefined)
})

test('已有 Host voiceAgent 时不覆盖宿主服务', async () => {
  const ctx = new Context()
  const existing = {
    capabilities: () => ({}),
    startConversation: async () => ({ }),
    registerActions: () => ({ dispose() {} }),
  }
  const unregister = ctx.reflect.provide('voiceAgent', existing)
  const agent = new VoiceAgentService()
  const dispose = provideHostVoiceAgentService(ctx, agent)
  assert.equal(dispose, undefined)
  assert.equal(ctx.get('voiceAgent'), existing)
  await unregister()
})

test('已有 Host voiceAgent 契约不完整时显式失败', () => {
  const ctx = new Context()
  const unregister = ctx.reflect.provide('voiceAgent', { capabilities: () => ({}) })
  assert.throws(
    () => provideHostVoiceAgentService(ctx, new VoiceAgentService()),
    /incompatible contract/,
  )
  void unregister()
})

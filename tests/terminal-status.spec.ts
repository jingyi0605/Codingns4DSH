import assert from 'node:assert/strict'
import test from 'node:test'
import { FeatureRegistry } from '../data/build/dist/features/index.js'
import { createTerminalStatusFeature } from '../data/build/dist/host/features/index.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'

test('终端状态由 Host 平台和实际 controller 模式决定', async () => {
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry({
    rpc,
    settings: {
      get: () => ({ terminalEnhancement: { defaultProfile: 'zsh' } }),
    },
  } as never)
  registry.register(createTerminalStatusFeature({
    platform: 'linux',
    controllerMode: 'baseline',
    effectiveEnabled: false,
    detectShells: () => [
      { profileId: 'zsh', displayName: 'zsh', path: null, available: false },
      { profileId: 'bash', displayName: 'bash', path: '/bin/bash', available: true },
    ],
  }))
  await registry.start('terminalStatus')

  const target = rpc.resolve('terminal/status')
  assert.notEqual(target, null)
  assert.deepEqual(await target!.handler(target!.action, {}), {
    platform: 'linux',
    controllerMode: 'baseline',
    effectiveEnabled: false,
    profiles: [{ profileId: 'bash', name: 'bash', path: '/bin/bash' }],
    resolvedProfileId: 'bash',
    fallbackReason: 'zsh 当前不可用，已回退到bash',
  })
})

test('终端状态模块停用后注销 RPC', async () => {
  const rpc = new CodingNsRpcTable()
  const registry = new FeatureRegistry({ rpc } as never)
  registry.register(createTerminalStatusFeature({ platform: 'unsupported' }))
  await registry.start('terminalStatus')
  assert.notEqual(rpc.resolve('terminal/status'), null)
  await registry.disable('terminalStatus')
  assert.equal(rpc.resolve('terminal/status'), null)
})

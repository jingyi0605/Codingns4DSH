import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installTerminalController,
  resolveTerminalStartupIdentity,
  terminalAttachmentGeneration,
  terminalWorkspaceId,
} from '../data/build/dist/host/terminal/startup.js'

const settingsValue = (enabled: boolean) => ({
  modules: { terminalEnhancement: enabled },
  terminalEnhancement: {
    defaultProfile: 'system' as const,
    appearance: {
      theme: 'inherit' as const,
      background: null,
      foreground: null,
      cursorColor: null,
      fontFamily: null,
      fontSize: null,
      lineHeight: null,
      cursorStyle: null,
      cursorBlink: null,
      scrollback: null,
    },
  },
})

test('Host ID 和终端映射路径在同一 DSH Profile 下保持稳定', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codingns-startup-'))
  try {
    const settingsPath = join(directory, 'settings.json')
    const first = await resolveTerminalStartupIdentity(
      settingsPath,
      () => 'local-11111111-1111-4111-8111-111111111111',
    )
    const second = await resolveTerminalStartupIdentity(
      settingsPath,
      () => 'local-22222222-2222-4222-8222-222222222222',
    )
    assert.deepEqual(second, first)
    assert.equal(first.storeFilename, join(directory, 'dsh-codingns', 'terminals.json'))
    assert.equal(await readFile(first.hostIdFilename, 'utf8'), `${first.hostId}\n`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('启动装配只读取一次开关并在 baseline 模式不创建持久身份', async () => {
  let identityReads = 0
  let captured: unknown
  const result = await installTerminalController(
    new Context(),
    { get: () => settingsValue(false) } as never,
    { documentPath: undefined },
    {
      resolveIdentity: async () => {
        identityReads += 1
        throw new Error('baseline 不应读取持久身份')
      },
      createController: (async (_ctx, options) => {
        captured = options
        return { mode: 'baseline', controller: {} } as never
      }) as never,
    },
  )
  assert.equal(result.mode, 'baseline')
  assert.equal(identityReads, 0)
  assert.deepEqual(captured, {
    enhancedEnabled: false,
    settings: (captured as { settings: () => unknown }).settings,
  })
})

test('强化模式把稳定 Host、store、workspace 和 attachment generation 传给工厂', async () => {
  let captured: any
  const result = await installTerminalController(
    new Context(),
    { get: () => settingsValue(true) } as never,
    { documentPath: '/profile/settings.json' },
    {
      platform: 'linux',
      resolveIdentity: async () => ({
        hostId: 'local-11111111-1111-4111-8111-111111111111',
        storeFilename: '/profile/dsh-codingns/terminals.json',
        hostIdFilename: '/profile/dsh-codingns/host-id',
      }),
      createController: (async (_ctx, options) => {
        captured = options
        return { mode: 'enhanced', controller: {}, service: {} } as never
      }) as never,
    },
  )
  assert.equal(result.mode, 'enhanced')
  assert.equal(captured.enhancedEnabled, true)
  assert.equal(captured.hostId, 'local-11111111-1111-4111-8111-111111111111')
  assert.equal(captured.storeFilename, '/profile/dsh-codingns/terminals.json')
  assert.equal(captured.platform, 'linux')
  assert.equal(
    captured.generation({ id: 'session-a' }, 'attach-a'),
    terminalAttachmentGeneration(captured.hostId, 'attach-a'),
  )
  assert.equal(captured.workspaceId({ id: 'session-a' }, '/workspace/a'), terminalWorkspaceId('/workspace/a'))
})

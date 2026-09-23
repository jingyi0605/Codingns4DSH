import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { CodingNsTerminalController } from '../dist/host/terminal/terminal-controller.js'
import { createTerminalController } from '../dist/host/terminal/controller-factory.js'

const terminalSettings = {
  defaultProfile: 'system',
  appearance: {
    theme: 'inherit', background: null, foreground: null, cursorColor: null,
    fontFamily: null, fontSize: null, lineHeight: null, cursorStyle: null,
    cursorBlink: null, scrollback: null,
  },
}

test('兼容 controller 完整导出 DSH remote.terminal 十个方法', () => {
  const ctx = new Context()
  const service = {
    listSession: () => [],
  }
  const controller = new CodingNsTerminalController(ctx, {
    hostId: 'host-a',
    service,
    settings: () => ({ defaultProfile: 'system', appearance: { scrollback: null } }),
    platform: 'darwin',
    detectShells: () => [{ profileId: 'zsh', displayName: 'zsh', path: '/bin/zsh', available: true }],
  })
  assert.deepEqual(remoteMethods(controller).map((method) => [method.method, method.mode ?? 'call']), [
    ['environment', 'call'],
    ['shells', 'call'],
    ['list', 'call'],
    ['create', 'call'],
    ['retain', 'stream'],
    ['follow', 'stream'],
    ['write', 'call'],
    ['resize', 'call'],
    ['rename', 'call'],
    ['close', 'call'],
  ])
})

test('shell 列表只返回 Host 检测到的白名单并把设置默认项排在首位', () => {
  const ctx = new Context()
  const controller = new CodingNsTerminalController(ctx, {
    hostId: 'host-a',
    service: { listSession: () => [] },
    settings: () => ({ defaultProfile: 'bash', appearance: { scrollback: 5000 } }),
    platform: 'linux',
    detectShells: () => [
      { profileId: 'zsh', displayName: 'zsh', path: '/bin/zsh', available: true },
      { profileId: 'bash', displayName: 'bash', path: '/bin/bash', available: true },
    ],
  })
  const signal = new AbortController().signal
  const agent = { id: 'session-a', session: { header: { cwd: '/workspace/a' } } }

  assert.deepEqual(controller.shells(agent, signal).map((shell) => shell.path), ['/bin/bash', '/bin/zsh'])
  assert.equal(controller.environment(agent, signal).scrollback, 5000)
})

test('terminal list 按当前 session 解析出的工作区读取持久终端', () => {
  let requested
  const controller = new CodingNsTerminalController(new Context(), {
    hostId: 'host-a',
    service: {
      listSession: (hostId, sessionId, workspaceId) => {
        requested = { hostId, sessionId, workspaceId }
        return []
      },
    },
    settings: () => ({ defaultProfile: 'system', appearance: { scrollback: 1000 } }),
    platform: 'darwin',
    workspaceId: (_agent, cwd) => `workspace:${cwd}`,
  })
  const signal = new AbortController().signal
  const agent = { id: 'session-a', session: { header: { cwd: '/workspace/a' } } }

  controller.environment(agent, signal)
  controller.list('session-a')
  assert.deepEqual(requested, {
    hostId: 'host-a',
    sessionId: 'session-a',
    workspaceId: 'workspace:/workspace/a',
  })
})

test('同一 DSH Workspace 下的不同 session 共享终端列表', () => {
  const ctx = new Context()
  const originalGet = ctx.get.bind(ctx)
  ;(ctx as unknown as { get: (name: string) => unknown }).get = (name: string) => {
    if (name === 'workspaceRegistry') return {
      list: () => [{ id: 'workspace-stable', sessionIds: ['session-a', 'session-b'] }],
    }
    return originalGet(name)
  }
  const requested: string[] = []
  const controller = new CodingNsTerminalController(ctx, {
    hostId: 'host-a',
    service: {
      listSession: (_hostId, _sessionId, workspaceId) => {
        requested.push(String(workspaceId))
        return []
      },
    },
    settings: () => ({ defaultProfile: 'system', appearance: { scrollback: 1000 } }),
    workspaceId: (_agent, cwd) => `cwd:${cwd}`,
  })
  const signal = new AbortController().signal
  const agent = (id: string) => ({ id, session: { header: { cwd: `/workspace/${id}` } } })

  controller.environment(agent('session-a'), signal)
  controller.list('session-a')
  controller.environment(agent('session-b'), signal)
  controller.list('session-b')
  assert.deepEqual(requested, ['workspace-stable', 'workspace-stable'])
})

test('会话绑定设置覆盖 Workspace Registry 并为每个 session 隔离终端', () => {
  const ctx = new Context()
  const originalGet = ctx.get.bind(ctx)
  ;(ctx as unknown as { get: (name: string) => unknown }).get = (name: string) => {
    if (name === 'workspaceRegistry') return {
      list: () => [{ id: 'workspace-stable', sessionIds: ['session-a', 'session-b'] }],
    }
    return originalGet(name)
  }
  const requested: string[] = []
  const controller = new CodingNsTerminalController(ctx, {
    hostId: 'host-a',
    service: {
      listSession: (_hostId, _sessionId, workspaceId) => {
        requested.push(String(workspaceId))
        return []
      },
    },
    settings: () => ({ defaultProfile: 'system', bindingScope: 'session', appearance: { scrollback: 1000 } }),
  })
  const signal = new AbortController().signal
  const agent = (id: string) => ({ id, session: { header: { cwd: `/workspace/${id}` } } })
  controller.environment(agent('session-a'), signal)
  controller.list('session-a')
  controller.environment(agent('session-b'), signal)
  controller.list('session-b')
  assert.deepEqual(requested, ['session:session-a', 'session:session-b'])
})

test('禁用强化时工厂仍使用插件 controller 与进程内 PTY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codingns-controller-'))
  try {
    const result = await createTerminalController(new Context(), {
      enhancedEnabled: false,
      settings: () => terminalSettings,
      platform: 'darwin',
    })
    assert.equal(result.mode, 'baseline')
    assert.equal(result.controller.constructor.name, 'CodingNsTerminalController')
    assert.ok(result.controller instanceof CodingNsTerminalController)
    assert.ok(result.service)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

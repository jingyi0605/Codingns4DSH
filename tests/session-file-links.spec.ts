import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import test from 'node:test'
import { fileAddressFor, parseFileAddress, sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { installNativeSessionFileLinkRouting } from '../src/client/session-file-links.js'
import { createVirtualSessionId } from '../src/shared/contracts/peer-host.js'
import { CODINGNS_DSH_VERSION_GLOBAL } from '../src/shared/index.js'

test('插件入口在 PeerHost 未启用时随原生服务就绪挂载，并在卸载时恢复文件入口', async () => {
  const { apply } = await import('../src/client/index.js')
  const globals = globalThis as unknown as Record<string, unknown>
  const previousVersion = globals[CODINGNS_DSH_VERSION_GLOBAL]
  globals[CODINGNS_DSH_VERSION_GLOBAL] = '0.2.1-alpha.2'
  let opened = ''
  const sidebar = { openResource(address: string) { opened = address } }
  const original = sidebar.openResource
  const services: Record<string, unknown> = {
    sidebarRight: sidebar,
    sessions: { list: { getSnapshot: () => ({ byId: { local: { cwd: 'D:/develop' } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => undefined } },
  }
  let whenReady: ((scope: unknown) => void) | undefined
  let cleanup: (() => void) | undefined
  try {
    apply({
      effect() {},
      inject(names: readonly string[], callback: (scope: unknown) => void) {
        if (names.length === 3 && names.includes('sidebarRight') && names.includes('sessions') && names.includes('workspaces')) whenReady = callback
      },
    } as never)
    assert.equal(sidebar.openResource, original, '服务未就绪前不改入口')
    assert.ok(whenReady, '通用修复由插件入口注册，独立于功能开关')
    whenReady({ get: (name: string) => services[name], effect: (run: () => () => void) => { cleanup = run() } })
    sidebar.openResource(sessionFileAddress('local' as never, '/D:/develop/report.md'))
    assert.equal(parseFileAddress(opened)?.path, 'D:/develop/report.md')
  } finally {
    cleanup?.()
    if (previousVersion === undefined) delete globals[CODINGNS_DSH_VERSION_GLOBAL]
    else globals[CODINGNS_DSH_VERSION_GLOBAL] = previousVersion
  }
  assert.equal(sidebar.openResource, original)
})

test('本地历史报告链接通过原生资源地址读取工作区外的真实 Windows 文件，无需启用 PeerHost', { skip: process.platform !== 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-file-links-'))
  const cwd = join(directory, 'workspace')
  const reportDirectory = join(directory, 'isolated-worktree', 'computer-use-20261012')
  mkdirSync(reportDirectory, { recursive: true })
  const report = join(reportDirectory, 'README.md')
  writeFileSync(report, '诊断报告\n', 'utf8')
  const target = `/${report.replace(/\\/gu, '/')}`
  let opened: { address: string; options?: unknown } | undefined
  const sidebar = {
    openResource(address: string, options?: unknown) {
      opened = { address, options }
      const file = parseFileAddress(address)!
      assert.equal(file.scope, 'session')
      assert.equal(file.scope === 'session' && file.sessionId, 'local-session')
      const resolved = win32.resolve(cwd, file.path)
      assert.equal(statSync(resolved).isFile(), true)
      return readFileSync(resolved, 'utf8')
    },
  }
  const original = sidebar.openResource
  const services: Record<string, unknown> = {
    sidebarRight: sidebar,
    sessions: { list: { getSnapshot: () => ({ byId: { 'local-session': { cwd } } }) } },
    workspaces: { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }), subscribe: () => () => undefined } },
  }
  const restore = installNativeSessionFileLinkRouting({ get: (name: string) => services[name] } as never)!
  try {
    assert.equal(existsSync(win32.resolve(cwd, target)), false, '原始 /盘符路径不能读到真实报告')
    const address = fileAddressFor('local-session' as never, cwd, target)
    assert.equal(sidebar.openResource(address), '诊断报告\n', '历史消息的原始链接可以直接打开')
    assert.equal(parseFileAddress(opened!.address)?.path, report.replace(/\\/gu, '/'))
    const options = { preferNewPane: true, params: { language: 'markdown' } }
    assert.equal(sidebar.openResource(`${address}:12?mode=text#section`, options), '诊断报告\n')
    assert.deepEqual(opened!.options, { preferNewPane: true, params: { line: 12, language: 'markdown' } })
    assert.ok(opened!.address.endsWith('?mode=text#section'))
    assert.deepEqual(options, { preferNewPane: true, params: { language: 'markdown' } })
  } finally {
    restore()
    rmSync(directory, { recursive: true, force: true })
  }
  assert.equal(sidebar.openResource, original)
})

test('通用入口按所属会话的最新真实目录规范，保留 POSIX 和未知会话路径', () => {
  const remoteId = createVirtualSessionId('peer', 'remote-session')
  let byId: Record<string, { cwd: string }> = {}
  let remotePath = 'C:/remote'
  let opened = ''
  const sidebar = {
    openResource(address: string) { opened = address },
    openResourceIn(_owner: string, address: string) { opened = address },
  }
  const services: Record<string, unknown> = {
    sidebarRight: sidebar,
    sessions: { list: { getSnapshot: () => ({ byId }) } },
    workspaces: { list: {
      getSnapshot: () => ({ items: [{ workspaceId: 'remote-workspace', path: 'codingns-peer-host://workspace', workspacePath: remotePath, title: 'remote', sessionIds: [remoteId] }], archivedSessionIds: [] }),
      subscribe: () => () => undefined,
    } },
  }
  const restore = installNativeSessionFileLinkRouting({ get: (name: string) => services[name] } as never)!
  const target = '/D:/develop/report.md'
  const open = (id: string) => {
    sidebar.openResource(sessionFileAddress(id as never, target))
    return parseFileAddress(opened)?.path
  }
  try {
    assert.equal(open('local-session'), target, '未知会话不猜平台')
    byId = { 'local-session': { cwd: 'D:/develop' }, posix: { cwd: '/repo' }, [remoteId]: { cwd: 'codingns-peer-host://workspace' } }
    assert.equal(open('local-session'), target.slice(1), '启动后新增的本地会话可以打开')
    assert.equal(open('posix'), target, '本机 Windows 不影响 POSIX 会话')
    sidebar.openResourceIn('posix', sessionFileAddress('local-session' as never, target))
    assert.equal(parseFileAddress(opened)?.path, target.slice(1), '放置面板的 owner 不决定文件平台')
    assert.equal(open(remoteId), target.slice(1), '远端空白会话使用工作区真实路径')
    remotePath = '/repo'
    assert.equal(open(remoteId), target, '远端目录变化后不保留旧平台判断')
    byId['local-session'] = { cwd: '/repo' }
    assert.equal(open('local-session'), target, '每次点击读取最新会话目录')
  } finally { restore() }
})

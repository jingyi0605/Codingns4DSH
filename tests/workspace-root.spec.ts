import assert from 'node:assert/strict'
import test from 'node:test'
import { listWorkspaceRoots, resolveWorkspaceRoot } from '../data/build/dist/host/workspace-root.js'

function context(registry: unknown) {
  return {
    get(name: string) {
      if (name !== 'workspaceRegistry') return undefined
      return registry
    },
  }
}

test('工作区根目录优先用 registry.get，不依赖终端缓存', () => {
  const registry = {
    get(id: string) {
      return id === 'ws-1' ? { id: 'ws-1', path: '/work/repo' } : undefined
    },
    list() {
      throw new Error('PeerHost Git 不能靠 list 抛错时失败')
    },
  }
  assert.equal(resolveWorkspaceRoot(context(registry), 'ws-1'), '/work/repo')
  assert.equal(resolveWorkspaceRoot(context(registry), 'missing'), null)
})

test('DSH Workspace 实体用 id 与 path getter 解析根目录', () => {
  class WorkspaceEntity {
    readonly id = '30aead24-1111-2222-3333-444444444444'
    get path() { return '/Users/dev/project' }
  }
  const entity = new WorkspaceEntity()
  const registry = {
    list: () => [entity],
  }
  assert.equal(resolveWorkspaceRoot(context(registry), entity.id), '/Users/dev/project')
  assert.deepEqual(listWorkspaceRoots(context(registry)), ['/Users/dev/project'])
})

test('follow 视图用 workspaceId/key 与 cwd 解析根目录', () => {
  const registry = {
    list: () => [
      { workspaceId: 'view-a', cwd: '/remote/a' },
      { key: 'view-b', directory: '  /remote/b  ' },
    ],
  }
  assert.equal(resolveWorkspaceRoot(context(registry), 'view-a'), '/remote/a')
  assert.equal(resolveWorkspaceRoot(context(registry), 'view-b'), '/remote/b')
})

test('Registry 缺失、get 抛错或路径非字符串时返回不可用', () => {
  assert.equal(resolveWorkspaceRoot({ get: () => undefined }, 'ws'), null)
  assert.equal(resolveWorkspaceRoot({ get() { throw new Error('without inject') } }, 'ws'), null)
  assert.equal(resolveWorkspaceRoot(context({
    get() { throw new Error('get failed') },
    list: () => [{ id: 'ws', path: 12 }],
  }), 'ws'), null)
  assert.deepEqual(listWorkspaceRoots({ get() { throw new Error('without inject') } }), [])
})

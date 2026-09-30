import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  EncryptedFilePeerHostCredentialStore,
  FilePeerHostRecordStore,
  InMemoryPeerHostCredentialStore,
  InMemoryPeerHostRecordStore,
  PeerHostStore,
  PeerHostStoreError,
} from '../data/build/dist/host/modules/peer-host/peer-host-store.js'

test('PeerHostStore 规范化局域网地址并拒绝重复目标', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  const created = await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'HTTP://192.168.1.20:13080/' , normalizedOrigin: '' } })
  assert.equal(created.route.kind, 'lan')
  assert.equal(created.route.normalizedOrigin, 'http://192.168.1.20:13080')
  await assert.rejects(
    store.create({ displayName: '重复', route: { kind: 'lan', baseUrl: 'http://192.168.1.20:13080', normalizedOrigin: '' } }),
    (error) => error instanceof PeerHostStoreError && error.code === 'PEER_HOST_DUPLICATE',
  )
})

test('PeerHost 路由变化和删除会清理 Host 侧目标凭据', async () => {
  const credentials = new InMemoryPeerHostCredentialStore()
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  await store.update('peer-1', { route: { kind: 'lan', baseUrl: 'https://127.0.0.1:13080', normalizedOrigin: '' } })
  assert.equal(await credentials.read('peer-1'), null)
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  await store.remove('peer-1')
  assert.equal(await credentials.read('peer-1'), null)
  assert.deepEqual(await store.list(), [])
})

test('文件记录不包含 token，敏感文件使用 AES-256-GCM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-peer-host-'))
  const recordPath = join(root, 'records.json')
  const credentialPath = join(root, 'credentials.enc')
  const recordStore = new FilePeerHostRecordStore(recordPath)
  const credentials = new EncryptedFilePeerHostCredentialStore(credentialPath, new Uint8Array(32).fill(7))
  const store = new PeerHostStore('user-1', recordStore, credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
  assert.doesNotMatch(await readFile(recordPath, 'utf8'), /access-secret|refresh-secret/u)
  assert.doesNotMatch(await readFile(credentialPath, 'utf8'), /access-secret|refresh-secret/u)
  assert.deepEqual(await credentials.read('peer-1'), { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200 })
})

test('保存的账号密码只进入加密凭据文件，绝不进入明文记录文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-peer-host-'))
  const recordPath = join(root, 'records.json')
  const credentialPath = join(root, 'credentials.enc')
  const credentials = new EncryptedFilePeerHostCredentialStore(credentialPath, new Uint8Array(32).fill(7))
  const store = new PeerHostStore('user-1', new FilePeerHostRecordStore(recordPath), credentials, () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  await credentials.write('peer-1', { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200, username: 'alice', password: 'password-secret' })
  const records = await readFile(recordPath, 'utf8')
  const encrypted = await readFile(credentialPath, 'utf8')
  assert.doesNotMatch(records, /alice|password-secret/u)
  assert.doesNotMatch(encrypted, /password-secret/u)
  // 加密文件可以完整还原账号密码，静默重登依赖这一点。
  assert.deepEqual(await credentials.read('peer-1'), {
    accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: 200,
    username: 'alice', password: 'password-secret',
  })
})

test('配色只接受 #rrggbb，非法值被丢弃', async () => {
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  const created = await store.create({
    displayName: '开发机',
    route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' },
    color: '#1677FF',
  })
  // 归一化为小写，避免同一颜色因大小写不同被当成两个值。
  assert.equal(created.color, '#1677ff')

  const invalid = await store.update('peer-1', { color: 'red; background: url(x)' })
  assert.equal(invalid.color, null)
  const cleared = await store.update('peer-1', { color: null })
  assert.equal(cleared.color, null)
})

test('可见工作区默认空集合，增删幂等且持久化到记录文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-peer-host-'))
  const recordPath = join(root, 'records.json')
  const store = new PeerHostStore('user-1', new FilePeerHostRecordStore(recordPath), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  const created = await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  // 新建的 Host 不显示任何远端工作区：这是本次改造的默认语义。
  assert.deepEqual(created.visibleWorkspaceIds, [])

  await store.setWorkspaceVisibility('peer-1', 'workspace-a', true)
  await store.setWorkspaceVisibility('peer-1', 'workspace-a', true)
  await store.setWorkspaceVisibility('peer-1', 'workspace-b', true)
  assert.deepEqual((await store.get('peer-1'))?.visibleWorkspaceIds, ['workspace-a', 'workspace-b'])

  await store.setWorkspaceVisibility('peer-1', 'workspace-a', false)
  // 移除不存在的 ID 不报错，避免并发刷新产生难以理解的状态。
  await store.setWorkspaceVisibility('peer-1', 'workspace-missing', false)
  assert.deepEqual((await store.get('peer-1'))?.visibleWorkspaceIds, ['workspace-b'])

  // 重开一个 store 读取同一份文件，确认可见集合确实落盘。
  const reopened = new PeerHostStore('user-1', new FilePeerHostRecordStore(recordPath), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  assert.deepEqual((await reopened.get('peer-1'))?.visibleWorkspaceIds, ['workspace-b'])
})

test('旧记录缺少可见集合时归一化为空，不会突然显示全部远端工作区', async () => {
  const legacy = {
    id: 'peer-1',
    ownerUserId: 'user-1',
    displayName: '开发机',
    route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: 'http://127.0.0.1:13080' },
    status: 'ready',
    pluginId: '@jingyi0605/codingns4dsh',
    pluginVersion: '0.2.0',
    dshVersion: '0.2.0-rc.1',
    apiCompatibility: 'peer-host-v1',
    fingerprint: 'sha256:abc',
    lastCheckedAt: 1,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  }
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore([legacy] as never), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  const record = await store.get('peer-1')
  assert.deepEqual(record?.visibleWorkspaceIds, [])
  assert.equal(record?.color, null)
})

test('整体替换可见工作区会去重并过滤空值', async () => {
  const store = new PeerHostStore('user-1', new InMemoryPeerHostRecordStore(), new InMemoryPeerHostCredentialStore(), () => 100, () => 'peer-1')
  await store.create({ displayName: '开发机', route: { kind: 'lan', baseUrl: 'http://127.0.0.1:13080', normalizedOrigin: '' } })
  const updated = await store.replaceVisibleWorkspaces('peer-1', ['workspace-a', 'workspace-a', '', '  ', 'workspace-b'])
  assert.deepEqual(updated.visibleWorkspaceIds, ['workspace-a', 'workspace-b'])
})

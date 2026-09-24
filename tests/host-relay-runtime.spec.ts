import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  FileHostDtlsIdentityStore,
  formatHostDtlsFingerprint,
  type HostDtlsIdentityMaterial,
} from '../dist/host/index.js'

const identity: HostDtlsIdentityMaterial = {
  privateKeyPem: 'private-key',
  certPem: 'certificate',
  signatureHash: { signature: 3, hash: 4 },
  fingerprint: 'sha-256 AA:BB:CC',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
}

test('Host DTLS identity 文件存储可写入并恢复完整材料', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-codingns-'))
  const path = join(directory, 'identity.json')
  const store = new FileHostDtlsIdentityStore(path)
  assert.equal(await store.read(), null)
  await store.write(identity)
  assert.deepEqual(await store.read(), identity)
  const raw = await readFile(path, 'utf8')
  assert.match(raw, /private-key/u)
})

test('Host DTLS fingerprint 统一为 sha-256 大写冒号格式', () => {
  assert.equal(formatHostDtlsFingerprint({
    getFingerprints: () => [{ algorithm: 'SHA-256', value: 'aa:1:b' }],
  }), 'sha-256 AA:01:0B')
})

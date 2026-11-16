import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decryptZcodeCredential } from '../data/build/dist/host/cli-adapters/zcode-credentials.js'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest()
function payload(key: Buffer, plaintext = 'fixture-api-key'): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return [iv, cipher.getAuthTag(), encrypted].map(value => value.toString('base64url')).join('.')
}
function v2(key: Buffer, kind: 'os' | 'env'): string {
  return `enc:v2:${kind}:${hash(key).toString('hex').slice(0, 24)}:${payload(key)}`
}

test('ZCode preserves plaintext and legacy authenticated credentials', async () => {
  const secret = 'fixture-secret'
  const encrypted = `enc:v1:${payload(hash(secret))}`
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET: secret } }), 'fixture-api-key')
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET: 'wrong' } }), null)
  const fallback = `zcode-credential-fallback:${process.platform}:${homedir()}:${userInfo().username}`
  assert.equal(await decryptZcodeCredential(`enc:v1:${payload(hash(fallback))}`, { env: {} }), 'fixture-api-key')
  assert.equal(await decryptZcodeCredential(' plain-fixture '), 'plain-fixture')
  assert.equal(await decryptZcodeCredential('  '), null)
})

test('ZCode v2 OS credentials use the specified store identity and fail closed', async () => {
  const key = randomBytes(32)
  const encrypted = v2(key, 'os')
  const path = join(tmpdir(), 'isolated-zcode', 'credentials.json')
  assert.equal(await decryptZcodeCredential(encrypted, {
    credentialPath: path,
    readOsKey: async requested => { assert.equal(requested, path); return key.toString('base64url') },
  }), 'fixture-api-key')
  for (const readOsKey of [async () => randomBytes(32).toString('base64url'), async () => null,
    async () => 'invalid-key', async () => { throw new Error('native module unavailable') }]) {
    assert.equal(await decryptZcodeCredential(encrypted, { readOsKey }), null)
  }
  const fields = encrypted.split(':')
  const parts = fields[4]!.split('.')
  const tag = Buffer.from(parts[1]!, 'base64url'); tag[0] = tag[0]! ^ 1
  parts[1] = tag.toString('base64url'); fields[4] = parts.join('.')
  assert.equal(await decryptZcodeCredential(fields.join(':'), { readOsKey: async () => key.toString('base64url') }), null)
})

test('ZCode v2 env credentials support explicit and adjacent secret files', async () => {
  const home = mkdtempSync(join(tmpdir(), 'zcode-credential-'))
  const secret = 'fixture-secret-with-at-least-32-bytes'
  const encrypted = v2(hash(secret), 'env')
  const credentialPath = join(home, 'credentials.json')
  const secretFile = join(home, 'credential-secret')
  writeFileSync(secretFile, secret)
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET: secret } }), 'fixture-api-key')
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET_FILE: secretFile } }), 'fixture-api-key')
  assert.equal(await decryptZcodeCredential(encrypted, { env: {}, credentialPath }), 'fixture-api-key')
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET: secret, ZCODE_CREDENTIAL_SECRET_FILE: secretFile } }), null)
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET: 'too-short' } }), null)
  assert.equal(await decryptZcodeCredential(encrypted, { env: { ZCODE_CREDENTIAL_SECRET_FILE: join(home, 'absent') } }), null)
})

test('ZCode never returns unsupported or malformed ciphertext as an API key', async () => {
  for (const value of ['enc:v3:unknown', 'enc:v2:os:invalid:x.y.z', 'enc:v1:x.y.z',
    'enc:v1:***.***.***', 'enc:v2:unknown:012345678901234567890123:x.y.z']) {
    assert.equal(await decryptZcodeCredential(value, { env: {}, readOsKey: async () => null }), null)
  }
})

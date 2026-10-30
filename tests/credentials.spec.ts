import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CredentialService } from '../data/build/dist/host/credentials/service.js'
import { EncryptedFileCredentialStore, InMemoryCredentialStore } from '../data/build/dist/host/credentials/store.js'
import { CodingNsRpcError } from '../data/build/dist/host/rpc-table.js'
import { encodeCredentialCarrier, parseCredentialCarriers } from '../data/build/dist/shared/credential-carrier.js'
import { bareSlashSpanAtCaret } from '../data/build/dist/client/command-token.js'
import { formatCredentialEnvironmentNotice } from '../data/build/dist/host/cli-adapters/feature.js'
import { createCliAdaptersFeature } from '../data/build/dist/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../data/build/dist/host/cli-adapters/registry.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { FeatureRegistry } from '../data/build/dist/features/registry.js'

test('credential metadata never exposes stored values and resolution returns only selected fields', async () => {
  const service = new CredentialService({ store: new InMemoryCredentialStore() })
  service.activate()
  await service.save({
    id: 'github',
    label: 'GitHub',
    fields: {
      username: 'alice',
      password: 'password-secret',
      apiKey: 'api-secret',
    },
  })

  const metadata = await service.list()
  assert.equal(metadata.length, 1)
  assert.doesNotMatch(JSON.stringify(metadata), /password-secret|api-secret/u)
  assert.deepEqual(await service.resolve({
    credentialId: 'github',
    bindings: [
      { field: 'username', env: 'GITHUB_USER' },
      { field: 'apiKey', env: 'GITHUB_TOKEN' },
    ],
  }), {
    GITHUB_USER: 'alice',
    GITHUB_TOKEN: 'api-secret',
  })
  service.deactivate()
  await assert.rejects(service.list(), (error) => error instanceof CodingNsRpcError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE')
})

test('encrypted credential storage does not contain plaintext and rejects a wrong key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-credentials-'))
  const path = join(root, 'credentials.enc')
  const store = new EncryptedFileCredentialStore(path, new Uint8Array(32).fill(9))
  const service = new CredentialService({ store })
  service.activate()
  await service.save({
    id: 'provider',
    label: 'Provider',
    fields: { apiKey: 'provider-secret' },
  })
  assert.doesNotMatch(await readFile(path, 'utf8'), /provider-secret/u)
  const reopened = new CredentialService({
    store: new EncryptedFileCredentialStore(path, new Uint8Array(32).fill(9)),
  })
  reopened.activate()
  assert.deepEqual((await reopened.list())[0]?.fields[0], { name: 'apiKey', hasValue: true })
  const wrong = new CredentialService({
    store: new EncryptedFileCredentialStore(path, new Uint8Array(32).fill(8)),
  })
  wrong.activate()
  await assert.rejects(wrong.list(), (error) => error instanceof CodingNsRpcError && error.code === 'CREDENTIAL_STORE_UNAVAILABLE')
})

test('credential environment bindings reject invalid and duplicate names', async () => {
  const service = new CredentialService({ store: new InMemoryCredentialStore() })
  service.activate()
  await service.save({ id: 'one', label: 'One', fields: { key: 'secret' } })
  await assert.rejects(
    service.resolve({ credentialId: 'one', bindings: [{ field: 'key', env: 'CODINGNS_INTERNAL' }] }),
    (error) => error instanceof CodingNsRpcError && error.code === 'CREDENTIAL_ENV_INVALID',
  )
  await assert.rejects(
    service.resolve({ credentialId: 'one', bindings: [{ field: 'key', env: 'ONE' }, { field: 'key', env: 'ONE' }] }),
    (error) => error instanceof CodingNsRpcError && error.code === 'CREDENTIAL_ENV_CONFLICT',
  )
})

test('credential carriers keep only formatted metadata in the message text', () => {
  const carrier = encodeCredentialCarrier('github', 'GitHub')
  assert.equal(carrier, '@[GitHub](codingns-credential:github)')
  const parsed = parseCredentialCarriers(`Use ${carrier} for this request`)
  assert.deepEqual(parsed.carriers, [{ version: 1, credentialId: 'github', label: 'GitHub' }])
  assert.equal(parsed.text, 'Use @GitHub for this request')
  assert.doesNotMatch(parsed.text, /api-secret/u)
})

test('credential carriers preserve IDs containing the letter s', () => {
  const parsed = parseCredentialCarriers(encodeCredentialCarrier('secrets', 'Secrets'))
  assert.deepEqual(parsed.carriers, [{ version: 1, credentialId: 'secrets', label: 'Secrets' }])
  assert.equal(parsed.text, '@Secrets')
})

test('credential prompt guidance names environment variables without exposing values', () => {
  const notice = formatCredentialEnvironmentNotice(['CREDENTIAL_PASSWORD', 'CREDENTIAL_USERNAME', 'CREDENTIAL_PASSWORD'])
  assert.match(notice, /CREDENTIAL_PASSWORD/u)
  assert.match(notice, /CREDENTIAL_USERNAME/u)
  assert.match(notice, /process environment/u)
  assert.doesNotMatch(notice, /secret-value/u)
})

test('external Agent turns receive credential values and secret-free usage guidance', async (t) => {
  const service = new CredentialService({ store: new InMemoryCredentialStore() })
  service.activate()
  await service.save({ id: 'secrets', label: 'Secrets', fields: { apiKey: 'test-token-value' } })

  let listener: ((options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) | undefined
  let received: { readonly prompt: string; readonly runtimeEnv?: Readonly<Record<string, string>> } | undefined
  const registry = new CodingNsCliAdapterRegistry([{
    descriptor: { id: 'codex', name: 'Codex' },
    async detect() { return { installed: true, version: '1.0.0', command: 'codex' } },
    async listModels() { return { groups: [], currentModel: null, currentEffort: null } },
    async *executeTurn(input) {
      received = input
      yield { type: 'finish', reason: 'stop' } as const
    },
  }])
  const table = new CodingNsRpcTable()
  const events = {
    on(name: string, next: (options: unknown, downstream: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) {
      if (name === 'llm/stream') listener = next
      return () => undefined
    },
  }
  const features = new FeatureRegistry({
    rpc: table,
    events,
    credentials: service,
  })
  features.register(createCliAdaptersFeature({ registry }))
  await features.start('cliAdapters')
  t.after(async () => {
    await features.disable('cliAdapters')
    service.deactivate()
  })

  await table.resolve('cli/session/set')!.handler('session/set', { sessionId: 'credential-turn', adapterId: 'codex' })
  for await (const _chunk of listener!({
    sessionId: 'credential-turn',
    messages: [{ role: 'user', content: 'Use @[Secrets](codingns-credential:secrets)' }],
  }, async function* () {})) {}

  assert.deepEqual(received?.runtimeEnv, { CREDENTIAL_APIKEY: 'test-token-value' })
  assert.match(received?.prompt ?? '', /CREDENTIAL_APIKEY/u)
  assert.match(received?.prompt ?? '', /process environment/u)
  assert.doesNotMatch(received?.prompt ?? '', /bnjwxkdg/u)
})

test('credential list pages filter metadata without exposing values', async () => {
  const service = new CredentialService({ store: new InMemoryCredentialStore() })
  service.activate()
  await service.save({ id: 'github', label: 'GitHub', fields: { token: 'secret-one' } })
  await service.save({ id: 'gitlab', label: 'GitLab', fields: { token: 'secret-two' } })
  assert.deepEqual((await service.listPage({ query: 'git' })).items.map((item) => item.id), ['github', 'gitlab'])
  assert.doesNotMatch(JSON.stringify(await service.listPage({ query: 'github' })), /secret-one|secret-two/u)
})

test('master password stores only a verifier and requires the current password to rotate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-master-password-'))
  const service = new CredentialService({
    store: new InMemoryCredentialStore(),
    masterPasswordPath: join(root, 'credentials.password'),
  })
  service.activate()
  assert.deepEqual(await service.masterPasswordStatus(), { configured: false })
  await service.setMasterPassword({ password: 'first-password' })
  assert.deepEqual(await service.masterPasswordStatus(), { configured: true })
  await assert.rejects(
    service.setMasterPassword({ currentPassword: 'wrong-password', password: 'second-password' }),
    (error) => error instanceof CodingNsRpcError && error.code === 'CREDENTIAL_MASTER_PASSWORD_INVALID',
  )
  await service.setMasterPassword({ currentPassword: 'first-password', password: 'second-password' })
  assert.doesNotMatch(await readFile(join(root, 'credentials.password'), 'utf8'), /first-password|second-password/u)
})

test('operation-menu credential and delegation selection can consume a bare slash', () => {
  assert.deepEqual(bareSlashSpanAtCaret('/', 7, { start: 1, end: 1 }), { start: 0, end: 1, draftRev: 7 })
  assert.deepEqual(bareSlashSpanAtCaret('hello /', 9, { start: 7, end: 7 }), { start: 6, end: 7, draftRev: 9 })
  assert.equal(bareSlashSpanAtCaret('/path', 1, { start: 5, end: 5 }), undefined)
  assert.equal(bareSlashSpanAtCaret('text/', 1, { start: 5, end: 5 }), undefined)
})

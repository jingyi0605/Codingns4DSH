import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { promisify } from 'node:util'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { ChildProcess } from 'node:child_process'
import { CredentialBroker } from '../data/build/dist/host/credentials/broker.js'
import { CredentialService } from '../data/build/dist/host/credentials/service.js'
import { InMemoryCredentialStore } from '../data/build/dist/host/credentials/store.js'

const execFileAsync = promisify(execFile)

async function createBroker(options: {
  readonly now?: () => number
  readonly requestTtlMs?: number
  readonly cleanupIntervalMs?: number
  readonly spawn?: typeof import('node:child_process').spawn
} = {}) {
  const service = new CredentialService({ store: new InMemoryCredentialStore() })
  service.activate()
  await service.save({
    id: 'ssh',
    label: 'SSH',
    fields: {
      username: 'root',
      password: 'secret-value',
    },
  })
  const broker = new CredentialBroker({ service, ...options, cleanupIntervalMs: options.cleanupIntervalMs ?? 60_000 })
  await broker.activate()
  return { service, broker }
}

test('credential request codes and handles are reusable only within their owning session', async (t) => {
  const { service, broker } = await createBroker()
  t.after(async () => { await broker.deactivate(); service.deactivate() })

  const issued = await broker.issue({ sessionId: 'session-a', credentialId: 'ssh' })
  const secondIssued = await broker.issue({ sessionId: 'session-a', credentialId: 'ssh' })
  assert.notEqual(secondIssued.requestCode, issued.requestCode)
  const description = broker.describeRequest('session-a', issued.requestCode)
  assert.notEqual(description.handle, '')
  assert.equal(broker.describeRequest('session-a', issued.requestCode).handle, description.handle)
  assert.equal(description.bindings[0]?.env, 'CREDENTIAL_USERNAME')
  assert.doesNotMatch(JSON.stringify(description), /secret-value/u)
  assert.throws(() => broker.describeRequest('session-b', issued.requestCode), /another session/u)
  assert.throws(() => broker.describeHandle('session-b', description.handle), /another session/u)

  const first = await broker.executeRequest({ sessionId: 'session-a', handle: description.handle, argv: [process.execPath, '-e', 'process.stdout.write(process.env.CREDENTIAL_USERNAME)'] })
  const second = await broker.executeRequest({ sessionId: 'session-a', requestCode: issued.requestCode, argv: [process.execPath, '-e', 'process.stdout.write(process.env.CREDENTIAL_USERNAME)'] })
  assert.equal(first.stdout, 'root')
  assert.equal(second.stdout, 'root')
})

test('SSH askpass is configured from the session binding without putting the secret in argv', async (t) => {
  if (process.platform === 'win32') return t.skip('OpenSSH askpass process replay is Unix-specific')
  const { service, broker } = await createBroker()
  t.after(async () => { await broker.deactivate(); service.deactivate() })

  const issued = await broker.issue({ sessionId: 'ssh-askpass', credentialId: 'ssh' })
  const handle = broker.describeRequest('ssh-askpass', issued.requestCode).handle
  const result = await broker.executeRequest({
    sessionId: 'ssh-askpass',
    handle,
    argv: [process.execPath, '-e', [
      'const { spawnSync } = require("node:child_process");',
      'const result = spawnSync(process.env.SSH_ASKPASS, [], { encoding: "utf8", env: process.env });',
      'process.stdout.write(JSON.stringify({ value: result.stdout.trim(), required: process.env.SSH_ASKPASS_REQUIRE, identityAgent: process.env.SSH_AUTH_SOCK }));',
    ].join(' ')],
  })

  const askpassResult = JSON.parse(result.stdout) as { readonly value: string; readonly required: string }
  assert.equal(askpassResult.value, 'secret-value')
  assert.equal(askpassResult.required, 'force')
})

test('codingns-credential describe and exec use the Host broker without exposing values in describe', async (t) => {
  const { service, broker } = await createBroker()
  t.after(async () => { await broker.deactivate(); service.deactivate() })

  const issued = await broker.issue({ sessionId: 'session-cli', credentialId: 'ssh' })
  const processEnvironment = broker.processEnvironment('session-cli')
  const env = {
    ...process.env,
    CODINGNS_CREDENTIAL_BROKER_ENDPOINT: processEnvironment.endpoint,
    CODINGNS_CREDENTIAL_BROKER_TOKEN: processEnvironment.token,
    CODINGNS_CREDENTIAL_SESSION: processEnvironment.sessionId,
    PATH: processEnvironment.path,
  }
  const described = await execFileAsync('codingns-credential', ['describe', '--code', issued.requestCode], { env })
  assert.match(described.stdout, /CREDENTIAL_USERNAME/u)
  assert.doesNotMatch(described.stdout, /secret-value/u)
  const handle = JSON.parse(described.stdout).handle as string
  const executed = await execFileAsync('codingns-credential', [
    'exec',
    '--handle',
    handle,
    '--',
    process.execPath,
    '-e',
    'process.stdout.write(`${process.env.CREDENTIAL_USERNAME}:${process.env.CREDENTIAL_PASSWORD}`)',
  ], { env })
  assert.equal(executed.stdout, 'root:secret-value')
})

test('credential broker expires request codes and revokes deleted credentials', async (t) => {
  let now = 10_000
  const { service, broker } = await createBroker({ now: () => now, cleanupIntervalMs: 1_000 })
  t.after(async () => { await broker.deactivate(); service.deactivate() })

  const issued = await broker.issue({ sessionId: 'session-a', credentialId: 'ssh' })
  assert.equal(Date.parse(issued.expiresAt), now + 8 * 60 * 60 * 1000)
  const expiredHandle = broker.describeRequest('session-a', issued.requestCode).handle
  now += 8 * 60 * 60 * 1000
  assert.throws(() => broker.describeRequest('session-a', issued.requestCode), /expired/u)
  assert.throws(() => broker.describeHandle('session-a', expiredHandle), /expired/u)
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  assert.throws(() => broker.describeRequest('session-a', issued.requestCode), /invalid/u)
  assert.throws(() => broker.describeHandle('session-a', expiredHandle), /invalid/u)

  now = 20_000
  const next = await broker.issue({ sessionId: 'session-a', credentialId: 'ssh' })
  const handle = broker.describeRequest('session-a', next.requestCode).handle
  await service.delete('ssh')
  await assert.rejects(
    broker.executeRequest({ sessionId: 'session-a', handle, argv: ['node', '-e', ''] }),
    /Credential not found/u,
  )
})

test('credential broker cleans expired child processes', async (t) => {
  let now = 10_000
  let killed = false
  const fakeSpawn = (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: () => boolean
      once: ChildProcess['once']
    }
    child.stdout = Readable.from([])
    child.stderr = Readable.from([])
    child.kill = () => {
      killed = true
      child.emit('close', null, 'SIGTERM')
      return true
    }
    return child as unknown as ChildProcess
  }) as unknown as typeof import('node:child_process').spawn
  const { service, broker } = await createBroker({ now: () => now, requestTtlMs: 1_000, spawn: fakeSpawn })
  t.after(async () => { await broker.deactivate(); service.deactivate() })

  const issued = await broker.issue({ sessionId: 'session-a', credentialId: 'ssh' })
  const running = broker.executeRequest({ sessionId: 'session-a', requestCode: issued.requestCode, argv: ['node', '-e', ''] })
  await new Promise((resolve) => setImmediate(resolve))
  now += 1_001
  broker.cleanup()
  await running
  assert.equal(killed, true)
})

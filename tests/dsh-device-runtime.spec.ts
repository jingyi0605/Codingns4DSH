import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryDshDeviceCredentialStore,
  startDshHostDeviceRuntime,
} from '../data/build/dist/host/index.js'
import type { HostDtlsIdentityMaterial } from '../data/build/dist/host/index.js'
import { SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'

const identity: HostDtlsIdentityMaterial = {
  privateKeyPem: 'private',
  certPem: 'certificate',
  signatureHash: { signature: 1, hash: 2 },
  fingerprint: 'sha-256 AA:BB',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
}

function ticket(bindingId = 'dsh-device-1') {
  return {
    ticket: 'dsh-ticket',
    expiresAt: '2099-01-01T00:00:00.000Z',
    signalingBaseUrl: 'https://relay.example.com/base',
    iceServers: [],
    iceTransportPolicy: 'all' as const,
    hostDtlsFingerprint: identity.fingerprint,
    bindingId,
    tunnelDomain: `${bindingId}.example.com`,
    trafficRemainingBytes: '0',
    credentialVersion: 1,
  }
}

test('DSH Host 首次启动注册独立设备并保存 device credential', async () => {
  const calls: string[] = []
  let registrationRequest: Record<string, unknown> | null = null
  let heartbeatDetails: Record<string, unknown> | undefined
  let closedSockets = 0
  let serverDevicePresent = true
  let registrationCount = 0
  let activeDeviceId = 'dsh-device-1'
  const store = new InMemoryDshDeviceCredentialStore()
  const control = {
    async registerDshDevice(_accessToken: string, request: Record<string, unknown>) {
      calls.push('register')
      registrationCount += 1
      activeDeviceId = `dsh-device-${registrationCount}`
      registrationRequest = request
      return {
        device: {
          dshDeviceId: activeDeviceId, deviceId: activeDeviceId, displayName: 'DSH Host', protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'],
          dtlsFingerprint: identity.fingerprint, tunnelDomain: `${activeDeviceId}.example.com`, status: 'active' as const,
          online: true, lastHeartbeatAt: null, createdAt: identity.createdAt, updatedAt: identity.updatedAt,
        },
        deviceCredential: `secret-device-credential-${registrationCount}`,
        credentialVersion: 1,
      }
    },
    async listDshDevices() { calls.push('list'); return { devices: serverDevicePresent ? [{ dshDeviceId: 'dsh-device-1', deviceId: 'dsh-device-1', displayName: 'DSH Host', protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'], dtlsFingerprint: identity.fingerprint, tunnelDomain: 'dsh-device-1.example.com', status: 'active' as const, online: false, lastHeartbeatAt: null, createdAt: identity.createdAt, updatedAt: identity.updatedAt }] : [] } },
    async heartbeatDshDevice(_accessToken: string, _deviceId: string, _credential: string, details?: Record<string, unknown>) { calls.push('heartbeat'); heartbeatDetails = details; return { device: {} as never, credentialVersion: 1 } },
    async createDshRelayTicket() { calls.push('ticket'); return { ...ticket(activeDeviceId), product: 'codingns4dsh' as const, dshDeviceId: activeDeviceId } },
  }
  const signalingSocketFactory = async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const socket = {
      readyState: 1,
      send(_data: string) {
        queueMicrotask(() => {
          for (const listener of listeners.get('message') ?? []) listener(new MessageEvent('message', { data: JSON.stringify({ type: 'registered', role: 'host', bindingId: activeDeviceId, sessionId: null }) }))
        })
      },
      close() { closedSockets += 1 },
      addEventListener(type: string, listener: (event: Event) => void) {
        const current = listeners.get(type) ?? new Set()
        current.add(listener)
        listeners.set(type, current)
        if (type === 'message') queueMicrotask(() => listener(new MessageEvent('message', { data: JSON.stringify({ type: 'registered', role: 'host', bindingId: activeDeviceId, sessionId: null }) })))
      },
      removeEventListener(type: string, listener: (event: Event) => void) { listeners.get(type)?.delete(listener) },
    }
    return socket
  }
  const runtime = await startDshHostDeviceRuntime({
    controlClient: control,
    accessToken: 'access',
    credentialStore: store,
    dtlsStore: { read: async () => identity, write: async () => undefined },
    profileName: 'stage0',
    signalingSocketFactory,
    heartbeatIntervalMs: 0,
  } as never)
  assert.equal(runtime.credential.deviceId, 'dsh-device-1')
  assert.equal(registrationRequest?.dshVersion, `${SUPPORTED_DSH_VERSION} (配置: stage0)`)
  assert.equal(typeof registrationRequest?.computerName, 'string')
  assert.equal(heartbeatDetails?.dshVersion, `${SUPPORTED_DSH_VERSION} (配置: stage0)`)
  assert.equal(typeof heartbeatDetails?.computerName, 'string')
  assert.equal(heartbeatDetails?.dtlsFingerprint, identity.fingerprint)
  assert.equal((await store.read())?.deviceCredential, 'secret-device-credential-1')
  assert.deepEqual(calls.slice(0, 3), ['register', 'heartbeat', 'ticket'])
  const replacement = await startDshHostDeviceRuntime({
    controlClient: control,
    accessToken: 'access',
    credentialStore: store,
    dtlsStore: { read: async () => identity, write: async () => undefined },
    profileName: 'stage0',
    signalingSocketFactory,
    heartbeatIntervalMs: 0,
  } as never)
  assert.equal(closedSockets, 1)
  await runtime.stop()
  await replacement.stop()

  serverDevicePresent = false
  const reregistered = await startDshHostDeviceRuntime({
    controlClient: control,
    accessToken: 'access',
    credentialStore: store,
    dtlsStore: { read: async () => identity, write: async () => undefined },
    profileName: 'stage0',
    signalingSocketFactory,
    heartbeatIntervalMs: 0,
  } as never)
  assert.equal(registrationCount, 2)
  assert.equal(reregistered.credential.deviceId, 'dsh-device-2')
  assert.equal((await store.read())?.deviceCredential, 'secret-device-credential-2')
  await reregistered.stop()
})

test('DSH 设备凭据被服务端撤销时不会绕过控制策略重新注册', async () => {
  const calls: string[] = []
  const store = new InMemoryDshDeviceCredentialStore()
  await store.write({
    deviceId: 'dsh-device-old',
    deviceCredential: 'stale-credential',
    credentialVersion: 1,
    dtlsFingerprint: identity.fingerprint,
    tunnelDomain: 'dsh-device-old.example.com',
    displayName: 'DSH Host',
    savedAt: identity.createdAt,
  })
  const control = {
    async registerDshDevice() {
      calls.push('register')
      return {
        device: {
          dshDeviceId: 'dsh-device-new', deviceId: 'dsh-device-new', displayName: 'DSH Host', protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'],
          dtlsFingerprint: identity.fingerprint, tunnelDomain: 'dsh-device-new.example.com', status: 'active' as const,
          online: true, lastHeartbeatAt: null, createdAt: identity.createdAt, updatedAt: identity.updatedAt,
        },
        deviceCredential: 'fresh-credential',
        credentialVersion: 2,
      }
    },
    async listDshDevices() {
      calls.push('list')
      return { devices: [{
        dshDeviceId: 'dsh-device-old', deviceId: 'dsh-device-old', displayName: 'DSH Host', protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'],
        dtlsFingerprint: identity.fingerprint, tunnelDomain: 'dsh-device-old.example.com', status: 'active' as const,
        online: false, lastHeartbeatAt: null, createdAt: identity.createdAt, updatedAt: identity.updatedAt,
      }] }
    },
    async heartbeatDshDevice(_accessToken: string, _deviceId: string, credential: string) {
      calls.push(`heartbeat:${credential}`)
      if (credential === 'stale-credential') {
        throw Object.assign(new Error('credential revoked'), { status: 403, errorCode: 'DSH_DEVICE_CREDENTIAL_INVALID' })
      }
      return { device: {} as never, credentialVersion: 2 }
    },
    async createDshRelayTicket() {
      calls.push('ticket')
      return { ...ticket('dsh-device-new'), product: 'codingns4dsh' as const, dshDeviceId: 'dsh-device-new' }
    },
  }
  await assert.rejects(() => startDshHostDeviceRuntime({
    controlClient: control,
    accessToken: 'access',
    credentialStore: store,
    dtlsStore: { read: async () => identity, write: async () => undefined },
    heartbeatIntervalMs: 0,
  } as never), /credential revoked/u)
  assert.deepEqual(calls, ['list', 'heartbeat:stale-credential'])
  assert.equal((await store.read())?.deviceCredential, 'stale-credential')
})

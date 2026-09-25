import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InMemoryDshDeviceCredentialStore,
  startDshHostDeviceRuntime,
} from '../data/build/dist/host/index.js'
import type { HostDtlsIdentityMaterial } from '../data/build/dist/host/index.js'

const identity: HostDtlsIdentityMaterial = {
  privateKeyPem: 'private',
  certPem: 'certificate',
  signatureHash: { signature: 1, hash: 2 },
  fingerprint: 'sha-256 AA:BB',
  createdAt: '2026-09-23T00:00:00.000Z',
  updatedAt: '2026-09-23T00:00:00.000Z',
}

function ticket() {
  return {
    ticket: 'dsh-ticket',
    expiresAt: '2099-01-01T00:00:00.000Z',
    signalingBaseUrl: 'https://relay.example.com/base',
    iceServers: [],
    iceTransportPolicy: 'all' as const,
    hostDtlsFingerprint: identity.fingerprint,
    bindingId: 'dsh-device-1',
    tunnelDomain: 'dsh-device-1.example.com',
    trafficRemainingBytes: '0',
    credentialVersion: 1,
  }
}

test('DSH Host 首次启动注册独立设备并保存 device credential', async () => {
  const calls: string[] = []
  let closedSockets = 0
  const store = new InMemoryDshDeviceCredentialStore()
  const control = {
    async registerDshDevice() {
      calls.push('register')
      return {
        device: {
          dshDeviceId: 'dsh-device-1', deviceId: 'dsh-device-1', displayName: 'DSH Host', protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'],
          dtlsFingerprint: identity.fingerprint, tunnelDomain: 'dsh-device-1.example.com', status: 'active' as const,
          online: true, lastHeartbeatAt: null, createdAt: identity.createdAt, updatedAt: identity.updatedAt,
        },
        deviceCredential: 'secret-device-credential',
        credentialVersion: 1,
      }
    },
    async listDshDevices() { calls.push('list'); return { devices: [] } },
    async heartbeatDshDevice() { calls.push('heartbeat'); return { device: {} as never, credentialVersion: 1 } },
    async createDshRelayTicket() { calls.push('ticket'); return { ...ticket(), product: 'dsh-codingns' as const, dshDeviceId: 'dsh-device-1' } },
  }
  const signalingSocketFactory = async () => {
    const listeners = new Map<string, Set<(event: Event) => void>>()
    const socket = {
      readyState: 1,
      send(_data: string) {
        queueMicrotask(() => {
          for (const listener of listeners.get('message') ?? []) listener(new MessageEvent('message', { data: JSON.stringify({ type: 'registered', role: 'host', bindingId: 'dsh-device-1', sessionId: null }) }))
        })
      },
      close() { closedSockets += 1 },
      addEventListener(type: string, listener: (event: Event) => void) {
        const current = listeners.get(type) ?? new Set()
        current.add(listener)
        listeners.set(type, current)
        if (type === 'message') queueMicrotask(() => listener(new MessageEvent('message', { data: JSON.stringify({ type: 'registered', role: 'host', bindingId: 'dsh-device-1', sessionId: null }) })))
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
    signalingSocketFactory,
    heartbeatIntervalMs: 0,
  } as never)
  assert.equal(runtime.credential.deviceId, 'dsh-device-1')
  assert.equal((await store.read())?.deviceCredential, 'secret-device-credential')
  assert.deepEqual(calls.slice(0, 3), ['register', 'heartbeat', 'ticket'])
  const replacement = await startDshHostDeviceRuntime({
    controlClient: control,
    accessToken: 'access',
    credentialStore: store,
    dtlsStore: { read: async () => identity, write: async () => undefined },
    signalingSocketFactory,
    heartbeatIntervalMs: 0,
  } as never)
  assert.equal(closedSockets, 1)
  await runtime.stop()
  await replacement.stop()
})

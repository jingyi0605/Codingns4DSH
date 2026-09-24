import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseDshDevice, resolveDshHostScope } from '../data/build/dist/client/dsh-h5-bootstrap.js'

const devices = {
  devices: [
    { dshDeviceId: 'offline', displayName: '离线 Host', status: 'active' as const, online: false, lastHeartbeatAt: null, protocolVersion: 'dsh-envelope-v1', capabilities: [], dtlsFingerprint: '', createdAt: '', updatedAt: '' },
    { dshDeviceId: 'online', displayName: '在线 Host', status: 'active' as const, online: true, lastHeartbeatAt: null, protocolVersion: 'dsh-envelope-v1', capabilities: ['rpc'], dtlsFingerprint: '', createdAt: '', updatedAt: '' },
  ],
}

test('H5 默认选择在线的 DSH Host，拒绝离线或已撤销设备', () => {
  assert.equal(chooseDshDevice(devices)?.dshDeviceId, 'online')
  assert.equal(chooseDshDevice(devices, 'online')?.dshDeviceId, 'online')
  assert.throws(() => chooseDshDevice(devices, 'offline'), /不可用/u)
  assert.throws(() => chooseDshDevice({ devices: [] }), /没有可用/u)
})

test('H5 使用 Ticket 下发的 canonical HostScope，兼容旧 Ticket 时回退 local', () => {
  const base = {
    ticket: 'ticket',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    signalingBaseUrl: 'https://channel.example/signaling',
    iceServers: [],
    iceTransportPolicy: 'all' as const,
    hostDtlsFingerprint: 'SHA256:test',
    bindingId: 'dshdev_test',
    tunnelDomain: 'dshdev_test.dsh-codingns',
    trafficRemainingBytes: '0',
    credentialVersion: 1,
    product: 'dsh-codingns' as const,
    dshDeviceId: 'dshdev_test',
  }
  assert.deepEqual(resolveDshHostScope(base), { hostId: 'dshdev_test', kind: 'local' })
  assert.deepEqual(resolveDshHostScope({ ...base, hostScope: { hostId: 'dshdev_test', kind: 'local' as const } }), { hostId: 'dshdev_test', kind: 'local' })
  assert.throws(() => resolveDshHostScope({ ...base, hostScope: { hostId: 'other', kind: 'local' as const } }), /HostScope/u)
})

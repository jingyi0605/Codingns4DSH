import assert from 'node:assert/strict'
import test from 'node:test'
import { QuickAppsClient } from '../src/client/quick-apps/client.js'

test('Quick Apps uses a native Connection channel with a leading slash', async () => {
  const calls: string[] = []
  const client = new QuickAppsClient({ call: async (channel, endpoint) => {
    if (!/^\/[A-Za-z0-9._~-]+$/u.test(channel)) throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
    calls.push(`${channel}/${endpoint}`)
    return { ok: true, value: [] }
  } })
  await client.call('list')
  await client.call('upsert', { app: { id: 'shortcut' } })
  assert.deepEqual(calls, ['/codingns/quickApps/list', '/codingns/quickApps/upsert'])
})

test('Quick Apps reuses the existing Fetch fallback without retrying ambiguous writes', async () => {
  const calls: string[] = []
  const client = new QuickAppsClient({ call: async (channel, endpoint) => {
    calls.push(`${channel}/${endpoint}`)
    if (channel === '/codingns') throw new Error('HTTP 405')
    assert.equal(channel, '/api')
    return { ok: true, value: [] }
  } })
  await client.call('list'); await client.call('list')
  assert.deepEqual(calls, ['/codingns/quickApps/list', '/api/codingns/quickApps/list', '/api/codingns/quickApps/list'])
  let attempts = 0
  const failing = new QuickAppsClient({ call: async () => { attempts++; throw new Error('timeout') } })
  await assert.rejects(failing.call('upsert', { app: { id: 'shortcut' } }), /timeout/u)
  assert.equal(attempts, 1)
})

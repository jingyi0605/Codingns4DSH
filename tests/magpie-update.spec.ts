import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAGPIE_UPDATE_MINIMUM_VERSION,
  MagpieUpdateError,
  MagpieUpdateService,
  parseMagpieUpdateNotes,
  parseMagpieUpdateStatus,
} from '../src/host/cli-adapters/magpie-update.js'

const latestStatus = {
  state: 'latest',
  current: '0.1.1322',
}

test('Magpie update parsers accept the fixed response shapes and reject malformed fields', () => {
  assert.deepEqual(parseMagpieUpdateStatus({
    ...latestStatus,
    latest: '0.1.1322',
    notes: '',
    url: 'https://github.com/yetone/magpie/releases/tag/v0.1.1322',
    retry: false,
    waiting: false,
    gaveUp: false,
  }), {
    state: 'latest',
    current: '0.1.1322',
    latest: '0.1.1322',
    notes: '',
    url: 'https://github.com/yetone/magpie/releases/tag/v0.1.1322',
    stuck: null,
    error: null,
    retry: false,
    done: null,
    total: null,
    size: null,
    waiting: false,
    gaveUp: false,
  })
  assert.deepEqual(parseMagpieUpdateNotes({
    latest: '0.1.1323',
    releases: [{ version: '0.1.1323', notes: 'Fixes', url: 'https://example.test/release' }],
  }), {
    latest: '0.1.1323',
    releases: [{ version: '0.1.1323', notes: 'Fixes', url: 'https://example.test/release' }],
    error: null,
  })
  assert.throws(() => parseMagpieUpdateStatus({ state: 'latest', current: '0.1.1322', retry: 'yes' }), MagpieUpdateError)
  assert.throws(() => parseMagpieUpdateNotes({ latest: '0.1.1323', releases: [{ version: '0.1.1323', notes: 42 }] }), MagpieUpdateError)
})

test('Magpie update check uses fixed routes and polls until checking finishes', async () => {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = []
  let statusReads = 0
  const service = new MagpieUpdateService({
    version: () => MAGPIE_UPDATE_MINIMUM_VERSION,
    sleep: async () => undefined,
    webApi: {
      async requestJson(path, options = {}) {
        calls.push({ path, method: options.method, body: options.body })
        if (path === '/api/update/check') return { state: 'checking', current: '0.1.1322' }
        if (path === '/api/update') {
          statusReads += 1
          return statusReads === 1
            ? { state: 'checking', current: '0.1.1322' }
            : { state: 'found', current: '0.1.1322', latest: '0.1.1323', notes: 'Fixes', url: 'https://example.test/release' }
        }
        throw new Error(`unexpected route ${path}`)
      },
    },
  })

  const status = await service.checkForUpdate()
  assert.equal(status.state, 'found')
  assert.deepEqual(calls.map(call => [call.method ?? 'GET', call.path]), [
    ['POST', '/api/update/check'],
    ['GET', '/api/update'],
    ['GET', '/api/update'],
  ])
  assert.equal(calls[0]?.body, undefined)
})

test('Magpie install requires explicit confirmation and handles a restart handoff', async () => {
  const calls: Array<{ path: string; method?: string; body?: unknown }> = []
  const service = new MagpieUpdateService({
    version: () => MAGPIE_UPDATE_MINIMUM_VERSION,
    webApi: {
      async requestJson(path, options = {}) {
        calls.push({ path, method: options.method, body: options.body })
        if (path === '/api/update') return { state: 'ready', current: '0.1.1322', latest: '0.1.1323' }
        throw new Error(`unexpected JSON route ${path}`)
      },
      async requestJsonOrNoContent(path, options = {}) {
        calls.push({ path, method: options.method, body: options.body })
        return null
      },
    },
  })

  await assert.rejects(service.installUpdate({ confirmed: false }), (error: unknown) => {
    return error instanceof MagpieUpdateError && error.code === 'CODINGNS_MAGPIE_UPDATE_CONFIRMATION_REQUIRED'
  })
  assert.equal(calls.length, 0, 'unconfirmed install must not call Magpie')

  const result = await service.installUpdate({ confirmed: true })
  assert.deepEqual(result, { requested: true, restartExpected: true, status: null })
  assert.deepEqual(calls, [
    { path: '/api/update', method: undefined, body: undefined },
    { path: '/api/update/install', method: 'POST', body: { view: 'codingns-magpie-management', when: 'now' } },
  ])
})

test('Magpie install accepts a successful acknowledgement while the Web process restarts', async () => {
  const service = new MagpieUpdateService({
    version: () => MAGPIE_UPDATE_MINIMUM_VERSION,
    webApi: {
      async requestJson(path) {
        if (path === '/api/update') return { state: 'found', current: '0.1.1322', latest: '0.1.1323' }
        throw new Error(`unexpected JSON route ${path}`)
      },
      async requestJsonOrNoContent() {
        return { accepted: true }
      },
    },
  })

  const result = await service.installUpdate({ confirmed: true })
  assert.deepEqual(result, { requested: true, restartExpected: true, status: null })
})

test('Magpie background observation never invokes the check or install routes', async () => {
  const paths: string[] = []
  const service = new MagpieUpdateService({
    version: () => MAGPIE_UPDATE_MINIMUM_VERSION,
    webApi: {
      async requestJson(path) {
        paths.push(path)
        return latestStatus
      },
    },
  })

  service.startBackgroundChecks()
  await new Promise<void>(resolve => setImmediate(resolve))
  service.stopBackgroundChecks()
  assert.deepEqual(paths, ['/api/update'])
})

test('Magpie update service fails closed before calling Web API for unsupported versions', async () => {
  let calls = 0
  const service = new MagpieUpdateService({
    version: () => '0.1.1321',
    webApi: { async requestJson() { calls += 1; return latestStatus } },
  })
  await assert.rejects(service.readStatus(), (error: unknown) => {
    return error instanceof MagpieUpdateError && error.code === 'CODINGNS_MAGPIE_UPDATE_UNSUPPORTED'
  })
  assert.equal(calls, 0)
})

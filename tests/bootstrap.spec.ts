import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  bootWithPreCordisTransport,
  installPreCordisTransport,
  CODINGNS_BOOTSTRAP_DSH_VERSION,
} from '../dist/bootstrap/index.js'
import { CODINGNS_DSH_ERROR_CODES, CodingNsDshError } from '../dist/shared/index.js'

const transport = Object.freeze({ ownsHost: true })

test('启动胶水锁定 DSH 版本并登记后可清理 Transport', () => {
  const registration = installPreCordisTransport({
    dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION,
    transport,
  })
  assert.equal((globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__, transport)
  registration.dispose()
  assert.equal((globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__, undefined)
})

test('重复接管和不兼容版本都明确失败', () => {
  const registration = installPreCordisTransport({
    dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION,
    transport,
  })
  try {
    assert.throws(
      () => installPreCordisTransport({ dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION, transport }),
      (error) => error instanceof CodingNsDshError && error.code === CODINGNS_DSH_ERROR_CODES.TRANSPORT_NOT_READY,
    )
    assert.throws(
      () => installPreCordisTransport({ dshVersion: '0.1.7', transport }),
      (error) => error instanceof CodingNsDshError && error.code === CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
    )
  } finally {
    registration.dispose()
  }
})

test('DSH 启动失败时胶水自动撤销全局 Transport', async () => {
  await assert.rejects(
    bootWithPreCordisTransport({
      dshVersion: CODINGNS_BOOTSTRAP_DSH_VERSION,
      transport,
      boot: async () => { throw new Error('boot failed') },
    }),
    /boot failed/u,
  )
  assert.equal((globalThis as typeof globalThis & { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__, undefined)
})

test('启动胶水构建产物不包含 Node 专属模块', async () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '../dist/bootstrap/index.js')
  const source = await readFile(path, 'utf8')
  for (const specifier of ['node:crypto', 'node:fs', 'node:net', 'node:child_process']) {
    assert.equal(source.includes(specifier), false, `启动胶水包含 ${specifier}`)
  }
})

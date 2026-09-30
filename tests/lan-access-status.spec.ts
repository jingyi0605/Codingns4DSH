import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import type { LanAccessDshSnapshot } from '../data/build/dist/shared/contracts/lan-access-dsh.js'
import {
  buildLanAccessUrls,
  formatLanAccessUrl,
  resolveLanAccessStatus,
} from '../data/build/dist/client/features/lan-access-status.js'
import { dshThemeColor } from '../data/build/dist/client/theme.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function snapshot(value: Partial<LanAccessDshSnapshot> = {}): LanAccessDshSnapshot {
  return {
    listenHost: '0.0.0.0',
    listenPort: 13080,
    dshPort: 17890,
    state: 'listening',
    actualListenPort: 13080,
    detectedDshPorts: [],
    error: null,
    loginEnabled: false,
    ...value,
  }
}

test('状态指示器把快照映射成未启动、启动中、运行中与失败四种语义', () => {
  assert.deepEqual(resolveLanAccessStatus(null), {
    state: 'stopped',
    labelKey: 'lan.statusStopped',
    color: dshThemeColor.labelTertiary,
    listening: false,
  })
  assert.deepEqual(resolveLanAccessStatus(snapshot({ state: 'starting' })), {
    state: 'starting',
    labelKey: 'lan.statusStarting',
    color: dshThemeColor.accent,
    listening: false,
  })
  assert.deepEqual(resolveLanAccessStatus(snapshot({ state: 'listening' })), {
    state: 'listening',
    labelKey: 'lan.statusListening',
    color: dshThemeColor.success,
    listening: true,
  })
  assert.deepEqual(resolveLanAccessStatus(snapshot({ state: 'error' })), {
    state: 'error',
    labelKey: 'lan.statusError',
    color: dshThemeColor.error,
    listening: false,
  })
})

test('只有监听中才给出可复制地址，端口取实际绑定端口', () => {
  assert.deepEqual(buildLanAccessUrls(null, ['192.168.1.5']), [])
  assert.deepEqual(buildLanAccessUrls(snapshot({ state: 'starting' }), ['192.168.1.5']), [])
  assert.deepEqual(buildLanAccessUrls(snapshot({ state: 'error' }), ['192.168.1.5']), [])
  // listenPort 为 0 时由系统分配，必须用 actualListenPort，否则复制出来的是错误端口。
  assert.deepEqual(
    buildLanAccessUrls(snapshot({ listenHost: '192.168.1.5', listenPort: 0, actualListenPort: 53124 }), []),
    ['http://192.168.1.5:53124/'],
  )
  // 端口非法时不编造地址。
  assert.deepEqual(buildLanAccessUrls(snapshot({ listenPort: 0, actualListenPort: null }), ['192.168.1.5']), [])
})

test('监听全部网卡时按网卡地址展开，并过滤回环与链路本地地址', () => {
  assert.deepEqual(
    buildLanAccessUrls(snapshot({ listenHost: '0.0.0.0' }), ['0.0.0.0', '127.0.0.1', '::1', '169.254.10.20', 'fe80::1', '192.168.1.5', ' 10.0.0.8 ']),
    ['http://192.168.1.5:13080/', 'http://10.0.0.8:13080/'],
  )
  // 没有可选网卡时退回监听地址，界面上仍能看到端口，而不是整块消失。
  assert.deepEqual(buildLanAccessUrls(snapshot({ listenHost: '0.0.0.0' }), ['0.0.0.0', '127.0.0.1']), ['http://0.0.0.0:13080/'])
  // 监听具体网卡时只给这一个地址，不展开其它网卡。
  assert.deepEqual(buildLanAccessUrls(snapshot({ listenHost: '10.0.0.8' }), ['192.168.1.5']), ['http://10.0.0.8:13080/'])
})

test('IPv6 地址加方括号，避免端口被解析成地址的一部分', () => {
  assert.equal(formatLanAccessUrl('fe80::1', 13080), 'http://[fe80::1]:13080/')
  assert.equal(formatLanAccessUrl('192.168.1.5', 13080), 'http://192.168.1.5:13080/')
  assert.deepEqual(buildLanAccessUrls(snapshot({ listenHost: '::1' }), []), ['http://[::1]:13080/'])
})

test('设置面板用状态指示器与可复制地址替代纯文本转发说明', async () => {
  const source = await readFile(join(root, 'src/client/features/lan-access-panel.ts'), 'utf8')
  assert.match(source, /resolveLanAccessStatus/u)
  assert.match(source, /buildLanAccessUrls/u)
  assert.match(source, /role: 'status'/u)
  assert.match(source, /'aria-live': 'polite'/u)
  assert.match(source, /lan\.copyAddressHint/u)
  assert.match(source, /lan\.copied/u)
  // 旧实现只有一行纯文本转发说明，地址无法复制，也不表达启动状态。
  assert.doesNotMatch(source, /role: 'status', style: dshSettingsNoteStyle/u)

  const locale = await readFile(join(root, 'src/client/locale.ts'), 'utf8')
  assert.match(locale, /'lan\.statusStopped': '未启动'/u)
  assert.match(locale, /'lan\.statusListening': '运行中'/u)
  assert.match(locale, /'lan\.copySuccess': '访问地址已复制'/u)
  assert.doesNotMatch(locale, /'lan\.forwarding': '当前转发/u)
})

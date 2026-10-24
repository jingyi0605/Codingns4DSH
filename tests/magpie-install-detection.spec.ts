import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MagpieInstallDetectionService,
  normalizeCustomCommand,
  parseMagpieVersion,
  type MagpieCliRunResult,
} from '../src/host/cli-adapters/magpie-detection.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { createCodingNsRpcHandler, createCodingNsSettingsRpcHandler } from '../src/host/rpc.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { MagpieInstallDetection } from '../src/shared/contracts/magpie-management.js'
import { magpieManagementFeature } from '../src/client/features/magpie-management.js'
import { cliAdaptersFeature } from '../src/client/features/cli-adapters.js'
import { CodingNsSettingsSection } from '../src/client/settings-section.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'
import { Children, isValidElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { normalizeDetection, readMagpieDetection } from '../src/client/feature-requirement.js'
import { en, zh } from '../src/client/locales/magpie.js'

interface Fixture {
  readonly platform: NodeJS.Platform
  readonly environment: NodeJS.ProcessEnv
  /** 可执行文件：路径 → 已存在的文件。 */
  readonly files?: readonly string[]
  /** 目录项：目录 → 名称列表。 */
  readonly directories?: Readonly<Record<string, readonly string[]>>
  /** 运行结果：入口 → 版本输出。 */
  readonly runs?: Readonly<Record<string, MagpieCliRunResult>>
  readonly pathHit?: string | null
  /** PATH after the Host has read the platform environment; on Windows this models registry PATH. */
  readonly pathEntries?: string
}

const NOW = Date.parse('2026-10-23T00:00:00Z')

/** Windows 环境变量本身就是 Windows 风格路径，因此不走 posix join。 */
const WINDOWS_ENVIRONMENT = {
  USERPROFILE: 'C:\\Users\\dev',
  APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
} as const

/** 宿主登录 Shell 的 PATH 是真实环境；测试固定为空，避免本机安装影响结论。 */
const emptyPath = (): string => ''

function serviceFor(fixture: Fixture): MagpieInstallDetectionService {
  const files = new Set((fixture.files ?? []).map(path => fixture.platform === 'win32' ? path.toLowerCase() : path))
  return new MagpieInstallDetectionService({
    platform: fixture.platform,
    environment: fixture.environment,
    now: () => NOW,
    resolvePath: async () => fixture.pathHit ?? null,
    isExecutable: async path => files.has(fixture.platform === 'win32' ? path.toLowerCase() : path),
    listDirectory: async directory => fixture.directories?.[directory] ?? [],
    pathEntries: () => fixture.pathEntries ?? emptyPath(),
    runVersion: async (command) => {
      const key = fixture.platform === 'win32' ? command.toLowerCase() : command
      const run = Object.entries(fixture.runs ?? {}).find(([entry]) => (fixture.platform === 'win32' ? entry.toLowerCase() : entry) === key)
      return run?.[1] ?? null
    },
  })
}

function okVersion(text: string): MagpieCliRunResult {
  return { status: 0, stdout: text, stderr: '', timedOut: false }
}

test('macOS detection follows the login-shell PATH and reports the Homebrew Magpie version', async () => {
  const service = serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev', PATH: '/usr/bin:/bin' },
    pathHit: '/opt/homebrew/bin/magpie',
    files: ['/opt/homebrew/bin/magpie'],
    runs: { '/opt/homebrew/bin/magpie': okVersion('magpie 0.1.1330\n') },
  })
  const detection = await service.detect()
  assert.deepEqual(detection, {
    installed: true,
    platform: 'macos',
    source: 'path',
    command: '/opt/homebrew/bin/magpie',
    version: '0.1.1330',
    reason: null,
    checkedAt: '2026-10-23T00:00:00.000Z',
  })
  assert.equal(MagpieInstallDetectionService.isUsable(detection), true)
})

test('macOS detection falls back to user bin directories when PATH is not populated by the launcher', async () => {
  const service = serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev' },
    pathHit: null,
    files: ['/Users/dev/.local/bin/magpie'],
    runs: { '/Users/dev/.local/bin/magpie': okVersion('magpie 0.1.1295') },
  })
  const detection = await service.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.source, 'common-location')
  assert.equal(detection.command, '/Users/dev/.local/bin/magpie')
  assert.equal(detection.version, '0.1.1295')
})

test('Windows detection prefers the npm .cmd shim and never treats the extensionless shim as runnable', async () => {
  const service = serviceFor({
    platform: 'win32',
    environment: WINDOWS_ENVIRONMENT,
    pathHit: null,
    directories: {
      'C:\\Users\\dev\\AppData\\Roaming\\npm': ['magpie', 'magpie.cmd', 'magpie.ps1'],
    },
    runs: { 'C:\\Users\\dev\\AppData\\Roaming\\npm\\magpie.cmd': okVersion('magpie 0.1.1330') },
  })
  const detection = await service.detect()
  assert.equal(detection.platform, 'windows')
  assert.equal(detection.installed, true)
  assert.equal(detection.command, 'C:\\Users\\dev\\AppData\\Roaming\\npm\\magpie.cmd', 'the POSIX-style npm shim is skipped in favour of magpie.cmd')
  assert.equal(detection.version, '0.1.1330')
})

test('Windows detection finds a standalone install outside PATH through the common locations', async () => {
  const service = serviceFor({
    platform: 'win32',
    environment: WINDOWS_ENVIRONMENT,
    pathHit: null,
    directories: {
      'C:\\Users\\dev\\AppData\\Local\\pnpm': ['magpie.exe'],
    },
    runs: { 'C:\\Users\\dev\\AppData\\Local\\pnpm\\magpie.exe': okVersion('magpie 0.1.1318') },
  })
  const detection = await service.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.command, 'C:\\Users\\dev\\AppData\\Local\\pnpm\\magpie.exe')
})

test('Windows detection reads the registry-derived PATH and finds the GitHub installer binary', async () => {
  const directory = 'C:\\Users\\dev\\tools\\magpie'
  const service = serviceFor({
    platform: 'win32',
    environment: WINDOWS_ENVIRONMENT,
    pathHit: null,
    pathEntries: `${directory};C:\\Windows\\System32`,
    directories: {
      [directory]: ['magpie-cli-windows-amd64.exe'],
    },
    runs: { [`${directory}\\magpie-cli-windows-amd64.exe`]: okVersion('magpie 0.1.1352') },
  })
  const detection = await service.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.source, 'common-location')
  assert.equal(detection.command, `${directory}\\magpie-cli-windows-amd64.exe`)
  assert.equal(detection.version, '0.1.1352')
})

test('Windows detection checks the official installer user bin directory', async () => {
  const directory = 'C:\\Users\\dev\\.local\\bin'
  const service = serviceFor({
    platform: 'win32',
    environment: WINDOWS_ENVIRONMENT,
    pathHit: null,
    directories: { [directory]: ['magpie.exe'] },
    runs: { [`${directory}\\magpie.exe`]: okVersion('magpie 0.1.1352') },
  })
  const detection = await service.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.command, `${directory}\\magpie.exe`)
  assert.equal(detection.version, '0.1.1352')
})

test('an entry that exists but cannot run is reported as installed-but-unusable', async () => {
  const service = serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev' },
    pathHit: '/usr/local/bin/magpie',
    files: ['/usr/local/bin/magpie'],
    runs: { '/usr/local/bin/magpie': { status: 1, stdout: '', stderr: 'boom', timedOut: false } },
  })
  const detection = await service.detect()
  assert.equal(detection.installed, true)
  assert.equal(detection.version, null)
  assert.equal(detection.reason, 'launch')
  assert.equal(MagpieInstallDetectionService.isUsable(detection), false, 'only a runnable entry with a version may enable the module')
})

test('detection reports missing when neither PATH nor common locations contain Magpie', async () => {
  const service = serviceFor({ platform: 'win32', environment: WINDOWS_ENVIRONMENT, pathHit: null })
  const detection = await service.detect()
  assert.equal(detection.installed, false)
  assert.equal(detection.command, null)
  assert.equal(detection.platform, 'windows')
  assert.equal(MagpieInstallDetectionService.isUsable(detection), false)
})

test('a custom absolute path overrides automatic lookup while invalid input falls back to auto detection', async () => {
  const service = serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev' },
    pathHit: '/opt/homebrew/bin/magpie',
    files: ['/opt/homebrew/bin/magpie', '/Users/dev/tools/magpie'],
    runs: {
      '/Users/dev/tools/magpie': okVersion('magpie 0.2.0'),
      '/opt/homebrew/bin/magpie': okVersion('magpie 0.1.1330'),
    },
  })
  const custom = await service.detect({ commandPath: '/Users/dev/tools/magpie' })
  assert.equal(custom.source, 'custom')
  assert.equal(custom.version, '0.2.0')

  const automatic = await serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev' },
    pathHit: '/opt/homebrew/bin/magpie',
    runs: { '/opt/homebrew/bin/magpie': okVersion('magpie 0.1.1330') },
  }).detect({ commandPath: 'magpie --version; rm -rf /' })
  assert.equal(automatic.source, 'path', 'a bare command or shell fragment is never executed')
  assert.equal(automatic.version, '0.1.1330')
})

test('custom command normalization accepts only absolute file paths', () => {
  assert.equal(normalizeCustomCommand(' /usr/local/bin/magpie '), '/usr/local/bin/magpie')
  assert.equal(normalizeCustomCommand('C:\\Users\\dev\\npm\\magpie.cmd'), 'C:\\Users\\dev\\npm\\magpie.cmd')
  assert.equal(normalizeCustomCommand('\\\\server\\share\\magpie.exe'), '\\\\server\\share\\magpie.exe')
  assert.equal(normalizeCustomCommand('magpie'), null)
  assert.equal(normalizeCustomCommand('/usr/local/bin/magpie --flag'), null)
  assert.equal(normalizeCustomCommand('/usr/local/bin/magpie; whoami'), null)
  assert.equal(normalizeCustomCommand('/usr/local/bin/magpie\n--flag'), null)
  assert.equal(normalizeCustomCommand('   '), null)
  assert.equal(normalizeCustomCommand(''), null)
})

test('version parsing fails closed on unexpected output and non-zero exits', () => {
  assert.equal(parseMagpieVersion(0, 'magpie 0.1.1330\n', ''), '0.1.1330')
  assert.equal(parseMagpieVersion(0, 'magpie v0.1.1330', ''), '0.1.1330')
  assert.equal(parseMagpieVersion(1, 'magpie 0.1.1330', ''), null)
  assert.equal(parseMagpieVersion(0, 'magpie dev-build', ''), null)
  assert.equal(parseMagpieVersion(0, `magpie 0.1.1330 ${'x'.repeat(400)}`, ''), null)
})

test('Host settings reject enabling Magpie management without a usable local install', async () => {
  const writes: unknown[] = []
  const value = { ...DEFAULT_CODINGNS_SETTINGS, modules: {} }
  const provider = {
    writable: true,
    describe: () => [{ ns: 'codingns', revision: 1, value }],
    get: () => value,
    mutate: async (_namespace: string, operations: unknown) => { writes.push(operations) },
  }
  const missing: MagpieInstallDetection = {
    installed: false, platform: 'macos', source: null, command: null, version: null, reason: null, checkedAt: 'now',
  }
  const blocked = createCodingNsSettingsRpcHandler(provider as never, { detectMagpie: async () => missing })
  await assert.rejects(
    blocked('set', { ops: [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }] }),
    (error: unknown) => (error as { code?: string }).code === 'CODINGNS_MAGPIE_NOT_INSTALLED',
  )
  assert.deepEqual(writes, [], 'the rejected write never reaches the settings provider')

  // 关闭（或写入其他模块）不需要探测，避免卸载后无法关闭。
  await blocked('set', { ops: [{ op: 'set', path: ['modules', 'magpieManagement'], value: false }] })
  await blocked('set', { ops: [{ op: 'set', path: ['modules', 'cliAdapters'], value: true }] })
  assert.equal(writes.length, 2)

  const installed: MagpieInstallDetection = { ...missing, installed: true, source: 'path', command: '/opt/homebrew/bin/magpie', version: '0.1.1330' }
  const allowed = createCodingNsSettingsRpcHandler(provider as never, { detectMagpie: async () => installed })
  await allowed('set', { ops: [{ op: 'set', path: ['modules', 'magpieManagement'], value: true }] })
  assert.equal(writes.length, 3, 'a runnable install allows the enable write')
})

test('Magpie detection is a Host RPC available before the module is enabled', async (t) => {
  const table = new CodingNsRpcTable()
  const detection = serviceFor({
    platform: 'darwin',
    environment: { HOME: '/Users/dev' },
    pathHit: '/opt/homebrew/bin/magpie',
    runs: { '/opt/homebrew/bin/magpie': okVersion('magpie 0.1.1330') },
  })
  const settings = { ...DEFAULT_CODINGNS_SETTINGS, modules: { magpieManagement: false } }
  const registry = new FeatureRegistry({ rpc: table, settings: { get: () => settings, watch: () => () => undefined } } as never)
  registry.register(createCliAdaptersFeature({
    registry: new CodingNsCliAdapterRegistry([]),
    magpieDetection: detection,
    // Host 的安装探测在启用后仍会重新探测；测试固定为同一个替身，避免读取真实登录 Shell。
    magpieDetectionOptions: { platform: 'darwin', environment: { HOME: '/Users/dev' }, pathEntries: emptyPath },
  }))
  await registry.start('cliAdapters')
  t.after(() => registry.disable('cliAdapters'))

  const probe = table.resolve('magpie/management/detection')!
  const result = await probe.handler(probe.action, {}) as MagpieInstallDetection
  assert.equal(result.installed, true)
  assert.equal(result.version, '0.1.1330')
  assert.equal(result.command, '/opt/homebrew/bin/magpie')

  // 未启用时，探测之外的 Magpie RPC 仍被拒绝。
  const snapshot = table.resolve('magpie/management/snapshot')!
  await assert.rejects(snapshot.handler(snapshot.action, {}), /disabled/u)

  // 用户手动指定一个不存在的入口：自动探测结果不被复用（否则会误判为已安装）。
  const custom = await probe.handler(probe.action, { commandPath: '/Users/dev/tools/missing-magpie', force: true }) as MagpieInstallDetection
  assert.equal(custom.installed, false, 'a custom path never falls back to the automatic PATH hit')

  // 非绝对路径不是手动入口：请求与注入替身放在同一个对象里也会被忽略，仍按自动探测处理。
  const ignored = await probe.handler(probe.action, {
    commandPath: 'magpie --version',
    platform: 'darwin',
    pathEntries: [],
    environment: {},
  }) as MagpieInstallDetection
  assert.equal(ignored.installed, true)
  assert.notEqual(ignored.command, '/Users/dev/tools/missing-magpie')
})

test('Magpie detection RPC is owner-only on the Connection channel and closed on the legacy fetch route', async () => {
  const table = new CodingNsRpcTable()
  table.register('magpie', async () => ({ ok: true }))
  const owner = { operator: 'operator', browserPeer: 'browser' }
  const handler = createCodingNsRpcHandler(table, { connection: owner })
  const limited = await handler('magpie/management/detection', {}, new AbortController().signal, { principal: { kind: 'session' } })
  assert.equal(limited.ok, false)
  assert.equal(limited.ok === false && limited.error.code, 'CODINGNS_RPC_FORBIDDEN')
})

test('client detection reader maps RPC failures to stable states', async () => {
  const ok = await readMagpieDetection({ rpc: { call: async () => ({ ok: true as const, value: {
    installed: true, platform: 'windows', source: 'path', command: 'C:\\npm\\magpie.cmd', version: '0.1.1330', reason: null, checkedAt: 'now',
  } }) } })
  assert.equal(ok.state, 'ready')

  const missing = await readMagpieDetection({ rpc: { call: async () => ({ ok: true as const, value: {
    installed: false, platform: 'macos', source: null, command: null, version: null, reason: null, checkedAt: 'now',
  } }) } })
  assert.equal(missing.state, 'missing')

  const outdatedHost = await readMagpieDetection({ rpc: { call: async () => ({ ok: false as const, error: { code: 'CODINGNS_RPC_NOT_FOUND', message: 'unknown' } }) } })
  assert.equal(outdatedHost.state, 'unavailable')
  assert.equal(outdatedHost.failure, 'host-rpc-outdated')

  const failedHost = await readMagpieDetection({ rpc: { call: async () => ({ ok: false as const, error: { code: 'X', message: 'host down' } }) } })
  assert.equal(failedHost.state, 'unavailable')
  assert.equal(failedHost.failure, 'host-request-failed')

  assert.equal(normalizeDetection({ installed: 'yes' }), null, 'an unknown payload never counts as installed')
})

test('Magpie install panel ships platform-specific install guidance in both locales', () => {
  // 面板本身依赖 React hook，行为由下面的 requireRender 与设置页测试覆盖；这里只守词典。
  assert.equal(magpieManagementFeature.settingsPanel?.name, 'MagpieInstallPanel')
  for (const key of ['magpie.install.installHelp.macos', 'magpie.install.installHelp.windows', 'magpie.install.installHelp.linux']) {
    assert.equal(typeof en[key], 'string', `${key} has English copy`)
    assert.equal(typeof zh[key], 'string', `${key} has Chinese copy`)
  }
  assert.notEqual(en['magpie.install.installHelp.windows'], en['magpie.install.installHelp.macos'], 'Windows guidance lists its own search locations')
})

test('only the Magpie card reads the install detection; every other card stays free of detection notes', async (t) => {
  const calls: string[] = []
  const registry = new FeatureRegistry({} as never)
  registry.register(cliAdaptersFeature)
  registry.register({
    descriptor: { name: 'sessionTranslation', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'client', ui: { label: 'Session translation', description: 'Translate sessions.', order: 32 } },
    start: () => undefined,
  } as never)
  registry.register(magpieManagementFeature)
  const services = {
    rpc: { call: async (_channel: string, endpoint: string) => { calls.push(endpoint); return { ok: true as const, value: null } } },
    dshVersion: '0.2.1-rc.2',
    locale: { bind: () => (key: string) => key, subscribe: () => () => undefined, getSnapshot: () => ({ revision: 0 }) },
  }
  const settings = {
    subscribe: () => () => undefined,
    getSnapshot: () => ({ status: 'ready', writable: true, value: { ...DEFAULT_CODINGNS_SETTINGS, modules: {} }, revision: 1 }),
  }
  const section = createHookRenderer(CodingNsSettingsSection as never, { settings, registry, services } as never)
  t.after(() => section.dispose())

  const elements = (node: ReactNode): ReactElement<any>[] => isValidElement<{ children?: ReactNode }>(node)
    ? [node as ReactElement<any>, ...Children.toArray((node as ReactElement<any>).props.children).flatMap(elements)]
    : []
  const sectionOutput = elements(section.render() as ReactNode)
  for (const entry of registry.modules().flatMap(module => sectionOutput.find(element => element.props.entry?.module === module) ?? [])) {
    const card = createHookRenderer(entry.type as (props: any) => ReactElement, entry.props)
    try {
      card.render(entry.props)
      const rendered = elements(card.render(entry.props) as ReactNode)
      const note = rendered.find(element => element.props?.['data-codingns-requirement'] !== undefined)
      if (entry.props.entry.module === magpieManagementFeature) {
        assert.ok(note !== undefined, 'the Magpie card explains the detection state before it can be enabled')
        assert.equal(note.props.role, 'status')
      } else {
        assert.equal(note, undefined, `${entry.props.entry.module.descriptor.name} must not render a Magpie detection note`)
      }
    } finally {
      card.dispose()
    }
  }
  // 只有 Magpie 卡片请求探测；其他模块的卡片不发任何与 Magpie 相关的 RPC。
  assert.deepEqual([...new Set(calls)], ['magpie/management/detection'])
})

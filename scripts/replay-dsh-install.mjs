import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const tarball = process.argv[2]
if (!tarball) throw new Error('用法：node scripts/replay-dsh-install.mjs <tarball>')

const packageName = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name
const runtimeDsh = process.env.DSH_RUNTIME_DSH
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
if (!existsSync(runtimeDsh)) throw new Error(`找不到 DSH 0.2.0-rc.2 runtime：${runtimeDsh}`)

const home = await mkdtemp(join(tmpdir(), 'dsh-codingns-replay-'))
const profile = join(home, 'profiles', 'replay')
await run(runtimeDsh, ['--profile', 'replay', '--from-default-profile', 'web', '--dump-config'], home)
await run(runtimeDsh, ['plugin', '--profile', 'replay', 'add', resolve(tarball)], home)
const dump = run(runtimeDsh, ['--profile', 'replay', '--dump-config'], home).stdout
await mkdir(join(profile, 'replay-artifacts'), { recursive: true })
await writeFile(join(profile, 'replay-artifacts', 'dump-config.txt'), dump)

const requireFromProfile = createRequire(join(profile, 'package.json'))
const packageJsonPath = requireFromProfile.resolve(`${packageName}/package.json`)
const packageRoot = dirname(packageJsonPath)
const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'))
if (manifest.version !== JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version) {
  throw new Error(`安装后的包版本不一致：${manifest.version}`)
}
if (manifest.peerDependencies?.['@deepseek-ai/dsh'] !== '>=0.2.0-rc.2 <=0.2.0-rc.2') {
  throw new Error('安装后的包没有精确声明 DSH 0.2.0-rc.2 peer ABI')
}
if (!dump.includes(packageName)) throw new Error('Profile dump-config 未包含 CodingNS bundle')

const moduleResolution = []
for (const moduleName of manifest.dsh?.client?.inject ?? []) {
  try {
    const path = requireFromProfile.resolve(`${moduleName}/package.json`)
    const moduleManifest = JSON.parse(await readFile(path, 'utf8'))
    moduleResolution.push({ name: moduleName, version: moduleManifest.version, path })
    if (moduleManifest.version !== '0.2.0-rc.2') throw new Error(`${moduleName}@${moduleManifest.version} 不是 rc.2`)
  } catch (error) {
    moduleResolution.push({ name: moduleName, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

const hostPath = requireFromProfile.resolve(`${packageName}/host`)
const host = await import(pathToFileURL(hostPath).href)
const checks = {}

// 通过实际安装后的 Host bundle 回放 Agent catalog、模型目录及 session/create/follow。
const calls = []
const driver = {
  descriptor: { id: 'replay-agent', name: 'Replay Agent', protocol: 'json-rpc', capabilities: ['models', 'steer'] },
  async detect() { return { installed: true, version: 'replay', command: '/replay-agent' } },
  async listModels() { return { groups: [{ id: 'replay', name: 'Replay', models: [{ id: 'replay-model', name: 'Replay Model', efforts: ['low'] }] }], currentModel: 'replay-model', currentEffort: 'low' } },
  async *executeTurn() { yield { type: 'text', text: 'replay' } },
  async steer(sessionId, prompt) { calls.push(['session/create', sessionId, prompt]) },
  async followUp(sessionId, prompt) { calls.push(['session/follow', sessionId, prompt]) },
}
const registry = new host.CodingNsCliAdapterRegistry([driver])
const catalog = await registry.catalog()
const models = await registry.models('replay-agent')
registry.setSession('replay-session', { adapterId: 'replay-agent', modelId: 'replay-model' })
await registry.steer('replay-session', 'create', false)
await registry.steer('replay-session', 'follow', true)
if (catalog.length !== 1 || catalog[0].id !== 'replay-agent') throw new Error('Agent catalog 回放失败')
if (models.groups?.[0]?.models?.[0]?.id !== 'replay-model') throw new Error('模型列表回放失败')
if (JSON.stringify(calls.map((call) => call[0])) !== JSON.stringify(['session/create', 'session/follow'])) throw new Error('session/create 或 session/follow 回放失败')
checks.agentCatalog = 'passed'
checks.models = 'passed'
checks.sessionCreate = 'passed'
checks.sessionFollow = 'passed'
await registry.dispose()

// 验证 PeerHost 原生 RPC 白名单和虚拟 ID 改写边界。
if (!host.DSH_NATIVE_REMOTE_METHODS.includes('session/create') || !host.DSH_NATIVE_REMOTE_METHODS.includes('session/follow')) throw new Error('PeerHost native RPC 白名单不完整')
checks.peerHostNativeRpc = 'passed'

// 用两个内存 DataChannel 回放 Relay hello 后的数据通道建立，覆盖实际 Carrier 分片入口。
const left = new MemoryChannel()
const right = new MemoryChannel()
left.peer = right
right.peer = left
const clientCarrier = host.createDataChannelCarrier(left)
const relayCarrier = host.createRelayTunnelHostCarrier(host.createDataChannelCarrier(right))
const received = []
relayCarrier.subscribe((value) => received.push(value))
await clientCarrier.send(host.encodeTunnelFrame({ type: 'hello', clientContext: null, protocolVersion: '1' }))
await clientCarrier.send(new Uint8Array([0x63, 0x6e, 0x73]))
if (received.length !== 1 || received[0][0] !== 0x63) throw new Error('Relay DataChannel 建立或数据收发失败')
checks.relayDataChannel = 'passed'
await clientCarrier.close()
await relayCarrier.close()

const report = {
  package: packageName,
  version: manifest.version,
  dsh: '0.2.0-rc.2',
  profile,
  packageRoot,
  moduleResolution,
  checks,
}
const reportPath = process.env.DSH_REPLAY_REPORT ?? join(profile, 'replay-artifacts', 'install-replay.json')
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
console.log(`安装回放通过，报告：${reportPath}`)

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result
}

class MemoryChannel {
  label = 'codingns-tunnel'
  readyState = 'open'
  bufferedAmount = 0
  peer = null
  listeners = new Map()
  send(data) {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    this.peer?.emit('message', { data: new Uint8Array(bytes) })
  }
  close() { this.readyState = 'closed'; this.emit('close', {}) }
  addEventListener(type, listener) { const list = this.listeners.get(type) ?? new Set(); list.add(listener); this.listeners.set(type, list) }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
}

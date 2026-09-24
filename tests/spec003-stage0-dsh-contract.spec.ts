import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'

async function readProjectFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8')
}

test('阶段 0 锁定 DSH 公共包版本', async () => {
  const packageJson = JSON.parse(await readProjectFile('node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json')) as { version?: unknown }
  const connectionPackageJson = JSON.parse(await readProjectFile('node_modules/@deepseek-ai/dsh-client-connection/package.json')) as { version?: unknown }
  assert.equal(packageJson.version, SUPPORTED_DSH_VERSION)
  assert.equal(connectionPackageJson.version, SUPPORTED_DSH_VERSION)
})

test('阶段 0 记录 Sidebar 正式注册和打开接口', async () => {
  const registry = await readProjectFile('node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts')
  const service = await readProjectFile('node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/types/client/service.d.ts')
  assert.match(registry, /register\(definition: SidebarRightTabDefinition\)/u)
  assert.match(service, /openTab<K extends string>/u)
  assert.match(service, /openTabIn<K extends string>/u)
  assert.match(service, /registerCloseHandler\(kind: string/u)
})

test('阶段 0 区分 Connection Fetch 路由和未确认的 Upgrade 扩展', async () => {
  const hostRpc = await readProjectFile('node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc-host.d.ts')
  assert.match(hostRpc, /get fetch\(\): HostConnectionFetch/u)
  assert.match(hostRpc, /createSharedFetchHandler\(channel: '\/api'\)/u)
  assert.doesNotMatch(hostRpc, /registerUpgrade|upgrade\.register/u)
})

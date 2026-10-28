import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { FileMagpieCommandStore } from '../src/host/cli-adapters/magpie-command-store.js'
import { createCliAdaptersFeature } from '../src/host/cli-adapters/feature.js'
import { CodingNsCliAdapterRegistry } from '../src/host/cli-adapters/registry.js'
import { MagpieWebService } from '../src/host/cli-adapters/magpie-web.js'
import { MagpieUpdateService } from '../src/host/cli-adapters/magpie-update.js'
import { CodingNsRpcTable } from '../src/host/rpc-table.js'
import { FeatureRegistry } from '../src/features/registry.js'
import { DEFAULT_CODINGNS_SETTINGS } from '../src/shared/contracts/config.js'
import type { MagpieInstallDetection } from '../src/shared/contracts/magpie-management.js'

const command = 'D:\\Program Files\\magpie\\magpie-windows-amd64.exe'

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codingns-magpie-command-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.ok(basename(root).startsWith('codingns-magpie-command-'))
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('Magpie command stores persist only the path, isolate Hosts, and clear idempotently', async (t) => {
  const root = await temporaryDirectory(t)
  const file = join(root, 'host-a', 'magpie-command')
  const store = new FileMagpieCommandStore(file)
  assert.equal(await store.read(), null)
  await store.write(command)
  assert.equal(await new FileMagpieCommandStore(file).read(), command)
  assert.equal(await readFile(file, 'utf8'), `${command}\n`)
  assert.equal(await new FileMagpieCommandStore(join(root, 'host-b', 'magpie-command')).read(), null)
  await assert.rejects(store.write('magpie --version'))
  assert.equal(await store.read(), command)
  await store.write('D:\\Other Tools\\magpie.exe')
  assert.deepEqual(await readdir(dirname(file)), ['magpie-command'], 'atomic writes leave no temporary files')
  await store.write(null)
  await store.write(null)
  assert.equal(await new FileMagpieCommandStore(file).read(), null)
})

test('invalid saved commands are ignored and storage errors are not reported as success', async (t) => {
  const root = await temporaryDirectory(t)
  const file = join(root, 'magpie-command')
  await writeFile(file, 'magpie --version; whoami')
  assert.equal(await new FileMagpieCommandStore(file).read(), null)
  const blocked = new FileMagpieCommandStore(join(file, 'not-a-directory'))
  await assert.rejects(blocked.write(command))
})

test('Host restart restores and revalidates the saved path; reset survives restart', async (t) => {
  const root = await temporaryDirectory(t)
  const file = join(root, 'magpie-command')
  let runnable = true
  let automaticAvailable = false
  const starts: (string | null)[] = []
  const calls: string[] = []
  t.mock.method(MagpieWebService.prototype, 'start', async function (this: MagpieWebService) {
    starts.push((this as unknown as { startupCommand: () => string | null }).startupCommand())
  })
  t.mock.method(MagpieUpdateService.prototype, 'startBackgroundChecks', () => {})
  const hosts: FeatureRegistry[] = []
  t.after(async () => { for (const host of hosts) await host.disable('cliAdapters') })
  const automatic = 'C:\\bin\\magpie.exe'
  const startHost = async () => {
    const rpc = new CodingNsRpcTable()
    const host = new FeatureRegistry({
      rpc,
      settings: {
        get: () => ({ ...DEFAULT_CODINGNS_SETTINGS, modules: { magpieManagement: true } }),
        watch: () => () => undefined,
      },
    } as never)
    hosts.push(host)
    host.register(createCliAdaptersFeature({
      registry: new CodingNsCliAdapterRegistry([]),
      magpieCommandStore: new FileMagpieCommandStore(file),
      magpieDetectionOptions: {
        platform: 'win32', environment: {}, pathEntries: () => '',
        resolvePath: async () => automaticAvailable ? automatic : null,
        listDirectory: async () => [],
        runVersion: async path => {
          calls.push(path)
          return (path === command && runnable) || (path === automatic && automaticAvailable)
            ? { status: 0, stdout: 'magpie 0.1.1476', stderr: '', timedOut: false } : null
        },
      },
    }))
    await host.start('cliAdapters')
    const target = rpc.resolve('magpie/management/detection')!
    const detect = (payload = {}) => target.handler(target.action, payload) as Promise<MagpieInstallDetection>
    return { host, detect }
  }
  const first = await startHost()
  assert.equal((await first.detect({ commandPath: command, force: true })).command, command)
  assert.equal(await new FileMagpieCommandStore(file).read(), command)
  await first.host.disable('cliAdapters')
  starts.length = 0
  calls.length = 0

  const second = await startHost()
  assert.ok(calls.includes(command), 'a fresh Host runs the saved executable, not a cached success')
  assert.equal((await second.detect()).command, command)
  assert.ok(starts.includes(command), 'enabled management starts Web using the restored path')
  assert.equal((await second.detect({ commandPath: 'D:\\Missing Tools\\magpie.exe' })).installed, false)
  assert.equal(await new FileMagpieCommandStore(file).read(), command)
  await second.host.disable('cliAdapters')

  runnable = false
  starts.length = 0
  const third = await startHost()
  assert.equal((await third.detect()).installed, false)
  assert.deepEqual(starts, [], 'a removed executable cannot auto-start Web after restart')
  assert.equal(await new FileMagpieCommandStore(file).read(), command, 'a missing executable remains replaceable or clearable')
  assert.equal((await third.detect({ resetCommand: true, force: true })).installed, false)
  assert.equal(await new FileMagpieCommandStore(file).read(), null, 'reset is saved even when auto detection finds nothing')
  await third.host.disable('cliAdapters')

  automaticAvailable = true
  const fourth = await startHost()
  assert.equal((await fourth.detect()).command, automatic)
  assert.equal((await fourth.detect()).source, 'path')
  assert.equal(await new FileMagpieCommandStore(file).read(), null)
})

test('failed persistence rejects the RPC and retains the active automatic detector', async (t) => {
  const rpc = new CodingNsRpcTable()
  const host = new FeatureRegistry({ rpc } as never)
  t.after(() => host.disable('cliAdapters'))
  host.register(createCliAdaptersFeature({
    registry: new CodingNsCliAdapterRegistry([]),
    magpieCommandStore: { read: async () => null, write: async () => { throw new Error('disk failure') } },
    magpieDetectionOptions: {
      platform: 'win32', environment: {}, pathEntries: () => '',
      resolvePath: async () => null, listDirectory: async () => [],
      runVersion: async () => ({ status: 0, stdout: 'magpie 0.1.1476', stderr: '', timedOut: false }),
    },
  }))
  await host.start('cliAdapters')
  const target = rpc.resolve('magpie/management/detection')!
  await assert.rejects(target.handler(target.action, { commandPath: command }), { code: 'CODINGNS_MAGPIE_PATH_STORAGE_FAILED' })
  const detection = await target.handler(target.action, {}) as MagpieInstallDetection
  assert.equal(detection.installed, false)
})

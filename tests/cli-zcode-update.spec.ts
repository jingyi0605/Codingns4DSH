import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { managementMethods, automaticUpdateMethod, type ManagementCommand } from '../src/host/cli-adapters/management-methods.js'
import { CliManagementService } from '../src/host/cli-adapters/management.js'
import { runZcodeUpdate, zcodeUpdateRoot } from '../src/host/cli-adapters/zcode-update.js'
import { readZcodePackagedVersion } from '../src/host/cli-adapters/desktop-app-runtime.js'
import { ZcodeAppServerDriver } from '../src/host/cli-adapters/zcode-driver.js'
import type { CodingNsCliAdapterDescriptor } from '../src/shared/contracts/cli-adapter.js'

const installed = (command: string): CodingNsCliAdapterDescriptor => ({ id: 'zcode', name: 'ZCode', installed: true, enabled: true,
  command, version: '3.14.4', detectionState: 'ready' })
const windowsEntry = 'D:\\Applications with spaces\\ZCode\\resources\\glm\\zcode.cjs'
const updateCommand: ManagementCommand = { file: windowsEntry, args: [], zcodeUpdate: { platform: 'win32', arch: 'x64' } }
const payload = Buffer.from('official package fixture')
function feed(platform = 'win32', checksum = createHash('sha512').update(payload).digest('base64')) {
  return `version: 3.15.3\nfiles:\n  - url: https://cdn-zcode.z.ai/zcode/electron/releases/3.15.3/ZCode.${platform === 'win32' ? 'exe' : 'zip'}\n    sha512: ${checksum}\n    size: ${payload.length}\n`
}
const publisher = (manifest = feed()): typeof fetch => async url => new Response(String(url).includes('/manifest?') ? manifest : payload)

test('ZCode selects the desktop updater only for supported owned bundles, leaving installation and other layouts manual', () => {
  for (const [entry, platform, arch, root] of [
    [windowsEntry, 'win32', 'x64', 'D:\\Applications with spaces\\ZCode'],
    ['C:\\Apps\\Zcode\\resources\\glm\\zcode.cjs', 'win32', 'arm64', 'C:\\Apps\\Zcode'],
    ['C:/Apps/Zcode/resources/glm/zcode.cjs', 'win32', 'x64', 'C:\\Apps\\Zcode'],
    ['/Applications/ZCode.app/Contents/resources/glm/zcode.cjs', 'darwin', 'arm64', '/Applications/ZCode.app'],
  ] as const) {
    assert.equal(zcodeUpdateRoot(entry, platform, arch), root)
    const adapter = installed(entry)
    const methods = managementMethods(adapter, 'update', platform, arch).methods
    assert.equal(automaticUpdateMethod(adapter, methods, platform), 'zcode-desktop')
    assert.ok(methods[0]?.executable)
    assert.equal(methods[0]?.invocation?.file, entry)
  }
  for (const [entry, platform, arch] of [
    ['zcode', 'win32', 'x64'], ['/opt/zcode/resources/glm/zcode.cjs', 'linux', 'x64'],
    ['/opt/homebrew/Caskroom/zcode/3.14.4/ZCode.app/Contents/resources/glm/zcode.cjs', 'darwin', 'arm64'],
    [windowsEntry, 'win32', 'ia32'], ['/tools/zcode', 'darwin', 'x64'],
    ['C:\\Users\\user\\scoop\\apps\\zcode\\current\\resources\\glm\\zcode.cjs', 'win32', 'x64'],
  ] as const) {
    const adapter = installed(entry)
    const methods = managementMethods(adapter, 'update', platform, arch).methods
    assert.ok(methods.every(method => !method.executable))
    assert.equal(automaticUpdateMethod(adapter, methods, platform), undefined)
  }
  assert.ok(managementMethods({ ...installed(windowsEntry), installed: false }, 'install', 'win32', 'x64').methods.every(method => !method.executable))
})

test('Windows update downloads and verifies the official package, retains the location and cleans the temporary installer', async () => {
  const urls: string[] = []
  const commands: ManagementCommand[] = []
  let output = ''
  const code = await runZcodeUpdate(updateCommand, new AbortController().signal, text => { output += text }, async command => {
    commands.push(command)
    assert.notEqual(basename(command.file).toLowerCase(), 'zcode.exe', 'App cleanup must not terminate the installer as a running ZCode process')
    assert.deepEqual(await readFile(command.file), payload)
    return 0
  }, async url => { urls.push(String(url)); return publisher()(url) })
  assert.equal(code, 0)
  assert.match(urls[0]!, /platform=windows-x86_64&channel=1$/u)
  assert.equal(urls.length, 2)
  assert.deepEqual(commands[0]?.args, ['/S', '/D=D:\\Applications with spaces\\ZCode'])
  assert.match(output, /Downloading ZCode 3\.15\.3/u)
  assert.match(output, /100%/u)
  await assert.rejects(access(commands[0]!.file), { code: 'ENOENT' })
})

test('ZCode refuses a corrupt package or untrusted manifest before starting the installer', async () => {
  for (const manifest of [feed('win32', Buffer.alloc(64).toString('base64')), feed().replace('cdn-zcode.z.ai', 'example.test'),
    feed().replace(`size: ${payload.length}`, 'size: 1'), 'version: 3.15.3\nfiles: []\n']) {
    await assert.rejects(runZcodeUpdate(updateCommand, new AbortController().signal, () => {}, async () => assert.fail('Installer must not run'), publisher(manifest)))
  }
})

test('ZCode download cancellation and installer errors propagate without a second install', async () => {
  const controller = new AbortController()
  let downloads = 0
  await assert.rejects(runZcodeUpdate(updateCommand, controller.signal, () => {}, async () => assert.fail('Installer must not run'), async url => {
    if (String(url).includes('/manifest?')) return new Response(feed())
    downloads++
    controller.abort(new Error('cancelled download'))
    return new Response(payload)
  }), /cancelled download/u)
  assert.equal(downloads, 1)
  assert.equal(await runZcodeUpdate(updateCommand, new AbortController().signal, () => {}, async () => 7, publisher()), 7)
})

test('macOS refuses to replace an open ZCode application before downloading', async () => {
  const root = '/Applications/ZCode.app'
  await assert.rejects(runZcodeUpdate({ file: `${root}/Contents/resources/glm/zcode.cjs`, args: [], zcodeUpdate: { platform: 'darwin', arch: 'arm64' } },
    new AbortController().signal, () => {}, async (command, _signal, output) => {
      assert.equal(command.file, '/bin/ps')
      output(`${root}/Contents/MacOS/ZCode\n`)
      return 0
    }, async () => assert.fail('No package should be downloaded while the app is open')), /Close ZCode/u)
})

test('ZCode management goes through maintenance, executes once, and reports the re-detected newer version', async context => {
  let adapter = installed(windowsEntry)
  let locked = false
  let executions = 0
  const service = new CliManagementService({
    async refreshCatalog() { return [adapter] },
    beginMaintenance() { locked = true; return () => { locked = false } },
  }, { platform: 'win32', arch: 'x64', resolveCommand: async command => command, run: async (command, signal, output) => {
    assert.equal(locked, true)
    return runZcodeUpdate(command, signal, output, async () => { executions++; adapter = { ...adapter, version: '3.15.3' }; return 0 }, publisher())
  } })
  context.after(() => service.dispose())
  const plan = await service.plan('zcode', 'update')
  assert.equal(executions, 0, 'preview never downloads or installs')
  assert.equal(plan.automaticMethodId, 'zcode-desktop')
  assert.ok(plan.methods.every(method => !('invocation' in method)))
  service.start({ adapterId: 'zcode', action: 'update', methodId: plan.automaticMethodId, fingerprint: plan.fingerprint })
  for (let i = 0; i < 1000 && service.status()?.state === 'running'; i++) await setImmediate()
  assert.equal(service.status()?.state, 'succeeded', service.status()?.error)
  assert.equal(service.status()?.adapter?.version, '3.15.3')
  assert.equal(executions, 1)
  assert.equal(locked, false)
})

async function writePackage(resources: string, version: string, headerPadding = 0) {
  const metadata = Buffer.from(JSON.stringify({ name: '@zcode/desktop', version }))
  const header = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: metadata.length } }, padding: ' '.repeat(headerPadding) }))
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(header.length + 8, 4)
  prefix.writeUInt32LE(header.length + 4, 8)
  prefix.writeUInt32LE(header.length, 12)
  await writeFile(join(resources, 'app.asar'), Buffer.concat([prefix, header, metadata]))
}

test('installed ZCode version comes from package metadata without launching the desktop app', async context => {
  const resources = await mkdtemp(join(tmpdir(), 'codingns-zcode-version-'))
  context.after(() => rm(resources, { recursive: true, force: true }))
  await writePackage(resources, '3.15.3')
  assert.equal(readZcodePackagedVersion(resources), '3.15.3')
  await writePackage(resources, '3.15.4', 7 * 1024 * 1024)
  assert.equal(readZcodePackagedVersion(resources), '3.15.4', 'current official ASAR indexes exceed 4 MiB')
  await writeFile(join(resources, 'app.asar'), Buffer.from('invalid archive'))
  assert.equal(readZcodePackagedVersion(resources), null)
})

test('macOS management resolves a readable bundled script without executable permission', { skip: process.platform === 'win32' }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-zcode-plan-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const resources = join(directory, 'ZCode.app', 'Contents', 'resources', 'glm')
  await mkdir(resources, { recursive: true })
  const entry = join(resources, 'zcode.cjs')
  await writeFile(entry, '')
  await chmod(entry, 0o644)
  const service = new CliManagementService({ async refreshCatalog() { return [installed(entry)] }, beginMaintenance() { return () => {} } }, { platform: 'darwin', arch: 'arm64' })
  context.after(() => service.dispose())
  assert.equal((await service.plan('zcode', 'update')).automaticMethodId, 'zcode-desktop')
})

test('ZCode re-detection sees replaced desktop metadata instead of a cached runtime', { skip: process.platform !== 'win32' }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-zcode-detect-'))
  const previous = process.env.ProgramFiles
  process.env.ProgramFiles = directory
  const resources = join(directory, 'Zcode.app', 'resources')
  const driver = new ZcodeAppServerDriver({ binaries: ['missing-zcode'], spawnSync: (() => ({ status: 1, stdout: '', stderr: '' })) as never })
  context.after(async () => {
    driver.dispose()
    if (previous === undefined) delete process.env.ProgramFiles
    else process.env.ProgramFiles = previous
    await rm(directory, { recursive: true, force: true })
  })
  await mkdir(join(resources, 'glm'), { recursive: true })
  await writeFile(join(resources, 'glm', 'zcode.cjs'), '')
  await writePackage(resources, '3.14.4')
  assert.equal((await driver.detect()).version, '3.14.4')
  await writePackage(resources, '3.15.3')
  assert.equal((await driver.detect()).version, '3.15.3')
})

test('macOS update stages the official archive and replaces the same app bundle', { skip: process.platform === 'win32' }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-zcode-mac-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'Zcode.app')
  const suffix = join('Contents', 'resources', 'glm')
  await mkdir(join(root, suffix), { recursive: true })
  await writeFile(join(root, suffix, 'zcode.cjs'), 'old')
  const result = await runZcodeUpdate({ file: join(root, suffix, 'zcode.cjs'), args: [], zcodeUpdate: { platform: 'darwin', arch: 'arm64' } },
    new AbortController().signal, () => {}, async command => {
      if (command.file === '/bin/ps') return 0
      assert.equal(command.file, '/usr/bin/ditto')
      if (command.args[0] === '-x') {
        const target = join(command.args[3]!, 'ZCode.app', suffix)
        await mkdir(target, { recursive: true })
        await writeFile(join(target, 'zcode.cjs'), 'new')
      } else await cp(command.args[0]!, command.args[1]!, { recursive: true })
      return 0
    }, publisher(feed('darwin')))
  assert.equal(result, 0)
  assert.equal(await readFile(join(root, suffix, 'zcode.cjs'), 'utf8'), 'new')
})

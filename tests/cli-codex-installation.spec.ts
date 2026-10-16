import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { detectBinary } from '../src/host/cli-adapters/binary-detection.js'
import { resolveManagementInstallation } from '../src/host/cli-adapters/management-installation.js'
import { CliManagementService } from '../src/host/cli-adapters/management.js'
import { invalidateCommandEnvironment, resolveCommandPath } from '../src/host/cli-adapters/process-utils.js'
import { CliUpdateCheckService } from '../src/host/cli-adapters/update-check.js'
import type { ManagementCommand } from '../src/host/cli-adapters/management-methods.js'
import type { CodingNsCliAdapterDescriptor } from '../src/shared/contracts/cli-adapter.js'

const posix = { skip: process.platform === 'win32' }

async function fixture(context: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codingns-codex-wrapper-')))
  context.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'local/bin'), prefix = join(root, 'npm prefix')
  const wrapper = join(directory, 'codex'), launcher = join(prefix, 'bin/codex')
  const packageRoot = join(prefix, 'lib/node_modules/@openai/codex'), entry = join(packageRoot, 'bin/codex.js')
  await mkdir(directory, { recursive: true })
  await mkdir(join(prefix, 'bin'), { recursive: true })
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(entry, '#!/usr/bin/env node\nthrow new Error("The fixture must never execute");\n', { mode: 0o755 })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }))
  await symlink(entry, launcher)
  const previous = process.env.CODEX_INSTALL_DIR
  process.env.CODEX_INSTALL_DIR = directory
  context.after(() => { if (previous === undefined) delete process.env.CODEX_INSTALL_DIR; else process.env.CODEX_INSTALL_DIR = previous })
  const adapter: CodingNsCliAdapterDescriptor = { id: 'codex', name: 'Codex', installed: true, enabled: true,
    command: wrapper, version: '0.162.1', detectionState: 'ready' }
  return { root, directory, prefix, wrapper, launcher, packageRoot, entry, adapter }
}

async function waitUntil(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (ready()) return
    await delay(5)
  }
  assert.fail('The fixture operation did not finish')
}

test('Codex proxy wrappers retain their npm owner, release channel and proxy setup during updates', posix, async context => {
  const f = await fixture(context)
  const script = `#!/bin/zsh\nset -e\nproxy_env="$HOME/.codex/codex-proxy.env"\nif [[ ! -r "$proxy_env" ]]; then\n  exit 1\nfi\nbuiltin source "$proxy_env"\nexec "${f.launcher}" --no-daemon "$@"\n`
  await writeFile(f.wrapper, script, { mode: 0o755 })
  assert.equal(await resolveManagementInstallation(f.wrapper, '@openai/codex'), f.entry)
  let adapter = f.adapter
  const commands: ManagementCommand[] = []
  const service = new CliManagementService({ refreshCatalog: async () => [adapter], beginMaintenance: () => () => {} }, {
    run: async command => { commands.push(command); adapter = { ...adapter, version: '0.163.0' }; return 0 },
  })
  context.after(() => service.dispose())
  const urls: string[] = []
  const updates = new CliUpdateCheckService({ fetch: async url => { urls.push(String(url)); return Response.json({ version: '0.163.0' }) } })
  context.after(() => updates.dispose())
  updates.refresh([adapter])
  await waitUntil(() => updates.catalog([adapter])[0]!.update?.state !== 'checking')
  assert.deepEqual(urls, ['https://registry.npmjs.org/@openai/codex/latest'])
  assert.equal(updates.catalog([adapter])[0]!.update?.state, 'available')

  const plan = await service.plan('codex', 'update')
  assert.equal(plan.automaticMethodId, 'npm')
  assert.deepEqual(commands, [], 'planning must not execute the wrapper or an installer')
  service.start({ adapterId: 'codex', action: 'update', methodId: 'npm', fingerprint: plan.fingerprint })
  await waitUntil(() => service.status()?.state !== 'running')
  assert.equal(service.status()?.state, 'succeeded')
  assert.deepEqual(commands, [{ file: 'npm', args: ['install', '-g', '@openai/codex@latest', '--prefix', f.prefix] }])
  assert.equal(await readFile(f.wrapper, 'utf8'), script)
})

test('Codex wrappers with dynamic, missing or unverified targets never select a standalone updater', posix, async context => {
  const f = await fixture(context)
  const service = new CliManagementService({ refreshCatalog: async () => [f.adapter], beginMaintenance: () => assert.fail('Must not start maintenance') })
  context.after(() => service.dispose())
  const unknown = join(f.root, 'unknown/codex')
  await mkdir(join(unknown, '..'), { recursive: true })
  await writeFile(unknown, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 })
  for (const script of [
    '#!/bin/zsh\nexec "$CODEX_TARGET" "$@"\n',
    '#!/bin/sh\nexec "$(find-codex)" "$@"\n',
    `#!/bin/sh\nexec '${f.launcher}' "$@" > /dev/null\n`,
    `#!/bin/sh\nexec '${f.root}/missing/codex' "$@"\n`,
    `#!/bin/sh\nexec '${unknown}' "$@"\n`,
    '#!/bin/sh\nexit 1\n',
    '#!/usr/bin/env python3\nprint("codex 0.162.1")\n',
    `#!/bin/sh\n${'#'.repeat(65_536)}\nexec '${f.launcher}' "$@"\n`,
  ]) {
    await writeFile(f.wrapper, script, { mode: 0o755 })
    assert.equal(await resolveManagementInstallation(f.wrapper, '@openai/codex'), null)
    assert.equal((await service.plan('codex', 'update')).automaticMethodId, undefined)
  }
  await writeFile(f.wrapper, `#!/bin/sh\nexec '${f.launcher}' "$@"\n`, { mode: 0o755 })
  await writeFile(join(f.packageRoot, 'package.json'), JSON.stringify({ name: 'unrelated', bin: { codex: 'bin/codex.js' } }))
  assert.equal(await resolveManagementInstallation(f.wrapper, '@openai/codex'), null)
})

test('Codex wrapper cycles stop without executing scripts', posix, async context => {
  const f = await fixture(context)
  const other = join(f.root, 'other/codex')
  await mkdir(join(other, '..'), { recursive: true })
  await writeFile(f.wrapper, `#!/bin/sh\nexec '${other}' "$@"\n`, { mode: 0o755 })
  await writeFile(other, `#!/bin/sh\nexec '${f.wrapper}' "$@"\n`, { mode: 0o755 })
  assert.equal(await resolveManagementInstallation(f.wrapper, '@openai/codex'), null)
})

test('unresolved Codex wrappers clear guessed standalone feeds while other agents retain their release identity', posix, async context => {
  const f = await fixture(context)
  const catalog = [f.adapter, { ...f.adapter, id: 'pi', command: '/custom/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js', version: '0.72.0' }]
  const urls: string[] = []
  const updates = new CliUpdateCheckService({ resolveCommand: async () => null,
    fetch: async url => { urls.push(String(url)); return Response.json({ version: '0.163.0' }) },
  })
  context.after(() => updates.dispose())
  updates.refresh(catalog)
  await waitUntil(() => updates.catalog(catalog).every(adapter => adapter.update?.state !== 'checking'))
  assert.deepEqual(urls.sort(), ['https://registry.npmjs.org/@openai/codex/latest', 'https://registry.npmjs.org/@mariozechner/pi-coding-agent/latest'].sort())
})

test('native Codex launchers still select their recognized standalone location', posix, async context => {
  const f = await fixture(context)
  await writeFile(f.wrapper, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), { mode: 0o755 })
  assert.equal(await resolveManagementInstallation(f.wrapper, '@openai/codex'), f.wrapper)
  const service = new CliManagementService({ refreshCatalog: async () => [f.adapter], beginMaintenance: () => assert.fail('Planning is read-only') })
  context.after(() => service.dispose())
  assert.equal((await service.plan('codex', 'update')).automaticMethodId, 'installer')
})

test('successful POSIX probes retain the executed absolute path after a login-shell PATH change', posix, async context => {
  const f = await fixture(context)
  invalidateCommandEnvironment()
  context.after(() => invalidateCommandEnvironment())
  await writeFile(f.wrapper, '#!/bin/sh\nprintf "codex 0.162.1\\n"\n', { mode: 0o755 })
  const detected = await detectBinary({ binaries: ['codex'], environment: { PATH: f.directory } })
  assert.deepEqual(detected, { installed: true, command: f.wrapper, version: '0.162.1' })
  const loginLookup = (() => ({ status: 0, stdout: `${f.launcher}\n__CODINGNS_PATH__${join(f.prefix, 'bin')}\n`, stderr: '' })) as never
  assert.equal(await resolveCommandPath('codex', loginLookup), f.launcher)
  assert.equal(await resolveCommandPath(detected.command!), f.wrapper, 'update lookup must retain the executable that passed detection')
})

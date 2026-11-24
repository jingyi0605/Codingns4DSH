import assert from 'node:assert/strict'
import type { spawnSync } from 'node:child_process'
import { join, win32 } from 'node:path'
import test from 'node:test'
import { CodexAppServerDriver } from '../data/build/dist/host/cli-adapters/codex-driver.js'
import { codexCliCandidates } from '../data/build/dist/host/cli-adapters/desktop-app-runtime.js'

function fakeProbe(available: ReadonlyMap<string, string>, calls: string[]): typeof spawnSync {
  return ((command: string, args: readonly string[]) => {
    calls.push(command)
    const version = args.includes('--version') ? available.get(command) : undefined
    return { status: version === undefined ? 1 : 0, stdout: version ?? '', stderr: '' }
  }) as typeof spawnSync
}

test('Codex desktop candidates cover current and legacy layouts in both macOS Applications directories', () => {
  const home = '/Users/Fixture With Spaces'
  const candidates = codexCliCandidates('darwin', home)
  assert.equal(candidates[0], 'codex')
  for (const root of ['/Applications', join(home, 'Applications')]) {
    for (const app of ['Codex.app', 'ChatGPT.app']) {
      const resources = join(root, app, 'Contents', 'Resources')
      const launcher = candidates.indexOf(join(resources, 'codex-cli', 'bin', 'codex'))
      const native = candidates.indexOf(join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'))
      const legacy = candidates.indexOf(join(resources, 'codex'))
      assert.ok(launcher > 0 && native > launcher && legacy > native)
    }
  }
  assert.deepEqual(codexCliCandidates('linux', home), ['codex'])
  assert.deepEqual(codexCliCandidates('win32', home), ['codex'])
})

test('Codex keeps a working PATH CLI ahead of desktop fallbacks', async () => {
  const calls: string[] = []
  const driver = new CodexAppServerDriver({
    spawnSync: fakeProbe(new Map([['codex', 'codex-cli 0.170.1']]), calls),
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '0.170.1', command: 'codex' })
  assert.deepEqual(calls.map(command => win32.basename(command)),
    process.platform === 'win32' ? ['powershell.exe', 'codex'] : ['codex'])
})

test('Codex detects the bundled launcher when PATH has no working CLI', {
  skip: process.platform !== 'darwin',
}, async () => {
  const calls: string[] = []
  const launcher = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'
  const driver = new CodexAppServerDriver({
    spawnSync: fakeProbe(new Map([[launcher, 'codex-cli 0.169.0-alpha.11.1']]), calls),
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '0.169.0-alpha.11.1', command: launcher })
  assert.equal(calls[0], 'codex')
})

test('Codex skips an unusable launcher and selects the bundled binary in a user Applications directory', async () => {
  const calls: string[] = []
  const resources = '/Users/Fixture With Spaces/Applications/ChatGPT.app/Contents/Resources'
  const launcher = join(resources, 'codex-cli', 'bin', 'codex')
  const binary = join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex')
  const driver = new CodexAppServerDriver({
    binaries: codexCliCandidates('darwin', '/Users/Fixture With Spaces'),
    spawnSync: fakeProbe(new Map([[launcher, 'not a version'], [binary, 'codex-cli 0.169.0']]), calls),
  })
  assert.deepEqual(await driver.detect(), { installed: true, version: '0.169.0', command: binary })
  assert.ok(calls.indexOf(launcher) >= 0 && calls.indexOf(launcher) < calls.indexOf(binary))
})

test('Codex respects an explicit binary list even when a desktop fallback is available', async () => {
  const calls: string[] = []
  const driver = new CodexAppServerDriver({
    binaries: ['/custom/codex'],
    spawnSync: fakeProbe(new Map([['/Applications/ChatGPT.app/Contents/Resources/codex', 'codex-cli 0.160.0']]), calls),
  })
  const result = await driver.detect()
  assert.equal(result.installed, false)
  assert.equal(result.command, null)
  assert.equal(calls[0], '/custom/codex')
  assert.deepEqual(calls.slice(1).map(command => win32.basename(command)),
    process.platform === 'win32' ? ['where.exe'] : [])
})

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SUPPORTED_DSH_VERSION } from '../data/build/dist/shared/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('package manifest declares the DSH bundle and client entry', () => {
  assert.equal(manifest.name, 'dsh-codingns')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.deepEqual(manifest.dsh.bundle, { patch: './dsh.bundle.patch' })
  assert.deepEqual(manifest.dsh.client, {
    inject: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-conversation',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-sidebar-right',
      '@deepseek-ai/dsh-client-ui-theme',
    ],
    platform: 'web',
    immediately: true,
  })
  assert.equal(manifest.exports['.'].default, './data/build/dist/index.js')
  assert.equal(manifest.exports['./client'].default, './data/build/dist/client/bundle.js')
  assert.equal(manifest.exports['./client/lan-access'].default, './data/build/dist/client/lan-access.js')
  assert.equal(manifest.exports['./host'].default, './data/build/dist/host/index.js')
  assert.equal(manifest.exports['./typert'].default, './data/build/dist/typert.host.js')
  assert.equal(manifest.exports['./typert'].types, './data/build/dist/typert.host.d.ts')
  assert.equal(manifest.exports['./bootstrap'].default, './data/build/dist/bootstrap/index.js')
  assert.equal(manifest.engines.dsh, SUPPORTED_DSH_VERSION)
  assert.equal(manifest.version, manifest.engines.dsh)
  assert.equal(JSON.parse(readFileSync(join(root, 'version.json'), 'utf8')).version, manifest.version)
})

test('bundle patch and example profile use DSH native shapes', async () => {
  const patch = await readFile(join(root, 'dsh.bundle.patch'), 'utf8')
  assert.match(patch, /id: dsh-codingns/u)
  assert.match(patch, /name: dsh-codingns/u)
  assert.match(patch, /id:\s*terminal-controller[\s\S]*?name:\s*'@deepseek-ai\/dsh-api-terminal-controller'[\s\S]*?disabled:\s*true/u)
  assert.match(patch, /id:\s*ui-sidebar-terminal[\s\S]*?name:\s*'@deepseek-ai\/dsh-client-ui-sidebar-terminal'[\s\S]*?disabled:\s*true/u)
  const profile = JSON.parse(await readFile(join(root, 'profile/package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['dsh-codingns'])
  assert.equal(profile.version, manifest.version)
  assert.equal(profile.dependencies['dsh-codingns'], manifest.version)
  assert.equal(profile.engines.dsh, SUPPORTED_DSH_VERSION)
})

test('npm 包声明包含工作区会话 Logo 资产', () => {
  assert.equal(manifest.files.includes('assets/provider-icons/**'), true)
})

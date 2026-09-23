import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('package manifest declares the DSH bundle and client entry', () => {
  assert.equal(manifest.name, 'dsh-codingns')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh.manifestVersion, 1)
  assert.deepEqual(manifest.dsh.bundle, { patch: './dsh.bundle.patch' })
  assert.deepEqual(manifest.dsh.client, {
    inject: [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-renderer',
    ],
    platform: 'web',
    immediately: true,
  })
  assert.equal(manifest.exports['.'].default, './dist/index.js')
  assert.equal(manifest.exports['./client'].default, './dist/client/bundle.js')
  assert.equal(manifest.exports['./client/lan-access'].default, './dist/client/lan-access.js')
  assert.equal(manifest.exports['./host'].default, './dist/host/index.js')
  assert.equal(manifest.exports['./bootstrap'].default, './dist/bootstrap/index.js')
  assert.equal(manifest.engines.dsh, '0.1.6-alpha.2')
})

test('bundle patch and example profile use DSH native shapes', async () => {
  const patch = await readFile(join(root, 'dsh.bundle.patch'), 'utf8')
  assert.match(patch, /id: dsh-codingns/u)
  assert.match(patch, /name: dsh-codingns/u)
  const profile = JSON.parse(await readFile(join(root, 'profile/package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, ['dsh-codingns'])
  assert.equal(profile.dependencies['dsh-codingns'], '0.1.0')
  assert.equal(profile.engines.dsh, '0.1.6-alpha.2')
})

test('npm 包声明包含工作区会话 Logo 资产', () => {
  assert.equal(manifest.files.includes('assets/provider-icons/**'), true)
})

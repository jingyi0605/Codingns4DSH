import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const profile = JSON.parse(readFileSync(new URL('../profile/package.json', import.meta.url), 'utf8'))

test('published DSH boot accepts the plugin and profile on every declared release boundary', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-alpha.1', '0.2.1-alpha.2', '0.2.1-alpha.3',
    '0.2.1-alpha.4', '0.2.1-alpha.5', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1-rc.4', '0.2.1-rc.3']) {
    for (const definition of [manifest, profile]) {
      assert.equal(evaluatePluginCompatibility(definition, {}, version), undefined, `${definition.name} on ${version}`)
    }
  }
})

test('published DSH boot enforces the minimum and accepts newer versions', () => {
  for (const version of ['0.2.0-rc.1']) {
    const issue = evaluatePluginCompatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh': '*' } }, {}, version)
    assert.deepEqual(issue?.requirements, { 'engines.dsh': manifest.engines.dsh })
    assert.equal(issue?.exempted, false)
  }
  for (const version of ['0.2.1', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh': '*' } }, {}, version), undefined)
  }
  assert.equal(evaluatePluginCompatibility({ ...manifest,
    peerDependencies: { '@deepseek-ai/dsh': '0.0.0' },
  }, {}, '0.2.1-rc.3'), undefined)
})

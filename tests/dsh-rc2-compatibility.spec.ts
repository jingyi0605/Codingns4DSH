import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
// The independently published 0.2.2 boot validates the older supported line.
// The 0.2.3 validator is exercised by the real installation replay.
import { evaluatePluginCompatibility } from 'dsh-app-boot-022'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const profile = JSON.parse(readFileSync(new URL('../profile/package.json', import.meta.url), 'utf8'))

test('published DSH boot accepts the plugin and profile on every declared release boundary', () => {
  for (const version of ['0.2.2-alpha.2', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.5', '0.2.3-alpha.1']) {
    for (const definition of [manifest, profile]) {
      assert.equal(evaluatePluginCompatibility(definition, {}, version), undefined, `${definition.name} on ${version}`)
    }
  }
})

test('published DSH boot enforces the minimum and accepts newer versions', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.5', '0.2.1', '0.2.2-alpha.1']) {
    const issue = evaluatePluginCompatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh': '*' } }, {}, version)
    assert.deepEqual(issue?.requirements, { 'engines.dsh': manifest.engines.dsh })
    assert.equal(issue?.exempted, false)
  }
  for (const version of ['0.2.2', '0.3.0-alpha.1', '0.3.0', '1.0.0']) {
    assert.equal(evaluatePluginCompatibility({ ...manifest, peerDependencies: { '@deepseek-ai/dsh': '*' } }, {}, version), undefined)
  }
  assert.equal(evaluatePluginCompatibility({ ...manifest,
    peerDependencies: { '@deepseek-ai/dsh': '0.0.0' },
  }, {}, '0.2.2-rc.5'), undefined)
})

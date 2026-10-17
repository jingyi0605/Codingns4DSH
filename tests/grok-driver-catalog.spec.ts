import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'

function catalogFixture(output: string, cachePath: string) {
  return new GrokBuildDriver({
    binaries: ['fake-grok'], modelCachePath: cachePath,
    spawnSync: ((_command, args) => ({ status: 0, stdout: args?.[0] === 'models' ? output : 'grok 1.0.62', stderr: '' })) as never,
    spawn: (() => {
      const stdout = new PassThrough(), stderr = new PassThrough()
      return { stdout, stderr, stdin: { write(line: string) {
        const request = JSON.parse(line)
        if (!request.id) return
        const result = request.method === 'session/new' ? { sessionId: 'catalog', models: { availableModels: [
          { modelId: 'grok-4.6', name: 'Grok 4.6' }, { modelId: 'custom', name: 'Custom' },
        ] } } : {}
        stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
      } }, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
}

test('Grok uses its fetched native model catalog instead of the initial ACP snapshot', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'codingns-grok-catalog-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cachePath = join(directory, 'models_cache.json')
  writeFileSync(cachePath, JSON.stringify({ models: {
    'grok-4.7-build-fast': { info: { id: 'grok-4.7-build-fast', name: 'Grok Fast', reasoning_efforts: [{ id: 'high' }, { id: 'xhigh' }] } },
    'unavailable': { info: { id: 'unavailable', name: 'Do not advertise', reasoning_efforts: ['high'] } },
  } }))
  const driver = catalogFixture('Default model: grok-4.7-build-fast\nAvailable models:\n  * grok-4.7-build-fast (default)\n  - custom\n', cachePath)
  try {
    const catalog = await driver.listModels()
    assert.equal(catalog.currentModel, 'grok-4.7-build-fast')
    assert.deepEqual(catalog.groups[0]?.models.map(model => model.id), ['provider-default', 'grok-4.7-build-fast', 'custom'])
    assert.deepEqual(catalog.groups[0]?.models[1]?.efforts, ['high', 'xhigh'])
    assert.equal(catalog.groups[0]?.models[2]?.name, 'Custom')
  } finally { driver.dispose() }
})

test('Grok falls back to ACP when the native models command is unavailable or unrecognized', async () => {
  const driver = catalogFixture('unknown command models', '/nonexistent/grok-model-cache')
  try { assert.deepEqual((await driver.listModels()).groups[0]?.models.map(model => model.id), ['grok-4.6', 'custom']) }
  finally { driver.dispose() }
})

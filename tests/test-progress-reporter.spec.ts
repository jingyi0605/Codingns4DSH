import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const reporterPath = fileURLToPath(new URL('../scripts/test-progress-reporter.mjs', import.meta.url))

function runFixture(source: string) {
  const directory = mkdtempSync(join(tmpdir(), 'codingns test progress-'))
  try {
    const reporter = join(directory, 'reporter.mjs')
    const fixture = join(directory, 'fixture.mjs')
    copyFileSync(reporterPath, reporter)
    writeFileSync(fixture, source)
    const env = { ...process.env, NODE_OPTIONS: `--no-warnings --test-reporter="${reporter}"` }
    // Start an independent runner instead of inheriting the parent test worker.
    delete env.NODE_TEST_CONTEXT
    return spawnSync(process.execPath, ['--test', fixture], {
      encoding: 'utf8',
      timeout: 10_000,
      env,
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('packaging reporter shows counts without test names or test output', () => {
  const result = runFixture(`
import test, { describe } from 'node:test'
describe('hidden suite detail', () => {
  test('hidden passing detail', () => {
    console.log('hidden stdout detail')
    console.error('hidden stderr detail')
  })
  test.skip('hidden skipped detail', () => {})
  test.todo('hidden todo detail')
  test('hidden parent detail', async (t) => {
    await t.test('hidden child detail', () => {})
  })
})
`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Tests: 0 completed\nTests: \d+ completed\n/u)
  assert.match(result.stdout, /Tests: 5 \| passed: 3 \| failed: 0 \| cancelled: 0 \| skipped: 1 \| todo: 1/u)
  assert.doesNotMatch(result.stdout + result.stderr, /hidden|Subtest|\u001b/u)
})

test('packaging reporter preserves test failures without printing their details', () => {
  const result = runFixture(`
import test from 'node:test'
test('hidden failing detail', () => { throw new Error('hidden error detail') })
`)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /Tests: 1 \| passed: 0 \| failed: 1/u)
  assert.doesNotMatch(result.stdout + result.stderr, /hidden|Subtest/u)
})

test('packaging reporter includes cancellations in the final counts', () => {
  const result = runFixture(`
import test from 'node:test'
test('hidden parent detail', (t) => {
  t.test('hidden cancelled detail', () => new Promise(() => {}))
})
`)
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /Tests: 2 \| passed: 0 \| failed: 1 \| cancelled: 1/u)
  assert.doesNotMatch(result.stdout + result.stderr, /hidden|Subtest/u)
})

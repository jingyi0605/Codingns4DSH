import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAsyncCommand } from '../src/host/cli-adapters/process-utils.ts'
import { detectBinary } from '../src/host/cli-adapters/binary-detection.ts'

test('Windows 原生 cmd 可以检测含中文、空格和 & 的包装器，并保留参数边界', { skip: process.platform !== 'win32' }, async (t) => {
  // 临时假 CLI 不访问任何安装、用户配置或 Desktop Profile。
  const root = mkdtempSync(join(tmpdir(), 'codingns CLI 中文 & '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const command = join(root, 'probe.cmd')
  writeFileSync(command, '@echo off\r\nif "%~1"=="--version" (echo probe 1.2.3 & exit /b 0)\r\necho [%~1]\r\n', 'utf8')
  assert.deepEqual(await detectBinary({ binaries: [command] }), { installed: true, version: '1.2.3', command })
  const result = await runAsyncCommand(spawnSync, command, ['value with spaces'], { shell: true })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '[value with spaces]')
})

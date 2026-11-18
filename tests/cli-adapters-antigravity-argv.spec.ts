import assert from 'node:assert/strict'
import { spawn, type SpawnOptions } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AntigravityDriver } from '../data/build/dist/host/cli-adapters/antigravity-driver.js'

for (const kind of ['exe', 'cmd', 'bat']) {
  test(`Windows AGY .${kind} 子进程收到完整的工作区、附件目录和 settings 参数`, { skip: process.platform !== 'win32' }, async (context) => {
    const root = mkdtempSync(join(tmpdir(), 'agy-argv-'))
    const exits: Promise<unknown>[] = []
    const cwd = join(root, 'My Project')
    const attachments = join(root, 'Local Files')
    const settings = join(root, 'My Settings.json')
    const entry = join(root, 'echo.cjs')
    const output = join(root, 'argv.json')
    const image = join(attachments, 'image')
    mkdirSync(cwd)
    mkdirSync(attachments)
    writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'))
    writeFileSync(entry, [
      'const args = process.argv.slice(2)',
      `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(args))`,
      "if (args.includes('acp')) {",
      "  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {",
      '    const { id, method } = JSON.parse(line)',
      "    const result = method === 'session/new' ? { sessionId: 'echo' } : method === 'session/prompt' ? { stopReason: 'end_turn' } : {}",
      "    if (id !== undefined) console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))",
      "    if (method === 'session/prompt') process.stdin.destroy()",
      '  })',
      "} else if (args.includes('models')) console.log('magpie/test\\tTest')",
      "else process.stdin.resume().on('end', () => console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'echo', status: 'SUCCESS', response: 'ok' } })))",
    ].join('\n'))
    const binary = kind === 'exe' ? process.execPath : join(root, `agy.${kind}`)
    if (kind !== 'exe') writeFileSync(binary, `@echo off\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`)
    const driver = new AntigravityDriver({
      binaries: ['argv-test-agy'],
      magpieCommand: () => 'fixture-magpie',
      autoUpdater: { check() {}, dispose() {} },
      resolveModelId: () => null,
      resolveContextWindow: () => undefined,
      resolveEffort: () => null,
      spawnSync: ((command: string) => ({ status: 0, stderr: '', stdout: command === 'fixture-magpie'
        ? `model=magpie/test\nsettings=${settings}\nGEMINI_API_KEY=fixture\nGOOGLE_GEMINI_BASE_URL=http://127.0.0.1:1`
        : /where\.exe$/iu.test(command) ? binary : '1.2.3' })) as never,
      spawn: ((command: string, args: string[], options: SpawnOptions) => {
        const child = spawn(command, command === process.execPath ? [entry, ...args] : args, options)
        exits.push(once(child, 'close'))
        return child
      }) as typeof spawn,
    })
    context.after(async () => {
      driver.dispose()
      await Promise.all(exits)
      rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    })
    const argv = () => JSON.parse(readFileSync(output, 'utf8')) as string[]
    const input = { sessionId: 'argv', prompt: 'echo', messages: [], cwd }
    await context.test('stream-json', async () => {
      await Array.fromAsync(driver.executeTurn(input))
      assert.deepEqual(argv(), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--settings', settings, '--add-dir', cwd, '--model', 'magpie/test'])
    })
    await context.test('models', async () => {
      await driver.listModels()
      assert.deepEqual(argv(), ['--settings', settings, 'models'])
    })
    await context.test('image ACP', async () => {
      await Array.fromAsync(driver.executeTurn({ ...input, attachments: [{ kind: 'image', path: image }, { kind: 'file', path: join(attachments, 'notes.txt') }] }))
      assert.deepEqual(argv(), ['--settings', settings, 'acp', '--add-dir', attachments])
    })
  })
}

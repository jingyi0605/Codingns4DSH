import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import type { SpawnOptions } from 'node:child_process'
import { spawnClaudeProcess } from '../data/build/dist/host/cli-adapters/claude-process.js'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { discoverClaudeModelCatalog } from '../data/build/dist/host/cli-adapters/claude-model-options.js'
import { createSubagentBridgeRuntime, setSubagentBridge } from '../data/build/dist/host/cli-bridge/bridge-holder.js'

const mcpConfig = JSON.stringify({ mcpServers: { codingns: {
  command: 'C:\\Program Files\\测试 & 工具\\node.exe',
  args: ['C:\\用户\\桥接\\mcp-stdio-entry.js'],
  env: { CODINGNS_BRIDGE_URL: 'http://127.0.0.1:63216', CODINGNS_BRIDGE_TOKEN: 'test-token', CODINGNS_DSH_SESSION_ID: '测试会话' },
} } })
const prompt = '请使用 "codingns" 工具。\n保留空格、中文、& 和 %PATH%。'

/** 这里只提取生成的文件参数；真正的 cmd 参数解析由 Windows 原生用例验证。 */
function argumentPath(args: readonly string[], flag: string): string {
  const value = args.at(-1)!.match(new RegExp(`${flag} (?:"([^"]+)"|([^ "]+))`))
  assert.ok(value, `缺少 ${flag}`)
  return value[1] ?? value[2]!
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() {
      this.stdin.end(); this.stdout.end(); this.stderr.end()
      this.emit('close', 0)
      return true
    },
  })
  return child
}

test('Windows Claude 包装器使用独立文件，保留 MCP、提示词及空参数并清理', () => {
  const paths: string[] = []
  const children = [fakeChild(), fakeChild()]
  const command = 'C:\\Program Files\\中文 & CLI\\claude.cmd'
  const runSpawn = ((file: string, args: string[], options: SpawnOptions) => {
    assert.equal(file, 'C:\\Windows\\System32\\cmd.exe')
    assert.equal(options.shell, false)
    assert.equal(options.windowsVerbatimArguments, true)
    assert.equal(options.cwd, 'C:\\Code\\GCAC')
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
    assert.ok(args[3]!.startsWith(`""${command}" `))
    assert.ok(args[3]!.includes('--tools "" --strict-mcp-config'))
    assert.doesNotMatch(args[3]!, /mcpServers|test-token|%PATH%|\n/u)
    const configPath = argumentPath(args, '--mcp-config')
    const promptPath = argumentPath(args, '--append-system-prompt-file')
    assert.equal(readFileSync(configPath, 'utf8'), mcpConfig)
    assert.equal(readFileSync(promptPath, 'utf8'), prompt)
    assert.equal(dirname(configPath), dirname(promptPath))
    paths.push(configPath)
    return children[paths.length - 1]
  }) as never
  const args = ['--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig, '--append-system-prompt', prompt, '--disallowedTools', 'Task']
  try {
    for (let index = 0; index < 2; index++) spawnClaudeProcess(command, args, {
      cwd: 'C:\\Code\\GCAC', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }, runSpawn, 'win32')
    assert.notEqual(dirname(paths[0]!), dirname(paths[1]!))
    children[0]!.emit('close', 0)
    assert.equal(existsSync(dirname(paths[0]!)), false)
    assert.equal(existsSync(paths[1]!), true, '结束一个进程不能删除另一个会话的配置')
    children[1]!.emit('error', new Error('spawn ENOENT'))
    children[1]!.emit('close', -1)
    assert.equal(existsSync(dirname(paths[1]!)), false)
    assert.equal(args[3], '--mcp-config', '不能修改调用方 argv')
    assert.equal(args[4], mcpConfig)
  } finally {
    for (const path of paths) rmSync(dirname(path), { recursive: true, force: true })
  }
})

test('Windows Claude 同步启动失败也删除临时配置', () => {
  let configPath = ''
  assert.throws(() => spawnClaudeProcess('claude.cmd', ['--mcp-config', mcpConfig], {}, ((_file: string, args: string[]) => {
    configPath = argumentPath(args, '--mcp-config')
    assert.ok(existsSync(configPath))
    throw new Error('同步启动失败')
  }) as never, 'win32'), /同步启动失败/u)
  assert.equal(existsSync(dirname(configPath)), false)
})

test('原生 exe 和 POSIX Claude 直接传递 argv，已有配置文件不归启动器清理', () => {
  for (const [platform, command] of [['win32', 'C:\\Program Files\\Claude\\claude.exe'], ['darwin', '/opt/claude'], ['linux', '/usr/bin/claude']] as const) {
    const args = ['--mcp-config', mcpConfig, '--append-system-prompt', prompt]
    spawnClaudeProcess(command, args, { shell: true }, ((file: string, actual: string[], options: SpawnOptions) => {
      assert.equal(file, command)
      assert.deepEqual(actual, args)
      assert.equal(options.shell, false)
      assert.equal(options.windowsVerbatimArguments, false)
      return fakeChild()
    }) as never, platform)
  }
  const root = mkdtempSync(join(tmpdir(), 'codingns-existing-mcp-'))
  const path = join(root, 'mcp.json')
  try {
    writeFileSync(path, mcpConfig)
    const child = fakeChild()
    spawnClaudeProcess('claude.cmd', ['--mcp-config', path, '--verbose'], {}, ((_file: string, args: string[]) => {
      assert.equal(argumentPath(args, '--mcp-config'), path)
      return child
    }) as never, 'win32')
    child.emit('close', 0)
    assert.equal(readFileSync(path, 'utf8'), mcpConfig)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Windows Claude 会话执行接入同一启动器，中断时清理桥接配置', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const controller = new AbortController()
  const paths: string[] = []
  const command = 'C:\\Claude\\claude.cmd'
  setSubagentBridge(createSubagentBridgeRuntime({ baseUrl: 'http://127.0.0.1:45999', token: 'integration-test-token' }))
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const driver = new ClaudeCodeDriver({
    binaries: [command],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.206', stderr: '' })) as never,
    spawn: ((_file: string, args: string[]) => {
      const path = argumentPath(args, '--mcp-config')
      paths.push(path)
      const config = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(config.mcpServers.codingns.env.CODINGNS_DSH_SESSION_ID, 'claude-windows-turn')
      assert.equal(config.mcpServers.codingns.env.CODINGNS_BRIDGE_TOKEN, 'integration-test-token')
      const child = fakeChild()
      queueMicrotask(() => controller.abort())
      return child
    }) as never,
  })
  try {
    const events = []
    for await (const event of driver.executeTurn({ sessionId: 'claude-windows-turn', messages: [], prompt: '测试', signal: controller.signal })) events.push(event)
    assert.deepEqual(events.at(-1), { type: 'finish', reason: 'cancel' })
    assert.equal(paths.length, 1)
    assert.equal(existsSync(dirname(paths[0]!)), false)
  } finally {
    driver.dispose()
    setSubagentBridge(undefined)
    Object.defineProperty(process, 'platform', descriptor)
    for (const path of paths) rmSync(dirname(path), { recursive: true, force: true })
  }
})

test('Windows Claude 模型发现使用空 MCP 文件，成功及超时均清理', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-discovery-config-'))
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  const paths: string[] = []
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    for (const timeout of [false, true]) {
      const catalog = await discoverClaudeModelCatalog({
        command: 'C:\\Claude\\claude.cmd', configDir: root, workspaceDir: root,
        env: { ANTHROPIC_BASE_URL: '' }, timeoutMs: 20,
        spawn: ((_file: string, args: string[]) => {
          const path = argumentPath(args, '--mcp-config')
          paths.push(path)
          assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: {} })
          assert.ok(args.at(-1)!.includes('--tools "" --strict-mcp-config'))
          const child = fakeChild()
          if (!timeout) queueMicrotask(() => {
            child.stdout.write(`${JSON.stringify({ type: 'control_response', response: {
              subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [{ value: 'discovered-model' }] },
            } })}\n`)
            child.kill()
          })
          return child
        }) as never,
      })
      assert.equal(catalog.groups[0]!.models.some((model) => model.id === 'discovered-model'), !timeout)
      assert.equal(existsSync(dirname(paths.at(-1)!)), false)
    }
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
    rmSync(root, { recursive: true, force: true })
    for (const path of paths) rmSync(dirname(path), { recursive: true, force: true })
  }
})

test('Windows 原生 cmd 往返保留 Claude 配置与提示词，关闭后无临时文件', { skip: process.platform !== 'win32' }, async () => {
  // 使用假 CLI 读取 argv 和配置，不启动真实 Claude，也不调用模型或访问 Profile。
  const root = mkdtempSync(join(tmpdir(), 'codingns Claude 中文 & '))
  const entry = join(root, 'argv.cjs')
  const command = join(root, 'claude.cmd')
  try {
    writeFileSync(entry, [
      "const fs = require('node:fs'); const args = process.argv.slice(2);",
      "const value = (flag) => args[args.indexOf(flag) + 1];",
      "process.stdout.write(JSON.stringify({ args, config: fs.readFileSync(value('--mcp-config'), 'utf8'), prompt: fs.readFileSync(value('--append-system-prompt-file'), 'utf8') }));",
    ].join('\n'))
    writeFileSync(command, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
    const child = spawnClaudeProcess(command, ['--mcp-config', mcpConfig, '--append-system-prompt', prompt, '--tools', '', '--add-dir', root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; let errors = ''
    child.stdout!.on('data', (chunk) => { output += String(chunk) })
    child.stderr!.on('data', (chunk) => { errors += String(chunk) })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, errors)
    const result = JSON.parse(output)
    assert.equal(result.config, mcpConfig)
    assert.equal(result.prompt, prompt)
    assert.equal(result.args[result.args.indexOf('--tools') + 1], '')
    assert.equal(result.args[result.args.indexOf('--add-dir') + 1], root)
    assert.equal(existsSync(dirname(result.args[result.args.indexOf('--mcp-config') + 1])), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

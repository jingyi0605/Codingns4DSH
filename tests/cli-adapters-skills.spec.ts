import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'
import { OpenCodeDriver } from '../data/build/dist/host/cli-adapters/opencode-driver.js'
import { GrokBuildDriver } from '../data/build/dist/host/cli-adapters/grok-driver.js'

async function writeSkill(root: string, name: string, frontmatter: string, body = '执行 Skill 正文。'): Promise<string> {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}`)
  return directory
}

test('Claude Skill 读取原生根目录，保留企业和用户优先级、YAML 与符号链接语义', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-skills-'))
  try {
    const project = join(root, 'project')
    const cwd = join(project, 'packages', 'app')
    const personal = join(root, 'personal')
    const managed = join(root, 'managed')
    const projectSkills = join(project, '.claude', 'skills')
    await mkdir(cwd, { recursive: true })
    await mkdir(join(project, '.git'))
    await writeSkill(join(root, '.claude', 'skills'), 'outside', 'description: 不应越过仓库根目录')
    await writeSkill(join(project, '.agents', 'skills'), 'agents-only', 'description: Claude 不原生发现此目录')
    await writeSkill(projectSkills, 'shared', 'description: 项目定义')
    await writeSkill(join(personal, 'skills'), 'shared', 'description: 用户定义')
    await writeSkill(join(managed, '.claude', 'skills'), 'shared', 'description: 企业定义')
    await writeSkill(projectSkills, 'renamed-folder', 'name: renamed\ndescription: >-\n  第一段\n  第二段\nmetadata:\n  name: 不要覆盖名称')
    await writeSkill(projectSkills, 'hidden', 'description: 自动调用专用\nuser-invocable: false')
    await writeSkill(projectSkills, 'body-fallback', '', '# 标题\n正文摘要。')
    await writeSkill(projectSkills, 'deploy', 'description: 仓库根目录')
    await writeSkill(join(cwd, '.claude', 'skills'), 'deploy', 'description: 项目子目录')
    await writeSkill(projectSkills, 'malformed', 'description: [损坏的 YAML')
    await writeSkill(projectSkills, 'synced', 'description: 保留目录')
    const linked = await writeSkill(join(root, 'external'), 'target', 'description: 共享目录')
    await symlink(linked, join(projectSkills, 'linked'), 'dir')
    await symlink(projectSkills, join(projectSkills, 'cycle'), 'dir')
    const driver = new ClaudeCodeDriver({ claudeConfigDir: personal, managedSettingsDir: managed })
    const catalog = await driver.listSkills({ sessionId: 'claude-skills', cwd })
    assert.deepEqual(catalog.map((item) => item.name).sort(), ['body-fallback', 'deploy', 'hidden', 'linked', 'packages/app:deploy', 'renamed', 'shared'])
    assert.equal(catalog.find((item) => item.name === 'deploy')?.description, '仓库根目录')
    assert.equal(catalog.find((item) => item.name === 'packages/app:deploy')?.description, '项目子目录')
    assert.equal(catalog.find((item) => item.name === 'body-fallback')?.description, '正文摘要。')
    assert.equal(catalog.find((item) => item.name === 'shared')?.description, '企业定义')
    assert.equal(catalog.find((item) => item.name === 'renamed')?.description, '第一段 第二段')
    assert.equal(catalog.find((item) => item.name === 'hidden')?.enabled, false)
    assert.ok(catalog.every((item) => !('path' in item) && !('content' in item)))
    await rm(join(managed, '.claude', 'skills'), { recursive: true })
    assert.equal((await driver.listSkills({ sessionId: 'claude-skills', cwd })).find((item) => item.name === 'shared')?.description, '用户定义')
    driver.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Claude Skill 可见性服从原生设置优先级和企业插件策略', async () => {
  const root = await mkdtemp(join(tmpdir(), 'claude-skill-settings-'))
  try {
    const project = join(root, 'project')
    const personal = join(root, 'personal')
    const managed = join(root, 'managed')
    await writeSkill(join(project, '.claude', 'skills'), 'deploy', 'description: 部署')
    await mkdir(join(project, '.git'))
    await mkdir(personal)
    await mkdir(managed)
    await writeFile(join(personal, 'settings.json'), JSON.stringify({ skillOverrides: { deploy: 'off' } }))
    await writeFile(join(project, '.claude', 'settings.local.json'), JSON.stringify({ skillOverrides: { deploy: 'user-invocable-only' } }))
    const driver = new ClaudeCodeDriver({ claudeConfigDir: personal, managedSettingsDir: managed })
    assert.equal((await driver.listSkills({ sessionId: 'settings', cwd: project }))[0]?.enabled, true)
    await writeFile(join(managed, 'managed-settings.json'), JSON.stringify({ skillOverrides: { deploy: 'off' } }))
    assert.equal((await driver.listSkills({ sessionId: 'settings', cwd: project }))[0]?.enabled, false)
    await writeFile(join(managed, 'managed-settings.json'), JSON.stringify({ strictPluginOnlyCustomization: true }))
    assert.deepEqual(await driver.listSkills({ sessionId: 'settings', cwd: project }), [])
    driver.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Claude 显式 Skill 命令通过原生 user 消息传递，参数和正文由 CLI 展开', async () => {
  const messages: Record<string, unknown>[] = []
  const args: string[][] = []
  const driver = new ClaudeCodeDriver({
    binaries: ['fake-claude'],
    spawnSync: (() => ({ status: 0, stdout: 'claude 2.1.288', stderr: '' })) as never,
    spawn: ((_command: string, parameters: string[]) => {
      args.push(parameters)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string) { messages.push(JSON.parse(data)) } }
      queueMicrotask(() => { stdout.end('{"type":"result"}\n'); stderr.end() })
      return { stdin, stdout, stderr, kill() { return true } }
    }) as never,
  })
  try {
    for await (const _event of driver.executeTurn({ sessionId: 'claude-command', prompt: '/summary staged diff' })) { /* 只验证协议下发。 */ }
    assert.deepEqual(messages.find((item) => item.type === 'user')?.message, { role: 'user', content: [{ type: 'text', text: '/summary staged diff' }] })
    assert.ok(args.every((parameters) => !parameters.includes('--skill')))
  } finally { driver.dispose() }
})

test('OpenCode 原生目录脱敏并禁用与 command 模板重名的 Skill', async () => {
  const requests: URL[] = []
  const driver = new OpenCodeDriver({
    binaries: [], serverUrls: ['http://opencode.test'],
    fetch: async (url: string) => {
      const parsed = new URL(url)
      requests.push(parsed)
      if (parsed.pathname === '/global/health') return Response.json({})
      if (parsed.pathname === '/skill') return Response.json([
        { name: 'summary', description: '总结', location: '/private/SKILL.md', content: '私密正文' },
        { name: 'review', description: '审查' },
      ])
      if (parsed.pathname === '/command') return Response.json([{ name: 'summary', source: 'skill' }, { name: 'review', source: 'command' }])
      return Response.json({}, { status: 404 })
    },
  })
  try {
    assert.deepEqual(await driver.listSkills({ sessionId: 'open-skills', cwd: '/workspace/project' }), [
      { id: 'summary', name: 'summary', description: '总结', enabled: true },
      { id: 'review', name: 'review', description: '审查', enabled: false },
    ])
    assert.ok(requests.filter((url) => ['/skill', '/command'].includes(url.pathname)).every((url) => url.searchParams.get('directory') === '/workspace/project'))
  } finally { driver.dispose() }
})

test('OpenCode Server 不可达时用原生 debug skill，浏览目录不启动进程', async () => {
  const calls: { args: string[]; cwd?: string }[] = []
  const driver = new OpenCodeDriver({
    serverUrls: [], binaries: ['fake-opencode'],
    spawn: (() => { throw new Error('浏览 Skill 不应启动 Server') }) as never,
    spawnSync: ((_command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ args, cwd: options.cwd })
      return { status: 0, stdout: args.includes('debug') ? JSON.stringify([{ name: 'native-only', description: '来自配置额外目录', location: '/private', content: '正文' }]) : 'opencode 1.18.34', stderr: '' }
    }) as never,
  })
  try {
    assert.deepEqual(await driver.listSkills({ sessionId: 'open-cli', cwd: '/workspace/native' }), [{ id: 'native-only', name: 'native-only', description: '来自配置额外目录', enabled: true }])
    assert.deepEqual(calls.find((call) => call.args.includes('debug')), { args: ['debug', 'skill'], cwd: '/workspace/native' })
  } finally { driver.dispose() }
})

/** 模拟原生 HTTP 路由；idle 可先于命令响应，检查错误不会被提前 finish 吞掉。 */
function openCodeSkillReplay(commandStatus = 200) {
  const posted: { path: string; directory: string | null; body: Record<string, unknown> }[] = []
  const driver = new OpenCodeDriver({
    binaries: [], serverUrls: ['http://opencode.test'],
    fetch: async (url: string, init: RequestInit = {}) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/global/health') return Response.json({})
      if (parsed.pathname === '/config/providers') return Response.json({ providers: { openai: { models: { test: {} } } } })
      if (parsed.pathname === '/session') return Response.json({ id: 'remote-skill' })
      if (parsed.pathname === '/skill') return Response.json([{ name: 'summary', description: '总结' }, { name: 'hidden', description: '禁用', enabled: false }])
      if (parsed.pathname === '/command') return Response.json([{ name: 'summary', source: 'skill' }])
      if (parsed.pathname === '/event') return new Response('data: {"type":"session.status","status":"idle"}\n\n', { headers: { 'content-type': 'text/event-stream' } })
      if (init.method === 'POST') {
        posted.push({ path: parsed.pathname, directory: parsed.searchParams.get('directory'), body: JSON.parse(String(init.body)) })
        if (parsed.pathname.endsWith('/command')) return Response.json({ message: '原生模板校验失败' }, { status: commandStatus })
        return Response.json({})
      }
      return Response.json({}, { status: 404 })
    },
  })
  return { driver, posted }
}

test('OpenCode 显式 Skill 使用 command API 下发参数、模型和附件', async () => {
  const { driver, posted } = openCodeSkillReplay()
  const root = await mkdtemp(join(tmpdir(), 'opencode-skill-attachment-'))
  try {
    const path = join(root, 'input.txt')
    await writeFile(path, '附件内容')
    for await (const _event of driver.executeTurn({
      sessionId: 'open-command', cwd: '/workspace/project', prompt: '/summary staged diff', modelId: 'openai/test', effortId: 'high',
      attachments: [{ kind: 'file', path, name: 'input.txt', mimeType: 'text/plain' }],
    })) { /* 等待请求完成。 */ }
    assert.equal(posted.length, 1)
    assert.equal(posted[0]?.path, '/session/remote-skill/command')
    assert.equal(posted[0]?.directory, '/workspace/project')
    assert.equal(posted[0]?.body.command, 'summary')
    assert.equal(posted[0]?.body.arguments, 'staged diff')
    assert.equal(posted[0]?.body.model, 'openai/test')
    assert.equal(posted[0]?.body.variant, 'high')
    assert.equal((posted[0]?.body.parts as Record<string, unknown>[])[0]?.type, 'file')
  } finally { driver.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('OpenCode 未知或禁用 Skill 保持普通消息，原生命令失败不重新执行', async () => {
  for (const prompt of ['/unknown 原始文字', '/hidden 原始文字']) {
    const { driver, posted } = openCodeSkillReplay()
    try {
      for await (const _event of driver.executeTurn({ sessionId: 'open-message', prompt })) { /* 检查原消息。 */ }
      assert.equal(posted[0]?.path, '/session/remote-skill/message')
      assert.deepEqual(posted[0]?.body.parts, [{ type: 'text', text: prompt }])
    } finally { driver.dispose() }
  }
  const { driver, posted } = openCodeSkillReplay(400)
  try {
    await assert.rejects(async () => {
      for await (const _event of driver.executeTurn({ sessionId: 'open-error', prompt: '/summary' })) { /* 收集终态错误。 */ }
    }, /OpenCode Skill 命令执行失败.*原生模板校验失败/u)
    assert.equal(posted.length, 1)
    assert.equal(posted[0]?.path, '/session/remote-skill/command')
  } finally { driver.dispose() }
})

test('Grok 采用 inspect 信任结果、限定名称和禁用状态，不返回正文路径', async () => {
  const calls: { args: string[]; cwd?: string }[] = []
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawn: (() => { throw new Error('目录浏览不应启动 ACP 会话') }) as never,
    spawnSync: ((_command: string, args: string[], options: { cwd?: string }) => {
      calls.push({ args, cwd: options.cwd })
      return { status: 0, stdout: args.includes('inspect') ? JSON.stringify({
        projectTrusted: false,
        skills: [
          { name: 'summary', invocableAs: '/local:summary', description: '限定名称', path: '/private', content: '正文' },
          { name: 'hidden', description: '自动调用专用', userInvocable: false },
          { name: 'disabled', description: '配置禁用', disabledReason: 'disabled in config' },
          { name: 'incompatible', description: '不兼容', compatibilityStatus: 'disabled' },
        ],
      }) : 'grok 1.0.46', stderr: '' }
    }) as never,
  })
  try {
    assert.deepEqual(await driver.listSkills({ sessionId: 'grok-skills', cwd: '/workspace/untrusted' }), [
      { id: 'local:summary', name: 'local:summary', description: '限定名称', enabled: true },
      { id: 'hidden', name: 'hidden', description: '自动调用专用', enabled: false },
      { id: 'disabled', name: 'disabled', description: '配置禁用', enabled: false },
      { id: 'incompatible', name: 'incompatible', description: '不兼容', enabled: false },
    ])
    assert.deepEqual(calls.find((call) => call.args.includes('inspect')), { args: ['inspect', '--json'], cwd: '/workspace/untrusted' })
  } finally { driver.dispose() }
})

test('Grok 原生目录失败不绕过信任去扫描项目目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-untrusted-skills-'))
  try {
    await writeSkill(join(root, '.grok', 'skills'), 'untrusted', 'description: 不应出现')
    const driver = new GrokBuildDriver({
      binaries: ['fake-grok'],
      spawnSync: ((_command: string, args: string[]) => ({ status: args.includes('inspect') ? 1 : 0, stdout: 'grok 1.0.46', stderr: 'inspect failed' })) as never,
    })
    assert.deepEqual(await driver.listSkills({ sessionId: 'grok-untrusted', cwd: root }), [])
    driver.dispose()
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Grok 限定 Skill 命令通过 ACP prompt 原样交给原生解析器', async () => {
  const prompts: Record<string, unknown>[] = []
  const argumentsList: string[][] = []
  const driver = new GrokBuildDriver({
    binaries: ['fake-grok'],
    spawnSync: (() => ({ status: 0, stdout: 'grok 1.0.46', stderr: '' })) as never,
    spawn: ((_command: string, args: string[]) => {
      argumentsList.push(args)
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const stdin = { write(data: string) {
        const request = JSON.parse(data)
        if (request.id === undefined) return
        if (request.method === 'session/prompt') prompts.push(request.params)
        const result = request.method === 'session/new' ? { sessionId: 'grok-native' } : request.method === 'session/prompt' ? { stopReason: 'end_turn' } : {}
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
      } }
      return { stdin, stdout, stderr, kill() { stdout.end(); stderr.end(); return true } }
    }) as never,
  })
  try {
    for await (const _event of driver.executeTurn({ sessionId: 'grok-command', prompt: '/local:summary staged diff' })) { /* 检查原生 ACP 文本。 */ }
    assert.deepEqual((prompts[0]?.prompt as { type: string; text?: string }[])[0], { type: 'text', text: '/local:summary staged diff' })
    assert.ok(argumentsList.every((args) => !args.includes('--skill')))
  } finally { driver.dispose() }
})

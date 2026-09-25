import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const clientBundle = join(dirname(fileURLToPath(import.meta.url)), '../data/build/dist/client/bundle.js')
const clientSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.ts')
const remoteWebContextSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/remote-web-context.ts')
const hostSource = join(dirname(fileURLToPath(import.meta.url)), '../src/host/index.ts')

test('Client 入口以 DSH Loader factory 格式构建', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/u)
  assert.match(source, /id:\s*["']dsh-codingns["']/u)
  assert.match(source, /factory:\s*\(require\)/u)
  assert.doesNotMatch(source, /require\(["']\.\/[^"']+\.(?:cjs|js)["']\)/u, 'DSH Client 不得依赖 Loader 无法解析的相对分块')
})

test('远程 DSH Web 自动确认内测声明，不触碰其他引导弹窗', async () => {
  const source = await readFile(remoteWebContextSource, 'utf8')
  assert.match(source, /\[role="dialog"\],dialog,\[class\*="onboardingOverlay"\]/u)
  assert.match(source, /内测声明/u)
  assert.match(source, /candidate\.textContent/u)
  assert.match(source, /button\.click\(\)/u)
  assert.match(source, /MutationObserver\(acknowledgeRemoteWelcome\)/u)
  assert.match(source, /welcomeTitles\.has\(welcomeTitle\(root\)\)/u)
  assert.match(source, /welcomeButtons\.has\(normalizeText\(candidate\.textContent\)\)/u)
  assert.match(source, /appRoot\.inert = false/u)
})

test('Host 启动页为 LAN 和本机 Web 注入 Host 所有权标记', async () => {
  const source = await readFile(hostSource, 'utf8')
  assert.match(source, /webserver\/index-inject/u)
  assert.match(source, /name: '__DSH_TRANSPORT__'/u)
  assert.match(source, /value: \{ ownsHost: true \}/u)
})

test('Client 构建产物不包含 Node 专属模块', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const specifier of ['node:crypto', 'node:fs', 'node:net', 'node:child_process']) {
    assert.equal(source.includes(specifier), false, `Client 产物包含 ${specifier}`)
  }
})

test('Client 构建产物包含模块卡片、设置面板和 Host RPC 调用', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.equal(source.includes('每个功能模块独立配置，避免多个表单同时横向挤压。'), false)
  for (const marker of [
    'type: "password"', 'auth/login', 'auth/logout',
    'settings.section', 'id: "codingns"', 'label: "CodingNS"', 'CodingNS 功能模块',
    'details', 'summary', 'role: "switch"', 'aria-label', 'aria-disabled', 'pointerEvents',
    'disabled: disabled || busy', 'aria-modal', '添加中…', '添加中转服务器', 'https://channel.codingns.com:1443',
    '局域网访问', '自动补齐 crypto.randomUUID', '中转访问服务', '绑定 Host',
    'settings/get', 'settings/set', '远程设置读取失败',
    'settings.subscribe(listener)', 'settings.getSnapshot()',
    'crypto', 'randomUUID',
    '外部Agent集成', 'cli/${action}', 'catalog', 'models', 'session/get', 'session/set', 'session/list', '外部 Agent 会话', 'adapter/set', '已停用',
    'conversation.input.right', 'Agent 选择器', '思考等级', 'data-codingns-agent', 'conversation.input.model',
    '安装状态', '模型目录', 'aria-modal',
    '工作区会话增强', '显示 Agent Logo', 'session/adapter-map', 'data-codingns-session-logo',
    '终端强化', '重启 DSH 后生效', '当前运行状态', '下次启动目标',
    '新建终端默认项', '系统推荐', 'PowerShell', 'Git Bash',
    '背景色', '前景色', '光标颜色', '字体', '字号（px）', '行高', '光标形状', '光标闪烁', '回滚行数',
    '添加启动配置', '保存配置', '完整启动命令', 'Workspace 内相对路径', '启用服务代理', 'debug/config/save',
    '启动入口', '执行环境', '服务检查', '端口每 5 秒自动检查', '端口状态尚未检查', '结束进程', '编辑', '删除', 'terminal/status', '运行方式由 Host 平台自动选择',
    'debug/config/update', 'debug/config/delete', 'debug/port/kill',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少 ${marker}`)
  }
  assert.equal(source.includes('环境变量名称'), false, '基础调试表单不应展示环境变量字段')
})

test('设置页由注册表驱动：遍历模块清单并同步启停', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const marker of [
    'settingsModules',
    'CLIENT_FEATURES',
    'settingsPanel',
    'alwaysEnabled',
    'reconcile',
    'dsh-codingns: 功能模块启停同步',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少 ${marker}`)
  }
})

test('设置页不再按模块名硬编码渲染分支', async () => {
  const bundle = await readFile(clientBundle, 'utf8')
  assert.equal(/\.id\s*===\s*["']reverseProxy["']/u.test(bundle), false, '产物仍按模块 id 分支')

  const source = await readFile(clientSource, 'utf8')
  assert.equal(/module\.id\s*===/u.test(source), false, '入口仍按模块 id 分支')
  assert.equal(source.includes('CODINGNS_MODULES'), false, '入口仍维护硬编码模块清单')
})

test('Client 构建产物声明 Cordis 服务依赖', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.match(source, /exports\.inject\s*=\s*inject/u)
  const clientSourceText = await readFile(clientSource, 'utf8')
  for (const dependency of ['remote', 'remote.workspace', 'remote.session', 'remote.terminal']) {
    assert.match(clientSourceText, new RegExp(`['"]${dependency.replace('.', '\\.') }['"]`))
  }
})

test('Client 构建产物提供自有 webTerminals 与 Sidebar 终端', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const marker of [
    'super(ctx, "webTerminals")',
    'dsh-codingns/terminal',
    'sidebar.right.pane.tab',
    'sidebar.right.tab.guide.entry',
    'CodingNS 自有的浏览器终端服务',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少自有终端标记 ${marker}`)
  }
  assert.equal(source.includes('@deepseek-ai/dsh-client-ui-sidebar-terminal'), false)
})

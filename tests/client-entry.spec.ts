import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const clientBundle = join(dirname(fileURLToPath(import.meta.url)), '../data/build/dist/client/bundle.js')
const clientSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/index.ts')
const remoteWebContextSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/remote-web-context.ts')
const hostSource = join(dirname(fileURLToPath(import.meta.url)), '../src/host/index.ts')
const runtimeVersionSource = join(dirname(fileURLToPath(import.meta.url)), '../src/client/dsh-runtime-version.ts')

test('Client 入口以 DSH Loader factory 格式构建', async () => {
  const source = await readFile(clientBundle, 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load/u)
  assert.match(source, /id:\s*["']@jingyi0605\/codingns4dsh["']/u)
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

test('远程 DSH Web 声明已认证 Host 所有权以启用持久设置', async () => {
  const source = await readFile(remoteWebContextSource, 'utf8')
  assert.match(source, /openStream: openRemoteStream,/u)
  assert.match(source, /streamBaseUrl: resourceBase\(\)/u)
  assert.match(source, /ownsHost: true,/u)
})

test('Desktop dsh-app 页面不请求不存在的本地身份端点', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/client/account-bar.ts'), 'utf8')
  assert.match(source, /location\.protocol[\s\S]{0,180}protocol !== 'http:'[\s\S]{0,100}protocol !== 'https:'/u)
})

test('Host 启动页只合并既有 Transport 且不覆盖 Desktop Transport', async () => {
  const source = await readFile(hostSource, 'utf8')
  assert.match(source, /webserver\/index-inject/u)
  assert.match(source, /injectDshWebTransportOwnership/u)
  assert.match(source, /name: DSH_VERSION_INJECTION_NAME/u)
  assert.doesNotMatch(source, /name: '__DSH_TRANSPORT__'/u)
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
    'settings.section', 'id: "codingns"', 'label: "Codingns4DSH"', 'Codingns4DSH 功能模块',
    'details', 'summary', 'role: "switch"', 'aria-label', 'aria-disabled', 'pointerEvents',
    'disabled: disabled || busy', 'aria-modal', '添加中…', '添加中转服务器', 'https://channel.codingns.com:1443',
    '局域网访问', '入口加载时会补齐', '中转访问服务', '绑定 Host',
    'settings/get', 'settings/set', '远程设置读取失败',
    'settings.subscribe(listener)', 'settings.getSnapshot()',
    'crypto', 'randomUUID',
    '外部Agent集成', 'cli/${action}', 'catalog', 'models', 'session/get', 'session/set', 'session/list', '外部 Agent 会话', 'adapter/set', '已停用',
    'conversation.input.right', 'Agent 选择器', '思考等级', 'data-codingns-agent', 'conversation.input.model', '@container (width<=650px)',
    '安装状态', '模型目录', 'aria-modal',
    '工作区会话增强', '显示 Agent Logo', 'session/adapter-map', 'data-codingns-session-logo',
    '终端增强', '当前运行状态',
    '新建终端默认项', '系统推荐', 'PowerShell', 'Git Bash',
    '背景色', '文本颜色', '光标颜色', '字号（px）', '行高', '光标形状', '光标闪烁', '回滚行数',
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
    // Cordis effect 标签改成英文，避免被国际化守卫当成用户可见中文文案。
    'codingns4dsh: feature module activation sync',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少 ${marker}`)
  }
})

test('Client 注入重载时先释放功能注册表，避免 Sidebar 类型残留', async () => {
  const source = await readFile(clientSource, 'utf8')
  assert.match(source, /return async \(\) => \{[\s\S]{0,180}unsubscribe\(\)[\s\S]{0,180}await registry\.reconcile\(\[\]\)/u)
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
  for (const dependency of ['remote', 'remote.workspace', 'remote.session']) {
    assert.match(clientSourceText, new RegExp(`['"]${dependency.replace('.', '\\.') }['"]`))
  }
  const injectDeclaration = clientSourceText.match(/export const inject = \[([^\]]+)\]/u)?.[1] ?? ''
  assert.doesNotMatch(injectDeclaration, /remote\.terminal/u)
  assert.match(clientSourceText, /const terminalRemote =/u)
})

test('Client 入口兼容 DSH 0.1.7 ConfigForm，不把旧 settingsScope 作为硬依赖', async () => {
  const source = await readFile(clientSource, 'utf8')
  const injectDeclaration = source.match(/export const inject = \[([^\]]+)\]/u)?.[1] ?? ''
  assert.equal(injectDeclaration.includes('settingsScope'), false)
  assert.match(source, /ctx\.get\('configForms'\)/u)
  assert.match(source, /ctx\.get\('settingsScope'\)/u)
  assert.match(source, /createConfigFormSettingsStore/u)
})

test('Client ConfigForm 只绑定 Host 实际提供的 scoped namespace，不误用加载中的空表单', async () => {
  const source = await readFile(clientSource, 'utf8')
  assert.match(source, /resolveServedConfigFormNamespace\(forms, CODINGNS_SETTINGS_ENTRY_IDS\)/u)
  assert.match(source, /client config form not served; falling back to Host settings RPC/u)
  // Host 持久模式会给任意 entry 造出一份停在 loading 的表单；按 status 猜测会
  // 绑定一份 Host 没下发的表单，让设置页永久把所有模块开关显示为不可操作。
  assert.doesNotMatch(source, /form\.getSnapshot\(\)\.status !== 'unavailable'/u)

  const adapterSource = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/dsh-capabilities/client/config-forms-adapter.ts'), 'utf8')
  assert.match(adapterSource, /forms\.describe\?\.\(\)\.getSnapshot\(\)\.view\?\.namespaces/u)
  assert.match(adapterSource, /entryIds\.find/u)
})

test('Client 版本门禁用兼容范围下界回退，不写死历史版本', async () => {
  const source = await readFile(runtimeVersionSource, 'utf8')
  assert.match(source, /hasModernConfigForms\(ctx\)/u)
  assert.match(source, /ctx\.get\('configForms'\)/u)
  // 回退值必须来自兼容范围：写死 0.1.7-rc.2 会在范围放宽为 >=0.2.0-rc.1 后
  // 变成“不支持的 DSH 版本”，把只缺启动页注入的页面误判为宿主不兼容。
  assert.match(source, /minimumSupportedDshVersion\(\)/u)
  assert.doesNotMatch(source, /'0\.1\.7-rc\.2'/u)
})

test('Client 构建产物提供自有 webTerminals 与 Sidebar 终端', async () => {
  const source = await readFile(clientBundle, 'utf8')
  for (const marker of [
    'super(ctx, "webTerminals")',
    'codingns4dsh/terminal',
    'sidebar.right.pane.tab',
    'sidebar.right.tab.guide.entry',
    'Codingns4DSH 自有的浏览器终端服务',
  ]) {
    assert.equal(source.includes(marker), true, `Client 产物缺少自有终端标记 ${marker}`)
  }
  assert.equal(source.includes('@deepseek-ai/dsh-client-ui-sidebar-terminal'), false)
  assert.match(source, /codingnsTerminal/u)
})

test('Client 终端 Remote 通过显式嵌套注入读取，避免 Cordis 代理越权访问', async () => {
  const source = await readFile(clientSource, 'utf8')
  assert.match(source, /settingsCtx\.inject\(\['remote\.codingnsTerminal'\]/u)
  assert.match(source, /terminalCtx\.get\('remote\.codingnsTerminal'\)/u)
  assert.doesNotMatch(source, /ctx\.get\('remote\.codingnsTerminal'\)/u)
  assert.doesNotMatch(source, /settingsCtx\.remote\.codingnsTerminal/u)
})

test('调试页使用 Codingns4DSH 自有终端 Remote 解析 Workspace', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/client/debug/ui.ts'), 'utf8')
  assert.match(source, /terminalRemote\?\.\(\)/u)
  assert.doesNotMatch(source, /remote\?\.terminal/u)
})

test('中继桥接为每类请求分配互不冲突的 ID，且绝不覆盖在途请求', async () => {
  // 早期实现把 fetch/script 与 ws.open 的计数器当成裸数字放进同一个 pending Map：
  // 两个计数器都从 1 开始，页面启动时插件包 fetch 与 /api/remote.mux 的 ws.open
  // 几乎同时发生，后到的 pending.set 会覆盖先到的在途请求，被覆盖的 Promise 永不落地。
  // 若被覆盖的是原生设置 settings/describe，DSH 设置镜像会停在 loading，
  // 中继下的「模型」页就永久空白且无报错。
  const source = await readFile(remoteWebContextSource, 'utf8')
  assert.match(source, /const allocateId = \(prefix, counter\) =>/u)
  assert.match(source, /while \(pending\.has\(id\)\)/u)
  assert.match(source, /allocateId\('req:', nextCallId\)/u)
  assert.match(source, /allocateId\('ws:', nextSocketId\)/u)
  assert.doesNotMatch(source, /pending\.set\(String\(/u, 'pending 的键必须带 kind 前缀')
  assert.doesNotMatch(source, /_id = String\(\+\+nextSocketId\)/u, 'WebSocket ID 不能与 fetch ID 共用裸数字空间')
})

test('部署用的 H5 运行时包含互不冲突的桥接 ID 前缀', async () => {
  const runtime = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../data/build/h5/runtime.js'), 'utf8')
  assert.match(runtime, /allocateId\('req:', nextCallId\)/u)
  assert.match(runtime, /allocateId\('ws:', nextSocketId\)/u)
})

test('桥接 ID 分配器（取自构建产物）不会覆盖在途请求', async () => {
  const runtime = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../data/build/h5/runtime.js'), 'utf8')
  const match = /const allocateId = \(prefix, counter\) => \{[\s\S]*?\n    \};/u.exec(runtime)
  assert.ok(match, '构建产物里必须能找到 allocateId')
  const pending = new Map()
  const allocate = new Function('pending', `${match[0]}\nreturn allocateId;`)(pending) as (prefix: string, counter: number) => { id: string; counter: number }

  const first = allocate('req:', 0)
  assert.deepEqual(first, { id: 'req:1', counter: 1 })
  // ws 空间与 fetch 空间各自从 1 开始，但 ID 必须不同。
  const socket = allocate('ws:', 0)
  assert.deepEqual(socket, { id: 'ws:1', counter: 1 })
  assert.notEqual(first.id, socket.id)

  // 极端情况：同前缀 ID 仍在途时必须跳过，而不是覆盖它。
  pending.set('req:2', {})
  assert.deepEqual(allocate('req:', 1), { id: 'req:3', counter: 3 })
})

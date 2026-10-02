import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('终端入口复用 DSH 内置按钮与菜单，不退回原生表单控件', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /Button,[\s\S]*Menu,/u)
  // 0.2.0 只导出 Regular/Medium 图标变体；入口必须经适配器解析，不能绑定旧导出名。
  assert.match(source, /resolveChevronDownIcon\(\)/u)
  assert.doesNotMatch(source, /IconChevronDownOutline(?:14|Regular|Medium)/u)
  assert.match(source, /variant: 'ghost'/u)
  assert.doesNotMatch(source, /createElement\(['"]select['"]/u)
  assert.doesNotMatch(source, /border:\s*['"]1px solid currentColor/u)
})

test('聚合页内终端列表支持双击重命名', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /function TerminalListRow/u)
  assert.match(source, /onDoubleClick:[ \t]*\(\) => setEditing\(true\)/u)
  assert.match(source, /terminalClass\.listClose/u)
})

test('消息列表会话头部不再显示终端恢复按钮', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')
  assert.doesNotMatch(source, /conversation\.session\.header\.actions/u)
  assert.doesNotMatch(source, /TerminalRecovery/u)
})

test('终端布局和 xterm 默认值与 DSH 0.1.6 内置终端一致', async () => {
  const [styles, xterm] = await Promise.all([
    readFile(join(projectRoot, 'src/client/terminal/styles.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8'),
  ])

  assert.match(styles, /border-radius:24px/u)
  assert.match(styles, /padding:8px/u)
  assert.match(styles, /--dsw-alias-bg-base/u)
  assert.match(styles, /--dsw-alias-label-primary/u)
  assert.match(xterm, /minimumContrastRatio:\s*4\.5/u)
  assert.match(xterm, /fontSize:\s*appearance\.fontSize \?\? 13/u)
  assert.match(xterm, /ui-monospace, SFMono-Regular, Menlo, Consolas, monospace/u)
})

test('终端外观设置按实际值展示且光标闪烁位于字号之前', async () => {
  const source = await readFile(join(projectRoot, 'src/client/features/terminal-enhancement-panel.ts'), 'utf8')
  const blinkIndex = source.indexOf("createElement(Field, { label: t('terminal.cursorBlink') }")
  const fontSizeIndex = source.indexOf("createElement(NumberField, { label: t('terminal.fontSize'),")
  assert.ok(blinkIndex >= 0 && fontSizeIndex >= 0 && blinkIndex < fontSizeIndex)
  assert.match(source, /background: appearance\.background \?\? '#111111'/u)
  assert.match(source, /fontSize: appearance\.fontSize \?\? 13/u)
  assert.match(source, /scrollback: appearance\.scrollback \?\? 1000/u)
  assert.doesNotMatch(source, /inheritLabel/u)
})

test('xterm 不会用 Shell 默认标题覆盖调试终端标题', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8')

  assert.match(source, /preserveHostTitle/u)
  assert.match(source, /state\.info\.title !== state\.info\.shell\.name/u)
  assert.match(source, /if \(!preserveHostTitle\) void view\.rename\(value\)/u)
})

test('终端 UI 通过聚合库存恢复跨会话页签', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /inventoryRevision/u)
  assert.match(source, /recoverSession\(sessionId\)/u)
  assert.match(source, /ctx\.slots\.inject\('sidebar\.right\.tab\.guide\.entry'/u)
})

test('聚合页关闭按钮只按 terminalId 关闭目标 Host 终端', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /webTerminals\.closeTerminal\(String\(sessionId\), item\.id\)/u)
  assert.doesNotMatch(source, /closeTerminalTabs/u)
})

test('新建终端入口打开聚合页并使用一次性自动创建标记', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /params: \{ autoCreate: true \}/u)
  assert.match(source, /params: \{ autoCreate: true, shellPath: path \}/u)
  assert.match(source, /params\.autoCreate/u)
})

test('终端类型按 kind 只保留一个聚合页签', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /kind: TERMINAL_KIND,[\s\S]*multiple: false/u)
  assert.match(source, /terminalClass\.aggregateRoot/u)
})

test('聚合页终端列表位于顶部横向标签栏，不占用内容区侧向空间', async () => {
  const styles = await readFile(join(projectRoot, 'src/client/terminal/styles.ts'), 'utf8')

  assert.match(styles, /aggregateRoot\}\{[^}]*flex-direction:column/u)
  assert.match(styles, /list\}\{[^}]*overflow-x:auto/u)
  assert.doesNotMatch(styles, /list\}\{[^}]*width:180px/u)
})

test('创建终端先写入当前列表并串行收敛库存刷新，避免内容视图闪退', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /const reloadSequence = useRef\(0\)/u)
  assert.match(source, /if \(sequence !== reloadSequence\.current\) return next/u)
  assert.match(source, /setTerminals\(\(current\) => current\.some\(\(item\) => item\.id === info\.id\)/u)
})

test('终端 Guide Entry 交给 Slots 注入器处理延迟声明', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /disposers\.push\(ctx\.slots\.inject\('sidebar\.right\.tab\.guide\.entry'/u)
  assert.doesNotMatch(source, /guideEntrySlot/u)
})

test('运行时丢失显示重建入口而不是假的进程退出', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8')
  // lost 是终态：给"重建终端"，不能再给只会重复失败的"重新连接"。
  assert.match(source, /const lost = state\.info\?\.state === 'lost'/u)
  assert.match(source, /terminalView\.rebuild/u)
  assert.match(source, /const retry = !ended && !lost/u)
  // 状态文案必须区分"运行时丢失"和"进程已退出"。
  assert.match(source, /if \(state\.info\?\.state === 'lost'\) return t\('terminalView\.lost'\)/u)
})

test('客户端在连接层断开时自动重连，终态才停下', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/model.ts'), 'utf8')
  // 流结束/异常但终端仍在运行 -> 退避重连。
  assert.match(source, /if \(this\.isRunning\(\)\) this\.scheduleReconnect\(\)/u)
  assert.match(source, /private scheduleReconnect\(\): void/u)
  // 真正收到画面后重置退避，避免长时间使用后重连变慢。
  assert.match(source, /this\.reconnectAttempts = 0/u)
})

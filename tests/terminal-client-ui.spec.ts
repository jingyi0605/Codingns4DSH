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
  assert.match(source, /icon: createElement\(resolvePlusIcon\(\)\)/u)
  assert.doesNotMatch(source, /createElement\(['"]select['"]/u)
  assert.doesNotMatch(source, /border:\s*['"]1px solid currentColor/u)
})

test('聚合页内终端列表支持双击重命名', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /function TerminalListRow/u)
  assert.match(source, /onDoubleClick:[ \t]*\(\) => setEditing\(true\)/u)
  assert.match(source, /terminalClass\.listClose/u)
  assert.match(source, /event\.preventDefault\(\)[\s\S]*event\.stopPropagation\(\)/u)
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
  // 聚合页是横向 flex 容器；终端项必须允许收缩，否则 xterm 的旧列宽会把移动端撑出视口。
  assert.match(styles, /root\}\{[^}]*width:0[^}]*min-width:0/u)
  assert.match(styles, /screen\}\{[^}]*width:100%[^}]*min-width:0/u)
  assert.match(xterm, /minimumContrastRatio:\s*4\.5/u)
  assert.match(xterm, /fontSize:\s*appearance\.fontSize \?\? 13/u)
  assert.match(xterm, /ui-monospace, SFMono-Regular, Menlo, Consolas, monospace/u)
  assert.match(xterm, /isSnapshot && host !== null[\s\S]*fitTerminal\(terminal, fitRef\.current, view\)/u)
  assert.match(xterm, /normalizeTerminalSnapshot\(render\.frame\.screen\)/u)
  assert.match(xterm, /value\.replace\(\/\\r\?\\n\/gu, '\\r\\n'\)/u)
  // 首帧之后字体和移动端容器才可能稳定；必须连续重排，历史顶部行也要按新列数布局。
  assert.match(xterm, /schedulePostAttachReflow/u)
  assert.match(xterm, /resolveTerminalDimensions/u)
  assert.match(xterm, /root\.clientWidth/u)
  assert.match(xterm, /if \(host\.clientWidth === 0 \|\| host\.clientHeight === 0\)/u)
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

test('终端页从 DSH navigation 快照读取自动创建参数', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /navigation\.getSnapshot\(\)/u)
  assert.match(source, /const params = isRecord\(snapshot\) \? snapshot\.params : undefined/u)
  assert.doesNotMatch(source, /navigationRevision > 0/u)
  assert.match(source, /typeof tab\.id === 'string'/u)
})

test('终端入口登记本地创建意图并由库存恢复清理空页签', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /markPendingAutoCreateIntent\(String\(sessionId\)\)/u)
  assert.match(source, /hasPendingAutoCreateIntent\(String\(sessionId\)\)/u)
  assert.doesNotMatch(source, /setTimeout\(\(\) => info\.tab\.actions\.close\(\), 300\)/u)
})

test('终端类型按 kind 只保留一个聚合页签', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /kind: TERMINAL_KIND,[\s\S]*multiple: false,[\s\S]*keepMounted: true/u)
  assert.match(source, /terminalClass\.aggregateRoot/u)
})

test('聚合页终端列表位于顶部横向标签栏，不占用内容区侧向空间', async () => {
  const styles = await readFile(join(projectRoot, 'src/client/terminal/styles.ts'), 'utf8')

  assert.match(styles, /aggregateRoot\}\{[^}]*flex-direction:column/u)
  assert.match(styles, /list\}\{[^}]*overflow-x:auto/u)
  assert.doesNotMatch(styles, /list\}\{[^}]*width:180px/u)
})

test('聚合页始终渲染页内终端列表导航', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  // 终端内容和列表必须由同一个库存分支渲染；如果只恢复单个 xterm
  // 视图，用户将看不到用于切换多个 Host 终端的顶部标签栏。
  assert.match(source, /createElement\('nav',\s*\{\s*className:\s*terminalClass\.list/u)
  assert.match(source, /terminals\.map\(\(item\) => createElement\(TerminalListRow/u)
  assert.match(source, /terminals\.map\(\(item\) => createElement\(CodingNsXtermView/u)
})

test('创建终端先写入当前列表并串行收敛库存刷新，避免内容视图闪退', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /const reloadSequence = useRef\(0\)/u)
  assert.match(source, /if \(sequence !== reloadSequence\.current\) return next/u)
  assert.match(source, /setTerminals\(\(current\) => current\.some\(\(item\) => item\.id === info\.id\)/u)
})

test('聚合页常驻挂载所有终端视图，切换标签只隐藏当前视图', async () => {
  const [uiSource, xtermSource] = await Promise.all([
    readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8'),
  ])

  assert.match(uiSource, /terminals\.map\(\(item\) => createElement\(CodingNsXtermView/u)
  assert.match(uiSource, /const activeId = selected\?\.id \?\? terminals\[0\]\?\.id/u)
  assert.match(uiSource, /active: item\.id === activeId/u)
  assert.match(uiSource, /visible: info\.tab\.visible/u)
  assert.match(xtermSource, /useEffect\(\(\) => visible \? view\.mount\(\) : undefined/u)
  assert.match(xtermSource, /style: active \? undefined : \{ display: 'none' \}/u)
})

test('聚合页隐藏时不卸载内部列表和终端视图', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/ui.ts'), 'utf8')

  assert.match(source, /keepMounted: true/u)
  assert.doesNotMatch(source, /if \(!info\.tab\.visible\) return null/u)
  assert.match(source, /visible: info\.tab\.visible/u)
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

test('终端输入会过滤设备识别回显并支持鼠标与触摸历史滚动', async () => {
  const source = await readFile(join(projectRoot, 'src/client/terminal/xterm-view.ts'), 'utf8')

  // resident 重放期间 xterm 可能重复回答 DA 查询；这些响应进入 shell
  // 后会被 zsh 回显成“1;2c0;276;0c”等异常字符。
  assert.match(source, /stripTerminalDeviceAttributeResponses\(data\)/u)
  // 移动端通过触摸位移换算为 xterm 行滚动，不能让浏览器默认滚动抢走事件。
  assert.match(source, /touchstart/u)
  assert.match(source, /touchmove/u)
  assert.match(source, /terminal\.scrollLines\(lines\)/u)
  assert.match(source, /touchVelocityLinesPerMs/u)
  assert.match(source, /requestAnimationFrame\(step\)/u)
  assert.match(source, /TERMINAL_TOUCH_MOMENTUM_FRICTION/u)
  assert.match(source, /TERMINAL_TOUCH_MOMENTUM_MAX_DURATION_MS/u)
  assert.match(source, /TERMINAL_TOUCH_MOMENTUM_RELEASE_IDLE_MS/u)
  assert.match(source, /const nextVelocity = clampNumber/u)
  assert.match(source, /松手时沿上一次手势方向继续滚动/u)
  assert.match(source, /Math\.abs\(deltaY\) <= Math\.abs\(deltaX\)/u)
  const wheelSource = source.match(/const wheel = \(event: WheelEvent\): boolean => \{[\s\S]*?\n    \}\n    terminal\.attachCustomWheelEventHandler\(wheel\)/u)?.[0]
  assert.ok(wheelSource, '未找到终端滚轮处理器')
  assert.match(wheelSource, /terminal\.buffer\.active\.baseY > 0/u)
  assert.match(wheelSource, /return true/u)
  assert.doesNotMatch(wheelSource, /terminal\.scrollLines\(/u)
  assert.match(source, /terminal\.onScroll\(/u)
  assert.match(source, /event\.preventDefault\(\)/u)
  assert.match(source, /state\.environment\?\.scrollback \?\? 1000/u)
  assert.match(source, /addEventListener\('touchmove', touchMove, \{ passive: false \}\)/u)
  assert.match(source, /removeEventListener\('touchmove', touchMove\)/u)
  assert.match(source, /scrollbar-gutter:stable/u)
  assert.match(source, /touch-action:pan-y/u)
  assert.match(source, /overscroll-behavior:contain/u)
  assert.match(source, /-webkit-overflow-scrolling:touch/u)
  assert.match(source, /::-webkit-scrollbar-thumb/u)
})

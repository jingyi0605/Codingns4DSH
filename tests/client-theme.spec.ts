import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  dshButtonStyle,
  dshFieldStyle,
  dshPopupSurfaceStyle,
  dshThemeColor,
} from '../data/build/dist/client/theme.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('表单控件使用 DSH 真实主题令牌', () => {
  assert.match(String(dshFieldStyle.background), /--dsw-specific-input-major/u)
  assert.match(String(dshFieldStyle.color), /--dsw-alias-label-primary/u)
  assert.match(String(dshFieldStyle.border), /--dsw-alias-border-l2/u)
  assert.match(String(dshButtonStyle.background), /--dsw-alias-button-elevated-fill/u)
  assert.match(String(dshButtonStyle.color), /--dsw-alias-label-primary/u)
})

test('弹窗表面同时设置 DSH 背景、前景和阴影', () => {
  assert.match(String(dshThemeColor.menuBackground), /--dsw-alias-bg-layer-3/u)
  assert.match(String(dshThemeColor.menuBackground), /--dsw-specific-menu/u)
  assert.doesNotMatch(String(dshThemeColor.menuBackground), /--dsw-alias-bg-l1/u, 'bg-l1 不是 DSH 令牌，不能留在回退链里')
  assert.match(String(dshPopupSurfaceStyle.background), /--dsw-specific-menu/u)
  assert.match(String(dshPopupSurfaceStyle.color), /--dsw-alias-label-primary/u)
  assert.match(String(dshPopupSurfaceStyle.boxShadow), /--dsw-elevation-prominent/u)
  assert.match(dshThemeColor.overlay, /--dsw-alias-bg-mask-1/u)
})

test('主题桥接与 Git 面板不再引用任何幽灵令牌', async () => {
  const files = [
    'src/client/theme.ts',
    'src/client/git-management.ts',
    'src/client/git-panel-styles.ts',
    'src/client/git-history-graph.ts',
  ]
  const sources = await Promise.all(files.map((file) => readFile(join(projectRoot, file), 'utf8')))
  // 这些令牌在 DSH 0.2.0-rc.1 的 401 个已定义令牌中都不存在，一旦写入就只会落到兜底值。
  // 用词边界匹配，避免把真实令牌（如 --dsw-alias-state-success-primary）误判成前缀相同的幽灵令牌。
  const ghosts = ['--dsw-alias-bg-l1', '--dsw-alias-bg-l2', '--dsw-alias-bg-primary', '--dsw-alias-bg-secondary', '--dsw-alias-bg-tertiary', '--dsw-alias-button-elevated-hover', '--dsw-alias-interactive-bg-selected', '--dsw-alias-state-danger', '--dsw-alias-state-success', '--dsw-elevation-l1', '--dsw-font-mono', '--dsw-font-family-mono']
  for (const [index, source] of sources.entries()) {
    for (const ghost of ghosts) {
      assert.doesNotMatch(source, new RegExp(`${ghost}(?![\\w-])`, 'u'), `${files[index]} 引用了幽灵令牌 ${ghost}`)
    }
  }
})

test('Git 面板的交互态由注入样式表提供且使用真实令牌', async () => {
  const source = await readFile(join(projectRoot, 'src/client/git-panel-styles.ts'), 'utf8')
  // 内联样式无法表达伪类，因此悬停/按下/聚焦/禁用必须落在注入的样式表里。
  // 禁用态统一走 `disabled` 常量插值，所以按引用次数统计而不是按字面量。
  const count = (pattern: RegExp): number => (source.match(pattern) ?? []).length
  assert.ok(count(/:hover:not\(:disabled\)/gu) >= 4, `悬停态覆盖不足：${count(/:hover:not\(:disabled\)/gu)}`)
  assert.ok(count(/:active:not\(:disabled\)/gu) >= 4, `按下态覆盖不足：${count(/:active:not\(:disabled\)/gu)}`)
  assert.ok(count(/:focus-visible/gu) >= 4, `聚焦态覆盖不足：${count(/:focus-visible/gu)}`)
  assert.ok(count(/\$\{disabled\}/gu) >= 5, `禁用态覆盖不足：${count(/\$\{disabled\}/gu)}`)
  assert.match(source, /--dsw-alias-interactive-bg-hover/u)
  assert.match(source, /--dsw-alias-interactive-bg-active/u)
  assert.match(source, /--dsw-focus-ring-width/u)
  assert.match(source, /--dsw-focus-ring-color/u)
  assert.match(source, /opacity:\.4;cursor:not-allowed/u)
  assert.match(source, /prefers-reduced-motion/u)
})

test('所有弹层组件复用跨 DSH 版本的实底主题令牌', async () => {
  const files = [
    'src/client/account-bar.ts',
    'src/client/debug/ui.ts',
    'src/client/workspace-session-archive-dom.ts',
    'src/client/subscription-slot.ts',
  ]
  const sources = await Promise.all(files.map((file) => readFile(join(projectRoot, file), 'utf8')))
  for (const source of sources) assert.doesNotMatch(source, /background:\s*['"]var\(--dsw-specific-menu/u)
})

test('所有 Client 表单不再引用不存在的旧主题令牌', async () => {
  const files = [
    'src/client/settings-section.ts',
    'src/client/features/lan-access-panel.ts',
    'src/client/features/reverse-proxy-panel.ts',
    'src/client/features/cli-adapters.ts',
    'src/client/features/workspace-session-enhancement-panel.ts',
    'src/client/workspace-session-logo-dom.ts',
    'src/client/cli-slots.ts',
  ]
  const sources = await Promise.all(files.map((file) => readFile(join(projectRoot, file), 'utf8')))
  const source = sources.join('\n')

  assert.doesNotMatch(source, /--dsw-alias-(?:bg-primary|bg-secondary|border-primary)/u)
  assert.equal(source.includes('dshSettingsFieldStyle'), true)
  assert.equal(source.includes('dshSettingsButtonStyle'), true)
  assert.equal(source.includes('dshPopupSurfaceStyle'), true)
  assert.equal(source.includes(dshThemeColor.labelPrimary), false, '组件应复用主题样式或令牌对象，不应复制令牌字符串')
})

test('切换外部 Agent 时模型选择器立即显示可访问的旋转加载状态', async () => {
  const source = await readFile(join(projectRoot, 'src/client/cli-slots.ts'), 'utf8')

  assert.match(source, /@keyframes codingns4dsh-cli-spin/u)
  assert.match(source, /className: 'codingns4dsh-cli-spinner'/u)
  assert.match(source, /'aria-busy': loading/u)
  assert.match(source, /role: loading \? 'status'/u)
  assert.match(source, /catalogState\?\.adapterId === selection\.adapterId/u)
  assert.match(source, /正在加载模型列表…/u)
  assert.match(source, /disabled: triggerDisabled/u)
  assert.match(source, /const triggerDisabled = !loading && modelUnavailable/u)
})

test('Agent 选择器位于模型左侧并显示完整 Provider Logo', async () => {
  const [slotSource, iconSource, bundleSource] = await Promise.all([
    readFile(join(projectRoot, 'src/client/cli-slots.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/provider-icons.ts'), 'utf8'),
    readFile(join(projectRoot, 'data/build/dist/client/bundle.js'), 'utf8'),
  ])

  assert.match(slotSource, /id: 'codingns4dsh-agent',[\s\S]*?order: -20/u)
  assert.match(slotSource, /id: 'codingns4dsh-model',[\s\S]*?order: -10/u)
  assert.doesNotMatch(slotSource, /slots\.inject\('conversation\.input\.left'/u)
  assert.match(slotSource, /className: 'codingns4dsh-agent-trigger'/u)
  assert.match(slotSource, /className: 'codingns4dsh-agent-option'/u)
  assert.match(slotSource, /role: 'menuitemradio'/u)
  assert.match(slotSource, /CIRCULAR_PROVIDER_ICON_IDS = new Set\(\['gemini', 'grok'\]\)/u)
  assert.match(slotSource, /CIRCULAR_PROVIDER_ICON_IDS\.has\(adapterId\) \? \{ \.\.\.style, borderRadius: '50%' \} : style/u)
  assert.equal(slotSource.match(/createElement\(NativeDropdownChevron/g)?.length, 2)
  assert.match(slotSource, /createElement\(NativeDropdownChevron, \{ open, locked \}\)/u)
  assert.match(slotSource, /viewBox: '0 0 14 14'/u)
  assert.match(slotSource, /M11\.8486 5\.5L11\.4238 5\.92383/u)
  assert.match(slotSource, /M10\.5 6V4\.75a3\.5 3\.5 0 0 0-7 0V6H3a1 1 0 0 0-1 1v4/u)
  assert.match(slotSource, /transform: !locked && open \?/u)
  assert.doesNotMatch(slotSource, /⌄/u)

  for (const adapterId of ['dsh', 'command-code', 'claude-code', 'kimi', 'gemini', 'pi', 'codex', 'opencode', 'grok', 'zcode']) {
    assert.match(iconSource, new RegExp(`(?:['"]${adapterId}['"]|\\b${adapterId}):`, 'u'), `${adapterId} 缺少 Logo 映射`)
  }
  assert.match(bundleSource, /data:image\/(?:png|svg\+xml);base64,/u, 'Client 单文件包应内联 Provider Logo')
})

test('输入工具栏放不下时按 DSH 判定收起模型字段，超长名称保持滚动展示', async () => {
  const [source, quickPhraseSource] = await Promise.all([
    readFile(join(projectRoot, 'src/client/cli-slots.ts'), 'utf8'),
    readFile(join(projectRoot, 'src/client/quick-phrase-slot.ts'), 'utf8'),
  ])

  // 放不下时由 DSH 给控制行加 data-model-compact；插件不能强制 nowrap，
  // 否则工具行改为压缩权限/规划组，测量口径失真且内容溢出重叠。
  assert.doesNotMatch(source, /flex-wrap:nowrap!important/u)
  assert.match(source, /\[data-composer-card\] \[data-model-compact\] \.codingns4dsh-model-root \.codingns4dsh-model-name,/u)
  assert.match(source, /\[data-composer-card\] \[data-model-compact\] \.codingns4dsh-model-root \.codingns4dsh-model-effort\{display:none!important\}/u)
  assert.match(source, /\[data-composer-card\] \[data-model-compact\] \.codingns4dsh-model-root \.codingns4dsh-model-icon\{display:block!important;flex:none\}/u)
  // 收起图标经适配层解析，不绑定具体 DSH 版本的导出名。
  assert.match(source, /resolveDataIcon\(\)/u)
  assert.doesNotMatch(source, /IconDataOutline/u)
  assert.match(source, /className: 'codingns4dsh-model-icon'/u)
  assert.match(source, /className: 'codingns4dsh-model-effort'/u)
  assert.match(source, /data-composer-card\].*width:0;flex:1 1 0/u)
  assert.match(source, /codingns4dsh-model-root/u)
  assert.match(source, /conversation\.input\.model.*select\{[\s\S]*max-width:min\(150px,45cqw\)/u)
  assert.match(source, /const nativeTriggerStyle = \{ width: '100%'/u)
  assert.match(source, /@keyframes codingns4dsh-cli-model-scroll/u)
  assert.match(source, /ResizeObserver/u)
  assert.match(source, /data-overflow.*String\(scrollDistance > 0\)/u)
  assert.match(source, /const modelNameStyle = \{ minWidth: 0, maxWidth: 150, flex: '0 1 150px'/u)
  assert.doesNotMatch(source, /const modelNameStyle = \{[^}]*textOverflow/u)
  assert.match(source, /const agentRootStyle = \{[^}]*flex: '0 0 auto'/u)
  assert.match(source, /const agentTriggerLabelStyle = \{ flex: '0 0 auto', whiteSpace: 'nowrap'/u)
  // 顺序兜底：权限/规划组固定排在快捷短语之后，不依赖 JS 挂载时序。
  assert.match(quickPhraseSource, /\[data-composer-card\] \[class\*="_modes"\]\{order:\$\{QUICK_PHRASE_PERMISSION_ORDER\}\}/u)
})

test('上下文计量 dock 保留稳定行高，避免数值投影短暂缺失时工具栏抖动', async () => {
  const source = await readFile(join(projectRoot, 'src/client/cli-slots.ts'), 'utf8')
  assert.match(source, /\[data-composer-card\] \+ div\{box-sizing:border-box;min-height:26px;align-items:center\}/u)
  assert.match(source, /svg\[viewBox="0 0 14 14"\] circle:last-child\{transition:stroke-dasharray \.18s ease,stroke \.18s ease\}/u)
})

test('订阅悬浮框按内容自适应且不产生横向滚动', async () => {
  const source = await readFile(join(projectRoot, 'src/client/subscription-slot.ts'), 'utf8')
  assert.match(source, /width: 'max-content'/u)
  assert.match(source, /maxWidth: 'min\(400px, calc\(100vw - 24px\)\)'/u)
  assert.match(source, /tableLayout: 'fixed'/u)
  assert.match(source, /overflow: 'visible'/u)
  assert.doesNotMatch(source, /sub2apiTableScrollStyle = \{ overflowX:/u)
})

test('官方余额统一复用适配器 Logo，并以进度条和到期倒计时展示', async () => {
  const source = await readFile(join(projectRoot, 'src/client/subscription-slot.ts'), 'utf8')
  assert.match(source, /const adapterIconSource = providerIconUrl\(adapterId \?\? 'dsh'\)/u)
  assert.match(source, /const providerBalanceRemaining = providerBalance === undefined \? null : balancePercent\(providerBalance\.remaining, providerBalance\.total\)/u)
  assert.match(source, /providerBalanceRemaining !== null\s*\? createRemainingRing\(providerBalanceRemaining\)/u)
  assert.match(source, /usage\.providerBalancePlanLabel/u)
  assert.match(source, /usage\.planName\?\.trim\(\)/u)
  assert.match(source, /role: 'progressbar'/u)
  assert.match(source, /function summarizeProviderBalance/u)
  assert.match(source, /function formatExpiryCountdown/u)
  assert.match(source, /usage\.expiresIn/u)
  assert.doesNotMatch(source, /src: deepseekIconSource, alt: '', width: 18, height: 18[\s\S]*deepseekIconSource !== undefined/u)
})

test('Codex 订阅展示重置次数与点数，并经确认模态框触发重置', async () => {
  const source = await readFile(join(projectRoot, 'src/client/subscription-slot.ts'), 'utf8')
  assert.match(source, /usage\.creditBalanceLabel/u)
  assert.match(source, /usage\.resetCreditsLabel/u)
  assert.match(source, /usage\.resetCreditsExpiresAt/u)
  assert.match(source, /usage\.resetButton/u)
  assert.match(source, /'subscription\/reset'/u)
  assert.match(source, /createElement\(ResetConfirmDialog/u)
  assert.match(source, /useDismissOnOutsidePointer\(resetDialogRef, resetOpen && !resetPending, closeResetDialog\)/u)
  assert.match(source, /'aria-modal': true/u)
  assert.match(source, /subscriptionUsageCache\.delete\(cacheKey\)/u)
  assert.match(source, /refreshRef\.current = refresh/u)
})

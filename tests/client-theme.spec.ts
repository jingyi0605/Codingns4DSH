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
} from '../dist/client/theme.js'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('表单控件使用 DSH 真实主题令牌', () => {
  assert.match(String(dshFieldStyle.background), /--dsw-specific-input-major/u)
  assert.match(String(dshFieldStyle.color), /--dsw-alias-label-primary/u)
  assert.match(String(dshFieldStyle.border), /--dsw-alias-border-l2/u)
  assert.match(String(dshButtonStyle.background), /--dsw-alias-button-elevated-fill/u)
  assert.match(String(dshButtonStyle.color), /--dsw-alias-label-primary/u)
})

test('弹窗表面同时设置 DSH 背景、前景和阴影', () => {
  assert.match(String(dshPopupSurfaceStyle.background), /--dsw-specific-menu/u)
  assert.match(String(dshPopupSurfaceStyle.color), /--dsw-alias-label-primary/u)
  assert.match(String(dshPopupSurfaceStyle.boxShadow), /--dsw-elevation-prominent/u)
  assert.match(dshThemeColor.overlay, /--dsw-alias-bg-mask-1/u)
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
  assert.equal(source.includes('dshFieldStyle'), true)
  assert.equal(source.includes('dshButtonStyle'), true)
  assert.equal(source.includes('dshPopupSurfaceStyle'), true)
  assert.equal(source.includes(dshThemeColor.labelPrimary), false, '组件应复用主题样式或令牌对象，不应复制令牌字符串')
})

test('切换外部 Agent 时模型选择器立即显示可访问的旋转加载状态', async () => {
  const source = await readFile(join(projectRoot, 'src/client/cli-slots.ts'), 'utf8')

  assert.match(source, /@keyframes dsh-codingns-cli-spin/u)
  assert.match(source, /className: 'dsh-codingns-cli-spinner'/u)
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
    readFile(join(projectRoot, 'dist/client/bundle.js'), 'utf8'),
  ])

  assert.match(slotSource, /id: 'dsh-codingns-agent',[\s\S]*?order: -20/u)
  assert.match(slotSource, /id: 'dsh-codingns-model',[\s\S]*?order: -10/u)
  assert.doesNotMatch(slotSource, /slots\.inject\('conversation\.input\.left'/u)
  assert.match(slotSource, /className: 'dsh-codingns-agent-trigger'/u)
  assert.match(slotSource, /className: 'dsh-codingns-agent-option'/u)
  assert.match(slotSource, /role: 'menuitemradio'/u)
  assert.match(slotSource, /CIRCULAR_PROVIDER_ICON_IDS = new Set\(\['gemini', 'grok'\]\)/u)
  assert.match(slotSource, /CIRCULAR_PROVIDER_ICON_IDS\.has\(adapterId\) \? \{ \.\.\.style, borderRadius: '50%' \} : style/u)
  assert.equal(slotSource.match(/createElement\(NativeDropdownChevron/g)?.length, 2)
  assert.match(slotSource, /viewBox: '0 0 14 14'/u)
  assert.match(slotSource, /M11\.8486 5\.5L11\.4238 5\.92383/u)
  assert.doesNotMatch(slotSource, /⌄/u)

  for (const adapterId of ['dsh', 'command-code', 'claude-code', 'kimi', 'gemini', 'pi', 'codex', 'opencode', 'grok']) {
    assert.match(iconSource, new RegExp(`(?:['"]${adapterId}['"]|\\b${adapterId}):`, 'u'), `${adapterId} 缺少 Logo 映射`)
  }
  assert.match(bundleSource, /data:image\/(?:png|svg\+xml);base64,/u, 'Client 单文件包应内联 Provider Logo')
})

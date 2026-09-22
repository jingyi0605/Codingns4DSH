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

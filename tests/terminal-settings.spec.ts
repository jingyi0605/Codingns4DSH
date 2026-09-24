import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODINGNS_TERMINAL_ENHANCEMENT_FIELD,
  DEFAULT_CODINGNS_SETTINGS,
  DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
} from '../data/build/dist/shared/index.js'
import { CodingNsSettingsSchema } from '../data/build/dist/host/settings.js'

test('终端强化默认继承 DSH 主题并使用系统推荐 profile', () => {
  assert.equal(CODINGNS_TERMINAL_ENHANCEMENT_FIELD, 'terminalEnhancement')
  assert.deepEqual(DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS, {
    bindingScope: 'workspace',
    defaultProfile: 'system',
    appearance: {
      theme: 'inherit',
      background: null,
      foreground: null,
      cursorColor: null,
      fontFamily: null,
      fontSize: null,
      lineHeight: null,
      cursorStyle: null,
      cursorBlink: null,
      scrollback: null,
    },
  })
  assert.equal(DEFAULT_CODINGNS_SETTINGS.modules.terminalEnhancement, undefined)
})

test('终端设置 schema 接受边界值和受控外观字段', () => {
  const resolved = CodingNsSettingsSchema({
    ...DEFAULT_CODINGNS_SETTINGS,
    terminalEnhancement: {
      bindingScope: 'session',
      defaultProfile: 'git-bash',
      appearance: {
        theme: 'custom',
        background: '#001122',
        foreground: '#AABBCC',
        cursorColor: '#abcdef',
        fontFamily: 'JetBrains Mono',
        fontSize: 32,
        lineHeight: 2,
        cursorStyle: 'underline',
        cursorBlink: true,
        scrollback: 100000,
      },
    },
  })
  assert.equal(resolved.terminalEnhancement.defaultProfile, 'git-bash')
  assert.equal(resolved.terminalEnhancement.bindingScope, 'session')
  assert.equal(resolved.terminalEnhancement.appearance.fontSize, 32)
})

test('旧终端设置缺少绑定范围时默认按工作区绑定', () => {
  const resolved = CodingNsSettingsSchema({
    ...DEFAULT_CODINGNS_SETTINGS,
    terminalEnhancement: {
      defaultProfile: 'system',
      appearance: { theme: 'inherit' },
    },
  })
  assert.equal(resolved.terminalEnhancement.bindingScope, 'workspace')
})

test('终端设置 schema 拒绝非法颜色、控制字符和越界数值', () => {
  const invalid = (patch: Record<string, unknown>): unknown => ({
    ...DEFAULT_CODINGNS_SETTINGS,
    terminalEnhancement: {
      ...DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
      appearance: { ...DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS.appearance, ...patch },
    },
  })

  assert.throws(() => CodingNsSettingsSchema(invalid({ background: 'red' }) as never), /appearance\.background/u)
  assert.throws(() => CodingNsSettingsSchema(invalid({ fontFamily: 'Mono\nInjected' }) as never), /appearance\.fontFamily/u)
  assert.throws(() => CodingNsSettingsSchema(invalid({ fontSize: 9 }) as never), /appearance\.fontSize/u)
  assert.throws(() => CodingNsSettingsSchema(invalid({ lineHeight: 2.1 }) as never), /appearance\.lineHeight/u)
  assert.throws(() => CodingNsSettingsSchema(invalid({ scrollback: 999 }) as never), /appearance\.scrollback/u)
  assert.throws(() => CodingNsSettingsSchema({
    ...DEFAULT_CODINGNS_SETTINGS,
    terminalEnhancement: {
      ...DEFAULT_TERMINAL_ENHANCEMENT_SETTINGS,
      bindingScope: 'invalid',
    },
  } as never), /bindingScope/u)
})

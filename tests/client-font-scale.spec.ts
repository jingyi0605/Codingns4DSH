import assert from 'node:assert/strict'
import test from 'node:test'
import { CODINGNS_FONT_BASE_PX, installFontScale, readFontBase, uiFontSize } from '../src/client/font-scale.js'

test('uiFontSize 在缺少 DSH 字号变量时回落到原像素值', () => {
  const expression = uiFontSize(13)
  // 变量缺失时表达式求值为 14px / 14 * 13 = 13px，与替换前的固定像素完全一致，
  // 因此 rc.2 / alpha.1 上的界面尺寸不会因为这次改动而变化。
  assert.match(expression, /var\(--codingns-font-base,\s*14px\)/u)
  assert.match(expression, /\/\s*14\s*\*\s*13\)$/u)
  assert.equal(CODINGNS_FONT_BASE_PX, 14)
  // 小数与整数都按同一模板换算。
  assert.match(uiFontSize(11.5), /\*\s*11\.5\)$/u)
})

test('installFontScale 写入指向 DSH 正文字号的基准变量并可清理', () => {
  const properties = new Map<string, string>()
  const doc = createDoc(properties)
  const dispose = installFontScale(doc)
  // 只写插件自己的变量，指向 DSH 的正文角色变量并带默认值兜底。
  assert.equal(properties.get('--codingns-font-base'), 'var(--dsh-content-font-size, 14px)')
  assert.equal(readFontBase(doc), 'var(--dsh-content-font-size, 14px)')
  dispose()
  assert.equal(properties.has('--codingns-font-base'), false)
})

test('installFontScale 复原安装前的变量值而不是一律删除', () => {
  const properties = new Map<string, string>([['--codingns-font-base', '16px']])
  const doc = createDoc(properties)
  const dispose = installFontScale(doc)
  assert.notEqual(properties.get('--codingns-font-base'), '16px')
  dispose()
  assert.equal(properties.get('--codingns-font-base'), '16px')
})

test('缺少 document 时安装与读取都安全降级', () => {
  const emptyDoc = { documentElement: undefined } as unknown as Document
  const dispose = installFontScale(emptyDoc)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(readFontBase(emptyDoc), undefined)
  assert.equal(readFontBase(undefined), undefined)
})

function createDoc(properties: Map<string, string>): Document {
  const root = {
    style: {
      getPropertyValue: (name: string): string => properties.get(name) ?? '',
      setProperty: (name: string, value: string): void => { properties.set(name, value) },
      removeProperty: (name: string): void => { properties.delete(name) },
    },
  }
  return { documentElement: root } as unknown as Document
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalDeviceAttributeResponses } from '../data/build/dist/shared/terminal-input.js'

test('终端输入过滤器移除 DA1/DA2 响应但保留普通 CSI 输入', () => {
  assert.equal(
    stripTerminalDeviceAttributeResponses('ls\u001b[?1;2c\u001b[>0;276;0c'),
    'ls',
  )
  assert.equal(stripTerminalDeviceAttributeResponses('\u001b[31c'), '\u001b[31c')
})

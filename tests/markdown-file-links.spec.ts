import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeMarkdownFileLinks } from '../src/client/markdown-file-links.ts'

test('normalizes agy document destinations for the native file renderer', () => {
  const message = [
    '[汇报](file:///E:/提交材料/汇报(终稿).pptx)',
    '[讲稿](<file:///E:/提交材料/逐页 讲稿.txt#L12> "交付")',
    '[笔记][doc]',
    '',
    '[doc]: FILE:///home/user/%E6%96%87%E6%A1%A3%23v2.md',
  ].join('\n')
  assert.equal(normalizeMarkdownFileLinks(message), [
    '[汇报](E:/提交材料/汇报(终稿).pptx)',
    '[讲稿](<E:/提交材料/逐页 讲稿.txt#L12> "交付")',
    '[笔记][doc]',
    '',
    '[doc]: /home/user/%E6%96%87%E6%A1%A3%23v2.md',
  ].join('\n'))
})

test('preserves literal examples, images and other link destinations', () => {
  const message = [
    '[Web](https://example.com/file:///E:/test.md)',
    '[Share](file://server/share/test.md)',
    '[Path](E:/test.md)',
    '![Image](file:///E:/test.png)',
    '',
    '`[Code](file:///E:/test.md)`',
    '',
    '```md',
    '[Code block](file:///E:/test.md)',
    '```',
  ].join('\n')
  assert.equal(normalizeMarkdownFileLinks(message), message)
})

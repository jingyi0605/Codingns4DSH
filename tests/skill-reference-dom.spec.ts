import assert from 'node:assert/strict'
import test from 'node:test'
import { findSkillReferenceMentions } from '../data/build/dist/client/skill-reference-dom.js'

test('Skill 引用只识别已索引的独立斜杠令牌', () => {
  const mentions = findSkillReferenceMentions('请使用 /pdf 检查 /Docs 继续，并忽略 https://example.com/pdf 与 /unknown。', new Set(['pdf', 'docs']))
  assert.deepEqual(mentions, [
    { raw: '/pdf', name: 'pdf', start: 4, end: 8 },
    { raw: '/Docs', name: 'docs', start: 12, end: 17 },
  ])
})

test('Skill 引用匹配保留规范名称并支持行首令牌', () => {
  assert.deepEqual(findSkillReferenceMentions('/Documents', new Set(['documents'])), [
    { raw: '/Documents', name: 'documents', start: 0, end: 10 },
  ])
  assert.deepEqual(findSkillReferenceMentions('path/to/pdf', new Set(['pdf'])), [])
})

test('Skill 引用支持 Provider 限定名称，仍然排除 URL 和普通路径', () => {
  const text = '/local:summary 参数 /apps/web:deploy 执行 https://example.com/local:summary'
  const mentions = findSkillReferenceMentions(text, new Set(['local:summary', 'apps/web:deploy']))
  assert.deepEqual(mentions.map((item) => item.name), ['local:summary', 'apps/web:deploy'])
})

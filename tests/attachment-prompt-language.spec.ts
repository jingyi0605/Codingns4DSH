import assert from 'node:assert/strict'
import test from 'node:test'
import { attachmentFileNotice } from '../src/shared/attachment-prompts.js'
import { promptWithAttachmentPaths, buildKimiUserInput, buildClaudeUserContent } from '../src/host/cli-adapters/attachment-utils.js'
import { GeminiCliDriver } from '../src/host/cli-adapters/gemini-driver.js'

test('all attachment formatters use the selected language and preserve exact file identity', async () => {
  const attachment = { kind: 'file' as const, name: '报告 "最终".txt', path: 'C:\\工作 目录\\报告 "最终".txt' }
  const prefixes = { en: 'Attached file', fr: 'Fichier joint', de: 'Angehängte Datei', ja: '添付ファイル', zh: '附件文件' }
  for (const language of ['en', 'fr', 'de', 'ja', 'zh'] as const) {
    const notice = attachmentFileNotice(attachment, language)
    assert.ok(notice.startsWith(prefixes[language]))
    for (const text of [notice, promptWithAttachmentPaths('Task', [attachment], language),
      await buildKimiUserInput('Task', [attachment], language), (await buildClaudeUserContent('Task', [attachment], language))[0].text]) {
      assert.ok(typeof text === 'string')
      assert.ok(text.includes(attachment.path))
      assert.ok(text.includes(attachment.name))
      if (language !== 'zh') assert.doesNotMatch(text, /请读取并处理|请使用工具读取|附件「/u)
    }
  }
  assert.equal(attachmentFileNotice({ path: '/tmp/file' }), '附件文件位于：/tmp/file\n请使用工具读取该文件的内容。')
  assert.equal(promptWithAttachmentPaths('Task', []), 'Task')
})

test('a text CLI receives translated late attachment instructions in its actual arguments', () => {
  const input = { sessionId: 'session', messages: [], prompt: 'Read the file.', translationLanguage: 'en' as const,
    attachments: [{ kind: 'file' as const, path: '/tmp/中文 目录/报告.txt', name: '报告.txt' }] }
  const driver = new GeminiCliDriver({ binaries: ['fake'] })
  const args = (driver as any).buildArgs(input) as string[]
  assert.equal(args[1], 'Read the file.\nPlease read and process the following message attachments:\nAttachment「报告.txt」：@/tmp/中文 目录/报告.txt')
  assert.deepEqual(args.slice(-2), ['--include-directories', '/tmp/中文 目录'])
  driver.dispose()
})

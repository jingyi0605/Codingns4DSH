import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('窗口列宽变化后重放 -J 合并后的历史，修复 tmux 历史行不重排', async () => {
  const source = await readFile(join(projectRoot, 'src/host/terminal/terminal-service.ts'), 'utf8')

  // tmux 只按新宽度渲染后续输出，不会重排已有内容；宽度变化后必须重新抓取
  // capture-pane -J 合并的长逻辑行并作为 snapshot 重放，否则历史行永远停在
  // 旧宽度、右侧留白。
  assert.match(source, /const widthChanged = record\.cols !== cols/u)
  assert.match(source, /if \(widthChanged\) this\.scheduleHistoryReflow\(identity\)/u)
  assert.match(source, /private async reflowHistory\(/u)
  assert.match(source, /pushSnapshot\(this\.info\(current, follower\.attachmentId\), captured\)/u)
  // 拖动窗口/软键盘动画会连续触发 resize，必须防抖合并成一次重放。
  assert.match(source, /HISTORY_REFLOW_DEBOUNCE_MS = 300/u)
  assert.match(source, /clearTimeout\(pending\)/u)
  // 服务卸载时清理待执行的重放，避免计时器泄漏。
  assert.match(source, /for \(const timer of this\.historyReflowTimers\.values\(\)\) clearTimeout\(timer\)/u)
})

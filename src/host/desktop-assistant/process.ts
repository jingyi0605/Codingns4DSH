import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** 保留有上限的原生启动诊断；正常回收不产生降级提示。 */
export function observeDesktopAssistantProcess(child: ChildProcessWithoutNullStreams,
  onError: (message: string) => void, onExit: () => void, isStopping: () => boolean): Promise<void> {
  let stderr = '', reported = false
  const failure = (message: string): void => {
    if (reported || isStopping()) return
    reported = true
    // 导航错误可能包含一次性启动 URL，不把实例令牌放进界面。
    onError(message.replace(/([?&]token=)[^\s&"'<>]+/gu, '$1[redacted]').slice(0, 500))
  }
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 4096) })
  child.once('error', (error) => failure(`原生悬浮启动失败：${error.message}`))
  // EPIPE 常常先于 close 到达；等待退出诊断，避免它掩盖真正的脚本异常。
  child.stdin.on('error', () => {})
  return new Promise((resolve) => {
    child.once('close', (code, signal) => {
      const reason = stderr.trim() || `code=${String(code)}, signal=${signal ?? 'none'}`
      failure(`原生悬浮进程已退出：${reason}`)
      onExit(); resolve()
    })
  })
}

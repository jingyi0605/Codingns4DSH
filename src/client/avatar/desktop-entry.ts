import { createElement, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { DesktopAssistantFrame } from '../../shared/desktop-assistant.js'
import { DesktopAssistantAvatar, DesktopAssistantBoundary, sendDesktopAssistantEvent } from './desktop-view.js'

function Companion(): ReactNode {
  const [frame, setFrame] = useState<DesktopAssistantFrame>()
  useEffect(() => {
    let stopped = false, failures = 0, timer: ReturnType<typeof setTimeout>
    const abort = new AbortController()
    const poll = async (): Promise<void> => {
      try {
        const response = await fetch('/state', { signal: abort.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('companion_state_unavailable')
        const next = await response.json() as DesktopAssistantFrame | null
        if (!stopped) { setFrame(next ?? undefined); failures = 0 }
      } catch { if (!stopped && ++failures >= 3) sendDesktopAssistantEvent('error', 'companion_state_unavailable') }
      if (!stopped) timer = setTimeout(() => { void poll() }, 250)
    }
    void poll()
    return () => { stopped = true; abort.abort(); clearTimeout(timer) }
  }, [])
  // 隐藏时卸载动画；恢复时沿用同一套形象数据，不启动麦克风或第二份工作台。
  return frame?.visible ? createElement(DesktopAssistantAvatar, { key: JSON.stringify(frame.model), frame }) : null
}
createRoot(document.getElementById('root')!).render(createElement(DesktopAssistantBoundary, null, createElement(Companion)))

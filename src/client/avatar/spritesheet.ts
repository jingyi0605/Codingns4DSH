import { createElement, useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import { assistantSpriteMotion, assistantSpriteReactionMotion } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarState, AssistantSpriteMotion } from '../../shared/assistant-avatar.js'
import type { AssistantAvatarRendererProps } from './registry.js'

/** 可测试的时钟：只推进当前动作实际拥有的帧，暂停后不追赶后台时间。 */
export class AssistantSpriteClock {
  private frame = 0
  private last: number | undefined
  private motion: AssistantSpriteMotion | undefined
  constructor(private state: AssistantAvatarState) {}
  setState(state: AssistantAvatarState): void { if (state !== this.state) { this.state = state; this.frame = 0; this.last = undefined } }
  setMotion(motion: AssistantSpriteMotion): void {
    if (this.motion?.row === motion.row && this.motion.frames === motion.frames && this.motion.interval === motion.interval) return
    this.motion = motion; this.frame = 0; this.last = undefined
  }
  reset(): void { this.last = undefined }
  tick(now: number): { row: number; frame: number } {
    const motion = this.motion ?? assistantSpriteMotion(this.state)
    if (this.last === undefined) this.last = now
    const steps = Math.floor(Math.max(0, now - this.last) / motion.interval)
    this.frame = (this.frame + steps) % motion.frames
    this.last += steps * motion.interval
    return { row: motion.row, frame: this.frame }
  }
}

/** 参考 Signalight 的纯 DOM 图集渲染，不引入 Pixi 或上游会话逻辑。 */
export function SpriteSheetAssistantAvatar({ model, state, reaction, size, onError, onLoadProgress }: AssistantAvatarRendererProps): ReactElement {
  const element = useRef<HTMLDivElement | null>(null)
  const motion = assistantSpriteReactionMotion(model, state, reaction)
  const motionRef = useRef(motion)
  motionRef.current = motion
  useEffect(() => {
    // 动画被暂停时也要立即呈现新状态的第一帧。
    if (element.current !== null) element.current.style.backgroundPosition = `0% ${motion.row * 100 / (model.spriteVersion === 2 ? 10 : 8)}%`
  }, [motion.row, motion.frames, motion.interval, model.spriteVersion])
  useEffect(() => {
    const target = element.current
    if (target === null) return undefined
    onLoadProgress?.({ phase: 'resources' })
    const image = new Image()
    let disposed = false
    let frameId = 0
    const clock = new AssistantSpriteClock('idle')
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const rows = model.spriteVersion === 2 ? 11 : 9
    const paint = (now: number): void => {
      clock.setMotion(motionRef.current)
      const frame = clock.tick(now)
      // 百分比按整张背景减去一帧的剩余范围定位，窄屏缩小也不会裁掉角色。
      target.style.backgroundPosition = `${frame.frame * 100 / 7}% ${frame.row * 100 / (rows - 1)}%`
    }
    const tick = (now: number): void => { if (disposed) return; paint(now); frameId = requestAnimationFrame(tick) }
    const refresh = (): void => {
      cancelAnimationFrame(frameId)
      clock.reset()
      paint(performance.now())
      if (!disposed && !document.hidden && !media?.matches) frameId = requestAnimationFrame(tick)
    }
    image.onload = () => {
      if (disposed) return
      if (image.naturalWidth !== 192 * 8 || image.naturalHeight !== 208 * rows) {
        onError(`avatar_sprite_dimensions_invalid: expected 1536x${208 * rows}`)
        return
      }
      target.style.backgroundImage = `url(${JSON.stringify(model.source)})`
      onLoadProgress?.({ phase: 'ready', loaded: 1, total: 1 })
      refresh()
    }
    image.onerror = () => { if (!disposed) onError('avatar_sprite_load_failed') }
    image.src = model.source
    document.addEventListener('visibilitychange', refresh)
    media?.addEventListener('change', refresh)
    return () => {
      disposed = true
      image.onload = null; image.onerror = null
      cancelAnimationFrame(frameId)
      document.removeEventListener('visibilitychange', refresh)
      media?.removeEventListener('change', refresh)
    }
  }, [model.source, model.spriteVersion, onError, onLoadProgress])
  return createElement('div', { ref: element, 'aria-hidden': true, style: { width: size, aspectRatio: '192 / 208',
    maxWidth: '100%', backgroundRepeat: 'no-repeat', backgroundSize: `800% ${model.spriteVersion === 2 ? 1100 : 900}%` } })
}

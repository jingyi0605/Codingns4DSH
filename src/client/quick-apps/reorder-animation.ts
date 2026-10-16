/** Animate grid moves on the outer shortcut, independently of the tile's jiggle. */
export function createQuickAppReorderAnimation() {
  let positions = new Map<HTMLElement, { left: number; top: number }>()
  const animations = new Map<HTMLElement, Animation>()
  const dispose = () => {
    for (const animation of animations.values()) animation.cancel()
    animations.clear()
    positions.clear()
  }
  return {
    dispose,
    update(root: HTMLElement) {
      const reducedMotion = root.ownerDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches === true
      const next = new Map<HTMLElement, { left: number; top: number }>()
      for (const node of root.querySelectorAll<HTMLElement>(':scope > [data-quick-app-id]')) {
        const position = { left: node.offsetLeft, top: node.offsetTop }
        next.set(node, position)
        const previous = positions.get(node)
        if (reducedMotion) { animations.get(node)?.cancel(); animations.delete(node); continue }
        if (!previous || typeof node.animate !== 'function' || previous.left === position.left && previous.top === position.top) continue
        const visual = node.getBoundingClientRect()
        animations.get(node)?.cancel()
        const layout = node.getBoundingClientRect()
        const x = previous.left - position.left + visual.left - layout.left
        const y = previous.top - position.top + visual.top - layout.top
        if (x === 0 && y === 0) { animations.delete(node); continue }
        const animation = node.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }],
          { duration: 220, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
        animations.set(node, animation)
        void animation.finished.then(() => { if (animations.get(node) === animation) animations.delete(node) }, () => undefined)
      }
      for (const [node, animation] of animations) if (!next.has(node)) { animation.cancel(); animations.delete(node) }
      positions = next
    },
  }
}

import { rmSync } from 'node:fs'

// dist 只包含可重建产物；先清理可避免已删除源码留下陈旧声明或浏览器分块。
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true })

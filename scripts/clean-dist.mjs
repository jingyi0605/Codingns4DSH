import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认清理仓库内的 data/build；参数仅用于测试隔离。
const buildDir = process.argv[2] ?? fileURLToPath(new URL('../data/build/', import.meta.url))

// data/build/dist 与 data/build/h5 是可重建产物；先清理可避免已删除源码留下陈旧声明或浏览器分块。
// data/build/npm 存放 scripts/publish-npm-package.sh 打出的 tarball，必须保留：整目录删除会让
// 打包后任何一次 build/test/pack（含并发 dev:watch）把刚生成的 tgz 连同目录一起删掉。
for (const name of ['dist', 'h5']) {
  rmSync(join(buildDir, name), { recursive: true, force: true })
}

import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createFileManagementFeature } from '../data/build/dist/host/features/file-management.js'

interface ResourceScope {
  readonly disposers: Array<() => void | Promise<void>>
  add(disposer: () => void | Promise<void>): void
}

async function call(table: CodingNsRpcTable, endpoint: string, payload: unknown): Promise<unknown> {
  const result = await createCodingNsRpcHandler(table)(endpoint, payload, new AbortController().signal)
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

test('文件管理 Host 模块支持编辑、目录操作、复制移动和 Git 排除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-file-management-'))
  const table = new CodingNsRpcTable()
  const resources: ResourceScope = { disposers: [], add(disposer) { this.disposers.push(disposer) } }
  const feature = createFileManagementFeature()
  feature.start({
    descriptor: feature.descriptor,
    resources,
    services: { rpc: table, listWorkspaceRoots: () => [root] },
  })
  try {
    await call(table, 'fileManagement/create-directory', { path: join(root, 'src') })
    await call(table, 'fileManagement/create-file', { path: join(root, 'src', 'README.md') })
    await call(table, 'fileManagement/write', { path: join(root, 'src', 'README.md'), content: '# 文件\n' })
    const read = await call(table, 'fileManagement/read', { path: join(root, 'src', 'README.md') }) as { content: string }
    assert.equal(read.content, '# 文件\n')

    await writeFile(join(root, 'src', 'archive.bin'), '二进制下载内容', { encoding: 'utf8' })
    const download = await call(table, 'fileManagement/download', { path: join(root, 'src', 'archive.bin') }) as {
      fileName: string
      mimeType: string
      contentBase64: string
    }
    assert.equal(download.fileName, 'archive.bin')
    assert.equal(download.mimeType, 'application/octet-stream')
    assert.equal(Buffer.from(download.contentBase64, 'base64').toString('utf8'), '二进制下载内容')

    await call(table, 'fileManagement/copy', { paths: [join(root, 'src', 'README.md')], destination: root })
    await call(table, 'fileManagement/move', { paths: [join(root, 'README.md')], destination: join(root, 'src') })
    await call(table, 'fileManagement/git-ignore', { paths: [join(root, 'src', 'README.md')] })
    assert.match(await readFile(join(root, '.gitignore'), 'utf8'), /src\/README\.md/u)

    await assert.rejects(() => call(table, 'fileManagement/read', { path: join(root, '..', 'outside.txt') }), /不在已知工作区/u)
    await call(table, 'fileManagement/delete', { paths: [join(root, 'src', 'README.md')] })
  } finally {
    for (const dispose of resources.disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodingNsImageArtifact } from '../data/build/dist/host/image-artifact-store.js'

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
])

test('图片产物读取只接受受支持的真实图片，并支持 Codex 内联 base64', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-image-artifact-test-'))
  try {
    const path = join(directory, 'generated.jpg')
    await writeFile(path, PNG)
    const saved = await readCodingNsImageArtifact({ type: 'image-artifact', path })
    assert.equal(saved.mediaType, 'image/png')
    await assert.rejects(readCodingNsImageArtifact({ type: 'image-artifact', path, mediaType: 'image/jpeg' }), /MIME 类型与文件内容不一致/)

    const image = await readCodingNsImageArtifact({
      type: 'image-artifact',
      data: Buffer.from(PNG).toString('base64'),
      mediaType: 'image/png',
      name: 'generated.png',
    })
    assert.equal(image.mediaType, 'image/png')
    assert.deepEqual([...image.data], [...PNG])
    assert.equal(image.name, 'generated.png')
    await assert.rejects(
      readCodingNsImageArtifact({
        type: 'image-artifact',
        data: `data:image/jpeg;base64,${Buffer.from(PNG).toString('base64')}`,
      }),
      /MIME 类型与文件内容不一致/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('图片产物不能通过相对路径或远程 URL 越过 Host 读取边界', async () => {
  await assert.rejects(
    readCodingNsImageArtifact({ type: 'image-artifact', path: '../generated.png' }),
    /路径或内联数据无效/,
  )
  await assert.rejects(
    readCodingNsImageArtifact({ type: 'image-artifact', data: 'https://example.com/generated.png' }),
    /路径或内联数据无效/,
  )
})

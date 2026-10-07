import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { ASSISTANT_AVATAR_CATALOG_URL } from '../data/build/dist/shared/assistant-avatar-catalog.js'
import { BUILTIN_ASSISTANT_AVATAR_ADAPTERS } from '../data/build/dist/shared/assistant-avatar-adapters.js'

const root = new URL('../', import.meta.url)
const catalog = JSON.parse(await readFile(new URL('avatar-packages/catalog.json', root), 'utf8'))
const documentPath = decodeURIComponent(new URL(ASSISTANT_AVATAR_CATALOG_URL).pathname.split('/blob/main/')[1]!)
const document = await readFile(new URL(documentPath, root), 'utf8')

test('目录条目字段完整、序号连续，原始素材与许可固定到同一上游版本', () => {
  assert.equal(catalog.catalogVersion, 1)
  assert.ok(catalog.packages.length > 0)
  const ids = new Set<string>()
  const sources = new Set<string>()
  for (const [index, entry] of catalog.packages.entries()) {
    assert.equal(entry.number, index + 1)
    for (const key of ['id', 'name', 'repositoryUrl', 'author', 'description', 'remarks']) assert.ok(entry[key]?.trim(), `${entry.id}: ${key}`)
    assert.ok(!ids.has(entry.id), `重复形象 ID：${entry.id}`)
    assert.ok(!sources.has(entry.sourceManifestUrl), `重复素材清单：${entry.id}`)
    ids.add(entry.id); sources.add(entry.sourceManifestUrl)
    assert.match(entry.revision, /^[a-f0-9]{40}$/u)
    const repository = new URL(entry.repositoryUrl)
    assert.equal(repository.origin, 'https://github.com')
    assert.ok(entry.sourceManifestUrl.startsWith(`https://raw.githubusercontent.com${repository.pathname}/${entry.revision}/`))
    assert.ok(entry.licenseUrl.startsWith(`${entry.repositoryUrl}/blob/${entry.revision}/`))
    assert.ok(['codex-pet', 'dsh-live2d-pet', 'cubism-model'].includes(entry.format))
    assert.ok(entry.verification.files > 0 && entry.verification.bytes > 0)
  }
})

test('每个安装清单可由统一适配器解析，安装后保留目录中的作者与许可说明', async () => {
  const native = BUILTIN_ASSISTANT_AVATAR_ADAPTERS.find((adapter) => adapter.id === 'codingns-pack')!
  for (const entry of catalog.packages) {
    assert.equal(entry.manifestPath, `avatar-packages/manifests/${entry.id}.avatar.json`)
    assert.equal(entry.installManifestUrl, `https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/${entry.manifestPath}`)
    const manifest = JSON.parse(await readFile(new URL(entry.manifestPath, root), 'utf8'))
    assert.ok(native.matches(manifest))
    const model = native.parse(manifest, { manifestUrl: entry.installManifestUrl })
    assert.equal(model.id, `catalog-${entry.id}`)
    assert.equal(model.name, entry.name)
    assert.equal(model.package?.author, entry.author)
    assert.ok(model.package?.license)
    assert.ok(model.package?.homepage)
    const source = new URL(model.source)
    assert.equal(source.origin, 'https://raw.githubusercontent.com')
    assert.ok(source.pathname.includes(`/${entry.revision}/`))
    assert.equal(model.renderer, entry.format === 'codex-pet' ? 'spritesheet' : 'live2d')
  }
})

test('GitHub 页面链接落在实际文档，六列清单与机器索引、安装链接保持一致', () => {
  assert.ok(ASSISTANT_AVATAR_CATALOG_URL.startsWith(`${catalog.repositoryUrl}/blob/main/`))
  assert.ok(document.includes('| 序号 | 名称 | 仓库地址 | 作者 | 简介 | 备注 |'))
  const rows = document.split('\n').filter((line) => /^\| \d+ \|/u.test(line))
  assert.equal(rows.length, catalog.packages.length)
  for (const entry of catalog.packages) {
    assert.ok(rows[entry.number - 1]!.startsWith(`| ${entry.number} | ${entry.name} |`))
    assert.ok(document.includes(`[install-${entry.id}]: ${entry.installManifestUrl}`))
    assert.ok(document.includes(`[source-${entry.id}]: ${entry.sourceManifestUrl}`))
    assert.ok(document.includes(`[license-${entry.id}]: ${entry.licenseUrl}`))
  }
})

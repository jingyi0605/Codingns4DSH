import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageName = '@jingyi0605/codingns4dsh'
const linkScript = join(repositoryRoot, 'scripts/link-dsh-dev.mjs')
const cleanScript = join(repositoryRoot, 'scripts/clean-stage0-dev-link.sh')

function createProfile(home: string) {
  const profileRoot = join(home, 'profiles', 'stage0')
  mkdirSync(profileRoot, { recursive: true })
  writeFileSync(join(profileRoot, 'package.json'), '{"name":"dsh-profile-stage0"}\n', 'utf8')
  return profileRoot
}

function cleanEnvironment(root: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: join(root, 'user-home') }
  delete env.DSH_HOME
  delete env.DSH_STAGE0_HOME
  return env
}

test('stage0 开发链接默认落在专用 DSH_HOME，不会创建 Desktop ~/.dsh 链接', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-dev-link-'))
  try {
    const env = cleanEnvironment(root)
    const stage0Home = join(env.HOME as string, '.dsh-stage0-020')
    createProfile(stage0Home)
    const result = spawnSync(process.execPath, [linkScript, 'stage0'], {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)

    const target = join(stage0Home, 'profiles', 'stage0', 'node_modules', packageName)
    assert.equal(realpathSync(target), repositoryRoot)
    assert.equal(existsSync(join(env.HOME as string, '.dsh', 'profiles', 'stage0')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage0 开发链接拒绝显式使用 Desktop ~/.dsh', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-dev-link-guard-'))
  try {
    const env = cleanEnvironment(root)
    const desktopHome = join(env.HOME as string, '.dsh')
    mkdirSync(desktopHome, { recursive: true })
    env.DSH_HOME = desktopHome
    createProfile(desktopHome)

    const result = spawnSync(process.execPath, [linkScript, 'stage0'], {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /拒绝.*Desktop.*DSH_HOME/u)
    assert.equal(existsSync(join(desktopHome, 'profiles', 'stage0', 'node_modules', packageName)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage0 清理脚本处理 scoped 新链接和旧 dsh-codingns 链接', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-clean-link-'))
  try {
    const env = cleanEnvironment(root)
    const stage0Home = join(root, 'stage0-home')
    const profileRoot = createProfile(stage0Home)
    const nodeModules = join(profileRoot, 'node_modules')
    const scopedTarget = join(nodeModules, packageName)
    const legacyTarget = join(nodeModules, 'dsh-codingns')
    mkdirSync(dirname(scopedTarget), { recursive: true })
    symlinkSync(repositoryRoot, scopedTarget, 'dir')
    symlinkSync(repositoryRoot, legacyTarget, 'dir')
    env.DSH_STAGE0_HOME = stage0Home
    env.DSH_HOME = join(root, 'inherited-desktop-shell-home')

    const result = spawnSync('/bin/bash', [cleanScript], {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
    assert.equal(existsSync(scopedTarget), false)
    assert.equal(existsSync(legacyTarget), false)
    const scopedBackups = readdirSync(dirname(scopedTarget)).filter((name) => name.startsWith('codingns4dsh.bak-old-'))
    const legacyBackups = readdirSync(nodeModules).filter((name) => name.startsWith('dsh-codingns.bak-old-'))
    const backups = [...scopedBackups.map((name) => join(dirname(scopedTarget), name)), ...legacyBackups.map((name) => join(nodeModules, name))]
    assert.equal(backups.length, 2)
    assert.deepEqual(
      backups.map((path) => realpathSync(path)).sort(),
      [repositoryRoot, repositoryRoot],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stage0 清理脚本拒绝 Desktop ~/.dsh', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-clean-link-guard-'))
  try {
    const env = cleanEnvironment(root)
    const desktopHome = join(env.HOME as string, '.dsh')
    mkdirSync(desktopHome, { recursive: true })
    env.DSH_HOME = desktopHome
    const result = spawnSync('/bin/bash', [cleanScript], {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /拒绝.*Desktop.*清理/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

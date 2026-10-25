import { spawn, execFileSync } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../', import.meta.url))
const focused = process.argv.includes('--focused')
if (process.argv.slice(2).some(arg => arg !== '--focused')) throw new Error('Usage: node scripts/test-isolated.mjs [--focused]')
const root = await mkdtemp(join(tmpdir(), 'codingns-isolated-'))
const workspace = join(root, 'workspace')
const artifacts = join(root, 'artifacts')
const bin = join(root, 'bin')
for (const dir of [workspace, artifacts, bin, 'home', 'dsh', 'cache', 'config', 'state', 'tmp'].map(path => isAbsolute(path) ? path : join(root, path))) {
  await mkdir(dir, { recursive: true })
}
console.log(`Isolated validation: ${root}`)

// Copy the current files, including uncommitted work, without copying local profiles or secrets.
const files = [...new Set(execFileSync('git', ['ls-files', '-c', '--others', '--exclude-standard', '-z'], { cwd: source }).toString().split('\0').filter(Boolean))]
for (const file of files) {
  if (/^(?:data|node_modules|\.git)(?:\/|$)/u.test(file) || /(?:^|\/)\.env(?:\.|$)/u.test(file)) continue
  const from = join(source, file)
  const info = await lstat(from).catch(error => { if (error.code !== 'ENOENT') throw error })
  if (!info?.isFile()) {
    if (info?.isSymbolicLink()) throw new Error(`Repository symlink needs an explicit isolation policy: ${file}`)
    continue
  }
  const to = join(workspace, file)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to, constants.COPYFILE_FICLONE)
}

async function assertLocalLinks(directory, boundary) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await assertLocalLinks(path, boundary)
    else if (entry.isSymbolicLink()) {
      const target = await readlink(path)
      const location = relative(boundary, resolve(dirname(path), target))
      if (isAbsolute(target) || location === '..' || location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`Dependency symlink escapes the isolated copy: ${relative(boundary, path)}`)
      }
    }
  }
}
await assertLocalLinks(join(source, 'node_modules'), join(source, 'node_modules'))
await cp(join(source, 'node_modules'), join(workspace, 'node_modules'), {
  recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
})
for (const [name, command] of [['node', process.execPath], ['pnpm', execFileSync('which', ['pnpm']).toString().trim()], ['npm', execFileSync('which', ['npm']).toString().trim()]]) {
  await symlink(command, join(bin, name))
}
const env = {
  PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
  HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
  DSH_HOME: join(root, 'dsh'), TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
  XDG_CACHE_HOME: join(root, 'cache'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
  npm_config_cache: join(root, 'cache/npm'), npm_config_update_notifier: 'false',
  PNPM_HOME: bin, COREPACK_ENABLE_NETWORK: '0', CI: '1', LANG: 'en_US.UTF-8', TZ: 'UTC',
}
// Reuse only an explicitly selected browser executable; the driver creates a fresh profile.
if (process.env.QUICK_APPS_BROWSER_BIN) env.QUICK_APPS_BROWSER_BIN = process.env.QUICK_APPS_BROWSER_BIN
const results = []
async function run(name, command, args, cwd = workspace) {
  const log = join(artifacts, `${name}.log`)
  const stream = createWriteStream(log)
  const started = Date.now()
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream, { end: false })
  child.stderr.pipe(stream, { end: false })
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', code => resolveExit(code ?? 1))
  })
  await new Promise(resolveEnd => stream.end(resolveEnd))
  results.push({ name, exitCode, milliseconds: Date.now() - started, log })
  console.log(`${exitCode === 0 ? 'PASS' : 'FAIL'} ${name} (${Math.round((Date.now() - started) / 1000)}s): ${log}`)
  if (exitCode !== 0) console.error((await readFile(log, 'utf8')).split('\n').slice(-45).join('\n'))
  return exitCode === 0
}

await run('typecheck', join(bin, 'pnpm'), ['run', 'typecheck'])
await run('version', join(bin, 'pnpm'), ['run', 'version:check'])
await run('capability', join(bin, 'pnpm'), ['run', 'capability:check'])
await run('i18n', join(bin, 'pnpm'), ['run', 'i18n:check'])
if (await run('build', join(bin, 'pnpm'), ['run', 'build'])) {
  const tests = focused ? ['plugin-update.spec.ts', 'plugin-update-browser.spec.ts', 'client-settings-promo.spec.ts', 'client-entry.spec.ts'] : (await readdir(join(workspace, 'tests'))).filter(name => name.endsWith('.spec.ts')).sort()
  await run('tests', process.execPath, ['--import', './tests/register-css-loader.mjs', '--test', '--test-concurrency=1', ...tests.map(name => `tests/${name}`)])
  if (await run('pack', join(bin, 'npm'), ['pack', '--ignore-scripts', '--json', '--pack-destination', artifacts])) {
    const packed = JSON.parse(await readFile(join(artifacts, 'pack.log'), 'utf8'))
    const target = join(workspace, 'data/build/package-smoke')
    await mkdir(target, { recursive: true })
    await run('unpack', '/usr/bin/tar', ['-xzf', join(artifacts, packed[0].filename), '-C', target])
    await run('package-smoke', process.execPath, ['--input-type=module', '--eval', `
      import assert from 'node:assert/strict'
      import { access, readFile } from 'node:fs/promises'
      import { PluginUpdateService } from './data/build/dist/host/update/service.js'
      import { compareSemver } from './data/build/dist/shared/contracts/plugin-update.js'
      const manifest = JSON.parse(await readFile('./package.json', 'utf8'))
      for (const item of Object.values(manifest.exports)) {
        for (const path of typeof item === 'string' ? [item] : Object.values(item)) await access(path)
      }
      assert.equal(compareSemver('1.0.0-rc.10', '1.0.0-rc.9'), 1)
      const service = new PluginUpdateService({ dispose() {} }, () => undefined)
      const runtime = await service.runtime(true)
      assert.equal(runtime.runningHostVersion, manifest.version)
      assert.equal(runtime.applyBlockCode, 'UPDATE_CAPABILITY_UNAVAILABLE')
      service.dispose()
      console.log('Packed updater modules load; exports exist; unsupported manager stays blocked.')
    `], join(target, 'package'))
  }
}
await writeFile(join(artifacts, 'report.json'), JSON.stringify({ root, workspace, focused, isolatedEnvironment: env, results }, null, 2) + '\n')
console.log(`Report: ${join(artifacts, 'report.json')}`)
if (results.some(result => result.exitCode !== 0)) process.exitCode = 1

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installVoicePythonRuntime, runVoiceEnvironmentProcess, verifyVoicePythonDependencies, voicePythonArchiveCommand, voicePythonArtifact, type VoicePythonArtifact, type VoiceEnvironmentCommand } from '../src/host/features/voice-python-runtime.js'
import { voiceProcessEnvironment } from '../src/host/features/voice-process-environment.js'

const payload = Buffer.from('模拟固定发布包，不包含可执行解释器')
const artifact: VoicePythonArtifact = { target: 'fixture-target', url: 'https://example.test/python.tar.gz',
  sha256: createHash('sha256').update(payload).digest('hex'), executable: 'python/bin/python3' }
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'codingns-python-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  let extracts = 0
  const run: VoiceEnvironmentCommand = async (command, args, signal) => {
    signal.throwIfAborted()
    if (command === voicePythonArchiveCommand()) {
      extracts++
      const output = join(args[args.indexOf('-C') + 1]!, artifact.executable)
      await mkdir(join(output, '..'), { recursive: true }); await writeFile(output, 'valid-python-fixture')
    } else assert.equal(await readFile(command, 'utf8'), 'valid-python-fixture')
  }
  return { directory, run, extracts: () => extracts }
}

test('托管解释器固定版本、架构、摘要与官方来源，不支持的平台明确拒绝', () => {
  for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64']]) {
    const build = voicePythonArtifact(platform, arch)
    assert.match(build.url, /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/20251014\//u)
    assert.match(build.url, /3\.12\.12%2B20251014/u); assert.match(build.sha256, /^[a-f0-9]{64}$/u)
    assert.ok(build.executable.startsWith('python/'))
  }
  assert.throws(() => voicePythonArtifact('win32', 'arm64'), /暂不支持/u)
})

test('下载先校验摘要再解压，成功缓存复用，损坏解释器可自动恢复', async (t) => {
  const f = await fixture(t); let downloads = 0
  t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(payload, { headers: { 'content-length': String(payload.length) } }) })
  const progress: string[] = []
  const install = () => installVoicePythonRuntime(f.directory, artifact, new AbortController().signal, (phase) => progress.push(phase), f.run)
  const python = await install()
  assert.equal(downloads, 1); assert.equal(f.extracts(), 1)
  assert.equal(await install(), python); assert.equal(downloads, 1)
  await writeFile(python, 'broken')
  assert.equal(await install(), python); assert.equal(downloads, 2); assert.equal(f.extracts(), 2)
  assert.equal(await readFile(python, 'utf8'), 'valid-python-fixture')
  assert.ok(progress.some((phase) => phase.includes('下载')))
  assert.equal((await readdir(f.directory)).some((name) => name.startsWith('.prepare-') || name.endsWith('.previous')), false)
})

test('摘要不匹配或正文不完整不能执行解压，失败清除暂存目录', async (t) => {
  const f = await fixture(t)
  for (const response of [new Response('tampered'), new Response(payload, { headers: { 'content-length': String(payload.length + 5) } })]) {
    t.mock.method(globalThis, 'fetch', async () => response)
    await assert.rejects(installVoicePythonRuntime(f.directory, artifact, new AbortController().signal, () => {}, f.run), /完整性/u)
  }
  assert.equal(f.extracts(), 0); assert.deepEqual(await readdir(f.directory), [])
})

test('下载期间取消不提升缓存、不调用解释器或解压命令', async (t) => {
  const f = await fixture(t); const abort = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(payload); abort.abort(new Error('助理已重置')); controller.close()
  } })))
  await assert.rejects(installVoicePythonRuntime(f.directory, artifact, abort.signal, () => {}, f.run), /重置/u)
  assert.equal(f.extracts(), 0); assert.deepEqual(await readdir(f.directory), [])
})

test('环境命令取消等待子进程关闭，并正确报告不存在的命令', async () => {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 50)
  try { await assert.rejects(runVoiceEnvironmentProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], abort.signal), /取消/u) }
  finally { clearTimeout(timer) }
  await assert.rejects(runVoiceEnvironmentProcess(join(tmpdir(), 'codingns-no-such-interpreter'), [], new AbortController().signal), /无法运行语音环境命令/u)
})

test('Windows 解压固定使用系统 tar，支持系统目录中的盘符、中文和空格', () => {
  const root = 'D:\\系统 目录\\Windows'
  assert.equal(voicePythonArchiveCommand('win32', { Path: 'C:\\Git\\usr\\bin', SystemRoot: root }), root + '\\System32\\tar.exe')
  assert.equal(voicePythonArchiveCommand('win32', { windir: root }), root + '\\System32\\tar.exe')
  assert.throws(() => voicePythonArchiveCommand('win32', { SystemRoot: 'relative' }), /SystemRoot/u)
  assert.throws(() => voicePythonArchiveCommand('win32', {}), /SystemRoot/u)
  assert.equal(voicePythonArchiveCommand('darwin', {}), 'tar')
})

test('Windows 清除所有大小写 Python 覆盖并统一管道编码，保留代理和可执行搜索路径', () => {
  const source = {
    PythonHome: 'bad-home', PYTHONHOME: 'another-bad-home', PythonPath: 'bad-path',
    PythonIOEncoding: 'cp1252', pythonutf8: '0', PythonNoUserSite: '0',
    Pip_No_Input: '0', Pip_Require_Virtualenv: 'false', Path: 'C:\\Git\\bin',
    HTTPS_PROXY: 'http://proxy.test', SSL_CERT_FILE: 'C:\\cert.pem',
  }
  const environment = voiceProcessEnvironment(source, 'win32')
  for (const name of Object.keys(environment)) {
    assert.ok(!['PYTHONHOME', 'PYTHONPATH'].includes(name.toUpperCase()))
    if (/^(?:PYTHON|PIP_)/iu.test(name)) assert.equal(name, name.toUpperCase())
  }
  assert.equal(environment.PYTHONIOENCODING, 'utf-8'); assert.equal(environment.PYTHONUTF8, '1')
  assert.equal(environment.PYTHONNOUSERSITE, '1'); assert.equal(environment.PIP_REQUIRE_VIRTUALENV, 'true')
  assert.equal(environment.PIP_NO_INPUT, '1')
  assert.equal(environment.Path, source.Path); assert.equal(environment.HTTPS_PROXY, source.HTTPS_PROXY)
  assert.equal(environment.SSL_CERT_FILE, source.SSL_CERT_FILE)
  assert.equal(source.PythonHome, 'bad-home')
  assert.equal(voiceProcessEnvironment({ PythonHome: 'case-sensitive', PYTHONHOME: 'bad' }, 'linux').PythonHome, 'case-sensitive')
})

test('依赖预检保留 DLL 原始错误与 Windows 修复提示，取消不误报缺少运行库', async () => {
  const signal = new AbortController().signal
  const failure = new Error('DLL load failed：无法找到指定的模块')
  const run: VoiceEnvironmentCommand = async (_command, args) => {
    assert.deepEqual(args.slice(0, 4), ['-I', '-X', 'utf8', '-c'])
    assert.match(args[4]!, /onnxruntime/u); assert.match(args[4]!, /scipy.signal/u)
    throw failure
  }
  await assert.rejects(verifyVoicePythonDependencies('python.exe', signal, run, 'win32'), (error: any) => {
    assert.match(error.message, /Visual C\+\+ 2015–2022 x64/u); assert.match(error.message, /无法找到指定的模块/u)
    assert.equal(error.cause, failure); return true
  })
  const abort = new AbortController(); const cancelled = new Error('助理已重置'); abort.abort(cancelled)
  await assert.rejects(verifyVoicePythonDependencies('python.exe', abort.signal, run, 'win32'), (error) => error === cancelled)
})

test('环境命令按 UTF-8 流式解码分块中文错误，不产生替换字符', async () => {
  const code = "const b = Buffer.from('中文依赖错误'); process.stderr.write(b.subarray(0, 2)); setTimeout(() => { process.stderr.write(b.subarray(2)); process.exitCode = 1 }, 20)"
  await assert.rejects(runVoiceEnvironmentProcess(process.execPath, ['-e', code], new AbortController().signal), /中文依赖错误/u)
})

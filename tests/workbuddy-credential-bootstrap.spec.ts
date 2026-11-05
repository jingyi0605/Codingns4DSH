import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WORKBUDDY_CREDENTIAL_PRELOAD } from '../data/build/dist/host/cli-adapters/workbuddy-credential-bootstrap.js'

const execFileAsync = promisify(execFile)
const bootstrapVariables = [
  'WORKBUDDY_AT_REST_ENCRYPTION',
  'CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET',
  'CODEBUDDY_SIDECAR_READY_SOCKET',
  'CODEBUDDY_SIDECAR_READY_TOKEN',
  'CODEBUDDY_SIDECAR_READY_SESSION_ID',
]

function runBootstrap(before: string, after: string, overrides: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env }
  for (const name of bootstrapVariables) delete environment[name]
  return execFileAsync(process.execPath, ['--eval', `${before}\n${WORKBUDDY_CREDENTIAL_PRELOAD}\n${after}`], {
    env: { ...environment, ...overrides }, timeout: 10_000, windowsHide: true,
  })
}

// 只用于隔离测试的固定合成密钥；不读取 WorkBuddy 或系统的任何认证数据。
const syntheticProvider = String.raw`
const syntheticSecret = Buffer.alloc(32, 7).toString('base64');
process._linkedBinding = name => {
  if (name !== 'electron_browser_workbuddy_storage') throw Error('unexpected binding');
  return { loggerGet: () => JSON.stringify({version: 1, atRestSecretKey: syntheticSecret}) };
};
if (process.env.TEST_SERVE === '1') process.argv.push('--serve');
`

const nativeReceiver = String.raw`
const net = require('node:net');
const crypto = require('node:crypto');
let bootstrapValid = false;
let readyValid = false;
const receiver = net.createServer(connection => {
  let buffer = '';
  connection.on('data', chunk => {
    buffer += chunk;
    if (!buffer.includes('\n')) return;
    const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
    const expected = crypto.createHash('sha256').update(syntheticSecret, 'utf8').digest();
    bootstrapValid = request.version === 1 && request.pid === process.pid &&
      request.sessionId === process.env.CODEBUDDY_SIDECAR_READY_SESSION_ID &&
      request.token === process.env.CODEBUDDY_SIDECAR_READY_TOKEN &&
      request.bootstrap?.policy === 'fields' &&
      request.bootstrap?.symmetricKey?.keyBase64 === expected.toString('base64') &&
      request.bootstrap?.symmetricKey?.keyId === crypto.createHash('sha256').update(expected).digest('hex').slice(0, 16);
    expected.fill(0);
    connection.end(JSON.stringify({ok: process.env.TEST_REJECT !== '1', policy: 'fields'}) + '\n');
    receiver.close();
  });
});
receiver.once('close', () => {
  if (process.env.TEST_REJECT === '1') return;
  if (process.env.TEST_SERVE !== '1') {
    console.log(JSON.stringify({bootstrapValid, policy: process.env.WORKBUDDY_AT_REST_ENCRYPTION}));
    return;
  }
  const ready = net.createConnection(process.env.CODEBUDDY_SIDECAR_READY_SOCKET);
  ready.once('connect', () => ready.end(JSON.stringify({jsonrpc:'2.0',id:'ready-1',method:'session.ready',params:{
    protocolVersion:1,token:process.env.CODEBUDDY_SIDECAR_READY_TOKEN,
    sessionId:process.env.CODEBUDDY_SIDECAR_READY_SESSION_ID,pid:process.pid,port:12345,
  }}) + '\n'));
  let response = '';
  ready.on('data', chunk => { response += chunk; });
  ready.once('end', () => {
    readyValid = JSON.parse(response).result?.ok === true;
    console.log(JSON.stringify({bootstrapValid,readyValid,policy:process.env.WORKBUDDY_AT_REST_ENCRYPTION}));
  });
});
receiver.listen(process.env.CODEBUDDY_SIDECAR_CREDENTIAL_BOOTSTRAP_SOCKET);
`

for (const serve of [false, true]) {
  test(`WorkBuddy 原生凭据初始化完成${serve ? '并确认精简服务就绪' : '后释放临时连接'}`, async () => {
    const result = await runBootstrap(syntheticProvider, nativeReceiver, { TEST_SERVE: serve ? '1' : '0' })
    assert.deepEqual(JSON.parse(result.stdout), { bootstrapValid: true, ...(serve ? { readyValid: true } : {}), policy: 'fields' })
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.includes(Buffer.alloc(32, 7).toString('base64')), false)
  })
}

test('WorkBuddy 已完整提供的原生引导环境保持原样', async () => {
  const inherited = Object.fromEntries(bootstrapVariables.map((name) => [name, `synthetic-${name}`]))
  const result = await runBootstrap(
    'process._linkedBinding = () => { throw Error("binding must not be loaded"); };',
    `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(bootstrapVariables)}.map(name => [name,process.env[name]]))));`,
    inherited,
  )
  assert.deepEqual(JSON.parse(result.stdout), inherited)
})

test('WorkBuddy 不完整的原生引导环境明确失败，不重新生成身份', async () => {
  await assert.rejects(runBootstrap(syntheticProvider, 'throw Error("CLI must not start");', {
    CODEBUDDY_SIDECAR_READY_TOKEN: 'synthetic-incomplete-token',
  }), (error: Error & { stderr?: string }) => {
    assert.match(error.stderr ?? '', /credential bootstrap environment is incomplete/u)
    assert.equal(error.stderr?.includes('synthetic-incomplete-token'), false)
    return true
  })
})

test('WorkBuddy 旧版没有原生绑定时继续由 CLI 自行认证', async () => {
  const result = await runBootstrap(
    'process._linkedBinding = () => { throw Error("binding unavailable"); };',
    'console.log(JSON.stringify({policy:process.env.WORKBUDDY_AT_REST_ENCRYPTION ?? null}));',
  )
  assert.deepEqual(JSON.parse(result.stdout), { policy: null })
})

test('WorkBuddy 原生密钥格式不支持时不加载 CLI，错误中不包含原始内容', async () => {
  await assert.rejects(runBootstrap(
    'process._linkedBinding = () => ({loggerGet: () => JSON.stringify({version: 2, atRestSecretKey: "synthetic-unsupported-value"})});',
    'throw Error("CLI must not start");',
  ), (error: Error & { stderr?: string }) => {
    assert.match(error.stderr ?? '', /credential key payload is unsupported/u)
    assert.equal(error.stderr?.includes('synthetic-unsupported-value'), false)
    return true
  })
})

test('WorkBuddy 原生接收器拒绝初始化后结束子进程并清理连接', async () => {
  await assert.rejects(runBootstrap(syntheticProvider, nativeReceiver, { TEST_REJECT: '1' }), (error: Error & { stderr?: string }) => {
    assert.match(error.stderr ?? '', /credential bootstrap failed: initialization rejected/u)
    assert.equal(error.stderr?.includes(Buffer.alloc(32, 7).toString('base64')), false)
    return true
  })
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { LoginAttemptGuard, createLoginAttemptContext } from '../data/build/dist/host/login-attempt-guard.js'
import { PEER_HOST_AUTH_PATHS, createLoginProtectionConfig, resolvePeerHostAuthResponse } from '../data/build/dist/host/lan-access-dsh.js'

const headers = {
  'user-agent': 'CodingNS test browser',
  'accept-language': 'zh-CN',
  'sec-ch-ua': '"Test"',
  'sec-ch-ua-platform': '"macOS"',
  'sec-ch-ua-mobile': '?0',
}

test('同一来源失败三次后要求图形验证码，验证码答案不出现在图片源码中', () => {
  let now = 1_000
  const guard = new LoginAttemptGuard(() => now)
  const context = createLoginAttemptContext('192.168.1.20', headers)

  guard.recordFailure(context)
  guard.recordFailure(context)
  guard.recordFailure(context)
  assert.equal(guard.requiresCaptcha(context), true)
  assert.equal(guard.beforeLogin(context).allowed, false)

  const challenge = guard.issueCaptcha(context)
  const svg = guard.renderCaptcha(challenge.id, context)
  assert.match(svg ?? '', /<svg\b/u)
  assert.doesNotMatch(svg ?? '', /<text\b|data-code=/u)
  assert.equal(guard.beforeLogin(context, { captchaId: challenge.id, captchaCode: '00000' }).allowed, false)

  guard.recordSuccess(context)
  assert.equal(guard.requiresCaptcha(context), false)
  now += 1
})

test('机器登录入口不要求图形验证码，但达到来源上限后进入冷却', () => {
  const guard = new LoginAttemptGuard(() => 1_000)
  const context = createLoginAttemptContext('192.168.1.21', headers)

  for (let index = 0; index < 12; index += 1) guard.recordFailure(context)
  const decision = guard.beforeLogin(context, { allowCaptcha: false })
  assert.equal(decision.allowed, false)
  if (decision.allowed) return
  assert.equal(decision.reason, 'rate_limited')
  assert.equal(decision.retryAfterSeconds, 60)
})

test('来源限速达到上限后返回冷却时间，窗口过期后恢复', () => {
  let now = 1_000
  const guard = new LoginAttemptGuard(() => now)
  const context = createLoginAttemptContext('192.168.1.22', headers)

  for (let index = 0; index < 12; index += 1) guard.recordFailure(context)
  const blocked = guard.beforeLogin(context)
  assert.equal(blocked.allowed, false)
  if (blocked.allowed) return
  assert.equal(blocked.reason, 'rate_limited')

  now += 15 * 60 * 1000 + 1
  assert.equal(guard.beforeLogin(context).allowed, true)
})

test('PeerHost 登录接口共享来源和全局失败限速', () => {
  const guard = new LoginAttemptGuard(() => 1_000)
  const config = createLoginProtectionConfig({ username: 'jackson', password: 'password123', timeoutSeconds: 1800, scopes: { lan: true, relay: true } })
  const context = createLoginAttemptContext('192.168.1.23', headers)
  const request = {
    method: 'POST',
    path: PEER_HOST_AUTH_PATHS.login,
    headers,
    body: new TextEncoder().encode(JSON.stringify({ username: 'jackson', password: 'wrong-password' })),
  }

  for (let index = 0; index < 12; index += 1) {
    const response = resolvePeerHostAuthResponse(request, config, new Set(), guard, context)
    assert.match(new TextDecoder().decode(response), /401 Unauthorized/u)
  }
  const blocked = resolvePeerHostAuthResponse(request, config, new Set(), guard, context)
  assert.match(new TextDecoder().decode(blocked), /429 Too Many Requests/u)
})

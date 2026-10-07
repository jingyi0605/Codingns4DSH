import assert from 'node:assert/strict'
import test from 'node:test'
import { LoginAttemptGuard, createLoginAttemptContext } from '../data/build/dist/host/login-attempt-guard.js'
import { LanAccessDshProxy, PEER_HOST_AUTH_PATHS, createLoginProtectionConfig, resolvePeerHostAuthResponse } from '../data/build/dist/host/lan-access-dsh.js'

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

// —— 回归：验证码被并发签发请求作废，导致正确密码也永远提示“验证码错误” ——

/** 足以压过守卫层每设备验证码配额的静态资源请求次数。 */
const MAX_FAVICON_REQUESTS = 6

const captchaGlyphs: Readonly<Record<string, readonly string[]>> = {
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
}

/** 从验证码 SVG 反解出答案，模拟“用户能看清图片并照抄”的等价能力。 */
function solveCaptcha(svg: string): string {
  const grids = new Map<number, string[][]>()
  for (const match of svg.matchAll(/M(\d+) (\d+)h3v3h-3z/gu)) {
    const offsetX = Number(match[1]) - 12
    const offsetY = Number(match[2]) - 14
    const index = Math.floor(offsetX / 24)
    const column = (offsetX % 24) / 3
    const row = offsetY / 3
    if (!Number.isInteger(column) || !Number.isInteger(row)) continue
    const grid = grids.get(index) ?? Array.from({ length: 7 }, () => Array.from({ length: 5 }, () => '0'))
    grid[row]![column] = '1'
    grids.set(index, grid)
  }
  return [...grids.keys()].sort((left, right) => left - right).map((key) => {
    const pattern = grids.get(key)!.map((row) => row.join('')).join(',')
    return Object.entries(captchaGlyphs).find(([, rows]) => rows.join(',') === pattern)?.[0] ?? '?'
  }).join('')
}

test('签发新验证码不会作废同设备已渲染的验证码', () => {
  const now = 1_000
  const guard = new LoginAttemptGuard(() => now)
  const context = createLoginAttemptContext('192.168.1.30', headers)

  const first = guard.issueCaptcha(context)
  const firstAnswer = solveCaptcha(guard.renderCaptcha(first.id, context) ?? '')
  // 同一设备再次签发（例如另一个标签页、或页面被重新渲染）不应当让旧验证码失效。
  guard.issueCaptcha(context)

  assert.equal(solveCaptcha(guard.renderCaptcha(first.id, context) ?? '').length, 5)
  assert.equal(guard.beforeLogin(context, { captchaId: first.id, captchaCode: firstAnswer }).allowed, true)
})

test('未登录的静态资源请求不会让登录页上的验证码失效', () => {
  const socket = { remoteAddress: '192.168.1.31' }
  const proxy = new LanAccessDshProxy()
  proxy.setLoginConfig(createLoginProtectionConfig({ username: 'jackson', password: 'password123', timeoutSeconds: 1800, scopes: { lan: true, relay: true } }))
  const authorize = (request: { method: string; path: string; query?: string; body: Uint8Array }): Uint8Array | 'pass' =>
    (proxy as unknown as { authorize: (request: unknown, local: boolean, socket: unknown) => Uint8Array | 'pass' })
      .authorize({ headers: headers as unknown as Record<string, string>, ...request }, false, socket)

  const decode = (response: Uint8Array | 'pass'): { status: number; body: string } => {
    assert.notEqual(response, 'pass')
    const text = new TextDecoder().decode(response as Uint8Array)
    const [head, ...rest] = text.split('\r\n\r\n')
    return { status: Number(/^HTTP\/1\.1 (\d+)/u.exec(head ?? '')?.[1] ?? '0'), body: rest.join('\r\n\r\n') }
  }
  const submit = (fields: Record<string, string>): { status: number; body: string } => {
    const body = new TextEncoder().encode(new URLSearchParams(fields).toString())
    return decode(authorize({ method: 'POST', path: '/__codingns/login', body }))
  }
  const fetchPage = (path: string, query?: string): { status: number; body: string } =>
    decode(authorize({ method: 'GET', path, body: new Uint8Array(0), ...(query === undefined ? {} : { query }) }))

  // 先让来源进入验证码态。
  for (let index = 0; index < 3; index += 1) submit({ username: 'jackson', password: 'wrong-password' })

  const page = fetchPage('/')
  assert.equal(page.status, 200)
  // 登录页与主页面保持相同模式，避免主屏幕 PWA 在登录跳转后继续覆盖状态栏。
  assert.match(page.body, /<meta name="apple-mobile-web-app-status-bar-style" content="default">/u)
  assert.doesNotMatch(page.body, /black-translucent/u)
  const captchaId = /name="captchaId" value="([^"]+)"/u.exec(page.body)?.[1]
  assert.equal(typeof captchaId, 'string')
  const answer = solveCaptcha(fetchPage('/__codingns/captcha', `id=${encodeURIComponent(captchaId!)}`).body)
  assert.equal(answer.length, 5)

  // 浏览器会为 favicon 等静态资源发出额外的未登录请求，它们不得签发新验证码，
  // 更不能把页面上已渲染的验证码挤出设备配额（这里刻意超过每设备上限）。
  for (let index = 0; index < MAX_FAVICON_REQUESTS; index += 1) assert.equal(fetchPage('/favicon.ico').status, 401)
  assert.equal(fetchPage('/__codingns/captcha', `id=${encodeURIComponent(captchaId!)}`).status, 200)

  const login = submit({ username: 'jackson', password: 'password123', captchaId: captchaId!, captchaCode: answer })
  assert.equal(login.status, 303)
  assert.doesNotMatch(login.body, /图形验证码/u)
})

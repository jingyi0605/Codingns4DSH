import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { setTimeout } from 'node:timers/promises'
import { LanAccessDshProxy, createLoginProtectionConfig, type ParsedLanRequest } from '../src/host/lan-access-dsh.js'
import { quickAppBrowser } from './quick-apps-browser-driver.js'

test('LAN HTTP login accepts native browser form submissions and retries after a bad password', { timeout: 30_000 }, async t => {
  const browser = await quickAppBrowser(t, ['--host-resolver-rules=MAP login.dsh.test 127.0.0.1'])
  if (!browser) return
  const cookieName = 'dsh_login_browser_fixture'
  const proxy = new LanAccessDshProxy(undefined, undefined, cookieName)
  proxy.setLoginConfig(createLoginProtectionConfig({ username: 'fixture-user', password: 'fixture-password', timeoutSeconds: 1800, scopes: { lan: true, relay: true } }))
  const authorize = (request: ParsedLanRequest) =>
    (proxy as unknown as { authorize(request: ParsedLanRequest, local: boolean, socket: unknown): Uint8Array | 'pass' })
      .authorize(request, false, { remoteAddress: '192.0.2.10' })
  const submissions: { headers: IncomingHttpHeaders; status: number }[] = []
  // Exercise browser-generated headers against the real authorization boundary.
  // Only the transport and the authenticated DSH page are fixture-owned.
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const response = authorize({
        method: req.method!, path: req.url!,
        headers: Object.fromEntries(Object.entries(req.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        body: Buffer.concat(chunks),
      })
      if (response === 'pass') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<p id="authenticated">Authenticated DSH fixture</p>')
        return
      }
      const bytes = Buffer.from(response)
      const separator = bytes.indexOf('\r\n\r\n')
      const [statusLine, ...lines] = bytes.subarray(0, separator).toString().split('\r\n')
      const status = Number(statusLine!.split(' ')[1])
      const responseHeaders = Object.fromEntries(lines.map(line => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon), line.slice(colon + 1).trim()]
      }))
      if (req.method === 'POST' && req.url === '/__codingns/login') submissions.push({ headers: req.headers, status })
      res.writeHead(status, responseHeaders)
      res.end(bytes.subarray(separator + 4))
    })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://login.dsh.test:${(server.address() as { port: number }).port}`
  const { command, evaluate } = browser
  const waitForPage = async (selector: string, expectedSubmissions: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (submissions.length === expectedSubmissions) {
        try {
          if (await evaluate(`document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(selector)})`)) return
        } catch (error) {
          if (!String(error).includes('context')) throw error
        }
      }
      await setTimeout(50)
    }
    assert.fail(`Browser did not reach ${selector}; submission statuses: ${submissions.map(({ status }) => status)}`)
  }
  const submit = (password: string) => evaluate(`
    document.querySelector('#login-username').value = 'fixture-user';
    document.querySelector('#login-password').value = ${JSON.stringify(password)};
    document.querySelector('form').requestSubmit();
  `)
  await command('Page.enable')
  await command('Network.enable')
  await command('Page.navigate', { url: origin })
  await waitForPage('#login-username', 0)
  assert.equal(await evaluate('isSecureContext'), false, 'Use ordinary LAN HTTP rather than trustworthy localhost')
  await submit('wrong-password')
  await waitForPage('#login-username', 1)
  assert.equal(submissions[0]!.status, 401, 'Invalid credentials reach password validation')
  await submit('fixture-password')
  await waitForPage('#authenticated', 2)
  assert.deepEqual(submissions.map(({ status }) => status), [401, 303])
  for (const { headers } of submissions) {
    assert.equal(headers.origin, origin, 'The browser retains the form origin on both login pages')
    assert.equal(headers['sec-fetch-site'], undefined, 'LAN HTTP must work without Fetch Metadata')
  }
  assert.equal(await evaluate('location.pathname'), '/')
  assert.equal(await evaluate('fetch("/__codingns/session").then(r => r.json()).then(s => s.authenticated)'), true)
  const { cookies } = await command('Network.getCookies', { urls: [origin] })
  assert.ok(cookies.some((cookie: { name: string; httpOnly: boolean }) => cookie.name === cookieName && cookie.httpOnly))
})

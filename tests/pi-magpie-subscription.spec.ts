import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { registerSubscriptionSlot } from '../data/build/dist/client/subscription-slot.js'
import { MagpieUsageService } from '../src/host/cli-adapters/magpie-usage.js'
import { createHookRenderer } from './fixtures/react-hook-renderer.js'

test('Pi Magpie selections resolve the verified model ID and routed upstream usage', async () => {
  const modelId = 'magpie/auto/deepseek-v4.1-flash'
  const sessionId = 'pi-provider-session'
  const urls: string[] = []
  const service = new MagpieUsageService({
    readModels: async (agent) => {
      assert.equal(agent, 'pi')
      return [
        'Example provider',
        'auto/deepseek-v4.1-flash    Deepseek-V4.1-Flash-Auto',
        "pi is shown every provider's models · magpie visible pi",
        'http://127.0.0.1:3425/v1',
      ].join('\n')
    },
    fetch: (async (url) => {
      const target = new URL(String(url))
      urls.push(`${target.pathname}${target.search}`)
      if (target.pathname.endsWith('/quotas')) return Response.json({ data: [{
        provider: 'workbuddy', name: 'WorkBuddy', windows: [{ name: 'Credits', used: 27, remaining: 73 }],
      }] })
      if (target.pathname.endsWith('/route')) return Response.json({
        session: sessionId,
        route: { asked: 'auto/deepseek-v4.1-flash', model: 'workbuddy/deepseek-v4.1-flash', served: 'deepseek-v4.1-flash', done: true, status: 200, tries: [] },
      })
      if (target.pathname.endsWith('/usage/requests')) return Response.json({ rows: [] })
      return Response.json({
        calls: 1, errors: 0, input: 1200, output: 80, cache_read: 200, cache_write: 0, cost: 0.001,
        sessions: [{ agent: 'pi', id: sessionId, calls: 1, errors: 0, input: 1200, output: 80, cache_read: 200, cache_write: 0, cost: 0.001 }],
      })
    }) as typeof fetch,
  })
  const session = { adapterId: 'pi', modelId, providerSessionId: sessionId }

  const initial = await service.read(session)
  assert.equal(initial?.modelId, modelId)
  assert.equal(initial?.session?.id, sessionId)
  assert.equal(initial?.upstreamProvider, null, 'the local `magpie` provider must not be mistaken for the routed upstream')
  assert.equal(initial?.quotaStatus, 'provider-unavailable', 'automatic routing should be resolved from this session route')
  assert.equal(urls.some((url) => url.includes('/route?')), false, 'the initial read stays aggregate-only')

  const routed = await service.read(session, undefined, true)
  assert.equal(routed?.routeStatus, 'available')
  assert.equal(routed?.upstreamProvider, 'workbuddy')
  assert.equal(routed?.quotas[0]?.windows[0]?.remainingPercent, 73)
})

test('Pi sessions using a Magpie model render the Magpie usage component', async (t) => {
  let component: ((props: unknown) => unknown) | undefined
  const slots = {
    inject: (_name: string, register: () => unknown) => register(),
    register: (_options: unknown, render: (props: unknown) => unknown) => { component = render; return () => undefined },
  }
  const subscriptionRequests: Record<string, unknown>[] = []
  const rpc = {
    call: async (_channel: string, method: string, payload: unknown) => {
      if (method.endsWith('/session/get')) return {
        ok: true,
        value: { adapterId: 'pi', modelId: 'magpie/auto/deepseek-v4.1-flash', providerSessionId: 'pi-provider-session' },
      }
      assert.ok(method.endsWith('/subscription'))
      subscriptionRequests.push(payload as Record<string, unknown>)
      return {
        ok: true,
        value: {
          providerUsage: null,
          magpie: {
            agent: 'pi', modelId: 'magpie/auto/deepseek-v4.1-flash', capturedAt: new Date().toISOString(), usageStatus: 'available',
            aggregate: { calls: 1, errors: 0, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0, costUsd: 0.001 },
            sessionId: 'pi-provider-session',
            session: { id: 'pi-provider-session', agent: 'pi', calls: 1, errors: 0, inputTokens: 1200, outputTokens: 80, cacheReadTokens: 200, cacheWriteTokens: 0, costUsd: 0.001 },
            routeStatus: 'not-requested', route: null,
            upstreamProvider: 'workbuddy', upstreamProviders: ['workbuddy'],
            quotaStatus: 'available',
            quotas: [{
              provider: 'workbuddy', name: 'WorkBuddy', kind: 'subscription', user: null, plan: null, alias: null,
              balance: null, readAt: null,
              windows: [{ name: 'Credits', usedPercent: 27, remainingPercent: 73, resetsAt: null, display: null, amount: null, limit: null, unit: null, holdsWhy: null }],
            }],
          },
        },
      }
    },
  }

  registerSubscriptionSlot(slots as never, rpc as never)
  assert.ok(component)
  const view = createHookRenderer(component!, { rpc, sessionId: 'dsh-pi-session' })
  t.after(() => view.dispose())

  let rendered: unknown
  for (let attempt = 0; attempt < 12; attempt++) {
    await setImmediate()
    rendered = view.render()
    if (subscriptionRequests.length > 0) break
  }

  assert.equal(subscriptionRequests.length, 1, 'Pi should pass the subscription-slot adapter eligibility check')
  assert.equal(subscriptionRequests[0]?.adapterId, 'pi')
  assert.equal(subscriptionRequests[0]?.modelId, 'magpie/auto/deepseek-v4.1-flash')
  assert.ok(rendered)
  const markup = JSON.stringify(rendered)
  assert.match(markup, /codingns4dsh-subscription-trigger/u)
  assert.match(markup, /provider-icons\/magpie\.png/u)
  assert.match(markup, /conic-gradient/u)
  assert.match(markup, /73/u)
})

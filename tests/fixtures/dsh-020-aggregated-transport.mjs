/**
 * DSH 0.2.0-rc.1 Client boot 的最小聚合 Transport fixture。
 * fixture 只模拟公开的 ClientConnectionRpc，不伪造 Cordis 的
 * Workspace/Session Store；后者必须由 DSH 原生 Client Controller 创建。
 */
export function createDsh020AggregatedTransportFixture(snapshot) {
  const calls = []
  const hooks = {
    ownsHost: true,
    rpc: {
      async call(channel, endpoint, payload) {
        calls.push({ channel, endpoint, payload })
        if (endpoint === 'aggregate/workspace/list') return { ok: true, value: { items: snapshot.workspaces } }
        if (endpoint === 'aggregate/session/list') return { ok: true, value: { items: snapshot.sessions } }
        return { ok: true, value: {} }
      },
      open() {
        return (async function* stream() {})()
      },
    },
  }

  return {
    hooks,
    calls,
    snapshot,
    generationSource: async (signal, ready) => {
      ready({ home: '/aggregated' })
      await new Promise((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

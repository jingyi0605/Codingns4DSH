export default async function* testProgressReporter(source) {
  const interactive = Boolean(process.stdout.isTTY)
  const prefix = interactive ? '\r\u001b[2K' : ''
  const suffix = interactive ? '' : '\n'
  const updateInterval = interactive ? 100 : 1000
  let completed = 0
  let lastUpdate = 0

  yield `${prefix}Tests: 0 completed${suffix}`

  for await (const { type, data } of source) {
    if (type === 'test:complete' && data.details.type !== 'suite') {
      completed += 1
      const now = Date.now()
      if (now - lastUpdate >= updateInterval) {
        yield `${prefix}Tests: ${completed} completed${suffix}`
        lastUpdate = now
      }
    } else if (type === 'test:summary' && data.file === undefined) {
      const { tests, passed, failed, cancelled, skipped, todo } = data.counts
      yield `${prefix}Tests: ${tests} | passed: ${passed} | failed: ${failed} | cancelled: ${cancelled} | skipped: ${skipped} | todo: ${todo} | duration: ${(data.duration_ms / 1000).toFixed(1)}s\n`
    }
  }
}

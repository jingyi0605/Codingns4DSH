export type BrowserEntryUrl = (baseUrl: string) => string | undefined

interface EntryUrl {
  readonly label: string
  readonly url: string
  readonly open: boolean
}

interface WebEntryContext {
  readonly webServer: object
  emit(subject: object, event: 'webserver/entry-url', baseUrl: string, entries: EntryUrl[]): void
}

/** Ask the WebServer's own Token plugin to contribute its entry URL. */
export function createBrowserEntryUrl(context: unknown): BrowserEntryUrl {
  const ctx = context as WebEntryContext
  return (baseUrl) => {
    const entries: EntryUrl[] = []
    ctx.emit(ctx.webServer, 'webserver/entry-url', baseUrl, entries)
    const entry = entries.find((item) => item.label === 'dsh web' && item.open)
    if (entry === undefined) return undefined
    const actual = URL.parse(entry.url)
    const base = new URL(baseUrl)
    return actual?.origin === base.origin && actual.pathname === base.pathname && !actual.username && !actual.password
      ? actual.href
      : undefined
  }
}

export function createLegacyBrowserEntryUrl(connection: unknown): BrowserEntryUrl {
  return (connection as { authenticatedUrl(baseUrl: string): string }).authenticatedUrl.bind(connection)
}

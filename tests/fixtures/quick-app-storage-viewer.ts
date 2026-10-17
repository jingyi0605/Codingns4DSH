import { attachQuickAppStorageBroker } from '../../src/client/quick-apps/browser-storage.js'
import type { QuickApp } from '../../src/shared/contracts/quick-apps.js'

const fixture = window as unknown as {
  fixtureApps: { app: QuickApp; view: { url: string; storageToken: string; storageScope: string; expiresAt: number } }[]
  fixtureStorageErrors: string[]
  fixtureDisposers: (() => void)[]
  fixtureOpen(entry: { app: QuickApp; view: { url: string; storageToken: string; storageScope: string; expiresAt: number } }): void
}
fixture.fixtureStorageErrors = []; fixture.fixtureDisposers = []
fixture.fixtureOpen = ({ app, view }) => {
  const frame = document.createElement('iframe')
  frame.id = app.id; frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads'); frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.style.width = '95%'; frame.style.height = '300px'
  fixture.fixtureDisposers.push(attachQuickAppStorageBroker({ owner: window, frame: () => frame, token: view.storageToken, scope: view.storageScope,
    expiresAt: view.expiresAt, onError: error => fixture.fixtureStorageErrors.push(error.message) }))
  document.body.append(frame); frame.src = view.url
}
for (const entry of fixture.fixtureApps) fixture.fixtureOpen(entry)

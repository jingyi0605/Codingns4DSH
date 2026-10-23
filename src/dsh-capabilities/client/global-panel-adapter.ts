import type { ComponentType } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.panellist': { kind: 'list'; scope: 'root' }
  }
}

export interface GlobalPanelIconProps {
  readonly size: number
  readonly active: boolean
}

export interface GlobalPanelContribution {
  readonly id: string
  readonly order: number
  readonly label: () => string
  readonly icon: ComponentType<GlobalPanelIconProps>
  readonly page: ComponentType<any>
  readonly pageProps: Readonly<Record<string, unknown>>
}

interface GlobalPanelSlots {
  inject(name: 'sidebar.panellist' | 'main', callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: ComponentType<any>): () => void
}

interface GlobalPanelLayout {
  selectPanel(panelId: string | null): void
}

export interface GlobalPanelAdapter {
  register(contribution: GlobalPanelContribution): () => void
}

interface GlobalPanelContext {
  readonly slots: GlobalPanelSlots
  readonly layout: GlobalPanelLayout
}

export function supportsGlobalPanel(context: unknown): boolean {
  return readGlobalPanelContext(context) !== undefined
}

export function createGlobalPanelAdapter(context: unknown): GlobalPanelAdapter {
  const services = readGlobalPanelContext(context)
  if (services === undefined) throw new TypeError('DSH global panel services are unavailable')
  const { slots, layout } = services

  return {
    register(contribution) {
      let sidebarDeclared = false
      let mainDeclared = false
      let disposeSidebarEntry: (() => void) | undefined
      let disposeMainEntry: (() => void) | undefined

      const releaseEntries = (): void => {
        disposeSidebarEntry?.()
        disposeSidebarEntry = undefined
        disposeMainEntry?.()
        disposeMainEntry = undefined
      }
      const syncEntries = (): void => {
        if (!sidebarDeclared || !mainDeclared) {
          releaseEntries()
          return
        }
        if (disposeMainEntry === undefined) {
          disposeMainEntry = slots.register({
            name: 'main',
            key: contribution.id,
            inject: () => ({
              ...contribution.pageProps,
              onClose: () => layout.selectPanel(null),
            }),
          }, contribution.page)
        }
        if (disposeSidebarEntry === undefined) {
          disposeSidebarEntry = slots.register({
            name: 'sidebar.panellist',
            id: contribution.id,
            order: contribution.order,
            label: contribution.label,
          }, contribution.icon)
        }
      }

      const disposeSidebarInjection = slots.inject('sidebar.panellist', () => {
        sidebarDeclared = true
        syncEntries()
        return () => {
          sidebarDeclared = false
          syncEntries()
        }
      })
      const disposeMainInjection = slots.inject('main', () => {
        mainDeclared = true
        syncEntries()
        return () => {
          mainDeclared = false
          syncEntries()
        }
      })

      return () => {
        disposeSidebarInjection()
        disposeMainInjection()
        sidebarDeclared = false
        mainDeclared = false
        releaseEntries()
      }
    },
  }
}

function readGlobalPanelContext(context: unknown): GlobalPanelContext | undefined {
  const slots = readContextService(context, 'slots')
  const layout = readContextService(context, 'layout')
  if (!hasMethod(slots, 'inject') || !hasMethod(slots, 'register') || !hasMethod(layout, 'selectPanel')) return undefined
  return { slots: slots as GlobalPanelSlots, layout: layout as GlobalPanelLayout }
}

function readContextService(context: unknown, name: string): unknown {
  if (typeof context !== 'object' || context === null) return undefined
  try {
    const getter = Reflect.get(context, 'get')
    if (typeof getter === 'function') {
      const service = getter.call(context, name)
      if (service !== undefined) return service
    }
  } catch {
    // Cordis contexts may reject reads outside the current inject chain.
  }
  try {
    return Reflect.get(context, name)
  } catch {
    return undefined
  }
}

function hasMethod(value: unknown, name: string): boolean {
  if (typeof value !== 'object' || value === null) return false
  try {
    return typeof Reflect.get(value, name) === 'function'
  } catch {
    return false
  }
}

import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

/** Real slot storage with the public declaration-lifetime semantics of SlotRegistry.inject. */
export function createPresentationSlots(core = new SlotCore()) {
  return {
    core,
    register: core.register.bind(core),
    registerFactory: core.registerFactory.bind(core),
    entries: core.entries.bind(core),
    subscribe: core.subscribe.bind(core),
    snapshot: core.snapshot.bind(core),
    inject(name: string, mount: () => () => void): () => void {
      let remove: (() => void) | undefined
      const reconcile = (): void => {
        if (core.specDynamic(name) === undefined) { remove?.(); remove = undefined }
        else if (remove === undefined) remove = mount()
      }
      const unsubscribe = core.subscribeDeclaration(name, reconcile)
      try { reconcile() } catch (error) { unsubscribe(); throw error }
      return () => { unsubscribe(); remove?.(); remove = undefined }
    },
  }
}

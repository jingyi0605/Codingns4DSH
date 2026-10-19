import { createElement, useMemo, useSyncExternalStore } from 'react'
import { parseVirtualSessionId } from '../../shared/contracts/peer-host.js'
import { installComposerPresentation } from './composer-presentation-adapter.js'
import type { PresentationSlots } from './slot-presentation-mirror.js'

/** Native file paths describe the client machine; remote sessions must upload bytes. */
export function installPeerHostAttachmentIntake(context: unknown, folderError: string): () => void {
  const slots = (context as { get?: (name: string) => unknown } | undefined)?.get?.('slots') as Partial<PresentationSlots> | undefined
  if (slots === undefined || !['inject', 'register', 'entries', 'subscribe'].every(key => typeof slots[key as keyof PresentationSlots] === 'function')) return () => undefined
  return installComposerPresentation(context as object, slots as PresentationSlots, Native => function PeerHostComposer(props) {
    if (typeof props.sessionId !== 'string' || parseVirtualSessionId(props.sessionId) === null || typeof props.addFiles !== 'function') {
      return createElement(Native, props)
    }
    return createElement(Native, {
      ...props,
      addFiles: (files: readonly File[], directories?: ReadonlySet<File>): unknown => {
        if (files.some(file => directories?.has(file))) return folderError
        // A browser-created File retains bytes and display metadata without the native
        // path association that would turn the original File into a local reference.
        return props.addFiles(files.map(file => new File([file], file.name, {
          type: file.type, lastModified: file.lastModified,
        })))
      },
    })
  }, createElement, { useMemo, useSyncExternalStore })
}

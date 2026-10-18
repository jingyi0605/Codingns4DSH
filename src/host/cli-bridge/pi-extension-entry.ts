// Pi's jiti extension loader aliases this static import to its bundled TypeBox.
// @ts-expect-error TypeBox is supplied by Pi's extension runtime, not CodingNS.
import { Type } from 'typebox'
import { createPiBridgeExtension, type PiExtensionApi, type PiTypeBoxApi } from './pi-extension.js'

const typeBox = { Type } as PiTypeBoxApi

export default function codingNsPiBridgeExtension(pi: PiExtensionApi): void {
  createPiBridgeExtension(pi, typeBox)
}

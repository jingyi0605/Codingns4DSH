export interface CodingNsTypertHostService {
  register?: (manifest: unknown) => (() => void) | void
  remote?: unknown
}

export function createTypertHostService(runtime: CodingNsTypertHostService): CodingNsTypertHostService {
  return runtime
}

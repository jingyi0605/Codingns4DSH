import type { NativeSubagentService } from './native-team-subagent.js'

let current: NativeSubagentService | undefined

export function setNativeSubagents(service: NativeSubagentService | undefined): void { current = service }
export function getNativeSubagents(): NativeSubagentService | undefined { return current }

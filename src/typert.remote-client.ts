/**
 * Client 侧 Typert Remote 描述。
 *
 * DSH 0.1.7 的 api-remotes/client 会自动提供官方 `remote.terminal`，
 * 因此 codingns4dsh 必须使用独立的 `remote.codingnsTerminal` 描述。
 * Host 与 Client 共用同一份 invocation 形状，避免两边的 endpoint 漂移。
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from './typert.host.js'

export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: TYPERT.package,
  descriptors: TYPERT.invocations.filter((item) => (item as { namespace?: unknown }).namespace === 'codingnsTerminal') as unknown as TypertRemoteContribution['descriptors'],
}

export default TYPERT_REMOTE

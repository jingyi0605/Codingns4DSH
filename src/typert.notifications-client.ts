/** 全局助理通知 Remote 的 Client 描述；实际连接仍由 DSH Remote WebSocket 承载。 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { TYPERT } from './typert.host.js'

export const ASSISTANT_NOTIFICATION_TYPERT_REMOTE: TypertRemoteContribution = {
  package: TYPERT.package,
  descriptors: TYPERT.invocations.filter((item) => (item as { namespace?: unknown }).namespace === 'codingnsAssistantNotifications') as unknown as TypertRemoteContribution['descriptors'],
}

export default ASSISTANT_NOTIFICATION_TYPERT_REMOTE

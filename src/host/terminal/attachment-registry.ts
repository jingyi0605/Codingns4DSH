import type {
  CodingNsTerminalRuntimeType,
  TerminalAttachmentRecord,
  TerminalRecordIdentity,
} from '../../shared/contracts/terminal.js'

export interface ManagedTerminalAttachment extends TerminalAttachmentRecord {
  readonly identity: TerminalRecordIdentity
  readonly runtimeType: CodingNsTerminalRuntimeType
}

/** generation 级 attach 注册表；这里只持有短命连接，绝不写入持久存储。 */
export class TerminalAttachmentRegistry {
  private readonly attachments = new Map<string, ManagedTerminalAttachment>()

  add(attachment: ManagedTerminalAttachment): void {
    if (this.attachments.has(attachment.subscriptionId)) {
      throw new Error(`终端订阅已经存在: ${attachment.subscriptionId}`)
    }
    this.attachments.set(attachment.subscriptionId, cloneAttachment(attachment))
  }

  get(subscriptionId: string): ManagedTerminalAttachment | undefined {
    const attachment = this.attachments.get(subscriptionId)
    return attachment === undefined ? undefined : cloneAttachment(attachment)
  }

  isCurrent(subscriptionId: string, generation: string, runtimeAttachmentId: string): boolean {
    const attachment = this.attachments.get(subscriptionId)
    return attachment?.generation === generation
      && attachment.runtimeAttachmentId === runtimeAttachmentId
  }

  remove(subscriptionId: string): ManagedTerminalAttachment | undefined {
    const attachment = this.attachments.get(subscriptionId)
    if (attachment === undefined) return undefined
    this.attachments.delete(subscriptionId)
    return cloneAttachment(attachment)
  }

  listByGeneration(generation: string): readonly ManagedTerminalAttachment[] {
    return [...this.attachments.values()]
      .filter((attachment) => attachment.generation === generation)
      .map(cloneAttachment)
  }

  listByTerminal(identity: TerminalRecordIdentity): readonly ManagedTerminalAttachment[] {
    return [...this.attachments.values()]
      .filter((attachment) => sameIdentity(attachment.identity, identity))
      .map(cloneAttachment)
  }

  list(): readonly ManagedTerminalAttachment[] {
    return [...this.attachments.values()].map(cloneAttachment)
  }
}

function sameIdentity(left: TerminalRecordIdentity, right: TerminalRecordIdentity): boolean {
  return left.hostId === right.hostId
    && left.workspaceId === right.workspaceId
    && left.dshSessionId === right.dshSessionId
    && left.terminalId === right.terminalId
}

function cloneAttachment(attachment: ManagedTerminalAttachment): ManagedTerminalAttachment {
  return { ...attachment, identity: { ...attachment.identity } }
}

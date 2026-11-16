/** Shared lifecycle rules for the unified ZCode progress reader and UI. */
export function workflowIsTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'canceled', 'aborted', 'interrupted', 'stopped'].includes(status)
}
export const ZCODE_WORKFLOW_ACTIVE_STATUSES = ['running', 'pending', 'queued', 'created', 'starting', 'waiting', 'stalled', 'resuming', 'executing', 'dispatched', 'active', 'in_progress'] as const
export function workflowIsActive(status: string): boolean {
  return (ZCODE_WORKFLOW_ACTIVE_STATUSES as readonly string[]).includes(status.trim().toLowerCase())
}


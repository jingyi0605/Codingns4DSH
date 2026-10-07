/** 三个入口打开同一根级工作台，不在设置卡片里再挂一份助理。 */
export const ASSISTANT_WORKBENCH_OPEN_EVENT = 'codingns-open-assistant'
export function openAssistantWorkbench(configuration = false): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ASSISTANT_WORKBENCH_OPEN_EVENT, { detail: { configuration } }))
}

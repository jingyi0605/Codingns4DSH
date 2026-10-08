import { createElement } from 'react'
import type { ReactElement } from 'react'
import { AssistantLoadedView, createAssistantViewLoader } from './assistant-view-loader.js'

// 两个配置入口共用模块缓存，草稿实例仍由工作台持有，切页不重新注册任何服务。
const configuration = createAssistantViewLoader(() => import('./assistant-configuration-view.js'))
export const assistantConfigurationFieldsLoader = createAssistantViewLoader(async () => (await configuration.load()).AssistantConfigurationFields)
export const assistantConfigurationPageLoader = createAssistantViewLoader(async () => (await configuration.load()).AssistantConfigurationPage)
export function AssistantConfigurationFields(props: Parameters<typeof import('./assistant-configuration-view.js')['AssistantConfigurationFields']>[0]): ReactElement {
  return createElement(AssistantLoadedView<typeof props>, { loader: assistantConfigurationFieldsLoader, viewProps: props, t: props.t })
}
export function AssistantConfigurationPage(props: Parameters<typeof import('./assistant-configuration-view.js')['AssistantConfigurationPage']>[0]): ReactElement {
  return createElement(AssistantLoadedView<typeof props>, { loader: assistantConfigurationPageLoader, viewProps: props, t: props.t })
}

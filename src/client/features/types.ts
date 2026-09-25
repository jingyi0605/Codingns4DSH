import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsLocale } from '../locale.js'

/** 一次 CodingNS RPC 的结果，与 DSH Connection 的结果形状一致。 */
export type CodingNsRpcResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Client 侧 RPC 调用句柄，由 DSH Connection 提供。 */
export interface CodingNsRpcClient {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<CodingNsRpcResult>
}

/** Client 侧功能模块在 start 中取用的服务集合。 */
export interface CodingNsClientServices {
  /** 当前 DSH 实际运行版本，由 Host 注入。 */
  readonly dshVersion: string
  readonly settings: SettingsScope<CodingNsSettings>
  readonly rpc: CodingNsRpcClient
  /** DSH Typert Remote；归档会话模块只通过运行时探测调用可选方法。 */
  readonly remote?: unknown
  /** DSH 语言运行时；所有 Client 文案都从 CodingNS 命名空间读取。 */
  readonly locale: CodingNsLocale
  /** DSH 对话装配服务；用于注册不写入 Session 的流式临时节点。 */
  readonly uiConversation?: unknown
  /** 对话工具栏 Slot 服务；测试和非 Web 宿主可以不提供。 */
  readonly slots?: SlotRegistry
  /** 当前 Client Cordis 上下文；只供需要注册 DSH UI Slot 的功能模块使用。 */
  readonly uiContext?: Context
}

/** 设置卡片传给模块面板的属性。 */
export interface FeaturePanelProps {
  /** 宿主注入的服务，与模块 start 中拿到的是同一份。 */
  readonly services: CodingNsClientServices
  /** 当前是否启用；未启用时面板需要自行灰显并禁用输入。 */
  readonly enabled: boolean
  /** 设置快照，用于读取表单初值和可写状态。 */
  readonly snapshot: SettingsScopeSnapshot<CodingNsSettings>
}

/**
 * 可在浏览器侧启停、并可出现在设置页的功能模块。
 *
 * 模块自带设置面板，设置页只负责遍历注册表渲染，因此新增模块不需要修改设置页。
 */
export interface CodingNsClientFeatureModule extends FeatureModule<CodingNsClientServices> {
  /** 卡片内容；不提供时该模块只显示标题栏开关。 */
  readonly settingsPanel?: (props: FeaturePanelProps) => ReactElement | null
}

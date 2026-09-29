import type { ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import type { CodingNsSettings } from '../../shared/contracts/config.js'
import type { CodingNsLocale } from '../locale.js'
import type { CodingNsSettingsSnapshot, CodingNsSettingsStore } from '../../dsh-capabilities/settings-store.js'
import type { PeerHostScopedClient } from '../peer-host-scoped-client.js'
import type { HostRouter } from '../host-router.js'
import type { PeerHostSessionController } from '../peer-host-session-controller.js'
import type { PwaNotificationClient } from '../pwa-notifications.js'

/** 一次 Codingns4DSH RPC 的结果，与 DSH Connection 的结果形状一致。 */
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
  readonly settings: CodingNsSettingsStore<CodingNsSettings>
  readonly rpc: CodingNsRpcClient
  /** PeerHost 远端资源适配器；请求始终绑定 HostScope。 */
  readonly peerHost: PeerHostScopedClient
  /** 所有跨 Host 资源共用的 generation 路由器。 */
  readonly hostRouter: HostRouter
  /** 远端会话的唯一控制入口；与 hostRouter 共享 generation 和清理生命周期。 */
  readonly peerHostSession: PeerHostSessionController
  /** DSH Typert Remote；归档会话模块只通过运行时探测调用可选方法。 */
  readonly remote?: unknown
  /** Codingns4DSH 自有终端 Remote；调试页不能依赖已停用的 DSH 官方 terminal。 */
  readonly terminalRemote?: () => unknown
  /** DSH 语言运行时；所有 Client 文案都从 Codingns4DSH 命名空间读取。 */
  readonly locale: CodingNsLocale
  /** DSH 对话装配服务；用于注册不写入 Session 的流式临时节点。 */
  readonly uiConversation?: unknown
  /** 对话工具栏 Slot 服务；测试和非 Web 宿主可以不提供。 */
  readonly slots?: SlotRegistry
  /** DSH 布局服务；手势只用它开合左侧会话列表。 */
  readonly layout?: { toggleSidebar(): void }
  /** DSH 右侧栏服务；手势用它读取状态并开合右栏。 */
  readonly sidebarRight?: { isExpanded(): boolean; toggleExpanded(): void }
  /** 通知与推送客户端；局域网 PWA 面板用它请求权限、订阅与注销 Service Worker。 */
  readonly notifications?: PwaNotificationClient
  /** 当前 Client Cordis 上下文；只供需要注册 DSH UI Slot 的功能模块使用。 */
  readonly uiContext?: Context
}

/** 设置页统一反馈的提示级别。 */
export type SettingsNoticeKind = 'success' | 'error' | 'info'

/** 由功能面板提交给设置页顶部 Toast 的反馈。 */
export interface SettingsNotice {
  readonly kind: SettingsNoticeKind
  readonly message: string
}

/** 设置卡片传给模块面板的属性。 */
export interface FeaturePanelProps {
  /** 宿主注入的服务，与模块 start 中拿到的是同一份。 */
  readonly services: CodingNsClientServices
  /** 当前是否启用；未启用时面板需要自行灰显并禁用输入。 */
  readonly enabled: boolean
  /** 设置快照，用于读取表单初值和可写状态。 */
  readonly snapshot: CodingNsSettingsSnapshot<CodingNsSettings>
  /** 将设置写入结果显示在设置区域顶部。 */
  readonly notify: (notice: SettingsNotice) => void
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

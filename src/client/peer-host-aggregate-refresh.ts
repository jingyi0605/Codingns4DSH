/**
 * PeerHost 聚合刷新的跨模块注册点。
 *
 * 远端归档会话只在聚合投影里维护，归档入口取消归档后必须立刻同步一次；
 * PeerHost 未启用时通知是空操作。
 */
type PeerHostAggregateRefresh = () => void | Promise<void>

let refresh: PeerHostAggregateRefresh | undefined
let refreshGeneration = 0

/** 注册当前页面的聚合刷新入口；返回取消注册。 */
export function registerPeerHostAggregateRefresh(candidate: PeerHostAggregateRefresh): () => void {
  refresh = candidate
  refreshGeneration += 1
  return () => {
    if (refresh === candidate) {
      refresh = undefined
      refreshGeneration += 1
    }
  }
}

/** 读取当前刷新入口及代数，供延迟任务丢弃旧页面注册留下的回调。 */
export function peerHostAggregateRefreshSnapshot(): { readonly generation: number; readonly refresh: PeerHostAggregateRefresh | undefined } {
  return { generation: refreshGeneration, refresh }
}

/** 请求一次聚合刷新；没有注册者时不做任何事。 */
export function requestPeerHostAggregateRefresh(): void | Promise<void> {
  return refresh?.()
}

/** 判断当前页面是否仍安装了 PeerHost 聚合刷新器。 */
export function isPeerHostAggregateRefreshRegistered(): boolean {
  return refresh !== undefined
}

/**
 * PeerHost 聚合刷新的跨模块注册点。
 *
 * 远端归档会话只在聚合投影里维护，归档入口取消归档后必须立刻同步一次；
 * PeerHost 未启用时通知是空操作。
 */
type PeerHostAggregateRefresh = () => void | Promise<void>

let refresh: PeerHostAggregateRefresh | undefined

/** 注册当前页面的聚合刷新入口；返回取消注册。 */
export function registerPeerHostAggregateRefresh(candidate: PeerHostAggregateRefresh): () => void {
  refresh = candidate
  return () => {
    if (refresh === candidate) refresh = undefined
  }
}

/** 请求一次聚合刷新；没有注册者时不做任何事。 */
export function requestPeerHostAggregateRefresh(): void | Promise<void> {
  return refresh?.()
}

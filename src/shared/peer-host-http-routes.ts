/**
 * PeerHost HTTP 数据面唯一白名单：发送端代理与目标 LAN 的 Bearer 鉴权共用。
 * 路由命中只表示允许使用 Host 票据；目标端仍必须验证签名、有效期与撤销状态。
 */
export const PEER_HOST_HTTP_PROXY_RULES = [
  { prefix: '/api/codingns/host/status', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/nativeLocal', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/native', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/nativeStream', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/nativeStreamOpen', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/nativeStreamNext', methods: ['POST'] },
  { prefix: '/api/codingns/peerHost/nativeStreamClose', methods: ['POST'] },
  // 工作区内的插件 RPC 和 Shell 状态都必须使用目标 Host 的登录态。
  { prefix: '/api/codingns/cli', methods: ['POST'] },
  { prefix: '/api/codingns/git', methods: ['POST'] },
  { prefix: '/api/codingns/debug', methods: ['POST'] },
  { prefix: '/api/codingns/fileManagement', methods: ['POST'] },
  { prefix: '/api/codingns/terminal/status', methods: ['POST'] },
  { prefix: '/api/workspaces', methods: ['GET'] },
  { prefix: '/api/sessions', methods: ['GET', 'POST'] },
  { prefix: '/api/file-tree', methods: ['GET'] },
  { prefix: '/api/files', methods: ['GET', 'PUT', 'POST'] },
  { prefix: '/api/git', methods: ['GET', 'POST'] },
  { prefix: '/api/terminal', methods: ['GET', 'POST'] },
  { prefix: '/api/right-tools', methods: ['GET', 'POST'] },
] as const

/** 按完整路径段匹配，不能让 debug-admin 等相似前缀借用调试授权。 */
export function isPeerHostHttpRoute(method: string, path: string): boolean {
  const route = PEER_HOST_HTTP_PROXY_RULES.find(candidate => path === candidate.prefix || path.startsWith(`${candidate.prefix}/`))
  return route !== undefined && (route.methods as readonly string[]).includes(method.toUpperCase())
}

/**
 * 生成 DSH 原生会话引用使用的 canonical URI。
 *
 * 引用正文会经过 PeerHost 的双向 ID 改写，因此这里必须与 DSH
 * `sessionReferenceResolver` 使用同一套 JSON + base64url 编码，不能把
 * 虚拟 SessionId 直接拼进 Markdown。
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sessionId))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const browserEncoder = (globalThis as { btoa?: (value: string) => string }).btoa
  const base64 = typeof browserEncoder === 'function'
    ? browserEncoder(binary)
    : readNodeBuffer().from(bytes).toString('base64')
  return `dsh-session:${base64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}`
}

/** 生成 `@[标题](dsh-session:...)` 形式的 DSH 会话引用。 */
export function formatSessionReferenceMention(label: string, sessionId: string): string {
  return `@[${label}](${encodeSessionReferenceUri(sessionId)})`
}

function readNodeBuffer(): { from(value: Uint8Array): { toString(encoding: string): string } } {
  const buffer = (globalThis as { Buffer?: { from(value: Uint8Array): { toString(encoding: string): string } } }).Buffer
  if (buffer !== undefined) return buffer
  throw new Error('当前运行时不支持 Base64 编码')
}

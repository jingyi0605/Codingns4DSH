import { open, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CodingNsCliSessionProbeInput, CodingNsCliSessionProbeResult } from './driver.js'

export interface StoredSessionProbeOptions {
  readonly roots: readonly string[]
  readonly matches: (path: string, entry: Dirent, providerSessionId: string) => boolean
  readonly validate: (path: string, providerSessionId: string) => Promise<boolean>
  readonly maxDepth?: number
}

/**
 * 在 Provider 的权威存储中只读查找会话。只有精确引用不存在，或成功扫描过
 * 至少一个权威根目录仍未找到时，才返回 missing。
 */
export async function probeStoredSession(
  input: CodingNsCliSessionProbeInput,
  options: StoredSessionProbeOptions,
): Promise<CodingNsCliSessionProbeResult> {
  const providerSessionId = input.providerSessionId?.trim()
  if (!providerSessionId) return { state: 'unknown', reason: '缺少 Provider 会话标识' }
  throwIfAborted(input.signal)

  const rawStoreRef = input.rawStoreRef?.trim()
  let exactHintFailure: CodingNsCliSessionProbeResult | undefined
  if (rawStoreRef) {
    const exactResult = await validateCandidate(rawStoreRef, providerSessionId, options.validate, true, input.signal)
    if (exactResult.state === 'available' || exactResult.state === 'unreachable' || exactResult.state === 'unknown') return exactResult
    // rawStoreRef 只是 hint。Provider 可能移动文件，也可能复用旧路径；ENOENT、
    // 内容不匹配或损坏都必须继续扫描权威 roots，找到后再更新引用。
    exactHintFailure = exactResult
  }

  let accessibleRoots = 0
  const candidates: string[] = []
  for (const root of options.roots) {
    try {
      throwIfAborted(input.signal)
      const entries = await walk(root, options.maxDepth ?? 6, input.signal)
      accessibleRoots += 1
      for (const entry of entries) if (options.matches(entry.path, entry.entry, providerSessionId)) candidates.push(entry.path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      if (isAccessError(error)) return { state: 'unreachable', reason: '无法读取 Provider 会话存储' }
      return { state: 'unknown', reason: 'Provider 会话存储探测失败' }
    }
  }

  if (candidates.length === 0) {
    if (exactHintFailure?.state === 'corrupt') return exactHintFailure
    return accessibleRoots > 0
      ? { state: 'missing', reason: 'Provider 会话存储中不存在该会话' }
      : exactHintFailure ?? { state: 'unknown', reason: 'Provider 会话存储不存在或尚未初始化' }
  }

  let sawCorrupt = false
  for (const candidate of candidates) {
    const result = await validateCandidate(candidate, providerSessionId, options.validate, false, input.signal)
    if (result.state === 'available') return result
    if (result.state === 'unreachable' || result.state === 'unknown') return result
    if (result.state === 'corrupt') sawCorrupt = true
  }
  return sawCorrupt
    ? { state: 'corrupt', reason: 'Provider 会话记录无法验证' }
    : { state: 'missing', reason: 'Provider 会话记录已被删除' }
}

/** 读取 JSONL 第一条非空记录，限制读取量，避免为一次探测加载完整历史。 */
export async function readFirstJsonRecord(path: string): Promise<Record<string, unknown> | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = new Uint8Array(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const line = new TextDecoder().decode(buffer.subarray(0, bytesRead)).split(/\r?\n/u).find((value) => value.trim() !== '')
    if (line === undefined) return null
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } finally {
    await handle.close()
  }
}

/** 将文件或目录引用规整到会话目录，供目录型 Provider 复用。 */
export async function resolveSessionDirectory(path: string): Promise<string> {
  return (await stat(path)).isDirectory() ? path : dirname(path)
}

/** 仅验证目标是普通文件，不读取历史正文。 */
export async function isRegularFile(path: string): Promise<boolean> {
  return (await stat(path)).isFile()
}

async function validateCandidate(
  path: string,
  providerSessionId: string,
  validate: StoredSessionProbeOptions['validate'],
  exact: boolean,
  signal?: AbortSignal,
): Promise<CodingNsCliSessionProbeResult> {
  try {
    throwIfAborted(signal)
    const valid = await validate(path, providerSessionId)
    throwIfAborted(signal)
    return valid
      ? { state: 'available', reason: 'Provider 原始会话可用', rawStoreRef: path }
      : { state: 'corrupt', reason: 'Provider 会话记录与绑定标识不一致', rawStoreRef: path }
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
      return { state: 'missing', reason: exact ? '绑定的 Provider 会话记录已被删除' : 'Provider 会话记录已被删除' }
    }
    if (error instanceof SyntaxError) return { state: 'corrupt', reason: 'Provider 会话记录不是有效 JSON', rawStoreRef: path }
    if (isAccessError(error)) return { state: 'unreachable', reason: '没有权限读取 Provider 会话记录', rawStoreRef: path }
    return { state: 'unknown', reason: 'Provider 会话记录验证失败', rawStoreRef: path }
  }
}

async function walk(root: string, maxDepth: number, signal?: AbortSignal): Promise<Array<{ path: string; entry: Dirent }>> {
  const found: Array<{ path: string; entry: Dirent }> = []
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  while (queue.length > 0) {
    throwIfAborted(signal)
    const current = queue.shift()!
    const entries = await readdir(current.path, { withFileTypes: true })
    throwIfAborted(signal)
    for (const entry of entries) {
      const path = join(current.path, entry.name)
      found.push({ path, entry })
      if (entry.isDirectory() && current.depth < maxDepth) queue.push({ path, depth: current.depth + 1 })
    }
  }
  return found
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const error = new Error('Provider 会话探测已取消')
  error.name = 'AbortError'
  throw error
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function isAccessError(error: unknown): boolean {
  return errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

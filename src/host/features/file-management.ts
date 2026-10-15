import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import type { FeatureModule } from '../../shared/contracts/feature.js'
import { CodingNsRpcError } from '../rpc-table.js'
import type { CodingNsHostServices } from './types.js'
import { readSessionChangedFiles } from '../session-changes.js'
import { runHtmlWorkspaceFileOperation } from '../html-workspace-files.js'

const MAX_EDIT_BYTES = 4 * 1024 * 1024

/** 文件管理增强的 Host 边界；所有路径先解析到已知工作区，再执行文件操作。 */
export function createFileManagementFeature(): FeatureModule<CodingNsHostServices> {
  return {
    descriptor: {
      name: 'fileManagement',
      version: '0.1.0',
      enabledByDefault: false,
      dependencies: [],
      runtime: 'host',
    },
    start(context) {
      context.resources.add(context.services.rpc.register('fileManagement', async (action, payload) => {
        const input = record(payload)
        switch (action) {
          case 'html-files': {
            const sessionId = requiredString(input.sessionId, 'sessionId')
            const root = findSessionRoot(context.services, sessionId)
            if (!root) throw new CodingNsRpcError('FILE_MANAGEMENT_WORKSPACE_UNAVAILABLE', 'This session has no available workspace')
            return runHtmlWorkspaceFileOperation(root, input)
          }
          case 'session-changes': {
            const sessionId = requiredString(input.sessionId, 'sessionId')
            const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
            const root = workspaceId !== ''
              ? context.services.resolveWorkspaceRoot?.(workspaceId) ?? findSessionRoot(context.services, sessionId)
              : findSessionRoot(context.services, sessionId)
            if (root === null || root === undefined || root.trim() === '') {
              throw new CodingNsRpcError('FILE_MANAGEMENT_WORKSPACE_UNAVAILABLE', '当前会话没有可用的工作区目录')
            }
            return readSessionChangedFiles(context.services, sessionId, root)
          }
          case 'read': {
            const target = resolveTarget(context.services, input)
            const info = await stat(target.absolute)
            if (!info.isFile()) throw new CodingNsRpcError('FILE_MANAGEMENT_NOT_FILE', '目标不是普通文件')
            if (typeof info.size === 'number' && info.size > MAX_EDIT_BYTES) throw new CodingNsRpcError('FILE_MANAGEMENT_TOO_LARGE', '文件超过可编辑大小限制')
            return { path: target.absolute, content: await readFile(target.absolute, 'utf8') }
          }
          case 'download': {
            const target = resolveTarget(context.services, input)
            const info = await stat(target.absolute)
            if (!info.isFile()) throw new CodingNsRpcError('FILE_MANAGEMENT_NOT_FILE', '目标不是普通文件')
            const content = await readFile(target.absolute)
            return {
              path: target.absolute,
              fileName: basename(target.absolute),
              mimeType: mimeTypeForPath(target.absolute),
              contentBase64: Buffer.from(content).toString('base64'),
            }
          }
          case 'write': {
            const target = resolveTarget(context.services, input)
            const content = requiredString(input.content, 'content', false)
            if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) throw new CodingNsRpcError('FILE_MANAGEMENT_TOO_LARGE', '文件超过可编辑大小限制')
            const info = await stat(target.absolute)
            if (!info.isFile()) throw new CodingNsRpcError('FILE_MANAGEMENT_NOT_FILE', '目标不是普通文件')
            await atomicWrite(target.absolute, content)
            return { path: target.absolute }
          }
          case 'create-file': {
            const target = resolveTarget(context.services, input)
            await mkdir(dirname(target.absolute), { recursive: true })
            await writeFile(target.absolute, '', { encoding: 'utf8', flag: 'wx' })
            return { path: target.absolute }
          }
          case 'create-directory': {
            const target = resolveTarget(context.services, input)
            await mkdir(target.absolute, { recursive: false })
            return { path: target.absolute }
          }
          case 'rename': {
            const source = resolveTarget(context.services, input)
            const destination = resolveTarget(context.services, { ...input, path: input.destination })
            await mkdir(dirname(destination.absolute), { recursive: true })
            await rename(source.absolute, destination.absolute)
            return { from: source.absolute, path: destination.absolute }
          }
          case 'copy':
            return copyTargets(context.services, input)
          case 'move':
            return moveTargets(context.services, input)
          case 'delete': {
            const paths = requiredStringArray(input.paths, 'paths')
            for (const path of paths) {
              const target = resolveTarget(context.services, { ...input, path })
              await rm(target.absolute, { recursive: true, force: false })
            }
            return { paths }
          }
          case 'git-ignore':
            return addGitIgnore(context.services, input)
          default:
            throw new CodingNsRpcError('CODINGNS_RPC_NOT_FOUND', `未知文件管理 RPC: fileManagement/${action}`)
        }
      }))
    },
  }
}

async function copyTargets(services: CodingNsHostServices, input: Record<string, unknown>): Promise<{ paths: readonly string[] }> {
  const paths = requiredStringArray(input.paths, 'paths')
  const destination = resolveTarget(services, { ...input, path: input.destination })
  const destinationInfo = await stat(destination.absolute)
  if (!destinationInfo.isDirectory()) throw new CodingNsRpcError('FILE_MANAGEMENT_NOT_DIRECTORY', '粘贴目标不是目录')
  for (const path of paths) {
    const source = resolveTarget(services, { ...input, path })
    await copyEntry(source.absolute, join(destination.absolute, basename(source.absolute)))
  }
  return { paths }
}

async function moveTargets(services: CodingNsHostServices, input: Record<string, unknown>): Promise<{ paths: readonly string[] }> {
  const paths = requiredStringArray(input.paths, 'paths')
  const destination = resolveTarget(services, { ...input, path: input.destination })
  const destinationInfo = await stat(destination.absolute)
  if (!destinationInfo.isDirectory()) throw new CodingNsRpcError('FILE_MANAGEMENT_NOT_DIRECTORY', '粘贴目标不是目录')
  for (const path of paths) {
    const source = resolveTarget(services, { ...input, path })
    await rename(source.absolute, join(destination.absolute, basename(source.absolute)))
  }
  return { paths }
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const info = await stat(source)
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: false })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyEntry(join(source, entry.name), join(destination, entry.name))
    }
    return
  }
  await copyFile(source, destination)
}

async function addGitIgnore(services: CodingNsHostServices, input: Record<string, unknown>): Promise<{ paths: readonly string[] }> {
  const paths = requiredStringArray(input.paths, 'paths')
  const resolved = paths.map((path) => resolveTarget(services, { ...input, path }))
  const roots = new Set(resolved.map((item) => item.root))
  if (roots.size !== 1) throw new CodingNsRpcError('FILE_MANAGEMENT_MULTIPLE_ROOTS', '一次只能处理同一个工作区中的文件')
  const root = resolved[0]?.root
  if (root === undefined) throw new TypeError('paths 不能为空')
  const ignorePath = join(root, '.gitignore')
  let current = ''
  try { current = await readFile(ignorePath, 'utf8') } catch { /* .gitignore 不存在时从空文件开始。 */ }
  const lines = current.split(/\r?\n/u).filter((line) => line.trim() !== '')
  for (const item of resolved) {
    const path = relative(root, item.absolute).replaceAll('\\', '/')
    const info = await stat(item.absolute)
    const pattern = info.isDirectory() ? `${path}/` : path
    if (!lines.includes(pattern)) lines.push(pattern)
  }
  await atomicWrite(ignorePath, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
  return { paths }
}

function resolveTarget(services: CodingNsHostServices, input: Record<string, unknown>): { absolute: string; root: string } {
  const rawPath = requiredString(input.path, 'path')
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
  const sessionRoot = sessionId === '' ? undefined : findSessionRoot(services, sessionId)
  const absolute = isAbsolute(rawPath)
    ? normalize(rawPath)
    : sessionRoot === undefined ? resolve(rawPath) : normalize(join(sessionRoot, rawPath))
  const roots = [...new Set([...(services.listWorkspaceRoots?.() ?? []), ...(sessionRoot === undefined ? [] : [sessionRoot])])]
    .map((root) => normalize(root))
    .filter((root) => root !== '')
    .sort((left, right) => right.length - left.length)
  const root = roots.find((candidate) => isInside(candidate, absolute))
  if (root === undefined) throw new CodingNsRpcError('FILE_MANAGEMENT_OUTSIDE_WORKSPACE', '路径不在已知工作区内')
  return { absolute, root }
}

function findSessionRoot(services: CodingNsHostServices, sessionId: string): string | undefined {
  const session = services.nativeSessions?.get(sessionId)
  return findCwd(session, 0)
}

function findCwd(value: unknown, depth: number): string | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCwd(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const key of ['cwd', 'workingDirectory']) {
    if (typeof record[key] === 'string' && record[key].trim() !== '') return record[key].trim()
  }
  for (const key of ['header', 'request', 'context', 'data', 'meta', 'session']) {
    const found = findCwd(record[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function isInside(root: string, target: string): boolean {
  const escaped = relative(root, target)
  return escaped === '' || (!escaped.startsWith('..') && !isAbsolute(escaped))
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.codingns-tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`
  let mode = 0o600
  try {
    const current = await stat(path)
    mode = current.mode === undefined ? mode : current.mode & 0o777
  } catch {
    // 新建 .gitignore 时使用受限默认权限。
  }
  await writeFile(temporary, content, { encoding: 'utf8', mode })
  try {
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

function requiredString(value: unknown, field: string, trim = true): string {
  if (typeof value !== 'string' || (trim && value.trim() === '')) throw new TypeError(`${field} 必须是非空字符串`)
  return trim ? value.trim() : value
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) throw new TypeError(`${field} 必须是非空字符串数组`)
  return value.map((item) => (item as string).trim())
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('文件管理 RPC 参数必须是对象')
  return value as Record<string, unknown>
}

function mimeTypeForPath(path: string): string {
  const extension = path.toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1] ?? ''
  return ({
    css: 'text/css',
    csv: 'text/csv',
    gif: 'image/gif',
    html: 'text/html',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    js: 'text/javascript',
    json: 'application/json',
    md: 'text/markdown',
    pdf: 'application/pdf',
    png: 'image/png',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    zip: 'application/zip',
  } as Record<string, string>)[extension] ?? 'application/octet-stream'
}

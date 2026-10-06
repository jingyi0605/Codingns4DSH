import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import type { CodingNsCliSkillDescriptor } from '../../shared/contracts/cli-adapter.js'

/** Host 内部保留的 Skill 路径；路径不能返回 Client。 */
export interface CodingNsDiscoveredSkill extends CodingNsCliSkillDescriptor {
  readonly path: string
}

export interface CompatibleSkillScanOptions {
  /** 项目目录候选，数组顺序就是同一层的优先级。 */
  readonly projectDirectories: readonly string[]
  /** 用户目录候选，数组顺序就是优先级。 */
  readonly userDirectories: readonly string[]
  /** Claude 的用户级定义优先于项目定义。 */
  readonly userFirst?: boolean
  /** 是否读取当前目录向上的项目层。默认读取到文件系统根目录。 */
  readonly stopAtGitRoot?: boolean
}

interface SkillRoot {
  readonly path: string
  /** 项目子目录的原生限定名，避免同名 Skill 调用到仓库根目录定义。 */
  readonly namespace?: string
}

/**
 * 扫描 Provider 原生支持的 SKILL.md 布局。
 *
 * Provider 自己负责把正文注入模型；Host 这里只验证 frontmatter、去重并提供
 * 菜单摘要。这样 `/name` 仍然由 Provider 原生解析，不会把 Skill 正文复制进 DSH。
 */
export function scanCompatibleSkills(cwd: string, options: CompatibleSkillScanOptions): readonly CodingNsDiscoveredSkill[] {
  const entries: CodingNsDiscoveredSkill[] = []
  const seenNames = new Set<string>()
  const visited = new Set<string>()
  const projectRoots = compatibleProjectRoots(cwd, options)
  const userRoots = options.userDirectories.map((path) => ({ path }))
  const roots = options.userFirst === true
    ? [...userRoots, ...projectRoots]
    : [...projectRoots, ...userRoots]
  for (const root of roots) scanSkillRoot(root, entries, seenNames, visited)
  return entries
}

function compatibleProjectRoots(cwd: string, options: CompatibleSkillScanOptions): readonly SkillRoot[] {
  const directories: string[] = []
  let current = resolve(cwd)
  while (true) {
    directories.push(current)
    if (options.stopAtGitRoot === true && existsSync(join(current, '.git'))) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  // 根目录普通名称先加载；子目录冲突时使用 Provider 原生的目录限定名。
  const projectRoot = directories.at(-1) ?? resolve(cwd)
  return directories.reverse().flatMap((directory) => options.projectDirectories.map((skillDirectory) => {
    const namespace = relative(projectRoot, directory).replaceAll('\\', '/')
    return { path: join(directory, skillDirectory), ...(namespace === '' ? {} : { namespace }) }
  }))
}

function scanSkillRoot(
  root: SkillRoot,
  entries: CodingNsDiscoveredSkill[],
  seenNames: Set<string>,
  visited: Set<string>,
): void {
  const canonicalRoot = canonicalDirectory(root.path)
  if (canonicalRoot === null) return
  const walk = (directory: string, depth: number): void => {
    if (depth > 32) return
    const canonicalDirectoryPath = canonicalDirectory(directory)
    if (canonicalDirectoryPath === null || visited.has(canonicalDirectoryPath)) return
    visited.add(canonicalDirectoryPath)
    // 使用入口路径保留符号链接的目录名称，规范路径仅用于去重。
    const skillFile = join(directory, 'SKILL.md')
    if (isFile(skillFile)) {
      // 带插件清单的 Skill 文件夹由 Claude 插件加载器处理，不能伪装成普通目录。
      if (isFile(join(directory, '.claude-plugin', 'plugin.json'))) return
      const skill = parseSkillFile(skillFile)
      if (skill !== null) {
        const name = seenNames.has(skill.name) && root.namespace !== undefined ? `${root.namespace}:${basename(directory)}` : skill.name
        if (!seenNames.has(name)) {
          seenNames.add(name)
          entries.push({ ...skill, id: name, name })
        }
      }
      return
    }
    let children
    try { children = readdirSync(canonicalDirectoryPath, { withFileTypes: true }) } catch { return }
    for (const child of children) {
      if (['.git', 'node_modules', '.trash', 'synced', 'anthropic-skills'].includes(child.name.toLowerCase())) continue
      // Claude 原生允许 Skill 文件夹是符号链接；realpath + visited 防止链接环。
      if (child.isDirectory() || child.isSymbolicLink()) walk(join(directory, child.name), depth + 1)
    }
  }
  walk(root.path, 0)
}

function parseSkillFile(path: string): CodingNsDiscoveredSkill | null {
  let source: string
  try { source = readFileSync(path, 'utf8') } catch { return null }
  const match = source.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)
  if (match === null && /^(?:\uFEFF)?---\r?\n/u.test(source)) return null
  const fields = match === null ? {} : parseSkillFrontmatter(match[1] ?? '')
  if (fields === null) return null
  if (fields.name !== undefined && typeof fields.name !== 'string') return null
  if (fields.description !== undefined && typeof fields.description !== 'string') return null
  const directoryName = basename(dirname(path))
  const name = typeof fields.name === 'string' ? fields.name.trim() : directoryName
  const description = typeof fields.description === 'string' ? fields.description.trim() : firstBodyParagraph(match === null ? source : source.slice(match[0].length))
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name) || description === '') return null
  if (name === 'synced' || name === 'anthropic-skills') return null
  return {
    id: name,
    name,
    description,
    enabled: fields['user-invocable'] !== false,
    path: dirname(path),
  }
}

/** 共用 YAML 校验；各 Provider 仍分别决定必填字段和名称规则。 */
export function parseSkillFrontmatter(source: string): Record<string, unknown> | null {
  // 使用完整 YAML 解析，避免折叠段落、引号和嵌套 metadata 被简化解析器误读。
  try {
    const document = parseDocument(source)
    if (document.errors.length > 0) return null
    const value: unknown = document.toJS({ maxAliasCount: 100 })
    if (value === null) return {}
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch { return null }
}

function firstBodyParagraph(body: string): string {
  const paragraph = body
    .replace(/^\s*#{1,6}[^\r\n]*(?:\r?\n|$)/gmu, '')
    .split(/\r?\n\s*\r?\n/u)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => part !== '')
  return paragraph ?? ''
}

function canonicalDirectory(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return null
    return realpathSync(path)
  } catch { return null }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

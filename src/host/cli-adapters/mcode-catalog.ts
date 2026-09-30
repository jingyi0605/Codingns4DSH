import type { CodingNsCliModelCatalog } from '../../shared/contracts/cli-adapter.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface McodeModelEntry {
  readonly id: string
  readonly efforts: readonly string[]
  readonly defaultEffort?: string
}

export interface McodeModelCatalogData {
  readonly models: readonly McodeModelEntry[]
  readonly currentModel: string | null
}

/**
 * 解析 mcode 官方 CLI 自己维护的 `~/.minimax/config.yaml` 模型清单。
 *
 * 与 codex 驱动从 `model/list` 读取 `supportedReasoningEfforts` 同理：档位
 * 以 CLI 自己声明为准（`thinking.effortOptions` + `defaultEffort`），不硬编码。
 * 这里只针对该文件的实际结构做定向解析，完整 YAML 不在插件依赖范围内。
 */
export function parseMcodeModelCatalog(configYaml: string): McodeModelCatalogData | null {
  const lines = configYaml.split(/\r?\n/u)
  const modelsHeader = lines.findIndex((line) => /^\s*models:\s*$/u.test(line))
  if (modelsHeader < 0) return null
  const modelsIndent = indentOf(lines[modelsHeader]!)

  const order: string[] = []
  const efforts = new Map<string, string[]>()
  const defaults = new Map<string, string>()
  let current: string | null = null
  let effortListIndent = -1

  for (let index = modelsHeader + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent < modelsIndent + 2) break
    const trimmed = line.trim()

    if (indent === modelsIndent + 2 && trimmed.endsWith(':')) {
      current = trimmed.slice(0, -1)
      order.push(current)
      effortListIndent = -1
      continue
    }
    if (current === null) continue

    if (trimmed === 'effortOptions:') {
      effortListIndent = indent
      efforts.set(current, [])
      continue
    }
    if (effortListIndent >= 0 && indent > effortListIndent && trimmed.startsWith('- ')) {
      efforts.get(current)?.push(trimmed.slice(2).trim())
      continue
    }
    if (effortListIndent >= 0 && indent <= effortListIndent) effortListIndent = -1

    const defaultEffort = trimmed.match(/^defaultEffort:\s*(.+)$/u)
    if (defaultEffort !== null) defaults.set(current, defaultEffort[1]!.trim())
  }

  if (order.length === 0) return null

  // model_order 段给出官方展示顺序；缺省保持声明顺序。
  const orderHeader = lines.findIndex((line) => /^\s*model_order:\s*$/u.test(line))
  if (orderHeader >= 0) {
    const ordered: string[] = []
    for (let index = orderHeader + 1; index < lines.length; index += 1) {
      const line = lines[index]!
      if (line.trim() === '') continue
      if (indentOf(line) <= indentOf(lines[orderHeader]!)) break
      const item = line.trim().match(/^-\s*(.+)$/u)
      if (item !== null && order.includes(item[1]!.trim())) ordered.push(item[1]!.trim())
    }
    const rest = order.filter((name) => !ordered.includes(name))
    order.splice(0, order.length, ...ordered, ...rest)
  }

  const defaultModel = lines.find((line) => /^defaultModel:\s*/u.test(line))
  const currentModel = defaultModel !== undefined
    ? defaultModel.replace(/^defaultModel:\s*/, '').trim() || null
    : null

  return {
    models: order.map((name) => {
      const defaultEffort = defaults.get(name)
      return {
        id: name,
        efforts: efforts.get(name) ?? [],
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      }
    }),
    currentModel,
  }
}

/** 组装 DSH 模型目录；模型 id 统一加 provider 前缀，便于 exec `--model` 直接使用。 */
export function buildMcodeCatalog(data: McodeModelCatalogData, providerId = 'minimax'): CodingNsCliModelCatalog {
  const currentEntry = data.models.find((model) => `${providerId}/${model.id}` === data.currentModel)
  return {
    groups: [{
      id: 'mcode',
      name: 'MiniMax Code',
      models: data.models.map((model) => {
        const id = `${providerId}/${model.id}`
        return {
          id,
          name: model.id,
          efforts: model.efforts,
        }
      }),
    }],
    currentModel: data.currentModel,
    currentEffort: currentEntry?.defaultEffort ?? null,
  }
}

function indentOf(line: string): number {
  const match = line.match(/^\s*/u)
  return match?.[0]?.length ?? 0
}

/** 读取 mcode 官方配置；文件缺失或损坏时返回 null。 */
export function readMcodeConfigYaml(home: string): string | null {
  try {
    return readFileSync(join(home, 'config.yaml'), 'utf8')
  } catch {
    return null
  }
}

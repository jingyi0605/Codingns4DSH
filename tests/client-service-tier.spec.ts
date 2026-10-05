import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeServiceTier,
  canSelectServiceTier,
  carriedServiceTierId,
  effectiveServiceTierId,
  isServiceTierEnabled,
  modelServiceTiers,
  needsServiceTierRevalidation,
  toggledServiceTierId,
  STANDARD_SERVICE_TIER_ID,
} from '../data/build/dist/client/service-tier.js'
import type { CodingNsCliModel, CodingNsCliModelCatalog } from '../data/build/dist/shared/contracts/cli-adapter.js'

const fastTier = { id: 'priority', name: 'Fast', description: '2x speed, increased usage' }

function model(overrides: Partial<CodingNsCliModel> = {}): CodingNsCliModel {
  return { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'high'], ...overrides }
}

function catalog(overrides: Partial<CodingNsCliModelCatalog> = {}): CodingNsCliModelCatalog {
  return { groups: [], currentModel: null, currentEffort: null, ...overrides }
}

test('只有官方订阅且模型声明了档位时才展示服务档位开关', () => {
  const withTier = model({ serviceTiers: [fastTier] })
  assert.equal(canSelectServiceTier(catalog({ officialSubscription: true }), withTier), true)
  // 第三方中转/纯 API key 接入：目录仍可能带档位元数据，但档位不会真正生效。
  assert.equal(canSelectServiceTier(catalog({ officialSubscription: false }), withTier), false)
  // 未确认（旧版 Codex 没有 account/read）必须按不可用处理，不能当成“已确认”。
  assert.equal(canSelectServiceTier(catalog({}), withTier), false)
  assert.equal(canSelectServiceTier(null, withTier), false)
  // 模型没有声明档位时不展示。
  assert.equal(canSelectServiceTier(catalog({ officialSubscription: true }), model()), false)
  assert.equal(canSelectServiceTier(catalog({ officialSubscription: true }), undefined), false)
})

test('未选择档位时回落到 Provider 配置的默认档位，再回落到标准速度', () => {
  // Codex 的 config.service_tier 会被 app-server 继承，不能显示成标准档。
  const configuredFast = catalog({ officialSubscription: true, defaultServiceTier: 'priority' })
  assert.equal(effectiveServiceTierId(configuredFast, undefined), 'priority')
  assert.equal(isServiceTierEnabled(configuredFast, undefined), true)
  assert.equal(activeServiceTier(configuredFast, model({ serviceTiers: [fastTier] }), undefined)?.name, 'Fast')

  const configuredStandard = catalog({ officialSubscription: true, defaultServiceTier: null })
  assert.equal(effectiveServiceTierId(configuredStandard, undefined), STANDARD_SERVICE_TIER_ID)
  assert.equal(isServiceTierEnabled(configuredStandard, undefined), false)

  // 目录未给出配置值时按标准速度处理，不能凭空造出一个档位。
  assert.equal(effectiveServiceTierId(catalog({}), undefined), STANDARD_SERVICE_TIER_ID)
  assert.equal(effectiveServiceTierId(null, undefined), STANDARD_SERVICE_TIER_ID)

  // 用户显式选择优先于配置默认值。
  assert.equal(effectiveServiceTierId(configuredFast, 'default'), 'default')
  assert.equal(isServiceTierEnabled(configuredFast, 'default'), false)
  // 空白选择等同于未选择。
  assert.equal(effectiveServiceTierId(configuredStandard, '  '), STANDARD_SERVICE_TIER_ID)
})

test('切换开关写入协议档位 id，关闭时显式写标准速度', () => {
  const withTier = model({ serviceTiers: [fastTier] })
  assert.equal(toggledServiceTierId(withTier, true), 'priority')
  // 关闭必须写 `default` 而不是 undefined：undefined 表示“不下发”，
  // 会让线程保留上一次的加速档。
  assert.equal(toggledServiceTierId(withTier, false), STANDARD_SERVICE_TIER_ID)
  // 模型没有声明档位时无法打开。
  assert.equal(toggledServiceTierId(model(), true), undefined)
})

test('模型未声明档位时清空已有选择，避免向不支持档位的模型继续下发', () => {
  assert.deepEqual(modelServiceTiers(model()), [])
  assert.deepEqual(modelServiceTiers(undefined), [])
  assert.equal(activeServiceTier(catalog({}), model(), 'priority'), undefined)
})

test('部分更新携带档位：改思考等级或目录规范化都不会把 Fast 掉回标准档', () => {
  const withTier = model({ serviceTiers: [fastTier] })

  // 开了 Fast 之后只改思考等级：档位必须原样带过去。
  assert.equal(carriedServiceTierId(withTier, 'priority'), 'priority')
  // 目录就绪后的规范化同样只改 modelId/effortId，档位也必须保留。
  assert.equal(carriedServiceTierId(withTier, 'priority'), 'priority')
  // 显式关闭状态（default）同样要携带，不能因为“不是加速档”就省略。
  assert.equal(carriedServiceTierId(withTier, 'default'), 'default')
  // 当前没有档位时不凭空引入。
  assert.equal(carriedServiceTierId(withTier, undefined), undefined)
  assert.equal(carriedServiceTierId(withTier, '  '), undefined)
})

test('切到不支持该档位的模型时显式回落标准速度，而不是省略', () => {
  // 新模型完全不声明档位。
  assert.equal(carriedServiceTierId(model(), 'priority'), STANDARD_SERVICE_TIER_ID)
  // 新模型声明了别的档位。
  assert.equal(
    carriedServiceTierId(model({ serviceTiers: [{ id: 'turbo', name: 'Turbo' }] }), 'priority'),
    STANDARD_SERVICE_TIER_ID,
  )
  // 新模型声明了同一档位则保留。
  assert.equal(carriedServiceTierId(model({ serviceTiers: [fastTier] }), 'priority'), 'priority')
  // 模型未知（目录还没回来）时保守回落，避免向未知模型下发档位。
  assert.equal(carriedServiceTierId(undefined, 'priority'), STANDARD_SERVICE_TIER_ID)
})

test('未确认官方订阅但目录声明了档位时，判定值得复检', () => {
  const withTier = model({ serviceTiers: [fastTier] })
  // 第三方接入的典型形态：模型声明档位、账号判定为 false。
  assert.equal(needsServiceTierRevalidation(catalog({ officialSubscription: false, groups: [{ id: 'codex', name: 'Codex', models: [withTier] }] })), true)
  // 未确认（字段缺省）同样是“可能过期”，需要复检。
  assert.equal(needsServiceTierRevalidation(catalog({ groups: [{ id: 'codex', name: 'Codex', models: [withTier] }] })), true)
  // 已确认官方订阅时无需复检：开关该显示就显示。
  assert.equal(needsServiceTierRevalidation(catalog({ officialSubscription: true, groups: [{ id: 'codex', name: 'Codex', models: [withTier] }] })), false)
  // 目录没有任何档位声明：无论订阅判定如何都不必复检。
  assert.equal(needsServiceTierRevalidation(catalog({ officialSubscription: false, groups: [{ id: 'x', name: 'X', models: [model()] }] })), false)
  assert.equal(needsServiceTierRevalidation(catalog({ officialSubscription: false })), false)
  assert.equal(needsServiceTierRevalidation(null), false)
})

test('档位行与菜单行共用同一盒模型，避免撑破弹层产生横向滚动条', async () => {
  const { readFile } = await import('node:fs/promises')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const source = await readFile(join(root, 'src/client/cli-slots.ts'), 'utf8')

  const styleOf = (name: string): string => {
    const start = source.indexOf(`const ${name} = {`)
    assert.notEqual(start, -1, `未找到样式 ${name}`)
    return source.slice(start, source.indexOf('\n', start))
  }
  const cell = styleOf('nativeMenuCellStyle')
  const tierRow = styleOf('serviceTierRowStyle')

  // 根因回归：nativeMenuCellStyle 用在 <button> 上（DSH 全局给了 border-box），
  // serviceTierRowStyle 用在 <div> 上。div 默认 content-box 时 width:100% 会把
  // 左右各 10px 的内边距额外算出去，整行比相邻行宽 20px，撑出横向滚动条，
  // 档位开关被推到贴住弹层右缘、与模型/思考等级的箭头错位。
  assert.match(cell, /boxSizing: 'border-box'/u, '菜单行必须显式声明 border-box，不能依赖 button 的默认样式')
  assert.match(tierRow, /boxSizing: 'border-box'/u, '档位行是 div，必须显式声明 border-box 才能与菜单行等宽')

  // 三行必须共用同一套内边距与最小高度，否则即使盒模型一致也会错位。
  for (const [name, style] of [['菜单行', cell], ['档位行', tierRow]] as const) {
    assert.match(style, /minHeight: 40/u, `${name}的最小高度必须与相邻行一致`)
    assert.match(style, /padding: '0 10px'/u, `${name}的左右内边距必须与相邻行一致`)
  }

  // 弹层横向不得可滚动：纵向滚动是设计内的，横向滚动只会来自子元素溢出。
  const menu = styleOf('nativeMenuStyle')
  assert.match(menu, /overflowX: 'hidden'/u, '弹层必须禁止横向滚动，溢出应作为缺陷暴露而不是被滚动条掩盖')
  assert.match(menu, /overflowY: 'auto'/u, '纵向滚动是既有设计，不能一并去掉')
})

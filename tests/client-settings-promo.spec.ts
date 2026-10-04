import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CODINGNS_GITHUB_URL } from '../data/build/dist/client/settings-promo.js'
import { settingsPromoClass } from '../data/build/dist/client/settings-promo-styles.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readProjectFile = (path: string): Promise<string> => readFile(join(root, path), 'utf8')

/** 去掉块注释与行注释，避免注释里的词命中「不得出现」类断言。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
}

test('推广条常量与 GitHub 仓库地址唯一', async () => {
  assert.equal(CODINGNS_GITHUB_URL, 'https://github.com/jingyi0605/Codingns4DSH')
  const section = await readProjectFile('src/client/settings-section.ts')
  // 设置页版本信息与推广按钮必须共用同一个地址，不允许出现第二份字面量。
  assert.doesNotMatch(section, /https:\/\/github\.com\//u, 'settings-section.ts 不得再写死 GitHub 地址')
  assert.match(section, /import \{ CodingNsSettingsPromo, CODINGNS_GITHUB_URL \} from '\.\/settings-promo\.js'/u)
})

test('设置页把推广条渲染在模块卡片之前', async () => {
  const section = await readProjectFile('src/client/settings-section.ts')
  const promoIndex = section.indexOf('createElement(CodingNsSettingsPromo, { locale: services.locale })')
  const cardsIndex = section.indexOf('settingsModules(registry).map')
  assert.ok(promoIndex > 0, '设置页缺少推广条渲染')
  assert.ok(cardsIndex > promoIndex, '推广条必须位于模块卡片之前')
  // 推广条只读取 locale，不参与设置快照，避免给设置分区引入新的订阅或写入循环。
  assert.match(section, /createElement\(CodingNsSettingsPromo, \{ locale: services\.locale \}\)/u)
  const promo = stripComments(await readProjectFile('src/client/settings-promo.ts'))
  assert.doesNotMatch(promo, /useSyncExternalStore\(|settings\.mutate\(|services\.settings/u, '推广条不得读写设置作用域')
})

test('推广条包含品牌、版本胶囊、引导文案与 GitHub 按钮四段结构', async () => {
  const promo = await readProjectFile('src/client/settings-promo.ts')
  for (const key of ['settings.promo.sectionLabel', 'settings.promo.version', 'settings.promo.starHint', 'settings.promo.github', 'settings.promo.actionLabel']) {
    assert.ok(promo.includes(`'${key}'`), `推广条缺少文案键 ${key}`)
  }
  assert.match(promo, /CODINGNS_VERSION/u, '版本胶囊必须取插件真实版本，不能写死')
  assert.match(promo, /target: '_blank'/u)
  assert.match(promo, /rel: 'noreferrer'/u)
  assert.match(promo, /settingsPromoClass\.logo/u)
  assert.match(promo, /settingsPromoClass\.version/u)
  assert.match(promo, /settingsPromoClass\.action/u)
  // 手指图标只做强调，必须留在 aria-hidden 里，避免读屏软件念出 emoji。
  assert.match(promo, /settingsPromoClass\.hand, 'aria-hidden': true/u)
})

test('设置页移除重复标题，只保留作用域说明', async () => {
  const section = await readProjectFile('src/client/settings-section.ts')
  // DSH 设置页左侧导航已经给出「Codingns4DSH」，页面内再渲染一级标题会形成两级标题。
  assert.doesNotMatch(section, /createElement\('h2'/u, '设置页不应再渲染 h2 标题')
  assert.doesNotMatch(section, /dshSettingsTitleStyle/u, '标题样式不应再被设置页引用')
  assert.match(section, /createElement\('p', \{ style: dshSettingsSubtitleStyle \}, t\('settings\.subtitle'\)\)/u)
})

test('推广条样式只引用 DSH 真实存在的主题令牌', async () => {
  // 本项目历史上出现过「幽灵令牌」：写进代码但 DSH 运行时从未定义，实际只落到回退值。
  const [styles, themeSource] = await Promise.all([
    readProjectFile('src/client/settings-promo-styles.ts'),
    readProjectFile('node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),
  ])
  const used = new Set([...styles.matchAll(/--dsw-[a-z0-9-]+/gu)].map((match) => match[0]))
  assert.ok(used.size >= 8, `推广条令牌覆盖不足：${used.size}`)
  for (const token of used) {
    assert.ok(themeSource.includes(`${token}:`), `推广条引用了 DSH 未定义的令牌 ${token}`)
  }
  // 硬编码色值会让暗色主题出现刺眼色块，推广条一律走令牌。
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b/u, '推广条样式不得硬编码色值')
})

test('推广条样式覆盖交互态、窄屏与动效偏好', async () => {
  const styles = await readProjectFile('src/client/settings-promo-styles.ts')
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.action\\}:hover`, 'u'))
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.action\\}:active`, 'u'))
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.action\\}:focus-visible`, 'u'))
  assert.match(styles, /--dsw-focus-ring-width/u)
  assert.match(styles, /@media \(max-width:640px\)/u, '窄屏必须改为纵向排列，避免文案被压成竖排')
  assert.match(styles, /prefers-reduced-motion/u)
  assert.match(styles, /data-plugin-css/u, '样式必须按 data-plugin-css 去重注入')
  // 附图口径：引导文案右对齐，紧邻右侧按钮。
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.text\\}\\{[^}]*text-align:right`, 'u'))
  // 尺寸对齐 DSH 设置页的紧凑阶梯：正文 12px、按钮最小高度 28px。
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.text\\}\\{[^}]*font-size:12px`, 'u'))
  assert.match(styles, new RegExp(`\\.\\$\\{settingsPromoClass\\.action\\}\\{[^}]*min-height:28px`, 'u'))
})

test('推广条类名全部登记且互不重复', () => {
  const names = Object.values(settingsPromoClass)
  assert.equal(new Set(names).size, names.length, '推广条类名出现重复')
  for (const name of names) assert.match(name, /^codingns4dsh-settings-promo/u)
})

test('中英文词典为推广条提供对称词条', async () => {
  const locale = await readProjectFile('src/client/locale.ts')
  const en = locale.slice(locale.indexOf('const CORE_EN'), locale.indexOf('const CORE_ZH'))
  const zh = locale.slice(locale.indexOf('const CORE_ZH'))
  for (const key of ['settings.promo.sectionLabel', 'settings.promo.version', 'settings.promo.starHint', 'settings.promo.github', 'settings.promo.actionLabel']) {
    assert.ok(en.includes(`'${key}':`), `英文词典缺少 ${key}`)
    assert.ok(zh.includes(`'${key}':`), `中文词典缺少 ${key}`)
  }
  // 中文文案按附图口径给出，保留「Star」与 GitHub 两个不译词。
  assert.match(zh, /'settings\.promo\.starHint': '如果 Codingns4DSH 帮到了你，请在 GitHub 点个 Star/u)
  assert.match(zh, /'settings\.promo\.version': '版本 v\{version\}'/u)
})

test('Client 构建产物包含推广条样式与文案', async () => {
  const bundle = await readProjectFile('data/build/dist/client/bundle.js')
  assert.match(bundle, /codingns4dsh-settings-promo/u)
  assert.match(bundle, /settings\.promo\.starHint/u)
  assert.match(bundle, /github\.com\/jingyi0605\/Codingns4DSH/u)
  assert.match(bundle, /Codingns4DSH 推广|Codingns4DSH promotion/u)
})

#!/usr/bin/env node
/**
 * Client 前端文案国际化守卫。
 *
 * 目的：阻止「浏览器可见文案绕过 codingns 词典」的回归。检查项：
 *   1. UI 位置出现中没有走 t() 的中文字面量（阻断）；
 *   2. 把中文当词典键传给 t()/tr()（阻断）；
 *   3. t('key') 的键在 en/zh 词典中缺失（阻断）；
 *   4. 词典片段之间出现重复键（阻断）；
 *   5. 片段内 en/zh 键集合不一致（阻断）；
 *   6. feature descriptor 的 ui 缺少 labelKey/descriptionKey（阻断）；
 *   7. 异常与日志里的中文（警告，可用 --strict-internal 升级为阻断）。
 *
 * 用法：
 *   node scripts/check-client-i18n.mjs                 # 全量检查，有违规即退出码 1
 *   node scripts/check-client-i18n.mjs --warn-only     # 只告警，始终退出 0
 *   node scripts/check-client-i18n.mjs --files a.ts b.ts  # 只检查指定文件的字面量（词典仍全量校验）
 *   node scripts/check-client-i18n.mjs --json          # 输出机器可读结果
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_DIR = join(ROOT, 'src/client')
const LOCALE_DIR = join(CLIENT_DIR, 'locales')
const LOCALE_FILE = join(CLIENT_DIR, 'locale.ts')
const ALLOWLIST_FILE = join(ROOT, 'scripts/client-i18n-allowlist.json')

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const TRANSLATOR_CALLEE = /^(t|tr|translate|te|\w+\.t)$/
const LOG_CALLEE = /^(console\.\w+|debug\w*|dev\w*|logger\.\w+)$/
/** 错误载荷字段：这些字段承载异常文本，按警告处理而不是渲染文案。 */
const INTERNAL_ERROR_FIELDS = new Set(['error', 'detail', 'errorDetail', 'reason'])
const KEY_ARG_COUNT = 1

const args = process.argv.slice(2)
const warnOnly = args.includes('--warn-only')
const strictInternal = args.includes('--strict-internal')
const asJson = args.includes('--json')
const fileFilterIndex = args.indexOf('--files')
const fileFilter = fileFilterIndex === -1
  ? null
  : new Set(args.slice(fileFilterIndex + 1).map((item) => relative(ROOT, resolve(ROOT, item))))

/** 递归收集 .ts 文件。 */
function collectTs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

/** 从对象字面量收集键名。 */
function objectKeys(node) {
  const keys = []
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = property.name
      if (ts.isStringLiteral(name) || ts.isIdentifier(name)) keys.push(name.text)
      else if (ts.isNumericLiteral(name)) keys.push(name.text)
    } else if (ts.isShorthandPropertyAssignment(property)) {
      keys.push(property.name.text)
    }
  }
  return keys
}

/** 收集某个文件里指定变量名的对象字面量键。 */
function collectNamedObjectKeys(file, names) {
  const source = parse(file)
  const found = []
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)
      && node.initializer !== undefined && ts.isObjectLiteralExpression(node.initializer)) {
      found.push({ file: relative(ROOT, file), name: node.name.text, keys: objectKeys(node.initializer) })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

// ---------------------------------------------------------------------------
// 词典收集
// ---------------------------------------------------------------------------
const dictionaryEntries = []
dictionaryEntries.push(...collectNamedObjectKeys(LOCALE_FILE, new Set(['CORE_EN', 'CORE_ZH'])))
for (const file of existsSync(LOCALE_DIR) ? collectTs(LOCALE_DIR) : []) {
  dictionaryEntries.push(...collectNamedObjectKeys(file, new Set(['en', 'zh'])))
}

const dictionary = { en: new Set(), zh: new Set() }
const keyOwners = { en: new Map(), zh: new Map() }
const duplicateKeys = []
for (const entry of dictionaryEntries) {
  const locale = entry.name === 'CORE_EN' || entry.name === 'en' ? 'en' : 'zh'
  for (const key of entry.keys) {
    dictionary[locale].add(key)
    const owner = `${entry.file}#${entry.name}`
    const owners = keyOwners[locale].get(key) ?? []
    if (!owners.includes(owner)) owners.push(owner)
    keyOwners[locale].set(key, owners)
  }
}
for (const locale of ['en', 'zh']) {
  for (const [key, owners] of keyOwners[locale]) {
    if (owners.length > 1) duplicateKeys.push({ key: `${locale}:${key}`, owners })
  }
}

const parity = {
  missingInZh: [...dictionary.en].filter((key) => !dictionary.zh.has(key)).sort(),
  missingInEn: [...dictionary.zh].filter((key) => !dictionary.en.has(key)).sort(),
}

// ---------------------------------------------------------------------------
// 字面量分类
// ---------------------------------------------------------------------------
function isChineseLiteral(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return CJK.test(node.text)
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) return CJK.test(node.text)
  return false
}

/** 向上查找最近的相关调用 / 构造 / 抛出上下文。 */
function literalContext(node) {
  let cur = node
  let insideTranslation = false
  let internalReason = null
  while (cur.parent !== undefined) {
    const parent = cur.parent
    if (ts.isCallExpression(parent)) {
      const callee = parent.expression.getText()
      if (TRANSLATOR_CALLEE.test(callee)) insideTranslation = true
      else if (LOG_CALLEE.test(callee)) internalReason = 'log'
      // Error 子类构造函数里的 super('...') 是异常文案，不是渲染文案。
      else if (callee === 'super') internalReason = internalReason ?? 'error'
    }
    if (ts.isNewExpression(parent)) internalReason = internalReason ?? 'error'
    if (ts.isThrowStatement(parent)) internalReason = internalReason ?? 'error'
    if (ts.isPropertyAssignment(parent)) {
      // 错误载荷字段（error/detail/...）属于异常通道，按警告处理；渲染用的
      // label/title/message 等字段仍然是阻断项。
      const name = parent.name.getText().replace(/^['"]|['"]$/g, '')
      if (INTERNAL_ERROR_FIELDS.has(name)) internalReason = internalReason ?? 'error'
      break
    }
    cur = parent
  }
  return { insideTranslation, internalReason }
}

function translationKeyOf(node) {
  const parent = node.parent
  if (parent !== undefined && ts.isCallExpression(parent) && TRANSLATOR_CALLEE.test(parent.expression.getText())) {
    if (parent.arguments[0] === node) return typeof node.text === 'string' ? node.text : null
  }
  return null
}

const allowlist = existsSync(ALLOWLIST_FILE)
  ? JSON.parse(readFileSync(ALLOWLIST_FILE, 'utf8'))
  : []
const allowlistMatched = new Set()
function allowlisted(file, node) {
  const text = node.text
  const hit = allowlist.find((entry) => {
    if (entry.file !== file) return false
    if (entry.kind === 'template-literal') {
      return ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
    }
    return entry.text !== undefined && (entry.text === text || text.includes(entry.text))
  })
  if (hit !== undefined) allowlistMatched.add(`${hit.file}\u0000${hit.kind ?? hit.text}`)
  return hit !== undefined
}

const violations = []
const warnings = []
const usedKeys = []

const clientFiles = collectTs(CLIENT_DIR).filter((file) => file !== LOCALE_FILE && !file.startsWith(LOCALE_DIR + '/'))
for (const file of clientFiles) {
  const relativeFile = relative(ROOT, file)
  const source = parse(file)
  const visit = (node) => {
    if (isChineseLiteral(node)) {
      const text = node.getText().replace(/\s+/g, ' ')
      const { insideTranslation, internalReason } = literalContext(node)
      if (!allowlisted(relativeFile, node)) {
        if (insideTranslation) {
          if (fileFilter === null || fileFilter.has(relativeFile)) {
            violations.push({ file: relativeFile, line: lineOf(source, node), rule: 'chinese-as-key', text })
          }
        } else if (internalReason !== null) {
          warnings.push({ file: relativeFile, line: lineOf(source, node), rule: `internal-${internalReason}`, text })
        } else if (fileFilter === null || fileFilter.has(relativeFile)) {
          violations.push({ file: relativeFile, line: lineOf(source, node), rule: 'untranslated-ui-text', text })
        }
      }
    }
    if (ts.isCallExpression(node) && TRANSLATOR_CALLEE.test(node.expression.getText())) {
      const first = node.arguments[0]
      const key = first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
        ? first.text
        : null
      if (key !== null && !CJK.test(key)) {
        usedKeys.push({ file: relativeFile, line: lineOf(source, node), key })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

const missingUsedKeys = [...new Set(usedKeys.map((item) => item.key))]
  .filter((key) => !dictionary.en.has(key) || !dictionary.zh.has(key))
  .sort()

// ---------------------------------------------------------------------------
// feature descriptor 的 labelKey / descriptionKey
// ---------------------------------------------------------------------------
const descriptorFiles = [
  ...collectTs(join(CLIENT_DIR, 'features')),
  join(CLIENT_DIR, 'git-management.ts'),
]
const descriptorIssues = []
for (const file of descriptorFiles) {
  const source = parse(file)
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'ui'
      && ts.isObjectLiteralExpression(node.initializer)) {
      const names = new Set(node.initializer.properties
        .filter((property) => ts.isPropertyAssignment(property))
        .map((property) => property.name.getText()))
      if (names.has('label') || names.has('description')) {
        const relativeFile = relative(ROOT, file)
        for (const required of ['labelKey', 'descriptionKey']) {
          if (!names.has(required)) {
            descriptorIssues.push({ file: relativeFile, line: lineOf(source, node), rule: 'descriptor-missing-key', text: required })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
const unusedAllowlist = allowlist
  .map((entry) => `${entry.file}\u0000${entry.kind ?? entry.text}`)
  .filter((id) => !allowlistMatched.has(id))

const blocking = [
  ...violations,
  ...missingUsedKeys.map((key) => ({ rule: 'missing-dictionary-key', text: key })),
  ...duplicateKeys.map((entry) => ({ rule: 'duplicate-dictionary-key', text: `${entry.key} (${entry.owners.join(', ')})` })),
  ...parity.missingInZh.map((key) => ({ rule: 'missing-zh-key', text: key })),
  ...parity.missingInEn.map((key) => ({ rule: 'missing-en-key', text: key })),
  ...descriptorIssues,
]

if (asJson) {
  console.log(JSON.stringify({
    summary: {
      dictionaryEn: dictionary.en.size,
      dictionaryZh: dictionary.zh.size,
      usedKeys: new Set(usedKeys.map((item) => item.key)).size,
      violations: violations.length,
      warnings: warnings.length,
      blocking: blocking.length,
    },
    violations,
    warnings,
    blocking,
    unusedAllowlist,
  }, null, 2))
} else {
  console.log(`编码词典：en ${dictionary.en.size} 键，zh ${dictionary.zh.size} 键；代码中使用的键 ${new Set(usedKeys.map((item) => item.key)).size} 个`)
  console.log(`违规（阻断）：${blocking.length}；告警（异常/日志中文）：${warnings.length}`)

  const print = (title, rows, render) => {
    if (rows.length === 0) return
    console.log(`\n== ${title} (${rows.length}) ==`)
    for (const row of rows.slice(0, 200)) console.log(render(row))
    if (rows.length > 200) console.log(`… 其余 ${rows.length - 200} 条见 --json 输出`)
  }

  print('UI 文案未走词典', violations.filter((item) => item.rule === 'untranslated-ui-text'),
    (item) => `${item.file}:${item.line} ${item.text}`)
  print('中文被当作词典键', violations.filter((item) => item.rule === 'chinese-as-key'),
    (item) => `${item.file}:${item.line} ${item.text}`)
  print('t() 使用了词典中不存在的键', missingUsedKeys.map((key) => ({ key })), (item) => item.key)
  print('词典重复键', duplicateKeys, (item) => `${item.key} ← ${item.owners.join(', ')}`)
  print('en 有而 zh 缺', parity.missingInZh.map((key) => ({ key })), (item) => item.key)
  print('zh 有而 en 缺', parity.missingInEn.map((key) => ({ key })), (item) => item.key)
  print('descriptor 缺少 labelKey/descriptionKey', descriptorIssues, (item) => `${item.file}:${item.line} ${item.text}`)
  print('异常/日志中的中文（警告）', warnings, (item) => `${item.file}:${item.line} [${item.rule}] ${item.text}`)
  print('allowlist 中已失效的条目', unusedAllowlist.map((id) => ({ id })), (item) => item.id.split('\u0000').join(' → '))
}

const failed = blocking.length > 0 || (strictInternal && warnings.length > 0)
if (failed && !warnOnly) {
  // 用 exitCode 而不是 process.exit：管道输出（--json）必须完整 flush 后再退出。
  process.exitCode = 1
  if (!asJson) {
    console.error('\n国际化守卫未通过：请把用户可见文案改为 t(\'<域>.<键>\') 并补齐 en/zh 词条。')
    console.error('规范见 docs/开发规范/20260930-前端文案国际化规范.md。')
  }
}
if (warnOnly && !asJson) console.log('\n--warn-only：仅告警，未阻断。')

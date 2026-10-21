/**
 * Command Code ACP 兼容桥。
 *
 * Command Code 1.74.3 的 ACP 服务把 ask_user_question 映射成
 * session/request_permission，并且只从 outcome.optionId 还原固定选项文本。
 *
 * 同一份 bundle 还只把内置模型目录当作可选模型白名单：ACP 的 availableModels()
 * 与 Agent 的 selectableModels() 都来自 catalogModels()，因此 providers.json 里
 * 声明的 BYOK 模型（例如 mcgrox/deepseek-v4.1-flash）会在 session/set_model 时被
 * 拒绝成 `Unknown model: ...`，而 CLI 自己的默认模型走另一条路径不受影响。这里
 * 把 BYOK 模型补进内存中的目录，使 ACP 会话能切换并真正路由到对应提供者。
 *
 * 这个 loader 只改写内存中的 cli.mjs，不修改用户安装的 npm 包或 Desktop
 * The model catalog and Magpie session patches depend only on stable function
 * entries,
 * not on minified catalog variable names or the complete function text. If the
 * upstream entry point disappears, the original module is left unchanged.
 */

import { fileURLToPath } from 'node:url'

interface LoaderContext {
  readonly format?: string
  readonly importAttributes?: Record<string, string>
}

interface LoadedModule {
  readonly format?: string
  readonly source?: string | Uint8Array
  readonly shortCircuit?: boolean
  readonly [key: string]: unknown
}

type NextLoad = (url: string, context: LoaderContext) => Promise<LoadedModule>

const COMMAND_CODE_CLI_SUFFIX = '/dist/cli.mjs'

/** Node ESM loader 入口；只拦截 Command Code 自己的 CLI bundle。 */
export async function load(url: string, context: LoaderContext, nextLoad: NextLoad): Promise<LoadedModule> {
  const loaded = await nextLoad(url, context)
  if (!url.endsWith(COMMAND_CODE_CLI_SUFFIX) || loaded.format !== 'module' || loaded.source === undefined) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source)
  const patched = patchCommandCodeAcpMod(patchCommandCodeAcpMagpieSession(patchCommandCodeAcpByokModels(patchCommandCodeAcpQuestion(source))))
  return patched === source ? loaded : { ...loaded, source: patched, shortCircuit: true }
}

/** ACP skips the ordinary CLI action that applies --mod before host creation. */
function patchCommandCodeAcpMod(source: string): string {
  const entry = 'async function runAcp(){'
  const mod = fileURLToPath(new URL('../cli-bridge/command-code-mod.js', import.meta.url))
  const initialize = `if(process.env.CODINGNS_DISABLE_NATIVE_AGENT==="1")setModPathsOverride([${JSON.stringify(mod)}]);`
  if (!source.includes('function setModPathsOverride(') || !source.includes(entry) || source.includes(initialize)) return source
  return source.replace(entry, entry + initialize)
}

/**
 * 把 Host 扩展回包里的 codingns/questionAnswer 读回 Command Code 的问题工具。
 * answers 同时接受数组和对象形状，兼容已经采用 Qwen 风格扩展的上游版本。
 */
function patchCommandCodeAcpQuestion(source: string): string {
  const questionDeclaration = 'async function requestQuestion(e,t){'
  const askClientReturn = 'return o&&"cancelled"!==o.outcome?{optionId:o.optionId}:"cancelled"'
  const questionReturn = 'if("cancelled"===r)return null;const s=Number(/^option_(\\d+)$/.exec(r.optionId)?.[1]);return t.options[s]?.label??null'
  if (!source.includes(questionDeclaration) || !source.includes(askClientReturn) || !source.includes(questionReturn)) return source

  const helper = 'function codingNsQuestionAnswer(e){const t=e?._meta?.["codingns/questionAnswer"];if(typeof t==="string"&&t.trim()!=="")return t.trim();const n=e?.answers;if(Array.isArray(n)){for(const e of n){const t=Array.isArray(e?.selectedOptions)?e.selectedOptions[0]:Array.isArray(e?.selected)?e.selected[0]:void 0;if(typeof t==="string"&&t.trim()!=="")return t.trim()}}else if(n&&typeof n==="object"){for(const e of Object.values(n)){if(typeof e==="string"&&e.trim()!=="")return e.trim()}}return null}'
  const responseWithAnswers = 'return o&&"cancelled"!==o.outcome?{optionId:o.optionId,answers:t.result?.answers,_meta:t.result?._meta}:"cancelled"'
  const questionWithCustom = 'if("cancelled"===r)return null;const c=codingNsQuestionAnswer(r);if(c!==null)return c;const s=Number(/^option_(\\d+)$/.exec(r.optionId)?.[1]);return t.options[s]?.label??null'
  let patched = source.replace(askClientReturn, responseWithAnswers)
  patched = patched.replace(questionReturn, questionWithCustom)
  // 必须替换完整的 async 声明；只匹配 function 会把 async 错移到辅助函数上，
  // 使原 requestQuestion 中的 await 失去合法上下文，导致整个 CLI 无法加载。
  patched = patched.replace(questionDeclaration, `${helper}${questionDeclaration}`)
  return patched
}

/**
 * Magpie associates usage and route records through `X-Magpie-Session`.
 * Command Code already passes its ACP session as `threadId` to the model
 * transport, but its built-in session-header helper only handles OpenCode.
 * Add the Magpie header for loopback OpenAI-compatible `/v1` gateways.
 */
function patchCommandCodeAcpMagpieSession(source: string): string {
  const original = 'function sessionRoutingHeaders(e){return e.threadId&&isSessionRoutedHost(e.baseURL)?Object.keys(e.headers??{}).some(e=>e.toLowerCase()===NT)?{}:{[NT]:e.threadId}:{}}'
  if (!source.includes(original) || source.includes('codingNsMagpieBaseUrl')) return source
  const helper = 'function codingNsMagpieBaseUrl(e){try{const t=new URL(e);return(t.hostname==="127.0.0.1"||t.hostname==="localhost"||t.hostname==="::1"||t.hostname==="[::1]")&&(/^\\/v1(?:\\/|$)/u.test(t.pathname))}catch{return false}}'
  const replacement = `${helper}function sessionRoutingHeaders(e){const t=Object.keys(e.headers??{});if(e.threadId&&isSessionRoutedHost(e.baseURL))return t.some(e=>e.toLowerCase()===NT)?{}:{[NT]:e.threadId};return e.threadId&&codingNsMagpieBaseUrl(e.baseURL)&&!t.some(e=>e.toLowerCase()==="x-magpie-session")?{"x-magpie-session":e.threadId}:{}}`
  return source.replace(original, replacement)
}

/**
 * Stable declaration shape for the upstream `catalogModels()` function.
 *
 * Command Code's minified catalog variable changed between 1.74, 1.82, and 1.84
 * (for example RL, NL, and QD), while ACP still builds its built-in catalog here.
 * Matching only the function entry and finding its body with balanced braces
 * avoids updating the plugin for every bundle re-minification.
 */
const CATALOG_MODELS_DECLARATION = /function\s+catalogModels\s*\([^)]*\)\s*\{/u

/**
 * Injected helper that supplements the bundle's BYOK model catalog.
 *
 * `process.getBuiltinModule` loads fs/os without depending on minified cli.mjs
 * import aliases. The providers file is read on each call, so changing BYOK
 * configuration does not require restarting the ACP process. Missing or invalid
 * configuration returns an empty list and preserves the upstream catalog.
 */
const BYOK_MODELS_HELPER =
  'function codingNsByokModels(){' +
  'const normalize=e=>e&&typeof e.id==="string"&&e.id.trim()!==""?' +
  '{id:e.id,name:typeof e.name==="string"&&e.name.trim()!==""?e.name:e.id,' +
  'description:typeof e.description==="string"&&e.description.trim()!==""?e.description:"byok"}:null;' +
  'try{if(typeof customModelListOptions==="function"){const e=customModelListOptions();' +
  'if(Array.isArray(e)){const n=e.map(e=>normalize({...e,name:e.id})).filter(Boolean);if(n.length>0)return n}}}catch{}' +
  'try{if(typeof getCustomProviderModelsSync==="function"){const e=getCustomProviderModelsSync();' +
  'if(Array.isArray(e)){const n=[];for(const t of e){if(!t||typeof t.id!=="string"||!Array.isArray(t.models))continue;' +
  'for(const e of t.models){if(!e||typeof e.id!=="string"||e.id.trim()==="")continue;' +
  'n.push(normalize({id:t.id+"/"+e.id,name:typeof e.name==="string"?e.name:e.id,' +
  'description:typeof t.name==="string"&&t.name.trim()!==""?t.name:"byok"}))}' +
  '}if(n.length>0)return n}}}catch{}' +
  'try{const fs=process.getBuiltinModule("node:fs"),os=process.getBuiltinModule("node:os"),' +
  'home=typeof process.env.HOME==="string"&&process.env.HOME.trim()!==""?process.env.HOME:os.homedir(),' +
  'p=home+"/.commandcode/providers.json";if(!fs.existsSync(p))return[];' +
  'const c=JSON.parse(fs.readFileSync(p,"utf8")),m=c&&typeof c.provider==="object"&&c.provider!==null?' +
  'c.provider:c&&typeof c.providers==="object"&&c.providers!==null?c.providers:null;if(!m)return[];' +
  'const n=[];for(const t of Object.keys(m)){const e=m[t];' +
  'if(!/^[a-z0-9][a-z0-9_.-]{0,63}$/u.test(t)||!e||typeof e!=="object"||e.disabled===true||e.enabled===false||' +
  'typeof e.models!=="object"||e.models===null)continue;' +
  'for(const r of Object.keys(e.models)){if(r.trim()!=="")n.push(normalize({id:t+"/"+r,name:t+"/"+r,' +
  'description:typeof e.name==="string"&&e.name.trim()!==""?e.name:"byok"}))}}return n}catch{return[]}}'

/** Patched `catalogModels()`: keep built-in entries first, then append unique BYOK models. */
const BYOK_MODELS_WRAPPER =
  'function catalogModels(...args){const a=codingNsBuiltinCatalogModels(...args);' +
  'for(const e of codingNsByokModels())if(e&&typeof e.id==="string"&&!a.some(n=>n&&n.id===e.id))a.push(e);return a}'

/**
 * 把 providers.json 声明的 BYOK 模型并入模型目录。
 *
 * `catalogModels()` 同时喂给 ACP 的 availableModels() 与 Agent 的 selectableModels()，
 * 是唯一的校验收口；只补这一处即可让 session/set_model 与后续请求路由同时生效。
 * 重复 id（BYOK 提供者与内置目录同名）保留内置条目，避免同一模型出现两次。
 */
function patchCommandCodeAcpByokModels(source: string): string {
  const match = CATALOG_MODELS_DECLARATION.exec(source)
  if (match === null || match.index === undefined) return source
  const openingBrace = match.index + match[0].lastIndexOf('{')
  const end = findJavaScriptBlockEnd(source, openingBrace)
  if (end === null) return source
  const original = source.slice(match.index, end)
  const renamed = original.replace(/^function\s+catalogModels/u, 'function codingNsBuiltinCatalogModels')
  if (renamed === original) return source
  return `${source.slice(0, match.index)}${BYOK_MODELS_HELPER}${renamed}${BYOK_MODELS_WRAPPER}${source.slice(end)}`
}

/** Find the end of a function body without interpreting braces inside literals/comments. */
function findJavaScriptBlockEnd(source: string, openingBrace: number): number | null {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = openingBrace; index < source.length; index += 1) {
    const current = source[index]!
    const next = source[index + 1]
    if (lineComment) {
      if (current === '\n' || current === '\r') lineComment = false
      continue
    }
    if (blockComment) {
      if (current === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (current === '\\') {
        escaped = true
      } else if (current === quote) {
        quote = null
      }
      continue
    }
    if (current === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (current === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (current === '"' || current === "'" || current === '`') {
      quote = current
      continue
    }
    if (current === '{') depth += 1
    else if (current === '}') {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
}

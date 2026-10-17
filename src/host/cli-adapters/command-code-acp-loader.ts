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
 * 目录；当上游实现已经变化时保持原模块不变。
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
  const patched = patchCommandCodeAcpMod(patchCommandCodeAcpByokModels(patchCommandCodeAcpQuestion(source)))
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

/** 上游 `catalogModels()` 的原始声明；命中不到说明实现已变化，保持模块不变。 */
const CATALOG_MODELS_DECLARATION =
  'function catalogModels(){return Object.values(RL).filter(e=>!e.hidden).map(e=>({id:e.id,name:e.name,description:e.description||null}))}'

/**
 * 注入到 bundle 的 BYOK 目录补充函数。
 *
 * 用 `process.getBuiltinModule` 取 fs/os，避免依赖 cli.mjs 压缩后的导入别名。
 * 每次调用重读 providers.json，用户改完 BYOK 配置无需重启 ACP 进程；文件不存在
 * 或解析失败时返回空数组，目录行为与上游完全一致。
 */
const BYOK_MODELS_HELPER =
  'function codingNsByokModels(){try{' +
  'const fs=process.getBuiltinModule("node:fs"),os=process.getBuiltinModule("node:os");' +
  'const p=os.homedir()+"/.commandcode/providers.json";' +
  'if(!fs.existsSync(p))return[];' +
  'const c=JSON.parse(fs.readFileSync(p,"utf8"));' +
  'const m=c&&"object"==typeof c.provider?c.provider:c&&"object"==typeof c.providers?c.providers:null;' +
  'if(!m)return[];' +
  'const out=[];' +
  'for(const id of Object.keys(m)){const v=m[id];if(!v||"object"!=typeof v.models)continue;' +
  'for(const name of Object.keys(v.models))out.push({id:id+"/"+name,name:id+"/"+name,description:"string"==typeof v.name?v.name:"byok"})}' +
  'return out}catch{return[]}}'

/** 打补丁后的 `catalogModels()`：内置目录在前，BYOK 模型去重后追加。 */
const BYOK_MODELS_DECLARATION =
  BYOK_MODELS_HELPER +
  'function catalogModels(){const a=Object.values(RL).filter(e=>!e.hidden).map(e=>({id:e.id,name:e.name,description:e.description||null}));' +
  'for(const e of codingNsByokModels())if(!a.some(n=>n.id===e.id))a.push(e);return a}'

/**
 * 把 providers.json 声明的 BYOK 模型并入模型目录。
 *
 * `catalogModels()` 同时喂给 ACP 的 availableModels() 与 Agent 的 selectableModels()，
 * 是唯一的校验收口；只补这一处即可让 session/set_model 与后续请求路由同时生效。
 * 重复 id（BYOK 提供者与内置目录同名）保留内置条目，避免同一模型出现两次。
 */
function patchCommandCodeAcpByokModels(source: string): string {
  if (!source.includes(CATALOG_MODELS_DECLARATION)) return source
  return source.replace(CATALOG_MODELS_DECLARATION, BYOK_MODELS_DECLARATION)
}

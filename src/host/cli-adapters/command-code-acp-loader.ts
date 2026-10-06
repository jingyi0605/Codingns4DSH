/**
 * Command Code ACP 自由文本兼容桥。
 *
 * Command Code 1.74.3 的 ACP 服务把 ask_user_question 映射成
 * session/request_permission，并且只从 outcome.optionId 还原固定选项文本。
 * 这个 loader 只改写内存中的 cli.mjs，不修改用户安装的 npm 包或 Desktop
 * 目录；当上游实现已经变化时保持原模块不变。
 */

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
  const patched = patchCommandCodeAcpQuestion(source)
  return patched === source ? loaded : { ...loaded, source: patched, shortCircuit: true }
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

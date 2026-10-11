import type { CodingNsNativeSessionBridge } from '../native-session-bridge.js'
import { getNativeSubagents } from './native-subagent-holder.js'
import { enqueueTeamSubagentSelection, EXTERNAL_SUBAGENT_IDS, hasNativeSubagentStart } from './native-team-subagent.js'
import { dispatchNativeSubagent, isNativeSubagentSession, nativeSubagentEventCursor, NATIVE_SUBAGENT_TIMEOUT_MS, nativeSubagentFailureNeedsReview, nativeSubagentFailureReviewFields, nativeSubagentParentSessionId, readNativeSubagentLifecycle, reviewNativeSubagentFailure, sendNativeSubagentMessage, sendNativeSubagentParentMessage, trackNativeSubagentFollowup, waitNativeSubagentLifecycle, type NativeParentAgent } from './native-subagent-dispatch.js'
import { getDelegationModel, isDelegationTargetAllowed } from './delegation-authorization.js'

export function createAgentSubagentTool(options: { readonly nativeSessions?: CodingNsNativeSessionBridge | undefined } = {}): Record<string, unknown> {
  return {
    name: 'agent_subagent',
    description: '异步并行执行外部 Agent 子任务。action=start 默认立即返回 child session；action=wait 等待指定 child session 终态；action=read 读取当前状态和结果；父代理用 action=send 向子代理补充指令，子代理可用自己的 parent session id（或省略 child_session_id）把报告回传父代理，子代理不能再次 start 创建嵌套代理。failed 子代理必须先 read/wait 查看并评估是否重新创建或接管；需要同步等待时显式传 run_in_background=false；依赖步骤必须先 wait/read 前置会话。',
    parameters: {
      type: 'object',
      properties: {
      agent: { type: 'string', enum: [...EXTERNAL_SUBAGENT_IDS] },
      prompt: { type: 'string', description: '完整、自包含的子任务说明。' },
      model: { type: 'string' },
      cwd: { type: 'string', description: '子代理的起始目录；相对路径相对父会话当前目录解析，缺省继承父会话目录。仅在 DSH 0.2.1-alpha.2 及以上生效。' },
      run_in_background: { type: 'boolean' },
      action: { type: 'string', enum: ['start', 'read', 'wait', 'send'] },
      child_session_id: { type: 'string', description: '父代理发送时填子会话 ID；子代理回传时可填父会话 ID，也可省略。' },
      message: { type: 'string', description: '发送给已创建子代理的后续消息。' },
      timeout_ms: { type: 'number' },
      depends_on: { type: 'array', items: { type: 'string' } },
    },
      required: [],
      additionalProperties: false,
    },
    // dsh-tools 的 `tools.register` 强制要求 `output.render` 是函数；把 render 放在
    // 顶层会被注册校验拒绝，并被 Host 的 catch 吞成一条 debugWarn，模型侧表现为
    // “工具不存在”。契约以 output 对象为准。
    output: {
      schema: { type: 'object' },
      render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }],
    },
    timeoutMs: NATIVE_SUBAGENT_TIMEOUT_MS,
    // 后台 start、read、wait 都只操作按 childSessionId 隔离的状态；创建阶段
    // 由 enqueueTeamSubagentSelection 保证同一 Provider 的单飞约束，工具本身可以并行执行。
    isConcurrencySafe: () => true,
    async execute(args: Record<string, unknown>, exec: { signal?: AbortSignal; agent?: NativeParentAgent }) {
      const adapterId = typeof args.agent === 'string' ? args.agent.trim() : ''
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      const native = getNativeSubagents()
      const parentAgent = exec.agent
      const parentId = parentAgent?.session?.header?.id ?? parentAgent?.id
      const action = args.action === 'wait' || args.action === 'read' || args.action === 'send' ? args.action : 'start'
      const childSessionId = typeof args.child_session_id === 'string' ? args.child_session_id.trim() : ''
      // 目标目录只做去空白；相对路径由 DSH 相对父级当前目录解析，本地不拼接。
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : undefined
      if (parentId === undefined) throw new Error('DSH 原生 Subagent 缺少父会话身份')
      const ownParentTarget = isNativeSubagentSession(options.nativeSessions, parentId)
        ? nativeSubagentParentSessionId(options.nativeSessions, parentId)
        : undefined
      if (action === 'start' && ownParentTarget !== undefined) {
        return { ok: false, status: 'failed', error: '当前会话禁止嵌套子代理：子会话只能通过 send 回传父会话报告' }
      }
      if (action === 'read') {
        const lifecycle = readNativeSubagentLifecycle(childSessionId)
        if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) {
          return { ok: false, status: 'failed', error: `DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}` }
        }
        const reviewed = reviewNativeSubagentFailure(childSessionId) ?? lifecycle
        return { ok: true, ...reviewed, ...nativeSubagentFailureReviewFields(reviewed) }
      }
      if (action === 'wait') {
        const lifecycle = await waitNativeSubagentLifecycle(childSessionId, typeof args.timeout_ms === 'number' ? args.timeout_ms : NATIVE_SUBAGENT_TIMEOUT_MS)
        if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) {
          return { ok: false, status: 'failed', error: `DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}` }
        }
        const reviewed = reviewNativeSubagentFailure(childSessionId) ?? lifecycle
        return { ok: reviewed.status === 'completed', ...reviewed, ...nativeSubagentFailureReviewFields(reviewed) }
      }
      if (action === 'send') {
        const message = typeof args.message === 'string' ? args.message.trim() : prompt
        if (parentAgent === undefined || options.nativeSessions === undefined) throw new Error('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
        // 子代理回传父会话时，调用方身份就是当前 child session；目标只能是
        // 该 child 的生命周期 parentSessionId，不能接受任意会话 ID，避免越权注入。
        const parentTarget = ownParentTarget
        if (parentTarget !== undefined && (childSessionId === '' || childSessionId === parentTarget)) {
          const sent = sendNativeSubagentParentMessage(options.nativeSessions, parentId, message)
          return sent.ok
            ? { ok: true, status: 'running', completed: false, parentSessionId: sent.parentSessionId ?? parentTarget, result: '子代理报告已回传父会话。' }
            : { ok: false, status: 'failed', parentSessionId: parentTarget, error: sent.error ?? '父会话报告回传失败。' }
        }
        if (native === undefined) throw new Error('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
        const lifecycle = readNativeSubagentLifecycle(childSessionId)
        if (lifecycle === undefined || lifecycle.parentSessionId !== parentId) {
          return { ok: false, status: 'failed', error: `DELEGATE_CHILD_NOT_FOUND: 找不到父会话下的子会话：${childSessionId}` }
        }
        const reviewed = reviewNativeSubagentFailure(childSessionId) ?? lifecycle
        const cursor = nativeSubagentEventCursor(options.nativeSessions, childSessionId)
        const sent = await sendNativeSubagentMessage(native, { parentAgent, parentId, childSessionId, message, signal: exec.signal })
        if (sent.ok) {
          trackNativeSubagentFollowup(options.nativeSessions, childSessionId, cursor)
          return { ok: true, status: 'running', completed: false, childSessionId, ...(sent.messageId === undefined ? {} : { messageId: sent.messageId }), result: '后续消息已发送给子代理。' }
        }
        return { ok: false, status: 'failed', childSessionId, error: sent.error ?? '子代理消息发送失败。', ...nativeSubagentFailureReviewFields(reviewed) }
      }
      if (!EXTERNAL_SUBAGENT_IDS.includes(adapterId as typeof EXTERNAL_SUBAGENT_IDS[number]) || prompt === '') throw new Error('agent 与 prompt 均不能为空且必须使用受支持的 Agent')
      if (!isDelegationTargetAllowed(parentId, adapterId)) {
        throw new Error(`DELEGATE_TARGET_NOT_ALLOWED: 当前对话未授权使用 ${adapterId}`)
      }
      // 委派 carrier 中的模型是用户在二级选择器里明确选定的事实。父模型可能
      // 自己猜一个 model 参数，不能覆盖该授权；旧 v1 carrier 没有模型时仍沿用
      // 工具参数/适配器默认值，保持向后兼容。
      const authorizedModelId = getDelegationModel(parentId, adapterId)
      const requestedModelId = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : undefined
      const modelId = authorizedModelId ?? requestedModelId
      const dependsOn = Array.isArray(args.depends_on)
        ? args.depends_on.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map((value) => value.trim())
        : []
      const dependencyStates = dependsOn.map((id) => readNativeSubagentLifecycle(id))
      const blocked = dependencyStates.some((state) => state === undefined || state.parentSessionId !== parentId || state.status !== 'completed')
      if (blocked) {
        const failedDependency = dependencyStates.find((state) => state !== undefined && nativeSubagentFailureNeedsReview(state))
        return {
          ok: false,
          status: 'failed',
          error: failedDependency === undefined
            ? 'DELEGATE_DEPENDENCY_NOT_READY: 前置子会话尚未 completed，请先调用 action=wait 或 action=read。'
            : 'DELEGATE_DEPENDENCY_FAILED_REVIEW_REQUIRED: 前置子代理 failed，必须先 action=read/wait 查看失败状态，再评估重新创建或接管。',
          dependencies: dependencyStates,
        }
      }
      // 原生子代理启动会把 parent 当真实 Agent 使用（读 agent.options.subagentDepth、
      // agent.session.header），因此必须传 exec.agent 本身；传 `{ id }` 占位对象会在
      // resolveChildDepth 抛 TypeError。这里同时要求能解析出父会话 id，供选择键去重。
      if (!hasNativeSubagentStart(native) || parentAgent === undefined || parentId === undefined || options.nativeSessions === undefined) throw new Error('DSH 原生 Subagent 能力不可用，当前 Host 未提供可续子会话')
      const result = await dispatchNativeSubagent(native, options.nativeSessions, {
        adapterId,
        prompt,
        parentAgent,
        parentId,
        ...(modelId === undefined ? {} : { modelId }),
        ...(cwd === undefined ? {} : { cwd }),
        background: args.run_in_background !== false,
        // dsh-tools 可能在同一轮并发执行多个 agent_subagent；不能再用旧的
        // 直接拒绝式单飞守卫，否则并行调用会随机收到“创建正在进行中”。
        select: (action) => enqueueTeamSubagentSelection(parentId, adapterId, modelId, action),
        signal: exec.signal,
      })
      if (result.background) {
        return { agent: result.adapterId, childSessionId: result.childSessionId, providerSessionId: result.childSessionId, ok: true, completed: false, status: result.status, background: true, result: result.text }
      }
      const lifecycle = readNativeSubagentLifecycle(result.childSessionId)
      return {
        agent: result.adapterId,
        childSessionId: result.childSessionId,
        providerSessionId: result.childSessionId,
        ok: result.ok,
        completed: result.completed,
        status: result.status,
        result: result.text,
        toolCalls: result.toolCalls,
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(lifecycle === undefined ? {} : nativeSubagentFailureReviewFields(lifecycle)),
      }
    },
  }
}

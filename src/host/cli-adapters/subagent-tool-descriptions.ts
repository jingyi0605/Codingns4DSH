/** Fixed model-facing copy, shared by the tool producer and prompt localization. */
export const AGENT_SUBAGENT_DESCRIPTIONS = {
  tool: {
    zh: '异步并行执行外部 Agent 子任务。action=start 默认立即返回 child session；action=wait 等待指定 child session 终态；action=read 读取当前状态和结果；父代理用 action=send 向子代理补充指令，子代理可用自己的 parent session id（或省略 child_session_id）把报告回传父代理，子代理不能再次 start 创建嵌套代理。failed 子代理必须先 read/wait 查看并评估是否重新创建或接管；需要同步等待时显式传 run_in_background=false；依赖步骤必须先 wait/read 前置会话。',
    en: 'Run external Agent subtasks asynchronously in parallel. action=start returns a child session immediately by default; action=wait waits for the specified child session to reach a terminal state; action=read reads its current status and results. The parent uses action=send to give a child additional instructions. A child can send a report back using its own parent session id (or omitting child_session_id), but cannot use start to create nested subagents. For a failed child, first use read/wait to inspect the failure and decide whether to recreate it or take over. For synchronous execution, explicitly pass run_in_background=false. Before dependent steps, use wait/read to check prerequisite sessions.',
  },
  prompt: {
    zh: '完整、自包含的子任务说明。',
    en: 'Complete, self-contained instructions for the subtask.',
  },
  cwd: {
    zh: '子代理的起始目录；相对路径相对父会话当前目录解析，缺省继承父会话目录。仅在 DSH 0.2.1-alpha.2 及以上生效。',
    en: 'The starting directory for the child. Relative paths are resolved against the parent session directory; defaults to inheriting that directory. Effective only in DSH 0.2.1-alpha.2 and later.',
  },
  childSessionId: {
    zh: '父代理发送时填子会话 ID；子代理回传时可填父会话 ID，也可省略。',
    en: 'When sent by the parent, use the child session ID. When reporting back from a child, use the parent session ID or omit this field.',
  },
  message: {
    zh: '发送给已创建子代理的后续消息。',
    en: 'A follow-up message for an already created child.',
  },
} as const

/** Only unchanged descriptions owned by this tool qualify for the local translation. */
export function localizeAgentSubagentDescription(toolName: string, text: string): string | undefined {
  if (toolName !== 'agent_subagent') return undefined
  return Object.values(AGENT_SUBAGENT_DESCRIPTIONS).find(description => description.zh === text)?.en
}

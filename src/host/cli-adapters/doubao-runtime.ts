/**
 * 此函数只在豆包自己的隐藏页面执行。闭包必须自包含，以便通过 CDP 序列化；
 * 私有模块只有结构特征，没有跨版本固定编号。凭据和公共参数始终留在 App。
 */
export async function installDoubaoRuntime(key: string): Promise<void> {
  type Native = Record<string, any>
  const scope = globalThis as unknown as Native
  if (location.host !== 'doubao-background') throw new Error('DOUBAO_BACKGROUND_REQUIRED')
  const chunks = scope.webpackChunkapp_flow_desktop_framework
  if (!Array.isArray(chunks)) throw new Error('DOUBAO_RUNTIME_UNSUPPORTED')
  const require = await new Promise<((id: string) => Native) & { m: Record<string, Function> }>((resolve) => {
    chunks.push([[key], {}, resolve])
  })
  const factories = Object.entries(require.m).map(([id, factory]) => ({ id, source: String(factory) }))
  const module = (matches: (source: string) => boolean): Native => {
    const found = factories.filter(({ source }) => matches(source))
    if (found.length !== 1) throw new Error('DOUBAO_RUNTIME_AMBIGUOUS')
    return require(found[0]!.id)
  }
  const configModule = module((s) => s.includes('FlowApiOptions not initialized') && s.includes('getCommonHeaders'))
  const configs = Object.values(configModule).filter((value) => typeof value === 'function' && String(value).includes('.flowApiOptions'))
  if (configs.length !== 1) throw new Error('DOUBAO_CONFIG_UNSUPPORTED')
  const config = (configs[0] as () => Native)()
  if (typeof config.getCommonParams !== 'function' || typeof config.getCommonHeaders !== 'function'
    || config.baseURL !== 'https://www.doubao.com') throw new Error('DOUBAO_CONFIG_UNSUPPORTED')
  const requestModule = module((s) => s.includes('uplinkKey:') && s.includes('downlinkKey:') && s.includes('status_code:'))
  const requestFactories = Object.values(requestModule).filter((value) => typeof value === 'function')
  if (requestFactories.length !== 1) throw new Error('DOUBAO_REQUEST_UNSUPPORTED')
  const requestFactory = requestFactories[0] as (input: Native) => (body: Native) => Promise<Native>
  const commands = Object.values(module((s) => s.includes('IMCMD_NOT_USED:') && s.includes('PULL_SINGLE_CHAIN:')))
    .find((value) => value && typeof value === 'object' && value.CREATE_CONVERSATION && value.BREAK_MSG) as Native | undefined
  if (!commands) throw new Error('DOUBAO_COMMANDS_UNSUPPORTED')
  // 同时验证“消息构造的默认 bot”和独立常量出口，避免猜一个看似合法的账号 ID。
  const botIds = new Set(factories.flatMap(({ source }) => [...source.matchAll(/bot_id:[^,;]+?\|\|"(\d+)"/gu)].map((match) => match[1]!)))
  if (botIds.size !== 1) throw new Error('DOUBAO_BOT_UNSUPPORTED')
  const botId = [...botIds][0]!
  const botConstants = factories.filter(({ source }) => source.length < 200 && source.includes(`"${botId}"`))
  if (botConstants.length !== 1 || !Object.values(require(botConstants[0]!.id)).includes(botId)) throw new Error('DOUBAO_BOT_UNSUPPORTED')
  const enums = Object.values(module((s) => s.includes('MSG_DIRECTION_UNKNOWN:') && s.includes('ONE_TO_BOT_CHAT:')))
  const direction = enums.find((value) => value?.MSG_DIRECTION_UNKNOWN === 0 && value.OLDER === 1)
  if (!direction) throw new Error('DOUBAO_ENUM_UNSUPPORTED')
  const invoke = async (url: string, command: string, uplinkKey: string, downlinkKey: string, body: Native): Promise<Native> => {
    const result = await requestFactory({ url, cmd: commands[command], uplinkKey, downlinkKey })(body)
    if (result.code !== 0) throw new Error(`DOUBAO_API_${Number(result.code) || 'ERROR'}`)
    return result.data ?? {}
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let pending: Uint8Array = new Uint8Array(0)
  let controller: AbortController | undefined
  let downloadLimit: number | undefined
  let downloaded = 0
  let disposed = false
  let lease: ReturnType<typeof setTimeout>
  // Host 意外退出时没有机会执行 finally；闲置桥最多存活 90 秒。
  const touch = (): void => {
    clearTimeout(lease)
    lease = setTimeout(() => { void scope[key]?.dispose() }, 90_000)
  }
  const cancel = async (): Promise<void> => {
    controller?.abort()
    try { await reader?.cancel() } catch { /* 已关闭的读取器无需重复取消。 */ }
    reader = undefined
    pending = new Uint8Array(0)
  }
  scope[key] = {
    async create(name: string) {
      touch()
      const data = await invoke('/im/conversation/create', 'CREATE_CONVERSATION', 'create_conv_uplink_body', 'create_conv_downlink_body', {
        conversation_type: 3, conversation_scene: 4, participant_list: [{ user_id: botId, user_type: 2 }],
        source_message_id: '', source_conversation_id: '', local_message_id_list: [], source_message_id_list: [],
        is_model_gen_name: false, ext: {}, name,
      })
      return { id: data.conversation_info?.conversation_id, section: data.conversation_info?.last_section_id, index: 0 }
    },
    async history(id: string) {
      touch()
      const data = await invoke('/im/chain/single', 'PULL_SINGLE_CHAIN', 'pull_singe_chain_uplink_body', 'pull_singe_chain_downlink_body', {
        conversation_id: id, anchor_index: Number.MAX_SAFE_INTEGER, conversation_type: 3, direction: direction.OLDER,
        limit: 50, ext: {}, filter: { index_list: [] }, evaluate_ab_params: '', evaluate_common_params: '',
      })
      const messages: Native[] = Array.isArray(data.messages) ? data.messages : []
      if (messages.some((message) => message.conversation_id !== id)) throw new Error('DOUBAO_HISTORY_MISMATCH')
      const last = messages.reduce<Native | undefined>((latest, message) => Number(message.index_in_conv) > Number(latest?.index_in_conv ?? -1) ? message : latest, undefined)
      return { id, section: last?.section_id, index: Number(last?.index_in_conv ?? 0), found: messages.length > 0,
        busy: last?.user_type === 2 && [100, 101, 110].includes(last.content_status) }
    },
    async stop(id: string, reply: string) {
      touch()
      await invoke('/im/message/break_stream_msg', 'BREAK_MSG', 'break_stream_msg_uplink_body', 'unknown', {
        conversation_id: id, reply_msg_id: reply, message_id: '', conversation_type: 3,
      })
    },
    async start(body: Native) {
      touch()
      if (disposed || controller) throw new Error('DOUBAO_DUPLICATE_STREAM')
      controller = new AbortController()
      const params = config.getCommonParams()
      body.client_meta.bot_id = botId
      body.ext.fp = params.fp
      const url = new URL('/chat/completion', config.baseURL)
      url.search = new URLSearchParams(params).toString()
      const response = await fetch(url, { method: 'POST', credentials: 'include', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...config.getCommonHeaders() }, body: JSON.stringify(body) })
      reader = response.body?.getReader()
      return { status: response.status, mime: response.headers.get('content-type') ?? '' }
    },
    async download(address: string, maxBytes: number) {
      touch()
      if (disposed || typeof address !== 'string' || address.length > 16_384) throw new Error('DOUBAO_DOWNLOAD_INVALID')
      let url: URL
      try { url = new URL(address) } catch { throw new Error('DOUBAO_DOWNLOAD_INVALID') }
      // 此来源已由真实文件块及字节下载验证；不接受普通回答里的链接或任意外网地址。
      if (url.protocol !== 'https:' || !/^p\d+-flow-sign\.byteimg\.com$/u.test(url.hostname)
        || url.port || url.username || url.password || url.hash) throw new Error('DOUBAO_DOWNLOAD_ORIGIN_UNSUPPORTED')
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) throw new Error('DOUBAO_DOWNLOAD_LIMIT_INVALID')
      await cancel()
      controller = new AbortController()
      downloaded = 0
      downloadLimit = maxBytes
      // 签名 URL 已含下载授权。禁止携带 Cookie、公共鉴权头，也不跟随重定向。
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]) })
      if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('DOUBAO_DOWNLOAD_TOO_LARGE') }
      reader = response.body?.getReader()
      return { status: response.status, mime: response.headers.get('content-type') ?? 'application/octet-stream' }
    },
    async read() {
      touch()
      if (pending.length === 0) {
        const result = await reader?.read()
        if (!result || result.done) return null
        pending = result.value
        downloaded += pending.byteLength
        if (downloadLimit !== undefined && downloaded > downloadLimit) { await cancel(); throw new Error('DOUBAO_DOWNLOAD_TOO_LARGE') }
      }
      // 每次最多跨 CDP 传送 64 KiB；读取由 Host 拉取驱动，不积压整份回答。
      const value = Array.from(pending.subarray(0, 65_536))
      pending = pending.subarray(value.length)
      return value
    },
    cancel,
    async dispose() { disposed = true; clearTimeout(lease); await cancel(); delete scope[key] },
  }
  touch()
}

# dsh-realtime-voice 的 voiceAgent 服务契约调查

日期：2026-10-04
调查对象：`dsh-realtime-voice@0.3.3`（作者 AlexKaiqi，最后发布 2026-08-31）
目的：为 spec013 复刻 `voiceAgent` 服务提供逐条可核对的契约依据。

## 1. 调查方法

```bash
url=$(npm view dsh-realtime-voice dist.tarball | tr -d '\r')
curl -sL "$url" -o /tmp/va.tgz
mkdir -p /tmp/va && tar xzf /tmp/va.tgz -C /tmp/va
```

全程只读，未安装该插件，未改动本机任何配置。

## 2. 包结构

| 文件 | 作用 |
| --- | --- |
| `package.json` | 清单；声明 `dsh.bundle.patch` 与 `dsh.client.platform = "web"` |
| `cordis.patch.yml` | 插件挂载点，id 为 `realtime-voice` |
| `spec/runtime-contract.json` | **版本化契约（v8）**，本次复刻的主要依据 |
| `plugin-spec.json` | 插件规格描述 |
| `dsh/index.js` | Host 入口，注册 HTTP 路由与静态资源 |
| `dsh/service.js` | 供应商适配器定义（OpenAI Realtime / 豆包 Duplex） |
| `dsh/transport.js` | Host 侧传输注册 |
| `dsh/agent-plan-speech.js` | 与 `dsh-multi-model-provider` 的衔接 |
| `dsh/audio-artifacts.js` | 音频产物存储 |
| `dsh/preview-audio.js` | 音频预览 |
| `client/client.js` | **Client 侧服务实现，`voiceAgent` 在这里注册** |
| `client/audio-input-worklet.js` | 麦克风采集 AudioWorklet |

## 3. 服务注册位置（关键结论）

`client/client.js:910-914`：

```js
function VoiceAgentService(ctx, options) {
  var self = Reflect.construct(Service, [ctx, 'voiceAgent'], VoiceAgentService)
  if (ctx && ctx.reflect && typeof ctx.reflect.provide === 'function') ctx.reflect.provide('realtimeVoice', self)
```

**结论一：`voiceAgent` 注册在浏览器 Client 侧，不是 Host 侧。** 对 `dsh/*.js` 全量 grep `provide('voiceAgent')` 无结果，确认 Host 半区从不注册该服务。

这一点决定了 spec013 的架构选择。参考实现把服务放在浏览器，而会话汇聚与派发所需的 `sessionQuery`、`sessionController` 都在 Host 进程内，导致 Host 侧大脑无法直接调用该服务，必须自建 host↔client RPC 桥。**spec013 因此把复刻实现放在 Host 侧**（见 `design.md` §6.2）。

**结论二：存在一个未文档化的别名 `realtimeVoice`。** 它既不在 README 中，也不在 `spec/runtime-contract.json` 中 —— 源码注释称其为「临时兼容别名」。spec013 不把该别名纳入契约。

## 4. 契约面（依据 `spec/runtime-contract.json` v8）

### 4.1 服务方法

```json
"clientService": {
  "name": "voiceAgent",
  "methods": ["capabilities", "startConversation", "registerActions"]
}
```

兼容别名方法：`models`、`open`、`registerTools`、`recognize`、`readAloud`。

`client/client.js:1004-1006` 确认别名：

```js
VoiceAgentService.prototype.open = VoiceAgentService.prototype.startConversation
VoiceAgentService.prototype.recognize = function (options) { return browserRecognition(this, object(options)) }
VoiceAgentService.prototype.readAloud = function (options) { return browserReadAloud(this, object(options)) }
```

`client/client.js:1029` 确认 `registerTools` 是 `registerActions` 的别名：

```js
VoiceAgentService.prototype.registerTools = VoiceAgentService.prototype.registerActions
```

### 4.2 capabilities

```json
"capabilities": ["secureContext", "realtime", "recognition", "audioInput", "readAloud", "voices"]
```

### 4.3 startConversation 选项

来自 `runtime-contract.json`，并经 `client/client.js:992-1003` 代码核实。**没有默认值对象**，缺省即 `undefined`：

| 选项 | 说明 |
| --- | --- |
| `routeId` | 选择供应商路由；缺 `protocol` 时用它查 `models()` 推导 |
| `protocol` | `'openai-webrtc'` 或 `'doubao-realtime-duplex'`；两者都不是则抛错 |
| `profileId` | 供应商档案 |
| `context` | 交给模型的上下文（仅作为 `instructions`，见 §4.6） |
| `ownerId` | 音频输入租约与动作匹配的归属标识 |
| `initialUserText` | 有界完整转写，trim 后上限 20000 字符 |
| `initialAudio` | `{ pcm16Base64, sampleRate }`；8–48 kHz，≤30 秒，最近邻重采样 |
| `outputOnly` | **契约与 README 均未记录**，但已实现：跳过麦克风、使用 `recvonly` |
| `previewText` | **契约与 README 均未记录**，但已实现：预置 PCM 提示音 |
| `gateway` | `{ path, version?, start, readyEvent? }`，**仅豆包**，路径经正则校验 |

🚩 **两处更正**（对早先基于 README 的推断）：

1. **`onEnd` / `onError` 不存在于 `startConversation`。** 它们是 `readAloud` / `recognize` 的选项。会话事件一律通过 `subscribe()` 获取。
2. **`captureAudio` 是 `recognize()` 的选项**（`client.js:758`），不是会话选项。

### 4.4 会话句柄

```json
"conversation": ["id", "subscribe", "updateContext", "resolveAction", "interrupt", "end"]
```

代码核实补充：

- `subscribe(listener)` 返回退订函数；**首个订阅者会排空一个 ≤16 事件的积压缓冲**。
- `id` 形如 `'realtime-voice-' + n`。
- `end()` 幂等，逆序执行清理，依次发出 `phase: 'stopped'` 与 `closed`，然后清空监听器。
- 兼容方法：`resolveTool`、`close`。

### 4.5 事件

契约文件声明 8 种；**实际发出 9 种** —— `interrupted` 是一等事件（`client.js:251`、`:318`、`:354`），但 `grep -c interrupted spec/runtime-contract.json` 结果为 **0**。

| 事件 | 字段 |
| --- | --- |
| `status` | `connected`、`status` |
| `phase` | `phase` |
| `transcript` | `role`、`text`、`final`、`source`（与 `role` 同值） |
| `action` | `callId`、`name`、`arguments`（**字符串**） |
| `action-result` | `callId`、`name`、`ok`、`output`、`error` |
| `audio-level` | `source`、`level` |
| `interrupted` | —（**契约文件未声明**） |
| `error` | `code`、`message`、`recoverable` |
| `closed` | — |

### 4.6 updateContext 的实际作用

`client.js:305` 发出 `{ type: 'context.update', context }`，**已关闭或未就绪时抛错**。

- OpenAI：转为 `session.update`，只带 `{ instructions }`。
- 豆包：宿主**重建整个会话**，并把 `next.session.id` 钉回原 `state.id`。
- 上下文**只作为 `instructions` 到达模型，不会成为对话条目**。
- 宿主侧 `maxContextChars` 默认 12000，钳制区间 [1000, 50000]。

## 5. 动作注册机制（逐条核实）

`runtime-contract.json` 的 `actionRegistry`：

```json
{
  "registration": "registerActions(ownerPrefix, actions)",
  "ownerMatch": "conversation ownerId startsWith ownerPrefix",
  "resolution": "registered name → execute(args, control) → resolveAction; unknown name under a matched owner → error result; unmatched owner → consumer resolves",
  "asyncResults": "execute may return a Promise; speech continues while the result is pending (dual output); executors that never settle are resolved with a timeout error (action.timeoutMs per action, default 300000ms)",
  "control": "execute may call control.resolve(result, options) to settle before follow-up work",
  "events": "action-result emitted after every automatic resolution"
}
```

代码核实，`client/client.js:1009-1028`：

```js
VoiceAgentService.prototype.registerActions = function (ownerPrefix, actions) {
  var prefix = text(ownerPrefix)
  if (!prefix) throw new TypeError('ownerPrefix is required')
  if (!actions || typeof actions !== 'object' || Array.isArray(actions)) throw new TypeError('actions must be an object of executors')
  var normalized = {}
  Object.keys(actions).forEach(function (name) {
    var action = object(actions[name])
    if (typeof action.execute !== 'function') throw new TypeError('action ' + name + ' must provide an execute function')
    normalized[name] = action
  })
  var entry = { ownerPrefix: prefix, tools: normalized }
  this.toolRegistries.push(entry)
  var self = this
  return {
    dispose: function () {
      var index = self.toolRegistries.indexOf(entry)
      if (index >= 0) self.toolRegistries.splice(index, 1)
    },
  }
}
```

`client/client.js:1032-1043` 的匹配与优先级：

```js
VoiceAgentService.prototype.lookupTools = function (ownerId) {
  var merged = null
  for (var i = this.toolRegistries.length - 1; i >= 0; i -= 1) {
    var entry = this.toolRegistries[i]
    if (ownerId && ownerId.indexOf(entry.ownerPrefix) === 0) {
      if (!merged) merged = {}
      var tools = entry.tools
      for (var name in tools) merged[name] = tools[name]
    }
  }
  return merged
}
```

**注意**：倒序遍历（`i--`）配合 `merged[name] = tools[name]` 的覆盖写入，使**后注册者优先**。

`ownerId` 为假值（`null` / `''` / `undefined`）时返回 `null`，即**静默不匹配**，而不是报错。

### 5.1 动作是如何被触发的

**没有自定义的 invoke 消息。** 触发源是供应商的工具调用，链路如下：

```text
供应商工具调用
   │  OpenAI: response.function_call_arguments.done
   │  豆包:   items[] 数组形态
   ▼
宿主 toolEvent()  transport.js:340-361
   │  （兼容两种方言，用 state.pendingToolCalls 去重）
   ▼
浏览器 normalizeProviderEvent  client.js:250
   │
   ▼
{ type: 'action', callId, name, arguments }   ← arguments 是字符串
   │
   ▼
emit() 自动分发  client.js:291-298
   ├─→ 通知所有订阅者
   └─→ service.dispatchAction(...)      ← 参考实现称之为 dual output
```

**关键点：分发是自动的**，与事件通知走同一条 `emit()` 路径，不是另一个 API。

### 5.2 结算顺序

`client.js:1074-1129`：

| 情况 | 结果 |
| --- | --- |
| owner 未匹配 | 静默（消费方自行处理） |
| 已匹配但动作名未知 | `{ ok: false, error: 'Unknown action: <name>' }` |
| 参数校验失败 | `{ ok: false, error: 'Invalid action arguments.' }` |
| 同步返回 | 直接结算 |
| 返回 `undefined` | `{ ok: true }` |
| 返回 Promise | 结算时解析（期间语音继续） |
| 抛错 | `{ ok: false, error }` |
| 永不结算 | 超时后 `'Action execution timed out.'` |

`control` 只有一个方法（`client.js:1101-1108`）：

```js
resolve: function (result, options) {
  if (resolved || handle.closed) return false
  resolved = true
  if (timer !== null) clearTimeout(timer)
  return self.settleAction(handle, event, result, options)
}
```

**幂等，返回 boolean。** 超时计时器在调用 `execute` **之前**武装，归属该句柄。

### 5.3 结果如何回到模型

`settleAction`（`client.js:1058-1067`）发出 `action-result` 事件，`output` 做**递归 4000 字符截断**（数组不截断）。

线上格式：`{ type: 'tool.result', call_id, output }` 后接 `{ type: 'response.create' }`。
编码：字符串原样，其它 `JSON.stringify`。

🚩 **豆包方言会静默丢弃 `response.create`**（`client.js:596-604`，该方言自动续接）。这是供应商特有行为，spec013 不复刻（见 `design.md` §6.3.1）。

### 5.4 必须保真的行为

| # | 行为 | 出处 |
| --- | --- | --- |
| 1 | 每个 action 的 `execute` 必须是函数，否则抛 `TypeError` | `client.js:1016` |
| 2 | `ownerPrefix` 为空字符串时抛 `TypeError` | `client.js:1011` |
| 3 | `dispose()` 从注册表移除该条目，之后不再匹配；幂等 | `client.js:1023-1026` |
| 4 | `ownerId` 以 `ownerPrefix` 开头才匹配 | `client.js:1036` |
| 5 | 同名前缀**后注册者优先** | `client.js:1034-1040`（倒序 + 覆盖） |
| 6 | 已匹配前缀下未注册的动作名 → 错误结果；未匹配 owner → 静默 | `runtime-contract.json` `resolution` |
| 7 | 分发由 `emit()` 自动完成，无独立 API | `client.js:291-298` |
| 8 | 默认超时 300000ms，可按 action 覆盖，计时器先于 `execute` 武装 | `client.js:52`、`:1101-1108` |
| 9 | `control.resolve` 幂等且返回 boolean | `client.js:1101-1108` |
| 10 | 结果 `output` 递归 4000 字符截断 | `client.js:1047` |
| 11 | 错误文案逐字一致 | `client.js:1079`、`:1084` |

## 6. 音频输入租约

```json
"audioInput": {
  "ownership": "exclusive-lease",
  "ownerOption": "ownerId",
  "conflictCode": "audio_input_busy",
  "standbyPreemption": "recognize-preemptible",
  "release": "conversation-end-or-startup-failure",
  "capture": "same-origin AudioWorkletProcessor batches Float32 microphone frames; the Client downsamples them to 16 kHz PCM for Doubao",
  "workletPath": "/dsh-realtime-voice/audio-input-worklet.js"
}
```

麦克风是**排他租约**：`ownerId` 标识持有者，冲突时返回 `audio_input_busy`。

## 7. 归属边界（重要）

`runtime-contract.json` 明确列出了该服务拥有与不拥有的能力：

```json
"owns": [
  "provider-wire-protocol", "browser-transport", "browser-media-lifecycle",
  "audio-input-arbitration", "provider-event-normalization",
  "action-execution-loop", "dual-output-scheduling"
],
"doesNotOwn": [
  "model-catalog", "credential-resolution", "role-profile",
  "drafts", "agent-submission", "knowledge", "delegation-policy"
]
```

**`doesNotOwn` 中包含 `agent-submission`。** 这直接说明：参考实现刻意不做会话投递，这正是 spec013 要补齐的部分——用 `sessionController.prompt` 实现 `agent-submission`，与 `voiceAgent` 契约互补而非重复。

## 8. 供应商绑定与依赖风险

| 项 | 情况 |
| --- | --- |
| 供应商 | GPT Realtime（`openai-webrtc`）与豆包 Duplex（`doubao-realtime-duplex`），均为云端 |
| 运行时依赖 | `dsh-multi-model-provider/realtimeModelRuntime` |
| peerDependency | `dsh-multi-model-provider: ^0.1.0-rc.11` |
| 最后发布 | 2026-08-31，此后无更新 |

### 8.1 版本漂移是真实风险

```text
dist-tags: { "latest": "0.1.0-rc.11", "next": "0.1.0-rc.19" }
```

- 该包的 `publishConfig.tag` 是 `next`，因此 **`latest` 指向的是最旧的已发布版本**（rc.11），是个陈旧标签。
- peer 范围 `^0.1.0-rc.11` 解析为 `>=0.1.0-rc.11 <0.2.0-0`，**全部 7 个已发布版本都满足**，所以全新安装会装到 **rc.19** —— 比作者开发时用的 `link:../dsh-multi-model-provider` 版本**新了 8 个发布**。
- 好消息：两者的耦合**仅通过 Cordis 注册表（peer）**，`dsh-realtime-voice` 在运行时**不 import** 它的任何东西。

**结论：不适合作为依赖。** spec013 只复刻其契约，不引入该依赖，也就不承担这一漂移风险。

## 9. 线协议与打断（供参考，不复刻）

### 9.1 两种拓扑

| 供应商 | 拓扑 |
| --- | --- |
| OpenAI | **WebRTC**：浏览器直连 OpenAI 传输媒体与 `oai-events` 数据通道；宿主只做 SDP 交换，密钥不下发浏览器 |
| 豆包 | **WebSocket 代理**：浏览器 → 宿主 → `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` |

### 9.2 打断的三条路径

1. **浏览器 RMS 检测**（仅豆包）：`client.js:215-230`，地板 `0.025`、噪声 ×2.5、连续 4 帧，自适应地板在输出期间不学习。
2. **供应商 VAD**：豆包 `:650-652`；OpenAI `:345-355`，**故意不发 `response.cancel`**（会话已设 `interrupt_response: true`，重复取消会与服务端竞争并产生假错误）。
3. **显式 `interrupt()`**：`:311-319`。

`playbackSuppressed` **只在 `response.created` 时清除**；被抑制的音频在解码前丢弃。

**这些都是供应商特有行为，spec013 第一版不做 barge-in，因此不复刻**（见 `design.md` §7、§6.3.1）。

## 10. README 与契约文件的不一致（共 17 处，列出关键项）

| 不一致 | 说明 |
| --- | --- |
| 🚩 `realtimeVoice` 别名 | README 与契约文件**均未记录** |
| 🚩 4 条未文档化路由 | `{base}/audio-input-worklet.js`、`{base}/client.js`、`POST {base}/artifacts/input`、`GET {base}/artifacts/audio/{uuid}` |
| 🚩 `outputOnly`、`previewText` | 完全未文档化但已实现 |
| 🚩 浏览器打断检测**仅豆包** | README 表述暗示是通用的 |
| 🚩 契约文件**少声明** | 无 `interrupted` 事件、无 `connecting` 阶段 |
| ✅ 准确 | 能力清单、兼容 API 清单、同源规则、启动队列、`audio-level`、30 秒/20000 字符边界 |
| ⚠️ 无法验证 | `test/` 被 `files` 白名单排除，但 `plugin-spec.json` 引用了 6 个测试文件 |

**对 spec013 的意义**：契约文件本身**不是完全可信的唯一来源**，必须以代码为准。这也是为什么本调查的每条结论都标注了文件与行号。

补充核对 `dsh-realtime-voice@0.3.3` 发布包：`client/client.js:372` 和 `:561` 的
`startConversation()` 会等待 `navigator.mediaDevices.getUserMedia()` 完成后才返回会话；
`client/client.js:779` 的 `recognize({ captureAudio: true })` 会在创建识别句柄时立即发起
采集请求。该包没有公开 `deviceId` 或 `setSinkId` 参数，因此 CodingNS 只能在 Client
边界短暂注入 `getUserMedia` 约束，不能把设备标识上传到 Host，也不能宣称已控制输出设备。

## 11. 已核实 vs 未核实

| 项 | 状态 |
| --- | --- |
| 服务名、别名、方法名、事件名 | **已核实**（代码 + 契约文件） |
| 服务注册在 Client 侧 | **已核实**（`client.js:910-914`；Host 侧 grep 无结果） |
| `registerActions` 校验、匹配、优先级、`dispose` | **已核实**（`client.js:1009-1043`） |
| 动作分发由 `emit()` 自动完成 | **已核实**（`client.js:291-298`） |
| `control.resolve` 幂等 + boolean | **已核实**（`client.js:1101-1108`） |
| 默认超时 300000ms | **已核实**（`client.js:52`） |
| `output` 递归 4000 字符截断 | **已核实**（`client.js:1047`） |
| 错误文案 | **已核实**（`client.js:1079`、`:1084`） |
| `interrupted` 事件未在契约中声明 | **已核实**（`grep -c` = 0，但代码中发出） |
| `startConversation` 无 `onEnd`/`onError` | **已核实**（`client.js:992-1003` 无此参数） |
| `captureAudio` 属于 `recognize()` | **已核实**（`client.js:758`） |
| 该插件在 DSH 0.2.0-rc.2 上的实际可用性 | **未验证**（未安装） |
| 运行时行为（超时是否真的触发、dual output 是否真的不阻塞） | **未验证**（纯静态分析） |
| `dsh-multi-model-provider` rc.19 的接口变化 | **未分析**（上述结论均针对 rc.11） |
| 是否提供 `.d.ts` | **不提供**；签名均由 JS 重建 |

## 12. 复刻清单

复刻实现要行为等价，至少要满足：

1. 暴露名为 `voiceAgent` 的服务，含 `capabilities`、`startConversation`、`registerActions`。
2. `registerActions` 的参数校验与抛错行为一致（`TypeError`）。
3. owner 前缀匹配用 `startsWith` 语义；假值 `ownerId` 静默不匹配。
4. 同名前缀**后注册者优先**。
5. `dispose()` 幂等，且只移除自己那一条。
6. 已匹配前缀下的未注册动作返回 `'Unknown action: <name>'`；参数错误返回 `'Invalid action arguments.'`。
7. 动作分发由事件发出路径自动完成，无独立 invoke API。
8. `control.resolve` 幂等且返回 boolean。
9. 异步执行器超时结算，默认 **300000ms**，可覆盖。
10. 每次自动结算发出 `action-result`，`output` 递归截断至 4000 字符。
11. `capabilities()` 只声明实际支持的能力。

**允许不同**：注册位置（Host 而非 Client）、供应商适配、传输方式、采集实现、打断策略、线协议方言处理。

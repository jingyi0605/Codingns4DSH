<div align="center">

# CodingNS for DeepSeek Harness

**把外部 Agent CLI、持久终端、工作区调试和远程访问，装进 DSH 原生界面。**

[![npm version](https://img.shields.io/npm/v/%40jingyi0605%2Fcodingns4dsh?logo=npm)](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)
[![DSH compatibility](https://img.shields.io/badge/DSH-0.2.1--alpha.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-3C873A?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/gpl-3.0.html)

**简体中文** · [English](README.en.md)

**当前版本 `@jingyi0605/codingns4dsh@0.2.1-beta.3`** · DSH **`>=0.2.0-rc.2 <=0.2.1-alpha.1`**（已验证 `0.2.1-alpha.1`）· Node **`>= 22.19`** · macOS / Linux / Windows

**[GitHub](https://github.com/jingyi0605/Codingns4DSH)** · **[npm](https://www.npmjs.com/package/@jingyi0605/codingns4dsh)** · **QQ 群 1092985965**

<p>
  <a href="#界面预览">界面预览</a> ·
  <a href="#这是什么">这是什么</a> ·
  <a href="#支持的外部-agent">外部 Agent</a> ·
  <a href="#功能详解">功能详解</a> ·
  <a href="#安装">安装</a> ·
  <a href="#首次使用">首次使用</a> ·
  <a href="#故障排查">故障排查</a> ·
  <a href="#开发">开发</a> ·
  <a href="#鸣谢">鸣谢</a> ·
  <a href="#许可证">许可证</a>
</p>

</div>

## 界面预览

<div align="center">
  <img width="100%" src="assets/screenshots/workspace-overview.jpg" alt="工作台与右侧 Git 面板">
</div>

CodingNS 工作台把会话、Agent 选择器与右侧 Git 面板放在同一界面中。

---

## 这是什么

**DSH（DeepSeek Harness）** 是一个编码 Agent 运行框架，由 CLI 和 Web 界面组成，在你的 Workspace 中运行 Agent 循环。

**Codingns4DSH 是一个 DSH 插件 Bundle**（Host 层 + 浏览器层），提供十二个模块，全部在 **设置 → Codingns4DSH** 中配置。

> 名称说明：本插件名为 **Codingns4DSH**（npm 包 `@jingyi0605/codingns4dsh`，设置页入口显示为 Codingns4DSH）；文中单独出现的 **Codingns4DSH** 指提供 Control API、账号与中继隧道的平台服务。

| 模块 | 作用 | 默认 |
| --- | --- | :---: |
| **外部Agent集成** | 把已安装的 Agent CLI 变成 DSH 原生会话：流式输出、工具调用、权限确认、提问、用量、思考强度 | 开 |
| **工作区会话增强** | 会话行显示 Agent Logo、归档会话入口、工作区隐藏/恢复入口、订阅/用量信息 | 关 |
| **移动端访问增强** | 手机或窄屏下收起主侧栏、设置导航改为图标轨道，支持左右横滑开合侧栏、Android 振动与局域网 PWA 通知 | 开 |
| **终端强化** | 持久终端，以及 Shell、主题、字体、光标、滚动缓冲区设置 | 关 · 需重启 |
| **局域网访问DSH** | 监听端口并把局域网地址转发到本机 DSH Web；状态指示器显示启动状态，一键复制可用的访问地址 | 常驻 |
| **登录保护** | 可选：用统一的本地账号保护局域网**和**中继访问，回环地址始终放行 | 常驻（卡片） |
| **中转访问服务** | **在互联网任何位置访问自己的 DSH Web**，端到端加密 | 关 |
| **工作区调试** | 按工作区保存启动配置、检查端口、HTTP 服务代理 | 开 |
| **Git 仓库管理** | 在右侧 Sidebar 标签页查看改动、暂存文件、提交和 Git 版本历史 | 开 |
| **文件管理增强** | 在文件侧栏创建、重命名、移动、复制、删除文件和目录，并支持代码与脚本识别 | 关 |
| **PeerHost 聚合工作台** | 当前 Host 代理已握手的其他 DSH Host，按 HostScope 聚合工作区、会话和受控工具 | 关 |
| **全局智能助理（测试中）** | 同一工作台创建、对话、配置和重置；项目认知、连续文字/语音、音色与形象管理 | 关 |

DSH 原生部分不会被替换：对话、会话列表、侧栏、设置、权限确认仍然是 DSH 自己的组件。

一切都跑在 **Host（你的电脑）** 上：Agent 进程、终端、文件、局域网/中继监听；浏览器只是视图。Agent CLI 作为 DSH 子进程使用自己的凭据与上游，模型流量不经过插件。远程访问全部可用。

补充说明：Codingns4DSH 装好后侧栏终端就已存在，**终端强化** 只是把它从基础本地 PTY 切换为持久后端（macOS/Linux 用 tmux，Windows 用 ConPTY），重启后生效；**工作区调试** 目前界面文案只有中文。

全局助理启用后，侧栏图标、悬浮形象和插件设置里的按钮打开同一工作台。首次只有名称、对话模型、性格背景、形象四个字段，右侧展示形象、名称与性格摘要，不提供试聊或问候试听；默认使用浏览器 TTS（文字转语音），无需安装 MOSS。点击创建后进入单栏连续对话。创建后的配置分为 **基本信息、形象管理、声音管理、更多设置** 四个标签页，识别模型放在声音管理，关联项目、提示词与索引调试放在更多设置。所有配置共用草稿，点击 **保存配置** 后统一生效；切换标签保留草稿，取消丢弃修改。下载和导入只准备资源，不提前启用。对话模型显式保存并传入原生助理 Agent，后台刷新不会覆盖未保存选择。实现与验证见[统一草稿保存与模型路由修复记录](docs/开发记录/20261007-助理配置统一草稿保存与模型路由修复记录.md)。

文字与实时语音共用 Host 持久保存的一份历史，可跨输入方式追问，停止语音、刷新或自动索引不会清除记录。正式对话由独立管理根 Agent 执行，开放工作区列表、会话列表、会话摘录、管理跟进四个工具、仅限用户已上传文件的只读文本附件工具，以及 Host 已注册的原生联网搜索；不允许创建子 Agent、执行命令、读取任意本地文件或修改代码。仅助理模型关闭思考，其他会话保留自己的参数；不支持关闭思考的模型会明确提示更换。项目只读取勾选范围内的未归档成员，兼容 PeerHost 虚拟工作区；无有效索引时可通过管理工具查询，范围变更隔离旧上下文。用户要求跟进时，发送前重新核对来源、范围和版本，默认排队，送达不代表完成。语音回复中的完整句子即刻进入串行 TTS 队列，残句在流结束时补播，打断会取消当前和后续播报。见[管理 Agent 与逐句流式播报实现记录](docs/开发记录/20261007-全局助理管理Agent与逐句流式播报实现记录.md)。

助理按连续对话中的意图自然调整语气：陪伴聊天先倾听和回应情绪，工作问题按当前事实查询和跟进，默认一到两个短句、100 字以内。天气、新闻等实时公开问题使用 DSH 的 `web_search`，复用 Host 的搜索提供商和凭据；搜索未配置或失败时如实说明，不把私有会话、附件或主机路径发送到搜索。助理的 DSH 身份和独立目录由 Host 明确提供，预览和索引总结仍不开放工具。见[联网搜索与陪伴交流改造记录](docs/开发记录/20261007-助理联网搜索与陪伴交流改造记录.md)。

联网搜索已在实际运行日志中完成两次调用。聊天、实时字幕和通话详情按「正文 → 工具调用 → 后续正文」穿插展示工具名称、执行状态及可展开的参数／结果，不集中在最底部；活跃时沿用约 600 毫秒的界面刷新。AI 正文与工具记录独立，语音只朗读正文，工具变化不会重复播报。旧记录没有段内位置时，工具放在所属回复之前。见[联网搜索复核与实时工具展示记录](docs/开发记录/20261008-助理联网搜索复核与实时工具展示记录.md)。

日常对话的助理名称右侧显示 **思考中、认知更新、空闲、工作中** 状态标签；消息区独立滚动，圆角输入栏始终位于窗口底部，左侧添加附件，右侧电话实时通话与发送／停止，标题配置和关闭也使用 DSH 风格图标。输入框随内容自动增高并可缩回单行，移除拖拽手柄及蓝色焦点边框，超过高度上限后内部滚动。语音尚未就绪时禁用电话按钮，并通过提示引导到声音管理。

日常对话已移除底部压缩与清理工具栏，没有助理会话列表；连续轮次复用 DSH Agent，由其自动压缩上下文。点击标题栏配置左侧的 **清理图标**，或发送 **`/clear`**（兼容 `/清理`、`/reset`、`/重置`），确认一次后只删除助理消息和交流摘要，保留配置与项目索引；取消不执行。输入 `/` 可选择清理提示。**重置助理**位于「配置 → 更多设置」，依次确认两次模态框后才执行：撤销生成、索引和语音初始化任务，清空配置和派生数据，返回创建界面，原始项目会话及下载素材保留。实现与验证见[输入栏附件与斜杠指令优化记录](docs/开发记录/20261007-助理输入栏附件与斜杠指令优化记录.md)和[spec013.1](specs/spec013.1-智能助理生命周期集成/README.md)。

输入栏支持文件选择、粘贴图片、移除草稿附件与仅附件发送；最多 **6 个附件，单个 10 MiB，合计 20 MiB**，成功发送前不会清空草稿。图片由 DSH 原生附件服务验证后交给模型，需模型支持视觉；文本文件可通过只读工具读取前 128 KiB，当前不解析 PDF、Office 等二进制文档。持久历史只保存附件引用与名称，不保存上传编码或用户指定的 Host 路径。

**工作台 → 配置 → 形象管理**复用一份角色配置；可选择基本形象和已安装形象，设置悬浮/对话展示并安装素材，预览同步当前选择。支持男女基本形象、透明图片、Codex v1/v2 宠物动作图集和 Live2D 模型地址。悬浮显示默认关闭，对话形象默认开启；助理未创建时不显示悬浮形象，创建后的悬浮宠物可拖动，点击打开统一工作台。Live2D 只在使用时加载，全身效果需要自备全身模型；本轮不提供本地文件上传。配置与源码验证见[形象插槽实现记录](docs/开发记录/20261007-全局助理统一形象插槽实现记录.md)和[spec014](specs/spec014-全局助理统一形象插槽/README.md)。

新配置提供 **鱼仔（男生）／鱼妞（女生）**，默认鱼妞；两张蓝白鲸鱼风格透明 PNG 使用生图工具生成，以固定同源图片 URL 加载，无需外部形象包或 Live2D 引擎，见[生成与接入记录](docs/开发记录/20261007-男女基本形象生图与接入记录.md)。初始化默认填入友善、耐心、可靠、表达简洁的标准性格，允许编辑或清空，已有用户设定保持原样。第三方素材与插件源码、npm 包分离。在「安装形象包」填写公开 **GitHub 仓库、子目录或文件地址**，或 **HTTP(S) JSON 清单、Live2D 模型、图片 URL**，点击「查找形象包」，选择候选后「安装并使用」。支持 CodingNS、Codex pet.json、DSH Live2D pet.json 与 Cubism 2/3 模型；完整素材下载到 CodingNS 自有目录，工作台安装成功后加入草稿列表，底部保存后正式登记启用，刷新和 Host 重建继续读取本地素材。适配的是素材与清单，第三方插件的脚本、换装界面、语音和桌面窗口仍由原插件实现。公开 API、清单示例和素材许可见[助理形象包与适配器接入规范](docs/开发规范/20261007-助理形象包与适配器接入规范.md)。

形象页面默认提供 **鱼妞／鱼仔和已安装形象**。悬浮尺寸提供迷你 72、标准 144、自定义三个档位，自定义时可输入 72–320 像素，旧尺寸保持兼容。「添加形象」内选择安装形象包或自定义素材，只显示对应表单。勾选 **启用第三方形象** 时弹出使用协议，明确同意并保存后才读取首批 12 条形象记录，并直接合并进 **当前形象** 下拉列表；第三方名称旁显示蓝底白字的 **第三方** 标签，列表选项、当前选中项和创建页采用相同标记，不再另设目录选择列表。已安装角色可直接切换；选中未安装角色后，自动将完整素材下载到独立临时目录，在右侧形象区域加载真实形象，无需另点下载按钮或确认该形象许可。下载及临时模型加载只在预览位置显示动画，不显示下载文字、进度条或停止预览按钮。预览不修改当前角色，下载期间仍能切换形象，切换或关闭后自动清理，异常断开由心跳超时回收。只有正式点击 **采用此形象** 时才需确认素材许可；采用复用已下载素材，正式安装及设置保存成功后才登记选中。失败后重新选择同一条目即可再次预览。安装后同一选项不会重复出现，关闭第三方目录保留已安装形象和当前角色。Live2D 沿用 Host 已单独安装的引擎。同意版本与时间随设置保存，刷新无需重新同意，使用说明更新后重新确认。手工 URL 安装继续可用。

文档保留[兼容形象包目录](assets/assistant-avatar-catalog.md)，界面中的 GitHub 目录按钮已移除。目录包含序号、名称、仓库地址、作者、简介、备注及统一安装清单、固定版本上游清单和许可链接。npm 文件白名单仅新增目录 JSON 与安装清单元数据，第三方图片、模型、动作和引擎仍从上游按需安装；页面内目录读取随包文件，可在 GitHub 目录尚未推送时使用。原目录与安装逻辑见[第三方形象协议与预览安装记录](docs/开发记录/20261007-第三方形象协议与预览安装实现记录.md)。

大肥鱼等第三方形象在创建和管理列表中明确标记为 **第三方**。首次创建只提供男女基本形象和用户已登记的形象，不把未登记的旧预设 ID 补入列表或预览；读取仍保留旧设置。已创建助理的旧大肥鱼选择继续兼容，并提供「将此形象安装到本地」。旧外链配置和扩展导入 API 保留。安装素材按内容版本隔离，保留模型、贴图、表情、动作、作者与许可，双展示共用下载；失败或取消不登记半包。实现与验证见[形象素材外置与仓库安装记录](docs/开发记录/20261007-形象素材外置与仓库安装实现记录.md)。

正式使用的 Live2D 引擎 `l2d@2.1.1` 是需要用户在目标 Host 可解析的依赖目录中单独安装的可选外部依赖；npm 不自动安装 [optional peer dependency（可选对等依赖）](https://docs.npmjs.com/cli/configuring-npm/package-json/#peerdependenciesmeta)。源码开发将同版本引擎列为开发依赖，安装本仓库依赖后 Stage0 源码入口即可解析，不需要修改运行 Profile。插件不捆绑引擎、Cubism SDK 或第三方宠物插件代码，形象素材安装器也不会自动安装引擎。选择 Live2D 时才加载引擎；缺失、接口异常或 WebGL 不可用时显示具体原因，临时预览不误显示其他角色，正式形象沿用内置回退，助理仍可创建和文字对话。修复依赖后重新选择即可重试，失败导入不会阻止恢复。

形象未就绪时显示呼吸光晕、轨道光点和真实进度条，图片、精灵图与 Live2D 共用该反馈。正式 npm 包在普通环境就绪后仅显示角色，缓存、下载次数、耗时和调试 tooltip 只在专用 **dsh-stage0** 服务中显示；正式环境不发送缓存诊断请求。Live2D 成功绘制后自动保存本地透明预览，刷新或再次载入时先显示预览与底部小型加载动画/进度条，后台真实动画就绪后淡入接替；首次使用或缓存不可用时保留原有完整载入效果。预览按形象、展示位置和构图/资源版本隔离，仅缓存图片，刷新仍需重建 WebGL。公开接口和容量规则见[统一形象本地透明预览实现记录](docs/开发记录/20261007-统一形象本地透明预览实现记录.md)，先前评估见[Stage0 诊断隔离与刷新持久化评估记录](docs/开发记录/20261007-形象Stage0诊断隔离与刷新持久化评估记录.md)。

选择形象后自动裁出 **128px 透明头像**，助理正式/流式消息和侧栏全局助理按钮共用并同步切换。图片取待机素材上部，动作图集取待机首帧，Live2D 优先复用透明预览；头像独立持久化，刷新直接读取已生成图片，不需要为头像重新加载动画。按钮更新保留焦点和打开工作台的行为。特殊构图可通过可选头像适配器自定义，旧扩展和生成失败保留默认头像，见[统一头像实现记录](docs/开发记录/20261007-统一形象头像生成与入口接入记录.md)。

在助理「基本」设置中，名称位于左侧，44×44 头像与「微调头像」位于右侧，同一行显示；裁剪面板在下方整行展开。使用 `react-easy-crop`（头像裁剪组件）拖动、缩放并实时预览，「确认裁剪」暂存头像，点击底部「保存配置」后同步更新对话与侧栏按钮；取消保留原头像。用户裁剪图片与构图按形象保存在当前浏览器，再次打开及刷新均可恢复，不随自动预览缓存到期；切换形象保留各自设置。浏览器清理网站数据会移除这些本地设置，详见[头像微调实现记录](docs/开发记录/20261007-头像微调与成熟裁剪组件接入记录.md)。

**工作台 → 配置 → 声音管理**提供初次配置向导，无必填字段：点击「准备语音资源」，Host 自动准备中英双语实时识别、专用运行环境与 MOSS CPU 模型；完成后点击「试听声音」检查播报，点击底部「保存配置」后，再回到对话开始语音授权麦克风。打开面板只检查资源，不下载或录音。已有识别模型、音色及播报参数保留；失败可重试并复用已完成资源。macOS ARM64／x64、Linux glibc ARM64／x64、Windows x64 提供固定版本独立 Python 的自动下载路径，无须预装 Python；旧专用虚拟环境与显式 Python 环境覆盖继续兼容。见[声音首次配置向导实现记录](docs/开发记录/20261007-声音首次配置向导实现记录.md)。

向导下方分别提供默认收起的 **语音输入**、**语音输出** 卡片。输入组管理麦克风和识别模型，可选择中文轻量／中文 Large／中英双语模型并下载、应用或验证；输出组管理输出设备、播报后端、音色、试听和播报参数。两组可独立展开，折叠保留草稿和下载任务，收起输出会停止组内试听。见[语音输入输出折叠设置实现记录](docs/开发记录/20261007-语音输入输出折叠设置实现记录.md)。

Windows x64 初始化在下载 MOSS 模型前检查推理库能否加载；若出现 DLL 错误，请按提示检查 Microsoft Visual C++ 2015–2022 x64 运行库及错误中指明的依赖，再重试。中文管道、系统解压器和取消释放的修复及实机验收要点见[Windows 兼容修复记录](docs/开发记录/20261007-全局助理Windows兼容修复记录.md)。

**音色设置**独立于形象包和语音识别模型，提供 MOSS 官方 ONNX 包的 **18 个预设**，显示名称、语言、性别。MOSS 模式下点击「试听音色」使用固定默认文本合成，无需填写试听文本；也可打开 Kyutai／AISHELL-3 网站，填写完整录音 ID 或 Hugging Face 音频文件网址「导入音色」，例如 `kyutai:voice-donations/0a67.wav` 或 `aishell:SSB00050001`。导入和音色切换随底部「保存配置」统一生效。浏览器模式隐藏 MOSS 音色、导入和高级参数，仅保留 MOSS 初始化入口及通用播报控制。本地 MOSS 的真实音质、首音延迟及内存仍待实测。使用方法与验证见[Host MOSS 语音与独立音色管理实现记录](docs/开发记录/20261007-HostMOSS语音与独立音色管理实现记录.md)。

实时对话会在流式文本出现句末或足够长的逗号、分号、冒号短语时提前合成；没有标点时也按等待时长和长度补切。MOSS 在上一段生成完成后即可准备下一段，前段继续播放，首帧立即解码输出；整轮音频播完才恢复听取状态。保持一个 CPU 推理进程，并限制提前准备的待播音频。实现与验收边界见[流式语音分段与播放流水线优化记录](docs/开发记录/20261007-流式语音分段与播放流水线优化记录.md)。

面板的「播报控制」支持 **语速 0.5～2 倍、音量 0～100%**，精确输入后 MOSS 模式可先试听、再保存，或恢复默认；切换音色保留参数。MOSS 高级设置提供分段停顿、单段文本长度与固定随机种子。当前 MOSS 使用轻量播放变速，音高会随语速变化；浏览器后端也应用所选语速和音量，在浏览器模式恢复默认只重置这两项。

初次向导和模型选择的新配置默认 **中英双语实时模型**（模型文件约 200 MB），适合包含英文术语的编程交流；已有选择继续复用，仍可手动选择中文轻量 14M 或 Zipformer Large。下载大小不等于实际运行内存占用。

点击聊天输入栏的电话图标进入专用实时通话页：展示当前助理形象、通话计时和底部流式文字，提供扬声器、麦克风静音和挂断控制。MOSS 在浏览器支持时可选择播放设备，浏览器音色使用系统默认输出；两种后端均支持关闭播报声音。挂断后回到聊天，以一张 **语音沟通** 卡片显示有效发言条数和时长；点击打开详情，查看完整文字及工作区、联网搜索等实际能力调用的参数和结果摘要，包括失败或被打断的执行。不保存原始录音，压缩模型上下文后仍保留通话内容，清理对话才删除记录。见[实时语音通话界面与聚合记录实现记录](docs/开发记录/20261007-实时语音通话界面与聚合记录实现记录.md)。

通话页右上角的 **收起通话** 可将当前通话收为悬浮球；已启用悬浮助手时合并到助手上，继续显示计时、发声提示和完整流式字幕气泡。点击悬浮球、助手或字幕气泡顶部可恢复窗口；收起和恢复保留同一次通话与静音设置，字幕可滚动回看。见[实时通话收起与悬浮字幕实现记录](docs/开发记录/20261008-实时通话收起与悬浮字幕实现记录.md)。

模型下载时显示当前文件的进度条、文件序号、百分比和下载大小；文件大小未知时显示不定进度条与已下载大小，下载后单独显示初始化状态。见[进度条实现记录](docs/开发记录/20261007-语音模型下载进度条实现记录.md)。

**管理模型**窗口用卡片展示未下载、文件不完整、已下载、当前使用和最近验证结果，可展开文件大小及位置，支持刷新、验证、补全下载、切换和重新下载。模型通过加载与静音识别验证后才设为当前使用；重新下载失败保留旧缓存，成功后窗口继续展示结果。见[模型管理实现记录](docs/开发记录/20261007-语音模型管理与可用性验证实现记录.md)。

---

## 支持的外部 Agent

在 Host 上按命令名检测，版本与模型列表优先从 CLI 自身读取；没有安全只读目录接口的 Agent 只提供 Provider 默认模型，避免刷新模型时创建会话。检测到的 Agent 默认启用，可单独启停。内置的 **DeepSeek Harness** Agent 始终可用。

| Agent | id | 命令 | 协议 | 能力 | 备注 |
| --- | --- | --- | --- | --- | --- |
| Command Code | `command-code` | `command-code`、`commandcode`、`cmdc` | CLI + ACP | 模型、Skill、流式、恢复、打断、工具、思考、用量、权限、提问 | 正式 Host 运行时使用 `cmd acp`；DSH 权限映射为 `--plan`、`--permission-mode accept-edits` 或 `--yolo`，问题通过 Command Code 的 `session/request_permission` 扩展回传 |
| Claude Code | `claude-code` | `claude` | stream-json | 模型、Skill、流式、恢复、打断、工具、思考、用量、权限确认、提问 | 原生 `.claude/skills` 目录与 `/name` 调用，`can_use_tool` 权限确认与 `AskUserQuestion` 提问 |
| Kimi CLI | `kimi` | `kimi`、`kimi-cli` | stream-json | 上述全部 + 权限确认、提问、插话 | — |
| Gemini CLI | `gemini` | `gemini` | ACP | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | ACP 权限与 form elicitation（表单式询问） |
| Pi Agent | `pi` | `pi`、`pi-agent` | JSON-RPC | 模型、流式、恢复、打断、工具、思考、用量、插话 | 当前协议没有可验证的 DSH 权限/提问回传 |
| Codex | `codex` | `codex` | JSON-RPC（app-server） | 全部 + 权限确认、提问、插话 | app-server 显式开启 `request_user_input`，由 DSH 原生问题面板承载 |
| OpenCode | `opencode` | `opencode`，或 `OPENCODE_SERVER_URL`（默认 `http://127.0.0.1:4096`） | HTTP + SSE | 全部 + Skill、权限确认、提问 | 原生 `/skill` 或 `debug skill` 目录，`session/.../command` 展开显式 Skill |
| Grok Build | `grok` | `grok`、`grok-build` | ACP | 模型、Skill、流式、工具、思考、用量、权限确认、提问 | 原生 `grok inspect --json` Skill 目录、ACP 权限与 Grok 私有 `_x.ai/ask_user_question` 结构化提问 |
| MiniMax Code | `mcode` | `mcode` | ACP / stream-json | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | 默认 ACP 路径支持交互；显式思考档位的 `exec` 路径没有交互式回传；上游贡献者：[chenjunyi000](https://github.com/chenjunyi000)；提交 PR [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6)、[#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| ZCode | `zcode` | `zcode`、桌面端内置运行时 | JSON-RPC 裸信封 | 模型、流式、恢复、打断、用量 | 上游贡献者：[chenjunyi000](https://github.com/chenjunyi000)；提交 PR [#6](https://github.com/jingyi0605/Codingns4DSH/pull/6)、[#7](https://github.com/jingyi0605/Codingns4DSH/pull/7) |
| CodeBuddy（自动识别 CN/国际版） | `codebuddy` | `codebuddy`、`codebuddy-code`、`cbc` 及 Windows `.cmd` 入口；按环境变量与认证域名自动选择区域 | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、用量、权限确认、提问 | 支持 stdio ACP 与 HTTP sidecar（旁路服务） ACP；CodexHost 上游贡献者：[mouzhi](https://github.com/mouzhi)；首次适配 [f30b000](https://github.com/BytePioneer-AI/codex-host/commit/f30b000f88950c40844b071eec2f6f385c6bcb49) |
| WorkBuddy | `workbuddy` | WorkBuddy 桌面应用内置 `codebuddy` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | 通过 HTTP ACP sidecar（旁路服务）接入权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；首次适配 [6e9f365](https://github.com/BytePioneer-AI/codex-host/commit/6e9f365e2bf8ac61716f8250475530ae790f2d2f) |
| Cursor CLI | `cursor-cli` | `cursor-agent`、`agent` | ACP（`acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[mouzhi](https://github.com/mouzhi)；首次适配 [ad6ba8e](https://github.com/BytePioneer-AI/codex-host/commit/ad6ba8e04d294c473d2dcad99880496ff39c1f7e) |
| Kiro CLI | `kiro-cli` | `kiro-cli` | ACP（`acp --agent-engine v3 --auth-method cli`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)；首次适配 [79675cd](https://github.com/BytePioneer-AI/codex-host/commit/79675cdbfdc042eb37a849c3eb1539e9efc40a0d) |
| Qoder | `qoder` | `qoder`、`qodercli` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)、[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；PR #289 合并 [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| Qoder CN | `qoder-cn` | `qodercn`、`qoderclicn` | ACP（`--acp`） | 模型、流式、恢复、打断、工具、思考、权限确认、提问 | ACP 标准权限与 form elicitation（表单式询问）；CodexHost 上游贡献者：[gy212](https://github.com/gy212)、[BytePioneer-AI（ChongWen）](https://github.com/BytePioneer-AI)；PR #289 合并 [8926130](https://github.com/BytePioneer-AI/codex-host/commit/8926130af1426a467747b66d8d2dbf68f7764a7b) |
| Antigravity | `antigravity` | `agy` | stream-json（stdin NDJSON） | 模型、流式、恢复、打断、工具、思考 | CodexHost 上游贡献者：[gy212](https://github.com/gy212)；首次适配 [ed4e785](https://github.com/BytePioneer-AI/codex-host/commit/ed4e785116642eafc08e4186e92e83f3816c7765) |

**模型** 模型列表 · **流式** 实时输出 · **恢复** 重启后继续 · **打断** 取消当前回合 · **工具** 对话中渲染工具调用 · **思考** 推理/思考强度 · **用量** token 或订阅额度 · **权限确认 / 提问** 变成 DSH 原生交互 · **插话** 回合中追加消息。

未列出的能力表示该 CLI 或其版本不支持；Agent 的安装与登录都在 DSH 之外完成，Codingns4DSH 不保存 Agent 凭据。

权限确认和提问都由 DSH 原生组件承载。Web Client Bundle 必须注入 `@deepseek-ai/dsh-client-ui-user-questions`，否则即使 Host 收到问题事件也没有问题面板。支持交互式回传的适配器会把 Provider 请求转换为公共的 `permission-request` 或 `question-request` 事件，交给 DSH 原生审批/问题组件，再按 Provider 协议和原始请求 ID 回传。ACP 适配器接入标准 `session/request_permission` 与 `elicitation/create` form（表单式询问）；Grok Build 的 `grok_build/ask_user_question` tool_call 由 `_x.ai/ask_user_question` 私有 ext_method 回传 `outcome`；Codex app-server 启动时显式开启 `default_mode_request_user_input`，才会产生 `item/tool/requestUserInput` 请求。Command Code 的 `ask_user_question` 在 ACP 中也使用 `session/request_permission`，通过 `toolCall.kind=other` 和 `toolCall.rawInput.question/options` 区分问题。固定选项按原始 `optionId` 回传；自由文本通过 ACP 回包 `_meta["codingns/questionAnswer"]` 携带，并由只作用于子进程内存的 Node loader 接回 Command Code 工具结果，不修改用户安装包。URL elicitation（URL 询问）需要浏览器安全确认流程，当前不宣告该能力。Antigravity 仍只根据 DSH 权限状态下发 CLI 安全模式。

Command Code ACP 的模型、权限和思考强度通过 `session/set_model`、`session/set_mode` 和 `session/set_config_option` 在发送提问前设置；恢复会话同样重新应用当前选择。普通 CLI 启动参数不能代替 ACP 会话配置，设置失败时立即中止。订阅查询遵循 CLI 的凭据优先级：`COMMAND_CODE_API_KEY` 环境变量优先，其次是 `~/.commandcode/auth.json`，避免订阅卡片与实际请求使用不同账户。

---

## 功能详解

### 外部 Agent 集成

在选择器里挑选 Agent 与模型后，Codingns4DSH 以 DSH 子进程方式启动（或恢复）该 CLI，并把事件流投影成原生会话；模型与思考强度按 Agent 记忆。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/agent-picker.jpg" alt="工作区会话增强：Agent Logo、归档会话与工作区列表"></td>
      <td><img width="100%" src="assets/screenshots/model-picker.jpg" alt="Codex 的模型列表"></td>
    </tr>
  </table>
</div>

模型列表直接读取自各 CLI，可随时切换；按钮上还会显示当前模型与思考强度。

外部 Agent 自己组装请求，上下文面板的启发式构成与真实用量不同源；这些会话的面板只保留占用百分比与总量，不显示「系统 / 工具 / 消息」明细。

### 会话增强与订阅用量

会话行显示 Agent Logo 与归档入口，输入框下方显示可读取额度的 Agent 的订阅或上游用量（含缓存命中率、按模型统计与费用）。「显示订阅/用量检测」右侧的“设置”按钮可调整查询超时（默认 10 秒，作用于所有 Agent）与自动查询间隔（默认 5 分钟，0 表示不自动查询）；同一 Agent 在间隔内切回时复用上次结果，不重复请求上游。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/subscription-usage.jpg" alt="Codex 上游用量与费用统计"></td>
      <td><img width="100%" src="assets/screenshots/subscription-plan.jpg" alt="Codex 订阅额度与重置时间"></td>
    </tr>
  </table>
</div>

用量来自 Agent 自身的额度接口或已配置的上游用量来源；数据只在 Host 上读取，不写入浏览器存储。Codex 官方订阅的弹层还会显示「剩余点数」（credits 余额，保留两位小数）与「重置次数」（与重置图标按钮同行展示，含每张到期时间）；点击后经确认模态框消耗 1 次重置次数立即恢复当前用量窗口，整条链路走 codex app-server 官方协议，Host 不接触订阅凭据。

CodeBuddy 与 WorkBuddy 的 ACP `usage_update` 和本地会话用量已经接入；官方套餐 billing 仍由 Host 侧按认证域名读取，认证或接口不可用时安全返回空值。CodeBuddy CN 与国际版共用一个适配器，当前区域自动决定认证、模型目录和套餐来源，不会把另一地区账号的数据串过来。

### 工作区调试

每个工作区一份启动配置（`<工作区>/.codingns/debug.json`）：命令、工作目录、环境变量、Shell 与可选端口，可一键启动、检查端口、结束进程或停止。可选反向代理会把端口通过 DSH 暴露出来，目前仅支持 HTTP。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/workspace-debug.jpg" alt="工作区调试面板：启动配置、端口状态与代理"></td>
      <td><img width="100%" src="assets/screenshots/workspace-debug-edit.jpg" alt="工作区调试面板：编辑启动配置"></td>
    </tr>
  </table>
</div>

面板实时显示端口监听状态与 PID，并按实例生成不可猜测的代理地址。

### 终端日志分享

DSH `0.2.1-alpha.1` 下，点击右栏终端标签栏的分享按钮，直接打开当前工作区会话菜单。首项为“新建会话”，点击后在当前工作区创建新会话并加入日志引用卡片；下方排除未发送的草稿，按更新时间显示最近 5 个已有会话，可点击“更多会话”展开。选择已有会话即把最近最多 200 行输出作为日志引用卡片加入该会话草稿。也可以先选中终端文字，在浮动按钮中选择“复制”或“分享”：复制保留完整选区，分享同样打开会话菜单。引用卡片携带固定正文，随原生草稿保存，发送时展开；保留已有问题与附件，不自动发送。每次分享最多 200 行 / 32 KiB，选区截断会在菜单提示。详情见[实现记录](docs/开发记录/20261007-终端日志分享与会话引用实现记录.md)。

点击输入框中的终端日志卡片，可通过小型悬浮模态框查看已保存的日志正文。长日志和长行支持滚动，保留等宽排版；关闭按钮、Esc 或点击遮罩均可关闭预览。

### 终端工作区状态与切换

终端卡片的打开状态和最近选中的子终端标签按工作区共享：切换到同工作区其他会话时恢复同一卡片状态和子终端选择，刷新页面后也保留。关闭卡片会同步隐藏同工作区各会话的卡片，Host 终端继续运行；重新打开时恢复共享选择。原子终端被关闭时回退到列表首项，库存为空时清除选择并移除卡片；浏览器存储读写失败时保留当前页面的内存记录。详情见[修复记录](docs/开发记录/20261007-终端工作区共享选择与卡片状态修复记录.md)。

同一浏览器页面内，同工作区会话共用每个子终端的连接与 xterm 屏幕。切换会话、子终端标签或隐藏卡片只改变显示位置，保留缓冲区、光标和滚动位置，后台输出继续消费；真实断线和显式刷新仍可重新连接。Host 保存终端身份和运行状态，并维持常驻 tmux 连接；页面刷新后重新订阅这些连接恢复历史。详情见[常驻屏幕修复记录](docs/开发记录/20261007-终端跨会话常驻连接与屏幕复用修复记录.md)。

### Git 仓库管理

Git 面板通过 DSH 原生右侧 Sidebar 的标签页入口打开，按 Workspace 保存状态并跨会话复用。未初始化的目录可直接初始化仓库；已初始化的仓库支持查看暂存文件和未提交文件、暂存/取消暂存、丢弃更改、填写提交说明、切换分支和浏览提交历史。模块关闭后会移除右侧标签及对应 Host Git RPC，不影响其他模块。

移动触摸视口下，新建、切换会话与后台标签恢复都不会主动显示右侧面板；只有手动按钮、有效横滑或右栏快捷键才能呼出，切换会话后重新收起。详见[修复记录](docs/开发记录/20261007-移动端右栏仅手动呼出修复记录.md)。

右栏顶部标签在移动触摸视口下支持横向滚动，轻点仍可切换标签；鼠标和手写笔继续使用原生拖拽排序。详见[修复记录](docs/开发记录/20261007-移动端右栏标签触摸滚动修复记录.md)。

### 文件管理增强

文件管理增强把常用文件操作接入 DSH 原生文件侧栏：可以创建文件和目录、重命名、移动、复制、删除，并按代码与脚本类型选择编辑入口。操作会经过 Workspace 路径校验，拒绝越出当前工作区；模块关闭后清理对应的侧栏入口和 Host RPC。

### PeerHost 多 Host 工作区

PeerHost 是当前 Host 的代理能力，不会切换当前登录 Host。启用后可在管理面板添加局域网 PeerHost，Host 侧保存目标配置和登录态，Client 只提交 `targetHostId` 与完整 `HostScope`（`hostId`、`targetHostId`、`workspaceId`、`sessionId`、`scopeGeneration`）。工作区、会话、聊天输入、实时事件、文件、Git、终端和右侧工具都按作用域路由，单个 PeerHost 故障不会阻塞当前 Host 或其他 PeerHost。

模型目录跟随原生前台会话所属 Host；后台远端请求不会改变本机或其他 Host 的模型列表，切换 Host 时清空旧目录并重新加载。Desktop 根地址下的作用域修复与验证见[开发记录](docs/开发记录/20261007-PeerHost前台模型目录作用域隔离修复记录.md)。

外部适配器模型缓存也按会话所属 Host 隔离，同 Host 的会话继续复用；模型配置与右栏文件、终端请求始终按资源 ID 路由。相关回归见[兼容验证记录](docs/开发记录/20261007-PeerHost远程适配器模型与右栏兼容验证记录.md)。

当前已验证的路径包括固定握手、HTTP/WS 正向白名单、Host-to-Host 局域网 `/ws` connector、实时事件过滤、有限指数退避、generation 重建和脱敏诊断。DSH 原生导航或 conversation 容器未提供稳定扩展点时，界面会显示明确的 `degraded`/`unsupported` 状态，不创建 iframe，也不会把远端 Web Context 冒充成原生三栏聚合。

中转 PeerHost 仍保持 `relay_unavailable/degraded`：现有浏览器中转 ticket 和任意公网 URL 不能替代经过验证的 Host-to-Host JSON/WS Transport。当前 Host 的既有局域网访问、中转访问、登录和单 Host 会话语义不受 PeerHost 影响。

### 模块与设置

设置页按模块渲染卡片，开关、说明和「是否需要重启」都来自模块自身的描述；终端外观、局域网映射、登录保护、中转账号等都在对应卡片内配置。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/settings-overview.jpg" alt="设置 → Codingns4DSH 模块卡片"></td>
      <td><img width="100%" src="assets/screenshots/settings-modules.jpg" alt="全部模块开关"></td>
    </tr>
  </table>
</div>

### 登录保护

默认关闭，在卡片中开启后用统一的本地账号保护局域网**和**中继访问（默认会话超时 30 分钟）。认证发生在 Host 的转发边界，未登录请求不会到达 DSH Web；`127.0.0.1` 与 `::1` 永远放行，避免把自己锁在外面。

<div align="center">
  <img width="70%" src="assets/screenshots/login-protection.jpg" alt="本地账号登录页">
</div>

密码以 `scrypt` 哈希保存在 `0600` 文件中，浏览器只持有 `HttpOnly`、`SameSite=Strict` 会话 Cookie。

### 远程访问

| | 局域网访问 | 中转访问服务 |
| --- | --- | --- |
| 从哪里连接 | 同一局域网 | **任何设备、互联网上的任何位置** |
| 前提 | 同一网络 + 放行监听端口 | Host 能通过 HTTPS 访问 Control API；设备能连上 Codingns4DSH 入口 |
| 是否暴露本地端口 | 是——所选网卡/端口（默认 `13080`） | 否——独立设备隧道 |
| 账号 | 可选登录保护 | 需要 Codingns4DSH 账号并绑定 Host |

**局域网**：选择监听网卡与端口，自动探测（或手动填写）本机 DSH Web 端口，启动后在另一台设备打开 `http://<局域网 IP>:<端口>`；开启自动启动可恢复映射，模块还会补齐明文 HTTP 来源所需的 `crypto.randomUUID`。

**中转**：配置 Control API（默认 `https://channel.codingns.com:1443`，可在此注册账号），登录、刷新设备、绑定当前 Host（显示标签、公钥、指纹），之后在任意设备通过 **`https://dsh.codingns.com`** 打开已绑定的 Host——不需要公网 IP、端口映射或 VPN。

<div align="center">
  <table>
    <tr>
      <td><img width="100%" src="assets/screenshots/relay-service.jpg" alt="中转访问服务卡片"></td>
      <td><img width="100%" src="assets/screenshots/relay-h5-login.jpg" alt="H5 登录页选择 DSH Host"></td>
    </tr>
  </table>
</div>

DSH 设置按钮旁的账户入口会显示登录状态、访问路径与延迟、Host CPU/内存，并可一键注销登录。

<div align="center">
  <img width="70%" src="assets/screenshots/relay-status.jpg" alt="账户状态弹层：访问路径、延迟、CPU 与内存">
</div>

其中「访问」会标明当前是通过本机、局域网还是中转进入 DSH Web。

**为什么中转看不到你的 DSH 内容**——隧道端到端加密，使用它不等于把对话交给服务器：

- 载荷走在 **DSH Client 与 DSH Host 之间的 WebRTC DataChannel，由 DTLS 保护**；无论直连还是经 TURN，Relay 都只承载密文。
- Relay 与控制站只处理**控制面元数据**：账号/设备记录、Host 绑定、ticket、SDP/ICE 信令、在线状态、流量统计。
- 每个 Host 自持 DTLS 证书（`~/.config/codingns4dsh/dtls-identity.json`）并发布 SHA-256 指纹，远端在握手时核对；不一致直接中断（`Host DTLS fingerprint 校验失败`），不会接受被替换的证书；同一指纹显示在中转卡片中供人工比对。
- 密码只用于登录请求；refresh token 与设备凭据留在 Host。诊断日志只记录协议元数据（方向、类型、流 ID、状态、字节数），不记录正文、票据、Cookie 或 DSH Web 内容。

---

## 安装

**环境要求**：DSH `>=0.2.0-rc.2 <=0.2.1-alpha.1`（已验证 `0.2.1-alpha.1`）· Node.js `>= 22.19` · `PATH` 中有 `pnpm`（`dsh plugin` 转发给 pnpm）· 可选：Agent CLI，以及 macOS/Linux 上用于持久终端的 `tmux`（`brew install tmux` / `sudo apt install tmux`）。

### 最简单的安装方式：使用内置 `web` Profile

DSH 的 `web` Profile 会在首次使用时自动初始化，不需要手动创建配置文件，也不需要执行 `--dump-config`：

```bash
dsh plugin --profile web add @jingyi0605/codingns4dsh@0.2.1-beta.3
dsh web
```

### 可选：使用独立 Profile

如果不想修改内置的 `web` Profile，再创建一个独立 Profile。这里的 `--dump-config` 只用于初始化并检查 Profile，不是插件安装的必需步骤：

```bash
dsh codingns --from-default-profile web --dump-config
dsh plugin --profile codingns add @jingyi0605/codingns4dsh@0.2.1-beta.3
dsh codingns
```

- **不要**用 `dsh plugin --profile <新名字> add …` 创建需要 Web 界面的独立 Profile：该命令只会从 `@deepseek-ai/dsh-base` 初始化，之后会报 `entry "terminal-controller" not found`。需要独立 Profile 时，请使用上面的 `--from-default-profile web`。
- npm 返回 404 说明该版本还没发布，请改用下面的源码安装。

```bash
# 可选：验证安装结果
dsh plugin --profile web list --depth 0           # -> codingns4dsh <版本>

# 升级、固定版本、卸载（之后重启 DSH）
dsh plugin --profile web add @jingyi0605/codingns4dsh@<版本>
dsh plugin --profile web remove @jingyi0605/codingns4dsh
```

**从源码安装到 Stage0**（仅用于开发验证）：

```bash
git clone https://github.com/jingyi0605/Codingns4DSH.git && cd Codingns4DSH
pnpm install && pnpm build
DSH_STAGE0_HOME="$HOME/.dsh-stage0-020" pnpm dev:link stage0
pnpm dsh:stage0
```

源码链接只允许进入专用的 Stage0 Profile。不要对 Desktop Profile 执行
`dsh plugin ... add "$PWD"`，也不要把 `pnpm pack` 产生的 `.tgz` 安装到 Desktop；
这两种方式都会把开发中的代码带进桌面端。需要在临时目录回放安装包时，使用
`pnpm replay:dsh-install ./<包文件>.tgz`，脚本会创建一次性的 `DSH_HOME`，不会接触
`~/.dsh` 或 `~/.dsh-stage0-020`。

Desktop 只通过 GUI 插件页安装已发布的 registry 版本，并固定版本号；Desktop 的
`~/.dsh/profiles/desktop` 与 Stage0 的 `~/.dsh-stage0-020/profiles/stage0` 不共享
插件目录、设置目录、会话目录或开发链接。Stage0 普通启动会自动托管 `dev:watch`：
先等待 Host 和 Client 首次编译成功，再启动 DSH；此后 Host 产物使用原生 HMR
（热模块替换），Client 产物更新后浏览器自动整页刷新，避免终端重复注册。
关闭 Stage0 时会一并结束本次启动的编译监听及其派生进程。

**磁盘状态**：设置保存在 `$DSH_HOME/settings.yaml`（默认 `~/.dsh/settings.yaml`）的 `codingns:` 命名空间。

| 路径 | 内容 |
| --- | --- |
| `$DSH_HOME/profiles/<profile>` | 已安装的插件包与 `dsh.profile.bundles` |
| `$DSH_HOME/codingns4dsh/` | 终端 `host-id` 与 `terminals.json`（恢复映射） |
| `~/.config/codingns4dsh/` | 中转凭据、DTLS 身份、登录保护哈希 |
| `<工作区>/.codingns/debug.json` | 调试启动配置（`0600`，拒绝保存密钥） |

---

## 首次使用

1. `dsh codingns` 打开 DSH Web 界面。
2. 打开 **设置 → Codingns4DSH** 查看模块卡片（需重启的模块会同时显示当前生效状态与下次启动目标）。
3. 在 DSH **之外** 安装并登录 Agent CLI，确保命令在 Host 的 `PATH` 中，然后在 **外部Agent集成** 中启用。
4. 在输入框选择 Agent、模型和思考强度并发送消息——输出流式写入原生会话，并带 Agent Logo 出现在侧栏。
5. 右侧栏：终端面板为当前工作区开终端（要持久化请启用 **终端强化** 后重启）；**调试** 面板添加启动配置并查看端口。
6. 需要远程使用时，开启 **登录保护**、配置 **局域网访问DSH**，或登录 **中转访问服务** 从任意网络访问；账户入口会显示当前访问路径与 Host 负载。

---

## 故障排查

- **版本** —— `dsh --version`、`dsh plugin --profile web list --depth 0`（独立 Profile 请替换 `web`）、`npm view @jingyi0605/codingns4dsh version`；启动时会拒绝范围外的 DSH，安装期在能识别当前运行时版本时同样拒绝。
- **安装期被 `PATH` 上的旧 `dsh` 误判** —— 安装期只把宿主注入的版本、Desktop Runtime 根和 Profile 内可解析的 `@deepseek-ai/dsh` 当作阻断依据；`PATH` 上的 `dsh --version` 仅用于提示，不会阻断安装。运行期仍以实际加载的 DSH 为准。
- **`patch: entry "terminal-controller" not found`** —— Profile 缺少 Web 应用层，按上文用 `web` 模板重建。
- **检测不到 Agent** —— 在 Host 上执行 `<cli> --version`；确认其目录在启动 DSH 的进程的 `PATH` 中（图形启动器常不同）；用各家工具登录后重启 DSH。
- **终端** —— macOS/Linux 持久模式需要 `tmux`；启停模块与修改绑定范围需重启；终端按工作区寻址。
- **实时语音提示 `ReadableStream uploading is not supported`** —— 浏览器请求流上传兼容问题，源码已改用短批次 PCM 上传和独立事件下行；参见[修复记录](docs/开发记录/20261007-实时语音浏览器请求流上传兼容修复记录.md)。
- **语音流连接失败（HTTP 400）** —— DSH 原生 HTTP 桥给 streaming 路由的 GET 附加了正文，导致请求尚未进入语音处理器就被拒绝。源码已将事件 GET 拆至 `/events` 并登记为 buffered；需加载同时更新的 Host 和 Client 产物，参见[修复记录](docs/开发记录/20261007-实时语音浏览器请求流上传兼容修复记录.md)。
- **实时语音卡顿诊断** —— 专用 Stage0 加载新版 Host 和 Client 后，自动把采集、上传、识别、模型首字、ONNX 各图耗时、音频分块、播放断流和主线程阻塞写入本仓库 `data/logs/voice-performance-*.jsonl`。运行 `node scripts/analyze-voice-diagnostics.mjs` 汇总最近写入真实指标的运行，自动跳过自检；上传积压或超时也会记录中止原因和在途批次。参见[诊断记录](docs/开发记录/20261007-实时语音性能诊断日志实现记录.md)与[上传积压修复记录](docs/开发记录/20261007-语音上传积压与诊断文件选择修复记录.md)。
- **实时语音延迟与字幕** —— 通话开始异步预热 MOSS，模型累计文字通过现有下行连接推送，同一通话复用模型验证；有语音句尾等待默认 0.8 秒，可通过 `CODINGNS4DSH_VOICE_ENDPOINT_SILENCE_SECONDS=1.2` 恢复原等待。字幕显示完整当前回复并支持回看前文。参见[优化记录](docs/开发记录/20261007-实时语音预热推送与完整字幕优化记录.md)。
- **局域网** —— 确认卡片启动状态与访问地址、防火墙放行、两台设备同网络；多个 DSH 实例时手动选择探测到的端口；开启登录保护后需先登录。
- **中转** —— 检查 Control API 可达性，会话过期则重新登录，刷新设备后绑定 Host。
- **日志** —— 默认不输出调试日志；需要完整排查启动或 RPC 时使用 `CODINGNS4DSH_DEBUG=1 dsh --profile stage0 --no-open`。只查看警告和错误时使用 `CODINGNS4DSH_DEBUG_LEVEL=warn dsh --profile stage0 --no-open`，也可简写为 `CODINGNS4DSH_DEBUG=warn`。旧变量 `CODINGNS4DSH_TUNNEL_DEBUG=1` 仍兼容；pnpm 安装日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。
- **反馈** —— 附上 DSH 与 Codingns4DSH 版本、操作系统、涉及模块和完整错误：[GitHub Issues](https://github.com/jingyi0605/Codingns4DSH/issues) 或 QQ **1092985965**。

---

## 开发

需要 Node `>= 22.19` 与 pnpm：

```bash
pnpm install
pnpm build            # 版本校验 → tsc → Client + H5 Bundle
pnpm test             # 构建后运行完整测试（当前 901 个用例）
pnpm typecheck
pnpm run capability:check   # DSH 能力注册表退休检查
```

开发循环：首次执行 `DSH_STAGE0_HOME="$HOME/.dsh-stage0-020" pnpm dev:link stage0` 后，
只需运行 `dsh-stage0` 或 `pnpm run dsh:stage0`，保存源码后自动编译并重载。
如果已有单独的 `pnpm run dev:watch`，使用 `DSH_STAGE0_WATCH=0 dsh-stage0`，
避免重复启动编译器；此时仍保留自动重载，外部监听由原终端管理。
`--dump-config`、配置 Schema 查询、帮助与插件管理命令不会启动编译监听。
实现和验证见[Stage0 自动编译与热重载接入记录](docs/开发记录/20261007-Stage0自动编译与热重载接入记录.md)。
`pnpm dev:link stage0` 在未设置变量时也会默认使用专用 Stage0 HOME；若显式把
`DSH_HOME` 指向 `~/.dsh`，脚本会拒绝执行。版本源是 `version.json`
（`version:set-plugin` / `version:set-dsh`，由 `version:check` 守卫）。

目录：`src/host`（Host 层）、`src/client`（浏览器层）、`src/dsh-capabilities`（DSH 能力注册与版本路由）、`src/shared/contracts`、`src/transport`（隧道与 WebRTC）、`src/features`（模块注册表）、`tests/`、`specs/`、`docs/`、`data/build`（已忽略）。

推送 `v*` tag 触发 GitHub Actions（tag/版本校验、冻结安装、类型检查、测试、`npm pack`）并以 provenance 发布，预发布版本用 `next` dist-tag。当前发布还会执行 DSH 安装回放、运行时模块解析和 npm 产物逐文件校验。

截图素材与清单见 [assets/screenshots](assets/screenshots/README.md)。

**英文版：[README.en.md](README.en.md)**

---

## 鸣谢

Codingns4DSH 的项目灵感与部分实现思路来自 **[CodexHost](https://github.com/BytePioneer-AI/codex-host)**——它把 Pi、Claude Code、Grok Build 等 Harness 原生跑在 Codex Desktop 里，展示了 Codingns4DSH 从另一侧沿用的方向：**把其他 Harness 作为一等 Agent 接入**，而不是替换它们。多 Harness 适配器模型、把 CLI 事件流投影为宿主原生会话、让每个 Agent 的会话留在宿主侧栏与输入框，都源自该项目的设计。感谢其作者与社区。

Codingns4DSH 是独立项目，与 CodexHost 无隶属关系。

---

## 许可证

本项目以 **GNU 通用公共许可证第 3 版或更高版本**发布（SPDX：`GPL-3.0-or-later`），完整条款见 [LICENSE](LICENSE)，`package.json` 中的 `license` 字段与之保持一致。

Copyright (C) 2026 jingyi0605

你可以在许可证允许的范围内自由使用、修改和分发本项目；分发衍生作品时须同样以 GPL 授权、附上完整源码并保留版权声明，且本项目不提供任何担保。

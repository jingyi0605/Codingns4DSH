# 兼容形象包目录

核验日期：2026-10-07。本目录收录 **12 个**可通过 CodingNS 统一适配器安装的形象包，包含 **7 个 Live2D（二维角色动画）模型和 5 个精灵图动作包**。

本仓库保存目录与安装清单；目录 JSON 和安装清单元数据随 npm 包提供，第三方美术素材从上游按需下载，不镜像美术文件或随包预装。新配置提供 **鱼妞／鱼仔** 两款基本形象，默认选择鱼妞，另保留用户已安装的形象。

本目录中的大肥鱼及其他角色均为 **外部依赖**。Live2D 还需要 `l2d@2.1.1` 引擎：首次选择 Live2D 形象时确认当前版引擎许可后，Host 会从固定 npm 地址下载该精确版本、校验摘要并安装到 CodingNS 自有目录；插件不预置引擎及第三方宠物插件代码，未确认许可前不下载。形象安装只下载所选包的素材，未安装引擎也可先用男女基本形象完成助理创建。

## 安装方式

1. 创建助理后，在 **全局智能助理 → 配置 → 形象管理 → 第三方形象** 阅读使用说明，勾选同意并开启第三方列表。
2. 选择形象后查看静态预览、作者、许可、备注和预计下载大小；此时不下载完整模型或动作图集。
3. 单独确认该形象的素材许可，点击「确认下载并使用」。安装成功后登记进「当前形象」列表，悬浮与对话共用；也可以切换回其他已安装形象。
4. 关闭第三方列表不会删除已安装素材；重新开启需同意说明。已同意且未关闭时，刷新保留协议状态；说明版本更新后重新确认。

手工安装入口继续支持仓库和其他 URL：复制下表「安装清单」链接地址，在 **安装形象包** 粘贴 URL，自动识别、查找候选后安装。该方式保留旧接口的兼容性，用户仍须自行核对素材许可。

「安装清单」由本仓库补充显示名称、素材作者和许可链接，素材 URL 固定到上游提交。这里仅转换清单，不改绘素材。「上游清单」也可直接安装，但部分上游文件未声明作者和许可，管理界面会显示「未声明」。请保留本表的署名与权利说明。

## 形象包列表

| 序号 | 名称 | 仓库地址 | 作者 | 简介 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | 大肥鱼 · Live2D 桌前 | [A8Chann/dsh-pet-live2d][repo-ds-whale-live2d] | 原作：上善无形；女仆设计：ZipZipPipe；Live2D：氵六青；插件：A8Chann | 蓝发女仆鲸鱼娘，带桌前道具、表情和动作。 | [安装清单][install-ds-whale-live2d] · [上游清单][source-ds-whale-live2d] · [素材许可][license-ds-whale-live2d]。CC BY-NC-SA 4.0；需署名三位素材作者。只适配模型与动作，不包含原插件的换装和喂食界面。 |
| 2 | 大肥鱼 · Q版全身 | [YunYueSama/codex-deepseek-pet][repo-ds-whale-sprite] | 新增创作：YunYueSama；底层社区角色与参考作品作者见上游权利说明 | 全身蓝发鲸鱼娘动作图集，适合轻量悬浮展示。 | [安装清单][install-ds-whale-sprite] · [上游清单][source-ds-whale-sprite] · [素材许可][license-ds-whale-sprite]。自定义署名许可仅覆盖作者有权授权的贡献；底层角色与参考作品权利尚需确认，不视为完整商业授权。 |
| 3 | 娜斯佳 Nastya | [Signalight/codex-to-dsh-pet][repo-nastya] | Signalight | 红瞳 Q 版学者，是轻量 DSH 精灵图插件的原创示例角色。 | [安装清单][install-nastya] · [上游清单][source-nastya] · [素材许可][license-nastya]。Codex v2；素材 CC BY-NC 4.0，需署名、非商业使用；插件代码的 MIT 不适用于图集。 |
| 4 | 小满 | [YaKun9/codex-pets][repo-xiaoman] | YaKun9 | 暖金毛色、红项圈的原创中华田园犬伙伴。 | [安装清单][install-xiaoman] · [上游清单][source-xiaoman] · [素材许可][license-xiaoman]。Codex v2；CC BY-NC-SA 4.0；原创动物角色，需署名、非商业使用、改编同许可。 |
| 5 | Scout · 水彩柯基 | [YaKun9/codex-pets][repo-scout-corgi] | FunShow（@fanslead） | 背着青绿背包、挂着相机的水彩柯基探险家。 | [安装清单][install-scout-corgi] · [上游清单][source-scout-corgi] · [素材许可][license-scout-corgi]。Codex v2；CC BY-NC-SA 4.0；AI 辅助原创，作者是 FunShow，仓库维护者不是素材作者。 |
| 6 | 布布 · 编程熊 | [YaKun9/codex-pets][repo-bubu-codebrew-bear] | xxhh0822（@xxhh0822） | 使用笔记本电脑、身边放着咖啡杯的棕色编程熊。 | [安装清单][install-bubu-codebrew-bear] · [上游清单][source-bubu-codebrew-bear] · [素材许可][license-bubu-codebrew-bear]。Codex v2；CC BY-NC-SA 4.0；AI 辅助原创，适合桌前构图。 |
| 7 | Haru | [Live2D/CubismWebSamples][repo-live2d-haru] | Live2D Inc.（官方角色与模型） | 官方女性角色样例，包含表情和身体动作。 | [安装清单][install-live2d-haru] · [上游清单][source-live2d-haru] · [素材许可][license-live2d-haru]。Cubism 3 清单；保留官方署名；遵守无偿素材许可和角色条件；附带声音不纳入播放。 素材不可当作 MIT 或随 npm 再分发。 |
| 8 | Hiyori Momose | [Live2D/CubismWebSamples][repo-live2d-hiyori] | Live2D Inc.（官方角色与模型） | 官方女性角色样例，适合人物与物理摆动展示。 | [安装清单][install-live2d-hiyori] · [上游清单][source-live2d-hiyori] · [素材许可][license-live2d-hiyori]。Cubism 3 清单；角色设计不得修改；保留官方署名，遵守无偿素材许可。 素材不可当作 MIT 或随 npm 再分发。 |
| 9 | Mao Niziiro | [Live2D/CubismWebSamples][repo-live2d-mao] | Live2D Inc.（官方角色与模型） | 官方猫耳女性角色样例，带表情和动作。 | [安装清单][install-live2d-mao] · [上游清单][source-live2d-mao] · [素材许可][license-live2d-mao]。Cubism 3 清单；保留官方署名；遵守无偿素材许可和角色条件。 素材不可当作 MIT 或随 npm 再分发。 |
| 10 | Mark-kun | [Live2D/CubismWebSamples][repo-live2d-mark] | Live2D Inc.（官方角色与模型） | 官方卡通男性角色样例，适合简洁的角色展示。 | [安装清单][install-live2d-mark] · [上游清单][source-live2d-mark] · [素材许可][license-live2d-mark]。Cubism 3 清单；须保持卡通人物性质，不可改绘为写实或美型男子；保留官方署名。 素材不可当作 MIT 或随 npm 再分发。 |
| 11 | Rice Glassfield | [Live2D/CubismWebSamples][repo-live2d-rice] | Live2D Inc.（官方角色与模型） | 官方女性角色样例，可用于人物动作展示。 | [安装清单][install-live2d-rice] · [上游清单][source-live2d-rice] · [素材许可][license-live2d-rice]。Cubism 3 清单；保留官方署名；遵守无偿素材许可和角色条件。 素材不可当作 MIT 或随 npm 再分发。 |
| 12 | Wankoromochi · 年糕犬 | [Live2D/CubismWebSamples][repo-live2d-wanko] | Live2D Inc.（官方角色与模型） | 官方年糕主题犬形角色，适合宠物悬浮展示。 | [安装清单][install-live2d-wanko] · [上游清单][source-live2d-wanko] · [素材许可][license-live2d-wanko]。Cubism 3 清单；须尊重年糕主题；保留官方署名，遵守无偿素材许可。 素材不可当作 MIT 或随 npm 再分发。 |

## 兼容与许可边界

- 已用当前源码安装器实际下载全部 12 个包的完整依赖，共 **161 个文件、32,687,876 字节**；验证包含模型、贴图、物理、姿势、动作、表情、显示信息及清单引用的音频。验证素材只存于独立临时目录，未放进源码或用户 Profile。
- 已在独立无头浏览器中逐个验证：7 个 Live2D 模型均触发真实加载完成并产生有效像素，5 个精灵图均为 1536×2288 的 v2 图集且首帧有效。12 项均无脚本错误，读取本地安装资源时无外网请求；这不等同于用户运行环境或所有动作的逐项验收。
- 一个素材配置可用于两个展示插槽，但全身、半身或桌前构图由模型本身决定。本目录不承诺原插件的换装、喂食、语音、声音播放和桌面窗口功能。
- 官方 Live2D 角色须同时遵守[无偿提供素材使用授权协议][live2d-license]和[角色个别条件][live2d-terms]，保留版权声明；不同使用主体和用途的许可范围不同，不能仅凭「免费样例」判断商业用途。角色音频不纳入本目录的播放用途。SDK（软件开发工具包）运行库的许可与角色素材许可分开，见[官方 SDK 许可说明][live2d-sdk-license]。
- 大肥鱼 Live2D 与三只原创动物采用 CC BY-NC-SA 4.0（署名、非商业、相同方式共享）；娜斯佳采用 CC BY-NC 4.0（署名、非商业）。大肥鱼精灵图的自定义许可仅覆盖作者有权授权的贡献，底层社区参考权利仍需确认。各项备注以对应固定版本的素材许可为依据。
- 仅收录可解析、可下载完整依赖且有可追溯权利说明的条目；这份目录提供技术兼容信息，不替代素材许可。尚未逐项明确许可的集合（例如 [Codpet 的素材政策][codpet-policy]）不列入推荐安装清单。

## 目录维护

机器索引：[catalog.json](../avatar-packages/catalog.json)；统一安装清单：[manifests](../avatar-packages/manifests)。

新增条目时，在机器索引末尾追加序号，补齐名称、仓库地址、真实素材作者、简介、备注、许可与固定提交；创建 CodingNS 原生清单并同步本表。素材许可不能用插件代码许可替代。更新上游版本后重新检查全部依赖和渲染效果，保持形象 ID 稳定。

本目录及安装清单在推送到本仓库 GitHub 的 `main` 分支后可在线访问；本地修改未推送时，先使用表内「上游清单」。

[repo-ds-whale-live2d]: https://github.com/A8Chann/dsh-pet-live2d
[install-ds-whale-live2d]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/ds-whale-live2d.avatar.json
[source-ds-whale-live2d]: https://raw.githubusercontent.com/A8Chann/dsh-pet-live2d/185c02bfbb3b886e1a236b5c2ec035cc085b9ca2/dsh-live2d-pet/pets/ds-whale-girl/pet.json
[license-ds-whale-live2d]: https://github.com/A8Chann/dsh-pet-live2d/blob/185c02bfbb3b886e1a236b5c2ec035cc085b9ca2/NOTICE.md
[repo-ds-whale-sprite]: https://github.com/YunYueSama/codex-deepseek-pet
[install-ds-whale-sprite]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/ds-whale-sprite.avatar.json
[source-ds-whale-sprite]: https://raw.githubusercontent.com/YunYueSama/codex-deepseek-pet/7661c8b304c5400701f91da01b1a643a207331de/codex-deepseek-pet/pet.json
[license-ds-whale-sprite]: https://github.com/YunYueSama/codex-deepseek-pet/blob/7661c8b304c5400701f91da01b1a643a207331de/ASSET_LICENSE.md
[repo-nastya]: https://github.com/Signalight/codex-to-dsh-pet
[install-nastya]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/nastya.avatar.json
[source-nastya]: https://raw.githubusercontent.com/Signalight/codex-to-dsh-pet/ca3833893b46ce0c4528c720f3ec772e7b1cbaec/packages/dsh-codex-pet/assets/nastya/pet.json
[license-nastya]: https://github.com/Signalight/codex-to-dsh-pet/blob/ca3833893b46ce0c4528c720f3ec772e7b1cbaec/LEGAL.md
[repo-xiaoman]: https://github.com/YaKun9/codex-pets
[install-xiaoman]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/xiaoman.avatar.json
[source-xiaoman]: https://raw.githubusercontent.com/YaKun9/codex-pets/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-xiaoman/pet.json
[license-xiaoman]: https://github.com/YaKun9/codex-pets/blob/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-xiaoman/LICENSE.md
[repo-scout-corgi]: https://github.com/YaKun9/codex-pets
[install-scout-corgi]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/scout-corgi.avatar.json
[source-scout-corgi]: https://raw.githubusercontent.com/YaKun9/codex-pets/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-scout-corgi/pet.json
[license-scout-corgi]: https://github.com/YaKun9/codex-pets/blob/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-scout-corgi/LICENSE.md
[repo-bubu-codebrew-bear]: https://github.com/YaKun9/codex-pets
[install-bubu-codebrew-bear]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/bubu-codebrew-bear.avatar.json
[source-bubu-codebrew-bear]: https://raw.githubusercontent.com/YaKun9/codex-pets/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-bubu-codebrew-bear/pet.json
[license-bubu-codebrew-bear]: https://github.com/YaKun9/codex-pets/blob/5de75e244de7d4f74d35ea14f226f583b986d7d3/original-bubu-codebrew-bear/LICENSE.md
[repo-live2d-haru]: https://github.com/Live2D/CubismWebSamples
[install-live2d-haru]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-haru.avatar.json
[source-live2d-haru]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Haru/Haru.model3.json
[license-live2d-haru]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[repo-live2d-hiyori]: https://github.com/Live2D/CubismWebSamples
[install-live2d-hiyori]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-hiyori.avatar.json
[source-live2d-hiyori]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Hiyori/Hiyori.model3.json
[license-live2d-hiyori]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[repo-live2d-mao]: https://github.com/Live2D/CubismWebSamples
[install-live2d-mao]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-mao.avatar.json
[source-live2d-mao]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Mao/Mao.model3.json
[license-live2d-mao]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[repo-live2d-mark]: https://github.com/Live2D/CubismWebSamples
[install-live2d-mark]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-mark.avatar.json
[source-live2d-mark]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Mark/Mark.model3.json
[license-live2d-mark]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[repo-live2d-rice]: https://github.com/Live2D/CubismWebSamples
[install-live2d-rice]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-rice.avatar.json
[source-live2d-rice]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Rice/Rice.model3.json
[license-live2d-rice]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[repo-live2d-wanko]: https://github.com/Live2D/CubismWebSamples
[install-live2d-wanko]: https://raw.githubusercontent.com/jingyi0605/Codingns4DSH/main/avatar-packages/manifests/live2d-wanko.avatar.json
[source-live2d-wanko]: https://raw.githubusercontent.com/Live2D/CubismWebSamples/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/Samples/Resources/Wanko/Wanko.model3.json
[license-live2d-wanko]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md

[live2d-license]: https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html
[live2d-terms]: https://www.live2d.com/eula/live2d-sample-model-terms_en.html
[live2d-sdk-license]: https://github.com/Live2D/CubismWebSamples/blob/b1de66b0b1f1cb881d95fb6158622aeb6a2827bd/LICENSE.md
[codpet-policy]: https://github.com/0xpipilu/codpet/blob/f62f3c89c22effe2f1ebcff041fa6243fe5b057d/docs/asset-policy.md

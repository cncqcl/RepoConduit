# 验收、真实接入与完成规则 v0.2

**当前证据边界：**不同版本的离线和真实组件记录不能拼成统一版本的完整发布通过；失败、跳过和 UNKNOWN 保留，见[验证状态](release-evidence.md)。下述 AC/LIVE 条件保持不变。

D240日常入口另需验证一次安装连接接入两个新项目、同项目网页独立新题，
用户不手填JSON/内部ID/专用脚本；项目分享范围显式更新与撤权生效，旧题基线
不改。文件交付不依赖完整聊天历史，区分程序原件、平台实际引用及手工导入；
正常网络、纯GET瞬时恢复和最终下载回退分别取证。SDK/无网络dry-run、恢复
预检、实际backup/restore及真实ChatGPT不能互相替代，旧包/旧失败保持绑定。

2026-10-22用户调整当前交付优先级：先完成Codex＋ChatGPT个人自用闭环，
Claude/GLM及NEUTRAL01后置。首组合的实际使用验证不等待第二runtime；完整
release_ready和历史各包状态不改写。本轮复用已通过组件，优先验证网页讨论
回本地同步、正式审查决定及独立的本地用户实施授权，不重复调查/离线套件。

本文件与 DESIGN.md 的 AC01–AC14 同步。它是验收规范；已有离线、安装包及真实组件记录各自绑定版本与环境，见[验证状态](release-evidence.md)。2026-10-24 的本人接管及安装版恢复是有范围的历史组件证据；统一版本完整 LIVE01–03 和完整中立性发布仍未通过。`contracts/acceptance-matrix.json` 给出需求/任务映射；不得从离线测试或跨包组件推断统一 live 通过。完整发布必须满足下列验收条件。

## 1. 四种里程碑声明不能混用

| 声明 | 可以证明什么 | 不可以声称什么 |
|---|---|---|
| handoff_validated | 本设计/配置包的格式、映射和文件完整性通过检查 | 产品已实现，模型在用户客户端已加载 |
| core_verified | 当前commit的离线单元/合约/集成/故障/权限边界适用测试通过 | ChatGPT账号、网页人工恢复或完整附件实际可用 |
| flagship_live_verified | 特定账号/客户端/OS/版本下，LIVE01–03的所有适用真实条件得到证据 | 其他平台、其他账号、所有模型天然兼容 |
| release_ready | 离线+旗舰live+实际安装恢复+第二runtime及其余发布条件均通过 | 永不出错、任意仓库语义理解绝对正确 |

原始完整第一版 Goal 的目标为 release_ready。用户已将本会话明确调整为 D240 日常范围，完成情况按其真实 route 和回执记录；完整第一版状态仍保留。manual-only/unsupported/blocked 不能自行视为完整发布的等价达成；受限范围需记录用户的范围调整、未满足项和实际 route，不能用改需求清单的方式掩盖缺口。

## 2. 真实测试的准备与权限

先使用两个专门创建、无秘密的合成 Git fixture：项目A含入口→调度→状态→持久化→取消分支及测试；项目B含不同唯一标记。至少一个源码文件超过默认读取页，包含一个可定位的关键函数；另准备超长单行和UTF-8边界。已知答案写入独立oracle文件，由验证器保存，不混进外部咨询prompt。

只在用户同意的账号与工作区内使用必要资料。不要默认把用户已有私有仓库发送给模型。开启调查/外部工具/文件提交时记录grant、audience、范围和预算；真实会话登录、2FA、CAPTCHA、consent及人工接管必须由用户完成，不能用自动化代替后写human_verified。

先记录：client/runtime/adapter versions、模型实际观察方式、账号非敏感标识、OS、repo commit/build、操作权限、自动收取route、工具和文件类型能力。缺失条件产生具体 blocker，继续其他可执行验证。

命令由M01及后续任务实际实现；本文不伪造目前可用的产品CLI。产品live runner应输出case ID、事件路径、native IDs的脱敏引用和进程退出码，不能只在末尾写字符串PASS。

## 3. 每份执行证据的最低格式

使用 `verification/evidence-record.schema.json` 记录：case/run/attempt、测试层、起止时间、执行者、commit/build、实际命令与cwd、退出码、runtime能力、观察断言、日志/文件清单引用和阻塞。主体姓名、绝对私有路径和远端ID可在private日志保留，公开报告用稳定脱敏映射。

执行收据与汇总审查收据使用同一 v0.2 必填元数据；审查不能替代所要求的真实执行层。
用途采用封闭名称并由发布验证器逐项绑定：

| 收据用途 | case_id | layer |
|---|---|---|
| AC、LIVE、第二 runtime、安装包执行 | 对应 AC01–14 / LIVE01–03 / NEUTRAL01 / PACKAGE01 | 对应实际执行层 |
| 三项发布阶段汇总 | stage:core_verified / stage:flagship_live_verified / stage:release_ready | review |
| 离线命令（缺省11项或下述single_run五项） | offline:加实际命令名（如 offline:test） | offline_command |
| 许可、秘密扫描、关键缺陷、能力报告、模型加载审查 | release:license_review / release:secret_scan / release:safety_defects / release:capability_report / release:model_loading | review |

每份收据必须包含 schema_version、非空 run_id、合法 case_id/layer 和原有绑定、观察、引用字段；未知顶层字段拒绝。
离线命令还须匹配实际 `npm run <命令名>`。等价有界命令应保存准确 argv，不能改写为未执行的命令来满足门禁。
纯 review 只引用底层执行证据，不产生 live 或 actual_human_performed 的事实。
能力条目可以复用对应的实际 AC/LIVE/NEUTRAL 收据，不必另造模型自证。

**测试去重兼容（D239，v0.2的可选汇总模式）：**
`release_evidence.offline_test_mode`缺省保持既有11条命令要求；唯一可显式
指定的值为`single_run`。该模式要求`typecheck`、`lint`、`test`、`build`、
`package:smoke`五条真实命令回执。`npm run test`保留全集目录glob、文件并发2；
验证器核对它和六个已知子集脚本的精确范围，不允许收窄、名称过滤、额外
命令或未知包装器。缺少全集回执不能由六份子集回执替代。没有执行的子集
不创建通过回执；若声明了子集条目，仍按原规则校验其状态、case、layer、
实际命令、source/build和原始引用。未知模式或显式null拒绝。

单次执行仍为`offline:test/offline_command`，不新增回执字段或case，也不
改写历史回执。全集入口拒绝已知`RCAC_CRASH_PHASE`诊断范围过滤；该变量
可继续用于直接定向诊断。该模式不是费用/原生执行授权，`offline_command`
仅是回执层名：全集包括条件原生与容器测试，运行前仍按实际资源、预计
时长/数量及当前授权处理。条件skip不得转为相关AC/LIVE通过；原始日志
必须支持所引用的实际覆盖，不能仅凭脚本glob推定执行成功。

安装包执行的三个通过用途（`PACKAGE01/package_smoke`、
`offline:package:smoke/offline_command`、`AC14/package_smoke`）还必须包含
`package_artifact`（仅 `archive_ref`、`sha256`、`integrity`）与
`package_smoke_output_ref`。它们必须匹配验收文件唯一声明的
`release_artifact`、保留的实际 tgz 字节，以及原始 smoke 输出中唯一的通过
结果。输出引用也必须列入 `evidence_refs`。三份用途收据可以复用同一次
实际安装测试和同一个保留包，无需重复安装。包要求非空且不超过 32 MiB；
SHA-256 与 SHA-512 SRI 由验证器重算。v0.2 旧包收据若没有这些字段，不能
证明待发布包；尚未选定最终包时 `release_artifact` 保持 null。

实际保留包的命令为 `npm run package:smoke -- --retain-archive <绝对新文件路径>`。
父目录必须已存在且无路径链接；目标必须不存在，不会覆盖旧包。测试完成并
确认子进程退出后才输出通过结果。仅核对哈希不能代替真实执行记录。

外部回答自称已调用工具不是tool receipt；本地代码实际记录才是。外部/调查模型输出不能直接把runtime验收JSON设成passed，runner和本地reviewer要检查文件与事件。

所有引用必须可追溯到实际存储的内容。文件hash由程序计算，不让模型填写想象的哈希。语义发现与执行观测分开；captured和user_confirmed分开；未做的事写not_run。

LIVE01/02 的通过回执还需 `bundle_deliveries`：LIVE01 精确记录 `v1`、`v2`，LIVE02 精确记录 `independent`。每项保存已发布 manifest 的仓内证据路径、原始 manifest SHA-256，以及与 manifest 文件集合一一对应的原始字节证据路径。归档时由 runner 从产品已发布对象和工具回执提取，不让外部模型填写来源；`verify:release` 重算每个文件的大小与哈希，核对 context/snapshot、声明文件集合、可移植路径结构、自动来源、v2 父版本与跨项目范围。LIVE01 v1 的二进制/ZIP 必须确实来自自动文件路线；LIVE02 的文件不能替它满足此要求。`route` 摘要与能力报告不能代替这些逐文件证据。

## 4. AC覆盖矩阵

| ID | 场景 | 必须验证的层 | 主实现任务 |
|---|---|---|---|
| AC01 | 本地发起、多轮查证与人类参与 | contracts, integration, mock_e2e, live | T01.1, T03.2, T04.1, T04.2, T04.3, T06.1, T08.1 |
| AC02 | 网页接管、宿主结束回合、之后恢复 | integration, mock_e2e, live_human | T03.1, T03.3, T04.3, T06.1, T08.1 |
| AC03 | 外部独立发起 | contracts, integration, mock_e2e, live | T01.1, T03.1, T05.1, T06.1, T08.1 |
| AC04 | 同项目多咨询、不同项目并发 | contracts, integration, faults, live | T01.1, T01.2, T01.3, T03.1, T03.3, T04.1, T07.1 |
| AC05 | 基线变更与证据过时 | contracts, integration, faults, live | T02.1, T05.3, T07.1 |
| AC06 | 大文件、分页和不完整检索 | contracts, integration, security | T02.2, T07.1 |
| AC07 | 完整多文件bundle与版本更新 | contracts, integration, faults, live | T05.1, T05.2, T05.3, T08.1 |
| AC08 | 交付中断与恶意内容 | contracts, integration, security, faults | T05.1, T05.2, T05.3, T07.1 |
| AC09 | 调查注入与权限升级 | contracts, integration, security, live_runtime | T01.2, T02.1, T04.1, T04.2, T07.1 |
| AC10 | 未知发送、worker崩溃与取消 | contracts, integration, faults, live_runtime | T01.3, T03.2, T04.1, T04.3, T07.1 |
| AC11 | 替换agent／协议而不修改核心 | contracts, boundary, real_second_runtime | T01.1, T07.2 |
| AC12 | 能力撤销、平台受限与数据再披露 | contracts, integration, security, live | T01.2, T03.2, T05.2, T06.2, T07.1 |
| AC13 | 上下文换聊与本地成果决策 | contracts, integration, mock_e2e, live | T03.1, T03.3, T05.3, T08.1 |
| AC14 | 服务重启与文件／数据库发布一致性 | contracts, integration, faults, package_smoke | T01.3, T05.3, T06.2, T07.1 |


不是所有AC都需要昂贵的真实外部模型运行。确定性的路径/权限/数据库崩溃以离线或真实进程测试覆盖；模型/账号/网页/原始附件/人工操作的事实必须live。离线通过永远不自动填满同一AC的live字段。

## 5. LIVE01：从本地发起到人工切换、调查、bundle与决策

**映射：** AC01/02/05/07/13。**目标：** 首要纵向闭环，不可缩减成一次问答。

1. 从安装后的产品启动fixture A，固定S1，创建Collaboration C1和ContextRevision V1；记录预授权参与者与调查预算。确认主host与managed investigator是独立执行上下文。
2. 本地Codex通过产品Skill/CLI创建或绑定准确的ChatGPT会话。记录消息发送意图、native关联和完成证据，保存完整问题及外部回答；不靠页面静止判断。
3. 让ChatGPT自主读至少三个相关模块，继续读取跨页关键函数。检查工具回执引用S1且未泄露B。
4. ChatGPT提交第一次调查：追踪正常状态流程。Codex investigator实际执行受限调查，输出路径、符号、片段、hash、覆盖和未知项；外部方能够核对原文件。
5. ChatGPT根据结果发起第二次调查：取消与持久化竞态。调查必须沿C1、S1和当前背景续接；不通过主host空等链阻塞。实际执行证据与模型总结分开。
6. 用户在本地追加一个约束，形成V2并发送同一Chat。确认外部方不会把已否决方案当作新指令。
7. 用户明确接管，在网页亲自追加至少三轮有效讨论；主host回合结束。记录操作人及观测证据；managed investigator与repo访问继续可用，自动sender无越权发言。没有真实人操作就保持本步骤not_run。
8. 回到本地，先同步网页新消息、当前生成状态、账号/聊天身份和control epoch，再提出新问题。检测到修改历史或错绑时进入reconcile_required而不抢发。
9. 外部交付bundle v1：Markdown/HTML/JSON及至少一份真实生成/上传的二进制或ZIP，含子目录。使用已验证自动route；保存原始字节和实际清单。外部没有提供预期清单时只声明receiver_observed集合完整。
10. 继续同一议题，交付v2，检查v1不可变、parent引用明确、咨询仍open；无脚本/规则自动执行。
11. 本地开发fixture形成S2。Codex读取v2，先发现与S1的相关差异，再记录接受/修改/拒绝项。允许实际结论为拒绝；框架正确性不要求模型一定同意。
12. 核对源码写入者：测试过程中只有本地验证器按步骤创建S2，外部请求与investigator没有修改源。保存manifest、事件、模型观察证据和本地DecisionRecord。

**通过条件：** 以上实际步骤均有证据。任何模型回复、role自称、mock transcript或手册都不能替代真正工具、调查、人工和文件记录。

## 6. LIVE02：网页独立发起与完整成果回收

**映射：** AC03/07/12。开始时不保留活动的本地host task。

1. 仅启用同一安装级连接与本地协调服务，确认项目B的明确授权和用户批准的managed investigator。D240按项目分别鉴权，不要求为B新建连接、手填内部ID或专用脚本；也不以共享连接推导其他项目权限。
2. 用户在ChatGPT网页进入已验证的工具环境，创建新议题C2，读取B的原始代码与说明。不能以A的chat或全局last_workspace代替明确绑定。
3. 对一个需要查证的问题提交受限调查；外部不能指定任意命令/模型/根目录，实际profile来自本地策略。
4. 形成完整bundle并交付，检查它只写收件区。接受文本文件集合与原始文件引用；没有文件引用能力时明确走已授权collector，而非重写原文件。
5. 本地Codex之后启动，列出自己的C2成果、核查文件和基线；只有用户要求才审查/晋升，不能因收件自动开始开发。
6. 测试写权限不可用：显示unsupported，不伪装readOnly；记录明确的降级或用户动作。此受限分支验证通过，不表示步骤4的原生直写已经通过。

**交付route记录：** `native_file_reference`、`text_set_mcp`、`authorized_local_collector`、`manual_import` 分开。全功能Goal要求至少一种真实自动多文件/二进制回收路径，另有手动导入保底；所有 advertised routes 单独验证。若用户仅允许manual方案，记录明确范围变更而非自行改验收。

## 7. LIVE03：多项目并发、真实隔离与恢复

**D239验收范围：**个人自用环境，信任用户选择的runtime/OS；验证本产品
实际路径的范围拒绝、只读、取消和恢复。允许复用原生权限/沙箱及已有适用
证据，不要求另行认证自建bwrap、每个FD/namespace或自然EOF。合成负向
用例集中到实际调查路径，不作为逐项审批的独立诊断链；不能以模型口头
拒绝替代真实控制，也不宣称恶意同用户进程或多租户安全已验证。

**映射：** AC04/09/10/12。优先用合成仓与受控错误，避免破坏真实账号或项目。

- 同一外部账号中A两个议题、B一个议题并行。验证消息/对象权限/调查/成果和lease。native聊天不能跨工作区重用。
- 对实际investigator发起越权读取、源码写入、无授权联网和递归咨询要求，用合成canary证明执行层拦截，而非模型口头拒绝。禁止将真实用户凭据用于负向测试。
- 对本地拥有的调查进程执行取消/故障注入，验证终止回执或recovery_required。不得杀死用户其他Codex/Chrome进程。
- 撤销grant并检查新请求及在途结果披露。切换账号必须使原能力证据失效；不能静默沿用旧句柄。
- unknown send 使用专门的无害请求和可注入传输故障；先检查已接受消息，不以再次发送作为默认修复。

结构性竞态可在离线fixture反复验证，实际账号上保留一条最小代表性证据。不反复大量发送来充当压力测试。

## 8. NEUTRAL01：第二真实local runtime

使用同一个合成snapshot、InvestigationRequest、grant与EvidenceRecord合约，接入另一种已经安装且获授权的coding runtime。它必须在真实进程/SDK路径上完成至少一次只读调查，并给出实际权限/工具回执；换一个Codex模型不算第二runtime。

核心对象与handler不允许出现第二套provider分支。不同external协议可以先以测试适配器验证语义差异；没有真实外部适配器验收，不能宣传该产品已支持。

缺少第二runtime账号时标blocked，继续旗舰与离线工作；不能把fixture写成real_second_runtime=true。完整release仍保留该关卡；用户可明确批准另一个受限发布范围，但必须说明未覆盖。

## 9. 安装与恢复验收

D240日常使用目标按现有AC01/03/04/07/08/10/12/14验证：同一安装/连接在
启动后接入两个新项目与同项目两题，用户不写JSON、内部ID或专用脚本；重启
可列举/继续正确议题，权限撤销后不再可读。正常文本与原文件版本交付独立于
聊天历史读取；大于10版的收件仍可发现，手工下载回退保留子目录/同basename
原件路径和字节，旧失败/unknown不消失。网络fixture验证瞬时重试与安全拒绝，
真实平台/原件/安装事实仍需对应执行，不能用SDK注入传输冒充。此为用户目标
在既有条目的具体观察，不增加新的release状态、审批或隔离资格系统。

从打包产物而非源目录运行。使用独立临时user-data，完成干净安装、启动、项目注册、短咨询/文件导入、停止、重启和历史读取。升级测试保留已发布bundle与Decision引用；卸载默认保留用户数据，删除需明确授权。

主机现有Codex/ChatGPT配置不可被测试无条件改写。若需要项目Skill或connector配置，保留安装清单、原值备份、回滚和明确用户动作。不得通过关闭沙箱/审批以获得绿灯。

## 10. 发布判定算法（已实现，当前发布门禁未通过）

`verify:release` 至少检查固定源码提交的离线命令回执、AC各层状态、LIVE01/02/03、实际human_handoff、第二runtime、clean package smoke、license审查、密钥扫描、当前能力报告与未解决的安全缺陷。

离线命令按第3节明确选择缺省旧集合或single_run集合；两者均保留独立
AC/LIVE、人工、第二runtime、包身份和source/build门禁，不以测试去重省略
它们。single_run只消除重复执行相同测试子集的要求，不降低实际测试范围。

回执的 `source_commit` 指实际测试的固定源码提交。回执归档可产生后继提交，但从该源码提交到当前归档 HEAD 的差异及工作区改动必须只限明确列出的证据输出；测试、工具、合约、打包清单、输入 fixture 和规范变化均须重新执行并绑定新源码提交。所有回执和能力报告仍须指向同一个源码提交与 `build_id`。安装包不包含持续变化的 Goal/验收账本；打包 smoke 应记录实际包的完整性标识。证据归档不能自动证明重打包后的不同字节已经安装测试。

Not-run、blocked、failed、skipped不能转passed；陈旧build的证据先做适用性检查。安全边界、串项目、重复副作用、半包发布、假执行回执的已知关键缺陷任一存在都阻塞完成。

如果无法完成live，正确交付是：实现和离线证据＋准确未完成列表＋可重复继续步骤，状态core_verified或needs_user；不是“真实验证已完成或限制已记录，所以完成”。

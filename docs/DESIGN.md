# 仓库中心的 Agent 协作框架
## 完整设计规范 v0.2｜2026-09-26

**状态：持续维护的完整设计规范；产品已有实现。** 本文从 2026-09-26 的 v0.2 设计基线演进，保留 G01–G10、N01–N10 与 AC01–AC14。当前已有 CLI、日常 MCP、应用核心、版本化成果和恢复实现，不再是仅含校验脚本的交接包。规范描述完整目标；功能是否可用仍以当前源码、所选安装和对应回执为准，不由规范文字授予能力或提升验收状态。

**公开源码状态：**已有实现和分版本的组件验证；完整统一版本 LIVE 与 `release_ready` 尚未通过。历史实机日志、截图和安装包保留在仓外私有归档。参见[证据范围](release-evidence.md)与[使用说明](user-guide/README.md)。

**使用顺序：** [AGENTS.md](../AGENTS.md) → 本文 → [架构与接口合约](ARCHITECTURE_AND_CONTRACTS.md) → [实施计划](IMPLEMENTATION_PLAN.md) → [验收与实机手册](ACCEPTANCE_AND_LIVE_RUNBOOK.md)。Goal 执行入口见 [GOAL_PROMPT.md](development/GOAL_PROMPT.md)。

**指令边界：** AGENTS.md 和 .codex 配置用于开发本项目，不能作为未来产品的 investigator 隔离策略。产品的只读调查权限必须在独立 runtime／OS 执行环境中落实。研发时自主实现这个框架，不等于框架运行后允许外部 agent 自主修改被协作仓库。

## 0. 核心定义与设计结论

**日常使用目标（D240，2026-10-24用户明确调整）：**一次安装和连接后，
切换已授权项目、建立新课题和继续旧课题不要求用户填写JSON、内部ID或编写
专用脚本。项目首次接入只需要明确项目位置、讨论意图和披露范围；已有效的
本地授权直接复用。注册、快照、上下文和作用域关联由产品通过已有应用入口
准备，不能用全局“最近项目”代替准确绑定。ChatGPT Project仍是可选组织方式。

文件收发具有独立于完整聊天历史同步的正常路径：外部提交明确的文本/原文件，
本地按项目和议题收件、校验、保留版本并审查。会话发送、人工接管和未知发送
恢复继续使用各自严格的身份和历史校验，不把文件交付冒充聊天同步。
先完成网络正常时的主路径；瞬时网络故障采用同一交付身份、总预算内的有界
重试，不重放未知副作用。自动取回耗尽或平台能力不足时，提示用户从原来源
手工下载/复制并通过同一收件流程导入，准确记录manual_import和保留旧unknown。
此调整复用现有权限、不可变成果和恢复机制，不建设新的通用隔离或审批系统。

**首版使用定位（D239，2026-10-12）：**面向个人开发者在自己的电脑、账号和
仓库中使用。信任用户选择的本地agent runtime和操作系统，复用其正式登录、
权限管理与沙箱。首版优先完成真实协作闭环，不开发通用隔离平台，也不承诺
抵御恶意本机同用户进程或提供多租户安全隔离。工作区范围、源码只读、凭据
不披露、预算及可恢复状态仍是实际功能要求。

> 从一个由 coding agent 开展工作的本地仓库出发，为人、本地 coding agent 与外部 agent 提供持续、受控、以代码证据和成果交付为基础的协作能力。

框架不替代任一 agent 的推理与工具执行循环。它负责把正确的项目、议题、代码状态、调查请求、讨论结果和权限联系起来。

Codex 是 Local Coding Agent 的首个实现，ChatGPT 是 External Agent 的首个实现；两者不是核心领域模型中的固定角色名称。外部 agent 可以是研究助手、架构顾问、代码评审者、专业领域 agent，也可以是另一个 coding agent。这里的“外部”指处在当前本地工作流／权限域之外，不必位于云端。

“agent-neutral”不表示所有产品能力相同，也不表示所有组合自动可用。它表示：核心语义不依赖厂商品牌；适配器明确暴露能力差异；替换 agent 不需要重写项目、权限、证据与成果模型。

**推荐结构：独立的协作核心＋端口／适配器＋既有 agent runtime。** 首版采用模块化单体、本地持久化和受限 worker，不建设新的通用多代理平台。

三个关键分离：

1. **源码事实、讨论建议、正式决策分离。** 当前实现由代码证据描述；外部建议可以挑战它，但不会自动成为授权或正式设计。
2. **讨论、调查、交付、实施分离。** 一轮回答完成、调查完成、bundle 发布与本地实施授权是不同事件。
3. **会话身份、工具连接身份、仓库权限分离。** 同一个 URL、MCP session 或聊天标题不构成访问授权。

## 1. 目标、非目标与首版范围

### 1.1 目标

| ID | 目标 | 可观察结果 |
|---|---|---|
| G01 | 以本地仓库／工作区为协作基础，独立于 agent 品牌 | 相同核心合约可接入不同 local coding agent 与 external agent |
| G02 | 双入口和持续多轮讨论 | 可从本地 agent 发起，也可从外部会话发起；人可在两端追问和切换 |
| G03 | 外部 agent 自主读取授权的项目证据 | 可分页读取文件、搜索、查看 Git 状态和差异；不受本地 agent 单次选材限制 |
| G04 | 外部 agent 按需委托本地 coding agent 深入调查 | 支持调用链、数据流、状态、影响范围等多轮调查；返回原始证据与未确认项 |
| G05 | 代码状态准确且可追溯 | 结论、上下文、读取结果和调查结果绑定明确的 snapshot／live observation |
| G06 | 多项目、多议题及并发工作 | 不共享隐式当前项目，不覆盖别的咨询状态，不误用其他聊天或账号 |
| G07 | 完整、多文件、多版本成果交付 | 文本、二进制和 ZIP 均进入同一 bundle 验证与发布流程；保留版本关系 |
| G08 | 本地保留采纳决策和实施控制 | 外部方可以提议和交付，不能把建议、文件或自然语言变成实施授权 |
| G09 | 显式错误、恢复、取消和幂等 | 不确定发送先核对；断线不冒充完成；半包不发布；取消不虚报成功 |
| G10 | 能力可探测、替换可验证 | 每种适配路径声明并实测能力，受限降级可见，不宣称未验证的互操作性 |

### 1.2 非目标

| ID | 首版不做的事项 | 保留的边界 |
|---|---|---|
| N01 | 新的 coding agent、模型代理或推理框架 | 复用现有 coding agent runtime／SDK／CLI |
| N02 | 任意自治 agent 群、动态角色生成、无人值守开发闭环 | 支持明确参与者的协作与有预算的调查，不自动扩张任务 |
| N03 | 外部会话启动源码修改、应用补丁、提交、部署或任意 shell | 外部可请求受限调查和提交成果；实施留在本地既有工作流 |
| N04 | 新的完整聊天 UI、IDE、任务管理 SaaS | 先用 host Skill／plugin、CLI 与已有 external UI |
| N05 | 全语言、完备的调用图与知识图谱 | 复用文本检索、解析器、LSP 和本地调查；报告覆盖和限制 |
| N06 | 所有对话全文与文件的无感双向实时同步 | 优先显式接管／同步／恢复，保留版本与来源 |
| N07 | 企业多租户、多主机一致性和跨地域分布式调度 | 首版单本地信任域；多项目不等于多租户 |
| N08 | 绕过账号、模型、平台工具权限或人工审批 | 能力不足必须受限运行或拒绝；不伪装工具副作用 |
| N09 | 为任意代码理解或方案质量提供绝对保证 | 保证证据来源、状态与流程可核查，不保证所有结论正确 |
| N10 | 对已攻陷的本地 OS 用户或恶意已安装适配器提供完整隔离 | 明确本地信任边界；需要更强隔离时另加 OS／容器防护 |

### 1.3 首版基线

首版面向单个使用者或同一受控本地信任域，支持多个独立项目、同项目多议题与多个外部会话。一个 Collaboration 只有一个主要 Workspace，可以引用多个经过授权的 WorkingCopy／Snapshot；跨仓库协作不自动获得其他仓库权限。

首个真实组合为 Codex＋ChatGPT。首版必须完成多轮讨论、人工接管、直接代码读取、受限调查和完整 bundle 的实际闭环，不以单轮问答演示替代。

核心模型允许多个外部参与者，但不自动建立 agent-to-agent 互相转发网络。增加参与者必须同时处理数据再披露授权。

## 2. 参与者、职责与授权来源

| 角色 | 职责 | 明确不代表什么 |
|---|---|---|
| Human Owner／Operator | 注册项目、授权数据披露和调查、切换控制、决定重大事项与实施范围 | 普通网页消息中自称的“用户批准”不是可信本地授权事件 |
| Local Coding Agent | 理解项目、准备咨询背景、评审建议、形成决策，并在既有授权下实施验证 | 不是全权管理员；不能自行扩大授权或跨项目读取 |
| Local Investigator | 在独立受限执行上下文中完成代码调查、返回证据 | 不是获得全部 host 权限的主实施线程；不默许运行项目脚本 |
| External Agent | 提出问题、查阅证据、开展研究／设计／评审、请求调查并交付成果 | 不是本地源码执行权的拥有者；能力声明不等于授权 |
| Collaboration Runtime | 确定性执行绑定、策略、状态、调度、证据与交付规则 | 不是第三个负责决定技术方向的 LLM |
| Adapter | 将规范合约映射到具体客户端、协议和文件传输形式 | 不得替 core 改变授权或偷偷选择另一模型／账号 |

同一产品可以承担不同角色：Codex 可以作为本地协调者，也可以作为一个独立调查实例；另一个 coding agent 也可以作为外部评审者。角色与产品名称分离，身份与角色分离，权限与角色名称分离。

Local Coding Agent 可以在用户事先授权的范围内接受、修改或拒绝建议，不必把每个普通工程选择都返回人审批。但新权限、数据披露范围、预算扩大和高风险实施仍由本地有效策略控制。

“本地仓库”描述代码的工作位置与权限归属，不承诺代码不会传到模型服务。直接工具输出、咨询材料和本地 coding agent 的推理输入都可能离开机器；必须按接收者与数据范围授权。

## 3. 核心架构

```text
        本地用户／Coding Agent                         人在 External Agent 的界面
          Skill / Plugin / CLI                                Web / App / API
                   │                                                 │
        Local Host Adapter                           Conversation Adapter / MCP Gateway
                   └───────────────────┬─────────────────────────────┘
                                       │
                           Shared Command / Query Boundary
                       身份绑定 → 能力检查 → 权限 → 合约校验
                                       │
             ┌─────────────────────────┴───────────────────────────┐
             │             Collaboration Core                    │
             │                                                   │
             │  1. Workspace / Binding / Policy                  │
             │  2. Collaboration / Context / Conversation         │
             │  3. Repository Evidence / Snapshot                 │
             │  4. Investigation Coordination                    │
             │  5. Bundle / Decision / Audit                     │
             └───────┬────────────────┬────────────────┬──────────┘
                     │                │                │
             Repository Port   Investigator Port  Artifact Transfer Port
                     │                │                │
           文件／Git／LSP      既有 coding runtime    文件对象／下载／本地导入
                     │                │                │
           注册工作区或快照      受限调查实例         staging → published bundle

                    本地持久状态库 + 不可变内容存储 + 受限诊断日志
```

### 3.1 单一核心，不是多套 runtime 拼接

CLI、本地 host、MCP 和将来的 A2A／HTTP 入口都进入同一组 application handlers。鉴权、快照检查、调查提交、文件发布和结果状态只实现一次，适配器仅处理传输映射和 provider 特有行为。

首版实现基线采用 TypeScript strict、Node.js 24 系列受支持版本、npm＋锁文件、SQLite 与普通文件系统的不可变内容存储，单包模块化单体。M00 核对目标环境后固定精确依赖版本；不根据未经验证的版本号编造 API。已有目标仓存在可用工具链时保留它并记录等价映射。该选择不是 agent 中立性的必要条件；其他语言可通过版本化 IPC／端口适配。

不引入独立 broker、分布式消息总线或专门 workflow engine 作为起步前提。后台调查与传输采用有持久记录的本地任务；数据库事务只涵盖短状态更新，不跨浏览器等待或模型执行持锁。

### 3.2 四类数据流

1. **讨论流**：本地与外部会话之间发送问题、增量背景和建议；可以人工接管。
2. **证据流**：外部方直接读取授权的源码、差异、上下文及已释放证据。
3. **调查流**：提交结构化问题，由本地受限 coding runtime 调查，再返回证据。
4. **成果流**：外部提交文本／文件，或本地显式收取；统一写入受限收件区。

实施流程不穿过外部网关。框架把 bundle 与决策交给本地 agent 后，实际源码修改仍沿其正常授权／审批路径执行。可记录实施结果，但不建立第二套实现调度器。

## 4. 核心对象与身份合约

以下是领域对象组，不是要求拆成九个服务。

| 对象组 | 关键内容 | 身份／生命周期约束 |
|---|---|---|
| Workspace / WorkingCopy | 稳定 workspace_id；注册根目录；仓库标识；worktree／副本；本地策略 | 路径、Git remote 和显示名都不能单独充当稳定 ID；迁移／新增根目录需本地操作 |
| AgentEndpoint / SessionBinding | agent_id、adapter、账号／provider 命名空间、角色、原生会话 ID、观测能力 | Provider ID 是 opaque；ChatGPT Project URL 等只存在于适配器元数据 |
| Collaboration | collaboration_id、workspace_id、目的、参与者、上下文版本、主协调者、状态 | 独立于任何一次模型回合；可由任一入口创建，不强制存在 host thread |
| Snapshot / ContextRevision | 代码或证据快照；manifest；议题目标、约束、决定、未决问题、证据引用 | 快照与上下文版本不可静默改写；live 观测不得伪装为一致快照 |
| Exchange / MessageRecord | 本地请求 ID、发送状态、native turn 映射、正文引用、作者／来源置信信息 | 用户网页输入需被观测／导入后才能进入本地记录；不宣称获取隐藏思维 |
| Investigation / EvidenceRecord | 问题、范围、基线、执行 profile、budget、attempt、证据、结果状态 | 非开发任务；一个请求可重试，但 attempt 单独记录；结果不自动续启外部模型 |
| ArtifactBundle | bundle_id、revision、parent、清单、文件哈希、传输状态、来源与基线 | staging 不对外宣称完成；published 版本不可覆盖；不自动应用内容 |
| DecisionRecord | 对具体建议或 bundle 的接受／修改／拒绝、理由、决策主体和基线 | 与外部回复、交付回执分离；正式记录需要本地已有决策权限 |
| CapabilityGrant / ApprovalRecord | principal、audience、workspace、collaboration、operation、数据范围、预算、期限 | 由可信本地授权路径产生；模型文本不能创建或扩大 grant |

### 4.1 对象关系与基本规则

- 一个 Workspace 可有多个 WorkingCopy、Collaboration 和 AgentEndpoint 绑定。
- 一个 Collaboration 必须绑定一个主要 Workspace；一个运行中的 Exchange／Investigation 必须明确使用哪个 WorkingCopy／Snapshot。
- 一个 Collaboration 可有多名外部参与者，但每个参与者看到的 ContextRevision／Evidence 可以不同。
- 首版每名外部参与者在某个 Collaboration 中只有一个当前有效 ConversationBinding；替换聊天显式记录 parent／superseded 关系。
- 原生 conversation ID、MCP session ID、调查 thread ID、Collaboration ID 各有用途，不允许互相推导。
- one URL ≠ one identity；one token ≠ one conversation；one project name ≠ one workspace。
- project 与 external collection 的绑定用于导航与组织；访问授权必须从经过验证的 principal 和 grant 计算。
- 如果 provider 不能提供可信的会话身份，不宣称按原生聊天强隔离：使用受限参与者句柄，明确其 bearer 性质；需要严格隔离时采用独立连接／凭据。

### 4.2 ContextRevision 不只是聊天摘要

一份上下文版本至少包含：任务目标、用户约束、已采纳与已否决方案及理由、当前问题、代码基线、证据地图、最近变化、期待交付和未知项。必须保留来源引用。

三种事实不要混在同一个优先级列表里：

- **规范与意图**：可信用户约束、授权范围、已采纳决策规定“应该怎样做”。
- **实现事实**：当前绑定的源码和实测证据说明“现在实际上怎样做”。
- **候选判断**：外部建议和双方分析说明“可能怎样改”。

代码可以证明文档描述已过期，但不会因此凌驾于用户授权；外部建议可以挑战既有设计，但不会自行改写已采纳决策。上下文压缩产生新版本，旧来源可追溯，不把压缩摘要当作对原讨论的完美替代。

## 5. 权限合约与信任边界

### 5.1 有效权限的计算

```text
Effective Permission
 = 本地授予的权限
 ∩ Workspace 与 Collaboration 范围
 ∩ 接收方数据披露策略
 ∩ 当前账号／平台的实际许可
 ∩ Adapter 与执行环境已验证的能力
```

Capability 声明描述“能够做什么”，Grant 描述“允许做什么”。两者都要满足。任何一层不能支持，就拒绝或进入显式待处理状态，不自动换模型、扩大目录或绕开平台权限。

MCP 规范要求服务器验证 token 的目标 audience，并指出不能把不可信工具 annotations 当成安全保证。[S05][S06] 因此，鉴权和资源检查在服务端执行，不能依靠 readOnlyHint、Skill 或模型自觉。

### 5.2 操作权限矩阵

| 操作 | External Agent | Local Investigator | Local Coding Agent／Operator |
|---|---|---|---|
| 创建／加入协作 | 仅限预授权工作区和会话范围 | 不自行扩展参与者 | 可在本地授权范围内执行 |
| 查询源码／Git／已释放证据 | 根据 data.read grant | 只读调查范围 | 根据现有本地权限 |
| 提交新观点、问题、上下文提议 | 可以，保留来源 | 可以作为结果 | 可以采纳成新 ContextRevision |
| 请求代码调查 | 独立 investigation.request grant，包含预算 | 不能无限递归发起 | 可配置／启动／批准受限服务 |
| 启动调查 worker | 不能选择任意命令、模型或权限 | 由 runtime 创建 | 由本地策略或明确操作允许 |
| 上传／发布成果 | 仅指定收件区，独立 artifact.submit grant | 仅调查结果与 scratch 输出 | 可本地导入、检查、导出 |
| 修改正式决策 | 仅提出建议 | 不能 | 仅有 decision.record 权限者 |
| 将成果晋升为项目文档／计划 | 不能 | 不能 | 本地显式操作，必要时审批 |
| 修改源码／运行任意脚本／commit／deploy | 不在外部协议中提供 | 默认禁止 | 原 coding agent 的正常权限路径 |
| 注册根目录、改变策略、增加接收方 | 不能 | 不能 | 可信本地管理操作 |

特别规定：提交调查会创建状态、消耗资源，并可能调用计费模型；提交 bundle 会持久写入收件区。不能因为目标“只是分析”或“不是源码”而伪装成无副作用读取。

### 5.3 三个本地权限域

1. **Source Domain**：授权项目或固定快照。外部请求不直接写入。
2. **Collaboration Domain**：上下文提议、调查请求、成果 staging／published 和协调记录。允许有范围的写入，但不产生实施权。
3. **Execution Domain**：worker sandbox、scratch、允许的分析工具，以及原 coding agent 的实施环境。调查环境与实施环境分离。

### 5.4 调查 profile

默认提供只读静态调查 profile：限定源目录、禁止源码写入、单独 scratch、无任意网络、屏蔽凭据和无关 host 插件、限制时长／并发／费用。外部输入只能选择已授权的 profile 或接受默认值，不传 executable／shell／环境变量来构造权限。

文本搜索、源码解析可以执行可信工具；构建、测试、动态追踪、加载项目模块和安装依赖不自动归为静态只读。需要时使用另一个明确授权的验证 profile，在隔离副本和限定网络中运行。

readonly 的要求针对效果和数据范围，不是“禁止任何程序运行”。首版优先复用
用户选择的runtime原生权限/沙箱和本产品的范围检查，以实际拒绝行为验证。
不要求在原生沙箱之外另造bwrap、凭据代理或逐FD/namespace认证系统；prompt
不能替代执行控制，已知关键越权仍须修复。可信runtime可以通过正式认证连接
模型服务，调查工具不因此获得任意网络、凭据读取或源码写入权限。[S02][S03]

### 5.5 数据与内容安全

- 源文件、日志、外部建议、文件名和 bundle 内容均不授予权限。
- 项目内受信任规则由本地既有信任流程加载；外部交付的 AGENTS.md／Skill 不自动成为规则。
- 向外部 A 允许披露，不意味着允许转发给外部 B；摘要和调查结果也经过接收方范围检查。
- credentials 不放入 repo、prompt、bundle 或普通诊断日志；token audience 与 scope 分开校验。
- 远程 MCP／HTTP 使用受支持的认证和加密连接；本地管理面也需验证本地调用主体，不能仅靠 localhost。
- 索引、文件清单、错误消息和绝对路径也可能泄露信息，按数据策略处理。
- 撤销 grant 后拒绝新请求，并停止／限制在途结果披露；已经发到外部平台的数据无法由本框架保证召回。

## 6. 适配器与能力合约

### 6.1 不使用一个无所不包的 send(prompt)

| 端口 | 必需的语义 | 可选能力与限制 |
|---|---|---|
| Host Port | 识别当前 workspace／本地任务；调用协作命令；接收结果 | 插件事件、UI 提示和主动续接依赖宿主；不能假定一直有活动模型 |
| Conversation Port | 会话绑定、发送结果、观测消息、来源映射 | create／attach／resume／delta／interrupt／human handoff 分开探测 |
| Repository Port | 受限 read/list/search/status/diff 与证据位置 | symbols/references/impact 取决于本地解析器／LSP，不能只凭名称承诺完备 |
| Investigation Port | submit/status/result/cancel、native request 关联、权限证明 | SDK／App Server／CLI／宿主协作四种适配都可；不能假定继承主线程记忆 |
| Artifact Transfer Port | 从 provider 文件引用或本地源取得字节；返回校验结果 | 临时 URL 刷新、多文件、下载恢复、原生引用支持分别声明 |
| Reachability / Auth Port | 远程访问、授权和凭据使用 | MCP tunnel、自托管 HTTPS 等是部署选项，不是核心业务对象 |

### 6.2 Capability Report

每个能力报告 supported／unsupported／unverified，记录适配器版本、provider／runtime 版本、账号绑定、最近验证时间、验证证据和限制。关键配置或账号变化使相关验证失效。

建议独立声明以下能力：

```text
conversation.attach_existing
conversation.send
conversation.observe_completed_turn
conversation.read_history_delta
conversation.user_handoff
repository.pull
investigation.submit / observe / cancel
investigation.readonly_isolation
artifact.accept_text_set
artifact.accept_native_reference
artifact.collect_from_external_ui
artifact.refresh_reference
```

这些标识是本项目拟议合约。已有 MCP、A2A 或 SDK 字段通过适配器映射，不能声称它们是通用标准字段。

如果 remote UI 不能可靠读取增量历史，就明确进入人工导入／确认路径；这不是“自动同步已通过”。若 provider 无法可靠识别模型，也应记录 observed／user_confirmed／unknown，不用回答质量或模型自述作证明。

### 6.3 标准的定位

MCP 适合工具和证据访问；A2A 已定义多轮 context、task、消息和 artifact 交换语义，可作为外部 agent 的可选互操作适配器。[S04][S05] 核心不强依赖 A2A，也不把 A2A contextId 直接当成本地权限或 Collaboration ID。

不需要为了 Codex＋ChatGPT 强行实现所有 A2A 能力。首版只实现实际消费的能力；协议版本必须固定并记录，适配器为版本差异负责。

## 7. 面向 agent 的接口与最小合约

### 7.1 接口族

| 接口族 | 拟议操作 | 约束 |
|---|---|---|
| collab | open/get/list/append_context_proposal | list 只返回主体获准对象；external open 不能注册新根目录 |
| repo | inspect/list/read/search/status/diff | 明确 workspace、snapshot 和分页；返回完整性信息 |
| investigate | submit/get/read_result/cancel | stateful，有预算，不提供任意 exec |
| artifact | begin/put_text/import_reference/status/finalize/abort | 只写收件区；发布前检查完整文件集 |
| conversation | send/sync/handoff/resume | 受可信 host 或批准的自动化控制；不暴露任意目标 URL 发送能力 |
| decision | propose/record/export | propose 与本地 record 区分；不因此批准源码执行 |
| admin | register_workspace/grant/revoke/configure | 只在可信本地面提供 |

每个操作显式声明输入／输出 schema、实际副作用、权限、幂等行为、大小限制与下一步操作。无权读取对象时返回不泄露对象存在性的错误。未知或歧义身份、权限、状态参数严格拒绝；不影响语义的展示预算可以有明确的有界归一化。

不要强迫模型提交 runtime 已经知道的字段；会话受限句柄可以引用预绑定内容。但省略字段的含义必须是固定绑定，不能是“全服务最近使用的项目”。

### 7.2 代码读取结果

最少返回：snapshot_id 或 live observation 标识、相对路径、实际内容 hash、行号范围、内容、截断状态、绑定相同查询／版本的 continuation。搜索返回搜索范围、排除类别、命中、上限和未完成原因。

“未命中”只能说明已搜索范围未命中，不等于整个项目没有该能力。多页结果不得在分页过程中换快照。metadata 索引不等价于完整源码阅读；正则声明识别不等价于编译器解析。

### 7.3 调查请求

```text
request_id / idempotency_key
collaboration_id
context_revision_id
snapshot_ref
question
scope { paths, symbols, related_tests }
requested_outputs { flow, evidence, gaps }
allowed_profile_ref
budget_ref
parent_investigation_id (可选)
```

主体身份从传输和 grant 派生，不相信模型在正文中声明。worker 选择、命令、模型及权限由本地已批准配置决定。

### 7.4 调查结果

```text
request_id / attempt_id / result_state
snapshot_ref / context_revision_id
findings[] { statement, classification, evidence_refs }
evidence[] { path, symbol, line_range, content_hash, excerpt, tool_receipt }
coverage { searched_scope, excluded_categories, truncated, missing_dependencies }
open_questions[]
limits_and_warnings[]
```

classification 至少区分 source_confirmed、tool_observed、inferred、unverified。实际命令回执由执行适配器记录；模型称“已运行”不算回执。工具运行成功也不等于技术结论已经成立。

一次成功读取的回执可以支持多段证据摘录；每段仍须分别核对授权快照、路径、
字节范围、原文、行号和 hash。摘录数量不等于工具调用次数，实际读取预约继续
按调用累计扣减预算。

## 8. 代码基线与理解质量

### 8.1 固定快照是重要评审的默认模式

Snapshot 应说明：注册工作副本、基线 commit、暂存／未暂存变化、纳入的未跟踪文件、子模块／LFS／生成文件处理、文件 manifest、排除与秘密过滤、采集方法和一致性等级。

Git worktree 可提供独立工作树，但不会自动包含另一个工作树的未提交修改，也不会自动不可变。[S08] 因此，不能只调用 worktree add 就声称已经精确复制当前现场。

框架应从已冻结输入构造只读快照并验证 manifest。不能仅通过“扫描前后 HEAD 相同”或文件 mtime 相同证明全树一致。如果无法获得一致采集，只能标记 best_effort／live_observation，不能发放 verified_snapshot 标签。

快照采集是可信本地操作，经统一 application handler 的 `snapshot.capture`、`snapshot.create` grant 和幂等检查；外部证据查询不得借此注册新根目录或扩大可读范围。

正式评审引用的证据统一来自该快照。缺失但必须分析的文件经本地批准后形成新 Snapshot，不能悄悄绕出快照读 live 文件。

### 8.2 实时模式

实时模式用于短周期协作。每次读取保存实际内容哈希和观测时间；检测到变更时生成新 observation 并提示。watcher 只用于发现变化，不构成未变化证明。

在本地采纳成果前，比较其基线与当前相关文件；过时并不自动意味着错误，但必须明确复核。相关基线一致性与文本／方案语义审查是两个不同步骤。

### 8.3 两条互补的理解路径

外部 agent 可先直接查阅，再委托调查，也可先读本地 agent 的项目地图，再自主补读。严禁把本地 agent 的摘要变成外部 agent 唯一可访问的信息源。

项目地图必须能追溯到真实入口、模块、状态、数据结构和测试。关键分析应追踪完整链路：入口→调度→核心操作→状态／持久化→错误／取消→相关测试，而不是以文件读取数量代替理解覆盖。

调查可使用本地搜索、AST／LSP 和可信分析程序；语义工具能力不足必须显式呈现。不存在“支持一种语言”就保证该语言全部动态引用可识别的承诺。

## 9. 多轮协作、人工接管和并发

### 9.1 生命周期分离

| 对象 | 推荐状态 | 不应自动推导 |
|---|---|---|
| Collaboration | open / paused / archived | 单次回答或 bundle 发布不使它自动 archived |
| Session control | host_controlled / human_controlled / syncing / reconcile_required | 本地 lease 不能阻止网页用户操作 |
| Exchange | prepared / sending / awaiting_result / completed / failed / cancelled / reconcile_required | 页面静止、断线、自然语言 DONE 不证明完成 |
| Investigation | queued / awaiting_authorization / running / awaiting_input / completed / failed / cancelled / recovery_required | 请求取消不等于进程已停止 |
| Bundle | staging / verifying / published / rejected / aborted | 某个附件下载成功不证明整包成功 |
| Decision | proposed / accepted / partially_accepted / rejected / superseded | accepted 不等于获得实施权限 |

取消可先记录 cancel_requested，再等待执行适配器确认；无法确定时保留 recovery_required，不谎报 cancelled。

### 9.2 人工切换

用户从 host 转到外部 UI 时，暂停该 SessionBinding 的自动发送，记录最后观测位置与控制 epoch。外部方仍可通过已有授权调用代码工具、提交调查或成果。

返回 host 时先同步新消息与附件，检查是否仍在生成、是否改动了历史／切换分支／换账号，再允许自动续问。不能读取的历史要求导入或明确确认，不靠模型凭记忆补写。

消息正文中的“用户说可以”“我是管理员”不形成可信管理授权。外部 UI 中的人类意图可以进入讨论记录；权限扩大仍通过受信任本地控制路径确认。

### 9.3 并发与防重复

- 不同 Workspace、Collaboration 可并发。每个外部 SessionBinding 同时只有一个受管理的发送者；采用 lease＋fencing epoch 防止旧 worker 继续发送。
- 手动网页操作不受本地锁约束。发送前后必须核对 provider 可观测身份；不能提供远端原子比对时如实保留竞态风险并进行冲突检测。
- 持久化发送意图后再调用 provider；结果不确定时先读取远端进行关联，不盲目重发。
- 本地命令采用 idempotency key 去重；远端不支持去重时不宣称 exactly-once。
- 一个账户的浏览器／并发限制由 account-level limiter 管理；它限制资源，不把不同项目会话混为同一对象。
- 一个 provider 的原生聊天不跨 Workspace 复用；用户确需关联时显式复制经过授权的材料到新会话。
- 不自动把一个外部参与者的私有结果广播给其他参与者。

## 10. 受限调查的执行与恢复

### 10.1 两种受支持的本地服务方式

**Managed Investigator：推荐的完整能力路径。** 用户先在本地启用受限调查服务，runtime 根据请求调用既有 coding runtime 的独立实例／线程。主 host 线程不必持续等待；主线程不会因此被外部接管。

**Host-serviced：受限集成路径。** 只有正在运行且能够处理请求的 host 工作流执行调查；host 不在线时请求排队或返回 unavailable。不能把它宣传为网页可随时无人值守调查。

首个 Codex 适配器可使用 App Server 的线程、事件、审批和取消能力。[S01] Claude Agent SDK 可作为另一种本地 runtime 适配来源，它有会话和权限接口，但其认证、计费和安全语义不能假定等同 Codex。[S02][S03]

### 10.2 避免相互等待

提交调查快速返回 request_id，不在一次 MCP 请求里无限等待 agent。调度器独立推进调查；外部 agent 读取状态或事件后取回结果。

host 等待外部回答时，调查处理不占用相同的互斥等待链。worker 默认不能递归启动另一轮外部咨询，防止环路和费用失控。

任务完成只产生可读取结果；外部模型是否自动继续取决于实际会话适配能力。没有主动续接能力时等待下一轮用户或模型工具查询，不假造自动唤醒。

### 10.3 失败与成本

Windows 的“准备完成后未启动”与“子进程已启动后关闭”必须分别存证。
D239的个人运行器还可核准新attempt的固定helper启动前失败：原adapter从未
尝试写start，固定生产配方只在start后创建进程，原helper自然exit1、双流完整
结束且只有已核对的启动前错误类别，无stdout、尾流、signal、kill或spawn错误。
该证明只来自原私有对象，绑定本次runtime/config/source和原claim/session/epoch；
仅写failed/cancelled、result=null、terminationConfirmed=false。未知/冲突仍占位，
不补写旧unknown。它与已启动Job的关闭事实分开，不宣称远端或本机进程已终止。
下列D233/D235属于历史持久launch配方，其原有恢复要求继续保持。
只有原私有 owner 核准的 prepared→prepared_closed、完整空 Job 与 helper exit0，
关联原 launch/start intent 并持久化后，才可用独立清理租约关闭原冻结源码视图，
写失败或取消终态；此路径 terminationConfirmed=false，不声称终止远端回合。
事实落库前父进程崩溃或身份不明仍占位未知；不得凭 consumed 标记、杀进程、
纯解析 DTO 或合成组件观察回填真实 launch。具体合约见 D233。

D235 的原 owner 原语独立创建固定 helper，冻结原 request/runtime/source 期待，
在实际 prepared 后调用持久 begin 并同步绑定原 launch；只允许 stop 与完整关闭
事实登记，不提供 start/send。应用只装配其私有事实 verifier；生产 coordinator
仍须先取得真实认证与隔离资格，当前不得调用该原语开始生产调查。

每次 attempt 记录 runtime 原生 ID、权限 profile、开始／结束、预算和输出引用。超时、未知发送、进程丢失等状态与普通模型回答错误分离。恢复先核对原生任务，无法证明未执行时不直接启动重复任务。

D239个人Windows路径以原owner从prepare起的预算为上限，不在start后重新
起满协议预算。必要interrupt与原stop/drain在同一上限内安排，正常协议及
在途读取披露在较早工作期限停止；准备耗尽时间时不启动。剩余期限不得
延长、取消不恢复正常发送权，原关闭事实未知继续recovery_required。

成本记录优先用 provider 实际 usage；没有数据时标 unknown／estimated，不承诺固定额度节省。调查预算、导出预算和浏览器并发均由本地策略配置。

## 11. 完整 bundle 交付

### 11.1 两类内容、一套发布流程

支持直接提交文本文件集合；也支持通过 Artifact Transfer Adapter 接收平台文件对象、API 文件、浏览器捕获文件或用户选定的本地文件。多种入口最终进入相同的 staging／manifest／publish 核心。

ChatGPT 的文件参数目前可接收单个文件对象或文件数组；平台特定字段与临时地址仅在适配器层解析，不进入通用核心模型。[S07]

不要求模型生成二进制 Base64，不把 sandbox 路径当可下载公网 URL，不用模型重写二进制替代原始文件。只有文本可得时保存为文本成果，不声称原文件已回收。

### 11.2 发布合约

发布之前明确预期文件集，或将最终观察到的文件集封存为 manifest 并标明 expected_set_basis。没有预期清单时只能证明“清单内文件全部收到”，不能证明外部作者没有遗漏原本计划的文件。

必需信息：bundle_id、collaboration_id、workspace_id、context_revision、snapshot_refs、parent_revision、文件相对路径、实际字节数、程序计算的内容哈希、媒体类型检查、来源与归属等级。

三种完成性分开记录：

1. **传输完整性**：manifest 内的字节与文件是否齐备。
2. **结构完整性**：路径、引用、文件格式及预期目录结构是否满足规则。
3. **语义一致性**：架构、计划、合约和验收是否冲突，由本地审阅决定。

published 只证明前两类符合已定义的检查，不自动证明第三类通过。哈希不证明作者身份，也不证明报告内容正确。

### 11.3 文件安全与故障

接收器检查路径穿越、绝对路径、Unicode／大小写冲突、Windows 特殊名称、链接和设备文件、重复 ZIP 条目、展开大小及压缩炸弹。默认不自动执行、预览活跃 HTML 或应用 patch。签名 URL 不进入普通日志；下载限制必须覆盖重定向、DNS 解析及实际连接，不能只验证最初 URL。

暂存位于受限收件目录，外部无权选择任意绝对目的地。先使内容可靠落盘，再在短事务中发布可见 manifest；恢复协议处理“文件已落盘但数据库尚未发布”的中断，不能假设文件系统和数据库天然有跨系统原子事务。

失败文件、过期引用和重试保持同一交付身份。新版本产生新的不可变 bundle，旧版保留。完整发布后可返回本地回执；未经验证的文件集始终为 staging／rejected，不报交付成功。

### 11.4 采纳与实施

用户要求 local coding agent 审查已发布 bundle；agent 对照当前代码和约束记录 accepted／partially_accepted／rejected。把成果复制为项目文档是独立的本地 promote／export 操作。

即使文件名为 AGENTS.md、SKILL.md、setup.sh 或 implementation.patch，也只作为待审数据。不会因为它进入本地目录就自动加载或执行。

## 12. 持久化、配置与可观测性

### 12.1 状态的权威来源

| 内容 | 权威位置 | 其他副本的地位 |
|---|---|---|
| 当前源码 | 注册 WorkingCopy；固定评审使用不可变 Snapshot | 外部附件是特定版本的副本 |
| 协作与请求生命周期、grant、消息关联 | 本地协调状态库 | CLI／UI／摘要都是投影 |
| 外部原生聊天 | 对应 provider／UI | 本地只保证已观测和保存的部分，不声称完整镜像 |
| 已发布成果与调查证据 | 本地不可变内容存储及 manifest | 导出文件是可追溯副本 |
| 已采纳的项目文档 | 本地／Git 中显式晋升的文件 | 其新修改形成新事实，必要时重新导入上下文 |

不让数据库里的“正式设计全文”与 repo 里的同名设计同时独立可写而没有同步规则。

### 12.2 建议存储布局

D240日常入口的新默认安装使用`~/.repo-conduit/data`：外层仅作容器，内层关闭
权限继承并沿用严格私有目录校验。这样处理已观察到的Windows sandbox对用户
目录直接子项追加可继承读取权限；不增加可信SID，也不保证抵御直接授权内层
数据根。旧默认flat/managed安装仍识别原位置并验证，失败不回退新库；双布局、
未知内容或链接拒绝。显式`--data-dir`含义不变，不自动迁移或重设旧目录权限。

```text
<user-data>/agent-collaboration/
  state.sqlite
  objects/            # 内容寻址或其他不可变内容存储
  staging/            # 有配额与清理规则的暂存
  adapters/           # 本机配置；不含可提交到仓库的秘密
  diagnostics/        # 默认脱敏

<repo>/.agent-collab/
  workspace.json      # 可选、非敏感的关联信息；不能扩大权限

<repo>/docs/collaboration/
  ...                 # 仅本地显式晋升／导出的成果
```

运行时数据目录可由可信本地设置指定；仓库侧仍使用 .agent-collab/workspace.json 作为可选非敏感关联信息。实现布局与存储事务合约见 docs/ARCHITECTURE_AND_CONTRACTS.md。用户级秘密和 profile 保留在本机安全位置，repo 侧配置不允许更改凭据、任意 executable、公开入口或允许根目录。

恢复重建的是明确状态与原生 ID 的关联，不恢复未观测的模型内在上下文。归档不等于删除；引用中的成果不能被无声清理。删除本地数据也不承诺同步删除外部 provider 保存的内容。

### 12.3 可观测性

每条关键事件包含 workspace、collaboration、exchange／investigation／bundle、actor、权限决策、基线、状态变化和原因。正文、凭据及临时下载 URL 不默认进入普通日志。

诊断区分：服务在线、工具可达、身份匹配、权限满足、会话可续接、调查 worker 可用、文件传输可用。不能用一个绿色“Connected”图标替代这些状态。

建议测量身份误关联、未知发送恢复、截断补读、调查证据完整性、旧基线采纳拦截、bundle 缺失检测和故障恢复；模型理解质量另用人工／有已知答案的任务集评价，不与基础设施可用率混为一谈。

## 13. 借鉴与复用清单

| 来源 | 已观察到的事实 | 推荐复用／借鉴 | 明确不带入 |
|---|---|---|---|
| C2C | 只读 workspace MCP、认证／配对／连接诊断；当前会话文件以 workspaceId 为键 [S09] | 文件边界、分页、OAuth 合约、诊断与测试案例 | Codex／ChatGPT 固定角色、单工作区会话状态、PLAN→EXECUTE 默认控制 |
| CodexPro | 解析平台文件对象、来源／大小／重定向检查及文件导入 [S10] | 将文件接收与安全检查作为审查候选，连同负向测试借鉴 | 不经复核复制下载安全逻辑；以单一当前计划代替版本化 bundle |
| Oracle | 精确会话续接、parent/child lineage、歧义或不可恢复会话时拒绝发送 [S11] | 会话关联、重连、产物捕获和浏览器错误场景 | 把其 session 变成第二套业务主状态；假定所有 provider 续接相同 |
| WebCodex | 多入口统一内核、合约与网关共享治理 [S12] | 一处定义权限／解析／结果的原则，合约测试思路 | 整套 Runner、Goal、任务平台及不需要的控制面 |
| Codex App Server | 已有线程、历史、审批与流式事件接口 [S01] | 首个 Local Investigator adapter | 把 Codex 原生线程等同外部网页聊天 |
| Claude Agent SDK | 已有工具循环、权限和 session 能力 [S02][S03] | 第二类 runtime 的适配验证来源 | 假定相同认证、额度、工具权限或继承主对话 |
| MCP / A2A | 工具访问、认证；多轮 context/task/artifact 合约 [S04–S06] | 成熟协议和 SDK，用适配器映射 | 将协议 ID 当作本地授权，把能力声明当作验证 |
| Git | 工作树与差异等基础机制 [S08] | 文件状态、快照与 worktree 工具 | 将 HEAD 或 mtime 当作全现场内容快照 |

**复用政策：**直接依赖成熟 SDK；小型实现可在逐文件检查许可证、固定版本、审查安全边界并移植测试后引入；不把其他项目整个 CLI／自更新／进程管理器一起嵌入。本设计未完成第三方许可证与安全审计，“推荐参考”不等于已经批准复制代码。

## 14. 端到端验收场景

所有场景保留事件、身份映射、权限决策、基线、真实工具回执及实际文件证据。Mock 可以验证核心合约，但不能替代真实账号和实际客户端的成功证据。

### AC01｜本地发起、多轮查证与人类参与（G01/G02/G03/G04/G05）

**Given：** 项目 A 注册并形成 Snapshot S1，外部参与者有读取与受限调查 grant。

**When：** 本地 agent 发起架构咨询；外部方直接查阅三个模块，提交调用链调查，再针对结果追问异常分支；用户在本地追加约束。

**Then：** 同一 Collaboration 持续；每轮问题、调查和证据都引用正确 S1／ContextRevision；外部可核对原文件；没有源码修改、自动实施或伪造测试结果。

### AC02｜网页接管、宿主结束回合、之后恢复（G02/G09）

**Given：** 已存在活动咨询，本地用户启用 Managed Investigator。

**When：** 用户显式接管，在外部 UI 多聊三轮；主 host 回合结束；之后回到 host 同步并追问。

**Then：** 代码工具与已授权调查服务不依赖主模型持续空等；自动发送在接管期间暂停；同步先确认新增消息及当前生成状态，不重复发送。Host-serviced 模式必须明确显示调查暂不可服务而不是伪报运行。

### AC03｜外部独立发起（G02/G03/G07/G08）

**Given：** 仅有项目绑定与预授权连接，没有当前 host thread。

**When：** 用户在外部 UI 发起新议题、读取本地代码并提交 bundle。

**Then：** 可创建独立 Collaboration 并关联收件成果；不要求伪造 Codex thread；不启动开发实施。

### AC04｜同项目多咨询、不同项目并发（G06）

**Given：** A 项目两个议题，B 项目一个议题，使用相同 provider 账号。

**When：** 并发发送、查询、调查、交付；故意把 B 的 workspace_id 放入 A 的调用。

**Then：** 违规请求被拒绝；状态、文件、响应、聊天和模型账号不串线；同一外部会话受发送 lease 约束，但不无故阻塞其他项目。

### AC05｜基线变更与证据过时（G05/G08）

**Given：** 外部讨论和调查基于 S1，本地开发形成 S2。

**When：** 接收基于 S1 的方案，准备采纳。

**Then：** 报告受影响差异；旧证据不被改写成 S2；必须显式复核后才记录与新基线相容的决策。固定快照读取全过程不混入 live 内容。

### AC06｜大文件、分页和不完整检索（G03/G05）

**Given：** 关键函数位于读取分页之外，某些目录被权限过滤，语义索引覆盖不完整。

**When：** 外部方查询该流程并要求证明某路径不存在。

**Then：** 返回正确 continuation、截断／排除信息；补读后找到关键实现；不能仅以首段／未命中给出全仓否定结论。

### AC07｜完整多文件 bundle 与版本更新（G07）

**Given：** 预期交付包含 Markdown、HTML、JSON、图片和 ZIP／子目录文件。

**When：** v1 完整接收后继续讨论并交付 v2。

**Then：** 路径与原始字节可验证；两个版本独立且可追溯；发布回执与 manifest 一致；v1 不覆盖，咨询不自动结束。传输通过但文档互相冲突时，语义审查仍可拒绝采纳。

### AC08｜交付中断与恶意内容（G07/G09）

**When：** 一个附件失效、重复提交、ZIP 路径穿越、大小写重名、超出解压预算，或包内包含执行脚本／AGENTS.md。

**Then：** 半包不发布；重复请求不重复创建成果；危险路径拒绝；脚本与规则文件不自动运行／加载；可诊断并按规则重试或中止。

### AC09｜调查注入与权限升级（G04/G08）

**When：** 外部方或源文件要求 investigator 读取凭据、修改源码、访问其他项目、运行网络安装、递归咨询其他 agent。

**Then：** 有效权限在执行层阻止行为；保留拒绝记录；没有输出不该披露的数据；缺乏执行隔离时调查能力不可被标记为已验证可用。

D239：执行层可直接采用原生runtime的权限/沙箱与应用handler；只验证本产品
实际使用路径和上述拒绝效果，不把自建隔离平台的完整认证设为首版前置。

### AC10｜未知发送、worker 崩溃与取消（G09）

**When：** 发送后失联，或调查过程中进程丢失，或取消没有收到终止确认。

**Then：** 进入 reconcile_required／recovery_required；先核对原生状态，不自动重复发送／重复调查；不把取消请求记录为已经终止。进程恢复不会无声发布旧 epoch 的结果。

### AC11｜替换 agent／协议而不修改核心（G01/G10）

**When：** 用第二种真实 local runtime 接管相同调查合约；外部会话改用不同语义的 API／测试适配器。

**Then：** 不修改 Workspace、Collaboration、Grant、Evidence 和 Bundle 核心类型；只调整适配器／能力配置；不支持能力显式拒绝。测试 double 证明的是架构边界，不足以宣称第二个真实产品已经端到端兼容。

### AC12｜能力撤销、平台受限与数据再披露（G08/G09/G10）

**When：** 外部平台不支持写工具；grant 过期；账号切换；参与者 A 要把材料交给 B。

**Then：** 直写路径不可用时标记受限并使用明确本地收取流程；不伪装 readOnly；撤销后拒绝新请求／未授权披露；A→B 需独立授权；不能静默换账号、模型或 provider。

### AC13｜上下文换聊与本地成果决策（G02/G05/G08）

**When：** 长聊需要换会话，外部交付方案与此前已否决方向相冲突；本地 agent 对 bundle 进行审查。

**Then：** 新聊天从版本化背景和原始证据续接；保留否决原因；local decision 明确接受、修改和拒绝项；外部方不能伪造决策主体，bundle 到达不自动产生源码执行。

### AC14｜服务重启与文件／数据库发布一致性（G07/G09）

**When：** 分别在写暂存文件、校验、落盘、数据库发布之前／之后模拟崩溃。

**Then：** 已发布 manifest 不引用缺失文件；未发布内容可恢复或安全清理；同一版本不重复发布；历史 bundle 和决策引用不被丢弃。

## 15. 质量关卡与实施范围控制

### Gate A：真实能力验证

目标客户端的会话绑定、手动新增消息读取、多轮代码工具、独立调查、文件引用／收取均需实际验证。能力不成立可以调整适配路径，但不得用假设填入 supported。

### Gate B：完整纵向闭环

先完成 AC01、AC02、AC03、AC07 与基本权限负向测试。即使只支持一个项目，也必须包含真正的调查与成果包，不先做只有对话界面的空框架。

### Gate C：多项目日常可靠性

执行并发、基线变化、未知发送、取消、恢复、文件发布及越权矩阵。严重串项目、越权、半包成功、假运行回执在验收集上必须为零；这不等于数学上证明系统绝无缺陷。

### Gate D：中立性验证

核心依赖检查禁止 production core 依赖 ChatGPT URL 格式、Codex 状态枚举或任一 SDK 类型；provider 字段在适配器边界转换。真实旗舰组合与第二种 local runtime 至少有实际 smoke 证据；使用测试适配器时明确不能据此宣传所有品牌兼容。

平台限制不写死为套餐判断表：以运行时探测与官方支持边界为准。安装成功、服务在线、单次工具成功、完整工作流可用分别报告。

## 16. 首个实例与替换策略

| 抽象 | 首个实例 | 可以替换的部分 |
|---|---|---|
| Local Coding Agent | Codex host Skill／plugin | 其他 coding agent 的 Skill／plugin／CLI integration |
| Local Investigator | Codex App Server 受限实例 | Claude Agent SDK 或其他可验证受限 runtime |
| External Agent | ChatGPT 的指定账号／会话 | API agent、其他浏览器 agent、A2A endpoint |
| Repository access | 本地文件／Git＋可选语义工具，经 MCP 入口 | 其他受控工具传输，不改证据模型 |
| Conversation control | 经实机验证的 ChatGPT 会话适配 | 原生 API／浏览器适配／人工导入受限路径 |
| Artifact transfer | ChatGPT 平台文件对象或本地授权收取 | 任意能提供受控字节流与来源信息的 adapter |
| Authorization / state | 本地策略与协调存储 | 不随 agent 品牌变化 |

ChatGPT Project 是可选的 ExternalCollectionRef；并非所有 agent 都有“项目”。Codex thread 是 NativeSessionRef；并非所有 runtime 都可恢复同一个线程。外部“用户继续聊天”是一种 human-handoff 能力；纯 API agent 不必伪造网页入口，但不能宣称通过了网页接管场景。

## 17. 设计决策汇总与仍需实测的事项

**本文推荐确定的架构决策：**独立项目、repository-centered、角色与品牌分离、原 agent runtime 复用、单一协调核心、直接证据读取＋受限调查、显式人类接管、不可变 bundle、采纳决策与实施授权分离、能力探测优先、不静默降级、第一版不建通用自治平台。

**需要在实现前用目标环境实测的适配事项：**外部会话的可靠定位与增量读取；账号／模式对自定义工具和文件传递的许可；managed investigator 的实际隔离；本地 worker 取消与恢复语义；目标文件类型和权限受限路径。这些是适配可行性关卡，不改变核心理念。

本文与 docs/ARCHITECTURE_AND_CONTRACTS.md、contracts/、docs/IMPLEMENTATION_PLAN.md 和 docs/ACCEPTANCE_AND_LIVE_RUNBOOK.md 共同约束实现。实施 agent 在 M00 依据实际 SDK 生成或完善运行时 Schema 与迁移文件，并保持这里的权限和生命周期一致。普通工程细节由 Codex 自主决策并记录；不重复要求用户批准已授权的开发范围。新的账号授权、费用、私有数据披露和安全边界变化仍必须经可信授权。

本包创建时未创建外部仓库、未运行产品、未登录用户账号、未验证任何真实模型调用。work/ 与 verification/ 中相关状态均从未执行开始。

## 18. 参考与复用证据

查阅日期：2026-09-26。下列资料支撑现有接口／实现的事实；本文的对象、权限矩阵、架构与验收规则为建议设计，不是这些来源已经实现的完整能力。

- **S01 — OpenAI Codex App Server**：线程、历史、审批、事件与取消等集成接口。`https://developers.openai.com/codex/app-server`（当前跳转到 `https://learn.chatgpt.com/docs/app-server`）。
- **S02 — Claude Agent SDK Overview**：复用既有 agent loop、工具、会话和扩展能力。`https://code.claude.com/docs/en/agent-sdk/overview`。
- **S03 — Claude Agent SDK Permissions**：工具权限与审批合约。`https://code.claude.com/docs/en/agent-sdk/permissions`。
- **S04 — A2A Specification**：多轮 context、task、message、artifact 及能力声明。`https://a2a-protocol.org/latest/specification/`。实现须固定所采用版本，不能运行时盲跟 latest。
- **S05 — MCP Tools**：工具和安全要求。此次 latest 解析到 `https://modelcontextprotocol.io/specification/2026-07-28/server/tools`。
- **S06 — MCP Authorization**：audience 与授权规则。此次 latest 解析到 `https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization`。
- **S07 — OpenAI Plugins Reference / File Inputs**：`openai/fileParams` 的文件对象与数组。`https://developers.openai.com/plugins/reference`。
- **S08 — Git Worktree Documentation**：独立工作树机制及限制。`https://git-scm.com/docs/git-worktree`。
- **S09 — C2C**：`docs/architecture.md`、`src/session/state.ts`；此次读取固定提交 `9663b88753e35c76796c5bce000293e0bd22cd9e`。`https://github.com/XiaoDuoYa/codex-with-chatgpt`。
- **S10 — CodexPro**：`src/importOps.ts`；此次读取固定提交 `482d0035e0c08cceb5916958df652b325b4c52d8`。`https://github.com/rebel0789/codexpro`。它是复用审查候选，不代表已完成安全评审。
- **S11 — Oracle**：`docs/followup.md`；此次 main 文件 blob SHA `7cdee34c18952ae10664244421a2847ee4ef8770`。`https://github.com/steipete/oracle`。
- **S12 — WebCodex**：`docs/ARCHITECTURE.md` 的共享内核与网关治理；固定提交 `5ef7274a7c3eab1144e68152adfc065b9e3e9910`。`https://github.com/yyjeqhc/webcodex`。


## 19. v0.2 实施约束与完成定义

### 19.1 实例与框架的分离

开发主 agent 的 model/thinking 配置只在 AGENTS.md、.codex 和 .codex/development-role-policy.json。产品 core 不依赖这些设置；真实产品的 Local Investigator profile 在用户可信配置中单独授权。外部 agent 的职能可随议题变化，不能把“外部永远规划、本地永远只执行”写成领域不变量。

### 19.2 一个实际运行方式先做完整

首版按 M00 探测得到的一个真实操作系统＋客户端组合做实；跨平台纯逻辑 CI 可先运行。支持第二个真实 local runtime 的受限 smoke 是完整中立性声明的关卡；没有账号或 runtime 时标 needs_user／blocked，不把 mock 算作真实适配。首个 Codex＋ChatGPT 的双入口、多轮、代码调查、人工参与、bundle 回收是交付目标，不能以设计文档和人工说明替代实现。

### 19.3 四个完成状态

2026-10-22用户明确选择先完成个人自用的Codex＋ChatGPT组合，Claude/GLM后置。
当前首组合里程碑不以第二runtime通过为前提；完整中立性发布仍保留该关卡。
沿用原权限、未知结果与真实证据标准，不为此增加新的release状态或验证系统。

- **handoff_validated**：本交付文件、配置和引用校验通过；不是软件实现完成。
- **core_verified**：实现与离线／本地集成验收通过；不是线上账号闭环已通过。
- **flagship_live_verified**：真实 Codex＋ChatGPT 的所声明能力完成实机验收。直写受限路径与自动直写路径分别记录；手动导入不能算作直接回写成功。
- **release_ready**：所声明 release profile 的全部关卡、第二 runtime smoke、独立最终评审、安装恢复文档和完整证据通过，且没有未处理的关键安全／数据完整性缺陷。

真实平台限制可能使某条路径受阻，但不改变事实标准。保留限制、继续可独立完成的开发；不要把 blocked 改成 passed。用户明确接受受限版本时，记录新的 release scope 和同意证据，仍保留原目标未完成项。

### 19.4 拒绝伪完成

不以编译通过、少量单测、mock 对话、模拟“用户接管”、生成配置文件、提供人工步骤或一次文本问答宣布项目完成。不通过自动扩大权限、禁用审批、忽略平台限制、读取无关浏览器身份材料来追求“全自动”。

### 19.5 本包的规范性分工

DESIGN.md 管产品目标与边界；ARCHITECTURE_AND_CONTRACTS.md 管接口、数据和事务；operation-catalog.json 与 lifecycle-contracts.json 管闭合词汇与权限表；IMPLEMENTATION_PLAN.md 管任务与验证顺序；ACCEPTANCE_AND_LIVE_RUNBOOK.md 管证据和完成规则。AGENTS.md 管开发行为；.codex TOML 管具体研发模型设置。发现冲突先保留较窄权限、较强证据要求，并通过同一次变更修订所有受影响文件，不能静默保留多套说法。

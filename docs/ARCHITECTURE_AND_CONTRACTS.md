# 核心架构与实现合约 v0.2

## D240 日常入口合约（缩小目标有边界验证）

省略`--data-dir`时，新安装数据根为`~/.repo-conduit/data`，外层仅作容器。
只有setup可创建空容器，创建前后重查布局，内层仍由原init及runtime严格验证。
旧根任一`state.sqlite/managed.json/lifecycle.sqlite`即为旧安装候选，不解析内容
决定是否回退；坏形状、访问错误和链接拒绝。旧候选与任何内层data入口并存
均拒绝；无旧候选时外层只能为空或仅含有安装标记的data目录。未知内容及未
标记的已有data目录不作为新建许可。显式路径不追加data，也不受默认布局影响。
不自动迁移、不重新protect旧根、不增加ACL白名单；旧根不安全时继续拒绝。

`DailyUseApplication`只编排现有应用dispatcher。可信本地管理操作按canonical
root复用项目/工作副本，明确披露范围后授予既有受限操作；外部不能注册目录、
传入身份或扩大权限。同名议题按持久collaboration和逐步骤幂等键复用；snapshot
await在事务外，中断重开继续原步骤，不用长事务包装。旧正式context不被新问题
静默改写；返回原question供host说明。新课题使用新的collaboration/context。

明确的分享范围变更经仅本地管理的`admin.replace_project_share`，服务端固定
日常双方permissions并核对预期旧grant、owner与接收方。在原短事务内撤销旧
grant、更新epochs并建立successor，保留原有限期限；额外grant会联合保留被删
范围时拒绝整笔变更。重放检查successor仍有效且范围相同，不重建被撤销权限。
首次准备的逐步骤恢复仍保留；新文件/新题使用显式范围和新的材料基线，旧题
snapshot不变。目录dataPath以`/`结尾，文件为精确相对路径。

旧fixed MCP继续保留。日常MCP绑定一个本机配置的接收方，不固定全局当前项目；
每次从授权项目/题列表选取topicHandle，应用重新检查当前grant并解析其准确
workspace/collaboration/workingCopy/context/snapshot。日常工具不接受caller scope，
也不根据URL、聊天标题或Project ID推导权限；没有native chat证据时不宣称聊天
强隔离。公开项目列表不返回本机绝对目录。

日常调查将一次可信本地选择保存为可选`codexRuntimeSource`，复用
已有受核验Windows runtime来源和登录。该字段不迁移旧binding，旧包仍拒绝
未知字段。`use-codex`由本地解析来源项目的准确
workspace/profile，不能由外部参数指定命令、模型、权限或运行时。
`enable-investigation`显式建立/复用目标SQLite profile并单独授予双方调查
request/read/cancel，不改旧日常分享grant或dataPaths；普通建题不启用调查。
停用不应撤销无关授权，也不得在仍存在其他有效调查权时声称已完全停用。

四个日常调查工具先解析topic，再分派既有investigate.submit/get/result/cancel。
人类可读请求名只用于稳定幂等意图；真实权限、父调查、固定快照、上下文和
预算仍由统一handler核验。运行时composition通过可信的按workspace选择回调
获得当前profile/source；同一服务用一个串行队列发现后启用的项目，已有attempt、
failed/unknown不重排。运行中的请求始终用原owner核验闭合，不能因profile/
来源变化改投新实例。启用/停用跨步骤后必须复核实际权限与目标状态，发生竞争
保留已完成步骤并报错，不声称整组原子回滚。本候选离线/安装/模型证据分别验收。
日常CLI须等待异步调查配置/撤销完成或拒绝后，再进入原finally释放应用、
数据库和安装门；不能返回尚未完成的helper就提前关闭dispatcher。该生命周期
缺陷已被实际CLI场景复现并作两处await修正；独立窗口的类型/lint及40项定向
回归已通过，旧失败保留。该组件记录仅描述当次修复；后续安装版实际 SDK 和
网页三轮调查见页首及对应回执，不能反向提升当次证据或冒充最新包统一 LIVE。

日常MCP的`topics/open_topic.project`由application统一解析：先查询精确现存ID，
该ID必须当前可见且不与另一个可见项目的名称冲突；撤权ID不回退为名称。
仅不存在该ID时，才按当前collab.list可见集合匹配唯一精确名称，不做修剪、
大小写折叠或模糊选择，也不按创建权限消歧。解析后固定canonical ID，继续
原handler的当前授权与幂等；异步撤权只能失败，不能改投另一个同名项目。

可信本地`admin.publish_project_material`把已接受的源上下文和当前获准快照
发布为接收方专属冻结材料。外部`collab.open_from_template`创建独立scope，
只继承该材料，`inheritedFrom`记录原接受者、原revision/snapshot及未接受的
requestedQuestion；不制造本地proposal/accept。发布和建题在事务中核对来源、
接收方及当前dataPaths，撤权在幂等重放时仍生效。新材料头只影响后续新题。

`repo.read_original`沿用统一data.read和固定snapshot绑定，限额内返回完整原字节
及hash；日常MCP将其编码为标准embedded resource blob，不保证特定客户端
自动生成原生附件。`source-export`仅限本地主体，在写入和完成manifest前重新
核对artifact.export及全部所选路径的data.read，完成标记最后发布。

安装级Tunnel profile只保存已有官方客户端路径、Tunnel标识和可选本机代理；
`connect`使用固定argv和env引用密钥，前台运行官方client。dry-run不读密钥、
不连网络；未知CLI接口拒绝，不用通用shell/每项目脚本或新后台管理器。

`publishDailyDelivery`将文本、可信平台文件流或本地明确选择的原件，统一交给
既有begin/put_text/import_reference/collect_local/finalize。人类版本名确定稳定
bundle和逐步骤键，原manifest的基线、parent和文件集仍不可变；重放核对原发布，
不依赖conversation binding、cursor或聊天正文。手工导入保持manual_import。

平台原件HTTPS GET默认最多3次，所有尝试共享原15秒（可信配置最多60秒）总期限；
每次重新解析并校验DNS/public地址，只重试明确临时网络和408/429/限定5xx。
重定向、来源/地址/权限/大小、TLS与其他永久错误不重试；失败部分字节不复用。
重试只取原引用字节，不生成新bundle、不刷新总预算、不重发模型/浏览器动作。
自动下载失败时返回脱敏回退提示；用户从原来源下载后，以新的恢复版本走本地
收件，保留原失败/staging/unknown，不能将手工来源改标自动或清除未知状态。

文件失败候选补充两段位置file_reference_preflight/delivery与固定failureReason，
typed下载错误沿用downloadStage。它们不代表begin/回滚状态或重试授权，不含
URL/host/file ID/原异常。平台file_name/mime_type仍optional；缺少目标名明确
拒绝，不从URL/ID猜名称。cd373e8a真实文本发布通过，B原件失败及新诊断适用
范围见[平台回执摘要](release-evidence.md)。

该对象格式是MCP服务端合约，不等于每个客户端给模型的调用签名。当前实测
客户端把`files`呈现为本地路径数组，由宿主转换为上述平台引用；模型按实际
公开schema提供本客户端可访问的原件，不手填URL/ID、不追加未声明的path。
路径不可用时停止，不将远端路径当作RepoConduit机器的本地文件访问权限。
单个16字节自动交付已通过，见[实际回执摘要](release-evidence.md)；
这不证明`read_original`资源在客户端可被原生消费或所有文件往返已通过。

安装级来源维护提供可信本地`add-file-origin`：在短SQLite写锁内重新检查
admin.grant和既有binding，去重追加明确批准的精确HTTPS来源，保留身份和旧项，
以私有临时文件/fsync/原子rename保存；默认setup语义不变。rename后失败不
宣称回滚文件，读回区分已保存但清理未确认/未知。保存策略在重启后生效，
不热改当前resolver，不自动重连、发送、清空或替换。外部MCP不提供更新入口。

下载器可将已安全解析且被拒的url.origin交给可信本机回调；CLI只在stderr输出
固定事件与长度受限的origin，标明这是外部输入所称、尚未批准的来源。原始
路径/query/file ID/异常不输出；外部MCP回执仍不含host。日志不是授权，不据此
自动追加。此为一次安装的管理能力，不为不同项目生成来源配置或审批载体。

D240安装级官方来源策略使用可选`fileSourcePolicy: chatgpt-official-v1`，仅在
adapter/CLI解释。旧binding缺失该字段时仍为精确名单；新安装的
`setup --file-source chatgpt`显式选择，旧安装须使用本地`enable-chatgpt-files`。
启用沿原admin.grant、写锁与原子保存路径，保留身份、精确列表及保存未知语义，
要求重启；启动和普通setup不自动迁移。预设仅接受规范ASCII单标签
`.oaiusercontent.com` HTTPS来源（可显式443），根域、多层域及Azure泛域不在内。
这是官方公布域族的保守产品子集，不声称覆盖所有未来文件主机。
该字段仅在显式启用时写入；不认识它的旧包会拒绝读取，不能声称旧包可直接
消费启用后的配置或自动降级策略。旧配置启用此能力必须由本地用户明确选择。

本地`check-file-network --file-origin HTTPS_ORIGIN`先只读私有binding，在runtime/
SQLite/application创建前检查来源并进行一次有界系统DNS观察，不查询任意未
允许的来源。报告只有public_ipv4/fake_ip/non_public_or_unsupported/dns_unavailable
和固定指导；public不代表TLS或文件成功。结果等待最多5秒，不保证取消OS查询。
当前只读CLI限flat安装，managed根明确拒绝，不绕过其正常generation/gate规则。
198.18/19只能提示疑似Fake-IP/保留地址；官方主机才给Mihomo fake-ip+blacklist
合并追加`*.oaiusercontent.com`的指导，whitelist/rule不得直接套用。不写共享
代理、不增加DNS服务或下载代理；既有公网IP pin/TLS/重定向/大小/重试保持。

后续源码88b7984修正并发CLI的启动恢复竞争：调查store以内部同步入口执行两类
原恢复，SQLite每次争用等待固定2000ms，finally恢复零等待；首次cleanup不重复
reconciliation，周期tick与普通运行期事务不变。不跨异步资源关闭维持等待设置，
不新增模型重放、队列消费、授权或外部DTO。该修正已通过定向/编译CLI组件与
独立复审，该次未验证安装版本，也不提升完整全集/包/LIVE门禁。见
[启动恢复回执摘要](release-evidence.md)。

2026-10-28官方CLI实际升至0.165.0-alpha.1.2，使旧0.164精确准入拒绝启动。
本候选仅同步TS/C#精确版本，保留历史codec及所有配置/权限/owner边界，不迁移
旧slot或消费旧queued。精确schema对照、19项定向及额外1项真实配置读取握手、
类型/lint和独立审查通过；完整测试、最终包及新版本模型调查尚未通过。见
[本轮兼容回执摘要](release-evidence.md)。

随后完整批次确认上述原生检查通过，但暴露可选prepare-only诊断遗漏固定目标
参数。该诊断现沿同一内部选择器追加第8参数，不增加外部输入，仍仅接受私有
合成fixture并prepare→stop；不返回writer、启动能力或生产资格。9项定向及
类型/lint、独立审查通过，完整批次/包门禁仍未通过。见
[参数修复回执摘要](release-evidence.md)。

可信普通CLI可在既有错误JSON中附加`privateDirectory`，仅从已知私有目录错误的
直接cause按精确字段与枚举重建component/operation/reason；不转发原异常、路径、
SID、环境或嵌套cause。MCP/HTTP等公共错误投影不改。这服务当前安装E2E的权限
检查故障定位，不改变授权、ACL、超时或重试。该序列化切片已通过3项回归及
类型/lint和独立静态审查，尚无新包实测；权限故障根因仍未知。见
[本轮回执摘要](release-evidence.md)。

规范主文档：[DESIGN.md](../DESIGN.md)。本文描述已实现应用及完整设计的合约；实际命令、操作与参数以所选安装版本的公开入口和源码为准。带日期或 D 编号的增量说明保留其当时范围，不将历史“待实现/待实测”套用到其他已验证路径，也不把规范文字当作未实测能力的证明。

## 1. 技术与源码组织

首版用 TypeScript strict＋Node 24＋npm lockfile，SQLite 管短事务状态，文件系统保存内容对象和 staging。一个可安装包、一个本地协调服务，不引入 Redis、消息总线、微服务、工作流引擎或新的模型总控。M00 固定实际依赖版本和平台范围；对 SQLite 驱动的选择做一个事务/打包 smoke 后定案。

```text
src/
  core/
    identity/       Workspace、WorkingCopy、Endpoint、Binding
    collaboration/  Collaboration、ContextRevision、Exchange、Decision
    policy/         Grant、effect、scope、budget、disclosure
    evidence/       Snapshot、ReadResult、Evidence
    investigation/  Request、Attempt、Result、cancel/recovery
    artifact/       Bundle、Manifest、delivery validation
  application/      同一套 command/query handlers、统一授权与事务入口
  ports/            repository、conversation、investigator、transfer、store、clock
  adapters/
    storage/        SQLite、CAS、migrations、recovery
    repository/     文件/Git/可选语义工具
    codex/          首个 investigator + host 映射
    chatgpt/        conversation + 平台文件映射
    mcp/            HTTP/stdio 等传输映射；不重复业务规则
    host/           Skill/CLI bridge
  cli/              本地管理和用户操作
  runtime/          调度、租约、生命周期、日志与 shutdown
skills/             实现阶段提供的真实 host skill，不是现在的虚假调用入口
tests/
  unit/ contracts/ integration/ security/ faults/ e2e/ boundary/
```

依赖方向：core 仅依赖本项目基础类型；application 依赖 core＋ports；adapters 实现 ports；CLI/MCP 转换请求后进入 application。不得让 core import SDK、浏览器 selector、ChatGPT URL、Codex native enum 或具体 model ID。JSON Schema/DTO 与 SDK 类型在边界转换，关闭未知权限字段。

## 2. 身份、命令和错误的统一外壳

Wire DTO 使用 snake_case、`schema_version = "0.2"`，内部 TypeScript 可统一 camelCase。opaque ID 由服务端随机生成，不根据名称、绝对路径或 provider URL 直接计算权限。主要前缀为 ws_/wc_/col_/ctx_/snp_/obs_/ex_/inv_/att_/bun_/dec_/gr_；前缀仅用于诊断，不代替类型校验。

对有副作用命令，外壳包含 operation、idempotency_key、绑定句柄和 payload。principal、audience、grant、local-management 身份来自验证过的传输上下文，禁止从模型 payload 取 authority。允许固定 session handle 引用已绑定对象；省略字段不意味着“最近项目”。

`RequestContext` 最少包括 authenticated_principal、transport_audience、verified_binding、request_id、permission_epoch、disclosure_recipient。handler 顺序固定：解析→验证主体/对象关联→能力→授权/预算/披露→并发与基线检查→执行→记录实际回执→再次检查结果披露权限。

D206 的现有 Tunnel stdio 仅为待用户确认的合成测试候选：平台已配置的
consumer contexts 可作为专用受限连接主体，不能自称独立个人账号或原生会话。
固定本地 binding、当前 grant 和统一 dispatch 继续负责对象范围与披露。
关联范围变化须先撤权并重新核查；未知远端或匿名 HTTP 仍拒绝。
截至此候选原记录时，尚未完成真实产品 Tunnel 调用；2026-10-27后续同一安装级
连接的真实网页调查链另见本节开头D240回执。后续组件不等于完整LIVE证据。

对未授权或不存在对象统一返回不泄露存在性的 `NOT_AVAILABLE`；其余闭合错误包含 INVALID_ARGUMENT、UNSUPPORTED_CAPABILITY、CAPABILITY_UNVERIFIED、BASELINE_MISMATCH、STALE_CURSOR、CONFLICT、LIMIT_EXCEEDED、RATE_LIMITED、AUTHORIZATION_REQUIRED、RECONCILE_REQUIRED、RECOVERY_REQUIRED、TRANSFER_INCOMPLETE、CANCEL_UNCONFIRMED。错误含 safe_message、retry_class（never/safe/reconcile/user_action）和 correlation_id，不含秘密、真实根目录或下载凭据。

同一 principal＋transport audience＋固定 workspace（本地管理操作为管理域）＋operation＋idempotency_key 与规范化 payload hash 原子关联。collaboration 和全部目标绑定对象必须进入规范化 payload hash；创建前尚无 collaboration 的命令也可据此幂等。相同内容返回原对象；不同内容 CONFLICT；授权撤销后的重放重新检查权限，不能直接从旧响应缓存泄露正文。目标保留期至少覆盖对象生命周期；清理需保留可避免重复副作用的 tombstone。

`conversation.sync` 虽然只读外部聊天，但会写入本地消息/附件索引，属于 state_write：携带幂等键，并按 binding＋原生消息标识＋消息版本去重。再次同步新内容使用新的请求键；重放同一次同步返回原回执，不重复导入。

完整操作清单在 [operation-catalog.json](../contracts/operation-catalog.json)。外部发现列表只显示当前主体获准能力；工具隐藏不是唯一防护，直接调用也要拒绝。聚合 supertool 不可成为更宽权限旁路。

## 3. 领域对象、关系和持久化

| 聚合 | 必需关联 | 核心不变量 |
|---|---|---|
| Workspace/WorkingCopy | operator、注册根目录、canonical real path | 外部不能注册根；同一路径变化也要重新核实 |
| Endpoint/Binding | adapter、account identity、native opaque session、workspace | 原生聊天不得跨 workspace 复用；账号变化使验证失效 |
| Collaboration | 一个主 workspace、参与者、目的、状态 | host thread 可为空，支持网页独立发起 |
| ContextRevision | collaboration、parent、目标/约束/决定/未知/证据 | 不可变；external 提议不能直接改正式约束或权限 |
| Snapshot/Observation | working copy、manifest、源一致性、排除 | live 与固定快照分开，不混页、不虚报一致性 |
| Exchange/Message | collaboration、binding、context、native correlation | 一轮完成不结束咨询；只保证已观测历史 |
| Investigation/Attempt | collaboration、snapshot、context、profile、预算 | 每 attempt 记录原生任务、权限和终态；不递归外部咨询 |
| Evidence | scope、source hash、位置、classification、receipt | 模型自述与 adapter 记录的执行事实分开 |
| Bundle/Manifest | collaboration、workspace、baseline、parent bundle | published 不可变；收齐文件不是语义批准 |
| Decision | bundle/建议、actor、理由、当前基线 | external 仅提议；实施授权不从 accepted 自动推导 |
| Grant/Approval | principal、audience、对象范围、op、预算、expiry | 可信本地管理；默认拒绝、即时撤销 |

SQLite 表按这些聚合分组即可，不需要一对象一服务。建议表：workspaces、working_copies、endpoints、session_bindings、collaborations、participants、context_revisions、snapshots、messages、exchanges、investigations、attempts、evidence、bundles、bundle_files、decisions、grants、approvals、idempotency_records、outbox、leases、audit_events。用 FK、唯一约束和 schema migration 测试维护关系；表名可等价调整，领域不变量不能改变。

单次 DB 事务不跨浏览器等待或模型运行。状态更新包含 expected_revision；冲突不得 last-write-wins 覆盖。对话发送和调查 dispatch 使用持久 outbox＋lease/fencing，租约失效的 worker 不得提交终态。

## 4. Workspace、快照与读取

注册是本地命令；canonical path、symlink、平台大小写、Windows 设备名等经过统一 PathPolicy。正文读取和搜索包括控制文件、元信息、错误路径的披露策略；敏感路径拒绝在命中输出前执行。TOCTOU 需要安全文件句柄/读取后验证或不可变副本，不仅调用一次 realpath。

重要评审默认固定输入：

- `frozen_git_tree`：固定 object ID 的树，只表示该 commit，不包含其他工作区未提交内容。
- `frozen_local_export`：来自确实冻结的源、文件系统快照或明确构造的受控副本；记录过程和 manifest。
- `best_effort_capture`：对活动目录复制、记录逐文件 hash；可冻结所得副本继续读取，但不能宣称它代表源目录同一瞬间的一致状态。
- `live_observation`：每次读取原始 hash/time；新内容是新 observation，不改写旧证据。

dirty changes、staged/unstaged、untracked、submodule/LFS、生成文件、敏感排除都有清单。source consistency 与“接收副本内容不再变”分开。不能用两次 HEAD/status/mtime 相同证明全树原子快照。

读取合约：`read(binding, snapshot_ref, path, range, cursor?) -> content, content_hash, line_range, completeness, continuation`。换行/编码保留原始 hash；引用行号说明解码方式。文本过大按字节与行数都限制，包括第一条超长行；二进制明确拒绝文本读取。cursor 绑定 actor、scope、snapshot、query 和位置，签名或以不可伪造服务器句柄表示。

搜索合约返回范围、排除类别、后续入口、未完成原因。不得用一次 top-k 无命中宣告全仓不存在。读取/分析 pipeline 必须能展开完整函数、调用方、状态/持久化、错误/取消和测试，不用“读取文件多”代替链路覆盖。

外部 MCP 对 collab、context、repo 和 investigate 的已实现操作声明具体、封闭的 payload 字段；其中 context 提议正文和调查输入也声明嵌套字段。该发现 schema 帮助客户端构造请求并提前拒绝结构错误，不能替代统一 dispatch 的 grant/范围/幂等检查、core 的路径及预算规则，或证明真实平台已调用工具。

`repo.read` 的MCP边界另声明既有读取结果的封闭outputSchema，成功时同时提供
原JSON文本和与之等值的structuredContent：包含正文、完整文件hash、字节/行范围、
编码、完整性、可选continuation和已有受限调查分支的toolReceipt。两种表示来自
同一次dispatch结果，不增加读取或权限；完整/空文件仍省略不存在的游标。拒绝
访问或结果结构错误仍只返回既有脱敏错误，不附结构化内容。其他操作的输出不变。
这是向后兼容的传输候选；SDK通过不证明ChatGPT网页已正确消费结构化结果。

## 5. Conversation Port 与人类控制

ChatGPT网页观察的会话地址接受精确普通`https://chatgpt.com/c/<UUID>`与已观察的
Project聊天`https://chatgpt.com/g/g-p-<32hex>/c/<UUID>`，以及实际新建聊天观察到的
`g-p-<32hex>-<slug>/c/<UUID>`。可选slug限1–64个小写ASCII字母/数字和单连字符，
不接受空、连续或结尾连字符。路径仍以实际聊天UUID、
正常账号观察和完整官方历史核对；Project ID仅校验路径结构，不选择产品工作区
或授予权限。Project根页不是已有聊天，不能绑定；query/fragment和错绑会话拒绝。
相同路径兼容适用于会话与两种既有附件观察，不改变下载完成/原字节要求。

2026-10-03 的 `chatgpt/host-observation` 只解析官方 host read_thread 的已观察
页面：保留原生消息身份、角色、正文、状态、顺序与分页，拒绝未知字段、截断、
附件和不支持的诊断。输入没有账号字段，因此 accountIdentity=unknown；分支和
生命周期均 unverified。该结果不是 ConversationPort 的完整 delta 或发送回执。
正常账户 UI 可以成为非 UUID 账号标识的观察来源，但一致的私有映射、每次使用
复核、账号变化拒绝以及实际发送/历史覆盖仍需验证；UI 指纹本身不授予权限。

端口最小能力：`bind`、`send`、`observe`、`sync_delta`、`request_handoff`、`resume`；每项独立 capability。source account/native session/turn/message 身份必须实测。没有可靠 message ID 时保留较弱 observation，不擅自匹配“最后一条看起来像答案”。

发送：保存 prepared→取得 binding lease/epoch→再次检查 account/history/control→标 sending→调用 provider→关联原始用户消息和新回复。网络异常但可能已发出则 reconcile_required；未知状态不自动 resend。远端不提供幂等或原子历史比较时明确保留该限制。

接管：本地可信动作把 control 转 human_controlled 并递增 epoch，停止自动发送，不撤销原有代码读取。用户在网页仍可自主讨论。恢复先 syncing，读取新增消息和附件，检查编辑历史/分支/账号/正在生成；未能完整确认则 reconcile_required。本地 lease 不能锁住网页的人，发送前后的二次检查只能减小风险，不能声称远端 exactly-once。

观察失败、无效增量或校验异常须在起始 binding/revision/epoch 仍匹配时持久
收紧为 reconcile_required；不得只报错而保留自动发送许可。并发接管/继任优先，
不覆盖其状态；保留 cursor、epoch 和未知 sendIntent。即使下次观察恢复有效，
普通 sync 也不能自动恢复发送，须由可信本地显式 resume。迟到的明确拒绝可以
结算发送事实并清除对应 intent，但不能解除先前的观察隔离。见 D201。

本地`conversation.resume`可选`acceptUnknownSendIntentId`，仅用于显式接受已观察
历史，不能证明旧发送成功。要求当前reconcile_required、唯一unknown原intent、
无pending receipt，以及可信adapter确认同provider/account/chat、完整无编辑且
停止生成的新历史和cursor前进。普通sync/resume的严格发送关联不变。
resume事务只将原send工作流status结算completed，保留原send_text、payload_hash、
outcome和unknown回执；新回执unknownSendDisposition记录accepted_observed_history、
原intent、from/next cursor及新增原生消息ID。事务同时采纳消息、清活动intent并
递增epoch，不提供completedSend或human_verified，不发送任何消息。

一个 Collaboration 对每个 participant 有一个当前 binding；换聊创建 successor，旧 binding 为 superseded，ctx 和 evidence 可溯源。不得将 provider 的隐藏思维存为所需上下文。Provider 会话是原始聊天事实源，核心只保证已观测并记录的部分。

首版 `conversation.successor` 仅接受本地 host/CLI 命令，输入旧 binding ID、预期 epoch/revision 和同范围既有 ContextRevision ID。可信本地适配器观察新原生会话；存储事务核对授权、同 provider/account、不同且未复用的 native session，并保留 parent 关联。新 binding 从 `human_controlled` 开始，须完成实际背景交付和原生同步才可恢复受管理发送。旧 binding 只允许当前授权下重放已完成命令回执；新的副作用一律拒绝。这个状态迁移本身不证明 provider 已收到背景或网页人工接管完成。

`context.read` 的空 payload 取当前 head；`revisionId` 取指定不可变 ContextRevision；`proposalId` 取提议。两个 ID 不可同时提供。三条读取路径均重新检查当前 `context.read` 权限，版本查询按 workspace/collaboration/ID 三元范围过滤；继任绑定记录的旧版本即使 head 前进也可准确重读。

人经网页表达的“批准”是讨论内容，不成为新增权限授权。普通技术观点可进入 ContextProposal，主 agent 依原授权确认后形成新的 ContextRevision。

前台 `host-conversation` CLI 复用单一 application handler，注入可信 host
adapter。绑定观察接收明确 workspace/collaboration；账号原值映射与完整
不可变基线位于同一私有 SQLite。SessionState.cursor 为唯一采纳指针。
固定 observe/submit JSONL 动作不携带任意脚本；submit 的 prepare/commit
之间由应用复查原 grant、epoch/revision 和 sending intent。commit 回执
保守为 unknown，原生新增 user/reply 对才可结算。EOF/超时先落库，再关闭
适配器存储和安装 runtime。备份恢复预检验证新增引用。范围与步骤见
docs/host-conversation.md；该桥实现不自动构成 LIVE 或 human_verified。
富文本和官方同消息 content reference 可通过可选 `native_message_copy_v1`
正文观察兼容：固定非敏感剪贴板标记、同原生消息 Copy、前后身份/正文一致；
完整 API 正文须与 Copy 相等，精确同 ID 引用保留原始来源并记录 Copy 正文。
不把引用或 DOM 文本伪装为 API 原文，不读取原剪贴板；账号、完整历史、基线
及 unknown send 守卫不变。观察增量不改变权限、主 handler 或数据库 schema。
内联图/代码可用 `native_message_rich_copy_v1`：同账号/chat/message 的完整
DOM 图属性/data SVG、代码行及文本前后稳定，并与heading及实际媒体数量
对应；原始复合内容留既有observation并纳入version。text只是原生Copy文本
部分，不能把平台Copy遗漏的图或代码换行冒充完整纯文本。当前支持范围及
未知媒体/编辑器拒绝规则见docs/host-conversation.md；不执行媒体、不改schema。
附件回复使用独立的 `native_message_attachment_copy_v1` 观察变体，前后完整
附件 DOM 必须一致，并与同账号/chat/message/turn 的完整 host inline 引用
一一匹配。文件引用使用实际 token 索引匹配，资源卡片按唯一文件名及组内顺序
完整消费；仅 file_reference token→filename，PNG/资源卡片 token 和其他字符
保持。允许有界安全 producer 子目录，仅作为身份而非可获取地址。完整展开的
resource_card_group_v1 严格核对行位置、祖先、下载控件与配对类型标签，折叠、
未知、隐藏或加载内容拒绝；稳定版本绑定有序附件身份而非全页回合或下载指纹。会话 prepare 与
下载分别传入预期草稿和空 composer；不扩大下载权限或替代完成对象。
上述会话同步变体仍拒绝重名附件；下载选择的扩展不改变其 filename Map。
详情及当前仅组件验证的边界见 docs/host-conversation.md。

正式host可能只给出最近十条，即使page声称无后续页。既有绑定可复用已校验
baseline的原native文本，与当前窗口唯一连续完整回合重叠恢复前缀；重叠须
达到旧尾部，新增消息必须全部由当前正式窗口覆盖，完整freshUI/Copy仍逐条
复核合并历史。原host页不修改，内部nativeSourceProjectionV1只存于既有
不可变观察并受record_hash保护，拒绝调用方提供投影。完整页覆盖全部旧ID/
角色/回合时保留原完整页校验，空基线行为不额外收紧。窗口缺口、旧编辑、
身份变化或不匹配的Copy仍拒绝。存储JSON节点上限为20000，1MiB/depth40及
纯JSON限制不变；双版本附件原始观察11301节点/277275B需此修正。无表结构
变更；旧二进制读取超过旧节点上限的新记录不支持，恢复须使用修后版本。

长聊天的 UI 虚拟化允许既有绑定使用显式 uiWindows 原始观察数组，前后两次
真实官方 host 页须稳定。各窗经过原账号/chat/composer、消息ID/角色/正文/Copy
校验，正序覆盖全部合并历史，至少一完整回合重叠且逐窗向前扩展；缺口、倒序、
重复或重叠变化拒绝。保留每窗和前后原始 host，不拼造单页；既有总消息/JSON
预算不变，无 schema 或 action 变更。原单窗口兼容和 unknown-send 精确关联
条件不变；新观察格式需要修后版本，不借给旧安装包作为已通过的统一验收。

同一桥可由本地启动参数启用 `artifact.collect_browser`，固定 download 动作核对
当前账号、原生附件来源及原下载对象完成路径。稳定 capture ID 绑定幂等 scope，
附件来源可为原 host/UI 观察，或显式版本化的完整所选消息 DOM 观察；后者核对
真实原生祖先、角色/完成状态和全部支持内容，未知结构拒绝。来源类型与全部
相关消息块绑定指纹，已有 intent 不得换源；此 DOM 输入不是历史同步或 cursor。
`artifact.collect_browser` 可选 `attachmentIndex` 为完整所选消息中已识别下载
入口的零基顺序（0..63），同时核对 basename；省略时继续要求全部附件名唯一。
有界 `rendered_file_links_v1` 保留 DIL 完整可见正文和文件链接祖先；当前仅将
无资源卡的 ZIP Open 链接识别为入口，其他 Open 链接须与原生资源卡的文件名
多重集合相等，仅作为预览别名。随后资源卡按行顺序提供下载入口。当前双版本
夹具的索引为 ZIP v1/v2 的0/1、五个v1资源卡的2..6、五个v2资源卡的7..11。
可见但未知的交互、隐藏内容、生成中、折叠卡片仍拒绝。Open标签只证明入口，
不证明下载；仍须本次原下载完成对象与接收方预期 hash/size。
索引进入业务幂等 payload、host target、capture input/hash 和 retry/reconcile
完整目标比较。旧输入不补默认0，可按原schema3读取；旧程序不支持含新字段的
记录，恢复含索引的记录须使用修后程序。新字段不改变原 input/state 或历史unknown。
首个直属元素中的严格空隐藏 SPAN 由 `empty_hidden_span_v1` 显式记录，
可信观察器检查零内容；节点及祖先进入指纹，其他隐藏内容仍拒绝。
私有输入固定原 grant/账号/目标/绑定 fingerprint。prepared→capturing 先持久化
再释放一次点击；unknown 只对账原对象。
prepared 仅因严格确认的来源变化可 CAS 至 aborted_before_capture；原 input/hash
保留，旧键不可重用，不自动重试。schema2兼容v1只读检查及事务迁移。
verified_candidate 不等于已收件，字节经统一 Objects 落盘后才提交文件收据。
已落盘目标仅同 capture 恢复，换键不重击。
显式本地reconcileOnly:{captureIntentId}可用新业务键及当前有效grant恢复原
reconcile_required/verified_candidate；完整目标和身份匹配历史输入，历史
grant/input/hash不改。只对账原对象，不prepare/commit/新关系；沿原锁、
sourceIdentity及最终围栏检查提交收据。此分支不让普通重试忽略原grant。
schema3 为本地显式 `retryOfCaptureId` 保存唯一前驱/后继和可信 host 的实际
browser/原 tab/新 tab 上下文；旧 input/hash/state 不变，旧程序拒绝新 schema。
只在新 tab 原完成对象可独立关联新动作时使用，业务输入不能伪造 host 上下文。
同 bundle 的既有跨进程锁覆盖 claim、capture、权限复查、落盘与回执；已有
staged 目标拒绝新的 claim，同 successor 可恢复落盘后尚未提交的原收据而不
再次点击。旧前驱在最后落盘前也须同步检查限制。新 grant 有效且
目标/身份相同；只豁免该前驱的 root 占位，不清除 unknown 或放宽文件歧义。
未决 intent 或错引用阻止恢复预检。首次无会话绑定的本地导入只记录明确来源，
不继承控制；有绑定时核对 host_controlled/epoch/revision/cursor。具体范围见
docs/host-conversation.md；原 ZIP 安装后自动收取及无动作重放已实测。
2026-10-19同议题合成bundle v1/v2已分别在9eab46c/69567ec安装包收齐、发布、
导出、独立审查及本地决定回读，并确认v1不变。此为不同固定包的子场景，
统一版本完整LIVE及release仍待完成。

## 6. Investigation Port：与实施分离

**D239当前定位：**首版信任个人用户选择的本地runtime，复用其正式认证与
原生权限/沙箱；本产品负责项目范围、只读工具入口、预算、结果与恢复接线。
不要求额外自建全进程隔离或通用凭据/网络代理。原生限制须在实际产品路径
上有效；不因“个人自用”开放网页任意命令、复制凭据或放行已知越权。
当前Codex版本的最终消息可由同thread/turn的完整 `item/completed` 送达，
再由明确 `turn/completed` 确认成功。`itemsView` 只描述该终态载荷缓存，
summary/notLoaded本身不提供候选内容；此前完整完成消息仍可沿原解析器、
读取回执与快照校验发布。冲突身份、晚到新项、async/问题消息不得发布。
本地CLI的MCP/HTTP启动可明确选择已准备的workspace/profile；组合层核对
本地管理员、当前revision和固定binding，外部请求不携带native选择。网页
submit只持久排队；默认本地`run-codex-investigation`只运行指定requestId。
D239后续代码批次为显式本地`--codex-managed`接通同一路线后台调度：仅
mcp/serve-http、完整workspace/profile选择且当前授权的未尝试队列可运行，
包含服务启动前queued；不启用时保持原行为。它不增加外部权限或grant，
不重放有attempt的失败/unknown。原handler取消及原owner收尾保持；本地信号关闭
不冒充原参与者取消。配置范围检查也在返回已有终态之前执行。
可信本地配置可另含runtimeSource={dataDirectory,workspaceId,profileRevision}，
显式复用来源的既有正式登录。来源状态库只读，双方当前本机admin.profile、
当前static_readonly_v1 revision均检查；执行预算来自目标当前可信profile，并
固化于request、owner及持久读取/回合计数，不由来源旧预算替代。原helper准备之后、写start
之前再次检查且runtime身份不变。来源管理权限约束选择，启动后的数据与结果
仍由目标grant/handler约束。目标request/snapshot/context/claim/结果不改为来源
身份，旧unknown不清理；不复制auth、不提供外部runtime字段或自动调度。
认领新请求前还须确认固定Codex可执行文件存在且为普通文件，并通过既有
helper/manifest/源码hash检查；已知缺失先拒绝，保留queued且不创建attempt或
owned session。该有限可用性检查不启动进程、不证明协议兼容，也不改变原
owner关闭规则；检查后组件仍可能变化，原native启动与关闭核验继续负责。
当前实际启动二进制精确固定为官方 Desktop CLI `0.165.0-alpha.1.2`，由
`windows-desktop-target.ts` 的版本常量控制。协议 codec 的兼容身份仍是
`windows-desktop-codex-0.163.0-alpha.11`；该历史命名不是当前二进制版本。
位置由adapter在实际OS用户
目录的官方bin直接子目录（最多8个）及一个历史路径中选择唯一匹配版本，
不按mtime挑选，也不接受外部请求指定路径。领取前固定的路径传给原生helper，
helper重新核对官方路径、无重解析及精确版本后启动固定配方。此前0.162的
完整launch仅保留历史读取与原身份关闭，不能获得新启动权限。model loader
只读接受已支持历史 slot 的原 recipe 及完整 config/hash；历史 0.162/0.163
迁移记录保留，不改写旧 runtime.json/auth 或提升旧配置资格。兼容身份与实际
启动二进制分别核对，不按标识字符串猜测当前 CLI 版本。
已核查 schema 中的 partial_answer 仅为非最终项；唯一final、终态、权限、roots和
工具边界检查保持。0.165 的定向 schema/配置读取和 a38 离线/安装结果已记录；
此前真实调查保留其原包和环境，不能据此宣称最新包的新模型调用或统一 LIVE 已通过。
独立owned路线仅在首次观察原生turn ID且当前owner/epoch、租约、请求权限与
冻结profile仍匹配、未取消或进入恢复时，将公共queued/claimed投影为running。
这里running表示原生turn已观察且调查尚未结算，不证明响应其余字段有效或模型
成功。原nativeRef/startedAt为空时保持为空；active phase和实际ID journal不变。
迟到ID仍保留用于对账，取消、恢复、过期或已关闭记录不因观察被重新启用；
重复观察不二次投影。最终状态与槽位释放继续只由原owner关闭和既有结算决定。
固定helper启动前失败仅保留白名单错误与原对象未启动证明，详细条件见
DESIGN第10.3节。新Codex owned session关闭kind为job_closed或not_started；
not_started要求原claim/session/epoch仍有效、无native journal和候选，结算
failed/cancelled、result=null、terminationConfirmed=false。prepared_closed仅在
无start尝试时取此kind；未知发送及旧unknown不由空nativeRef或错误名推定关闭。
原owner的预算从prepare起算，coordinator不能在start后重置为满额。内部
剩余时间取原wall/monotonic较早期限，工作在既有预算内为interrupt/drain各
预留最多5秒；正常RPC和在途读取的最终披露共用较早工作期限。freshness后
剩余不足不写start，期限变化只可缩短；清理等待计入同步发送耗时。不恢复
撤权/取消后的正常发送或读取，也不把预算耗尽/EOF当作owner关闭事实。
下列D238及之前记录是旧候选事实，保留但不再作为所有调查实现的必经前置。

**D238历史决策：**以下tools诊断历史不再自动形成新的执行前置。产品要求
真实调查的范围/凭据/工具网络边界、可信读取及结果、原身份终止与安全恢复；
自然EOF是关闭策略选择，未被DESIGN规定为独立发布关卡。采用原owner受控stop
仍须另行实现/核验原group及bridge，不追认旧EOF失败或未知回合完成。
现有WSL/bwrap空HOME/断网配方没有认证/provider通路；WSL读取注册、持久owner
与结果结算也未接通。不能直接复用Windows目标或Claude队列冒充已支持。
先解决这些具体支持输入，才规划真实调查候选；不再为孤立EOF/FD诊断重跑实机。
当前observer拒绝和全部安全合约仍有效，未删除或放宽；见docs/DECISIONS.md D238。

D238 S0静态核查进一步确认：可信adapter正式使用凭据允许，模型工具取得
凭据不允许。固定0.157.1的模型请求在AppServer运行路径内，dynamicTools是
追加集合而非排他工具白名单。当前整体断网候选不能直接进入真实调查；
需要先决定同路线认证/模型通信与全部可调用工具的实际隔离边界。
该结论不批准边界修改或实机；原资格门禁、失败记录和恢复语义不变。

contained initialize 诊断仍仅在 tools，不进入 application 或生产资格。
本次 f8ba2c51 在写前观察失败，未执行 EOF 路径。工具只增加固定 read-site、
PID/FD 与闭合异常类别/有界 errno 的失败定位，不输出异常消息、路径或 traceback，
不忽略缺失项、不自动重试。成功读链清除临时定位；不能由旧部分摘要补齐资格。
固定观察器核对同一原 unit 的 bwrap→Node→native、七类 namespace、当前
backing/挂载、四键 Node/六键 native 环境、进程状态与 FD/stdio；两次完整快照
稳定后才允许既有 explicitGatewayOauth 双帧 writer。异步 helper 保持桥失败处理，
每帧复查失败/关闭/源码变化；未知 FD 或身份拒绝，不自动扩权限。
helper 无 close 只报告 unconfirmed，不证明 Linux 退出；原 group 与 bridge
实际终态分别核对。单次d018c7ab在协议写入前因POLL_TARGETS失败，实际资格未完成。
tools的epoll修复要求完整有界fdinfo；明确零watch可接受，非空watch绑定当前
目标dev/ino，不证明历史open-file-description来源；未知格式/设备编码拒绝。
其他FD限制与双快照保持。修复仅离线验证，新实机仍需授权。具体范围见 D236。

修复后单次d5e41f32通过原epoll点后FD_UNKNOWN失败，无协议写入。Node的
io_uring标签及额外pipe类别尚无来源/权限资格，不新增允许类型；部分FD摘要
与清理成功不能替代完整稳定payload资格或握手。两次失败已升级边界分析。

固定tools候选现有filter新增io_uring三syscall拒绝，initialize在bwrap内复用
已挂载Python封口后唯一exec原Node。observer以固定seal hash/完整argv与outer
stdio object/direction/ns元数据独立核对；Node最多4个无外部别名的FIFO读写对。
native extra pipe仍拒绝。没有新增挂载/网络或生产接线；32项定向与独立复审
仅证明离线候选，实际seal/fallback/FD形态未知，不能视为生产investigator隔离。

随后00710e6上的单次19d7c289实测通过固定写前payload七项事实及稳定双快照；
该窄观察不覆盖后续模型执行。initialize响应后合法configWarning裸通知被
原slash规则拒绝，initialized未发送，计划闭环未完成。transport仅对固定
wsl-codex-0.157.1增加schema校验的具名warning数据例外，保留未知裸method、
带id请求、frame/总量/通知数拒绝。warning路径/文本不能用于执行或授权；
不据启动bwrap警告安装组件或扩大PATH/挂载。54项离线回归与类型/局部lint
通过不替代修复后实机；原13份失败证据和原unit/bridge收尾独立保存。

之后a0b1708的074a4d47已观察真实固定两帧发送与initialize响应，但initialized
无消费ACK。Windows end后原unit四次仍running，stop后清理不可补作自然退出。
tools诊断补Windows finish（非native EOF）、unit RuntimeMaxSec之前的有界原
身份自然终态观察及实际clean bridge close区分；其他身份/stream/error/预算
仍拒绝。18项离线验证不替代修复后native收尾，生产调查资格仍关闭。

中间候选的尾流缺口经独立审查发现并修复：stdout EOF若留有partial JSONL
即失败，transport必须持续解析至bridge drain后才主动关闭，不能漏过迟到
非法帧。最终60项受影响离线回归与类型/局部lint通过，未重复真实预检。

2026-10-11 的 WSL containment 候选仅存在 tools 中：固定 bwrap 空 root、
狭窄只读运行依赖/合成 source、空 tmpfs HOME/scratch、必需 namespace 和
内核 key API deny-filter。专用 tools 预检协调器已执行一次，但 manager 环境
错误使其在固定依赖核对后、payload 启动前停止；无生产接入。可信管理平面
现有固定 DBUS/XDG 环境，env-i 在 bwrap 前移除，payload 仍不可访问 host bus。
初次修补只经离线验证，其后固定 canary的实机范围见下段。受信 launcher
前缀、最终 payload/FD/挂载/网络身份与原 unit 收尾须按实际payload分别观察。
保留原三键 root 审计，
bwrap 的 PWD 使该候选 payload 初始环境为明确四键，不能混用旧事实。
全断宿主网络候选不提供生产 provider 连接；必要连接与任意工具网络的
区别仍待后续真实验证。见 D236 与既有 WSL 续接回执。

同日修复后的固定 Python canary已实测：宿主阳性对照、16项事实、7类 namespace、
挂载/FD与原 unit/bridge收尾通过。此证据仅绑定eeee80f配方及该合成进程，
不借给Codex AppServer/模型/生产owner/CAS；下一步先检查已有helpLaunch的
实际目标接口，再准备同配方零模型握手。旧失败保留，不提升release门禁。

35db759的首次contained help已返回真实帮助文本，但原unit的ControlGroup退出后
清空使诊断终态/stop被拒绝，Linux bridge未确认退出，整次仍failed。tools修复
不放宽running身份：只对同boot/UID/Id/Invocation、loaded/active/exited/MainPID0，
夹查两次unit观察并检查保存的原group路径empty/absent，才允许诊断终态与条件
收尾；当前空ControlGroup本身不是证据。后续新boot中原unit/group缺失不补旧bridge
EOF或退出码。修复仅离线验证，cleanup仍非原子，不进入生产CAS或调查资格。

其后fd27a3b单次0c588d46修复后help-only已观察完整help、保存的原group为空、
同Invocation退出、stop后unit not-found及两层bridge exit0。该诊断闭环通过，
cleanupAtomic=false、containmentObserved=false及生产门禁保留；此前失败不改。
后续零模型握手准备复用既有qualification runner/transport/writer，不新增通用
relay。实际Node/native子进程、环境变化及FD/namespace/挂载须绑定当次payload，
不以unit MainPID、旧三键环境或Python canary代替。尚未执行contained握手。

提交字段：collaboration、context_revision、snapshot_ref、question、scope(paths/symbols/tests)、requested_outputs、允许的 profile_ref、budget_ref、parent_request。外部不能传 shell、executable、模型、环境变量或任意工作目录。参数白名单和实际权限均检查。

Managed Investigator 在用户本地预授权后可独立运行，不依赖主 host 模型空等。Codex 首个 adapter 使用实测 App Server 合约，生成/检查目标版本 types；不得凭旧文档猜 RPC。Host-serviced 是另一个显式能力等级，不冒充独立后台服务。

默认调查是静态只读：一个被冻结的授权源码视图、可写 scratch、受限可信工具、无不必要 host 插件、无任意网络、不能写源码、不能递归创建 agent。模型服务连接由受控适配器使用；“禁止任意网络”不应误写成“禁止一切 provider 连接”。依赖下载安装、构建、测试和动态追踪需独立验证 profile，不能藏进 read-only inquiry。

提交立即返回 request_id；MCP 调用不无限阻塞。状态/结果读取分离；server 完成不会自动让外部模型继续，主动续接只在 Conversation capability 已验证时使用。

输出必须区分 source_confirmed/tool_observed/inferred/unverified，附 scope、coverage、exclusions、gaps、源 hash、symbol/line、adapter-owned tool_receipts。模型没有执行的命令不可生成 tool_receipt。没有供应商 usage 就记 unknown，不做虚构成本结算。

同一成功读取回执可被多个证据摘录引用，每段独立通过原生身份、快照和精确字节
校验。结果预算检查按不同回执数量计算，实际读取仍按每次预约扣额度；持久回执
记录重复、finding内重复引用和未知回执仍拒绝。Claude的evidenceReceiptIds保持
逐摘录的有序投影，包含重复引用，不能单独去重而破坏ticket与落盘结果的绑定。

取消先 cancel_requested；实际进程/原生 turn 终止确认后 cancelled。无法核对则 recovery_required。重启先读取旧 native ID；无法证明未执行时不自动开新 attempt。过期 epoch 结果可保存为孤立证据但不能成为当前有效结果。

受限原生启动前，持久 claim 与源码/WSL 预约先做短事务绑定和当前授权检查；每次原生副作用之后再次检查授权。存储预检只核对记录，不证明运行器实际看到的 gate、源码字节或 OS 隔离。启动发生后撤权时，可信 native ID 必须保留供终止恢复，结果不能发布。旧协议迟到回执在授权未变且身份相同时仍可对账；取消、撤权和过期 epoch 不借恢复重放扩大权限。

应用拥有唯一后台调查队列调用者：启动恢复完成后逐请求获取可信内部 authority，以精确持久 profile/budget、当前隔离证明/权限 epoch 和观察身份进行 `claimRequest`，不得用一项证明调用 `claimNext` 领取其他请求。完整 prompt 预检和已保存快照内容摘要先于 claim；资源预约先于独立限时路径读取 grant 与既有 model coordinator。固定 Claude 配方配置没有 verified/enabled/executable/argv/env/model/UID/boot 参数；观察身份与资格只来自内部 authority，默认 null/false，外部入口不能注入。实际执行资格仍未验证，此调用链不意味着 Codex investigator 可用。模型执行不阻塞应用 ready 或其他 workspace 的领取；数据库持续维护全局 2、workspace 1 的槽位。领取后未知终态保持 recovery_required 与占位，撤销 worker grant 失败禁止继续领取并使关闭报错。关闭先停止领取和定时器，再 abort/drain，最后关闭所有 stores；同步调度异常也转为 rejected Promise。见 D212。

D214 的 Windows Codex 单次协议协调器仅接受内部可信调用方提供的连接，
最初绑定 Desktop 26.930.2377.0 / CLI 0.159.0-alpha.12.1；D232 的新记录选择
Desktop 26.930.3930.0 / CLI 0.160.0，旧目标只保留解码和恢复；该选择
不是实际二进制或 OS 隔离证明。盘符 cwd 只做规范词法检查，启动请求固定
named permission profile，响应必须回显精确 cwd/profile/root 和只读、无网络
sandbox。thread/turn 原生 ID 先落持久日志；终态仅取同一绑定回合的完整原生
通知。固定闭合 output schema 是输出提示，实际文本解析仍为权威。
默认候选只完成语法和 request/attempt/snapshot/context 绑定检查。D215 的内部
可信读取配置固定注册 `repo.read`；thread/turn ID 落库并核对完整启动响应后
才放行工具调用。独立 worker grant、冻结 session deadline 与持久共享预算
经同一 DispatchService / RepositoryApplication 授权和读取；真实页面回执绑定
attempt/epoch/intent/thread/turn/call，不能伪造 process nativeRef。同步披露事务
再次核对当前权限、租约与回合；无效持久日期拒绝，失败预约不退款。
启用该配置的候选必须核对 adapter-owned 回执与冻结快照字节才标 receipt_verified；
无读取配置仍标 syntax_only。两者均不发布 result、不释放占位。真实 launcher、
隔离/进程树终止证明及正式结果结算尚未完成。过期 owner 不发送 interrupt 或
terminate；未知状态进入 recovery_required。中立提示构造与 Claude 兼容导出
共用完整 16KiB UTF-8 预检。详见 D214/D215 和对应限定验证收据。

D239（2026-10-22）区分合法绑定调用的参数错误与协议错误：非法repo.read
arguments在既有队列等待turn持久绑定后、调用capability前返回固定失败，不
读取或预约预算；parser及8192字节/400行上限不变。它仍消耗40次transport
计数和8个并发槽，回复经过当前权限/期限检查，取消或关闭抑制迟到回复。
工具/身份/回合/重复ID等协议错误仍拒绝连接，不放宽外部能力。

D227 补齐 supplied coordinator 的 runtime 引用防改写：入口复制并冻结
protocol target/cwd/profile/model，thread/turn 使用冻结值，source preflight
前后复查原参数未变化；最终比较在注入的 clock/deadline 回调之后。参数漂移
拒绝当前发送并保留 recovery_required，不授予 launch 资格或释放占位。
限定离线证据见 `CODEX_RUNTIME_MUTATION_2026-10-05.md`（私有历史记录，见[验证状态](release-evidence.md)）。

D216 将 Windows staging 清理的原生意图检查前移到领取清理租约的短事务内，
先于 epoch/state 更新和文件关闭。任何 thread intent（包括无已观察 ID 或
已有终态）都会拒绝该纯 staging 清理；终态回合不证明进程树已经终止。
若清理租约先提交，持久 epoch/reconcile 状态禁止旧 owner 或清理 owner
创建新 thread/turn。结算仍保留第二次检查。已有的 Windows source reservation
只证明准备了文件；生产 launcher 还须在创建 app-server 进程前持久记录启动
意图，保存实际进程身份，并提供终止/恢复观测。这些能力尚未实现/实测，
不能用预先提供的 StdioConnection 或 readiness=ready 代替运行资格。

D217 新增独立 Windows app-server 启动日志：唯一 intent 与精确 prepared
source、原始 owner/epoch、profile/permission epoch、固定 recipe/协议目标及
主机/执行实例绑定，在创建进程前的短事务持久化。内部资格回调默认不存在；
缺失时不插入 intent。回调后计入单调耗时并重新检查原授权和租约。
PID 与完整 uint64 creation FILETIME 原样字符串只是身份事实，不是进程控制
句柄或隔离/树终止证明。原始 launcher 可在撤权或 owner 接管后保存精确迟到
身份；冲突拒绝，unknown 单调保持 recovery_required，不重新授权 RPC。
任何 launch 行都阻止纯 staging 清理；thread/turn 与已有读取 session 必须
复查 launch 当前资格，unknown 后不预约新读取或披露在途结果。
现有仅接受 supplied connection 的协调器遇到任意 launch 行，在 initialize
之前拒绝并保留恢复记录；恢复没有原生端口时保留文件和占位。生产回调仍
未接线。未来真实 launcher 必须把 transport 绑定精确进程句柄，并处理并发
创建/撤权、进程树终止与安装重启；记录校验不能单独批准 supplied connection。

D218 的固定 Windows Job helper 已提供 HANDLE 基础合成验证路径。无名、
不可继承的 Job 设置 kill-on-close；STARTUPINFOEX 的 JOB_LIST 在创建时关联，
同时 suspended；精确 root HANDLE 的 Job membership 与完整 uint64 FILETIME
观察先于 resume。公开配方只支持 single/tree/parent_exits，自身内部角色只创建
固定子代；不接受任意 executable/argv/env/cwd/PID/Job name。子进程显式使用
闭合环境。helperVersion 2 的 fixturePids 通过活进程查询句柄、当前 Job membership
和精确 helper image 路径核对；tree/parent_exits 初帧先观察三个 fixture，single
观察一个 fixture，不能将 conhost 等系统
伴随进程凑进三代计数。完整进程列表与 accounting 一致后才报告成员；stop 在持有的 Job
HANDLE 上终止，并要求原 root signaled 和完整空列表。父进程退出、停止 ACK、
helper EOF 或 PID 消失都不能单独证明整树终态。

薄 TS channel 限制帧/总字节/期限、序列和原始身份，stop 在途拒绝新命令；
初帧后同步失败不能返回成功会话。观察对象被冻结。测试用 channel seam 只
验证协议事件顺序，不授予原生或 investigator 权限。显式 build:windows-helper
使用现有 Framework64 csc 编译同一 C# 源码，输出到 dist/src；安装没有 hooks。
这条固定合成路径不是 app-server transport，PID 不登记进 D217，生产资格
回调保持缺失。Job containment/终止不提供凭据、源码、网络或 Codex profile
隔离；qualified launcher、持久恢复及安装重启后的进程控制仍待实际接线。

D219 将 Job HANDLE 控制接到实际 owned stdio。新固定配方仅包含合成握手
fixture 与固定 Desktop Codex readiness，不接受任意 exe/argv/env/cwd/RPC。
三组匿名 pipe 的 child ends 是 HANDLE_LIST 唯一继承项；JOB_LIST 同次创建，
suspended 身份检查后 resume。父端不继承，创建后关闭 helper 的 child ends。
并行 reader 字节经带锁 v3 envelope 传输。双 EOF、原 root HANDLE 退出、完整
Job 空与 helper 正常关闭共同决定成功；候选或 EOF 单独都不证明关闭。

内部 TS wrapper 将现有零模型 readiness 三项准确 payload 映射为编译时固定
命令，helper 也强制顺序/单次使用。诊断 authority 在启动、每次写和返回前
检查；失效后拒绝新写但允许自有 Job 清理。清理丢弃 queued initialize，迟到
started 不重开握手。v3 manifest 对应 pipe 实现，旧三个 canary 场景仍发 v2
observations；旧 manifest 不能与新 adapter 混用。诊断不写 D217 investigator
launch、不启用 qualification、不执行 setupStart/thread/turn；生产隔离与持久
恢复仍待完成。

D220 的产品 CLI 默认 readiness 入口复用上述 owned Job 通道；注入的协议
测试 runtime 不产生原生 closure。调查的关闭事实另以 launchId 唯一持久化：
固定 production recipe、原始 launch tuple、scope、PID/FILETIME、双 EOF、
root exit、完整 Job zero、正常 helper exit 及序列必须匹配。存储入口还要求
内部可信 verifier 确认完整 owned transcript；缺失或 false 拒绝，结构校验
不能授予资格。诊断 recipe 的 closure 不能登记为 production 事实。

原 owner 撤权或被接管后仍可提交精确迟到关闭事实，但不能恢复 RPC 权。
事实独立、冻结、幂等，冲突拒绝；读取受当前 claim fence 约束。关闭事实
一旦存在，launch 的 usable 检查在 verifier 前后均拒绝后续 RPC，包括重入
回调中新登记的 closure。它不发布结果、不清理源码、不释放槽位，也不改写
原 launch 状态。固定 production native recipe、owned factory、coordinator、
资格与最终结算尚未接通；安装重启读取事实不是跨进程恢复 Job HANDLE 的证明。

D228 只接通固定零模型 `owned_pipe_fixture_v1` 的原生同步 writer：helper 保留
唯一原 server HANDLE 至进程结束，私有 factory 关联实际 child/binding/writer；
stop/fail/close 即撤销。复制原 HANDLE 后校验 live PID/FILETIME/image、server PID、
message/NOWAIT 和双冻结期限，一次固定帧 WriteFile，未知或短写不重放。
名称/scope 不构成原生授权，内部 writer 不公开外部入口。此合成通道不能提供
production launch 资格、有效隔离、模型或最终读披露事务证明。

D229 的可选同步 transport writer 复用原 codec/pending table，只接受同步 true；
完整 JSONL（含 LF）上限为 min(configured frame limit,65536 UTF-8 bytes)。它不使用
supplied Writable 或旧前置 hook，不赋予 owned/production 资格。同步早到 RPC 响应
仅暂存于该 pending entry，发送确认前不能成功结算；失败/关闭无重放。真实 Promise
拒绝被接管，但不等待其结果，不调用任意 thenable，也不能撤回异步函数已产生的副作用。
storage/control 的 sendWindowsLaunchControl 在同一 SQLite 事务比较完整原 launch/
identity、执行当前 usable 检查并同步 emit；成功 repo.read 仍用原 discloseCodexRead，
不得嵌套该 control 事务。当前尚未装配生产 owner，supplied durable launch 拒绝保持。

D230 的启动合约使用最小附加 start-intent 表及严格版本化记录，字段为 kind、
launchId、reservedAt、consumedAt。新 begin 在同事务创建 launch 与未消费预约；升级
不补旧 Current/legacy 预约。内部 dispatchWindowsLaunchStartOnce 先在事务 A 原子
消费已有预约并提交，再仅由这次消费调用在事务 B 重查授权并同步发送固定 start。
回滚 B 不删除 A；崩溃/撤权/未知发送都不授予重放。预约不能授权重建原 helper，
还须私有 factory 持有原 prepare helper。SQLite/恢复扫描切片通过限定离线验证，
不是生产能力；正常身份观察与 recovery_required 单调语义不变，历史记录不补授权。
身份观察供清理使用，不要求已消费预约；usable/thread/turn/read/control 则必须有
原 launch 的合法已消费预约。已经观察到身份的 launch 不能再 dispatch start。
安装扫描核对严格字段、唯一原 launch 关联与 reservedAt=launch.intentAt，不根据
墙钟大小推导消费/观察顺序，也不拒绝已清理的未消费身份事实。
最终65项受影响测试、30项contracts、1项boundary及typecheck/scoped lint通过，
七个最终输入字节不变；范围见 WINDOWS_START_ONCE_2026-10-05.md（私有历史记录，见[验证状态](release-evidence.md)）。

D221 只在原始 transport 同步发送点检查 control RPC、initialized 与自动读取失败
响应的当前授权；不创建第二 Writable 或延迟重放队列。底层 cork、未完成写入、
背压和错误均拒绝新帧。成功 repo.read 仍在既有短事务最终披露检查内同步 enqueue，
不再重入事务；失败响应另核 worker grant/session/turn。原始输入 error 和 callback
错误关闭协议；已被 OS 接受的字节不能撤回。精确 bound interrupt 的 abort/deadline
例外保留当前 owner/source 检查，持久 Windows launch 的 supplied-connection 路径仍拒绝。

D222 的本地管理动作只为当前 static_readonly_v1 workspace/profile revision 创建
固定私有 HOME、闭合 config 与不可覆盖 runtime metadata；runtimeId 不推导其他身份。
重复 prepare 拒绝；check 校验路径/ACL/元数据和完整 config 字节，再以闭合环境运行
固定 --version/features list。慢速文件/ACL 检查后、每次外部诊断前后及返回前重核当前
管理 grant/revision。诊断不读或复制 auth.json，不执行登录/setup/model。六项工具开关
观察不等于 strict-config、有效读取根或 native token/网络隔离；productionAvailable、
isolationVerified 恒 false。D223 在 check 中追加固定 desktop_config_check_v1 owned
Job 配方：固定 app-server --stdio --strict-config、同一派生空 check cwd 和专用环境。
原 config 文件以 FileShare.Read 持有至 Job 关闭，启动前校验该句柄字节 hash。
三种封闭控制输入只对应 initialize、initialized、config/read；每帧原生写前重核
当前 DB 管理授权。strictConfigVerified 仅在 Windows/private CODEX_HOME、指定 model、
never approval、disabled web search 及三字段来自原 user config 文件都符合，且双 EOF、
原 root exit、完整 Job 0、helper exit 0 后为 true。原始配置和 stderr 不作为输出。
这仍不证明有效读取根、凭据/网络隔离、模型或生产可用；生产 factory/coordinator、
调查与恢复资格仍待接线和真实验收。

D225 的 Windows 恢复结算只消费已持久核准的 Current launch/closure；无关闭事实、
旧 binding 或身份冲突不得触碰源码视图。原 lease 过期后，清理 owner 取得新 epoch，
原 launch/source epoch 保持不变；真实 source close 后，在同一短事务重核 owner、
lease、精确 launch/closure/source 并写失败或取消终态、result=null、删除 active/outbox。
新增 `investigation_windows_launch_settlement_facts` 保存 cleanup owner/epoch/time、
原 privateRoot 与完整 sourceClosed observation，关联原 request/attempt/launch。
它是追加清理审计事实；原 launch、三字段 closure 和未知 thread/turn journal 不变。
`windows_launch_closed_without_outcome` 仅在完整事实链下允许安装预检保留未知 native
journal；其他未知状态仍拒绝。任何 turn 仍必须具有已观察、合法的父 thread ID；
未知 thread 只能保留尚无 turn 的 intent，已知 thread 可保留结果未知的 turn，不能
把不可能的父子记录当作未知结果。terminationConfirmed 仅指精确本地 Job 的树已结束，
不代表 provider turn、远端取消或计费终止。历史 schema 缺该新表且无此新终态可按
旧预检路径检查；有此终态而无事实链必须拒绝。构造 store 以 CREATE TABLE IF NOT
EXISTS 追加表，不回填历史 launch/closure，不放宽纯 staging cleanup。

D224 为新 Windows launch origin 增加 runtimeId 与 configSha256，绑定专用配置
身份；格式验证不证明该配置实际来自 owner，生产内部 verifier 仍须核对当前
owner/workspace/revision/路径/ACL/字节。新 begin 只接受完整新绑定。读取显式兼容
原八字段 legacy JSON，不补字段、不猜旧配置、不全表改写；legacy 在资格回调前
永久拒绝 usable，不能重复启动、thread/turn、读取披露或 staging 清理。原 owner
仍可按原 legacy origin 追加迟到身份、recovery 和经独立 verifier 确认的 closure；
伪补绑或配置身份替换不匹配原 origin。关闭事实继续不结算结果或释放 source/slot。

D231 固定原生 windows_app_server_readonly_v1 增加 prepared→唯一 start→started
阶段：prepared 尚无子进程/root，控制输入仅 start/stop；准备后仍按原双期限检查
创建与 resume。通用内部 writer 使用独立 prepared pipe 名，保留原 helper
PID/full FILETIME/server HANDLE 及 NOWAIT/message/完整单次 WriteFile 核查。名空间
只拒绝原样的其他配方元数据，不是内核配方授权；可信本机调用者若改名并提供
另一真实句柄，通用 writer 不独立约束配方。生产必须由私有 factory 的实际 session
及阶段证明该边界。65536字节包含 LF，输出总界为1MiB；旧诊断 writer 三帧界保持。
pre-start prepared_closed 只证明该准备 Job 的完整空关闭，不是带进程身份的
Windows launch closure。生产恢复不得将其伪装成 job_closed。
实际创建的合成 TS owner 验证阶段/序列/原身份、错误或未知写后撤销，以及双 EOF、
root exit、完整 Job 0 和 helper exit0；它不接受 supplied channel、任意 executable
或资格回调，也不提供生产资格。内部 runtime resolver 从持久 claim/profile/runtime/
source/snapshot 核查精确绑定，当前最终保持 WINDOWS_RUNTIME_UNQUALIFIED、无 launch
副作用。产品生产 owner 与 coordinator/最终披露/恢复接线仍未完成。

D232 不改写历史 Windows launch/runtime 记录。完整旧 origin 与八字段旧 legacy
仍供迟到身份、关闭、恢复和安装扫描使用；新 begin/start/control/usable 必须
使用完整当前目标，资格回调前后重核。旧 runtime slot 在诊断前拒绝，配置字节
不变；新 profile revision 创建新的 runtimeId。新 codec 显式发送
requestAttestation=false 与 text_elements=[]，旧 codec 保留原 wire shape。
生成 TS 的必填字段和 JSON Schema 默认值不证明 native 拒绝或隔离。固定诊断
三帧和 supplied durable launch 拒绝边界保持。见 docs/DECISIONS.md D232。

D233 的未启动事实与 D225 的 process closure 分开。追加
`investigation_windows_app_server_not_started` 与
`investigation_windows_not_started_settlement_facts`；只接受完整当前 origin、
匹配原 start intent、无 child identity/closure/native thread/turn 的原 launch。
内部 owner verifier 默认缺席即拒绝，并在回调后再次核查持久状态；撤权/过期后
仍可保存精确 prepared1→prepared_closed2、原 helper PID/full FILETIME、完整 Job0、
helper exit0，但不得恢复执行权。已保存事实排斥之后的 start/control/usable/child事实。
新 cleanup epoch 不改原 launch/source epoch；实际冻结视图 close 后，原请求失败或
取消、result=null、failureReason=windows_launch_not_started、terminationConfirmed=false，
追加独立审计并释放 active/outbox。安装预检需完整相互关联的事实链且不得有 native
journal，不复用 D225 的未知 thread/turn 例外。旧行不回填、无事实仍占位。

独立 prepare-only 组件观察器使用固定原生 production recipe，但只接受精确合成
config/README，唯一控制帧是 stop。它自行创建并拥有 helper，核对完整序列、实际
helper PID/full FILETIME、stop 写完成、helper双管道结束、空 stderr、实际 exit0；
不返回 launchId/start/send/writer，不登记调查或授予生产资格。取消/未知关闭拒绝，
仅有界清理本方资源，测试保留未知现场。该组件不能绑定给另一实际 launch；原生产
resolver 仍为 WINDOWS_RUNTIME_UNQUALIFIED。落库前硬崩溃 transcript 丢失仍未解决。

D235 新增 `createWindowsOriginalOwnerFactory`，构造空 registry 无平台或 native
副作用；实际应用 store 接入其 `verifyNotStarted`。原语 `prepare` 自行创建固定
helper、scope 与 instance，冻结 claim/runtime/config/source 期待；`reserveLaunch`
必须调用真实 store 的 durable begin，prepared 后同步绑定其返回的原 origin。
唯一 native 控制是单次 write(stop+LF)，必须成功 write 回调；协议不要求 stdin EOF，
不能用 end/shutdown 的完成替代帧写完成，错误仍保持 unknown。`close` 仅证明本方
未启动 helper 的完整终态；只有已绑定
owner 的 `stopAndRecord` 才能登记原 launch 事实。无任意 executable/channel/writer、
DTO issue 或合成 prepare-only 观察回填入口。私有 registry 核对完整不可变 origin
与实际观察，SQL 回滚不销毁唯一证明；成功落库后退休，相同事实可幂等查询。
应用没有生产 prepare/start/send 调度入口，`verifyWindowsLaunch` 仍缺席即拒绝；
真实认证/隔离资格、后续控制与披露接线、落库前硬崩溃仍待完成。

## 7. Artifact Transfer 与发布

外部只能写 runtime 分配的 staging，不选择绝对目的地。两种入口是文本文件集合和 provider/native/local 文件传输 adapter。核心接收受控流与来源，不保存可自由调用的任意 URL。ChatGPT 文件参数四个声明字段与平台要求留在 adapter；不得把 sandbox:/ 字符串当公网下载地址。[C08]

begin 明确文件集或计划；put_text/import_reference 写暂存；status 返回逐文件状态；finalize 封存 manifest 并验证；abort 将 staging 永久终止。`expected_set_basis` 为 producer_declared 或 receiver_observed；后一种只能保证清单内齐全，不证明作者未遗漏文件。

外部 MCP 对这六个成果工具分别声明可发现的 `payload` 对象字段和必填项；`artifact.import_reference` 另声明顶层平台 `file` 参数。MCP schema 仅作为调用前的结构约束，实际授权、scope、幂等、来源和发布条件仍由统一 dispatch 与 application 校验。客户端发现并能构造请求不代表 ChatGPT 已完成真实文件交付。

stdio 文件入口仅在固定 MCP binding 与当前 grant 的发现结果已包含
`artifact.import_reference` 时读取既有私有 `oauth-config.json`。复用完整配置
校验并只取精确的 `allowedFileOrigins`；不借用 OAuth 身份或启动 issuer。
缺文件或空列表保持下载关闭，已有非法或非私有配置拒绝启动。非空来源使用
与 HTTP 相同的受控下载 resolver，继续进入统一 dispatch 和 staging 校验。
来源配置不授予文件提交权；真实平台文件交付仍须独立验收。

abort 的数据库 tombstone 与幂等回执在同一事务提交；随后同步文件标记。崩溃后以数据库 tombstone 为准补齐缺失或仍为 staging 的标记，冲突标记拒绝覆盖。已发布 bundle 不可 abort，已 abort bundle 不可继续写入或发布；数据库若同时出现 published manifest 与 abort tombstone，所有读取路径拒绝该矛盾状态。abort 不删除共享内容寻址对象；对象清理另行依据引用关系治理。

每个文件包含 normalized_relative_path、actual_size_bytes、sha256、media_type、source_receipt；hash 程序计算，不由模型猜。相对路径使用可移植规则：拒绝绝对/盘符/UNC、..、NUL、符号链接/硬链接条目/设备条目、重复 ZIP entry、大小写或 Unicode 归一化冲突、Windows 保留名称与尾部点空格。压缩包原件可归档；解包后的每项按相同规则验证。默认不预览活跃 HTML，不加载包内 AGENTS/Skill，不应用 patch。

平台文件引用导入另记录可选的 opaque `source_identity`；旧成果允许缺失。`source_receipt` 保持 route 类别，`source_identity` 只标识接收时的来源句柄，不证明作者或账号。原始平台文件 ID 和签名下载 URL 不进入 manifest；同路径同字节但来源身份变化应拒绝复用。

发布顺序：stream 到临时文件→验证 bytes/hash/格式→flush→同文件系统 atomic rename 到不可变对象→写最终 manifest 对象→短 DB transaction 建立 bundle 和文件引用并设 published→回执。不同平台缺少 durability primitive 时说明所保证等级并测试；不要假设 SQLite 与 FS 有跨系统原子事务。

崩溃在 DB 前会产生待清理 orphan，不会生成 published 假成功；崩溃在 DB 后能根据已落盘内容恢复。启动检查发现已发布对象损坏时保留不可变的 `state=published`，另将 `integrity_status` 标为 `missing` 或 `corrupt`，读取/导出返回 integrity_error，不能静默重新下载替换 hash。GC 保留所有被 bundle/decision/evidence 引用的对象。

恢复旧版已发布成果时也重检 manifest 的可移植路径结构及声明文件集。即使对象字节和哈希存在，文件/目录别名、大小写冲突或缺少 declared 文件仍判为 corrupt，重复 finalize、对账与读取不能将其当作完整交付；原 manifest 保持不可变，修复须走单独的新版本或人工审查。

published 只证明已定义的传输/结构检查通过；semantic_status 仍 not_reviewed。DecisionRecord 才记录本地评审。promote/export 是独立本地授权动作，要基线检查和目标冲突检查。

本地 `artifact.list` 按明确的 workspace/collaboration 与当前 `artifact.read` grant，列出固定发布序列上界内的已发布 bundle；签名游标绑定调用主体、范围和页大小，分页期间新增发布要重新开始列表才可见。列表中的 `integrityStatusRecorded` 是上次记录值，不声称此刻文件仍完整。`artifact.inspect` 对单个已发布 bundle 重新核验对象字节，返回实际 manifest、程序计算的 manifest hash、父版本及当前完整性；其 `ready` 仅表示传输/结构完整，不等于语义采纳或当前源码基线复核。这两个操作不暴露在外部 MCP。

本地 `decision.record` 可带可选的逐项结论 `{id,sourceRef,outcome,reason}`。`sourceRef` 只指向该已发布 bundle 或其 manifest 中的文件；逐项 ID 唯一、数量与文本有界，总体 outcome 必须与逐项结论一致。历史无逐项内容的决策保持可读；有项和无项的同 ID 重放互相冲突。逐项结论不会改变 `implementationAuthorized=false` 或绕过 baseline review。

本地 `decision.list` 用显式 workspace/collaboration、当前 `context.read` grant 和最多 10 项的分页列出决策摘要；签名游标绑定主体、接收方、范围、页大小及首轮插入序列上界。追加的新决策需从第一页重新列举。`decision.get` 按 ID 返回完整 DecisionRecord，包含逐项理由；这两个操作不向外部 MCP 发布，读取历史不表示采纳或实施授权。

### DecisionProposal 补齐合约（D161，离线实现已验证）

`decision.propose` 通过统一 application 接受 `proposalId`、`contextRevisionId`、
`snapshotId`、`recommendation`（accept/modify/reject）、`reason`。可选的
`bundleId` 与 `bundleManifestHash` 必须同时提供或同时省略；提供时绑定准确的
已发布 bundle 及其 context/snapshot。reason 以 UTF-8 计最多 16 KiB。
建议绑定同一 workspace/collaboration 下已存在的 revision/snapshot；允许历史
revision，不能移动 context head。proposedBy 由可信请求主体产生，禁止客户端
提供批准或执行字段。

建议作为不可变 DecisionProposal 单独存储，经过当前 grant、事务内持久 grant
与幂等检查；`implementationAuthorized` 固定为 false。本地 `decision.get`
将严格二选一接收 decisionId/proposalId。本地列表默认继续返回正式决策；显式
`kind: proposal` 使用独立建议列表与绑定该 kind 的游标。外部只可提交建议与
取得原回执，不能调用本地 get/list。该扩展不自动创建 DecisionRecord、基线
评审、正式采纳或实施授权。无 bundle 建议的正式 DecisionRecord 使用下述
独立本地 review/record 流程；不能由建议提交成功推定完整决策闭环通过。

后续正式决策扩展已通过离线回归与独立复审，证据见
[proposal 目标决策记录摘要](release-evidence.md)
（真实端到端验收仍待完成）：`decision.review` 和 `decision.record`
使用互斥目标：完整 bundleId/bundleManifestHash，或 proposalId。proposal 目标
要求持久建议与请求同 scope、同源 snapshot/context；不能把历史建议改绑到
新基线。accept/modify 的 review 必须绑定目标、原基线和当前 heads，复核后
heads 改变则拒绝；reject 保留直接记录路径。合法历史幂等回执仍原样返回。
该扩展复用原始差异计算和 JSON 存储，不增加外部批准操作或实施权限。

## 8. 运行边界与保守默认值

以下是首版操作默认值，不是平台提供的固定能力；必须可由可信本地配置调整并纳入测试。外部请求只能收窄，不能扩大。

| 项 | 默认值 |
|---|---:|
| 单次文本读取返回 | 64 KiB，且不超过 400 行；硬上限 256 KiB/2,000 行 |
| 搜索返回 | 默认 50，硬上限 200，整体正文预算 64 KiB |
| 调查问题 | 最大 16 KiB；大背景以 context/evidence 引用传递 |
| 文本文件提交 | 每次最多 1 MiB，可多文件分次提交 |
| 单个接收文件 | 32 MiB |
| 单 bundle 展开总量 | 128 MiB、最多 256 个文件 |
| ZIP 最大压缩比 | 100:1，且始终受展开总量与逐项限制 |
| investigator 并发 | 全局 2、每 workspace 1；队列有配额 |
| 单次 investigation attempt | 默认 600 秒，另设 turn/tool/usage 限额 |
| 同一外部账号自动发送 | 最大 2 个并发；每 binding 一个发送者 |

D163 的账号发送占位按同一产品状态库内持久 binding 的
`(provider_id, account_id)` 计算，跨 workspace/collaboration、跨连接和进程共享。
`conversation.send` 命令处于 `sending` 或 `reconcile_required` 时占位；
`prepared` 不占位。占位检查与进入 sending 必须处于同一 SQLite 写事务，
在调用外部发送端口之前执行。submitted、unknown、人工接管、撤权、重启、
epoch 变化或时间流逝都不能证明发送未发生，因此不能释放占位。
既有可信 rejected 转换、关联原 intent与原生消息对的完整对账，或上述本地显式
接受完整已观察历史，将工作流置为completed后释放；最后一种仍保留原发送unknown，
不是成功证明。历史超额未决命令保留并拒绝新增，不自动清空。
此约束不宣称限制用户网页手动发送或其他独立安装状态库；账号身份不得从
请求文本、线程 ID 或本地 OS 用户推导。实现和验收状态见 D163 回执。

预算数值落在 `runtime-limits.json`（由实现创建的用户可信配置），不与研发 `.codex` 子代理并发混用。没有货币 usage 时用有依据的 wall/turn/output 限制并标费用 unknown；不能声称保证了精确货币上限。

D162 的 workspace investigator 配置使用统一 application 下的追加式 SQLite
profile revision，替代上述 investigator 预算的独立 JSON 文件载体（其余限制
不由这一切片实现）。`admin.configure_profile` 仅允许 management scope 的
可信本地管理员；payload 为 workspaceId、expectedRevisionId（首版 null）、
presetRef=`static_readonly_v1` 与闭合 budget。正 safe integer 配置上限为
600 秒、每 attempt 8 个持久 turn intent、每 request 40 个受控工具预约。
配置 CAS、授权与幂等处于同一短事务；不得改写历史 revision 或已有请求预算。
新安装显式授予 admin.profile；旧安装须由现任管理员显式授予，不静默升级。
保存返回 runtimeAvailability=unavailable，不能接受命令、模型、网络、凭据、
enabled 或调用者隔离证明。运行绑定与真实隔离未通过时保持禁用。
该配置切片已通过离线合并回归、独立复审及实际安装包配置/重放验证；
调查运行、账号和真实隔离验收仍未通过。

D204 的内部模型提示保留完整 request scope 与 parentInvestigationId 为
JSON 数据。symbols 不扩大由 paths/relatedTests 得出的 allowedPaths；父关联
不隐含父结果读取权，也不把旧回执转为本 attempt 回执。完整序列化 UTF-8
提示受同一 16KiB preflight/coordinator 限额；该限定修复未开启生产 profile。

受限 investigator 的 `maxToolCalls` 按调查请求累计，不在重连、重启或新 attempt 时重置。`repo.read` 通过当前授权与精确快照绑定后，在应用 handler 读取正文前原子预约一次额度；工具发现和重复授权检查不扣减。相同参数重试及分页是新调用。预约前拒绝不扣减；预约后的读取失败、断链或披露撤权不退款。预约次数不证明读取成功，也不构造工具执行回执。迁移前已执行过的请求若无法确定历史用量，保持未知并拒绝新预约，仍允许查询、取消和恢复。

内部 WSL FIFO 连接从当前持久 claim 的完整 WSL resource 派生路径，不接受外部命令指定 root、unit、执行程序或环境。准备过程在本地预约后核对授权；接线只接受已持久化为 started 的 attempt，并在异步 readiness 后再次核查。工具 MCP 与模型提示/输出占用独立管道；绝对截止时间来自持久 startedAt 与请求 wall budget，读取预约和披露复查也受其约束，流量不续期。空闲撤权、租约或 epoch 变化关闭连接。关闭只证明传输桥接子进程的观测状态，不提交调查终态、不释放 slot、不删除产品 FIFO 目录，也不证明原生模型 unit 已终止。目录和单次 relay.lock 保留给原生 owner 恢复；不自动重连。当前路径仅是固定零模型资源合约下的内部传输切片，生产模型 supervisor、账号和 OS 隔离尚未验证。

内部 relay 的新准备过程预建 `helper.lock`：mode 0600、owner 为本次 Linux user、单硬链接、正好一个字节 `0`，文件及父目录 fsync 后才返回 prepared。固定 helper 只打开已有文件，持有非阻塞 flock，将 `0` 写为 `1` 并 fsync 后才接 FIFO；不创建、截断、删除或重置。宿主 relay 接受格式合法的 `0`/`1`，单次连接仍由独立 `relay.lock` 和当前持久授权控制。旧缺失/空 marker 的 attempt 不补填、不升级，保持不可用并由原生恢复处理；新调查使用新 attempt。marker 在 sandbox 内可写，仅约束固定 helper 的合作协议，不能替代主机权限、预算或原生清理。实际 SRT 组件成功见 MODEL_RELAY_PREPARED_2026-09-30.md（私有历史记录，见[验证状态](release-evidence.md)）。

固定 launch-config 组件只构造 `/opt/srt.json`、`/opt/mcp.json`、`/opt/mcp-fifo.py` 三份小文件，逐份不超过 64 KiB、总量不超过 128 KiB，记录字节长度与程序计算的 SHA-256；domain 列表必须由可信 profile 明确提供，不追加 provider 默认值。当前 v3 启动保留 sealed mounts；组件字节校验和 SRT relay probe 的另一个配置实例不能互相替代，也不构成完整生产隔离证明。

## 9. Capability 与 release 声明

实际零模型 PID namespace 探针确认 bwrap 0.6.1 的 `--block-fd` 在 EOF 后继续执行，因此不得将其作为失败即拒绝的生产屏障。早期 info/block 观察仍有非零 effective capabilities，必须等固定 bootstrap READY 后独立观察最终身份；原始 host wrapper running fact 不能自动升级为 sandbox confinement。固定 bootstrap 组件已实现：sealed memfd 经 ro-bind-data 只读挂载，在 SRT/model exec 前严格读取一次有界 header/raw prompt/EOF，异常与不完整输入退出。实际 WSL 空输入探针退出86，固定体hash与host读取的挂载字节一致，三项已观察PID均缺席；有效帧成功测试仅替换最后exec为合成marker，不调用模型。READY不是权限或confinement receipt；supervisor已接固定bootstrap parent与有界startup候选协议，生产dispatch仍关闭，实际隔离观察落库后才能发送提示。自建 socket 哨兵拒绝与已观察后代退出仅为组件证据，不通过 consumed 模型树或 LIVE 门禁。见 MODEL_PIDNS_2026-09-30.md（私有历史记录，见[验证状态](release-evidence.md)） 与 MODEL_BOOTSTRAP_2026-09-30.md（私有历史记录，见[验证状态](release-evidence.md)）。

内部启动事实接线先复核请求及模型预约，再观察等待中的原 unit，保存精确 WSL 身份、验证 native-start receipt、检查返回状态确为 started，最后用完整 observation receipt 将原始 journal 与实际 native 字段原子落库。旧 journal-only 行保持 native_json=NULL，不自动升级或授权新 prompt；恢复读取保留原始 launch epoch。探针期间取消或撤权会保留 nativeRef 供恢复并进入 reconcile，不形成可执行 running fact；未确认探针保留 recovery_required 和占位。该接线不 release、不发送 prompt。模型终态 observer 仅返回 `model_unit_terminal`，须已关闭 journal、原 PID 缺席及保存 cgroup 空/缺席；loaded 与 not-found 分别核验，PID 重用保守拒绝。consumed 阶段必须有匹配的历史完整 running observation，数据库已保存完整原始观察；unit 终止不得自动升级成 consumed 模型进程树终止。独立 cleanup owner 取得新租约后关闭原始闸门、保存迟到身份并观察原 PID/cgroup；只有 closed entered/released 才可凭专用一次票据结算 model_execution_prevented。原始 terminal 观察与失败/取消记录及释放 slot 同事务，保留 nativeRef、startedAt 和 prompt intent，terminationConfirmed=false。prepared、consumed、身份不明和证据不足保持占槽；恢复不 release、不重发 prompt。

模型 running observer 在入口深拷贝 resource/journal/descriptor，校验精确模型绑定后以固定 WSL 程序用两次 systemctl 夹住 PID/start ticks/cgroup 检查；只返回 `claude_model_running` 或未确认，不授予 release 或终止能力。内部 native-start 与 running-fact receipt 分别绑定完整 claim、原生引用和观察快照，单次消费、可撤销、有数量上限，不能跨用途/epoch/attempt 使用。receipt factory 只供可信本地 owner，不是外部输入或用户审批机制；应用已接内部 model coordinator，默认 authority 仍关闭，不能代替每次 SQLite 授权/lease 复核或真实运行资格验收。

模型 launch 预约 JSON 精确包含 `action/workerEpoch/sourceDigest/profileDigest/commandDigest` 五项，必须在 gate prepare 或原生启动前持久化；固定零模型 v2 保持原四项。运行事实的 commandDigest 必须匹配预约值，不以事实自身提供的摘要作为期望值。历史模型四项记录仅可解码和枚举，不能预检、接线、提交 prompt 或自动补填；它们继续占用未结算槽位，等待明确的恢复事实。

内部模型启动采用独立 `claude_model_v1` payload/action 和 journal，不扩展 `fixed_zero_model_v1`。可信执行者先持久预约，启动等待中的精确 unit，再观察并持久保存原生身份及显式 verifier 核验的 running fact，随后接入受限 MCP。事务化 prompt intent 绑定原始 epoch、nativeRef、profile/command 摘要及 prompt hash；同内容重试也拒绝重新插入。恢复执行者可以读取原意图，不因此获得再次发送权。running fact 是原始观察事实，getter 不重新证明当前 OS 存活。独立 supervisor 保留原始parent身份，在同锁内检查closed/原PID/start ticks/cgroup、持久consumed并Popen固定bootstrap。startup候选行与后续模型字节分开；收到完整header/raw prompt/EOF后，同锁内最终复查再有界写入子进程。完整帧交付后的非零退出或无退出码保持uncertain。新command recipe绑定bootstrap摘要、固定FD10/11与精确argv/env；旧摘要可status/close，不能启动新recipe。prompt通过有界stdin，而非argv/env/journal。READY不授权发送，配置字节封存已接 v2，独立 confinement 观察与落库条件尚待接通。墙钟限制为可信请求的 1–600 秒。进程桥失败返回 uncertain，不证明 Linux 后代终止，不释放槽位。现有零模型终态凭据不能用于模型作业；consumed 模型树终止、实际工具执行回执与 turn 预算仍须接通和验证，生产 profile 保持关闭。

第二 runtime 的模型启动使用独立 MCP-only 构造器：空 `/work`、精确本次 `/relay` 和固定 Python helper，不接受源码或 snapshot 挂载。原有 `claude-sandbox-spec` 仅保留诊断预览，不能用于生产调查。MCP 配置只指定该 helper；stdin/stdout 传递工具字节，模型提示和输出使用 supervisor 的独立管道。构造器只约束命令形状，不验证磁盘对象、SRT 配置、认证、预算或原生身份。模型类型、历史运行事实及一次 prompt 意图已实现组件接线，执行回执与原生终止的生产闭环尚未接通；生产 profile 仍关闭，不据此声明第二 runtime 可用。

当前启动 recipe 为 `claude_model_bootstrap_config_v3`，保留 v2 的配置字节封存并加入必填可信轮次上限。可信 profile 明确提供 domain 列表；一次私有字节快照同时形成 commandDigest、三文件 target/length/hash 清单和 startupInput。初始输入为 `claude_model_config_input_v1` 的 ASCII JSON header＋LF（合计最多 2048 字节）及精确三段 bytes，不等 EOF、不预读后续 prompt。可信 parent 在独立五秒绝对期限及原 RuntimeMaxSec 内读取、验证并 seal，之后重新取 journal 锁检查 prepared/open 才写 entered；读取期间 close 不受该锁阻塞。三个配置及 bootstrap/info pipe 的临时 FD 提升到至少 32，检查固定 10–14 空闲后才 dup2；12–14 只读 data bind 对应三配置，10/11 保持 bootstrap/info。未知 FD 不覆盖，失败关闭 owned FD。旧 commandDigest 可 status/close，不可 v3 enter 或历史升级。

D196 的 v3 bootstrap argv 包含可信 `maxTurns` 的规范十进制值，范围为 1–8；固定 CLI 尾部传入一次 `--max-turns`。commandDigest 绑定该值，原 owner 在准备原生资源前与持久请求预算核对。缺失、非整数、越界和预算不符均拒绝，不从模型输出推导预算。完整 v2 历史事实按冻结 bootstrap/parent 元数据验证，只供读取和清理，不补填 cap，不授予新事实、prompt intent 或发送资格；混合版本拒绝。当前修改已通过定向回归及独立源码审查，结果回收也核对原启动 cap；实际模型达到 cap 时的行为未验证，不能据此保证货币费用或开启生产 profile。见 MODEL_NATIVE_TURN_BUDGET_2026-10-02.md（私有历史记录，见[验证状态](release-evidence.md)）。

Windows bridge 先安装读/错/关闭监听，再只写一次 startupInput 且不 end；配置写 callback 成功与合法 READY 均到齐后才允许显式 prompt frame/EOF。配置写失败、READY 缺失及 bridge 异常不重发或重启同 attempt。该接线保持原五秒 bootstrap 截止时间；sealed 配置和候选 READY 不替代独立 confinement 落库、当前 grant/lease 复核或 consumed 模型树终止证明，生产 profile 继续关闭。

后续独立观察事实限定为 `model_outer_confined_v1`：只证明固定 bootstrap 等待提示时的外层 PID、挂载和启动身份。必须明确记录 `host_shared_pre_srt` 与 SRT `not_started`，不得写成网络已隔离。实际零模型原始探针已观察到 parent→bwrap wrapper→outer PID 1→bootstrap 四段关系；outer/bootstrap 五类 capabilities 全零、NNP=1，bootstrap 只有三个与可信 parent 反向匹配的 pipe，outer 另有固定 eventfd。这些是当前组件事实，不是已经接入的生产 observer 或持久化权限。实现必须夹查原 unit/进程身份、核对完整有界挂载图及固定文件字节，拒绝超限/变化；原始 bytes 解码须拒绝非法编码。历史行不补写、新事实必须先于 prompt intent 并同事务核验当前 grant/lease/epoch，最终发送仍需再次核验。SRT 实际执行、模型工具/网络权限及完整树终态继续单独验收，production profile 不因此开启。

外层采集的所有有界文件读取必须循环到 EOF 或上限加一；单次短读、末尾 LF 和前后相同不能证明 `/proc` seq_file 完整。挂载路径与 mount source 严格解码内核转义，文件系统选项作为有界不透明值保存，不能把合法 drvfs 的 Windows 路径反斜线误判为路径转义。系统只读 bind 的子挂载按完整 host 表、实际 realpath 和 parent 拓扑推导，再逐项核对目标、device/root/type/source、readonly flags 和 backing stat；不能用前缀或文件系统类型白名单独立授权。隐藏的旧子挂载、堆叠及循环拒绝。采集候选不构成 confinement fact；正式验证必须核对实际 consumed/open journal、sandbox proc PID 视图、private root/cwd 对象身份和结束身份元组，再接专用持久化与发送前授权。

外层 collector 已补齐 sandbox proc PID 1/2 视图、root/cwd/work stat、有界空工作目录及结束身份元组。原 owner 包装层复制完整候选后只复用一次实际 supervisor status，要求原 consumed/open journal 全量相同；不复制 journal Python 逻辑。期限由首次原始 release 前的单调时间加五秒与原 wall budget 截止取较早者，不能从 READY 重置或跨恢复复用。取消、原 handle 关闭、超时或迟到均拒绝；桥关闭不证明 Linux 终态。此前零模型路径约559ms形成候选。源码15b1f252已实现完整挂载/进程/FD纯语义校验，实际新样本在首次release后约639ms通过，其中语义校验约48ms；网络仍host_shared_pre_srt，SRT未启动。私有路径不得意外解析，relay与只读对象按路径、dev/ino及同设备filesystem root拒绝重叠；root/work设备对应挂载，数量由完整host投影导出而非固定样本数，ro/rw互斥、固定文件模式精确。见MODEL_OUTER_VALIDATION_2026-09-30.md（私有历史记录，见[验证状态](release-evidence.md)）。该事实仍仅为样本，原owner专用持久化、唯一窗口及发送前当前授权尚未接通，生产profile继续关闭。

原owner专用组件现已实现完整事实与可信期望的nullable outer_json一写落库；历史迁移不回填，恢复只读不授权重发。进程内outer/intent/send票据分用途一次消费，原窗口受五秒及原wall预算约束，完整验证后重查期限。存储在克隆前保存数值时间基准，完整验证及receipt回调后用单调耗时重查当前grant/lease/epoch/wall；历史intent仍保留不确定性。离线组合已覆盖真实票据对象＋SQLite的顺序、关闭和恢复拒绝，但原生handle首次release历史及最终一次write尚待trusted coordinator接通，不升级为生产闭环或模型隔离证明。见MODEL_OUTER_PERSISTENCE_2026-09-30.md（私有历史记录，见[验证状态](release-evidence.md)）。

新增 consumed 专用组件 `model_tree_terminal_v1`，不能将既有 `model_unit_terminal` 升级使用。其前提是完整历史 native/outer 事实及精确同一 closed consumed journal；固定 pidfd 操作复核原 outer PID 1、wrapper、parent 的 boot/UID/PID/start ticks/namespace/cgroup，拒绝 PID 复用和身份变化，不回退数字 PID 或 unit 名称信号。原 init 缺席与原 unit 终态两侧复核、全部等待同一绝对期限；迟到结果与迟到拒绝不得形成成功。专用进程内票据绑定原事实和当前 cleanup claim/epoch；SQLite 事务重新核原历史和当前租约，并计入完整验证及 verifier 耗时，原子保存终态、失败/取消记录及释放槽位。无可信 outcome 则 result=null、failureReason=model_tree_terminated_without_outcome；保留原 prompt intent/native/outer。此组件已接已安装产品的 consumed 恢复流程，观察前后重查当前 cleanup 租约并使用同一私有票据实例；旧未执行恢复仍分开。原生进程树及安装重启尚未实测，不能开启 profile 或宣称完整模型运行、SRT 隔离、NEUTRAL01/发布就绪。设计依据与实测层次见 MODEL_TREE_DESIGN_2026-10-01.md（私有历史记录，见[验证状态](release-evidence.md)）。

冻结54cebcc的派生sealed SRT/FIFO零模型组件实测已通过：当前父监听前后回执、内层独立网络命名空间、实际MCP scoped read/hash、跨项目/路径/写工具/额度拒绝及已采样后代终态均有原始证据。该固定测试替换模型工作负载并标记synthetic isolation，不证明生产模型链路、一般联网限制、consumed树结算或安装重启，不开启profile。见MODEL_TREE_RECOVERY_2026-10-01.md（私有历史记录，见[验证状态](release-evidence.md)）。

原 owner 新增一次性 `readNativeOutcomeCandidate`：成功提交原 prompt 后，等待原 bridge 的确定零退出，解析最多 256 KiB 的严格 UTF-8 单对象输出，仅投影 SDK 文档中的成功判别字段、结果文本、producer-reported turn 数及原始字节 hash。请求、attempt、workspace、epoch、nativeRef、prompt/command digest 来自 owner，不从输出推导。最终披露前重新检查当前运行授权和原持久 wall deadline；不复用五秒发送窗口。显式关闭、取消、撤权、不确定退出、迟到或格式错误返回无候选。候选不发布 `InvestigationResult`、不生成工具回执、不证明树终态、不释放槽位；调用方仍须 finally close。当前仅有离线回归，CLI 2.1.284 的真实输出兼容性与原生 turn budget 执行未验证，生产 profile 继续关闭。见 MODEL_NATIVE_OUTCOME_CANDIDATE_2026-10-02.md（私有历史记录，见[验证状态](release-evidence.md)）。

CapabilityReport：capability_id、status(supported/unsupported/unverified)、adapter_version、runtime_version、account_binding、verified_at、evidence_refs、limitations。换账号、版本、授权或关键配置时使相关证明失效。

consumed 树的 Z 状态不能作为缺席证据：仅原 PID/start ticks 匹配时允许无信号等待真正缺席，持续 Z、身份变化、X/x 和未知状态仍拒绝；等待共用原绝对期限。可信 supervisor 仅可回收自身持有的 Popen 子进程，帧等待/EOF/hash/journal 锁约束不变。程序更新必须保留精确历史身份验证：仅固定 parent program 参数可使用编译进源码、由冻结 Git 核实的历史 SHA256/字节长度白名单，其余 argv 与完整事实逐项校验保持。历史读取及 cleanup 不授予新启动/发送资格；新 owner 观察、outer/intent/send 票据和新事实入库要求当前 program。launch 始终生成当前代码，不提供版本选择，不动态学习白名单、不改写旧事实。D160 的候选实施仍需回归和独立审查；第三实测失败及兼容回归不构成恢复/发布通过。

产品必须分别显示：服务在线、读取可用、会话身份核实、多轮历史同步、investigator 隔离、MCP直交、原生文件引用、本地授权收取。不要一个 Connected 代表全部。

标准仅作为传输：MCP 用于工具；A2A 为将来适配候选，首版不强制实现。外部平台不支持 side-effect tools 时，使用真实的本地收取/显式处理路径并标 restricted，不伪称 direct_path 已成功。[C07]

## 10. 可观测性与单一事实源

结构化调查新增闭合 `investigation_result_v1` wire：实际固定快照读取后持久成功页回执，绑定原 request/attempt/epoch/native、worker grant/身份和页字节范围/hash；不从预算计数补造历史读取。回执仅证明 handler 准备返回。完整 UTF-8/BOM 字节和实际页核验 evidence；拒绝 provider `tool_observed`，来源核验不等于语义结论证明。原 owner 同 epoch 完成 gate close、独立树观察与分别用途的一次性票据；close 前和 tree 前检查当前所有权，tree 前保留至少 17 秒租约覆盖最多 15 秒观察。heartbeat 续租不扩大 wall 执行预算。SQLite 单事务复核当前 request/worker grants 与路径，保存树事实、完整 wire provenance、去掉 wire byteRange 的 canonical result、终态及删除 outbox/占位；取消/撤权仅在树证明成立后以 null result 释放，未知树保持恢复。应用组合注入内部同实例票据并先等待 modelRuns 再关闭 stores。限定离线回归及独立审查通过，纵向 native/model/tree 仍为 synthetic；不开放 production profile，不代表 live 或 release_ready。见 D198 与 investigation publication receipt。

日志默认只含 opaque IDs、operation、effect、safe reason、timing、status、baseline 和证据引用。prompt/源码正文在受控内容存储，非普通日志；credentials、signed URL、cookie/profile 永不导出。支持按 collaboration 导出脱敏支持包。

原生模型调查的当前 sealed prompt 容量为完整序列化后 16384 UTF-8 字节，包括可信绑定、结果合约、问题和已接受 context；领域 question 字段上限不等于该 runtime 对全部合法组合的执行保证。完整构造后先在 claim/resource reservation 前检查，coordinator 在任何原生启动前复查；禁止截断、丢弃 context 或改写 revision。超限明确报告 `MODEL_PROMPT_LIMIT_EXCEEDED`，诊断仅含 actualBytes/maxBytes。已有 reservation 的调用保留占位，记录固定 `model_prompt_limit_exceeded` 并进入既有恢复路径；不能伪造 termination 或直接释放槽位。该接口决定见 D197；实现与限定离线纵向已验证，真实模型/原生树验收仍待完成，不能据此开放生产 profile。

运行时 core 是自身生命周期事实源；provider 是原聊天事实源；仓库/快照是源码事实源；已批准项目文档是其 Git 中的事实源。不要让数据库与同名 repo 文档独立双写。

退出顺序：拒绝新写请求→停止发送/dispatch→settle或标unknown→flush证据→关闭DB。重启重新对账 leases、outbox、attempt和staging；不根据上次内存状态猜完成。所有迁移和清理均有失败恢复用例。

D239当前固定Windows alpha17.2协议仅将严格绑定同一未终态thread/turn的
已知暂态连接error/`willRetry=true`视为原生同回合恢复通知。该通知不授权
新的RPC、attempt、工具读取或预算续期，计入原通知和总字节上限；provider
文字不保留。认证/权限/限额/重试耗尽/未知类别或非法身份仍立即失败。
明确turn终态、唯一完整final、实际receipt与snapshot和原owner关闭才允许
结果结算。历史目标保持原行为，旧失败/unknown不补写为成功。

### D239 个人 Windows 第二运行时

Windows Claude adapter 使用同一个通用调查请求、profile budget、固定快照和
成功读取账本；不使用 Codex thread/turn 伪装身份，也不经过旧 WSL 资源调度。
本机管理员显式选择当前 static_readonly_v1，MCP 只接受/查询/取消请求，
`run-claude-investigation` 执行明确的一个未尝试请求；外部输入不能选择
可执行文件、命令、环境或回调。固定官方 CLI 复用当前用户既有 GLM 配置，
空工作目录、禁内建工具、唯一受限 MCP、禁普通 hooks/CLAUDE.md 自动读取，
并绑定 wall/turn/tool-call 预算。managed policy 不得被绕过。

本机启动器仅从固定用户 `.claude/settings.json` 的 env 中读取既有连接、
认证与四个模型键，整组在进程内存中传给原生 helper 和 CLI；不混配宿主
的 provider 环境，不传用户 hooks/permissions/工具设置，不另存凭据文件。
当前明确的既有端点为 `https://open.bigmodel.cn/api/anthropic`；配置缺失、
不完整或非法即在模型启动前拒绝，不回退到需要其他账号的 OAuth。

当前2.1.287流还包含精确的ui_invalidate/ui.render通知、同session的
thinking_tokens计数及assistant thinking块。adapter只识别这些已观察形态：
启动前UI通知的session必须与随后init相同；计数通知必须在init之后、字段
闭合且为非负安全整数。thinking及signature是不透明原生字段，不产生工具、
结果或证据。未知通知、身份变化、非法字段和结果后的流量仍拒绝；原256KiB/
1024行、唯一工具/配对、回合上限及完整结果与真实读取回执校验保持。

若原生最终result整段恰为单层小写json代码围栏，adapter仅去掉最外层标记，
保留内部JSON原文；LF/CRLF均支持。前后解释、多段、嵌套或其他标签不提取。
原始流及hash不变，内部仍须通过严格schema、重复字段、回执和快照校验。

原 Windows Job 提供本次 nativeRef 的启动和完整关闭事实；私有回调将事实
绑定 claim/epoch，模型文字和调用方布尔值不产生该权力。真实 `repo.read`
仍走唯一 handler，成功回执与准确快照字节通过后才产生 canonical result；
wire byteRange 只用于校验，原始输出在私有尝试目录保留。取消后闭合才清除
结果，未知关闭保留 active attempt。通用过期意图重启只投影为
recovery_required，不自动重试、释放占位或清理其他 runtime。旧通用
completed.terminationConfirmed 字段语义不变，当前 Job 关闭单独记录，
不能把该字段或定向模拟测试冒充真实第二 runtime 验收。

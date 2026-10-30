# 安装、配置与恢复

**日常入口：**在支持日常命令的安装中，`rcac setup --file-source chatgpt` 一次准备私有状态和 Skill，并返回 `connection.command` 与 `connection.args` 供现有 MCP host 连接。身份由程序生成，无需填写 principal 或 recipient；setup 不分享项目。已有安装启用该预设用 `enable-chatgpt-files`。新默认数据目录为 `~/.repo-conduit/data`；旧默认布局保留，不自动迁移，冲突时显式选择 `--data-dir`。setup 默认将 Skill 复制到 `~/.agents/skills/consult-external-agent`，同名不同内容会保留并报错。源码文档更新不会升级已安装包。

讨论、课题查询和文件收件等日常命令的 `--project` 使用已存在 Git 根目录的绝对路径；调查管理命令的选择器另支持已注册的唯一精确项目名。首次 `discuss --project ... --topic ... --question ...` 须按本人授权指定重复 `--share`（目录以 `/` 结尾）或 `--share-tracked` 二选一；后者选取 HEAD 中跟踪文件，未提交或未跟踪内容不进入冻结材料。再次分享替换范围而非追加；同名题复用原问题及快照。新提交需要新题，再用 `publish-project` 发布材料。网页 MCP 可按返回的项目 ID 或唯一精确名称选择，不要手填内部 ID。

`inbox/receive/export` 按项目、题目和版本工作；`receive --file` 是本机绝对原件路径。安全解压后可用 `receive --from-directory` 选择目录，保留相对路径和不同目录下的同名文件；`--parent-version` 指同题已发布父版，不合并或覆盖父版。`source-export --file` 使用冻结快照内相对路径。本地收件、导出、原件导出和人工原生下载均不需要 Tunnel、密钥或完整聊天同步。客户端文件交付遵循实际公布的 schema 和可访问原件，不手填 URL/ID 或重建字节。

已有官方 Tunnel 可在 setup 同时提供 `--tunnel-client` 和 `--tunnel-id` 保存配置，`--proxy` 是可选本地 HTTP 代理；`rcac connect` 前台运行，`--dry-run` 不联网，不代表自启动或当前在线。`use-codex` 选择安装级已有调查来源，`enable-investigation` 为项目显式启用并沿用现有预算；首次新 profile 默认 120 秒、3 回合、12 次工具调用。新题复用该 profile；启用服务可能处理原有排队任务，先核对队列。更多步骤见[个人使用](personal-use.md)及[HTML 手册](user-guide/index.html)。

历史组件验证和完整发布的区分见[验证状态](release-evidence.md)。

本文覆盖本地 CLI、MCP stdio 和自管 OAuth HTTP 的回环入口。当前没有服务安装器、后台服务管理器、Web 控制台或 host 配置编辑器；操作员需要从 PowerShell 启动 CLI，并在实际客户端配置连接。

Codex Windows Desktop 可作为本地 host，直接在获授权的任务中运行本机 `rcac` CLI；这条入口不需要 WSL。要让客户端自动发现 RepoConduit MCP 工具，仍须按下文配置受限 stdio 连接；CLI 不会自动装入客户端设置。网页收发/同步由具有官方浏览器和历史工具的 host 驱动 `host-conversation`，不是 CLI 内置浏览器。受限 AI investigator 是另一执行边界；当前研发任务的权限不能代替它。

使用安装包中的 `skills/consult-external-agent/SKILL.md`，指定实际数据目录并核对项目、课题与快照。本人可接管讨论，回到 host 会话桥恢复须先同步；普通本地收件不依赖会话桥。登录、同意和本机密钥输入由本人完成。历史组件与局限见[验证状态](release-evidence.md)。

## 当前能力边界

- CLI 接受 `init`、`init-managed`、`backup ABSOLUTE_DESTINATION`、`restore ABSOLUTE_BACKUP`、`upgrade --package ABSOLUTE_TGZ --backup ABSOLUTE_DESTINATION`、`doctor`、`request`、`host-conversation [ABSOLUTE_DOWNLOAD_ROOT]`、`collect-local ABSOLUTE_SOURCE`、`collect-local-set`、`configure-mcp`、`mcp`、`configure-oauth`、`configure-file-origins`、`serve-http`。以下高级原语使用绝对路径形式的 `--data-dir`；日常命令可采用上文默认目录。`request`、`collect-local`、`collect-local-set`、`configure-mcp`、`configure-oauth`、`configure-file-origins` 从标准输入读取单个 JSON 对象，最大 1 MiB。`host-conversation` 是持续运行的 JSONL 前台桥进程，负责接收已授权的会话动作并回传真实 host 观察；不是浏览器，也不能单独取得网页历史。
- `mcp` 是由 MCP host 启动的 stdio 子进程，不是监听 TCP/HTTP 的服务。它读取本地 `mcp-binding.json`，再把该固定主体、audience、recipient 和 workspace 绑定到该进程的连接。
- 本地 `configure-mcp` 会检查已有 grant 与请求公开的操作；直接编辑 binding 文件不会创建授权。撤销 grant 后，后续调用会重新鉴权。
- `serve-http` 把本地 OAuth issuer、逐请求 opaque-token introspection 和产品 HTTP MCP 接到统一 dispatcher；产品 grant 仍单独控制可读范围。两个监听器只绑定 127.0.0.1。真实 ChatGPT OAuth client/consent 尚未验收；既有无 OAuth Tunnel 的合成网页实测是另一条已记录路径，不能代替该项。浏览器 Developer Mode 不会让本地监听器自动对网页可达。
- D239 已接入个人 Codex 调查的本地应用运行入口、固定原生启动器与结果结算，调用方式见下方 Windows 配置小节。默认不开启；2026-10-27 旧安装包的网页调查实测见上方回执，不能转移为其他包的完整 LIVE 验收。MCP operation catalog 中存在 `investigate.*` 名称也不能证明已完成安装或实测。
- 当前没有经过完整发布门禁的 release。`npm run verify:release` 已实现失效即拒绝的证据检查；当前缺少真实验收回执时会列出阻塞并退出非零。
- Windows Desktop 路线可在已初始化的数据目录运行 `rcac --data-dir $DataDir codex-windows-readiness`。该命令只启动固定版本的本机 Codex App Server，发送 `initialize`、`initialized` 和参数为 `null` 的 `windowsSandbox/readiness`，不执行 `setupStart`、登录、thread/turn 或模型调用。2026-10-15 当次记录的固定目标为 Desktop 包 `26.1007.9446.0`、`codex-cli 0.162.0-alpha.17.2`；路径和CLI版本的实际观察见源码仓中的 `D239_DESKTOP_PATH_FIX_2026-10-15.json`（私有历史记录，见[验证状态](release-evidence.md)），不代表重新执行了readiness。版本或路径变化会失败并要求重新核查 schema。2026-10-03 在旧版本上的零模型诊断先返回 `ready`，随后源码 wrapper 返回 `updateRequired`，是各次当时的记录，见 `WINDOWS_READINESS_BINDING_2026-10-03.md`（私有历史记录，见[验证状态](release-evidence.md)）；不是当前版本验收。输出的 `readiness` 只描述当前 Desktop 环境，`isolationVerified` 固定为 `false`、`modelTurn` 固定为 `not_run`；不得仅凭 `ready` 打开生产调查 profile，也无需为复用已测试的个人Windows路径重复该诊断。

2026-10-03 的后续只读诊断在两份既有原生日志中定位到
`helper_sandbox_lock_failed`：锁定 `.sandbox-bin` 时打开目录失败。日志还报告
失败前已配置防火墙/WFP；当前过滤器状态未独立验证。当前目录 owner 已有
ChangePermissions，不能据此猜测 ACL 修复。失败 helper 身份及底层错误码仍
未知；再次执行 provisioning 可能改本地账号、防火墙和权限，须先核定范围并
取得普通用户授权。不要把 `codex sandbox` 当作纯只读诊断或关闭调查隔离。
记录见 [Windows provisioning 诊断摘要](release-evidence.md)。

Windows readiness 的产品 CLI 默认入口现使用 owned Job stdio 通道；实际
安装后 CLI 输出包含原 root PID/FILETIME、双 EOF 后的完整空 Job closure。
从源码使用这条诊断前，除 `npm run build` 外须显式执行
`npm run build:windows-helper`；旧 manifest 或缺少 helper 会拒绝，不会在
安装时自动编译或下载。`npm run test:windows-helper:installed` 离线打包、
安装并初始化临时私有数据目录，执行真实 CLI 的 readiness；这是有界诊断，
不会启动模型、provisioning 或登录，也不提升完整发布验收。详见
[D220 关闭事实与安装 CLI 证据摘要](release-evidence.md)。

## 安装与首次初始化

要求使用 Node.js 24.x（`package.json` 限制 `>=24 <25`）和 npm。以下命令从仓库源码构建并安装本地 CLI：

```powershell
node --version
npm --version
npm ci
npm run build
npm install --global .
```

`npm run build` 生成 `dist/src/cli/main.js`；全局安装后 CLI 名称为 `rcac`。若不想全局安装，可在 PowerShell 中设置 `$RepoRoot` 为仓库路径，并用 `& node (Join-Path $RepoRoot 'dist\src\cli\main.js') --data-dir $DataDir init` 调用；其他 CLI 动作同理。

选择一个专用于 RepoConduit 的新数据目录。初始化是 create-only：路径已存在时会拒绝继续，不会覆盖已有数据库或重置管理员。Windows 上优先放在当前用户的本地应用数据目录下；项目会检查数据目录及其祖先目录的 ACL，并检查 `state.sqlite` 和可选 `mcp-binding.json` 的 ACL。其他平台按实现检查数据目录权限位及 binding 文件权限位，并确认数据库文件存在。若当前机器的 `%LOCALAPPDATA%` 祖先 ACL 被判为不安全，初始化会拒绝；先核对 ACL，再选择当前用户私有的其他绝对目录，例如 `%USERPROFILE%` 下的独立目录，不要关闭检查或修改全局权限来绕过。

```powershell
$DataDir = Join-Path $env:LOCALAPPDATA 'RepoConduit-data'
rcac --data-dir $DataDir init
```

成功时 CLI 输出 JSON，包含 `initialized`、`dataDirectory` 和当前操作系统主体 `principal`。首次初始化只建立本地管理授权和 SQLite 状态文件，不会注册项目、启用 MCP host 或启动服务。若目标已存在，先确认它是否为已有数据目录；不要删除目录后重试。

### 新建受管安装

明确选择另一个全新、尚不存在的根目录：

```powershell
$ManagedRoot = Join-Path $env:USERPROFILE 'RepoConduit-managed'
rcac --data-dir $ManagedRoot init-managed
```

父目录须已存在。此命令创建私有维护锁、一个版本化 generation 的数据目录、
四类 SQLite 状态及初始本地管理授权，最后写入 `managed.json`。后续命令
继续使用 `$ManagedRoot`，不要直接指向 `generations/.../data`。内部数据目录
及其 junction 别名不能作为独立安装入口。

初始软件来源是当前安装的 CLI；不会复制或假建 generation 的 `package`
目录，也不启动恢复、调查、模型或监听器。已有 flat、受管或半成品目录均拒绝
接管。失败后保留目录；发布开始后的失败保持当前进程的维护锁，但进程退出后
仍需核对磁盘上的清单与数据，不能认定“失败即未发布”。不要删除目录或重复
初始化来处理中断。初始化本身不执行迁移或恢复；专用备份、恢复及已实测的受管升级兼容对与剩余门禁见下文。

`npm run package:managed-smoke` 从打包产物离线安装到独立 prefix，检查受管
初始化、四类表、重复初始化字节保持、维护排他、本地请求以及专用 CLI 备份恢复的原授权和二进制保留；不验证真实模型、
ChatGPT 接入或完整发布。

## 本地 Host Skill

安装包包含 `skills/consult-external-agent/`：`SKILL.md`、命令参考和
`agents/openai.yaml`。在现有 host 中显式读取这个安装目录下的 Skill，即可沿
既有 `request` 与 `host-conversation` CLI 执行咨询、追问、接管、同步、收件和
本地审查。选择的数据目录、workspace/collaboration、基线与预算仍须来自
产品回执；网页 URL 不选择工作区。Skill 不创建授权、不开启 managed 调查。

`rcac setup` 会按上文复制整个 Skill 到默认发现目录；其他 host 的发现目录
可能不同，需按其支持方式放置并保留现有同名 Skill。可使用 `$consult-external-agent`；
setup 不会自动编辑全局 host 配置。移除该副本仅取消 Skill 发现，不删除 RepoConduit 数据。

会话桥与其浏览器收取路线需要实际可调用的官方浏览器/历史工具；仅加载网页或
安装 Skill 不提供这些能力。工具缺失时保持对应步骤 unavailable，可继续
本地查询和审查。桥接输入说明见[前台 host 会话桥](host-conversation.md)。

## 注册 workspace 与 working copy

每个请求都需要明确的 workspace ID；不要以“最近项目”替代。先注册一个已存在的项目目录，再为实际参与调查的工作副本登记路径。CLI 请求 envelope 使用 `operation`、`scope`、`payload` 和副作用操作要求的 `idempotencyKey`。示例：

```powershell
$WorkspaceJson = @'
{"operation":"admin.register_workspace","scope":{"workspaceId":"management"},"idempotencyKey":"register-workspace-001","payload":{"name":"My project","root":"D:\\Projects\\MyProject"}}
'@
$Workspace = $WorkspaceJson | rcac --data-dir $DataDir request | ConvertFrom-Json
$WorkspaceId = $Workspace.id

$WorkingCopyJson = @"
{`"operation`":`"admin.register_working_copy`",`"scope`":{`"workspaceId`":`"management`"},`"idempotencyKey`":`"register-working-copy-001`",`"payload`":{`"workspaceId`":`"$WorkspaceId`",`"root`":`"D:\\Projects\\MyProject`"}}
"@
$WorkingCopy = $WorkingCopyJson | rcac --data-dir $DataDir request | ConvertFrom-Json
```

注册会解析并验证路径存在且为目录；产品入口拒绝与私有数据目录重叠的 workspace/working copy 根。保存命令返回的 opaque `ws_...` 和 `wc_...` ID；后续 CLI/MCP 操作必须使用准确 ID。注册 working copy 只登记目录，不表示已采集快照或已向任何外部主体授权。

## 本地原始文件收取与审查副本

`artifact.collect_local` 使用本地 OS 主体、明确的 workspace/collaboration 和独立的 `artifact.collect` grant。操作员在 CLI 参数中选择一个绝对路径；命令 JSON 只包含 bundle ID、bundle 内相对路径和 media type。源文件路径不会进入 bundle manifest 或公开回执。普通 `request` 不接受这个操作，外部 MCP 也不能调用它。源必须是单个普通文件，位于产品数据目录和所有已注册 workspace/working copy 之外；链接、设备、多硬链接和超过 32 MiB 的文件会被拒绝。ZIP 保留原字节并检查内部路径与预算，不自动解包或执行内容。

先在该 collaboration 中取得 `artifact.submit`、`artifact.read`、`artifact.collect`、`artifact.export` 的本地 grant，使用已有 `artifact.begin` 创建预期路径明确的 bundle。以下是随后逐文件收取的命令形状，`$WorkspaceId`、`$CollaborationId`、`$BundleId` 与文件路径都必须替换为真实值；源文件由操作员亲自选择，不能用另一个工作区的源码作为源：

```powershell
$CollectJson = @"
{`"operation`":`"artifact.collect_local`",`"scope`":{`"workspaceId`":`"$WorkspaceId`",`"collaborationId`":`"$CollaborationId`"},`"idempotencyKey`":`"collect-raw-v1`",`"payload`":{`"bundleId`":`"$BundleId`",`"path`":`"assets/raw.bin`",`"mediaType`":`"application/octet-stream`"}}
"@
$CollectJson | rcac --data-dir $DataDir collect-local 'C:\Users\me\Downloads\raw.bin'
```

也可以用 `collect-local-set` 一次提交操作员明确选定的 1–256 个绝对源文件。输入包含 `scope`、`bundleId`、`contextRevision`、`snapshotRefs`、可选 `parentBundleId`，以及每个文件的 `sourcePath`、bundle 相对 `path` 和 `mediaType`。命令按目标路径稳定排序，依次 begin/collect，全部成功才 finalize；中途失败保持 staging，修复缺失源后用原清单重试。它不会递归扫描目录，源路径不会进入成果清单；来源仍为 `manual_import`，不代表 ChatGPT 自动交付。示例：

```powershell
$Set = @{ scope = @{ workspaceId = $WorkspaceId; collaborationId = $CollaborationId }; bundleId = $BundleId; contextRevision = $ContextRevision; snapshotRefs = @($SnapshotId); files = @(
  @{ sourcePath = 'C:\Users\me\Downloads\raw.bin'; path = 'assets/raw.bin'; mediaType = 'application/octet-stream' },
  @{ sourcePath = 'C:\Users\me\Downloads\bundle.zip'; path = 'archives/bundle.zip'; mediaType = 'application/zip' }
) } | ConvertTo-Json -Depth 5 -Compress
$Set | rcac --data-dir $DataDir collect-local-set
```

每个文件使用不同的幂等键。相同键重试会重新读取并核对源字节；文件改变时拒绝冲突。文件集齐后调用 `artifact.finalize`，保存它返回的原始单行 JSON；manifest hash 是这行 JSON 的 UTF-8 SHA-256（不含行尾换行），不能根据重新排版的 JSON 猜测。`artifact.export` 只将已发布且完整的 bundle 复制到私有 `$DataDir\exports\<exportName>`，要求该 hash 与 `expectedManifestHash` 相同，并拒绝覆盖已有目标；它不写项目源码、不自动采纳，也不执行包内规则。导出命令形状如下：

```powershell
$ExportJson = @"
{`"operation`":`"artifact.export`",`"scope`":{`"workspaceId`":`"$WorkspaceId`",`"collaborationId`":`"$CollaborationId`"},`"idempotencyKey`":`"export-review-v1`",`"payload`":{`"bundleId`":`"$BundleId`",`"expectedManifestHash`":`"$ManifestHash`",`"exportName`":`"review-v1`"}}
"@
$ExportJson | rcac --data-dir $DataDir request
```

导出用于本地阅读原始文件；`decision.review` 和 `decision.record` 是后续独立的本地动作，并仍需检查当前快照与上下文基线。导出和决策均不代表源码实施授权。再次导出同一名称时只允许同一操作的完整性核验重试；目标被改动会返回错误，须人工检查，不能静默覆盖。

本地 agent 若在成果交付后才启动，可先用 `artifact.list` 发现指定 collaboration 中已发布的 bundle，再对目标调用 `artifact.inspect`。两者都要求 `artifact.read` grant，且不公开给外部 MCP。`artifact.list` 默认每页 10 项，`limit` 范围为 1–10；返回的 `nextCursor` 只用于同一主体、范围和页大小的后续页。分页固定首轮看到的发布上界；并发新发布须重新从第一页列举。列表里的 `integrityStatusRecorded` 是存储值，检查当前字节和获取可用于导出/决策的 `manifestHash` 应调用 `artifact.inspect`。例如：

```powershell
$List = @{ operation = 'artifact.list'; scope = @{ workspaceId = $WorkspaceId; collaborationId = $CollaborationId }; payload = @{ limit = 10 } } | ConvertTo-Json -Depth 4 -Compress
$List | rcac --data-dir $DataDir request
$Inspect = @{ operation = 'artifact.inspect'; scope = @{ workspaceId = $WorkspaceId; collaborationId = $CollaborationId }; payload = @{ bundleId = $BundleId } } | ConvertTo-Json -Depth 4 -Compress
$Inspect | rcac --data-dir $DataDir request
```

`artifact.inspect` 的 `ready` 只表示这一次核验的包对象完整，不表示建议已接受或当前源码仍符合原快照。`decision.record` 可选传入逐项 `items`，每项包含稳定 `id`、`sourceRef`（`bundle:<bundleId>` 或 `file:<manifest内相对路径>`）、`outcome`（`accept`/`modify`/`reject`）与非空 `reason`。最多 100 项，总体 `outcome` 必须与逐项结论一致；仍需先按原 bundle hash 调用 `decision.review`，并保持本地决策权限。历史没有 `items` 的决策继续有效；逐项记录不会授权修改源码。

已安装包还包含 `tools/archive-live-bundle.mjs`，用于在真实运行后归档**已发布** bundle 的 manifest 和每个文件的原始字节。它使用当前本地 OS 主体调用已安装 CLI 的 `artifact.inspect`、`artifact.export`，因此要求目标 collaboration 的 `artifact.read`、`artifact.export` grant；归档前后都核查发布对象。输入必须给出精确的 workspace、collaboration、bundle、case 和版本角色，仓库证据根目录须已包含 `verification/RUNTIME_ACCEPTANCE.json`。例如，以下命令从包目录执行，`$DataDir` 与各 ID 由实际运行记录提供：

```powershell
$PackageRoot = Join-Path (npm root -g) 'repo-conduit'
$Cli = Join-Path $PackageRoot 'dist\src\cli\main.js'
$Archiver = Join-Path $PackageRoot 'tools\archive-live-bundle.mjs'
$EvidenceRoot = (Resolve-Path '<证据仓库绝对路径>').Path
$ArchiveRequest = @{ runId = 'LIVE01'; role = 'v1'; scope = @{ workspaceId = $WorkspaceId; collaborationId = $CollaborationId }; bundleId = $BundleId } | ConvertTo-Json -Depth 4 -Compress
$ArchiveRequest | node $Archiver --data-dir $DataDir --cli $Cli --evidence-root $EvidenceRoot
```

命令只输出 `bundle_deliveries` 的一项引用：`role`、`manifest_ref`、`manifest_hash`、`file_refs`。LIVE01 用 `v1`、`v2` 分别运行，LIVE02 用 `independent`；本地 runner 在复核实际工具/文件来源后，将结果加入对应真实回执。重复归档同一对象只在现有字节完全相同的情况下成功，证据被改动时拒绝覆盖。**原始字节会复制到指定仓库的 `verification/live/`，归档前必须确认这些文件获准进入该证据仓；含私有源码或秘密的文件不可直接提交。** 这个命令不会生成 provider 工具回执、把 `manual_import` 改成自动 route，或把 LIVE 状态改成 passed。`verify:release` 另行核对逐文件来源与内容。

本地 agent 重启后若不知道决策 ID，可在指定 workspace/collaboration 调用 `decision.list`（payload 可带 `limit` 1–10、`cursor`），再用 `decision.get` 的 `{ "decisionId": "..." }` 读取完整 DecisionRecord。两者要求当前 `context.read` grant，且仅在本地 CLI/host 可用。列表游标只能由同一主体、接收方、范围和页大小续用；分页期间新增决策需重新从第一页列举。历史决策与源码实施授权仍分离。

建议提交扩展（已通过离线 SDK/SQLite 测试和独立复审）：
已配置并获 `decision.propose` grant 的参与者可提交 payload
`{ "proposalId": "suggestion-1", "contextRevisionId": "ctx-1", "snapshotId": "snapshot-id", "recommendation": "modify", "reason": "建议与理由" }`，
并提供明确 scope 与 idempotencyKey。可选 bundleId/bundleManifestHash 必须成对，
绑定已发布成果；reason 最多 16 KiB UTF-8。建议回执只表示已保存，不批准实施。
本地 `decision.get` 使用 `{ "proposalId": "suggestion-1" }` 读取完整建议，
不得同时提供 decisionId；`decision.list` 的 `{ "kind": "proposal" }` 返回建议
摘要和 nextCursor，默认列表仍为正式决策。建议与正式决策游标不能互换。
外部 MCP 不提供 get/list 或正式决策记录工具。真实网页调用仍待验收。

正式建议决策扩展已通过离线回归与独立复审，真实端到端验收仍待完成。本地 `decision.review` 的
payload 可选择 `{ "reviewId": "review-1", "proposalId": "suggestion-1",
"snapshotId": "snapshot-id", "contextRevisionId": "ctx-1" }`；不得混入
bundleId/bundleManifestHash。之后本地 `decision.record` 使用相同 proposalId、
原 snapshot/context，加 decisionId、reviewId、outcome 和 reason。accept/modify
要求复核后的当前上下文与快照仍匹配；变化后须重新复核。reject 可直接记录。
建议目标的逐项 sourceRef 只能是 `proposal:suggestion-1`。建议提交者和建议的
recommendation 不决定本地结论；正式记录也不授予源码实施权。

换聊后按绑定中保存的 `contextRevisionId` 调用 `context.read`，payload 为 `{ "revisionId": "ctx_..." }`，即可重读同一议题的固定版本；空 payload 读取当前版本，`{ "proposalId": "..." }` 读取提议。`revisionId` 与 `proposalId` 不能并用。此读取不自动把背景发送给外部聊天，发送前仍须核对实际接收会话与授权材料。

## 受限调查策略配置

`admin.configure_profile` 使用可信本地 CLI 的 management scope。payload 为
`{ "workspaceId": "ws_...", "expectedRevisionId": null,
"presetRef": "static_readonly_v1", "budget": { "maxWallSeconds": 600,
"maxTurns": 8, "maxToolCalls": 40 } }`，并提供 idempotencyKey。
首次配置的 expectedRevisionId 必须显式为 null；后续修改传上次回执的 id。
版本冲突后重新核对当前配置，不能盲目覆盖。预算只能为正 safe integer，
且不超过上述策略上限。turn intent 按 attempt 计数，工具预约按 request 累计。

新 init 会明确授予 admin.profile；旧数据目录不会自动扩权。现任管理员可
通过既有 admin.grant 显式向 management 授予单一 admin.profile，目标使用
当前 CLI 的 local-os audience、recipient 与 principal 相同，不带
collaborationId 或 dataPaths。配置成功只保存不可变策略版本；返回
runtimeAvailability=unavailable。它不登录账号、启动模型或证明隔离合格。
这一入口已通过 26 项合并回归、独立复审及安装包配置/重放验证；真实调查
运行仍待完成，不能从配置成功推定模型可用。

## 配置本地 MCP stdio

先通过可信本地 CLI 创建范围明确的 grant。以下示例只允许一个本地 MCP 主体在一个 workspace 中打开和读取 collaboration；`principal`、`audience`、`recipient` 必须与本地 binding 一致。示例身份字符串是本地选择并固定在 binding 中的授权标识，不是 host 提供的登录身份或平台认证令牌。当前 stdio 适配器不对网络调用方做身份认证；能以该数据目录权限启动进程的一方会使用此 binding 身份，因此只应配置可信的本地 MCP host：

```powershell
$McpPrincipal = 'repo-conduit-local-client'
$McpAudience = 'local-mcp'
$GrantJson = @"
{`"operation`":`"admin.grant`",`"scope`":{`"workspaceId`":`"management`"},`"idempotencyKey`":`"grant-local-mcp-001`",`"payload`":{`"principal`":`"$McpPrincipal`",`"audience`":`"$McpAudience`",`"workspaceId`":`"$WorkspaceId`",`"recipient`":`"$McpPrincipal`",`"permissions`":[`"collab.create`",`"collab.read`"],`"expiresAt`":null}}
"@
$Grant = $GrantJson | rcac --data-dir $DataDir request | ConvertFrom-Json
```

`configure-mcp` 校验 binding 中的每一项操作都受该主体现有授权，并以 create-only 方式写入 `$DataDir\mcp-binding.json`；已存在时会拒绝覆盖，没有 CLI 重绑/轮换命令。下面配置与上例 grant 对应：

```powershell
$BindingJson = @"
{`"principal`":`"$McpPrincipal`",`"audience`":`"$McpAudience`",`"recipient`":`"$McpPrincipal`",`"workspaceId`":`"$WorkspaceId`",`"visibleOperations`":[`"collab.open`",`"collab.get`"]}
"@
$BindingJson | rcac --data-dir $DataDir configure-mcp
```

按你正在使用的 MCP host 的正式 stdio 配置格式，配置它启动 `rcac --data-dir <绝对数据目录> mcp`。此仓库不修改 Codex、Claude 或其他 host 的全局配置，也没有提供 host 配置 JSON schema；不要直接照抄本指南之外的猜测字段。由 host 启动进程后，host 与该 MCP server 通过标准输入/输出通信。

平台文件导入默认关闭。只有 binding 与当前 grant 已允许
`artifact.import_reference` 时，stdio 入口才读取下文的既有私有 OAuth 配置，
复用其中精确的文件来源列表及 HTTP 下载器。该读取不借用 OAuth 身份，
不启动 issuer，也不新增 grant。配置缺失或来源为空时文件工具不发现；已有
配置非法或不私有则启动失败。当前没有纯 stdio 的独立来源配置命令，不要
为了启用下载创建虚构 OAuth 配置。更改来源后须重启实际使用的 `mcp`
子进程或 `serve-http`，运行中的连接继续使用启动时的来源列表。

MCP server 只会发现源码中已接线、surface 为 `external_mcp` 且在 binding 与 grant 中均获准的操作。隐藏工具不是权限边界的唯一检查；每个调用仍经统一 dispatch 授权。`visibleOperations` 不能扩大 grant。修改授权时使用本地 `admin.grant`/`admin.revoke`，不要手工编辑数据库或 binding 文件。

## 自管 OAuth HTTP 回环服务

这个入口适合已有受信任 HTTPS 反向代理、实际 ChatGPT OAuth client ID 和回调地址的操作者。OpenAI Secure MCP Tunnel 只承载 MCP 流量及发现信息；浏览器要访问的授权页和令牌端点仍需独立可达的 HTTPS issuer。当前项目没有自动部署或购买这类公网入口。**没有这些真实配置时不要把示例域名提交给 `configure-oauth` 并宣称已经接通。**

先用本地 `admin.grant` 给一个明确的外部 principal、resource audience、recipient、workspace 和所需操作授予权限。`configure-oauth` 会再核对该 grant、工作区、issuer/client/subject 与 scope 到操作的映射；不会自动授予权限。它从标准输入接收单个 JSON 对象，结构如下（值仅示意，不能直接用于真实连接）：

```json
{
  "issuer": "https://issuer.example.test",
  "resource": "https://mcp.example.test/mcp",
  "clientId": "actual-client-from-chatgpt",
  "redirectUris": ["https://chatgpt.example.test/actual-callback"],
  "scopes": ["collab.read"],
  "operator": { "subject": "operator-1", "password": "ENTER_SECURELY_AT_RUNTIME" },
  "binding": {
    "issuer": "https://issuer.example.test",
    "clientId": "actual-client-from-chatgpt",
    "subject": "operator-1",
    "principal": "approved-external-operator",
    "recipient": "actual-client-from-chatgpt",
    "workspaceId": "EXACT_WORKSPACE_ID",
    "scopes": {
      "collab.read": {
        "delegatedPermissions": ["collab.read"],
        "visibleOperations": ["collab.get"]
      }
    }
  }
}
```

在本地交互中安全输入密码并把完整 JSON 通过管道送给 `rcac --data-dir $DataDir configure-oauth`；不要把含明文密码的 JSON 放在源码仓、Shell 历史或日志中。命令生成稳定签名密钥、cookie key 和密码的 scrypt hash，create-only 写入私有 `$DataDir\oauth-config.json`；不会回显密码或密钥。已经存在的配置不会被覆盖；当前没有自动轮换命令。将该配置文件、`issuer.sqlite` 和原有数据目录作为同一受保护数据集备份。

`resource` 可以是规范 HTTPS origin 或带非尾斜杠路径的完整资源 URL；issuer 仍只能是规范 HTTPS origin。受保护资源元数据从完整 resource 路径派生，例如示例 resource 对应 `/.well-known/oauth-protected-resource/mcp`。token audience、产品 grant 和 issuer 的 resource 必须逐字一致。已有 origin 配置按原值保留，不会自动迁移到路径；改用路径时须在新的私有配置中明确设置 audience、重新授予对应 grant 并重新完成外部客户端关联和同意。Tunnel 对外 resource 及反向代理路径以真实发现响应为准，不可从 tunnel ID 猜测公网域名。

平台文件下载默认关闭。需要该能力时，本地管理员先核对平台实际提供的文件域名，再以 `configure-file-origins` 单独设置精确的 HTTPS 来源。例如将 `{"allowedFileOrigins":["https://files.example.test"],"expectedAllowedFileOrigins":[]}` 通过标准输入交给 `rcac --data-dir $DataDir configure-file-origins`。旧配置的预期列表也为 `[]`；后续更新须提供上次已保存的来源列表作为 `expectedAllowedFileOrigins`，不匹配返回 `CONFLICT`，重新核对后重试。空 `allowedFileOrigins` 可关闭下载。命令只更改来源，保留 issuer、签名密钥、cookie key、密码哈希和操作绑定；成功结果报告 `restartRequired: true`，须重启实际使用的 `serve-http` 或 `mcp` 才会生效。来源必须是规范的 HTTPS DNS origin，不接受路径、尾斜杠、查询、凭据、IP、非标准端口或会被 URL 解析器改写的拼写。此配置只提供下载候选；`artifact.import_reference` 在 HTTP 路径须由 OAuth binding、scope 与本地 grant 授权，在 stdio 路径须由固定 MCP binding 与当前本地 grant 授权。不要仅凭此设置推断真实平台文件来源，也不要默认填入 OpenAI 域名。

来源更新使用现有 `state.sqlite` 的短写事务串行化管理员授权复核和预期列表检查，再将私有临时配置文件 fsync 后原子替换。进程终止时 SQLite 自动释放锁；配置文件和数据库不是跨资源原子事务，崩溃后应按实际保存的来源列表重新核对再操作。

`rcac --data-dir $DataDir serve-http` 会加载私有配置，在回环地址启动 issuer 和 MCP，向 stdout 输出两个不含密钥的本地监听 URL；SIGINT/SIGTERM 关闭服务。需要固定回环端口时，可分别传 `--issuer-port 43123` 和 `--mcp-port 43124`，也可同时传入；两者都只接受规范十进制 1–65535，端口占用则启动失败。省略的端口仍自动分配。运行参数不写入私有配置。固定 MCP 端口可供已授权的 Tunnel 客户端配置本地转发地址；它不使 issuer 可从网页访问，也不创建公网服务。反向代理必须只转发预定 issuer 与 MCP 路径、保持 TLS 和原始公网 URL，并自身具有受信任的访问边界；本命令不修改防火墙或创建公网服务。实际 ChatGPT 配置、同意和工具调用仍需用户在网页完成并由 LIVE 测试记录。仅看到本地监听或 OAuth 元数据不代表已连通。

## 诊断

先确认运行时版本、构建和静态检查：

```powershell
node --version
npm --version
npm run typecheck
npm run lint
npm run package:smoke
```

根目录 `npm-shrinkwrap.json` 是 `package-lock.json` 的逐字节发布派生物。npm 11.9 在两种锁同时存在时优先使用 shrinkwrap；维护依赖时不要在仓库根目录直接运行会更新锁的 npm 命令。先把 `package.json` 和源 `package-lock.json` 复制到**不含 shrinkwrap** 的独立目录，在那里按既定 npm 流程更新并审核这两个文件；确认后将更新的文件复制回仓库，再显式同步派生锁。例如从仓库根目录开始：

```powershell
$SourceRoot = (Resolve-Path .).Path
$LockStage = Join-Path $env:TEMP ("rcac-lock-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $LockStage | Out-Null
Copy-Item -LiteralPath (Join-Path $SourceRoot 'package.json') -Destination $LockStage
Copy-Item -LiteralPath (Join-Path $SourceRoot 'package-lock.json') -Destination $LockStage
Push-Location $LockStage
try {
    # 在此目录按既定 npm 流程更新依赖；审核 package.json 与 package-lock.json。
} finally { Pop-Location }
# 审核通过后，才将 staging 中更新的两个文件复制回仓库：
Copy-Item -LiteralPath (Join-Path $LockStage 'package.json') -Destination $SourceRoot
Copy-Item -LiteralPath (Join-Path $LockStage 'package-lock.json') -Destination $SourceRoot
node tools/prepare-installation-package.mjs --sync
node tools/prepare-installation-package.mjs --check
```

`--sync` 只更新普通、非符号链接且硬链接数为 1 的派生文件；不修改源锁。`--check` 只读检查两者字节相同，缺失或漂移会失败。省略模式参数并传入绝对 staging 路径仍是仅首次创建，已有派生文件时拒绝覆盖。不要用 `npm shrinkwrap` 维护这对锁文件；当前 npm 版本会移除源 `package-lock.json`。

`package:smoke` 先检查派生锁，离线打包且禁用生命周期脚本，实际 tgz 通过安装包结构预检后才安装到临时 prefix，并核对安装后的 shrinkwrap 与源锁原字节一致。随后运行打包 CLI 的 `init`、注册临时 workspace，以独立 MCP 客户端调用安装后 stdio 服务的 `collab.open`，再启动安装后的本地 OAuth HTTP 服务，最后清理临时目录。它不验证 Codex Desktop 的 MCP 配置、ChatGPT remote 连接、真实调查隔离或完整 release。

为发布证据保留实际已测试的包，使用
`npm run package:smoke -- --retain-archive <绝对新文件路径>`。父目录须已存在且
为普通规范路径，目标须不存在；工具不会覆盖旧文件。原始 stdout 的最终
JSON 包含 `packageSha256` 与 `packageIntegrity`，成功保留时还有
`packageArchiveRetained:true`。保存原始输出与 tgz 后，按验收手册的
`release_artifact`/`package_artifact` 绑定填写实际执行收据；尚未完成最终
构建验收时不要把该包声明为已发布或把未运行项改为通过。

常见故障对应动作：

- `Installation path already exists`：`init` 只接受不存在的目录。先核实目标目录及数据归属；已有数据应直接复用，不能通过删库重建来“修复”。
- `Installation missing; run init first`：`--data-dir` 指向错误，或没有在该目录初始化。核对 CLI 参数和目标路径。
- `Data directory permissions unavailable or unsafe` / `Data directory is not private`：停止使用该目录，检查它、`state.sqlite`、可选的 `mcp-binding.json` 及祖先目录的所有者、继承和访问规则。Windows 初始化将目录 DACL 设为受保护，仅授予当前用户与 SYSTEM；检查会拒绝其他主体的允许规则和不安全祖先。修复 ACL 后再重试；没有 CLI ACL 修复/诊断子命令。
- `Invalid MCP binding`、`NOT_AVAILABLE` 或启动时报 binding 错误：确认先完成 `init`、本地 grant 和 `configure-mcp`；检查 principal/audience/recipient/workspace 是否逐字匹配，且所有请求公开的操作都有对应 grant。Binding 文件必须是普通文件并通过私有数据 ACL 检查。
- host 看不到工具：确认 host 使用 stdio 启动了当前安装的 `rcac --data-dir ... mcp`，并检查 binding 的 `visibleOperations` 是否已通过 configure 校验。Catalog 中的合约声明不证明某个 handler 已实现。

本地只读诊断入口为：

```powershell
rcac --data-dir 'C:\Users\YOUR_NAME\RepoConduitData' doctor
```

`doctor` 面向已存在的私有安装目录，读取静止数据库投影。若存在 WAL/SHM
或诊断期间基础数据库发生变化，会拒绝报告；这不证明服务离线，也不会
自动停止服务或清理日志。它不作为在线健康探测使用。返回有界 JSON：安装数据可读性、
MCP 配置及当前授权、会话未决发送、调查 profile 配置与运行时可用性、
本地文件入口与平台 origins 配置。服务在线、host 工具可达和原生账号身份
分别报告 `not_checked`；本地配置或授权不能证明这些真实能力。
前台会话适配器报告 `foreground_adapter_installed`，账号、绑定、历史读取与
人工接管分别保持 `not_checked`；调查 runtime 未验证时仍报告 unavailable。
不以保存 profile 或 Connected 图标推断可用。未决发送只报告存在性，
不要据此自动重发。

诊断不初始化缺失目录、不迁移、不修 ACL、不启动恢复/调查/模型/网络，
不显示凭据、原生 ID、会话正文或原始配置。缺失、损坏或不支持的 schema
返回安全错误。它不替代真实账号、安装恢复或完整发布验收；实施与验证状态
见 D164 回执。当前仍没有单独的 `status`、ACL repair、数据库迁移或在线服务
健康探测命令。CLI 错误输出到 stderr，正常结果输出 JSON 到 stdout；MCP
stdio 的 stdout 保留给协议，不要把调试文本重定向到该通道。`serve-http`
若拒绝配置，先检查数据目录及 `oauth-config.json` 和 `issuer.sqlite` 的文件类型/ACL、
固定 client 与 scope/grant 是否匹配；不要手工改写密钥或授权数据库。

## 停止与本地卸载

CLI `request`、`init`、`configure-mcp` 和 `configure-oauth` 是一次性进程。MCP 是 host 启动的子进程：在 host 中断开该 MCP server 或正常退出 host；CLI 也监听 SIGINT/SIGTERM 并关闭 stdio handle 与 application store。`serve-http` 也在终止信号后关闭本地 listener。RepoConduit 不自行注册后台任务、Windows 服务或开机启动项。

要从本机移除全局 CLI，可先在 MCP host 中移除该 stdio server 配置，然后运行：

```powershell
npm uninstall --global repo-conduit
```

卸载 npm 包不会删除 `$DataDir`、SQLite 状态、binding、artifact 对象、源码、bundle、聊天或 host 留存的数据。当前没有产品数据删除命令；数据目录默认保留。删除用户数据应作为独立、明确的本地文件操作，并先完成备份与归属核对。

隔离临时安装目录中的实际离线卸载及同一 tgz 重装已验证：已知数据库、binding、发布对象字节保留，重装 CLI 能读取原 bundle 与决策。证据见 `SAME_VERSION_REINSTALL_2026-10-01.md`（私有历史记录，见[验证状态](release-evidence.md)）。该验证不涵盖跨版本升级或跨机器备份恢复。

## 备份与恢复

### 受管安装的专用命令

停止使用该安装的 MCP/HTTP 进程后，选择私有父目录下两个全新、尚不存在的绝对路径。备份目录必须位于安装之外，且不能与已注册 workspace/working copy 重叠；父目录须已存在。

```powershell
$BackupRoot = Join-Path $env:USERPROFILE 'RepoConduit-backup-001'
rcac --data-dir $ManagedRoot backup $BackupRoot
$RestoredRoot = Join-Path $env:USERPROFILE 'RepoConduit-restored-001'
rcac --data-dir $RestoredRoot restore $BackupRoot
```

`backup` 持有整个操作的维护排他锁；有运行中的本地持有者、持久化的未知发送/原生调查状态或未完成的 bundle staging 时会拒绝，不会自动终止进程、发布成果或改写结案状态。升级也执行该备份检查；需要先按原交付流程完成或显式中止未完成成果，不能修改数据库状态来绕过检查。它使用真实 SQLite logical backup 保存 state 和可选 issuer，保留配置、对象、已结案的暂存记录和普通锁文件，验证原始字节及引用后才发布 `backup.json`。不要修改备份中的任何文件；配置可能含密钥，备份应保持私有，不能放进共享源码仓。

`restore` 当前只支持同机器、相同包版本和新的受管根目录，验证精确清单、hash、数据库、引用和对象后，最后发布 `managed.json`。不覆盖、合并现有目录，不重新生成管理员，不启动监听器、恢复或模型。终止或失败后的部分目录需要保留核查，不能删除后重跑来证明恢复成功。文件 fsync 与清单末尾发布不等于已验证的整机断电恢复保证。

本地丰富数据集测试已验证 bundle v1/v2、多格式原始字节、决策历史和 issuer 表行保留；安装后 CLI 烟测已验证原授权和二进制保留。另一个实际不同版本升级烟测已验证安装后的 CLI 历史读取，见下节；这些证据不等于完整发布验收。

### 受管安装的本地升级

当前已实现和实测的兼容对为 format 1 的 `0.1.0 → 0.1.1`。使用从受控本地源码准备、构建和打包的候选 tgz；hash 和 npm integrity 用于一致性检查，不证明第三方软件可信。候选包必须显式包含匹配的 `npm-shrinkwrap.json`。在独立 staging 根运行 `node tools/prepare-installation-package.mjs ABSOLUTE_STAGING_ROOT` 生成 publication lock；工具拒绝覆盖已有输出。

```powershell
$CandidateArchive = Join-Path $env:USERPROFILE 'repo-conduit-0.1.1.tgz'
$UpgradeBackup = Join-Path $env:USERPROFILE 'RepoConduit-before-upgrade-001'
$Upgrade = rcac --data-dir $ManagedRoot upgrade --package $CandidateArchive --backup $UpgradeBackup | ConvertFrom-Json
& node $Upgrade.candidateCli --data-dir $ManagedRoot doctor
```

旧 CLI 持有维护排他锁，完成安装外的新备份后，复制非活动候选代，离线安装锁定依赖、运行固定迁移入口、独立验证，最后替换活动清单。安装禁用生命周期脚本及继承 npm/Node 配置注入。保留旧代和备份，不改变全局 CLI 链接；成功后使用返回的 `candidateCli`。旧 CLI 将拒绝新活动版本，不能反复使用旧命令重试已经完成的升级。

协调进程仍存活时，未知关闭或发布失败保留候选和维护锁归属，不自动删除 WAL、回滚或重发。协调进程死亡后，系统会释放它的维护锁；候选与备份仍保留，重新取得锁不能证明 npm 或迁移后代已退出，不应据此删除残留目录。实际安装后的旧 CLI 到新 CLI 链路已保存 v1/v2 四格式共八个原始文件和评审决策，并通过新 CLI 的历史查询。复现：`npm run build`，随后 `node tools/installation-upgrade-smoke.mjs`。证据：`INSTALLED_UPGRADE_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）。

执行前可以在同一命令末尾加 `--dry-run`。它暂时取得维护排他锁，仅检查受管清单、固定版本组合、包结构及路径；不修改活动数据，不创建备份或候选，不运行 npm 或迁移。返回 `preflight_passed` 与明确的 `notChecked`：注册工作区重叠、备份数据及完整性、离线依赖可用性、迁移及激活均未验证。即使业务数据库损坏，静态预检也可能成功；实际升级会重新检查，不能把预检报告当作可升级保证。

已在实际打包安装的 CLI 上验证四个协调进程中断点：npm 启动前、迁移启动前、活动清单 rename 前及真实 rename 后。各点只在已启动的直接 worker 全部实际关闭后终止测试拥有的协调进程；切换前重启仍选择旧代，切换后新 CLI 能读历史、旧 CLI 拒绝，备份、候选及切换前 pending 保留。未完成 staging 会拒绝升级且不会被隐式发布。证据：`UPGRADE_COORDINATOR_CRASH_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）。

另已定向验证备份和候选复制中指定普通文件首次原生写入后的中断：保留原文件的严格前缀，旧活动数据库和清单原字节不变，重启可读历史，重试不会覆盖残留。该次只运行两个新增点，未重跑此前四点。证据：`UPGRADE_COPY_INTERRUPTION_2026-10-02.md`（私有历史记录，见[验证状态](release-evidence.md)）。

SQLite logical backup 执行中、运行中的 npm/迁移 worker、整个后代进程树、任意历史 schema/跨机器兼容性和整机断电恢复尚未通过。上述测试不能扩大为这些保证。

### 旧 flat 数据目录

停止 MCP host 与 `serve-http`，并确认 RepoConduit 子进程已退出后，备份整个数据目录，而不是只拷贝 SQLite 主文件。目录包含 `state.sqlite`、可能存在的 `mcp-binding.json`、`oauth-config.json`、`issuer.sqlite`，以及可能存在的 `artifact-objects`。OAuth 配置含签名私钥与 cookie key，备份必须保持同等私有权限；不要把它放进被注册或对外共享的源码目录。

`artifact-objects` 下的 `staging/*.lock`、`idempotency-locks/*.lock` 与 `export-locks/*.lock` 在当前版本是持久 SQLite **普通文件**。操作结束或进程退出只释放事务锁，不删除这些文件；备份和恢复时应一同保留。旧版本可能在相同路径留下**目录**锁。当前版本遇到这种目录会拒绝操作，不会猜测持有者已退出或按时间自动删除。跨版本恢复前先停止所有使用该数据目录的旧进程并保存完整备份；旧目录需要逐项核对后进行受控离线处理。不要在服务运行期间改名、删除或替换任何 `.lock` 文件或目录，以免两个进程使用不同的锁身份。

恢复时，在安装相同或兼容版本 CLI 后，将完整备份恢复到原数据目录，并保留私有 ACL。不要对非空目录运行 `init`。恢复后先检查 Windows ACL；再用本地 CLI/MCP 启动路径验证能够打开数据。如果现有 binding 对应的 grant 已撤销或过期，可按该 binding 中原有 principal/audience/recipient/workspace 重新授予所需权限。若 binding 身份或 workspace 本身需要更改，当前没有 CLI 重绑/轮换流程；停止该配置并保留数据以待后续支持，不要手工改写发布记录、数据库或 binding 文件。数据库与 artifact 文件必须作为一个数据集恢复；缺失或损坏时不要伪造完整性。

上述 flat 路线是手动离线操作，不会自动接管为受管安装。当前没有内置迁移、回滚或数据修复命令，也没有经过验证的跨版本恢复保证。若恢复失败，保留原备份和错误输出，避免继续写入可能不一致的数据目录。

## 验证证据范围

### Windows Job 句柄基础的开发验证

此限定检查运行固定 helper 的自身子代，并通过 owned stdio 执行固定 Desktop
Codex 的零模型 readiness 握手；不执行登录、setupStart、thread/turn 或模型。
Windows 构建机需要已有的
`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（本机核对为
4.8.9221.0）；没有编译器时检查失败，不下载或安装。源码构建按此顺序执行：

```powershell
npm run build
npm run build:windows-helper
npm run test:windows-helper:installed
```

第二步显式把 exe、C# 源码和来源清单放入 dist/src，第三步离线打包、禁用
install hooks 安装到独立临时目录，再从已安装路径运行三种固定场景及两个
固定 stdio 配方。manifest/helper 新实现为 version 3；旧 canary v2 observations
仍单列经映像核对的 fixturePids，完整 Job 列表另保留系统伴随
进程。正常关闭需 root HANDLE 已 signaled、全部 Job 成员为空；EOF、取消或
超时保持 unknown。该脚本不是完整 package:smoke 或发布门禁，也不能启用
生产 investigator。tsc 本身不会编译 C#；待打包包含本 helper 时先执行显式
编译步骤，不依赖 npm install/postinstall。

可用 `npm run test:windows-helper:installed -- --retain-archive ABSOLUTE_NEW.tgz`
保留本次实际安装的原始包。父目录须已存在且规范，目标须为新的绝对 `.tgz`
路径；独占复制不覆盖已有文件，输出实际字节长度、SHA256 与 SHA512 SRI。
此烟测还从安装路径运行合成 prepare→stop 分支，确认未创建 Codex 子进程、
完整空 Job 与 helper exit0。它不登记真实 launch 或提供生产启动能力。
任一阶段失败时保留临时目录并向 stderr 报告路径；只有全部通过、确认所有
owned helper 关闭且根路径校验通过后才删除。失败目录可能仍有未知进程，
不能仅凭脚本结束手动递归删除。D234 实测收据见
`WINDOWS_INSTALLED_D234_2026-10-05.md`（私有历史记录，见[验证状态](release-evidence.md)）。

D235 原 helper owner 的源码恢复验证与以上安装烟测分别记录。应用只装配私有
未启动事实 verifier，未启用生产调查。原 owner 的 `close` 不等于 launch 事实；
只有实际 prepared 后持久绑定的 owner 完整关闭并落库，才允许既有独立清理
路径结算。未知/取消的 native 关闭保留现场，SQL 失败可重试同一事实但不重启
helper、不重发 stop。见 `WINDOWS_ORIGINAL_OWNER_D235_2026-10-06.md`（私有历史记录，见[验证状态](release-evidence.md)）。

两个 stdio 配方只允许固定三帧 readiness 输入；子进程原字节按封闭 envelope
转发，正常返回还需要双 EOF、整个 Job 空和 helper 退出 0。`updateRequired`
是有效诊断结果，不会启用隔离资格或生产调查。固定 Desktop 不存在、版本
改变或协议失败时不得替换任意 CLI 或自动执行 provisioning。任意后代持有
pipe、压力与生产隔离的资格仍需独立验收；本脚本不证明这些场景已完成。

### Windows 专用配置（零模型诊断）

D239 新增个人自用调查的应用组合入口，使用下方 prepare 生成的固定配置。
它与历史零模型 check 分开：用户通过官方登录在专用 HOME 中产生的认证文件
可供原生 Codex 使用，RepoConduit 不读取或复制其内容。此代码入口的真实
Codex/模型兼容性不能由离线 fixture 推断。2026-10-13固定Desktop26.1007.2314.0 /
CLI0.162.0-alpha.17.2上的开发源码调用已实测一次合成读取、正式结果返回、
本地采纳和重开恢复，原e87220c安装包的本地API也通过两次合成调查追问；
新增CLI启动接线和完整ChatGPT双入口多模块验收分别记录。证据见
D239_LIVE_CONTINUATION_2026-10-12.md（私有历史记录，见[验证状态](release-evidence.md)），不据此声明release_ready。

本地应用组合代码可配置明确 workspace/profile 后调用：

```ts
const app = openApplication(dataDirectory, {
  codexInvestigator: {workspaceId, profileRevision},
});
try {
  await app.ready;
  // requestId 来自同一产品的 investigate.submit；不是 Codex thread ID。
  const investigation = await app.runCodexInvestigation(requestId);
  // 外部参与者仍通过既有 investigate.get/result 查询各自有权限的结果。
} finally {
  await app.close();
}
```

这是可信本地组合选项，不从网页/MCP payload 接受模型、执行程序或运行目录。
未配置时不启动 Codex。读取沿固定快照和现有 handler；结果须核对真实读取
回执并确认原运行实例关闭才发布。未知退出保留待恢复记录及占位，不自动
重复调查。`app.close()` 会停止接收新调查并等待本实例收尾。

### 从网页排队、由本地CLI执行

已有正式登录和准备好的当前profile后，本地管理员可在启动时明确选择：

```powershell
rcac --data-dir ABSOLUTE_DATA_DIR mcp --codex-workspace WORKSPACE_ID --codex-profile CURRENT_REVISION_ID
rcac --data-dir ABSOLUTE_DATA_DIR serve-http --codex-workspace WORKSPACE_ID --codex-profile CURRENT_REVISION_ID
```

只启动实际使用的一种入口。选择必须与MCP固定workspace或OAuth operator
binding一致，并检查本地`admin.profile`、当前revision和既有runtime元数据。
选择不创建grant、不登录、不运行模型；未配置时调查提交仍拒绝。网页使用
原有`investigate.submit/get/result/cancel`，不能传模型、程序、环境或工作目录。

若新工作区复用已有登录目录，额外显式提供完整三项本地参数：
`--codex-runtime-data-dir CANONICAL_SOURCE_DATA_DIR --codex-runtime-workspace SOURCE_WORKSPACE_ID --codex-runtime-profile SOURCE_REVISION_ID`。
来源路径须为规范绝对私有目录。双方当前本机`admin.profile`、只读profile与
预算一致才允许选择，准备之后写start前重核。来源数据库只读、凭据不复制；
目标议题与授权仍独立，来源的旧unknown不会被释放或重放。

取得产品requestId后，本地管理员在另一个终端运行一次：

```powershell
'{"workspaceId":"WORKSPACE_ID","profileRevision":"CURRENT_REVISION_ID","requestId":"PRODUCT_REQUEST_ID"}' | rcac --data-dir ABSOLUTE_DATA_DIR run-codex-investigation
```

该动作只执行指定已排队请求，使用该请求的预算和原grant；不扫描队列、
创建新请求或自动重试。输出`requestId/state/hasResult`；本次执行出现失败时，
附加本地`diagnostic`（确切requestId、固定阶段、白名单错误码，不含原生正文）。
重读既有终态不会补造旧诊断，也不会重新启动。结果仍从原请求参与者
的`investigate.result`权限路径取得。返回已有终态不会启动新attempt；
未知收尾保留`recovery_required`。服务与CLI可持有共享安装租约，维护仍受阻。

这是默认的显式单请求执行能力。正式取消
由原请求参与者调用`investigate.cancel`；本地Ctrl+C只停止本CLI拥有的运行实例，
等待收尾并按实际事实结算，不能冒充网页参与者或将未知退出写成cancelled。
新命令的源码CLI/MCP检查不等于安装版模型调用或ChatGPT LIVE通过。

#### 显式本地后台调查（D239，代码及离线接线已验证）

同一Windows Codex运行器现有默认关闭的`--codex-managed`开关，例如：

```powershell
rcac --data-dir ABSOLUTE_DATA_DIR mcp --codex-workspace WORKSPACE_ID --codex-profile CURRENT_REVISION_ID --codex-managed
```

仅在`mcp`或`serve-http`上与完整workspace/profile选择一起使用。它会处理
固定范围内仍有当前有效授权、未取消且从未产生attempt的队列，包括启动前
已经queued的请求；启用前应确认这个范围符合本次允许的模型用量。
不加开关时仍需上面的单请求CLI，默认重启不自动执行。后台服务沿原
claim、权限/预算、只读读取、结果结算与关闭流程，不重试失败或unknown。
外部不能传此开关或修改运行器；启用本身不创建grant，不代替本人登录/同意。

本批完成17项去重受影响用例、3项合约/核心边界、类型/lint及独立复审；
其中实际SQLite、handler和localhost传输使用明确的原生协议fixture。
2026-10-15的保留安装包（source `9fec0de`、包SHA前缀 `0c7baaaf`）随后完成
一次真实单文件managed调查：自动claim、405B快照读取、正式结果返回、
原owner关闭，以及新只读数据库连接取回的结果与原MCP输出一致。
该场景的临时grant已撤销，服务已退出，不是当前持续运行的后台服务。
三文件60秒调查仍曾超时；此记录不证明完整多轮、显式取消或网页入口通过。
原始失败及独立复核见源码仓中的
[有界调查记录摘要](release-evidence.md)。

单次CLI JSON可另含`runtimeSource`对象，三个字段为`dataDirectory`、
`workspaceId`、`profileRevision`，含义及检查同上。不要把它放入网页提交参数。
启动失败时`diagnostic.preparedFailure`只含固定错误类别与有限关闭观察，不含
原生错误正文；完整原对象未启动证明可结算failed/cancelled，保持
`terminationConfirmed=false`。关闭或启动发送未知仍保持recovery_required。

已有安装、workspace 和当前 `static_readonly_v1` profile revision 后，本地管理员
可用两个动作。输入通过 stdin，不接受自选 binary、argv、env、路径或 config：

```powershell
'{"workspaceId":"WORKSPACE_ID","profileRevision":"CURRENT_REVISION_ID","modelRef":"gpt-6-sol"}' | rcac --data-dir ABSOLUTE_DATA_DIR prepare-windows-investigator
'{"workspaceId":"WORKSPACE_ID","profileRevision":"CURRENT_REVISION_ID","runtimeId":"RETURNED_RUNTIME_UUID"}' | rcac --data-dir ABSOLUTE_DATA_DIR check-windows-investigator
```

替换占位值后执行。prepare 创建专用 HOME/config/runtime metadata，重复请求拒绝
且不覆盖；profile 更新需新 revision。check 运行固定 Desktop 版本、features list
和 owned Job 中的 app-server --strict-config/config/read，不执行模型或认证。
存在 auth.json 时拒绝；不得手工复制客户端凭据进去。
版本、当前 grant/revision、私有 ACL、路径、配置或 metadata 漂移时拒绝，不修复
现有目录。只有选定配置值和原 user 文件来源符合、原 config 文件在原生诊断期间
锁定，并完成双 EOF/root exit/Job 0/helper exit 0，才返回 `strictConfigVerified=true`。
失败保持未验证；不回传原配置或 stderr。仍保持 `productionAvailable/isolationVerified`
为 false，`authentication=not_verified`、`modelTurn=not_run`。这不是可用的生产 investigator。

安装后的 `test:windows-helper:installed` 也会调用 prepare/check 并跨独立 CLI 进程
重新读取同一 runtime；仍是限定组件检查，不能替代 package:smoke 或真实 release。

Windows 生产启动日志的新配置身份为 runtimeId/configSha256。旧格式日志可以重开
并保留原进程身份和恢复事实，但不会自动补上当前 runtime 的身份，也不可继续
执行调查。不要手工为旧日志加字段或删除旧 intent 来重试；原 source/slot 保留，
原 owner 的可信关闭事实仍可核对。字段齐全也不等于生产隔离已验收。

Windows cleanup runner 对已有完整 Current launch 与可信 Job closure 的过期调查，
可接管清理 lease、关闭原冻结 source 并结算 failed/cancelled。缺失或损坏证明以及旧
launch 继续占位。关闭文件后数据库未结算时，重开依靠原 tombstone 恢复，不重启调查。
新增清理事实表随 store 打开追加创建；旧记录不自动回填。不要删除事实或修改未知
thread/turn 来通过安装预检。终态仍无结果，且不承诺远端模型请求或费用状态。

源码入口为 `src/cli/main.ts`；Windows ACL 实现在 `src/runtime/local-security.ts`；MCP stdio 和可见操作实现在 `src/adapters/mcp/stdio.ts` 与 `src/adapters/mcp/server.ts`；打包烟测为 `tools/package-smoke.mjs`。`tests/integration/cli-entrypoint.test.ts` 覆盖本地 CLI 身份、初始化、workspace/working copy、grant 与 collaboration；`tests/integration/product-mcp-stdio.test.ts` 覆盖本地 stdio 连接、同一数据状态访问和撤销后的拒绝；`tests/security/local-data-acl.test.ts` 的 ACL 负向用例仅在 Windows 运行。

这些源码与测试证明范围不等于当前机器已经执行过上述完整安装、MCP host 接入、恢复或远程验收。旗舰双入口、隔离 investigator、ChatGPT remote/tunnel 和完整 release 仍未由本指南或 package smoke 验证。

## 个人 Windows Claude 调查

沿用已安装的 Claude Code 2.1.287 与用户既有 GLM 连接，不要求 Claude
订阅或重新登录。启动器从固定用户 `.claude/settings.json` 的 env 中选择
已有连接、认证与模型变量，只在进程内存中传递，不另存密钥、不加载用户
hooks/工具权限设置；缺失或非法即拒绝，不转用其他账号。profile 使用现有
`static_readonly_v1` 和有限预算。由拥有本机
profile 管理权限的 host 启动明确绑定的连接：

```powershell
rcac --data-dir 'C:/private/case' mcp --claude-workspace WORKSPACE --claude-profile REVISION
```

该连接只使通用 `investigate.submit/get/cancel` 路径可用，不自动运行模型。
得到 queued request 后，由同一本机 host 执行一次：

```powershell
'{"workspaceId":"WORKSPACE","profileRevision":"REVISION","requestId":"REQUEST"}' |
  rcac --data-dir 'C:/private/case' run-claude-investigation
```

可读文件由原调查和 grant 决定。CLI 不接任意 command、provider、凭据或
工具列表；版本不符、授权变化或结果缺真实读取证明会拒绝。失败请求不重放，
unknown/恢复占位不自动删除。原始 native 输出和错误保存在私有数据目录的
`claude-runs/attempt_...`；MCP 的短时 bearer 不作为日志导出。

安装版 NEUTRAL01 验收入口为 `tools/prepare-neutral-live.ts INSTALLED_CLI`，
只准备专用合成案例及一个 queued 请求；设置它返回的案例根目录为
`RCAC_NEUTRAL_CASE` 后运行 `npm run test:e2e:live` 才会执行真实调查。
未设置案例时该用例明确 skipped，不构成 LIVE 或 NEUTRAL01 通过。
实际模型回合应在相应使用范围内执行；真实通过记录以当前固定包的原件为准。

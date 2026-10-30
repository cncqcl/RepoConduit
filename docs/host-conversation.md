# 前台 host 会话桥

`rcac --data-dir ABSOLUTE_PATH host-conversation [ABSOLUTE_DOWNLOAD_ROOT]` 启动前台 JSONL 会话。
进程使用当前 OS 用户、`local-os` audience 和 `local_cli` surface；命令仍经过
统一 application dispatcher。此入口没有独立浏览器执行器，需当前本地 host
使用已支持的 CUA 和官方 `read_thread` 接口执行固定动作。

日常文件收件不要求启动此桥或先同步聊天。本人可原生下载原件后使用
`rcac receive --project ABSOLUTE_GIT_ROOT --topic TITLE --version NAME --file ABSOLUTE_FILE`，
或安全解压后用 `--from-directory` 保留子路径，再用 `export` 审查；这些本地动作和
`source-export` 不需要 Tunnel 或 key。父版本须为同题已发布版本，子版本不会合并覆盖父版。
实际目录原件回执见 [2026-10-29 记录摘要](release-evidence.md)。
只有需要正式会话同步或人工接管恢复时才使用以下桥协议；不要将人工下载冒充自动同步。

## 协议

每行一份 JSON，单行最多 1 MiB。一次只处理一个产品命令、一个在途动作。

```json
{"type":"command","requestId":"bind-1","command":{"operation":"conversation.bind","scope":{"workspaceId":"ws","collaborationId":"col"},"payload":{},"idempotencyKey":"bind-1"}}
```

产品输出 `action`，包含 `actionId`、`kind` 和明确 target。host 回送：

```json
{"type":"action_result","actionId":"实际动作ID","raw":{}}
```

`observe` 的 raw 包含正常 Account UI 的 Email 观察、当前聊天 DOM 投影和
官方 host 页面原始对象。适配器自己核对原生 ID、角色、正文、顺序、分页和
停止生成状态，计算增量；不接收 host 自报的 complete/historyChanged。
原 `{account,ui,host}` 观察仍限于短纯文本。富文本及官方正文引用可使用下述
原生 Copy 观察；附件需下述专用变体，未知内容、预览弹窗、临时 local-chatgpt 标识、截断和
不完整分页仍拒绝。

### 原生消息 Copy 正文（可选）

已观察的 ChatGPT UI 将 Markdown 渲染为段落、表格和代码；官方 `read_thread`
也可能只返回 `::chatgpt-content-reference{index="0" source_message_id="实际消息ID"}`。
不能把占位符当正文，也不能把可见文本伪装为官方 API 的原文。

此时 raw 可增加 `bodyCopies` 数组，每项为：

```json
{"kind":"native_message_copy_v1","before":{"nativeSessionId":"实际聊天ID","nativeMessageId":"实际消息ID","role":"assistant","text":"实际渲染正文","tags":["P","SPAN"]},"after":{"nativeSessionId":"实际聊天ID","nativeMessageId":"实际消息ID","role":"assistant","text":"实际渲染正文","tags":["P","SPAN"]},"clipboardBefore":"repoconduit-native-message-copy-v1","clipboardAfter":"原生 Copy 返回的 Markdown"}
```

host 先在同一原生消息下观察身份、角色及正文，向浏览器剪贴板**写入并读回**
固定非敏感标记 `repoconduit-native-message-copy-v1`，再点击该消息唯一的 Copy
（用户消息为 Copy message），读取结果并再次观察同一消息。不要读取或保存
用户原先的剪贴板内容；这个标记只用于检测复制是否发生，不是授权或审批凭证。
不得通过发消息、重新生成、复制其他消息或读取页面隐藏状态补齐正文。

before/after 必须与对应 ui.heading 的渲染正文和 tags 一致，聊天、消息、角色
也必须一致；不接收多余或重复 Copy。正文投影只取消息内容，不含操作工具栏。
支持普通 Markdown 的呈现标签和插件提及的装饰 SVG，不执行其中链接或内容；
表单、脚本、媒体及其他未知标签拒绝。已有正常 Account UI、完整官方历史页、
原生 ID/顺序/selection、无生成、无弹窗和准确 composer 检查均不变。

完整 API 正文必须与 Copy 逐字符相等。只有 assistant 的上述精确、同 ID 引用
可以从 Copy 得到正文；复制结果仍是占位符或仍等于标记时拒绝。存储保留原始
host 引用、DOM 和 Copy 来源，消息 text 使用复制的原始 Markdown；不宣称该
正文来自 API。旧基线比较和 unknown send 原生消息对结算保持不变。此增量
不改变数据库 schema，不自动授予新的会话或执行权限。

整条正文引用的 index 支持实际非负十进制 0–999，不接受前导零；仍须准确匹配
source_message_id 和同消息 Copy，不把 index 当作消息身份。

整条引用也可用于恢复包含文件讨论的普通 Markdown 正文。此时使用实际正文根
及原生 Copy，不从“下载”字样、资源卡或文件名推导文件身份、URL或字节；正文
之外的附件控件不作为正文捕获。静态装饰 SVG 的 circle 与既有 svg/path/use
仅作为观察标签，不执行或重新渲染。需要核验 inline 文件身份或实际收取文件时，
仍使用下述专用附件观察/下载流程。2026-10-23 原聊天12消息正文恢复已实测，
见[首组合回本地记录摘要](release-evidence.md)。

### 内联图和可编辑代码的 Copy 观察

`native_message_rich_copy_v1` 沿用同消息 Copy 的 before/after、剪贴板标记和
完整官方正文/同 ID 引用校验，增加 `richBefore/richAfter`。两者必须与对应
`heading.assistant.rich` 完全一致，包含账号、聊天、消息、角色、完整 DOM
正文、有序 inlineImages 和 codeEditors。当前只支持最多八个已观察的
`IMG[data-d-component=svg]` 内联 UTF-8 data SVG、一个 CodeMirror 代码框；
不支持普通图片、远端图片地址或未知编辑器。ui.media 仍报告实际图片，
其数量必须与本窗经过消息绑定校验的图片完全对应，不能静默清空。

原始图片属性/data URI、完整代码行和渲染文本保存在既有 observation，
并纳入消息 version；不执行、下载或重新渲染 SVG。message.text 仍是原生
Copy 的文本部分，不宣称其中包含图片。平台 Copy 将本次代码行合并为
单行，故另存完整 DOM 行结构，并核对 Copy 中准确代码块；不修改 Copy。
可信 host 仅把真实 Ask ChatGPT 输入框列为 composer，消息内已识别的
Edit code 保留为正文结构，未知可编辑区域仍拒绝。已观察的被动 MathML
和 SVG rect 标签可伴随原生 Copy，不提供数学执行或通用媒体支持。

观察格式需修后 adapter；没有数据库迁移或新增执行权限。定向验证不代表
原聊天已经恢复或当前安装包通过统一 LIVE。

### 发送草稿中的原生应用标记

已观察的应用标记在编辑器显示名称，正式历史则保存
`[$slug](app://asdk_app_...)`。新发送须将后者及准确后缀存入既有 send intent。
prepare 的唯一 composer 可从 `{text}` 扩为 `{text,nodes}`，nodes 记录实际一个
P 中的首个不可编辑 SPAN 标记及一个以空格开头的尾部文本节点。适配器核对
标记名称、显示名称、app 路径、链接、图标和完整已知属性；只有该形态转换为
上述规范文本后与 intent 逐字符比较。多标记、额外节点或不一致字段拒绝。
正文、旧 intent 和历史消息不做此转换；旧纯显示名称的 unknown 不追认成功。
普通无应用的 `{text}` 观察不变；字面应用 Markdown 不可替代原生标记。
空编辑器及账号、聊天、旧基线检查不变。

旧纯显示名intent不能通过普通sync/resume追认；本地host/CLI可在同原聊天执行
`conversation.resume`，payload在bindingId、expectedEpoch外增加
`acceptUnknownSendIntentId`（当前原intent ID）。产品仍先通过正常observe核对
完整历史、账号/chat、无编辑、无生成和cursor前进；空历史、错误intent或仍在
发送/等待结果均拒绝。该显式处置的回执含unknownSendDisposition：
kind=accepted_observed_history、原完整intent、新消息ID及from/next cursor。
旧命令仅工作流status结算，原text/hash/outcome/unknown回执保留，旧发送键仍
返回unknown；普通sync、匹配证明和future prepare规则不变。它解除活动占位并
恢复原聊天可续用，不表示原发送已证实成功，不代替人工接管实测，不重发。

### 同一聊天中的附件回复

已观测的 ZIP 引用与 PNG 文件卡片可使用 `native_message_attachment_copy_v1`。
它保留普通 Copy 的全部字段，并增加 `attachmentBefore`、`attachmentAfter`：
两者均为现有 `observed_chatgpt_dom_attachment_v1` 完整所选消息投影，前后必须
相等。host 仍读取完整官方历史，DOM 附件投影不能单独建立历史或 cursor。
复用 `tools/chatgpt-download-dom-observer.mjs`，可指定 `nativeMessageId` 以明确
选择聊天中重复的文件名；同一消息内重复或歧义仍拒绝。

附件投影核对同一账号、聊天、消息、回合、全部已完成状态、完整有序块及精确
composer。普通 Copy 仍不接受 BUTTON；专用变体仅支持现有完整附件观察器识别
的文件引用、PNG 卡片、完整展开的资源卡片组及关闭的 View analysis。可见媒体、未知块和预览弹窗
仍拒绝。官方非空 attachments 数组、缺少 inline 身份的全文占位符仍不支持。

完整 API 正文中的每条 `:chatgpt-content-reference{index="N"}[label](sandbox:/mnt/data/filename)`
必须以连续索引、唯一文件名与 DOM 附件完整对应。DOM 中的 file_reference
按实际 referenceIndex 匹配；资源卡片保持组内相对顺序，不把页面显示顺序当作
原生正文索引。只允许将 file_reference 的 token 替换成其已验证 filename，
image_card 与 resource_card token 保持原样；其他字符、链接、
空白不得改动，完整结果必须与原生 Copy 逐字符相等。sandbox 引用仅作来源
身份，不是可获取 URL、本地文件路径或下载完成证明。

producer 引用可包含最多八段安全相对路径，父段限 ASCII 名称；拒绝空段、
点段、反斜杠和百分号编码，末段必须匹配唯一附件文件名。原生 label 必须为
文件名，旧顶层 `下载 filename` 形式仍兼容。资源组以显式
`resource_card_group_v1` 投影记录完整展开列表、逐行实际位置、祖先及下载控件，
支持 Document/HTML/Code/Image。配对类型与 Open file 只允许已观察的 CSS 互斥；
hidden、busy、加载状态、跨行控件、折叠或不完整列表仍拒绝。

消息 text 保存 Copy 原文，version 绑定正文及有序附件身份，不包含整页回合数
或下载指纹；追加下一轮不会修改旧版本。原始 API、DOM 与 Copy 来源仍保留。
发送 prepare 用原应用提供的准确草稿作为预期 composer；下载观察仍要求空
composer。附件同步不会点击下载、解除其他 unknown 或证明 bundle 完成。

`submit` 分为 prepare 和 commit。prepare 只核对目标、账号、基线并准备
准确草稿，不可点击 Send 或按 Enter。准备观察通过后，应用重新检查原 grant、
当前 epoch/revision、控制状态和已持久化 intent，随后释放一次 commit 动作。
host 应立即执行一次正式提交；失去当前页面或自行延迟时放弃点击并对账。
动作回执不证明提交已完成，结果保留 unknown，之后以准确新增 user/reply
原生消息对结算。检查与远端点击没有原子保证。

prepare transport 已成功返回、但准确草稿/账号/会话或旧历史校验失败时，
适配器在 checkpoint 和 commit 前返回既有 rejected 结果；不能规范化文本后
放行。transport 本身失败、checkpoint 失败、commit 发送或其回执不明仍抛出，
由应用保留 unknown。此区分只适用于新的执行，不追认或清除历史 unknown。

产品输出 `result`，含 requestId 与 result 或固定脱敏 error。重复、错序、
未知 ID、超时（最多五分钟）和关闭连接都会停止该前台通道；关闭前先让
应用结算未知状态，再关闭数据库。重新打开通道不能重发旧未知意图。

## 持久化与恢复

同一私有 state.sqlite 保存随机 opaque 账号键与完整不可变消息基线。
账号原始 Email 只留私有数据库，普通结果不输出原值。每次使用重新观察
账号；不同账号不能沿用绑定。不同聊天即使继承消息 ID 也不能共用基线。

SessionState.cursor 是唯一已采纳位置。适配器先保存候选，应用 CAS 成功才
推进 cursor；失败候选不成为“最新会话”。备份/恢复预检核对候选、parent、
账号、scope 和已采纳 cursor 引用。安装数据格式仍为 1；新 adapter 表有
独立 schema version=1，旧无 host 表安装兼容，半表或不兼容结构拒绝。

### 既有绑定的正式历史窗口

正式宿主可能只返回最近十条消息，即使 page 标为无后续页。新绑定仍要求
当前正式页与完整 UI 对应。已有可信 baseline 时，同步及发送准备可用原始
native 来源与当前正式窗口的唯一、连续完整回合重叠恢复前缀；重叠必须到达
旧尾部，新增消息必须全部位于当前正式窗口。没有重叠、缺口、编辑、倒序或
身份变化均拒绝。host 原页保持原样，不把合并历史冒充单次正式 API 全页。

完整 fresh UI 与实际 Copy 仍逐项核对全部消息，旧 processed text/version
保持不变；保留前缀使用原 native 文本，不能用附件 Copy 处理后的文本替代。
内部 nativeSourceProjectionV1 只随既有不可变观察存储并受 record_hash 保护，
不接受业务输入的投影。原完整页覆盖全部旧消息时沿用原全页校验；空页及
同 ID 正式引用变为相同 Copy 正文的既有行为不变。

双版本附件的完整 Copy before/after 实测为 277275 字节、11301 个 JSON 节点。
存储节点上限调为 20000，1 MiB、深度 40 及纯 JSON 限制不变，无表或 schema
迁移。旧二进制不能读取超出其节点上限的新记录，恢复须使用修后版本。
该窗口兼容不证明完整终身历史，也不放宽当前账号、会话、权限或发送门禁。

长聊天 DOM 自身也可能虚拟化。既有绑定可以提交
`{account,uiWindows,host,hostAfter}`；每个窗口保留独立的
`{account,ui,bodyCopies}` 原始观察，不伪造一张完整 DOM。窗口按历史正序覆盖
全部合并消息，相邻至少重叠一个完整回合且必须向前扩展；缺口、倒序、重复、
包含窗口以及重叠正文/version 改变均拒绝。每条消息继续经过原 ID、角色、
selection、正文及 Copy 校验；各窗账号/chat/composer 必须一致。窗口数量和
总消息数有界，原 1 MiB/20000 节点等存储限制不变。

host/hostAfter 必须来自围绕真实窗口采集的两次官方读取，均 idle、分页完整，
原生消息和分页元数据稳定。新绑定仍使用原单窗口入口；旧单窗口基线继续
兼容。多窗口只修复观察兼容性，不改变 send intent 的准确正文/唯一原生消息
对关联，也不因存在调查结果就把 unknown 发送判为成功。

本桥不建立 managed investigator，不替代产品 OAuth，也不证明人工接管或
LIVE01–03。实施与验收状态分别见 GOAL_STATE 和 RUNTIME_ACCEPTANCE。

## 本地浏览器收取（安装后合成版本化收取已实测）

可选下载目录由本地启动参数指定，省略时不启用收取。`artifact.collect_browser`
仅接受 local_cli/local_host，统一 dispatcher 检查 `artifact.collect` 与原 grant。
payload 为 bundleId、收件区相对 path、nativeSessionId、nativeMessageId、filename、
expectedSha256、expectedSize，可选 retryOfCaptureId 或互斥的 reconcileOnly:{captureIntentId}；
命令另带 scope/idempotencyKey。外部不能提供目录、
URL、任意脚本或可信回执。预期 SHA/大小是完整性约束，不是来源证明。未声明
目标及已知路径/大小写/文件目录冲突在任何下载动作前拒绝。

可信 host 执行固定 download 的 observe/commit/reconcile。observe 包含新的正常
Account UI、可见附件控制及明确类型的原生消息来源。旧 host/UI 格式继续要求
官方完整原生消息投影；`observed_chatgpt_dom_attachment_v1` 则由
`tools/chatgpt-download-dom-observer.mjs` 只读提取当前完整渲染的附件消息：
实际聊天/消息/回合祖先、assistant 标记、complete 状态、全部支持的正文块、
ZIP 引用及同消息图片卡片。未知、隐藏或生成中的结构拒绝；所有相关块纳入
来源指纹。当前已观测的关闭状态 `View analysis` 控件保留实际祖先；PNG 卡片
中准确的 `data-markdown-copy=exclude`、`Open file` 辅助标签单独核对并记录，
纯装饰 SVG 只允许已知图形元素；这些不能放行其他隐藏内容。
`empty_hidden_span_v1` 仅记录消息首个直属元素：唯一原始属性 `hidden=""`、
零子节点及空文本的不可见 SPAN；保留节点与完整祖先并纳入来源指纹。
可信观察器检查其零内容形态；隐藏豁免仅适用于该节点，祖先检查不变。
DOM 格式只证明所选消息，不提供历史分页，不推进 SessionState.cursor，
也不替代会话同步所需的官方历史。两种类型不可在已有 intent 上互换。
传给观察器的 `account` 必须保留正常 Account UI 的原始 `{labels}` 或 `{fields}`
结构，不能传已解析的 Email 字符串。工具返回深层对象若发生 `MaxDepth` 等裁剪，
在受支持的只读 DOM evaluation 内将完整投影序列化成 JSON 文本，再由 host 解析；
仍保留原字节和结构上限。缺失的祖先属性不可从相邻节点重建，也不能放宽 parser。
commit 只对该 intent/账号/
来源 fingerprint 点击一次；host 须点击前注册已支持的等待接口，完成时从**原
下载对象**取实际本地 path，返回 clicked=true、observation 与
completion={captureIntentId,kind:`browser_download_completed`,path}。
reconcile 只查询原对象，返回 observation/completion。失去对象或超时不能以
已有文件、预期 hash 或 sandbox 路径替代完成记录，也不能重复点击。

`reconcileOnly` 是同一本地入口的明确无点击恢复：新业务幂等键记录当前有效
grant和原captureId，原capture必须是未受限制的reconcile_required或
verified_candidate。完整目标、身份、账号、绑定、root、来源及预期字节仍须
匹配原输入；只有当前授权与历史grant分开核对。原input/hash/grant不改，
复用原baseline及已保存retryContext，不prepare、不commit或创建重试关系。
当前授权在前后复查，原对象证明及最终落盘检查不变。普通收取请求不能凭
更换grant或新幂等键绕过历史匹配；同一已验证候选的落盘/收据恢复不重击。

原对象确实丢失时，本地可显式提交新的幂等请求并指定旧 `retryOfCaptureId`；
它不重放旧请求，也不将旧 unknown 改为成功。仅这个新请求的 host observe
结果为 `{observation,retryContext}`，commit/reconcile 在原结果上增加同一
`retryContext={browserId,originalTabId,retryTabId}`。上下文由可信 host 使用实际
官方浏览器句柄填写，不能出现在业务 payload；同一浏览器的新旧 tab 必须不同，
各阶段必须与首次保存的关系相同。旧 v2 数据没有 tab 字段，旧 tab 的首次关联
来自 host 既有执行证据，不宣称数据库证明该关系。只有正式能力与实测确认
新 tab 的监听和原完成对象能独立关联新动作时，host 才能执行这项重试。

同一私有 state.sqlite 的 browser_capture_intents 固定 scope、原 grant、opaque
账号、聊天/消息/附件、来源/绑定 fingerprint、目录基线与候选指纹。
prepared→capturing 先落库再释放点击；不确定提交进入 reconcile_required。
browser capture schema2 将仅 prepared 的来源变化记录为
`aborted_before_capture`/`source_changed_before_capture`，原 input/hash 不变。
必须再次确认原权限、账号、绑定和其余输入；旧键永久拒绝，不自动创建新键。
该终态只证明本产品未释放下载 commit；已 capturing 或 unknown 不可退役。
旧 v1 数据库只读检查不变更，实际打开时经完整验证在事务内迁移。
schema3 增加唯一前驱/后继关系并兼容验证后迁移 v1/v2，旧行 input/hash/state
保持原字节；旧版本不能打开新 schema，升级前须关闭旧 bridge。前驱仅允许
reconcile_required，同账号、scope、bundle/path、主体/受众/接收方、聊天/消息、
文件/大小/hash、目录与会话绑定；新请求可使用新的有效同范围 grant。
关系 claim 与收取/落盘共用既有跨进程 bundle 锁；目标已有 staged 文件时
拒绝新的 claim。同一 successor 在落盘后、回执前中断，仍可凭原
verified_candidate/sourceIdentity 恢复，不重新点击。claim 原子保存关系和新
intent，永久阻止旧 attempt 继续落盘。
同目录只豁免该被限制的前驱；其他未决、新后继未完成或迟到文件歧义仍拒绝。
重试不是原 unknown 已终止的证明，也不改变恢复预检对未决历史的保守判断。
verified_candidate 仅表明原完成对象与新候选匹配，没有收件字节；application
复查权限后通过既有 ArtifactObjects 落盘，再提交幂等文件收据。
sourceReceipt=authorized_local_collector，不冒充 platform_file_reference 或
manual_import。已有 staged 文件只可恢复相同既有 capture，并核对原
sourceIdentity；换幂等键不能对该目标再次点击。

有受管理绑定时要求同账号/聊天、host_controlled、无未知发送并固定 epoch/
revision/cursor。无绑定的首次导入是本地明确选择的独立网页附件来源，保存
实际账号，不推断历史会话控制。同安装的未决 intent 阻止同目录新 intent，
无法锁住人或其他安装。精确 bigint 身份/纳秒时间、路径链与单候选校验拒绝
歧义；恢复预检拒绝未决 intent、半表及错 scope/账号/grant 引用。

当前原 ZIP 的安装后收取已实测：一次点击、原完成对象的新路径、Objects
与应用持久收据一致；新进程重放同请求不释放下载动作。随后原 PNG 单击发生
前台超时，保留原完成对象并通过同 intent 对账恢复，重放不释放下载动作。
两个声明文件齐全后已由安装 CLI 发布并检查 integrity=ok；见
[双文件记录摘要](release-evidence.md)。
该合成子场景保留 ZIP/PNG 各自源码与包，不代表最终统一版本。找回的历史 ZIP/PNG 仍是 local_file_observed，旧等待
不追认为成功。bundle v1/v2 与 LIVE 尚未通过，见
[原 ZIP 实测记录摘要](release-evidence.md)及
[检查点摘要](release-evidence.md)。

2026-10-19同议题六原件v1在9eab46c包完成发布/导出/独立审查/本地决定；
69567ec修后包以正式最近10条窗口和完整12条UI准确结算已发v2，不重发。
v2六原件2285B各取一次原完成对象，发布显式parent=v1，实际产品重新检查v1
ready/integrity/manifest/files逐项不变。独立审查验证ZIP五成员逐字节相等及
CRC32、64×64绿色PNG及全部chunk CRC32、静态正文和父标记。本地decision
回读一致，implementationAuthorized=false。历史原READMEunknown不改，后继
收件不追认为旧动作成功。两包子场景不冒充统一release，见
[版本化文件实测摘要](release-evidence.md)。

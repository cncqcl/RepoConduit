# 官方接口、参考实现与复用政策 v0.2

查阅/整合日期：2026-09-26。产品的对象、权限、状态、接口和默认预算是本项目设计，不声称来自以下项目或已经被它们全部实现。引用 URL 用于实施时再次核查；部署以实际固定版本为准。

## 1. 本次核查的 Codex／OpenAI 配置来源

| ID | 官方来源 | 本包使用的事实与边界 |
|---|---|---|
| C01 | https://developers.openai.com/codex/subagents （转至 https://learn.chatgpt.com/docs/agent-configuration/subagents） | 项目独立角色 TOML、model/effort、并发字段和覆盖规则；活跃父权限可能影响子代理 |
| C02 | https://developers.openai.com/codex/config-reference | 配置字段含义与所支持的值；安装版本需核查 |
| C03 | https://developers.openai.com/codex/cli/slash-commands （转至 https://learn.chatgpt.com/docs/developer-commands?surface=cli） | `/goal` 的设置、查看、pause/resume；目标最多 4,000 字符 |
| C04 | https://developers.openai.com/codex/models | Codex 模型选择、真实 ID 与客户端/账号条件 |
| C05 | https://developers.openai.com/api/docs/models | GPT-6 Astra/Sol/Luna 的模型标识；API可用不等于用户Codex权限 |
| C06 | https://developers.openai.com/codex/config-basic 与 https://developers.openai.com/codex/guides/agents-md | 项目配置与信任、指令发现；AGENTS不是运行时切换模型的程序 |
| C07 | https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt；https://developers.openai.com/chatgpt | 官方来源当前冲突：Help Center称Pro仅read/fetch、full MCP限Business与Enterprise/Edu；ChatGPT开发者首页称Plus/Pro均有read/write MCP。账号级实际权限须由真实工具调用确认；本项目当前没有这类调用证据 |
| C08 | https://developers.openai.com/plugins/reference | fileParams文件对象四个声明属性，其中download_url/file_id必需；平台相关映射不进入core |
| C09 | https://developers.openai.com/codex/app-server | Codex线程/事件/审批/取消接口；使用安装版本生成/检查bindings |

以上官方页面已查询；不因为网页页面存在就证明用户账号已获得能力。C07 两个当前官方页面对个人套餐的描述不一致，暂不据此断言个人Pro既支持或不支持写调用；实际账号能力保持未验证。产品采用能力探测＋明确授权，不硬编码一个永远有效的套餐表。普通Chat、Work、Deep Research的可用工具不同，不能混为一个已验收实例。

## 2. 输入设计已记录的参考实现

| ID | 仓库与固定依据 | 定向检查点 | 不继承 |
|---|---|---|---|
| R01 | [codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt/tree/9663b88753e35c76796c5bce000293e0bd22cd9e)，commit `9663b88753e35c76796c5bce000293e0bd22cd9e` | `docs/architecture.md`；`src/session/state.ts`；MCP与浏览器路线 | 单工作区单组会话状态；PLAN→EXECUTE默认职责 |
| R02 | [codexpro](https://github.com/rebel0789/codexpro/tree/482d0035e0c08cceb5916958df652b325b4c52d8)，commit `482d0035e0c08cceb5916958df652b325b4c52d8` | `src/importOps.ts`；受限工具路线、fixture与负向测试；下载来源/重定向/路径处理 | 单current-plan槽；泛化shell或整CLI自更新 |
| R03 | [oracle](https://github.com/steipete/oracle/tree/ed26dff9119580006cd11fd26584d54512233fa0)，`docs/followup.md` blob `7cdee34c18952ae10664244421a2847ee4ef8770` 对应 commit `ed26dff9119580006cd11fd26584d54512233fa0` | 精确原聊天续接、未知发送、产物捕获；Chrome CDP 专用 profile 与文件路线 | 第二套业务主session；跨provider行为等价假设；不复制浏览器 profile |
| R04 | [webcodex](https://github.com/yyjeqhc/webcodex/tree/5ef7274a7c3eab1144e68152adfc065b9e3e9910)，commit `5ef7274a7c3eab1144e68152adfc065b9e3e9910` | `docs/ARCHITECTURE.md`；统一内核/权限/工具合约；GPT Actions 个人Pro路线尚未验证 | 整套Runner/Goal/任务平台 |

这些固定引用保留自 v0.1 输入；本次通过 GitHub API 核对了 R01/R02/R04 的提交 SHA、R03 的 blob SHA 与其包含提交。R03 原记录本身是文件 blob，不是 commit；新增包含提交以便重复定位，不替换原 blob 证据。本包不是一次重新跑完整参考仓审计的声明。

可选调查适配参考：https://github.com/joseanu/codex-from-chatgpt ，只在需要核查 App Server 请求/恢复时定向读取；不把它加入必需运行依赖。

## 3. 协议与基础工具来源

- MCP：https://modelcontextprotocol.io/specification/latest/basic/authorization ；https://modelcontextprotocol.io/specification/latest/server/tools 。实施固定所使用 revision，正确校验 audience 与副作用。
- A2A：https://a2a-protocol.org/latest/specification/ 。只作为可选适配方向，不是首版必需依赖。
- Git worktree：https://git-scm.com/docs/git-worktree 。独立工作树不代表自动复制dirty状态或被冻结。
- 第二 runtime 候选：https://code.claude.com/docs/en/agent-sdk/overview ；https://code.claude.com/docs/en/agent-sdk/permissions 。官方 SDK/权限可作为调查适配候选；不得假定它与 Codex 有同等授权、计费或模型能力。

## 4. 复用审计结果

逐个候选的固定引用、许可证、路线证据层、复用决策、安全检查、测试证据边界、依赖与维护责任见 [reuse-audit.md](reuse-audit.md)。当前未复制或移植第三方代码；表格中的路线结论不代表个人账号实测或本产品 live 验收。

不得复制凭据、用户profile、自动更新脚本或全局配置修改逻辑。引入任何第三方代码先核查许可证并保留要求的版权/说明；本包未授予第三方代码许可证，也未把参考项目代码打进包。

停止调研条件：关键端口得到一个可靠实现路线、接口证据、异常用例和许可证判断。之后进入实现，遇到具体缺口再补查，不扩大为无限竞品研究。

### 2026-10-08 bounded current Codex source evidence

Official `rust-v0.162.0-alpha.2` resolves to commit
`74e804deeb1241d5fe699b31fb319f7d46454c42`. Seven selected upstream files
(LICENSE, NOTICE, Windows sandbox processor, tool planner, registry, router,
Session owner) and original GitHub API responses are retained only as reference
evidence under the private historical probe evidence; see [evidence status](release-evidence.md).
Git blob/size/hash checks passed; Apache-2.0 LICENSE and NOTICE are retained.
No upstream implementation was transplanted into product code or made a new
runtime dependency. Published version-source provenance does not attest the
installed binary's build inputs. This bounded check stops with the current
candidate's exclusive tool policy unverified; it does not start another route.

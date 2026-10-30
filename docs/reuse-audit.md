# Reference reuse audit

核查日期：2026-09-27。范围限于下列固定引用和已提供的 personal-routes 调研发现；不是对四个仓库全部代码、依赖或测试的完整审计。GitHub 提交、文件和许可证通过 GitHub API 核对。路线描述分为源码/文档确认与实际 live 验收，二者不能互相替代。

## 路线和复用结论

| 候选与固定依据 | 许可证 / notice | 源码或文档确认的个人路线 | live 证据 | 本项目复用决定 / 安全检查 |
|---|---|---|---|---|
| R01 [XiaoDuoYa/codex-with-chatgpt](https://github.com/XiaoDuoYa/codex-with-chatgpt/tree/9663b88753e35c76796c5bce000293e0bd22cd9e)，commit `9663b88753e35c76796c5bce000293e0bd22cd9e`；检查 `docs/architecture.md`、`src/session/state.ts` 与 MCP / browser 路线 | MIT；若未来移植代码，保留原版权声明和 MIT 许可文本。 [LICENSE](https://github.com/XiaoDuoYa/codex-with-chatgpt/blob/9663b88753e35c76796c5bce000293e0bd22cd9e/LICENSE) | 参考实现记载以浏览器配合只读 MCP 访问的路线。该路线不证明 ChatGPT 个人账号能够调用 RepoConduit 的写工具。 | 没有使用此参考实现完成的 RepoConduit live 调用；个人账号工具权限、项目适配和文件交付均未验证。 | **idea-only**。只把浏览器与只读查询作为路线证据；不继承其单工作区会话状态或 PLAN→EXECUTE 职责。检查点限定于状态/授权边界；未移植代码或测试。 |
| R02 [rebel0789/codexpro](https://github.com/rebel0789/codexpro/tree/482d0035e0c08cceb5916958df652b325b4c52d8)，commit `482d0035e0c08cceb5916958df652b325b4c52d8`；检查 `src/importOps.ts`、受限工具和 fixture / 负向测试 | MIT；若未来移植代码，保留原版权声明和 MIT 许可文本。 [LICENSE](https://github.com/rebel0789/codexpro/blob/482d0035e0c08cceb5916958df652b325b4c52d8/LICENSE) | 参考代码中的写工具路线仅有 fixture 层证据；写能力不能据此升级为个人 Pro 真实服务可用。 | 未观察到对个人账户的真实写工具调用，亦无该参考项目 fixture 之外的写入证明。 | **idea-only**。仅记录受限工具与文件导入边界；下载来源、重定向、路径处理需要本项目自己的边界测试。未复制 `importOps.ts`、更新器或 shell 能力。 |
| R03 [steipete/oracle](https://github.com/steipete/oracle/tree/ed26dff9119580006cd11fd26584d54512233fa0)，`docs/followup.md` blob `7cdee34c18952ae10664244421a2847ee4ef8770`，对应 commit `ed26dff9119580006cd11fd26584d54512233fa0` | MIT；若未来移植代码，保留原版权声明和 MIT 许可文本。 [LICENSE](https://github.com/steipete/oracle/blob/ed26dff9119580006cd11fd26584d54512233fa0/LICENSE) | 文档/实现路线涉及 Chrome CDP、用户手动登录的专用浏览器 profile、恢复原聊天及收集文件。不得复制、导入或共享现有个人浏览器 profile。此路线为参考实现事实，不自动成为本产品获准路线。 | 没有 RepoConduit Oracle/CDP live 会话或文件采集验收。本次打开的 OpenAI [Terms of Use 页面](https://openai.com/policies/terms-of-use/)返回 Europe 版本，其中禁止“Automatically or programmatically extracting data or Output”；它与自动化网页读取的适用关系尚未核实，因此不将 DOM/CDP 路线记录为本产品已选路线。 | **idea-only，路线状态待主会话决定**。只记录人工登录、会话续接和文件收集的参考事实；未复制 profile、cookie、CDP 会话或自动化代码。这里仅记录该页面文字，不作法律解释。 |
| R04 [yyjeqhc/webcodex](https://github.com/yyjeqhc/webcodex/tree/5ef7274a7c3eab1144e68152adfc065b9e3e9910)，commit `5ef7274a7c3eab1144e68152adfc065b9e3e9910`；检查 `docs/ARCHITECTURE.md` 与 GPT Actions 路线 | Apache-2.0；若未来移植代码，附许可证文本；检查并保留适用的 `NOTICE` 内容，遵守署名、修改标记及专利条款。 [LICENSE](https://github.com/yyjeqhc/webcodex/blob/5ef7274a7c3eab1144e68152adfc065b9e3e9910/LICENSE) | GPT Actions 是该参考项目采用/描述的路线；它是否能在个人 Pro 下提供本项目需要的写操作，当前为 **unverified**。 | 未观察到 ChatGPT 个人 Pro 经 GPT Actions 调用 RepoConduit、提交调查或写入 bundle。 | **idea-only**。参考统一内核、工具契约与权限分层；不继承整套 Runner、Goal 或任务平台。未移植代码或测试。 |

## 许可与复用状态

- 四个固定引用的 GitHub 许可证元数据分别为 MIT、MIT、MIT、Apache-2.0。R03 的原始引用是 blob SHA，不是提交；GitHub 文件接口确认该 blob 位于上表的 `ed26dff9119580006cd11fd26584d54512233fa0` 提交。R01/R02/R04 的 commit SHA 均与请求的固定 SHA 一致。
- 本轮未从参考项目复制或移植源代码、fixture、测试、profile、凭据、更新器或全局配置逻辑。当前无第三方代码 notice 需要随本项目交付；若将来移植代码，必须按上表相应许可证引入 license/notice，并将源文件、改动和测试追踪到提交。
- 本次审计没有修改 `package.json` 或锁文件以引入参考项目依赖。维护责任属于 RepoConduit 对应 adapter / application 层；不以封装整个参考 CLI 代替本项目权限检查。
- 路线调查可支持后续工程路线选择，但不改变产品设计权限、状态或完成标准。任何外部 route 的使用都须按本项目的授权和验收规范单独判断；本审计不作安全策略决策。

## 测试证据与限制

- 参考项目中的文档、源码路径和 fixture/负向测试只作为源材料检查点；本次没有运行这些项目的测试，也没有把它们的测试移植到 RepoConduit。
- 本次未运行 RepoConduit 测试；本文件是来源与复用记录，不构成接口、集成或 live 验收证据。
- OpenAI 官方资料目前对个人 MCP 权限存在来源冲突：[ChatGPT 开发者文档](https://developers.openai.com/chatgpt)称 Plus/Pro 支持读写 MCP；[Help Center](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)称 Pro 只有 read/fetch，full MCP 限 Business 与 Enterprise/Edu。此记录将个人账户实际权限保留为 **unverified**，须由真实账户工具调用与返回结果确认；两份文档都不是本账户调用回执。
- 源码可确认、fixture 可确认、官方计划文档和实时账户能力是不同证据层。本项目尚无实际账户工具调用或多文件 bundle 发布回执，因此不能据此声称完整个人账户路线已实现或通过。

## 下一步

保留当前个人账户路线为未验证；待本项目具备获授权的远端连接和非敏感 fixture 验收环境后，记录真实工具发现、调用结果、文件路径及错误行为。Oracle 网页提取路线的条款适用性与实现选择交由主会话处理。没有必要扩大为无边界竞品调查。

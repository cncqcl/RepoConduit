# 仓库目录与本地文件

根目录保留项目入口、许可证和工具默认读取的工程配置。使用和研发文档放在
`docs/`；贡献与安全说明放在 `.github/`；研发角色、角色策略和工程进度摘要放在
`.codex/`。`AGENTS.md` 留在根目录，供本地 coding agent 发现。

| 位置 | 内容 |
| --- | --- |
| `docs/user-guide/` | 面向用户的 Markdown 与离线 HTML 使用说明 |
| `docs/getting-started.md` | 简短上手入口 |
| `docs/DESIGN.md` | 产品目标与安全边界 |
| `docs/development/` | 开发任务入口和目录说明 |
| `.github/` | 贡献与安全说明 |
| `.codex/` | 研发配置、角色和进度摘要，不是产品调查器的权限配置 |
| `src/`、`contracts/`、`native/` | 产品源码、共享合约和 Windows helper 源码 |
| `tests/`、`tools/`、`skills/` | 测试、维护工具和随包分发的 host Skill |
| `verification/` | 公开验收模板、schema 和有范围的源码准备报告 |
| `node_modules/` | 本地开发依赖；由 npm 管理，不进入 Git 和源码导出物 |
| `dist/` | 本地构建输出；由构建命令更新，不进入 Git 和源码导出物 |
| `.local/` | 被忽略的必要工具组件或新诊断输出，不放历史安装副本和私有证据 |

`package.json`、`package-lock.json`、`npm-shrinkwrap.json`、`tsconfig.json` 和
`eslint.config.mjs` 保留在根目录。两个锁文件用途不同：前者服务源码依赖安装，
后者随安装包分发；项目校验要求它们内容一致，不能把其中一个当作重复文件删除。

历史诊断、临时安装、截图、下载包和私有运行材料保留在仓外归档。归档是移动和
保留，不表示已删除数据或释放磁盘空间；需要恢复历史现场时按原路径恢复到私有副本。
不要移动仍被进程占用的日志或运行依赖；应先确认进程身份，并在正常停止后归档。

本地已有安装及其数据目录与源码仓分开管理。整理源码或重建 `dist/` 不会自动升级
用户安装。完整产品发布状态仍以[验收手册](../ACCEPTANCE_AND_LIVE_RUNBOOK.md)为准。

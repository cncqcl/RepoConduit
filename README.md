# RepoConduit

RepoConduit 帮助个人开发者围绕本地 Git 项目与外部智能体协作。它将项目材料、讨论课题和版本化交付关联起来：用户可以在 ChatGPT 网页讨论，在本地 Codex 查收、审查结果，再决定是否授权实施。

当前首要组合是 Codex 与 ChatGPT。已有不同版本的组件验证和个人使用记录；**完整、统一版本的发布验收尚未通过**。调查能力需要单独配置和授权；外部参与者不会因此获得任意命令、源码写入或部署权限。详见[当前限制](docs/known-limitations.md)和[验证状态](docs/release-evidence.md)。

## 开始使用

- [用户使用说明](docs/user-guide/README.md)：常规流程、ChatGPT 网页中的讨论、课题与版本、关机恢复及常见问题。也可打开[离线 HTML 版](docs/user-guide/index.html)。
- [安装、配置与恢复](docs/operations.md)：CLI、连接和数据管理。
- [文档导航](docs/README.md)：开发设计、验收和其他说明。

源代码要求 Node.js 24.x。使用锁文件安装开发依赖后，可运行：

```powershell
npm ci
npm run typecheck
npm run lint
npm run build
```

完整测试为 `npm test`；真实运行与发布验证有额外环境和证据要求，见[验收手册](docs/ACCEPTANCE_AND_LIVE_RUNBOOK.md)。本仓库的 `private` 标记不表示已经发布到 npm；安装时请使用自己构建或取得的可信包。

## 目录

| 目录 | 内容 |
| --- | --- |
| `src/` | 产品源码与适配器 |
| `contracts/` | 共享操作合约 |
| `tests/` | 自动化测试和测试材料 |
| `docs/` | 使用、操作、设计和验收说明 |
| `tools/` | 构建、诊断和验证工具 |
| `skills/` | 本地 host 使用的协作 Skill |

项目源码采用 [MIT 许可证](LICENSE)。第三方依赖和许可材料见[依赖与许可](docs/DEPENDENCIES_AND_LICENSES.md)及[第三方声明](docs/THIRD_PARTY_NOTICES.md)。

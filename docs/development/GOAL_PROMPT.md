# 开发任务入口

先读取 [AGENTS.md](../../AGENTS.md)、[产品设计](../DESIGN.md)、
[架构与接口](../ARCHITECTURE_AND_CONTRACTS.md)、
[当前维护计划](../IMPLEMENTATION_PLAN.md) 和
[验收规则](../ACCEPTANCE_AND_LIVE_RUNBOOK.md)。

以用户当前明确任务为范围，核查真实源码、工作区改动及受影响测试。
`.codex/GOAL_STATE.json` 是公开工程状态摘要，不是宿主 Goal 配置，
不触发后台工作，也不承接历史用户的机器、账号或研究授权。

实现、测试、真实集成和正式发布分别判断。维护用户数据与历史失败；
产品调查器的权限不能继承本仓研发权限。只运行当前任务必要检查，
长时/高成本验证先估算并获得当前用户授权。完整发布仍遵循验收手册。

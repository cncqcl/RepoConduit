# Codex 研发配置

本页描述仓库内的研发角色配置，不构成产品 Local Investigator 的安全隔离证明。主会话配置和角色文件、当前客户端支持情况、账户模型可用性及会话覆盖共同决定实际运行设置；`AGENTS.md` 本身不会切换模型。

当前项目角色映射以 [development-role-policy.json](../config/development-role-policy.json) 和 `.codex/agents/` 中 TOML 为准：主会话为 `gpt-6-astra` / `medium`；架构与独立评审为 Astra/high，定向探索与验证为 Sol 6.1/high，明确实现为 Sol 6.1/medium，文档及视觉任务为 Terra/high，难题升级角色为 Astra/xhigh。默认子代理遵循当前用户层设置。角色映射是项目策略，不是模型性能保证。

`.codex/config.toml` 定义主会话和并发默认值；项目角色配置用于研发框架，不为外部调查授予权限。父会话的活动权限可能影响子代理，不能把角色配置中的只读声明当作已验证沙箱。

历史配置检查只证明当时客户端对所测配置的解析；新会话是否加载、实际 role/model/effort 与账户权限需在相应客户端实际核对。已运行会话可能保留已有选择或缓存。若客户端格式或可用模型变化，应先查其实际 schema，再一致更新相关项目配置；不可用模型不得虚构别名或静默降低质量关键角色的要求。

仓库工程进度记录与宿主的原生 Goal 是不同概念。是否提供 `/goal` 以及其用法应以当前客户端为准，不通过猜测配置字段模拟未提供的功能。历史观察和完成边界见[验证状态](release-evidence.md)。

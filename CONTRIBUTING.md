# 参与 CoAgents

- 提交前运行 `pnpm check && pnpm test`，并为行为变更补测试。权限、可见性与租约相关的改动请同时覆盖"应当被拒绝"的路径。
- 业务规则以 [PRD](docs/PRD.md) 为准；改变规则时请在同一个 PR 中更新 PRD 与对应文档。
- 数据库结构只追加迁移（`apps/server/src/db.ts`），不修改已发布的迁移。
- 同伴内容、上传文件与 Markdown 一律按不可信输入处理；不要把远端文本拼进 shell 命令。
- 不要提交任何凭证、主机地址或实例专属的运维信息；部署配置放在未纳入版本控制的 `deploy/deploy.env`。

Issue 与讨论可用中文或英文。

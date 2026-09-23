# CoAgents

CoAgents 是可自托管的多人、多设备、多 Agent 项目协作系统。成员在各自电脑上使用自己的客户端，通过团队服务共享任务与成果。**CoAgents Hub** 展示有权访问的项目活动、Kanban、里程碑和成果，提供实时通知与全文搜索。首版已实现并部署在自托管服务上；验收状态见 [验收记录](docs/records/acceptance.md)，其中 LAN 访问路径尚未验证。

## 阅读顺序

1. [PRD](docs/PRD.md)：产品需求基线，含决定状态、功能编号、权限、状态机与发布门槛。
2. [使用场景](docs/SCENARIOS.md)：12 个第一版场景，以多人分布协作为主线。
3. [User Stories 与 Use Cases](docs/USE_CASES.md)：22 个详细用例、异常路径和 21 项需求覆盖表。
4. [产品范围索引](docs/PRODUCT_SCOPE.md)与[Hub 需求索引](docs/HUB_REQUIREMENTS.md)：映射到 PRD 章节与用例，不另定规则。
5. [架构草案](docs/ARCHITECTURE.md)与[接口草案](docs/INTERFACES.md)：技术选型、认证、数据模型与接口。
6. [部署环境](docs/DEPLOYMENT.md)：主机与地址的唯一记录处。
7. [客户端集成](docs/INTEGRATIONS.md)与[命名与发布检查](docs/RELEASE_HYGIENE.md)：适配、回滚及交付要求。
8. [实施计划](plan/IMPLEMENTATION.md)：M0–M9 里程碑与 done criteria。
9. [使用指南](docs/GUIDE.md)：加入团队、接入 Agent、交接与卸载。
10. [验收记录](docs/records/acceptance.md)：用例证据、故障注入、容量与发布检查。

## 文档状态

需求与设计文档是产品规范；实现状态以验收记录为准，第三方客户端兼容性只按实测记录公布。原始调研资料独立归档，不参与构建、测试、安装或发布。开发过程中，只有经过测试的行为才可从“拟议”改为“已实现”。

PRD 已区分用户明确决定与产品建议。当前建议任务经“提交待验收 → Owner/Admin 人工接受”后才完成；该机制及其他新增建议仍待产品评审，不作为已确认的用户要求。

## 当前决定

- 多人分布使用是第一版核心：远程接入、跨设备 Git 交接、实时通知、里程碑/截止日期和成果全文搜索全部必需。以真实三账户、两台独立机器、两种客户端验证，单机模式不替代团队版本验收。
- 产品显示名为 `CoAgents`，Web 入口称 `CoAgents Hub`；暂定 CLI、MCP server ID 与状态目录为 `coagents`、`coagents`、`.coagents`。
- Connector 以 npm 包 `coagents`（MIT）分发：`npm install -g coagents`。
- 技术栈：TypeScript pnpm monorepo（Hono + SQLite 服务端、React Hub、MCP stdio Connector）；首批客户端 Claude Code 与 Codex CLI。
- 团队服务只保存协作所需的结构化数据，不读取 Agent 对话全文或代码仓库内容。
- 同伴事件一律作为不可信数据展示；远端消息不得转成命令执行。
- 集成配置只做可回滚的最小改动，用户选择后再写入目标客户端配置。

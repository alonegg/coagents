# CoAgents

可自托管的多人、多设备、多 Agent 项目协作系统。团队成员在各自电脑上继续使用自己的编码客户端（Claude Code、Codex CLI），通过同一个团队服务共享任务、决策、交接与成果；**CoAgents Hub** 提供项目看板、实时活动、里程碑、成果全文检索、权限与审计。

*A self-hosted collaboration service for teams whose members each run their own coding agents. Agents connect over stdio MCP through the `coagents` Connector; people work in the web Hub. MIT licensed.*

## 功能

- **任务与租约**：五列看板，同一时刻只有一个执行者（人或 Agent）持有任务；过期租约不能再写入；验收由人完成。
- **实时协作**：业务事件按序推送，断线按游标补读，撤权后已有连接立即断开；站内通知区分送达与已读。
- **跨设备交接**：交出方记录分支与 commit，接手方 Connector 在自己的工作副本中只读核对，缺什么说清楚。
- **成果**：Markdown、文件、链接；草稿私有、发布版本不可改、受限名单；中文与 PDF 正文全文检索。
- **里程碑与截止日期**：按项目时区解释日期，逾期由服务端计算，达成须由人确认。
- **账户与后台**：注册申请与审批、项目邀请、设备授权、临时密码、实例审计。

## 快速开始

**接入一个已有的 CoAgents 服务**（需要 Node.js 22.12+）：

```bash
npm install -g coagents
coagents login --server https://<服务地址> --project <项目 ID>
coagents install claude-code     # 或 codex
```

详见 [使用指南](docs/GUIDE.md)。

**自己部署一套服务**：见 [自托管部署](docs/DEPLOYMENT.md)（单台 Linux 主机、systemd、Caddy 自动 HTTPS）。

## 开发

```bash
pnpm install
pnpm check    # 类型检查
pnpm test     # 服务端、Connector 与集成测试
pnpm build    # 服务端、Hub 与 npm 包（packages/connector/.pkg）

# 本地运行
printf '%s' 'a-local-password' | node apps/server/dist/main.js setup --username admin --display-name Admin
COAGENTS_HUB_DIR=apps/hub/dist node apps/server/dist/main.js serve    # http://127.0.0.1:8787
```

| 目录 | 内容 |
| --- | --- |
| `apps/server` | 团队服务：Hono + SQLite，HTTP API、SSE、全文检索、后台 |
| `apps/hub` | CoAgents Hub：React 单页应用，由服务端同源托管 |
| `packages/connector` | Connector（npm 包 `coagents`）：stdio MCP 服务、设备码登录、客户端配置安装与卸载 |
| `packages/contract` | 服务端与客户端共享的 schema、状态机与权限矩阵 |
| `deploy/` | 主机初始化、systemd 单元、Caddy 配置、发布脚本 |
| `scripts/e2e`、`scripts/load` | 跨机器验收与容量测试 |

## 文档

1. [PRD](docs/PRD.md)：产品需求、权限、状态机与发布门槛。
2. [使用场景](docs/SCENARIOS.md) 与 [用例](docs/USE_CASES.md)。
3. [架构](docs/ARCHITECTURE.md) 与 [接口](docs/INTERFACES.md)。
4. [客户端集成](docs/INTEGRATIONS.md)：[Claude Code 记录](docs/records/claude-code.md)、[Codex 记录](docs/records/codex.md)。
5. [实施计划](plan/IMPLEMENTATION.md) 与 [验收记录](docs/records/acceptance.md)。
6. [使用指南](docs/GUIDE.md)、[自托管部署](docs/DEPLOYMENT.md)、[命名与发布检查](docs/RELEASE_HYGIENE.md)。

## 设计边界

- 服务只保存协作所需的结构化数据，不读取 Agent 对话全文，也不自动读取代码仓库；Git 仅在用户发起交接时做只读检查。
- 同伴写入的内容一律作为不可信数据交给 Agent，不会被当作命令执行。
- Agent 权限是所属用户当前角色与授权 scope 的交集，不能验收、管理成员或跨项目访问。
- 客户端配置只做可回滚的最小改动，写入前展示差异，卸载时恢复原样。

当前状态：第一版已实现并在一套测试实例上完成验收，局域网访问路径尚未验证，见 [验收记录](docs/records/acceptance.md)。

## 参与与安全

欢迎提 Issue 与 Pull Request，见 [CONTRIBUTING](CONTRIBUTING.md)。安全问题请按 [SECURITY](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)

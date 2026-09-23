# 集成记录：Claude Code

按 [客户端集成](../INTEGRATIONS.md) 的验收记录模板填写。未列出的项保持"待验证"。

| 项 | 结果 |
| --- | --- |
| 客户端版本 | Claude Code 2.1.280 |
| 操作系统 / 设备 | macOS（Darwin 25.6.0，arm64），开发机 |
| 服务地址类型 | 公网 HTTPS，`https://coagents.chengdu80.org`，Let's Encrypt 证书 |
| 配置位置 | 项目根目录 `.mcp.json`（项目级），条目名 `coagents`，stdio |
| 安装前后差异 | 在已有 `existing-tool` 条目的文件中新增 `coagents` 条目；安装前展示差异 |
| 客户端信任 | Claude Code 对项目级 MCP 服务要求人工批准；安装器不代为批准，只提示 |
| 真实工具调用 | 2026-09-23：`claude -p` 会话中服务状态 connected，依次调用 get_context、list_tasks、claim_task、submit_task，任务进入待验收；Hub 显示连接"已验证"，事件标注 Agent 来源 |
| 证书校验 | Connector 使用 Node 默认校验；自签证书服务被拒绝（`tests/connector.integration.test.ts`） |
| 撤销与卸载 | `coagents uninstall claude-code`：`.mcp.json` 恢复后 SHA-256 与安装前一致（bc1652e7…）；服务端凭证撤销，旧令牌 401；本机凭证删除 |
| 实时收取与重连 | Connector 在 MCP 运行期间保持 SSE 流，断线按游标退避重连；服务重启后自动恢复（2026-09-23 实测）；Hub 显示送达/已读序号 |
| Git 交接 | Connector 层能力与客户端无关；跨设备实测见 [Codex 记录](codex.md)，本地真实 git 集成测试见 `tests/handoff.integration.test.ts` |

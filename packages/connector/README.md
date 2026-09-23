# coagents

CoAgents Connector：把 Claude Code、Codex CLI 等编码 Agent 通过 MCP 接入自托管的 CoAgents 团队服务，在同一个项目里共享任务、租约、决策、交接、成果与全文检索。

*Connects coding agents (Claude Code, Codex CLI) to a self-hosted CoAgents team service over stdio MCP.*

需要 Node.js 22.12 或更高版本，以及一个 CoAgents 服务地址和你在其中的项目。

## 安装

```bash
npm install -g coagents
coagents --version
```

## 接入

在你的代码工作目录中：

```bash
coagents login --server https://<你的 CoAgents 服务> --project <项目 ID> --label "Claude Code on <电脑>"
coagents install claude-code     # 写入本目录 .mcp.json；在 Claude Code 中批准 coagents 服务
coagents install codex           # 或写入 ~/.codex/config.toml 中带标记的一段
coagents status
```

`login` 显示一个确认码，在已登录的 CoAgents Hub 中核对项目与设备后批准。凭证只保存在 `~/.coagents/credentials.json`（0600），目录绑定 `.coagents/project.json` 不含凭证。建议把 `.coagents/` 加入 `.gitignore`。

写入客户端配置前会显示差异。配置里记录的是当前 Node 与本包的绝对路径；升级或移动 Node 后重新执行一次 `install`。

## Agent 可用的工具

`get_context` `ack_events` `list_tasks` `create_task` `claim_task` `renew_task_lease` `release_task` `submit_task` `publish_decision` `publish_blocker` `list_artifacts` `get_artifact` `create_artifact` `update_artifact_draft` `publish_artifact` `prepare_handoff` `list_handoffs` `accept_handoff` `list_milestones` `search_artifacts`

Agent 不能验收任务、管理成员、上传文件或访问其他项目。同伴写入的内容作为不可信数据返回。跨设备交接时 Connector 只在你的工作副本中做只读 git 检查，不 fetch、不切换分支、不改文件。

## 卸载

```bash
coagents uninstall claude-code   # 未被改动时逐字节恢复 .mcp.json，撤销服务端凭证，删除本地绑定
coagents uninstall codex
npm uninstall -g coagents
```

## 许可证

MIT

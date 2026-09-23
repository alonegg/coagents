# 接口草案

状态：拟议。接口名和字段是 CoAgents 自主设计，实施前可以调整；它们不表示任何现成服务的兼容性。所有接口由服务端根据身份、项目成员关系及对象可见性授权。

业务规则以 [PRD](PRD.md) 为准。以下接口纳入本版新增的人工验收与 Agent 文本成果建议；接口名称仍可调整。

## MCP 工具，首版

| 工具 | 输入 | 成功结果 | 关键错误 |
| --- | --- | --- | --- |
| `get_context` | `cursor?`, `limit?` | 已授权项目摘要、有效决策、未读事件、`next_cursor`, `has_more` | 项目未初始化、无权访问 |
| `list_tasks` | `status?` | 任务数组 | 无效筛选 |
| `create_task` | `title`, `description?`, `request_id` | 新任务 ID | 标题无效、权限不足 |
| `claim_task` | `task_id`, `request_id` | 持有者、`lease_token`、租约截止时间、新版本 | 已被持有、状态不可认领、任务不存在 |
| `renew_task_lease` | `task_id`, `lease_token`, `request_id` | 延长后的租约 | 已过期、非持有者 |
| `release_task` | `task_id`, `lease_token`, `note?`, `request_id` | 回到待办的任务与新版本 | 非持有者、租约已过期 |
| `submit_task` | `task_id`, `lease_token`, `summary`, `artifact_version_ids?`, `evidence?`, `request_id` | 待验收状态和提交 ID | 非持有者、证据不足 |
| `publish_decision` | `body`, `supersedes_id?`, `request_id` | 事件与决策 ID | 被替代项不存在、重复替代冲突 |
| `publish_blocker` | `body`, `task_id?`, `lease_token?`, `request_id` | 事件 ID；带任务时返回阻塞状态与新版本 | 正文无效、带任务但非持有者 |
| `list_artifacts` | `task_id?`, `status?` | 可见成果的标题、版本与摘要 | 权限不足 |
| `get_artifact` | `artifact_id`, `version?` | 授权版本的正文或下载入口 | 不存在或无权访问 |
| `create_artifact` / `update_artifact_draft` | 标题、正文或链接、`task_id?`, `expected_version?` | 本人名下草稿 | 无权限、版本冲突 |
| `publish_artifact` | `artifact_id`, `expected_version` | 不可变发布版本 | 无权限、可见范围未确定 |
| `prepare_handoff` / `accept_handoff` | 任务、目标、成果版本与本地 Git 检查结果（由 Connector 上报，服务端记录为客户端自证） | 待接收记录/新租约 | 缺 commit、仓库不符、材料缺失、租约竞争 |
| `list_milestones` | 无 | 目标、日期、关联任务数量 | 无权限 |
| `search_artifacts` | `query`, `version_scope?`, `cursor?` | 授权正文片段及版本位置 | 无权限、索引未就绪 |

所有写入参数由 schema 校验，正文有长度上限。重复的 `request_id` 返回原结果。MCP 错误同时提供机器可读代码与可读说明，不泄露凭证或内部路径。Agent 暂不通过 MCP 上传二进制成果；首版文件上传由 Hub 完成。

MCP 工具不接收 `project_id`：Connector 启动时从工作目录的 `.coagents/project.json`（只含服务地址与项目 ID，不含凭证）确定项目，再使用本机凭证库中绑定该用户、设备和项目的 Agent 凭证。一个客户端只写入一个 `coagents` MCP 条目，多个项目通过不同工作目录区分；`list_milestones` 的 `project_id` 参数随之取消。

所有写入都要求 `request_id`。任务状态只能经语义动作改变，不提供通用的改状态工具：`claim_task`（待办/阻塞 → 进行中）、`release_task`（进行中 → 待办）、带 `task_id` 的 `publish_blocker`（进行中 → 阻塞）、`submit_task`（进行中 → 待验收）；这些动作由持有者凭有效 `lease_token` 执行，成功后清理或发放租约并递增任务版本。不带 `task_id` 的阻塞只记录事件，不改变任务状态。编辑任务标题、说明、验收条件等字段使用 `expected_version`。接受/退回/重开为 Hub 中经人工会话授权的独立操作，不暴露为 Agent MCP 工具。Agent 不得借用户身份调用人工验收接口。

## 内部服务 API

团队服务 API 经 HTTPS 供远程 Hub 和各设备 Connector 使用，不承诺为公开兼容协议。首版资源：`/v1/session`、`/v1/invitations`、`/v1/devices`、`/v1/projects`、`/v1/activity`、`/v1/notifications`；项目下提供 `activity`、`tasks`、`artifacts`、`members`、`agents`、`handoffs`、`milestones`、`search`。附件只能通过授权下载接口获取；全文片段在返回前执行同样授权。具体方法、schema 和认证方式由契约测试确认。

实时事件接口支持认证、恢复游标、事件 ID 和连接重授权；传输可选 SSE/WebSocket，语义统一。客户端申报设备标识不能替代设备凭证。事件已送达确认与 Agent 已读取确认是不同动作。邀请接受、设备撤销、里程碑确认及人工验收使用相应的人类角色接口。

项目列表只返回当前用户为成员的项目；活动、任务、成果与统计都按同一项目授权过滤。更新任务时提交 `expected_version`，冲突返回可识别错误供 Hub 刷新卡片。成员和凭证管理只允许相应角色；登录状态不能由前端传来的角色字段决定。

## 读取游标规则

1. 查询 `cursor = N` 返回 `seq > N` 的事件，顺序为升序。
2. 只有客户端明确确认已处理的 `seq` 才写入 Cursor。
3. 页大小受限；`has_more = true` 时客户端继续读取，不得把未返回事件标为已读。
4. 断线重试可能重复返回事件，客户端按事件 ID 去重。

## 数据示例

```json
{
  "project": { "id": "project_01", "name": "示例项目", "role": "contributor" },
  "events": [
    { "seq": 8, "id": "event_08", "kind": "decision", "body": "采用 SQLite 保存本机状态" }
  ],
  "next_cursor": 8,
  "has_more": false
}
```

此示例只说明字段含义；最终 schema 由实际代码和契约测试确认。

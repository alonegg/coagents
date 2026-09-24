# 接口草案

状态：拟议。接口名和字段是 CoAgents 自主设计，实施前可以调整；它们不表示任何现成服务的兼容性。所有接口由服务端根据身份、项目成员关系及对象可见性授权。

业务规则以 [PRD](PRD.md) 为准。以下接口纳入本版新增的人工验收与 Agent 文本成果建议；接口名称仍可调整。

## MCP 工具

协议版本 2（Connector 0.2.0）。交换对象的字段、证据规则和提示词送达方式见 [Agent 协作协议](AGENT_PROTOCOL.md)；工具的权威定义在 `packages/connector/src/server.ts`。

| 工具 | 输入 | 成功结果 | 关键错误 |
| --- | --- | --- | --- |
| `get_context` | `cursor?`, `limit?` | 身份与角色、项目、有效决策（含作者类型）、`my_work`、成员、精简事件、`workflow`、`next_cursor`, `has_more` | 项目未绑定、无权访问、Connector 过旧 |
| `ack_events` | `seq` | 新的已读游标 | — |
| `wait_for_events` | `after_seq?`, `timeout_seconds?`（≤55） | 他人产生的事件，或 `timed_out` | — |
| `list_tasks` | `status?` | 精简任务（持有者、`is_you`、清单条数） | 无效筛选 |
| `get_task` | `task_id` | 完整任务、验收清单、历次提交（证据、覆盖、验收说明） | 不存在或无权访问 |
| `create_task` | `title`, `description?`, `criteria?`, `assignee_id?`, `request_id?` | 新任务 | 标题无效、权限不足 |
| `claim_task` | `task_id`, `request_id?` | 任务与租约截止时间（令牌由 Connector 保存） | 已被持有、状态不可认领 |
| `renew_task_lease` | `task_id`, `request_id?` | 延长后的租约 | 租约无效 |
| `release_task` | `task_id`, `note?`, `request_id?` | 回到待办的任务 | 租约无效 |
| `submit_task` | `task_id`, `summary`, `evidence_items?`, `evidence?`, `artifact_version_ids?`, `request_id?` | 待验收任务、提交 ID、逐条覆盖 | 租约无效、证据不足、条目编号未知 |
| `publish_decision` | `body`, `supersedes_id?`, `request_id?` | 决策 | 重复替代冲突 |
| `publish_blocker` | `body`, `kind?`, `needs_from_user_id?`, `depends_on_task_id?`, `task_id?`, `request_id?` | 事件；带任务时返回阻塞状态 | 租约无效、成员或任务不存在 |
| `list_artifacts` / `get_artifact` | `task_id?` / `artifact_id` | 可见成果与版本 | 无权访问 |
| `create_artifact` / `update_artifact_draft` / `publish_artifact` | 标题、正文或链接、`expected_revision` | 草稿 / 不可变版本 | 版本冲突、无权限 |
| `prepare_handoff` | `task_id`, `summary`, `next_steps[]`, `risks?`, `target_user_id?`, `include_git?`, `artifact_version_ids?` | 待接收交接 | 未提交或未推送的代码、租约无效 |
| `list_handoffs` / `accept_handoff` | `state?`, `task_id?` / `handoff_id` | 交接列表 / 新租约与本地检查结果 | 缺 commit、仓库不符、租约竞争 |
| `list_milestones` | 无 | 目标、日期、任务数量 | — |
| `search_artifacts` | `query`, `scope?`, `limit?` | 授权片段及版本位置 | 无权访问 |

错误返回 `{ error: { code, message, hint } }`。读工具标注 `readOnlyHint`，写工具标注 `destructiveHint: false`；没有删除类工具。

所有写入参数由 schema 校验，正文有长度上限。重复的 `request_id` 返回原结果。MCP 错误同时提供机器可读代码与可读说明，不泄露凭证或内部路径。Agent 暂不通过 MCP 上传二进制成果；首版文件上传由 Hub 完成。

MCP 工具不接收 `project_id`：Connector 启动时从工作目录的 `.coagents/project.json`（只含服务地址与项目 ID，不含凭证）确定项目，再使用本机凭证库中绑定该用户、设备和项目的 Agent 凭证。一个客户端只写入一个 `coagents` MCP 条目，多个项目通过不同工作目录区分；`list_milestones` 的 `project_id` 参数随之取消。

所有写入都带 `request_id`：Agent 可自行传入以便重试时复用，未传时由 Connector 生成。任务状态只能经语义动作改变，不提供通用的改状态工具：`claim_task`（待办/阻塞 → 进行中）、`release_task`（进行中 → 待办）、带 `task_id` 的 `publish_blocker`（进行中 → 阻塞）、`submit_task`（进行中 → 待验收）；这些动作由持有者凭有效 `lease_token` 执行，成功后清理或发放租约并递增任务版本。不带 `task_id` 的阻塞只记录事件，不改变任务状态。编辑任务标题、说明、验收条件等字段使用 `expected_version`。接受/退回/重开为 Hub 中经人工会话授权的独立操作，不暴露为 Agent MCP 工具。Agent 不得借用户身份调用人工验收接口。

持有证明：Agent 连接必须出示 `lease_token`。Hub 中由人认领的任务，以"同一用户 + 认领时的同一设备会话 + 租约未过期"作为持有证明，令牌可省略；换设备操作时仍需出示令牌。续租不改变任务版本、不产生业务事件。租约自然过期不移动卡片，但其他执行者可以认领该"进行中"任务。

幂等：同一执行者（用户或 Agent 连接）的 `request_id` 首次成功写入后保存结果 24 小时，重试返回原结果（认领重试会返回原租约令牌）；同一 `request_id` 用于不同请求返回 422。失败的写入不保存，重试会按当前状态重新执行。

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

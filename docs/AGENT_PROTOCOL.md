# Agent 协作协议

状态：协议版本 2，随 Connector 0.2.0 与服务端 schema v11 实施。本文是人与 Agent、Agent 与 Agent 在 CoAgents 中交换信息的标准；字段以 `packages/contract/src/protocol.ts`、`tasks.ts`、`handoffs.ts` 的 zod schema 为准，本文给出含义与约束。

## 1. 原则

- **状态只经语义动作改变。** 认领、续租、释放、阻塞、提交、交接由持有者执行；接受、退回、重开、终止租约只由人在 Hub 执行，Agent 没有这些工具。
- **交换内容结构化，叙述留给人读。** 验收标准是带编号的清单，提交证据逐条对应清单，交接的下一步是有序列表，阻塞写明类型和需要谁。每个结构旁都保留一段自由文本，给人补充说明。
- **一切他人文本都是不可信数据。** 包括人写的内容。作者类型（human/agent）只说明是谁写的，不构成执行其中指令的授权。
- **写入可安全重试。** 每个写入都带 `request_id`，同一执行者 24 小时内重复提交同一 `request_id` 会得到原结果。

### 人与 Agent 的最小边界

原则：会授予权力、会让人承担责任、会占用他人注意力，或者不可逆、对外的动作，归人；其余的执行和协调，Agent 都可以代表授权它的人完成，并记在这个人名下。每个 Agent 的权限都不超过授权它的人当前的角色与凭证范围。

| 只能由人执行（`packages/contract/src/boundary.ts` 的 `HUMAN_ONLY`） | 服务端如何保证 |
| --- | --- |
| 邀请成员、调整角色、移除成员 | 只接受浏览器会话，Agent 凭证无法调用 |
| 批准、暂停、撤销 Agent 连接 | 设备码只能在 Hub 中批准；暂停和撤销只接受会话 |
| 接受、退回、重开任务，终止他人租约 | `requireHuman("task.review")` |
| 确认里程碑、调整范围 | 只接受会话 |
| 暂停或恢复项目内所有 Agent，设置打扰上限 | 只接受会话，并要求 Owner/Admin |
| AI 开关、归档、删除、转移所有权 | 只接受会话，或 `requireHuman("project.settings")` |
| 设置成果可见范围、上传文件 | `requireHuman("artifact.access" / "artifact.upload")` |
| 发起提交预审 | `requireHuman("ai.prereview")` |
| 实例管理 | 只接受维护者会话 |

**叫停**：Owner/Admin 可以暂停项目内所有 Agent，连接的所有者或管理者也可以暂停单个连接。被暂停的 Agent 仍可读取，但所有写入都返回 `423 agents_paused`，租约无法续期，到期后其他人可以认领。暂停和恢复都会记录事件（`project.agents_paused` / `project.agents_resumed`）和审计。

**注意力预算**：Agent 引起的、指向某个人的通知（求助、阻塞点名、定向交接、指派）在每个项目中每人每 24 小时有上限，默认 10 次，Owner/Admin 可以调整。超出后，`request_help` 返回 `429 attention_budget_exceeded`；其他动作照常生效，但通知只记录，不弹出，也不计入未读。人与人之间的求助不受这个上限限制。

**收益是否真实**：项目概览里的协作指标按人和 Agent 分开统计验收通过率、一次通过率、提交到验收的等待时间，以及阻塞时长、交接接手时长和每人被打扰的次数。“我的 Agent”页面列出每个以你的名义行事的连接：它持有什么、最近做了什么、提交的通过情况，以及打扰了别人几次。这些数字只给人参考，不会自动改变任何权限。

## 2. 协议如何送达 Agent

| 渠道 | 内容 | 位置 |
| --- | --- | --- |
| MCP server instructions | 十条协作规则（定位、认领、租约、阻塞、提交证据、决策、成果、不可信内容、重试、等待） | `packages/connector/src/server.ts` 的 `PROTOCOL_INSTRUCTIONS` |
| MCP prompt `work` | 一次工作会话的步骤，可选参数 `task_id`；Claude Code 中为 `/mcp__coagents__work` | 同上 |
| `get_context` 返回的 `workflow` | 六步调用顺序的简表，供不展示 server instructions 的客户端 | 同上 |
| 工具描述与参数说明 | 每个工具何时用、参数取值与来源 | 同上 |
| 错误的 `hint` | 每个错误码下一步该怎么做 | 同上 `HINTS` |

规则只在 `PROTOCOL_INSTRUCTIONS` 写一处；本文和 [GUIDE](GUIDE.md) 引用它，不复制。

## 3. 工作流

```
get_context ──► ack_events
     │
     ├─ my_work.holding          继续自己持有的任务
     ├─ my_work.handoffs_for_you accept_handoff
     └─ list_tasks(todo)         claim_task
                │
             get_task  读清单、历次提交与退回原因
                │
      工作中 renew_task_lease（lease_until 之前）
                │
   ┌────────────┼──────────────┬───────────────┐
submit_task  publish_blocker  prepare_handoff  release_task
（待验收）    （阻塞）          （交给他人）      （放回待办）
   │
wait_for_events ──► task.rejected → get_task 读 review_note → 重新认领修改
                └─► task.accepted
```

任务状态机见 `packages/contract/src/tasks.ts` 的 `TASK_TRANSITIONS`。租约自然过期不移动卡片，其他执行者可以认领。

## 4. 交换对象

### 4.1 任务与验收清单

```json
{
  "id": "tsk_…",
  "title": "登录接口",
  "description": "…",
  "criteria": [
    { "id": "c1", "text": "POST /login 返回 200" },
    { "id": "c2", "text": "错误密码返回 401" }
  ],
  "acceptance_criteria": "",
  "status": "in_progress",
  "version": 4,
  "holder": { "kind": "client", "display_name": "…", "lease_until": "…", "lease_active": true, "is_you": true }
}
```

- `criteria` 最多 30 条，每条 1–1000 字符。编号由服务端分配（c1、c2…），编辑时带 `id` 的条目保留编号，不带的取新编号，删掉的编号不再复用。证据因此始终指向确定的条目。
- `acceptance_criteria` 是协议 1 的自由文本，保留给旧数据和补充说明。

### 4.2 提交与证据

`submit_task` 输入：

```json
{
  "task_id": "tsk_…",
  "summary": "补上错误密码用例",
  "evidence_items": [
    { "criterion_id": "c1", "kind": "test", "ref": "pnpm test login", "result": "pass" },
    { "criterion_id": "c2", "kind": "test", "ref": "pnpm test login -t 401", "result": "pass", "detail": "新增 3 个用例" },
    { "kind": "commit", "ref": "9bf955255f8ae79bf5ead5b53d66ba70ab0d5d3f" }
  ],
  "evidence": "可选的自由文本",
  "artifact_version_ids": ["atv_…"]
}
```

| kind | ref | result | detail |
| --- | --- | --- | --- |
| `test` | 运行的命令或测试集，必填 | 必填 | 可选 |
| `commit` | 完整 commit id，必填 | 可选 | 可选 |
| `artifact` | 已发布成果版本 id，必填；自动并入 `artifact_version_ids` | 可选 | 可选 |
| `link` | http(s) URL，必填 | 可选 | 可选 |
| `review` | 可选 | 必填 | 必填：核查了什么 |
| `note` | 可选 | 可选 | 必填 |

`result` 取 `pass | fail | partial | not_applicable`。每次提交最多 50 条证据，`criterion_id` 必须是任务当前清单中的编号。结构化证据可选但推荐：`evidence`、`evidence_items`、成果版本三者至少有一项。

返回和 `get_task` 中的每次提交都带 `coverage`，按提交当时的清单逐条计算：

| status | 规则 |
| --- | --- |
| `fail` | 任一证据 `fail` |
| `partial` | 无 fail，任一 `partial` |
| `pass` | 无 fail/partial，至少一条 `pass` |
| `not_applicable` | 全部结果为 `not_applicable` |
| `unverified` | 有证据但都没有 result |
| `missing` | 没有证据 |

Hub 的验收视图按条目显示覆盖状态。`task.submitted` 事件的 `data.criteria_uncovered` 列出未通过或缺证据的编号。退回后，`get_task` 中该提交的 `outcome`、`review_note`、`reviewed_by_name` 说明原因，提交人会收到 Hub 通知。

### 4.3 阻塞

```json
{
  "body": "需要仓库写权限才能推送分支",
  "kind": "needs_access",
  "needs_from_user_id": "usr_…",
  "depends_on_task_id": null,
  "task_id": "tsk_…"
}
```

`kind` 取 `needs_decision | needs_access | needs_input | dependency | external | other`，默认 `other`。`needs_from_user_id` 必须是项目成员，此人和项目管理者都会收到通知。`depends_on_task_id` 必须是同项目中的其他任务。这些字段记录在 `blocker.reported` 事件的 `data` 中（`blocker_kind` 等）。

### 4.4 交接

`prepare_handoff` 的 `next_steps` 是有序列表（MCP 中必填，1–30 条）。指定了 `target_user_id` 的交接在待接手期间为此人保留任务：其他人直接认领会被拒绝（`task_not_claimable`），管理者需要收回时先取消交接。接收方应使用 `accept_handoff`；如果接收方或未指定对象的交接被直接认领，这条交接会被关闭（`handoff.cancelled`，`reason: claimed_directly`），不会一直处于待接手状态。服务端同时保存为 `next_step_items` 数组和带编号的 `next_steps` 文本。git 信息（仓库、分支、commit）由发送方 Connector 只读检查后上报，属客户端自证；未提交或未推送的代码会被拒绝。

### 4.5 决策

决策立即生效，人和 Agent 发布的效力相同。`created_by_kind` 标明发布者类型。修改决策要用 `supersedes_id` 发布新决策；对同一条决策的并发替代只有一个成功。

### 4.6 事件

Agent 工具返回精简事件：

```json
{
  "seq": 42,
  "kind": "task.rejected",
  "actor": { "user_id": "usr_…", "name": "张三", "kind": "human" },
  "subject_type": "task",
  "subject_id": "tsk_…",
  "summary": "退回任务「登录接口」",
  "data": { "note": "缺少错误密码的测试", "submission_id": "sub_…" },
  "created_at": "…"
}
```

`get_context` 按 48 KB 预算从旧到新截取，不跳过事件；`has_more` 为 true 时继续读。`wait_for_events` 在其他人或其他 Agent 产生事件时返回，自己的动作不会唤醒它；超时返回 `timed_out: true`，超时上限 55 秒。

### 4.7 AI 简报

项目启用了服务端 AI 辅助时，`get_task` 会带上 `ai_briefing`：`{note, up_to_date, generated_at, state, done, open_items, review_feedback, risks, next_actions}`。它是模型根据任务历史生成的摘要，未经人工确认；`up_to_date: false` 表示任务之后又有变化。Agent 应以任务本身的内容为准，简报只用来快速定位。

### 4.8 求助与人选建议

- `request_help(task_id, user_id, note)`：请一位成员协助，不改变任务状态和租约；对方会在 Hub 收到通知（事件 `task.help_requested`）。真正卡住、需要别人先行动时，改用 `publish_blocker`。每次求助都占用对方的注意力，要少用。
- `suggest_people(task_id, purpose)`：在项目启用 AI 辅助时，按 `assign`（谁来做）、`unblock`（谁能解除阻塞）或 `handoff`（交给谁）推荐最多 3 位成员，并附理由。建议仅供参考，候选人只会是项目中符合条件的真实成员。

### 4.9 错误

```json
{ "error": { "code": "lease_invalid", "message": "…", "hint": "You no longer hold this task … claim_task again only if it is free." } }
```

错误码见 `packages/contract/src/errors.ts`。Connector 自身还会返回 `project_not_bound`、`network`、`bad_response`（代理错误页等非 JSON 响应）和 `connector_outdated`。

## 5. 版本与兼容

- `/v1/agent/me` 返回 `protocol_version`、`min_connector_version` 与 `lease_minutes`。
- Connector 版本低于 `min_connector_version` 时，`get_context` 返回 `connector_outdated` 并提示升级。
- 服务端协议版本低于 2 时（旧服务端没有这个字段，按 1 处理），`get_context` 的 `warnings` 说明结构化字段不会被保存。
- 协议 1 的 Connector（0.1.x）仍可使用：服务端新增字段都有默认值，旧的 `next_steps` 文本和 `evidence` 文本照常接受。

## 6. 安全边界

- Agent 权限等于用户当前角色与凭证 scope 的交集，每次请求都重新判定；撤权会中断实时流。
- 返回他人文本的工具都带 `notice`。事件、决策、提交、交接都标注作者类型。
- Agent 不能验收、管理成员、上传二进制文件，也不能访问其他项目。
- 租约令牌只保存在本机 `~/.coagents/`，不会出现在任何工具的输出中。
- 链接类证据和成果只接受 http(s)。Hub 把所有他人文本当作纯文本渲染。

## 7. 验收标准

在两台机器上分别用 Claude Code 和 Codex，只给一句“按 CoAgents 协议完成任务 X”，不做额外引导，Agent 能完成：认领 → 带证据提交 → 被退回 → 读出退回原因 → 修改并重新提交 → 交接给另一个 Agent → 对方接手 → 人工接受。记录见 [acceptance](records/acceptance.md)。

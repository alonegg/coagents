# 架构草案

状态：拟议，非现有实现。

业务语义以 [PRD](PRD.md) 为准。本草案包含人工验收、Agent 文本成果等本版产品建议，尚未形成实现承诺。

## 组件

```text
各设备浏览器 ────────────────────────┐
成员 A：Agent ── 本机 Connector ─────┼── HTTPS ── 团队服务
成员 B：Agent ── 本机 Connector ─────┘              ├─ Hub / API / 实时事件
                                                  ├─ 用户、设备、项目授权
                                                  ├─ 任务、成果、交接、里程碑
                                                  └─ 数据库、文件、全文索引
```

第一版采用集中权威服务和分布客户端：浏览器直接通过 HTTPS 访问 Hub，Agent 经本机 stdio MCP Connector 访问同一服务。成员可以处于 LAN、VPN 或不同网络，部署提供可达且有可信证书的服务地址。业务服务统一裁决租约、权限和事件顺序；前端与 MCP 不各自维护权威副本。

首版可采用单个服务实例与服务主机本地 SQLite 文件，禁止客户端共享数据库文件或把它当多主同步机制。成果文件与索引也由服务管理。数据库选择需要以 PRD 容量目标压测确认；扩展服务实例需要另行设计一致性。单机开发模式是同一架构的配置，不是首版交付范围的缩减。

## 技术选型（2026-09-23 已决定）

| 部分 | 选型 | 说明 |
| --- | --- | --- |
| 语言与仓库 | TypeScript（strict），pnpm workspace monorepo | 服务、Hub、Connector 同一语言，共享契约包。 |
| 契约 | `packages/contract`，zod schema | API 与 MCP 的输入输出、错误码只在此定义一次，服务端与客户端共同引用。 |
| 服务端 | Node.js LTS + Hono，better-sqlite3（WAL） | 单实例；数据库、成果文件和索引放在服务数据目录。 |
| Hub | React + Vite，由服务端同源托管 | 同源部署以简化 cookie 会话和 CSRF 防护。 |
| Connector | 官方 MCP TypeScript SDK，stdio | 与 Hub 走同一服务 API。 |
| 测试 | Vitest；权限矩阵以数据表驱动生成 API 与 MCP 用例 | 另设泄露测试：无权身份检查列表、总数、片段、推送与下载。 |
| 部署 | 服务进程由 systemd 管理，前置 Caddy 提供 HTTPS | 主机与地址见 [部署环境](DEPLOYMENT.md)。 |

## 认证与设备授权（2026-09-23 已决定）

- 账户：用户名 + 密码（服务端以 argon2id 保存）。首次设置在服务主机本地用 CLI 创建实例维护账户，不开放 Web 首次设置入口。无邀请不能注册。
- 浏览器：登录后发放 HttpOnly、Secure、SameSite=Lax 的会话 cookie，会话绑定 browser 设备；写请求校验 CSRF token。
- Connector：设备码流程。Connector 请求设备码并显示给用户，用户在已登录的 Hub 中确认设备与项目 scope，Connector 取得绑定用户、设备、项目的 Agent 凭证，保存在本机凭证库（文件权限 0600）。服务端只保存凭证哈希。
- 恢复：实例维护者在服务主机上用 CLI 重置用户密码并撤销其全部会话；Owner 身份恢复同样经该 CLI，操作写入审计。首版不发邮件。

## 数据模型

| 实体 | 最小字段 | 约束 |
| --- | --- | --- |
| User | `id`, `username`, `display_name`, `timezone`, `auth_state`, `instance_role` | 实例维护与项目角色分开；项目权限由 Membership 决定；认证凭据单独安全存储。 |
| Project | `id`, `name`, `description`, `lifecycle`, `timezone`, `due_at?`, `created_at`, `updated_at` | 默认私有；active/archived；日期按项目时区解释。 |
| Membership | `project_id`, `user_id`, `role`, `status` | 角色为 Owner/Admin/Contributor/Viewer；每个项目恰有一个 Owner。 |
| Invitation | `id`, `project_id`, `target_identity?`, `role`, `token_hash`, `expires_at`, `accepted_at?`, `revoked_at?` | 有期限、一次性；接受时检查身份、状态与角色。 |
| Device | `id`, `user_id`, `kind`, `label`, `last_seen_at`, `revoked_at` | `kind` 为 browser/connector。浏览器首次登录即登记一台 browser 设备（标签取自 User-Agent，可改名），会话绑定该设备；Connector 经设备码授权登记。设备与人类身份、Agent 会话分开；用户可撤销自己的整台设备。 |
| DeviceProjectGrant | `device_id`, `project_id`, `revoked_at` | 项目管理员只能撤销本项目的设备授权。 |
| Client | `id`, `project_id`, `user_id`, `device_id`, `label`, `scopes`, `last_seen_at`, `revoked_at` | Agent 凭证只授予单项目和有限 scope。 |
| Task | `id`, `project_id`, `title`, `description`, `acceptance_criteria`, `assignee_id?`, `status`, `holder_kind?`, `holder_id?`, `holder_device_id?`, `lease_token_hash?`, `lease_until?`, `version`, `updated_at` | 负责人和执行者分开；`holder_kind` 为 user（Hub 中人类认领）或 client（Agent 连接），同时记录设备；五种看板状态；变更在事务内完成。 |
| TaskSubmission | `id`, `task_id`, `summary`, `artifact_version_ids`, `evidence`, `submitted_by`, `reviewed_by?`, `outcome`, `review_note?`, `created_at` | 接受与退回可追溯；引用具体成果版本，不随着当前版本变化。 |
| Artifact | `id`, `project_id`, `task_id?`, `title`, `summary`, `kind`, `status`, `visibility`, `current_version?`, `author_id`, `source_author?`, `source_at?`, `imported_by?`, `imported_at?` | 导入来源与系统操作者分开；已发布成果可同时存在新工作草稿；先检查项目成员关系。 |
| ArtifactVersion | `id`, `artifact_id`, `state`, `version?`, `revision`, `body?`, `file_id?`, `url?`, `created_by`, `created_at`, `published_at?` | `state` 为 draft/published。每个成果最多一个 draft 行，草稿编辑以 `revision` 做乐观并发；发布时在同一事务内分配下一个 `version` 号、改为 published 并更新 `Artifact.current_version`。已发布行不可修改。 |
| ArtifactGrant | `artifact_id`, `user_id` | 仅受限成果使用；Owner/Admin 保留管理访问。 |
| StoredFile | `id`, `project_id`, `storage_key`, `media_type`, `size`, `checksum` | 文件只通过授权下载接口访问；不把路径暴露给浏览器。 |
| Event | `seq`, `id`, `project_id`, `kind`, `actor_user_id`, `actor_client_id?`, `actor_device_id?`, `subject_type`, `subject_id`, `summary`, `created_at` | `seq` 单调递增；`id` 用于幂等去重；查询时按 `subject_type/subject_id` 关联对象权限，受限成果相关事件对无权者整体过滤，不先返回再隐藏。 |
| Decision | `id`, `project_id`, `event_seq`, `body`, `supersedes_id?` | `supersedes_id` 建唯一约束，并发替代同一决策只有一条成功，另一条返回冲突；当前有效版本为未被替代的决策。 |
| Cursor | `consumer_kind`, `consumer_id`, `project_id`, `last_seen_seq` | consumer 为 Agent 连接或浏览器设备；只在客户端确认接收后前移。 |
| AuditRecord | `id`, `project_id`, `actor_id`, `action`, `object_id`, `created_at` | 记录敏感变更的元数据，不记录凭证或成果正文。 |
| Milestone | `id`, `project_id`, `title`, `criteria`, `due_at`, `state`, `confirmed_by?`, `confirmed_at?`, `confirm_note?`, `version` | `state` 为 open/achieved；Owner/Admin 可带原因从 achieved 重开为 open；逾期由 `due_at` 与 open 状态计算，不单独存储。任务增加/移除有事件记录。 |
| Handoff | `id`, `task_id`, `from_holder`, `from_device_id`, `target_user_id?`, `repo_identity?`, `branch?`, `commit?`, `dirty_state?`, `artifact_versions`, `check_result?`, `checked_by_device_id?`, `state` | Git 检查结果由接收端 Connector 上报，服务端记录为客户端自证并记下上报设备，不宣称服务端验证过代码；校验通过后才确认代码任务接手；不自动传输未提交代码。 |
| Notification | `id`, `recipient_id`, `project_id`, `event_id`, `delivered_at?`, `read_at?` | 按接收者与事件去重，读取前重新授权。 |
| SearchDocument | `artifact_version_id`, `project_id`, `text`, `locations`, `index_state` | 默认最新发布版本；返回片段前按当前权限检查。 |

Task 增加可选 `milestone_id` 和 `due_at`；首版一任务最多属于一个里程碑。浏览器 Session 也绑定设备，撤销设备会话和 Connector 授权同样失效。授权材料只保存所需的安全表示，不进入日志或业务事件。

时间以 UTC 存储。任务租约使用服务端时钟，续租、释放、提交待验收都要求当前持有者和有效租约标识；过期判断与认领在同一事务内完成。完成改为 Owner/Admin 人工接受提交，Agent 不能完成验收。管理员可带原因终止租约。归档项目业务只读，恢复不复活被撤销的授权。客户端重试使用请求 ID 保证幂等。

Kanban 的 `status` 为 `todo / in_progress / blocked / review / done`。任务数量从授权范围内的任务实时计算或由受同样权限约束的投影生成；空任务集不计算百分比。活动流来自业务事件，在线心跳另存，不得计入任务完成率。成果正文和上传文件由本产品存储，区别于自动读取代码仓库文件。

## Connector 与项目绑定

每个客户端配置只写入一个 `coagents` MCP 条目。Connector 启动时从工作目录向上查找 `.coagents/project.json`（服务地址、项目 ID，不含凭证），再从用户目录的本机凭证库取出绑定该用户、设备和项目的 Agent 凭证。凭证仍是单项目、有限 scope；找不到绑定时工具返回未初始化错误，不回退到其他项目。

## 事件和上下文

实时通道可采用 SSE 或 WebSocket，必须在业务事务提交后从持久化事件发送，并能按最后确认游标补读。通知仅由去重后的业务事件生成。长连接在投递时检查当前权限；撤权主动关闭或重新授权，不能只在建连时校验。成员看到的在线、送达、读取状态分别记录，不能据送达判断 Agent 已工作。

读取事件时按 `seq` 分页，返回 `next_cursor` 与 `has_more`。在查询层过滤用户无权看到的对象；Hub、MCP、统计与附件下载复用授权服务。呈现给 Agent 时可以按阻塞、交接、决策、普通消息标注重要度，但不能改变游标顺序或在截断后提前确认未读事件。上下文预算采用明确的字节或 token 上限，超限时告知还有多少事件待取。

项目卡片所需的活动时间、任务数量与最近成果可以由查询聚合生成；只有性能实测需要时再增加缓存。若增加缓存，成员或成果权限变更必须同步失效，不能让旧摘要泄露内容。

## 断线、交接与索引

离线缓存是过期的已读快照；不能本地认领或授予新权限。重连先校验用户/设备/项目，再核对任务版本和租约；过期认领与续租不重放。结果不明的其他写入保留幂等标识，查询原结果后决定重试。

Git 检查由 Connector 在用户指定的目录执行固定的只读检查，核对仓库映射、commit 和工作区状态。交接接收仍需新的原子租约，检查与认领间发生竞争要明确失败。文件搬运与代码合并不由交接事件隐式触发。

全文提取覆盖 Markdown、纯文本和有文本层 PDF，异步任务显示索引状态。中文检索方案（2026-09-23 已决定）：应用侧把每段中日韩文字切成单字加相邻二元组，交给 FTS5 unicode61 分词；查询时每段文字转为其二元组短语，其余词按原样匹配，全部条件取交集。对比实验（`scripts/spikes/cjk-search.mjs`，6 篇中文文档、12 个查询）中 trigram 召回 7/12（一字、两字查询全部漏检），单字加二元组 12/12；该方案无原生依赖，片段从原文截取。索引保存原文与 PDF 分页偏移，`coagents-server reindex` 可从受管成果重建。查询阶段连接当前成果权限，随后生成片段和总数；不能先返回全文片段再在 UI 隐藏。删除/撤权立即过滤，即使旧索引稍后清理。历史索引需显式选版本，索引恢复可从受管成果重建。

## 安全与数据边界

- 首版团队部署经 HTTPS 网关或服务自身 TLS 提供可达地址；内部后端可监听 loopback。浏览器认证与 CSRF 防护、Connector 凭证和证书校验同时生效。Agent 凭证绑定用户、设备、项目和 scope，撤销传播到已有连接。
- 本地数据目录不自动采集原始对话或仓库文件内容。用户主动上传的成果文件按项目隔离存储；日志排除凭证和文件正文。Git 信息只在用户主动发起交接时读取所需的 branch 与 commit。
- 项目默认私有。服务端在读取、写入、搜索、统计和下载时检查成员身份、角色与成果可见性；无权对象不返回标题、数量或可猜测的存储路径。
- 来自其他会话的正文作为不可信数据传给 Agent，不给予指令优先级。所有客户端配置写入都经过用户选择和差异预览。
- 归档的第三方抓取物不成为运行时依赖、打包资源或生成代码的输入。

## 待验证项

在三账户、两台独立机器和两种客户端上测试并发、实时延迟、断线/重启、证书和邀请失效、设备撤销、Git 接手、跨时区日期与全文索引权限；按 PRD 规模压测。各客户端和操作系统支持情况以实测记录公布。

# 第一版验收记录

日期：2026-09-23。环境：测试实例 `https://coagents.chengdu80.org`（单台 4 核 / 3.8 GB 云主机，部署方式见 [自托管部署](../DEPLOYMENT.md)）；机器 A 为开发机（macOS arm64），机器 B 为 GitHub 托管 runner（Ubuntu 24.04，美国网络，每次运行都是全新机器）；账户 `alone`（Owner/实例维护）、`e2e-contrib`（Contributor）、`e2e-viewer`（Viewer）；客户端 Claude Code 2.1.280、Codex CLI 0.144.1。

自动测试：`pnpm test` 共 102 项（服务端单元与接口、Connector、真实 HTTP 服务上的集成测试，含真实 git 交接）。跨机脚本在 `scripts/e2e/`，由开发机与 `e2e-remote.yml` 工作流分别执行。

## 用例

| 用例 | 结果 | 证据 |
| --- | --- | --- |
| UC-01 首次设置、登录与创建项目 | 通过 | `session.test.ts`、`projects.test.ts`；`m1.mjs`；CLI 首次设置在实例已有用户时拒绝 |
| UC-02 我的项目与概览 | 通过 | `hub.test.ts`（卡片按查看者计算、名称字面匹配）；`m8.mjs`；浏览器截图核对 |
| UC-03 活动与筛选 | 通过 | `hub.test.ts`（跨项目、受限事件隐藏、分页）；`tasks.test.ts`（游标不漏读）；`m8.mjs` |
| UC-04 任务与 Kanban | 通过 | `tasks.test.ts`（五列状态机、版本冲突、Viewer 只读）；`m2.mjs` |
| UC-05 认领、续租与释放 | 通过 | `tasks.test.ts`；`m2.mjs`（两机 100 次并发，双持有者 0）；`m9-skew.mjs`（客户端时钟 ±2–3 小时） |
| UC-06 阻塞与替代决策 | 通过 | `tasks.test.ts`（并发替代仅一条成功、跨项目不泄露）；连接器集成测试（恶意决策正文作为不可信数据） |
| UC-07 导入已有成果 | 通过 | `artifacts.test.ts`（原作者/日期与导入人分开，未知显示为空）；`m5.mjs` |
| UC-08 创建、发布与更新成果 | 通过 | `artifacts.test.ts`（草稿私有、已发布版本数据库级不可改）；`m5.mjs`；Agent 经 MCP 创建发布 |
| UC-09 提交、验收与重开 | 通过 | `tasks.test.ts`；M3 实测退回、M5 实测接受且后续版本不改变绑定；Agent 无法验收 |
| UC-10 阅读、预览与下载 | 通过 | `artifacts.test.ts`（仅白名单内联预览、HTML 作为不透明下载）；浏览器实测 Markdown 注入被清除 |
| UC-11 受限成果与删除 | 通过 | `artifacts.test.ts`、`search.test.ts`；`m5.mjs`（跨机直链 404、列表与事件无痕迹） |
| UC-12 邀请、角色、移除与所有权 | 通过 | `projects.test.ts`；`m1.mjs` |
| UC-13 连接、检查与撤销 Agent | 通过 | `agents.test.ts`；[Claude Code 记录](claude-code.md)、[Codex 记录](codex.md)；`m9-clean.mjs`（全新机器卸载无残留） |
| UC-14 获取上下文与交接 | 通过 | 连接器集成测试；`handoff.integration.test.ts`；`m6.mjs` |
| UC-15 断线、重试与重启恢复 | 通过 | `m2.mjs`（中断首个请求后重试不重复）；`m4.mjs`（断流补读）；服务重启后流自动恢复（M4 记录） |
| UC-16 归档、恢复与删除 | 通过 | `hub.test.ts`；`m8.mjs` |
| UC-17 部署并从独立设备访问 | 部分通过 | 公网 HTTPS 跨网络路径通过（`m1.mjs` 等）；**LAN 路径未验证**，无可用局域网环境 |
| UC-18 实时同步、通知与补读 | 通过 | `stream.integration.test.ts`；`m4.mjs`（往返 p95 854 ms） |
| UC-19 跨设备检查代码并接手 | 通过 | `handoff.integration.test.ts`；`m6.mjs`（缺 commit 被拒且工作区不变，fetch 后接手） |
| UC-20 里程碑与截止日期 | 通过 | `milestones.test.ts`、`planning.test.ts`（含夏令时）；`m7.mjs`（跨时区同一时刻） |
| UC-21 全文检索 | 通过 | `search.test.ts`；`m7.mjs`（中文 PDF 第 2 页命中、撤权后总数 0） |
| UC-22 撤销单设备 | 通过 | `stream.integration.test.ts`；`m4.mjs`（旧流约 1 s 内关闭，另一设备正常） |

## 故障注入

| 故障 | 结果 |
| --- | --- |
| 断网 / 断流 | B 断流期间 20 次写入，重连按游标补读，与服务端列表逐条一致（M4） |
| 服务重启 | 流自动重连，重启后写入 1.45 s 内送达，会话保持（M4） |
| 时钟偏差 | runner 在 libfaketime `+3h`、`-2h` 下认领、续租、设截止、提交，均按服务端时钟（`m9-skew.mjs`） |
| 响应丢失 | 首个请求 5 ms 超时中断，同一 request_id 重试两次，只产生 1 个任务（M2） |
| 在线撤权 | 撤销设备、连接、成员后已有流立即收到 revoked 并关闭，下一请求 401/404（M4、`agents.test.ts`） |

## 容量（PRD 第 11 节）

规模：20 个项目 × 200 个任务、约 1.2 万条事件、10 位成员、20 台浏览器设备、50 个各自保持实时流并持续读写的 Agent 会话，持续 183 s（`scripts/load/capacity.mjs`）。

在服务主机本机经 Caddy 与 TLS 访问（往返约 4 ms，满足"稳定连接 RTT 不超过 100 ms"）：

| 操作 | 请求数 | 错误 | p50 ms | p95 ms |
| --- | --- | --- | --- | --- |
| Agent 读取 200 个任务 | 4415 | 0 | 11 | 56 |
| Agent 读取事件页 | 4415 | 0 | 7 | 49 |
| Hub 项目卡片（20 个摘要） | 1160 | 0 | 30 | 74 |
| Hub 看板 200 个任务 | 1160 | 0 | 13 | 62 |
| Hub 跨项目活动 | 1160 | 0 | 26 | 73 |
| Agent 认领 / 释放（写入） | 1365 / 1365 | 0 | 13 / 11 | 54 / 51 |

常规读取 p95 远低于 2 s 门槛。服务进程 CPU 峰值约 110%，内存约占 4.6%。登录 p50 1.1 s 来自 20 个设备同时做 argon2id 校验（有意的慢哈希，不属于列表读取门槛）。

同一负载从 runner（美国网络）发起时，健康检查基准往返中位数 842 ms，结果被跨洋链路主导（p95 2.6–9.1 s，偶发数分钟停顿），服务器负载平均仅 0.38，不代表服务端容量；从开发机发起时本机代理在并发连接下连接超时。二者都不满足 PRD 的网络前提，不作为结论。

## 发布检查

- 命名扫描（`scripts/release-scan.sh`，规则文件在仓库外）：仓库文件、构建产物与 source map、主机上部署目录均为 0 命中；服务进程无对外连接。
- 全新机器安装、运行、卸载：无残留（`m9-clean.mjs`）。
- 备份与恢复：演练通过，见 [部署环境](../DEPLOYMENT.md)。

## Agent 协作协议 v2（2026-09-24）

目标见 [Agent 协作协议](../AGENT_PROTOCOL.md) 第 7 节。环境：服务 schema v11，Connector `coagents@0.2.2`（从 npmjs.org 安装），Claude Code 2.1.281，Codex CLI 0.144.1（`-m gpt-5.5`）。同一台开发机上两个独立工作副本，各自登录为独立的 Agent 连接：Claude Code 代表 `e2e-contrib`，Codex 代表 `alone`。代码远端为本机 bare 仓库。脚本：`scripts/e2e/protocol.mjs`。任务为 slugify 小库，带 4 条验收清单。

给 Agent 的指令只有一句话，没有另外说明协议：

| 轮次 | 客户端 | 指令 | 结果 |
| --- | --- | --- | --- |
| 1 | Claude Code | 按 CoAgents 协议完成任务 X | get_context → ack → claim → get_task → 编码、提交、推送 → submit_task，c1–c4 各有证据（test/commit + 结果） |
| — | 人 | 退回：①全角空格与 emoji 没有测试 ②`slugify(null)` 返回 `'null'` | — |
| 2 | Claude Code | 继续任务 X；时间有限，只处理退回意见第 1 条，剩下的交给 alone | get_task 读出退回原因 → 补测试、推送 → prepare_handoff：目标用户从 members 中取得，下一步写成 4 条列表，包含第 2 条修法 |
| 3 | Codex（默认沙箱） | 按 CoAgents 协议继续交接给你的工作 | accept_handoff 被拒（缺 commit，提示 fetch）→ 沙箱中 `.git` 只读，fetch 失败 → **没有绕过交接**，给出确切的 `git fetch` 命令请用户执行 |
| 4 | Codex（续会话，完全访问） | 我已经 fetch，请继续 | accept_handoff 成功 → 修实现、补测试和 README → 提交推送 → submit_task，c1–c4 各有证据 |
| — | 人 | 独立 clone 复核（7/7 通过，`slugify(null) === ''`）后接受 | 任务完成 |

事件序列：`task.created → claimed(agent) → submitted(agent) → rejected(human) → claimed(agent) → handoff.prepared(agent) → claimed(agent) → handoff.accepted(agent) → submitted(agent) → accepted(human)`。每条事件都标注了执行者是人还是 Agent。

实测中发现并修复的问题（第一次运行）：

1. **同一台电脑、同一项目的两个工作副本共用一个凭证。** 第二次 `coagents login` 静默覆盖了第一次（而且是另一个用户），两个 Agent 实际成了同一个执行者。0.2.1 改为每个工作副本一个 Agent 连接。
2. **工具标注 `openWorldHint: true` 导致 Codex 在 `codex exec` 中取消所有写入**（"user cancelled MCP tool call"）。0.2.2 统一改为 false；CoAgents 只作用于团队自己的服务，这个值本来就应该是 false。
3. **待接手的交接可以被直接认领绕过**。Codex 因沙箱无法 fetch，改用 claim_task 直接认领，交接一直停在待接手状态。现在指定了目标的交接为目标人保留任务；由目标人或未指定目标时直接认领，会关闭这条交接。协议文本也写明：检查失败又无法自行修复时，请用户执行命令。

另外两处观察：第一次运行时，我写的退回意见第 2 条有误（README 其实已经有中文示例）；Codex 核实后如实指出，而 Claude Code 没有核实就把这一条列进了交接步骤。协议第 2 条因此加上了“核实退回原因”。Codex 默认沙箱中 `.git` 只读，所以 fetch、commit、push 都需要用户执行，或者给 Codex 放开沙箱；这属于客户端设置，不是协议问题。

未覆盖：两个真实客户端都在同一台机器上运行，跨机器的代码交接以 M6（runner 上的 Connector）的结果为准。

## 服务端 AI 辅助（2026-09-24）

模型接入：火山方舟 Coding Plan（OpenAI 兼容接口，模型名 `ark-code-latest`，响应中显示为 `auto`），strict json_schema 输出。

- 本地实例用真实模型跑完整流程：
  - 提交预审把证据薄弱的 c1 判为“证据薄弱”，没有证据的 c2 判为“无证据”，证据里写着“文档稍后补”的 c3 判为“与证据矛盾”，并起草了退回说明。
  - 任务简报列出了未处理的退回意见，并指出 401 的 code/message 在数据中没有给出。
  - 动态摘要正确区分了人和 Agent。
  - 单次调用约 1–1.6k 输入 tokens，耗时 11–29 秒（后台执行）。
- 测试实例 `/admin/ai/test` 连接正常（2.7 秒）。启用后在 Agent 协议 v2 验收项目上生成的预审、简报和摘要都与实际经过一致。
- 自动化测试（`tests/ai.integration.test.ts`，使用假模型服务）覆盖了以下几点：
  - API Key 只写不读，只有维护者能配置。
  - 提交后自动预审。
  - 成员文字里的 `</data>` 被转义，无法提前闭合数据块。
  - 受限成果标题不会出现在任何发给模型的输入中。
  - 模型输出不合法时标为失败，下次请求重试。
  - 超过每日上限时跳过，不调用模型。
  - Viewer 能查看结果，但不能发起生成。
  - 按项目关闭后立即不可用。
  - Agent 通过 `get_task` 能读到标注为“未经确认”的简报。

第二批（验收清单起草、推荐人选、求助）用真实模型测试：
- 本地模拟一个 4 人团队：王经理（Owner），以及李（后端）、张（前端）、赵（测试），各自有已验收的任务。
  - “密码重置接口”推荐了李，理由引用了他已验收的登录、注册接口，并说明为什么不推荐其他人。
  - 头像上传被阻塞的任务推荐了李（实现上传接口）和王经理（确认存储方案）。
  - 清单草稿把项目决策（统一错误格式、审计日志）落实成了可核对的条目，还指出了账号枚举和令牌重放两个风险。
- 测试实例上，新任务“slugify 支持自定义分隔符”生成的 8 条清单包含向后兼容这一条。推荐了实际完成过 slugify 的一方，没有推荐提交曾被退回的一方。
- 自动化测试覆盖以下几点：
  - 模型编造的成员 id 会被丢弃，候选人姓名取自数据库。
  - 推荐执行者时不会列出 Viewer。
  - 推荐接手人时不会推荐请求者本人。
  - 不能向自己或项目外的人求助。
  - 求助通知会送达对方。
  - Agent 可以通过 MCP 调用 `suggest_people` 和 `request_help`。

注意：Coding Plan 定位是编码工具订阅，用作产品后台是否符合其条款需要确认；正式使用可以在后台改成普通方舟推理接入点。

## 人与 Agent 的边界（2026-09-24）

- 自动化测试（`tests/boundary.integration.test.ts`）覆盖了以下几点：
  - 暂停：Contributor 无权暂停整个项目；暂停后 Agent 的写入返回 `agents_paused` 和提示，读取正常，`get_context` 显示暂停状态；暂停单个连接不影响同一个人的另一个连接。
  - Agent 调用验收接口时被拒绝，提示“Only a person”。
  - 打扰上限设为 2 时，第 3 次求助返回 `attention_budget_exceeded`；随后点名同一人的阻塞仍然生效，但通知被静音，不计入未读。人与人之间的求助不受上限限制。
  - “我的 Agent”列出持有任务、最近动作和打扰次数。
  - 协作指标按人和 Agent 分开统计通过率和一次通过率。
- 真实客户端：在测试实例上暂停项目后，让 Claude Code（`coagents@0.2.5`）“按 CoAgents 协议完成任务”。它只调用了 get_context 和 get_task，一次写操作都没尝试，也没改本地代码；向用户说明项目已暂停，恢复后再从认领开始。
- 本地实例带数据从 schema v13 升级到 v14 正常；Hub 中的暂停开关、提示条、边界清单、协作指标面板显示正常。

## 未通过或待决定

1. **LAN 路径未验证**（PRD 第 13 节要求 LAN 与一种跨网络路径）。方案已定（真实子域名指向内网 IP，DNS-01 签发证书，见 PRD OD-04），还需要两台内网机器实测。按 PRD 这是发布阻断项。
2. OD-03 的文件上限与预览白名单为暂定值，待确认；删除保留期未定。
3. 两种客户端都在开发机上实测；机器 B 以 Connector CLI 作为客户端，没有安装第二个编码客户端。
4. 主机位于中国大陆，域名未备案；目前 80/443 未被拦截，需持续观察。

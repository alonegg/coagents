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

## 未通过或待决定

1. **LAN 路径未验证**（PRD 第 13 节要求 LAN 与一种跨网络路径）。需要可用的局域网环境，或由产品决定首版只以公网 HTTPS 交付。按 PRD 这是发布阻断项。
2. OD-03 的文件上限与预览白名单为暂定值，待确认；删除保留期未定。
3. 两种客户端都在开发机上实测；机器 B 以 Connector CLI 作为客户端，没有安装第二个编码客户端。
4. 主机位于中国大陆，域名未备案；目前 80/443 未被拦截，需持续观察。

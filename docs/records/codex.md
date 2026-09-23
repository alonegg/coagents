# 集成记录：Codex CLI

按 [客户端集成](../INTEGRATIONS.md) 的验收记录模板填写。未列出的项保持"待验证"。

| 项 | 结果 |
| --- | --- |
| 客户端版本 | codex-cli 0.144.1，模型 `gpt-5.5`（测试时以 `-m` 指定；用户默认模型在 ChatGPT 账号下不可用，未改动其配置） |
| 操作系统 / 设备 | macOS（Darwin 25.6.0，arm64），开发机 |
| 服务地址类型 | 公网 HTTPS，`https://coagents.chengdu80.org` |
| 配置位置 | `~/.codex/config.toml`（或 `$CODEX_HOME/config.toml`）中带标记注释的 `[mcp_servers.coagents]` 表。该版本不读取项目内 `.codex/config.toml`；实测 Codex 以会话目录作为 stdio 服务的工作目录，因此一个全局条目按目录下的 `.coagents/project.json` 区分项目 |
| 安装前后差异 | 仅在文件末尾追加一个带标记的表，其余内容逐字不变；安装前展示差异 |
| 真实工具调用 | 2026-09-23：`codex exec -m gpt-5.5` 中调用 get_context、claim_task、prepare_handoff；交接记录由 Connector 只读读取分支与 commit |
| Git 交接 | Codex 在开发机准备定向交接（分支 `handoff-trial/…` @ 2036617）；GitHub runner 上的 Connector 首次接手因缺少 commit 被拒并说明需 fetch 的分支，工作副本未变；fetch 后接手成功并提交待验收（`scripts/e2e/m6.mjs`） |
| 撤销与卸载 | `coagents uninstall codex`：运行期间 Codex 自己向配置追加了项目信任条目，卸载按设计只移除 coagents 表并保留这些改动；首次实测发现卸载会残留一个分隔空行，已修复并加回归测试。测试结束后用安装前备份还原，SHA-256 与安装前一致（3492a577…）；服务端凭证已撤销 |
| 实时收取与重连 | 与 Claude Code 共用 Connector，见 [Claude Code 记录](claude-code.md) |

建议在项目的 `.gitignore` 中加入 `.coagents/`；Connector 的工作区干净检查已排除该目录。

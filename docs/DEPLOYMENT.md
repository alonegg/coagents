# 部署环境

状态：已部署（2026-09-23 起）。本文件是主机、地址、登录方式的唯一记录处，其他文档只引用这里。

| 项 | 值 |
| --- | --- |
| 主机 | <server-ip>，<云主机>；Ubuntu 24.04.3，x86_64，4 核，3.8G 内存，40G 磁盘 |
| 登录 | `root`，密钥为开发机 `~/<ssh-key>.pem` |
| 服务地址 | `https://coagents.chengdu80.org`（Route 53 托管区 chengdu80.org，A 记录指向主机） |
| 开放端口 | 云安全组只放行 22、80、443；8443/9443 实测外部不可达 |
| 跨网络路径 | 公网 HTTPS |
| LAN 路径 | 待定 |
| 保留的云厂商代理 | proxima、assist-client、cloud-monitor-agent（勿删） |

| 服务布局 | 代码 `/opt/coagents/current`（指向 `releases/<时间>-<commit>`，保留 5 个）；数据 `/var/lib/coagents`；配置 `/etc/coagents/coagents.env`；Node 固定在 `/opt/coagents/node` |
| 进程 | systemd `coagents`（服务用户 coagents，监听 127.0.0.1:8787）；`caddy` 终止 HTTPS（Let's Encrypt，HTTP-01 自动续期） |

## 常用命令

```bash
ssh -i ~/<ssh-key>.pem root@<server-ip>
deploy/deploy.sh                                        # 开发机上构建并滚动发布当前工作树（保留 5 个版本）
bash deploy/bootstrap-host.sh coagents.chengdu80.org    # 新主机一次性初始化，在主机上以 root 运行
journalctl -u coagents -f                               # 服务日志
```

## 账户与身份恢复

实例维护账户为 `alone`；密码与验收账户密码只保存在开发机 `~/.coagents-secrets/accounts.env`（0600），不进仓库。以下命令在主机上以 root 运行，密码从标准输入读取，不出现在命令行或历史记录中。

```bash
printf '%s' "$PW" | coagents-admin setup --username <用户> --display-name <显示名> --timezone Asia/Shanghai   # 仅首次，实例已有用户时拒绝
printf '%s' "$PW" | coagents-admin reset-password --username <用户>   # 重置密码并撤销其全部会话 # [待验证]
# 日常的注册审批、停用、临时密码与维护者任命在 Hub 的"后台"完成（实例维护者可见）。
coagents-admin disable-user --username <用户>                          # 停用账户，撤销会话与 Agent 连接
coagents-admin reindex                                                 # 从受管成果重建全文索引
```

Owner 忘记密码时，由实例维护者用 `reset-password` 恢复；项目所有权不受影响。

## 备份与恢复

数据全部在 `/var/lib/coagents`（SQLite 数据库与 `files/` 下的成果文件）。2026-09-23 演练：停服 672 ms 完成打包；备份恢复到临时目录后以独立实例启动，健康检查正常，项目、任务、事件、成果版本、文件、用户、Agent 连接计数与线上逐项一致，文件 SHA-256 一致，重建索引 8/8 就绪。

```bash
systemctl stop coagents && tar -C /var/lib -czf /var/backups/coagents/coagents-backup-$(date +%Y%m%d%H%M%S).tgz coagents && systemctl start coagents
# 原地恢复：
systemctl stop coagents && mv /var/lib/coagents /var/lib/coagents.before-restore && tar -C /var/lib -xzf /var/backups/coagents/coagents-backup-<时间>.tgz && chown -R coagents:coagents /var/lib/coagents && systemctl start coagents   # [待验证]
```

备份放在 `/var/backups/coagents`（root:coagents 0750，文件 0640），后台"运行状态"显示最近一次备份时间。备份包含凭证哈希与全部成果，按敏感数据保管。

## 验收数据

实例上保留验收产生的测试数据：账户 `e2e-contrib`、`e2e-viewer`（活跃）与 18 个 `load-*` 压测账户（已停用）；名称以 M1–M8 开头的项目为各里程碑验收项目，容量测试项目已软删除。正式使用前可按需归档或删除这些项目。

## 发布 Connector（npm 包 `coagents`）

版本号只改 `packages/connector/package.json` 与 `packages/connector/src/server.ts` 中的 `CONNECTOR_VERSION`（有测试保证二者一致）。发布目录是打包生成的 `packages/connector/.pkg`，仓库里的工作区包标为 private，不能直接发布。

```bash
pnpm test && pnpm -F coagents bundle
scripts/release-scan.sh ~/.coagents-secrets/hygiene-patterns.txt packages/connector/.pkg
cd packages/connector/.pkg && npm publish --access public --registry=https://registry.npmjs.org
```

全新机器安装验证：`e2e-remote.yml` 以 `milestone=npm-clean` 运行，从 tarball 全局安装后完成登录、两种客户端配置、真实调用、卸载与 `npm uninstall -g`，检查无残留。

## 已知风险

- 主机位于中国大陆。未备案域名在 80/443 上可能被云厂商拦截；2026-09-23 用 Host 头实测 HTTP 未被拦截，需在部署 HTTPS 后持续观察。

## 变更记录

- 2026-09-23：按用户要求清理原有服务。删除 <旧服务> 全部容器、数据卷、镜像与 `/opt/<旧服务>`，卸载宿主机 redis-server。删除前的完整备份在开发机 `每日项目观察/server-backups/<server-ip>-<旧服务>-20260923/`（`pg_dumpall.sql.gz` 为一致的逻辑备份；`volumes.tgz` 是在线打包，Postgres 部分不保证一致）。

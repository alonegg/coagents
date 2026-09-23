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
deploy/deploy.sh                                   # 从开发机构建并滚动发布当前工作树
bash deploy/bootstrap-host.sh coagents.chengdu80.org   # 新主机一次性初始化，在主机上以 root 运行
printf '%s' "$PW" | coagents-admin reset-password --username <用户>   # 主机上重置密码并撤销其全部会话 # [待验证]
journalctl -u coagents -f                          # 服务日志
```

实例维护账户为 `alone`；账户密码与验收账户密码只保存在开发机 `~/.coagents-secrets/accounts.env`（0600），不进仓库。

## 已知风险

- 主机位于中国大陆。未备案域名在 80/443 上可能被云厂商拦截；2026-09-23 用 Host 头实测 HTTP 未被拦截，需在部署 HTTPS 后持续观察。

## 变更记录

- 2026-09-23：按用户要求清理原有服务。删除 <旧服务> 全部容器、数据卷、镜像与 `/opt/<旧服务>`，卸载宿主机 redis-server。删除前的完整备份在开发机 `每日项目观察/server-backups/<server-ip>-<旧服务>-20260923/`（`pg_dumpall.sql.gz` 为一致的逻辑备份；`volumes.tgz` 是在线打包，Postgres 部分不保证一致）。

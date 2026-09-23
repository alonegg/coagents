# 部署环境

状态：主机已接入，CoAgents 尚未部署。本文件是主机、地址、登录方式的唯一记录处，其他文档只引用这里。

| 项 | 值 |
| --- | --- |
| 主机 | <server-ip>，<云主机>；Ubuntu 24.04.3，x86_64，4 核，3.8G 内存，40G 磁盘 |
| 登录 | `root`，密钥为开发机 `~/<ssh-key>.pem` |
| 服务地址 | `https://coagents.chengdu80.org`（Route 53 托管区 chengdu80.org，A 记录指向主机） |
| 开放端口 | 云安全组只放行 22、80、443；8443/9443 实测外部不可达 |
| 跨网络路径 | 公网 HTTPS |
| LAN 路径 | 待定 |
| 保留的云厂商代理 | proxima、assist-client、cloud-monitor-agent（勿删） |

```bash
ssh -i ~/<ssh-key>.pem root@<server-ip>
```

## 已知风险

- 主机位于中国大陆。未备案域名在 80/443 上可能被云厂商拦截；2026-09-23 用 Host 头实测 HTTP 未被拦截，需在部署 HTTPS 后持续观察。

## 变更记录

- 2026-09-23：按用户要求清理原有服务。删除 <旧服务> 全部容器、数据卷、镜像与 `/opt/<旧服务>`，卸载宿主机 redis-server。删除前的完整备份在开发机 `每日项目观察/server-backups/<server-ip>-<旧服务>-20260923/`（`pg_dumpall.sql.gz` 为一致的逻辑备份；`volumes.tgz` 是在线打包，Postgres 部分不保证一致）。

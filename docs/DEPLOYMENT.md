# 自托管部署

适用于一台可以从公网或局域网访问的 Linux 主机（已在 Ubuntu 24.04 x86_64 上实测）。本文件只写通用步骤；具体实例的主机、账号和运维记录应保存在仓库之外。

## 架构

- `coagents` 服务：Node.js 22，systemd 管理，以专用用户 `coagents` 运行，只监听 `127.0.0.1:8787`。
- Caddy：终止 HTTPS（Let's Encrypt，HTTP-01 自动签发与续期），反向代理到服务；实时流路径不压缩不缓冲。
- 数据：`/var/lib/coagents`（SQLite 数据库与 `files/` 下的成果文件）；配置：`/etc/coagents/coagents.env`；代码：`/opt/coagents/current` 指向 `releases/<时间>-<commit>`（保留 5 个）。

需要一个解析到主机的域名，并开放 80、443 端口。

## 首次部署

```bash
# 1. 在开发机上配置目标主机（此文件不进仓库）
cat > deploy/deploy.env <<ENV
DEPLOY_HOST=root@<主机>
DEPLOY_KEY=<ssh 私钥路径>
ENV

# 2. 在主机上以 root 初始化（安装 Caddy、固定版本的 Node、服务用户与目录）
scp deploy/bootstrap-host.sh root@<主机>:/root/ && ssh root@<主机> bash /root/bootstrap-host.sh <域名>

# 3. 在开发机上构建并发布（每次更新都用这一步）
deploy/deploy.sh

# 4. 在主机上创建第一个实例维护账户（密码从标准输入读取）
printf '%s' "$PW" | coagents-admin setup --username <用户> --display-name <显示名> --timezone Asia/Shanghai
```

`bootstrap-host.sh` 默认从 npmmirror 下载 Node，可用 `NODE_MIRROR` 改为官方地址；`deploy.sh` 在主机上安装依赖时默认也使用 npmmirror，可用 `NPM_REGISTRY` 覆盖。

## 账户与身份恢复

日常的注册审批、停用、临时密码与维护者任命在 Hub 的"后台"完成。以下命令在主机上以 root 运行：

```bash
printf '%s' "$PW" | coagents-admin reset-password --username <用户>   # 重置密码并撤销其全部会话 # [待验证]
coagents-admin disable-user --username <用户>                          # 停用账户，撤销会话与 Agent 连接
coagents-admin reindex                                                 # 从受管成果重建全文索引
journalctl -u coagents -f                                              # 服务日志
```

## 备份与恢复

```bash
systemctl stop coagents && tar -C /var/lib -czf /var/backups/coagents/coagents-backup-$(date +%Y%m%d%H%M%S).tgz coagents && systemctl start coagents
# 原地恢复：
systemctl stop coagents && mv /var/lib/coagents /var/lib/coagents.before-restore && tar -C /var/lib -xzf /var/backups/coagents/coagents-backup-<时间>.tgz && chown -R coagents:coagents /var/lib/coagents && systemctl start coagents   # [待验证]
```

备份目录 `/var/backups/coagents`（root:coagents 0750）；后台"运行状态"显示最近一次备份时间。备份包含凭证哈希与全部成果，按敏感数据保管。演练记录见 [验收记录](records/acceptance.md)。

## 发布 Connector（npm 包 `coagents`）

版本号只改 `packages/connector/package.json` 与 `packages/connector/src/server.ts` 中的 `CONNECTOR_VERSION`（有测试保证二者一致）。发布目录是打包生成的 `packages/connector/.pkg`；仓库里的工作区包标为 private，不能直接发布。发布令牌须为 granular token，对全部包可读写并允许绕过双重验证（仅限指定包的令牌无法创建新包）。

```bash
pnpm test && pnpm -F coagents bundle
scripts/release-scan.sh <禁用标识规则文件> packages/connector/.pkg
cd packages/connector/.pkg && npm publish --access public --registry=https://registry.npmjs.org
```

## 已知注意事项

- 主机位于中国大陆时，未备案域名在 80/443 上可能被云厂商拦截。
- 验收脚本（`scripts/e2e/`、`.github/workflows/e2e-remote.yml`）需要一个运行中的实例与仓库 secrets，只由维护者手动触发。

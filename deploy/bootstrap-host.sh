#!/usr/bin/env bash
# One-time host preparation. Run as root on the deploy host: bash bootstrap-host.sh <domain>
set -euo pipefail

DOMAIN=${1:?domain}
NODE_VERSION=${NODE_VERSION:-22.22.3}
NODE_MIRROR=${NODE_MIRROR:-https://registry.npmmirror.com/-/binary/node}

apt-get update -q
DEBIAN_FRONTEND=noninteractive apt-get install -y -q build-essential python3 rsync caddy sqlite3

id coagents >/dev/null 2>&1 || useradd --system --home /var/lib/coagents --shell /usr/sbin/nologin coagents
install -d -o coagents -g coagents -m 0700 /var/lib/coagents
install -d -m 0755 /opt/coagents /opt/coagents/releases /etc/coagents

# Pinned Node.js for the service, independent of any system node.
if [[ "$(/opt/coagents/node/bin/node -v 2>/dev/null)" != "v${NODE_VERSION}" ]]; then
  tmp=$(mktemp -d)
  curl -fsSL "${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o "$tmp/node.tar.xz"
  rm -rf /opt/coagents/node && mkdir -p /opt/coagents/node
  tar -xJf "$tmp/node.tar.xz" -C /opt/coagents/node --strip-components=1
  rm -rf "$tmp"
fi
/opt/coagents/node/bin/corepack enable --install-directory /opt/coagents/node/bin pnpm

if [[ ! -f /etc/coagents/coagents.env ]]; then
  cat > /etc/coagents/coagents.env <<ENV
COAGENTS_DATA_DIR=/var/lib/coagents
COAGENTS_PUBLIC_URL=https://${DOMAIN}
COAGENTS_HOST=127.0.0.1
COAGENTS_PORT=8787
COAGENTS_HUB_DIR=/opt/coagents/current/apps/hub/dist
ENV
  chmod 0644 /etc/coagents/coagents.env
fi

install -d -m 0755 /etc/systemd/system/caddy.service.d
cat > /etc/systemd/system/caddy.service.d/coagents.conf <<ENV
[Service]
Environment=COAGENTS_DOMAIN=${DOMAIN}
ENV
install -d -o caddy -g caddy /var/log/caddy
systemctl daemon-reload
echo "bootstrap done"

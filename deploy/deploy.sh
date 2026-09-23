#!/usr/bin/env bash
# Build and roll out the current working tree to the deploy host (see docs/DEPLOYMENT.md).
# Usage: deploy/deploy.sh   (env: DEPLOY_HOST, DEPLOY_KEY, NPM_REGISTRY)
set -euo pipefail

HOST=${DEPLOY_HOST:-root@<server-ip>}
KEY=${DEPLOY_KEY:-$HOME/<ssh-key>.pem}
REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RELEASE=$(date -u +%Y%m%d%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes "$HOST")

echo "==> release $RELEASE"
rsync -az --delete -e "ssh -i $KEY -o IdentitiesOnly=yes" \
  --exclude node_modules --exclude dist --exclude '*.tsbuildinfo' --exclude .git --exclude .statamcp --exclude .coagents-data \
  "$ROOT/" "$HOST:/opt/coagents/releases/$RELEASE/"

"${SSH[@]}" bash -s -- "$RELEASE" "$REGISTRY" <<'REMOTE'
set -euo pipefail
RELEASE=$1; REGISTRY=$2
export PATH=/opt/coagents/node/bin:$PATH
cd "/opt/coagents/releases/$RELEASE"
pnpm install --frozen-lockfile --registry="$REGISTRY" --reporter=append-only | tail -3
VITE_COAGENTS_BUILD="$RELEASE" pnpm build | tail -2
echo "$RELEASE" > apps/hub/dist/build.txt
install -m 0644 deploy/coagents.service /etc/systemd/system/coagents.service
COAGENTS_DOMAIN=x caddy validate --config deploy/Caddyfile --adapter caddyfile >/dev/null
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
install -m 0755 deploy/coagents-admin /usr/local/bin/coagents-admin
ln -sfn "/opt/coagents/releases/$RELEASE" /opt/coagents/current.new && mv -Tf /opt/coagents/current.new /opt/coagents/current
systemctl daemon-reload
systemctl enable --now coagents >/dev/null 2>&1
systemctl restart coagents
systemctl enable --now caddy >/dev/null 2>&1
systemctl reload caddy || systemctl restart caddy
# Keep the five newest releases.
ls -1dt /opt/coagents/releases/* | tail -n +6 | xargs -r rm -rf
for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8787/v1/health && echo && exit 0
  sleep 0.5
done
echo "service did not become healthy" >&2
journalctl -u coagents -n 30 --no-pager >&2
exit 1
REMOTE
echo "==> deployed $RELEASE"

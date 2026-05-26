#!/usr/bin/env bash
# Deploy buffettindicators to the VPS: sync the repo into /srv, install
# production deps, and restart the systemd service. Run from the repo root.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="/srv/buffettindicators"
SERVICE="buffettindicators.service"
HEALTH_URL="http://127.0.0.1:3002/"

cd "$SRC_DIR"

echo "==> sync to $DEST_DIR"
# Exclude local-only and generated files; never overwrite the live cache dir.
rsync -a --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '*.pem' \
  --exclude 'data/' \
  --exclude '*.db' --exclude '*.db-shm' --exclude '*.db-wal' \
  "$SRC_DIR"/ "$DEST_DIR"/

echo "==> install production deps"
( cd "$DEST_DIR" && npm ci --omit=dev )

echo "==> restart $SERVICE"
sudo systemctl restart "$SERVICE"

sleep 1
sudo systemctl is-active "$SERVICE" >/dev/null && echo "==> active"

if curl -fsS -o /dev/null -w '%{http_code}\n' "$HEALTH_URL" | grep -q '^200$'; then
  echo "==> $HEALTH_URL 200 OK"
else
  echo "==> warning: health check did not return 200" >&2
fi

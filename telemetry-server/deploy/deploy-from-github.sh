#!/usr/bin/env bash
set -euo pipefail

REPO=/home/ubuntu/ws/SerialTerminal
APP="$REPO/telemetry-server"
NODE=/home/ubuntu/ws/SerialTerminalTelemetry/runtime/bin/node
NPM=/home/ubuntu/ws/SerialTerminalTelemetry/runtime/bin/npm
ENV_FILE=/etc/serialterminal-telemetry.env
export PATH="/home/ubuntu/ws/SerialTerminalTelemetry/runtime/bin:$PATH"

if [[ "$(id -u)" -eq 0 ]]; then
  echo 'Run this script as ubuntu; it uses sudo only for privileged deployment steps.' >&2
  exit 1
fi

cd "$REPO"
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git fetch origin main
git pull --ff-only origin main
test -z "$(git status --porcelain)"

cd "$APP"
"$NPM" ci --omit=dev --ignore-scripts
"$NODE" --check src/server.js
"$NODE" --check src/store.js
"$NPM" test

DATABASE_URL="$(sudo sed -n 's/^DATABASE_URL=//p' "$ENV_FILE")"
test -n "$DATABASE_URL"
sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/001-init.sql
sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/002-update-source.sql

sudo cp deploy/serialterminal-telemetry.service /etc/systemd/system/serialterminal-telemetry.service
sudo cp deploy/serialterminal-telemetry-prune.service /etc/systemd/system/serialterminal-telemetry-prune.service
sudo cp deploy/serialterminal-telemetry-prune.timer /etc/systemd/system/serialterminal-telemetry-prune.timer
sudo cp deploy/serialterminal-telemetry-nginx.conf /etc/nginx/snippets/serialterminal-telemetry.conf
sudo cp deploy/serialterminal-telemetry-nginx-zones.conf /etc/nginx/conf.d/serialterminal-telemetry-zones.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl restart serialterminal-telemetry
sudo systemctl reload nginx
sleep 2
sudo systemctl is-active --quiet serialterminal-telemetry
curl --fail --silent --show-error http://127.0.0.1:3100/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3100/serialterminal/api/v1/update-source >/dev/null

printf 'Deployed SerialTerminal telemetry at %s\n' "$(git -C "$REPO" rev-parse --short HEAD)"

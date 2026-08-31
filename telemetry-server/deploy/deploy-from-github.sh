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
sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/003-update-policies.sql
UPDATE_METADATA_HOSTS="$(sudo sed -n 's/^UPDATE_METADATA_HOSTS=//p' "$ENV_FILE")"
UPDATE_METADATA_URLS_TEXT="$(sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT DISTINCT metadata_url FROM update_policies WHERE enabled ORDER BY metadata_url")"
UPDATE_METADATA_URLS=()
if [[ -n "$UPDATE_METADATA_URLS_TEXT" ]]; then
  mapfile -t UPDATE_METADATA_URLS <<< "$UPDATE_METADATA_URLS_TEXT"
fi
UPDATE_METADATA_HOSTS="$UPDATE_METADATA_HOSTS" "$NODE" scripts/validate-update-policy-hosts.js "${UPDATE_METADATA_URLS[@]}"
MODERN_SMOKE_POLICY="$(sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -AtF $'\t' -c \
  "SELECT COALESCE(min_client_version, max_client_version, '0.0.0'), COALESCE(channel, 'stable') FROM update_policies WHERE enabled AND NOT legacy ORDER BY priority DESC, id LIMIT 1")"
LEGACY_SMOKE_POLICY="$(sudo -u postgres psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT 1 FROM update_policies WHERE enabled AND legacy LIMIT 1")"

sudo cp deploy/serialterminal-telemetry.service /etc/systemd/system/serialterminal-telemetry.service
sudo cp deploy/serialterminal-telemetry-prune.service /etc/systemd/system/serialterminal-telemetry-prune.service
sudo cp deploy/serialterminal-telemetry-prune.timer /etc/systemd/system/serialterminal-telemetry-prune.timer
sudo cp deploy/serialterminal-telemetry-nginx.conf /etc/nginx/snippets/serialterminal-telemetry.conf
sudo cp deploy/serialterminal-telemetry-nginx-zones.conf /etc/nginx/conf.d/serialterminal-telemetry-zones.conf
# Keep old site includes valid while removing their obsolete duplicate location.
sudo install -m 0644 /dev/null /etc/nginx/snippets/serialterminal-update-compat.conf
sudo install -m 0644 /dev/null /etc/nginx/snippets/serialterminal-update-compat-nginx.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl restart serialterminal-telemetry
sudo systemctl reload nginx
sleep 2
sudo systemctl is-active --quiet serialterminal-telemetry
curl --fail --silent --show-error http://127.0.0.1:3100/healthz >/dev/null
curl --fail --silent --show-error http://127.0.0.1:3100/serialterminal/api/v1/update-source >/dev/null
if [[ -n "$MODERN_SMOKE_POLICY" ]]; then
  IFS=$'\t' read -r MODERN_SMOKE_VERSION MODERN_SMOKE_CHANNEL <<< "$MODERN_SMOKE_POLICY"
  curl --fail --silent --show-error \
    --noproxy '*' \
    --resolve trigger-cn.top:443:127.0.0.1 \
    --header "X-SerialTerminal-Version: $MODERN_SMOKE_VERSION" \
    --header "X-SerialTerminal-Channel: $MODERN_SMOKE_CHANNEL" \
    https://trigger-cn.top/serialterminal/latest.yml >/dev/null
fi
if [[ -n "$LEGACY_SMOKE_POLICY" ]]; then
  curl --fail --silent --show-error \
    --noproxy '*' \
    --resolve trigger-cn.top:443:127.0.0.1 \
    https://trigger-cn.top/serialterminal/latest.yml >/dev/null
fi

printf 'Deployed SerialTerminal telemetry at %s\n' "$(git -C "$REPO" rev-parse --short HEAD)"

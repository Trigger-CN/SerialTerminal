# SerialTerminal Telemetry Server

Private active-installation dashboard and pseudonymous daily activity endpoint.

## Data collected

- Random installation UUID generated while activity statistics are enabled; users can disable reporting in settings
- SerialTerminal version
- Operating system family
- Processor architecture

The server stores only an HMAC of the installation UUID. This is pseudonymous, linkable activity data rather than an irreversibly anonymous record. It does not collect serial port names, serial data, hardware identifiers, usernames, filenames, or IP addresses in the application database.

Daily activity rows should be retained for 90 days. Run `npm run prune` daily from a systemd timer or cron. Installation summary rows are retained to preserve cumulative installation counts. The telemetry HMAC secret is persistent metric state: back it up securely because rotating or losing it makes existing installations appear new.

Dashboard DAU, WAU, and MAU values count unique installations active in their UTC windows. Total installations count all unique installation IDs ever reported. The version breakdown groups each installation by its latest reported version, so an upgrade moves that installation from the old version to the new one without increasing the total.

The public endpoint can be imitated by third parties because a desktop application cannot securely contain a shared API secret. Dashboard values are product estimates, not suitable for billing, licensing, or security decisions. Use Nginx rate limits and monitor abnormal bursts of new installation IDs.

## Setup

1. Create a PostgreSQL database and restricted database user.
2. Apply `db/001-init.sql` and then `db/002-update-source.sql`.
3. Run `npm install`.
4. Generate an administrator password hash with `npm run password -- "your password"`.
5. Copy `.env.example` values into a protected systemd environment file.
6. Start with `npm start` behind an HTTPS reverse proxy.

The process listens on `127.0.0.1:3100` by default. The public activity endpoint is `/serialterminal/api/v1/activity`; the public update-source endpoint is `/serialterminal/api/v1/update-source`; the dashboard is `/serialterminal/admin/`.

The dashboard's `客户端更新源` section stores the primary HTTPS `latest.yml` URL in PostgreSQL. New clients query the public endpoint before each update check, then fall back through the server `/serialterminal/latest.yml`, Tencent COS, and GitHub Release metadata. Existing clients with a hard-coded COS URL are unaffected; keep the COS objects and the legacy proxy available during migration.

For production, install the application at `/home/ubuntu/ws/SerialTerminalTelemetry`, copy the units under `deploy/` to `/etc/systemd/system/`, and keep the environment file readable only by root and the service account. Enable both `serialterminal-telemetry.service` and `serialterminal-telemetry-prune.timer`. Run `npm ci --omit=dev` rather than `npm install` during deployment.

## Nginx

```nginx
limit_req_zone $binary_remote_addr zone=serialterminal_activity:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=serialterminal_admin_login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=serialterminal_update_source:10m rate=30r/m;

location = /serialterminal/api/v1/activity {
    client_max_body_size 2k;
    limit_req zone=serialterminal_activity burst=5 nodelay;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /serialterminal/api/v1/update-source {
    limit_req zone=serialterminal_update_source burst=10 nodelay;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /serialterminal/admin/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /serialterminal/admin/login {
    limit_req zone=serialterminal_admin_login burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Keep Nginx access-log retention short because access logs normally contain client IP addresses. The Node service listens only on loopback and relies on Nginx for per-client rate limiting.

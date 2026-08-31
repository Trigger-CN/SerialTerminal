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
2. Apply `db/001-init.sql`, `db/002-update-source.sql`, and `db/003-update-policies.sql` in that order. All migrations are idempotent and should also be applied when upgrading an existing deployment. Migration `003` uses the existing `service_settings.update_metadata_url` value for its one-time legacy and modern policy seeds, then records a marker so later deployments do not recreate policies.
3. Run `npm install`.
4. Generate an administrator password hash with `npm run password -- "your password"`.
5. Copy `.env.example` values into a protected systemd environment file. `UPDATE_METADATA_HOSTS` optionally replaces the default trusted metadata/asset host list; entries also allow their subdomains.
6. Start with `npm start` behind an HTTPS reverse proxy.

The process listens on `127.0.0.1:3100` by default. The public activity endpoint is `/serialterminal/api/v1/activity`; the public dynamic update manifest is `/serialterminal/latest.yml`; the compatibility update-source endpoint is `/serialterminal/api/v1/update-source`; the dashboard is `/serialterminal/admin/`.

## Dynamic update manifests

`GET /serialterminal/latest.yml` selects an enabled update policy and returns the selected origin's `latest.yml` as YAML. Clients should send these request headers:

- `X-SerialTerminal-Version`: the current client semantic version, for example `0.4.0`
- `X-SerialTerminal-Channel`: the update channel, for example `stable`

A policy with an empty channel applies to every channel. Minimum and maximum client versions are optional inclusive bounds. Among eligible policies, higher `priority` values take precedence. At most one policy can be marked `legacy`; when enabled, it supplies the manifest for old clients that request `/serialterminal/latest.yml` without the policy-selection headers. Disabled policies are never selected. Keep an enabled legacy policy while compatible clients remain in use.

The authenticated dashboard creates and edits policies through `/serialterminal/admin/api/update-policies`. `GET` lists policies, `POST` creates one, and `PUT /serialterminal/admin/api/update-policies/:id` replaces an existing policy; there is no delete endpoint. Policy writes use the administrator session, same-origin credentials, and the session's `X-CSRF-Token`. Policy metadata URLs must use HTTPS and end in `/latest.yml`. HTTPS alone does not make an origin trustworthy; configure only origins operated by or explicitly trusted by the project.

The Node service dynamically fetches and transforms the selected origin manifest. Relative installer and blockmap paths are resolved against the selected metadata URL's directory. Nginx and Node serve the resulting YAML, not those binary assets, so every origin asset referenced by `latest.yml` must remain publicly available. Changes at an origin can therefore affect update delivery even when no policy row changes.

Manifest fetching is fail-closed: policy URLs and redirects must remain on the configured HTTPS host allowlist, redirects back to the public dynamic endpoint are rejected, responses are bounded by timeout and size, and normalized manifests may contain only supported updater fields and safe public asset URLs. Cache entries are partitioned by policy and client selection inputs so one channel or version range cannot reuse another policy's manifest.

`GET /serialterminal/api/v1/update-source` remains available for clients that use update-source discovery. It returns the fixed compatibility document `{ "schemaVersion": 1, "metadataUrl": "https://trigger-cn.top/serialterminal/latest.yml" }`, directing them to the dynamic endpoint. Older `0.3.7` clients already request that URL directly and are handled by the legacy policy. Clients with a hard-coded third-party origin continue to bypass this service and depend on that origin remaining available.

For production, clone `https://github.com/Trigger-CN/SerialTerminal.git` to `/home/ubuntu/ws/SerialTerminal` and keep the environment file readable only by root and the service account. The verified Node 22 runtime remains under `/home/ubuntu/ws/SerialTerminalTelemetry/runtime`; application code and `node_modules` live in the GitHub checkout. Run `telemetry-server/deploy/deploy-from-github.sh` as `ubuntu` to pull `main` with `--ff-only`, install dependencies, run tests and migrations `001` through `003`, update systemd/Nginx configuration, and restart the service. The script replaces historical static compatibility snippets with empty include files, then health-checks both modern header-based and headerless legacy manifest requests through local HTTPS Nginx. Enable both `serialterminal-telemetry.service` and `serialterminal-telemetry-prune.timer`.

## Nginx

```nginx
limit_req_zone $binary_remote_addr zone=serialterminal_activity:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=serialterminal_admin_login:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=serialterminal_update_source:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=serialterminal_update_manifest:10m rate=30r/m;

location = /serialterminal/api/v1/activity {
    client_max_body_size 2k;
    limit_req zone=serialterminal_activity burst=5 nodelay;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /serialterminal/api/v1/update-source {
    limit_req zone=serialterminal_update_source burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /serialterminal/latest.yml {
    limit_req zone=serialterminal_update_manifest burst=10 nodelay;
    limit_req_status 429;
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-SerialTerminal-Version $http_x_serialterminal_version;
    proxy_set_header X-SerialTerminal-Channel $http_x_serialterminal_channel;
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

The production snippets also forward `X-Real-IP` and `X-Forwarded-For`. Keep Nginx access-log retention short because access logs normally contain client IP addresses. The Node service listens only on loopback and relies on Nginx for per-client rate limiting.

Do not add an Nginx static or COS `location = /serialterminal/latest.yml` alongside the dynamic route. Nginx forwards the two selection headers explicitly and leaves Node's `Cache-Control` and `Vary` response headers unchanged. Any additional CDN or proxy in front of Nginx must also honor those headers so one channel or client-version response is not reused for another.

CREATE TABLE IF NOT EXISTS installations (
    device_key TEXT PRIMARY KEY,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_version VARCHAR(40) NOT NULL,
    platform VARCHAR(16) NOT NULL,
    arch VARCHAR(16) NOT NULL
);

CREATE TABLE IF NOT EXISTS device_activity (
    device_key TEXT NOT NULL REFERENCES installations(device_key) ON DELETE CASCADE,
    activity_date DATE NOT NULL,
    app_version VARCHAR(40) NOT NULL,
    platform VARCHAR(16) NOT NULL,
    arch VARCHAR(16) NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device_key, activity_date)
);

CREATE INDEX IF NOT EXISTS device_activity_date_idx ON device_activity(activity_date);

CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);

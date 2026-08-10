CREATE TABLE IF NOT EXISTS service_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT NOT NULL
);

INSERT INTO service_settings (setting_key, setting_value, updated_by)
VALUES (
    'update_metadata_url',
    'https://trigger-cn.top/serialterminal/latest.yml',
    'migration'
)
ON CONFLICT (setting_key) DO NOTHING;

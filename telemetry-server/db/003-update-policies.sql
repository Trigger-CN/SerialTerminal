BEGIN;

CREATE TABLE IF NOT EXISTS update_policies (
    id BIGSERIAL PRIMARY KEY,
    channel TEXT,
    min_client_version TEXT,
    max_client_version TEXT,
    metadata_url TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    legacy BOOLEAN NOT NULL DEFAULT FALSE,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by TEXT NOT NULL
);

-- Existing deployments may have applied the first version of this migration
-- before channel-based matching was introduced.
ALTER TABLE update_policies
    ADD COLUMN IF NOT EXISTS channel TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM update_policies
        WHERE (min_client_version IS NOT NULL AND NOT (
            char_length(min_client_version) <= 100
            AND min_client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        )) OR (max_client_version IS NOT NULL AND NOT (
            char_length(max_client_version) <= 100
            AND max_client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        ))
    ) THEN
        RAISE EXCEPTION 'update_policies contains invalid semantic version bounds; correct those rows before rerunning migration 003';
    END IF;
END $$;

ALTER TABLE update_policies
    DROP CONSTRAINT IF EXISTS update_policies_min_client_version_check,
    DROP CONSTRAINT IF EXISTS update_policies_max_client_version_check;

ALTER TABLE update_policies
    ADD CONSTRAINT update_policies_min_client_version_check
        CHECK (min_client_version IS NULL OR (
            char_length(min_client_version) <= 100
            AND min_client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        )),
    ADD CONSTRAINT update_policies_max_client_version_check
        CHECK (max_client_version IS NULL OR (
            char_length(max_client_version) <= 100
            AND max_client_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
        ));

CREATE UNIQUE INDEX IF NOT EXISTS update_policies_one_legacy
    ON update_policies (legacy)
    WHERE legacy;

-- Repair rows seeded by an earlier draft before recording the one-time marker.
-- Administrator-edited rows are left untouched.
WITH migration_source AS (
    SELECT CASE
        WHEN setting_value = 'https://trigger-cn.top/serialterminal/latest.yml'
            THEN 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml'
        ELSE setting_value
    END AS metadata_url
    FROM service_settings
    WHERE setting_key = 'update_metadata_url'
)
UPDATE update_policies
SET metadata_url = migration_source.metadata_url,
    updated_at = NOW()
FROM migration_source
WHERE update_policies.updated_by = 'migration'
AND NOT EXISTS (
    SELECT 1 FROM service_settings WHERE setting_key = 'update_policies_seeded'
);

WITH migration_source AS (
    SELECT CASE
        WHEN setting_value = 'https://trigger-cn.top/serialterminal/latest.yml'
            THEN 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml'
        ELSE setting_value
    END AS metadata_url
    FROM service_settings
    WHERE setting_key = 'update_metadata_url'
)
INSERT INTO update_policies (metadata_url, legacy, updated_by)
SELECT metadata_url, TRUE, 'migration'
FROM migration_source
WHERE NOT EXISTS (
    SELECT 1 FROM service_settings WHERE setting_key = 'update_policies_seeded'
)
AND NOT EXISTS (SELECT 1 FROM update_policies WHERE legacy);

WITH migration_source AS (
    SELECT CASE
        WHEN setting_value = 'https://trigger-cn.top/serialterminal/latest.yml'
            THEN 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml'
        ELSE setting_value
    END AS metadata_url
    FROM service_settings
    WHERE setting_key = 'update_metadata_url'
)
INSERT INTO update_policies (metadata_url, legacy, updated_by)
SELECT metadata_url, FALSE, 'migration'
FROM migration_source
WHERE NOT EXISTS (
    SELECT 1 FROM service_settings WHERE setting_key = 'update_policies_seeded'
)
AND NOT EXISTS (SELECT 1 FROM update_policies WHERE NOT legacy);

INSERT INTO service_settings (setting_key, setting_value, updated_by)
VALUES ('update_policies_seeded', '1', 'migration')
ON CONFLICT (setting_key) DO NOTHING;

COMMIT;

'use strict';

function createStore(pool) {
  return {
    async ready() {
      await pool.query('SELECT 1');
    },

    async recordActivity({ deviceKey, activityDate, appVersion, platform, arch, now }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO installations (device_key, first_seen_at, last_seen_at, last_version, platform, arch)
          VALUES ($1, $2, $2, $3, $4, $5)
          ON CONFLICT (device_key) DO UPDATE SET
            last_seen_at = EXCLUDED.last_seen_at,
            last_version = EXCLUDED.last_version,
            platform = EXCLUDED.platform,
            arch = EXCLUDED.arch
          WHERE installations.last_seen_at <= EXCLUDED.last_seen_at
        `, [deviceKey, now, appVersion, platform, arch]);
        await client.query(`
          INSERT INTO device_activity
            (device_key, activity_date, app_version, platform, arch, first_seen_at, last_seen_at)
          VALUES ($1, $2, $3, $4, $5, $6, $6)
          ON CONFLICT (device_key, activity_date) DO UPDATE SET
            app_version = EXCLUDED.app_version,
            platform = EXCLUDED.platform,
            arch = EXCLUDED.arch,
            last_seen_at = EXCLUDED.last_seen_at
        `, [deviceKey, activityDate, appVersion, platform, arch, now]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async createSession({ tokenHash, csrfHash, expiresAt }) {
      await pool.query('DELETE FROM admin_sessions WHERE expires_at <= NOW()');
      await pool.query(`
        INSERT INTO admin_sessions (token_hash, csrf_hash, expires_at)
        VALUES ($1, $2, $3)
      `, [tokenHash, csrfHash, expiresAt]);
    },

    async getSession(tokenHash) {
      const result = await pool.query(`
        SELECT token_hash, csrf_hash, expires_at
        FROM admin_sessions
        WHERE token_hash = $1 AND expires_at > NOW()
      `, [tokenHash]);
      return result.rows[0] || null;
    },

    async deleteSession(tokenHash) {
      await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [tokenHash]);
    },

    async getUpdateSource() {
      const result = await pool.query(`
        SELECT setting_value AS metadata_url, updated_at, updated_by
        FROM service_settings
        WHERE setting_key = 'update_metadata_url'
      `);
      return result.rows[0] || null;
    },

    async setUpdateSource(metadataUrl, updatedBy, now) {
      const result = await pool.query(`
        INSERT INTO service_settings (setting_key, setting_value, updated_at, updated_by)
        VALUES ('update_metadata_url', $1, $3, $2)
        ON CONFLICT (setting_key) DO UPDATE SET
          setting_value = EXCLUDED.setting_value,
          updated_at = EXCLUDED.updated_at,
          updated_by = EXCLUDED.updated_by
        RETURNING setting_value AS metadata_url, updated_at, updated_by
      `, [metadataUrl, updatedBy, now]);
      return result.rows[0];
    },

    async getMetrics(days, today) {
      const startDate = new Date(`${today}T00:00:00.000Z`);
      startDate.setUTCDate(startDate.getUTCDate() - (days - 1));
      const start = startDate.toISOString().slice(0, 10);
      const [summary, activity, versions, platforms, architectures, recentActivity] = await Promise.all([
        pool.query(`
          SELECT
            (SELECT COUNT(*)::int FROM device_activity WHERE activity_date = $1) AS dau,
            (SELECT COUNT(DISTINCT device_key)::int FROM device_activity WHERE activity_date >= ($1::date - 6)) AS wau,
            (SELECT COUNT(DISTINCT device_key)::int FROM device_activity WHERE activity_date >= ($1::date - 29)) AS mau,
            (SELECT COUNT(*)::int FROM installations) AS total_installations,
            (SELECT COUNT(*)::int FROM installations WHERE (first_seen_at AT TIME ZONE 'UTC')::date = $1) AS new_today,
            (SELECT MAX(last_seen_at) FROM installations) AS last_activity_at
        `, [today]),
        pool.query(`
          SELECT activity_date::text AS day, COUNT(*)::int AS devices
          FROM device_activity
          WHERE activity_date BETWEEN $1 AND $2
          GROUP BY activity_date
          ORDER BY activity_date
        `, [start, today]),
        pool.query(`
          SELECT last_version AS label, COUNT(*)::int AS devices
          FROM installations
          GROUP BY last_version
          ORDER BY devices DESC, label
        `),
        pool.query(`
          SELECT platform AS label, COUNT(*)::int AS devices
          FROM (
            SELECT DISTINCT ON (device_key) device_key, platform
            FROM device_activity
            WHERE activity_date BETWEEN $1 AND $2
            ORDER BY device_key, activity_date DESC, last_seen_at DESC
          ) latest
          GROUP BY platform
          ORDER BY devices DESC, label
        `, [start, today]),
        pool.query(`
          SELECT arch AS label, COUNT(*)::int AS devices
          FROM (
            SELECT DISTINCT ON (device_key) device_key, arch
            FROM device_activity
            WHERE activity_date BETWEEN $1 AND $2
            ORDER BY device_key, activity_date DESC, last_seen_at DESC
          ) latest
          GROUP BY arch
          ORDER BY devices DESC, label
        `, [start, today]),
        pool.query(`
          SELECT
            RIGHT(device_key, 8) AS device_id,
            app_version,
            platform,
            arch,
            last_seen_at
          FROM device_activity
          ORDER BY last_seen_at DESC, device_key
          LIMIT 50
        `)
      ]);
      const byDay = new Map(activity.rows.map(row => [row.day, row.devices]));
      const daily = [];
      for (let offset = 0; offset < days; offset++) {
        const date = new Date(`${start}T00:00:00.000Z`);
        date.setUTCDate(date.getUTCDate() + offset);
        const day = date.toISOString().slice(0, 10);
        daily.push({ day, devices: byDay.get(day) || 0 });
      }
      return {
        summary: summary.rows[0],
        daily,
        versions: versions.rows,
        platforms: platforms.rows,
        architectures: architectures.rows,
        recentActivity: recentActivity.rows
      };
    },

    async close() {
      await pool.end();
    }
  };
}

module.exports = { createStore };

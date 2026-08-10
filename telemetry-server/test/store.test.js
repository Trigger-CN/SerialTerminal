'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../src/store');

test('version metrics group every installation by its latest reported version', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('AS dau')) return { rows: [{ dau: 1 }] };
      if (sql.includes('GROUP BY activity_date')) return { rows: [] };
      if (sql.includes('GROUP BY last_version')) return { rows: [{ label: '0.3.6', devices: 4 }] };
      if (sql.includes('LIMIT 50')) return { rows: [{ device_id: '1234abcd', app_version: '0.3.6' }] };
      return { rows: [] };
    }
  };

  const metrics = await createStore(pool).getMetrics(30, '2026-08-04');
  const versionQuery = queries.find(query => query.sql.includes('GROUP BY last_version'));

  assert.deepEqual(metrics.versions, [{ label: '0.3.6', devices: 4 }]);
  assert.deepEqual(metrics.recentActivity, [{ device_id: '1234abcd', app_version: '0.3.6' }]);
  assert.match(versionQuery.sql, /FROM installations/);
  assert.doesNotMatch(versionQuery.sql, /device_activity|activity_date/);
  assert.doesNotMatch(versionQuery.sql, /LIMIT/);
  assert.deepEqual(versionQuery.params, []);
  const recentQuery = queries.find(query => query.sql.includes('LIMIT 50'));
  assert.match(recentQuery.sql, /FROM device_activity/);
  assert.deepEqual(recentQuery.params, []);
});

test('installation summary rejects an older report that could roll back its version', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) { queries.push({ sql, params }); },
    release() {}
  };
  const store = createStore({ async connect() { return client; } });

  await store.recordActivity({
    deviceKey: 'device', activityDate: '2026-08-04', appVersion: '0.3.6',
    platform: 'win32', arch: 'x64', now: new Date('2026-08-04T12:00:00.000Z')
  });

  const installationQuery = queries.find(query => query.sql.includes('INSERT INTO installations'));
  assert.match(installationQuery.sql, /WHERE installations\.last_seen_at <= EXCLUDED\.last_seen_at/);
});

test('store reads and upserts the centralized update source', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT setting_value')) return { rows: [{ metadata_url: 'https://cdn.example/latest.yml' }] };
      return { rows: [{ metadata_url: params[0], updated_by: params[1] }] };
    }
  };
  const store = createStore(pool);
  assert.equal((await store.getUpdateSource()).metadata_url, 'https://cdn.example/latest.yml');
  assert.equal((await store.setUpdateSource('https://new.example/latest.yml', 'admin', new Date('2026-08-04'))).updated_by, 'admin');
  assert.match(queries[0].sql, /service_settings/);
  assert.match(queries[1].sql, /ON CONFLICT/);
});

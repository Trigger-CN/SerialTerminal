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

test('store reads, creates, and updates channel-aware update policies', async () => {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM update_policies') && sql.includes('ORDER BY')) {
        return { rows: [{ id: 1, channel: 'stable', metadata_url: 'https://cdn.example/latest.yml' }] };
      }
      return { rows: [{ id: params[0] === '5' ? 5 : 2, channel: params[0] === '5' ? params[1] : params[0] }] };
    }
  };
  const store = createStore(pool);
  const value = {
    channel: 'stable', minClientVersion: '0.4.0', maxClientVersion: null,
    metadataUrl: 'https://cdn.example/latest.yml', enabled: true, legacy: false, priority: 10
  };
  assert.equal((await store.getUpdatePolicies())[0].channel, 'stable');
  assert.equal((await store.createUpdatePolicy(value, 'admin', new Date('2026-08-04'))).channel, 'stable');
  assert.equal((await store.updateUpdatePolicy('5', value, 'admin', new Date('2026-08-05'))).id, 5);

  assert.match(queries[0].sql, /SELECT id, channel, min_client_version/);
  assert.match(queries[1].sql, /INSERT INTO update_policies/);
  assert.deepEqual(queries[1].params.slice(0, 4), ['stable', '0.4.0', null, 'https://cdn.example/latest.yml']);
  assert.match(queries[2].sql, /SET channel = \$2/);
  assert.deepEqual(queries[2].params.slice(0, 5), ['5', 'stable', '0.4.0', null, 'https://cdn.example/latest.yml']);
});

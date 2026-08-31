'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { createTelemetryServer } = require('../src/server');
const { hashPassword, hashToken } = require('../src/auth');

const SHA512 = Buffer.alloc(64).toString('base64');
const COS_METADATA_URL = 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml';

function policy(overrides = {}) {
  return {
    id: 1,
    channel: null,
    min_client_version: null,
    max_client_version: null,
    metadata_url: COS_METADATA_URL,
    enabled: true,
    legacy: false,
    priority: 0,
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    updated_by: 'migration',
    ...overrides
  };
}

function manifest(overrides = {}) {
  return [
    `version: ${overrides.version || '1.2.3'}`,
    'files:',
    `  - url: ${overrides.url || 'SerialTerminal-Setup-1.2.3.exe'}`,
    `    sha512: ${overrides.sha512 || SHA512}`,
    `path: ${overrides.url || 'SerialTerminal-Setup-1.2.3.exe'}`,
    `sha512: ${overrides.sha512 || SHA512}`
  ].join('\n');
}

async function startServer({ policies, fetchMetadata, config: configOverrides = {} } = {}) {
  const calls = [];
  const sessions = new Map();
  const updatePolicies = policies || [policy(), policy({ id: 2, legacy: true })];
  const store = {
    async ready() {},
    async recordActivity(value) { calls.push(value); },
    async createSession(session) { sessions.set(session.tokenHash, session); },
    async getSession(tokenHash) { return sessions.get(tokenHash) || null; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async getUpdatePolicies() { return updatePolicies; },
    async createUpdatePolicy(value, updatedBy, now) {
      const saved = policy({
        id: Math.max(0, ...updatePolicies.map(item => Number(item.id))) + 1,
        channel: value.channel,
        min_client_version: value.minClientVersion,
        max_client_version: value.maxClientVersion,
        metadata_url: value.metadataUrl,
        enabled: value.enabled,
        legacy: value.legacy,
        priority: value.priority,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        updated_by: updatedBy
      });
      updatePolicies.push(saved);
      return saved;
    },
    async updateUpdatePolicy(id, value, updatedBy, now) {
      const index = updatePolicies.findIndex(item => String(item.id) === String(id));
      if (index < 0) return null;
      updatePolicies[index] = {
        ...updatePolicies[index],
        channel: value.channel,
        min_client_version: value.minClientVersion,
        max_client_version: value.maxClientVersion,
        metadata_url: value.metadataUrl,
        enabled: value.enabled,
        legacy: value.legacy,
        priority: value.priority,
        updated_at: now.toISOString(),
        updated_by: updatedBy
      };
      return updatePolicies[index];
    },
    async getMetrics(days) {
      return {
        summary: { dau: 2, wau: 4, mau: 8, total_installations: 12, new_today: 1 },
        daily: [{ day: '2026-08-04', devices: 2 }],
        versions: [], platforms: [], architectures: [], recentActivity: [], days
      };
    }
  };
  const config = {
    telemetrySecret: 'a'.repeat(32),
    adminUsername: 'admin',
    adminPasswordHash: await hashPassword('correct horse battery staple'),
    publicOrigin: 'https://trigger-cn.top',
    fetchMetadata: fetchMetadata || (async () => manifest()),
    ...configOverrides
  };
  const server = createTelemetryServer({
    store,
    config,
    clock: () => new Date('2026-08-04T12:00:00.000Z'),
    logger: { error() {} }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, store, calls, sessions, updatePolicies, baseUrl };
}

function administratorSession(harness) {
  const token = 'test-session-token';
  harness.sessions.set(hashToken(token), {
    token_hash: hashToken(token),
    csrf_hash: hashToken('csrf'),
    expires_at: new Date('2026-08-05')
  });
  return {
    Origin: 'https://trigger-cn.top',
    Cookie: `__Host-serialterminal_admin=${token}`,
    'X-CSRF-Token': 'csrf',
    'Content-Type': 'application/json'
  };
}

function validPolicyPayload(overrides = {}) {
  return {
    metadataUrl: COS_METADATA_URL,
    channel: 'stable',
    minClientVersion: '0.4.0',
    maxClientVersion: null,
    enabled: true,
    legacy: false,
    priority: 10,
    ...overrides
  };
}

test('activity endpoint validates and HMACs installation identifiers', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const installationId = '9284747a-85cc-4e0a-92b2-6d577442b27e';

  const response = await fetch(`${harness.baseUrl}/serialterminal/api/v1/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installationId, appVersion: '0.3.6', platform: 'win32', arch: 'x64', schemaVersion: 1 })
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true, activityDate: '2026-08-04' });
  assert.equal(harness.calls.length, 1);
  assert.notEqual(harness.calls[0].deviceKey, installationId);
  assert.match(harness.calls[0].deviceKey, /^[0-9a-f]{64}$/);
});

test('activity endpoint rejects unknown or sensitive payload fields', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/api/v1/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      installationId: '9284747a-85cc-4e0a-92b2-6d577442b27e',
      appVersion: '0.3.6', platform: 'win32', arch: 'x64', schemaVersion: 1,
      serialData: 'must not be accepted'
    })
  });

  assert.equal(response.status, 400);
  assert.equal(harness.calls.length, 0);
});

test('dashboard metrics require a valid administrator session', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());

  const unauthorized = await fetch(`${harness.baseUrl}/serialterminal/admin/api/metrics?days=30`);
  assert.equal(unauthorized.status, 401);

  const token = 'test-session-token';
  harness.sessions.set(hashToken(token), { token_hash: hashToken(token), csrf_hash: hashToken('csrf'), expires_at: new Date('2026-08-05') });
  const authorized = await fetch(`${harness.baseUrl}/serialterminal/admin/api/metrics?days=30`, {
    headers: { Cookie: `__Host-serialterminal_admin=${token}` }
  });
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.summary.dau, 2);
  assert.equal(body.days, 30);
});

test('public update-source endpoint returns the fixed dynamic metadata URL', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/api/v1/update-source`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { schemaVersion: 1, metadataUrl: 'https://trigger-cn.top/serialterminal/latest.yml' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('dynamic manifest selects by version and channel and normalizes asset URLs', async t => {
  const requestedUrls = [];
  const harness = await startServer({
    policies: [
      policy({ id: 4, channel: 'stable', min_client_version: '0.4.0', priority: 20 }),
      policy({ id: 3, channel: 'stable', max_client_version: '0.3.9', priority: 30 }),
      policy({ id: 2, priority: 5 })
    ],
    fetchMetadata: async url => {
      requestedUrls.push(url);
      return manifest();
    }
  });
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: {
      'X-SerialTerminal-Version': '0.4.2',
      'X-SerialTerminal-Channel': 'stable'
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/yaml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');
  assert.equal(response.headers.get('vary'), 'X-SerialTerminal-Version, X-SerialTerminal-Channel');
  assert.deepEqual(requestedUrls, [COS_METADATA_URL]);
  const body = await response.text();
  assert.match(body, /version: 1\.2\.3/);
  assert.match(body, /https:\/\/tst-update-package-1316411824\.cos\.ap-hongkong\.myqcloud\.com\/releases\/latest\/SerialTerminal-Setup-1\.2\.3\.exe/);
});

test('dynamic manifest uses only the legacy policy when selection headers are absent', async t => {
  const legacyUrl = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest.yml';
  const requestedUrls = [];
  const harness = await startServer({
    policies: [policy({ id: 1, priority: 100 }), policy({ id: 2, metadata_url: legacyUrl, legacy: true })],
    fetchMetadata: async url => {
      requestedUrls.push(url);
      return manifest({ url: 'https://github.com/Trigger-CN/SerialTerminal/releases/download/v1.2.3/SerialTerminal-Setup-1.2.3.exe' });
    }
  });
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`);
  assert.equal(response.status, 200);
  assert.deepEqual(requestedUrls, [legacyUrl]);
});

test('dynamic manifest follows allowed redirects but resolves assets against the policy URL', async t => {
  const metadataUrl = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest.yml';
  const redirectUrl = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/signed?filename=latest.yml';
  const requestedUrls = [];
  const harness = await startServer({
    policies: [policy({ metadata_url: metadataUrl })],
    fetchMetadata: async url => {
      requestedUrls.push(url);
      return url === metadataUrl
        ? { statusCode: 302, headers: { location: redirectUrl }, body: '' }
        : { statusCode: 200, body: manifest() };
    }
  });
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: { 'X-SerialTerminal-Version': '0.4.0', 'X-SerialTerminal-Channel': 'stable' }
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedUrls, [metadataUrl, redirectUrl]);
  assert.match(await response.text(), /https:\/\/github\.com\/Trigger-CN\/SerialTerminal\/releases\/latest\/download\/SerialTerminal-Setup-1\.2\.3\.exe/);
});

test('dynamic manifest rejects redirects back to its public entry without following them', async t => {
  const metadataUrl = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest.yml';
  const requestedUrls = [];
  const harness = await startServer({
    policies: [policy({ metadata_url: metadataUrl })],
    fetchMetadata: async url => {
      requestedUrls.push(url);
      return {
        statusCode: 302,
        headers: { location: 'https://trigger-cn.top/serialterminal/latest.yml' },
        body: ''
      };
    }
  });
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: { 'X-SerialTerminal-Version': '0.4.0', 'X-SerialTerminal-Channel': 'stable' }
  });
  assert.equal(response.status, 503);
  assert.deepEqual(requestedUrls, [metadataUrl]);
});

test('dynamic manifest rejects partial headers, missing policies, and unsafe upstream assets', async t => {
  const harness = await startServer({
    policies: [policy()],
    fetchMetadata: async () => manifest({ url: 'https://evil.example/setup.exe' })
  });
  t.after(() => harness.server.close());

  const partial = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: { 'X-SerialTerminal-Version': '0.4.0' }
  });
  assert.equal(partial.status, 400);
  assert.equal(partial.headers.get('vary'), 'X-SerialTerminal-Version, X-SerialTerminal-Channel');

  const noPolicy = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`);
  assert.equal(noPolicy.status, 404);

  const unsafe = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: { 'X-SerialTerminal-Version': '0.4.0', 'X-SerialTerminal-Channel': 'stable' }
  });
  assert.equal(unsafe.status, 503);
  assert.deepEqual(await unsafe.json(), { error: 'update_metadata_unavailable' });
});

test('dynamic manifest discards unknown alias-heavy fields before serialization', async t => {
  const harness = await startServer({
    policies: [policy()],
    fetchMetadata: async () => [
      'version: 1.2.3',
      `path: SerialTerminal-Setup-1.2.3.exe`,
      `sha512: ${SHA512}`,
      'seed: &seed ["xxxxxxxxxx", "xxxxxxxxxx"]',
      'expanded: &expanded [*seed, *seed, *seed, *seed, *seed, *seed, *seed, *seed, *seed, *seed]',
      'payload: [*expanded, *expanded, *expanded, *expanded, *expanded, *expanded, *expanded, *expanded, *expanded, *expanded]'
    ].join('\n')
  });
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/latest.yml`, {
    headers: { 'X-SerialTerminal-Version': '0.4.0', 'X-SerialTerminal-Channel': 'stable' }
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(body.length < 1024);
  assert.doesNotMatch(body, /seed|expanded|payload/);
});

test('dynamic manifest preserves staged rollout and rejects excessive files', async t => {
  const stagedHarness = await startServer({
    policies: [policy()],
    fetchMetadata: async () => `${manifest()}\nstagingPercentage: 25\n`
  });
  t.after(() => stagedHarness.server.close());
  const headers = { 'X-SerialTerminal-Version': '0.4.0', 'X-SerialTerminal-Channel': 'stable' };
  const staged = await fetch(`${stagedHarness.baseUrl}/serialterminal/latest.yml`, { headers });
  assert.equal(staged.status, 200);
  assert.match(await staged.text(), /stagingPercentage: 25/);

  const excessiveHarness = await startServer({
    policies: [policy()],
    fetchMetadata: async () => [
      'version: 1.2.3',
      'files:',
      ...Array.from({ length: 33 }, (_, index) => [
        `  - url: setup-${index}.exe`,
        `    sha512: ${SHA512}`
      ]).flat()
    ].join('\n')
  });
  t.after(() => excessiveHarness.server.close());
  const excessive = await fetch(`${excessiveHarness.baseUrl}/serialterminal/latest.yml`, { headers });
  assert.equal(excessive.status, 503);
});

test('administrator can create and update policies with CSRF and same-origin metadata', async t => {
  const harness = await startServer({ policies: [] });
  t.after(() => harness.server.close());
  const headers = administratorSession(harness);
  const create = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload())
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  assert.equal(created.channel, 'stable');
  assert.equal(created.minClientVersion, '0.4.0');

  const update = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies/${created.id}`, {
    method: 'PUT', headers, body: JSON.stringify(validPolicyPayload({ priority: 25 }))
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).priority, 25);

  const list = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    headers: { Cookie: headers.Cookie }
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).policies[0].priority, 25);
});

test('administrator policy writes reject unsafe input, missing CSRF, and legacy conflicts', async t => {
  const harness = await startServer({ policies: [policy({ id: 7, legacy: true })] });
  t.after(() => harness.server.close());
  const headers = administratorSession(harness);
  const unsafe = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({ metadataUrl: 'http://evil.example/latest.yml' }))
  });
  assert.equal(unsafe.status, 400);
  const recursive = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({
      metadataUrl: 'https://trigger-cn.top/serialterminal/latest.yml'
    }))
  });
  assert.equal(recursive.status, 400);
  const oversizedPriority = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({ priority: 2147483648 }))
  });
  assert.equal(oversizedPriority.status, 400);
  const invalidPrerelease = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({ minClientVersion: '1.2.3-01' }))
  });
  assert.equal(invalidPrerelease.status, 400);
  const trailingDotLoop = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({
      metadataUrl: 'https://trigger-cn.top./serialterminal/latest.yml'
    }))
  });
  assert.equal(trailingDotLoop.status, 400);
  const missingCsrf = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers: { ...headers, 'X-CSRF-Token': '' }, body: JSON.stringify(validPolicyPayload())
  });
  assert.equal(missingCsrf.status, 403);
  const conflict = await fetch(`${harness.baseUrl}/serialterminal/admin/api/update-policies`, {
    method: 'POST', headers, body: JSON.stringify(validPolicyPayload({
      channel: null, minClientVersion: null, legacy: true
    }))
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'legacy_policy_conflict' });
});

test('login issues secure session and CSRF cookies', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: 'https://trigger-cn.top',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 303);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /Secure/);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.match(cookies[1], /serialterminal_csrf=/);
  assert.doesNotMatch(cookies[1], /HttpOnly/);
  assert.match(cookies[2], /__Host-serialterminal_login_csrf=;/);
  assert.match(cookies[2], /Max-Age=0/);
});

test('login accepts same-origin browser form metadata when Origin is omitted', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 303);
});

test('login accepts Edge same-origin form metadata when Origin is null', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: 'null',
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 303);
});

test('login accepts its CSRF token when browser metadata is omitted', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const page = await fetch(`${harness.baseUrl}/serialterminal/admin/login`);
  const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const setCookie = page.headers.getSetCookie()[0];
  assert.match(setCookie, /Path=\//);
  const csrfCookie = setCookie.split(';', 1)[0];
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ csrf, username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 303);
});

test('login rejects requests without browser metadata or its CSRF token', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 403);
});

test('login rejects cross-site browser form metadata', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 403);
});

test('login rejects cross-site form metadata when Origin is null', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());
  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Origin: 'null',
      'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ username: 'admin', password: 'correct horse battery staple' })
  });

  assert.equal(response.status, 403);
});

test('malformed cookies do not break protected routes', async t => {
  const harness = await startServer();
  t.after(() => harness.server.close());

  const response = await fetch(`${harness.baseUrl}/serialterminal/admin/api/metrics?days=30`, {
    headers: { Cookie: '__Host-serialterminal_admin=%E0%A4%A' }
  });

  assert.equal(response.status, 401);
});

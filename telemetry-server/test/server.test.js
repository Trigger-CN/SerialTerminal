'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const { createTelemetryServer } = require('../src/server');
const { hashPassword, hashToken } = require('../src/auth');

async function startServer(overrides = {}) {
  const calls = [];
  const sessions = new Map();
  const store = {
    async ready() {},
    async recordActivity(value) { calls.push(value); },
    async createSession(session) { sessions.set(session.tokenHash, session); },
    async getSession(tokenHash) { return sessions.get(tokenHash) || null; },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
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
    ...overrides
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
  return { server, store, calls, sessions, baseUrl };
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

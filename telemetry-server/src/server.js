'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');
const { Pool } = require('pg');
const { createStore } = require('./store');
const { verifyPassword, hashToken, createSessionCredentials } = require('./auth');

const ROOT = path.join(__dirname, '..');
const BASE = '/serialterminal';
const SESSION_COOKIE = '__Host-serialterminal_admin';
const LOGIN_CSRF_COOKIE = '__Host-serialterminal_login_csrf';
const ALLOWED_DAYS = new Set([7, 30, 90]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const ALLOWED_PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const ALLOWED_ARCHITECTURES = new Set(['x64', 'arm64', 'ia32']);

function loadAsset(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function parseCookies(value = '') {
  const cookies = {};
  value.split(';').forEach(part => {
    const separator = part.indexOf('=');
    if (separator < 1) return;
    try {
      cookies[decodeURIComponent(part.slice(0, separator).trim())] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Ignore malformed cookies instead of failing the entire request.
    }
  });
  return cookies;
}

function send(response, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function sendJson(response, status, value, headers = {}) {
  send(response, status, JSON.stringify(value), 'application/json; charset=utf-8', headers);
}

function securityHeaders(publicOrigin) {
  return {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(publicOrigin.startsWith('https://') ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
  };
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function createTelemetryServer({ store, config, clock = () => new Date(), logger = console }) {
  const assets = {
    login: loadAsset('public/login.html'),
    dashboard: loadAsset('public/dashboard.html'),
    css: loadAsset('public/dashboard.css'),
    js: loadAsset('public/dashboard.js')
  };
  const headers = securityHeaders(config.publicOrigin);

  async function getSession(request) {
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (!token) return null;
    const session = await store.getSession(hashToken(token));
    return session ? { ...session, token } : null;
  }

  function validRequestMetadata(request) {
    if (request.headers.origin && request.headers.origin !== 'null') {
      return request.headers.origin === config.publicOrigin;
    }
    if (request.headers['sec-fetch-site']) return request.headers['sec-fetch-site'] === 'same-origin';
    if (!request.headers.referer) return null;
    try {
      return new URL(request.headers.referer).origin === config.publicOrigin;
    } catch {
      return false;
    }
  }

  function renderLogin(csrf) {
    return Buffer.from(assets.login.toString('utf8').replace('{{LOGIN_CSRF}}', csrf));
  }

  const server = http.createServer(async (request, response) => {
    Object.entries(headers).forEach(([name, value]) => response.setHeader(name, value));
    const url = new URL(request.url, config.publicOrigin);
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'GET' && url.pathname === '/readyz') {
        await store.ready();
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && url.pathname === `${BASE}/api/v1/activity`) {
        if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
          return sendJson(response, 415, { error: 'content_type' });
        }
        const payload = JSON.parse(await readBody(request, 2048));
        const valid = payload && Object.keys(payload).length === 5
          && UUID_PATTERN.test(payload.installationId || '')
          && VERSION_PATTERN.test(payload.appVersion || '')
          && payload.appVersion.length <= 40
          && ALLOWED_PLATFORMS.has(payload.platform)
          && ALLOWED_ARCHITECTURES.has(payload.arch)
          && payload.schemaVersion === 1;
        if (!valid) return sendJson(response, 400, { error: 'invalid_payload' });
        const now = clock();
        const activityDate = now.toISOString().slice(0, 10);
        const deviceKey = createHmac('sha256', config.telemetrySecret).update(payload.installationId).digest('hex');
        await store.recordActivity({ ...payload, deviceKey, activityDate, now });
        return sendJson(response, 200, { accepted: true, activityDate });
      }
      if (request.method === 'GET' && url.pathname === `${BASE}/admin/login`) {
        if (await getSession(request)) {
          response.writeHead(303, { Location: `${BASE}/admin/` });
          return response.end();
        }
        const loginCsrf = randomBytes(32).toString('base64url');
        return send(response, 200, renderLogin(loginCsrf), 'text/html; charset=utf-8', {
          'Set-Cookie': `${LOGIN_CSRF_COOKIE}=${loginCsrf}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`
        });
      }
      if (request.method === 'POST' && url.pathname === `${BASE}/admin/login`) {
        const form = new URLSearchParams(await readBody(request, 4096));
        const metadataValid = validRequestMetadata(request);
        const csrfCookie = parseCookies(request.headers.cookie)[LOGIN_CSRF_COOKIE] || '';
        const csrfValid = csrfCookie.length >= 32 && hashToken(csrfCookie) === hashToken(form.get('csrf') || '');
        if (metadataValid === false || (metadataValid === null && !csrfValid)) {
          return send(response, 403, 'Forbidden', 'text/plain; charset=utf-8');
        }
        const passwordValid = await verifyPassword(form.get('password') || '', config.adminPasswordHash);
        const authenticated = form.get('username') === config.adminUsername && passwordValid;
        if (!authenticated) return send(response, 401, renderLogin(form.get('csrf') || ''), 'text/html; charset=utf-8');
        const credentials = createSessionCredentials();
        const expiresAt = new Date(clock().getTime() + 8 * 60 * 60 * 1000);
        await store.createSession({ ...credentials, expiresAt });
        response.writeHead(303, {
          Location: `${BASE}/admin/`,
          'Set-Cookie': [
            `${SESSION_COOKIE}=${encodeURIComponent(credentials.token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
            `serialterminal_csrf=${encodeURIComponent(credentials.csrf)}; Path=${BASE}/admin; Secure; SameSite=Strict; Max-Age=28800`,
            `${LOGIN_CSRF_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
          ]
        });
        return response.end();
      }
      if (request.method === 'GET' && url.pathname === `${BASE}/admin/dashboard.css`) {
        return send(response, 200, assets.css, 'text/css; charset=utf-8', { 'Cache-Control': 'private, max-age=3600' });
      }
      if (request.method === 'GET' && url.pathname === `${BASE}/admin/dashboard.js`) {
        return send(response, 200, assets.js, 'application/javascript; charset=utf-8', { 'Cache-Control': 'private, max-age=3600' });
      }
      if (url.pathname.startsWith(`${BASE}/admin/`)) {
        const session = await getSession(request);
        if (!session) {
          if (url.pathname.startsWith(`${BASE}/admin/api/`)) return sendJson(response, 401, { error: 'unauthorized' });
          response.writeHead(303, { Location: `${BASE}/admin/login` });
          return response.end();
        }
        if (request.method === 'GET' && url.pathname === `${BASE}/admin/`) {
          return send(response, 200, assets.dashboard, 'text/html; charset=utf-8');
        }
        if (request.method === 'GET' && url.pathname === `${BASE}/admin/api/metrics`) {
          const days = Number(url.searchParams.get('days') || 30);
          if (!ALLOWED_DAYS.has(days)) return sendJson(response, 400, { error: 'invalid_days' });
          const now = clock();
          const metrics = await store.getMetrics(days, now.toISOString().slice(0, 10));
          return sendJson(response, 200, { generatedAt: now.toISOString(), days, ...metrics });
        }
        if (request.method === 'POST' && url.pathname === `${BASE}/admin/logout`) {
          const csrf = request.headers['x-csrf-token'];
          if (validRequestMetadata(request) === false || hashToken(csrf || '') !== session.csrf_hash) {
            return sendJson(response, 403, { error: 'forbidden' });
          }
          await store.deleteSession(hashToken(session.token));
          return sendJson(response, 200, { ok: true }, {
            'Set-Cookie': [
              `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
              `serialterminal_csrf=; Path=${BASE}/admin; Secure; SameSite=Strict; Max-Age=0`
            ]
          });
        }
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      logger.error('Request failed', error);
      sendJson(response, error.statusCode || (error instanceof SyntaxError ? 400 : 500), {
        error: error instanceof SyntaxError ? 'invalid_json' : 'internal_error'
      });
    }
  });
  return server;
}

function loadConfig() {
  const required = ['DATABASE_URL', 'TELEMETRY_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'PUBLIC_ORIGIN'];
  required.forEach(name => {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  });
  if (process.env.TELEMETRY_SECRET.length < 32) throw new Error('TELEMETRY_SECRET must be at least 32 characters');
  return {
    databaseUrl: process.env.DATABASE_URL,
    telemetrySecret: process.env.TELEMETRY_SECRET,
    adminUsername: process.env.ADMIN_USERNAME,
    adminPasswordHash: process.env.ADMIN_PASSWORD_HASH,
    publicOrigin: process.env.PUBLIC_ORIGIN.replace(/\/$/, ''),
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3100)
  };
}

if (require.main === module) {
  const config = loadConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = createStore(pool);
  const server = createTelemetryServer({ store, config });
  server.listen(config.port, config.host, () => {
    console.log(`SerialTerminal telemetry listening on http://${config.host}:${config.port}`);
  });
  async function shutdown() {
    server.close();
    await store.close();
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createTelemetryServer, loadConfig };

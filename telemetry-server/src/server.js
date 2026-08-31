'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');
const { Pool } = require('pg');
const yaml = require('js-yaml');
const { createStore } = require('./store');
const { verifyPassword, hashToken, createSessionCredentials } = require('./auth');

const ROOT = path.join(__dirname, '..');
const BASE = '/serialterminal';
const SESSION_COOKIE = '__Host-serialterminal_admin';
const LOGIN_CSRF_COOKIE = '__Host-serialterminal_login_csrf';
const ALLOWED_DAYS = new Set([7, 30, 90]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const SEMVER_IDENTIFIER = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_PATTERN = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${SEMVER_IDENTIFIER}(?:\\.${SEMVER_IDENTIFIER})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);
const ALLOWED_PLATFORMS = new Set(['win32', 'linux', 'darwin']);
const ALLOWED_ARCHITECTURES = new Set(['x64', 'arm64', 'ia32']);
const DEFAULT_UPDATE_METADATA_HOSTS = Object.freeze([
  'trigger-cn.top',
  'gitee.com',
  'github.com',
  'githubusercontent.com',
  'myqcloud.com'
]);
const MAX_METADATA_BYTES = 512 * 1024;
const MAX_METADATA_FILES = 32;
const MAX_METADATA_URL_LENGTH = 4096;
const MAX_METADATA_TEXT_BYTES = 128 * 1024;
const MAX_VERSION_LENGTH = 100;
const METADATA_TIMEOUT_MS = 5000;
const MAX_METADATA_REDIRECTS = 3;
const UPDATE_METADATA_ENTRY_URL = 'https://trigger-cn.top/serialterminal/latest.yml';
const POLICY_FIELDS = Object.freeze([
  'metadataUrl',
  'channel',
  'minClientVersion',
  'maxClientVersion',
  'enabled',
  'legacy',
  'priority'
]);

class UpdateMetadataError extends Error {
  constructor(message, statusCode = 503, code = 'update_metadata_unavailable') {
    super(message);
    this.name = 'UpdateMetadataError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeAllowedHosts(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const hosts = [];
  for (const raw of values) {
    const entry = String(raw || '').trim().toLowerCase();
    if (!entry) continue;
    const host = entry.replace(/^\*?\./, '').replace(/\.$/, '');
    if (!host || /[\s/:?#]/.test(host)) throw new Error(`Invalid update metadata host: ${raw}`);
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function getHostRules(allowedHosts) {
  if (Array.isArray(allowedHosts) && allowedHosts.every(rule => rule && typeof rule === 'object')) {
    return allowedHosts.map(rule => ({
      host: String(rule.host || '').toLowerCase().replace(/\.$/, ''),
      subdomains: rule.subdomains === true
    })).filter(rule => rule.host);
  }
  if (allowedHosts === undefined || allowedHosts === null) {
    return DEFAULT_UPDATE_METADATA_HOSTS.map(host => ({
      host,
      subdomains: true
    }));
  }
  const values = Array.isArray(allowedHosts) ? allowedHosts : normalizeAllowedHosts(allowedHosts);
  return values.map(raw => {
    const value = String(raw || '').trim().toLowerCase();
    const subdomains = value.startsWith('.') || value.startsWith('*.') || !value.startsWith('[');
    return {
      host: value.replace(/^\*?\./, '').replace(/\.$/, ''),
      subdomains
    };
  }).filter(rule => rule.host);
}

function isAllowedHost(hostname, allowedHosts) {
  const normalized = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return getHostRules(allowedHosts).some(rule => normalized === rule.host
    || (rule.subdomains && normalized.endsWith(`.${rule.host}`)));
}

function parseSemver(value) {
  if (typeof value !== 'string' || value.length > MAX_VERSION_LENGTH) return null;
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: match[1],
    minor: match[2],
    patch: match[3],
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareNumericStrings(left, right) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) return normalizedLeft.length - normalizedRight.length;
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function compareSemver(left, right) {
  const leftVersion = typeof left === 'string' ? parseSemver(left) : left;
  const rightVersion = typeof right === 'string' ? parseSemver(right) : right;
  if (!leftVersion || !rightVersion) return 0;
  for (const component of ['major', 'minor', 'patch']) {
    const comparison = compareNumericStrings(leftVersion[component], rightVersion[component]);
    if (comparison) return comparison;
  }
  if (!leftVersion.prerelease.length && !rightVersion.prerelease.length) return 0;
  if (!leftVersion.prerelease.length) return 1;
  if (!rightVersion.prerelease.length) return -1;
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index++) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^(0|[1-9][0-9]*)$/.test(leftPart);
    const rightNumeric = /^(0|[1-9][0-9]*)$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericStrings(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function validateUpdateMetadataUrl(value, allowedHosts) {
  if (typeof value !== 'string' || value.length > MAX_METADATA_URL_LENGTH) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
    || url.hostname.endsWith('.')) return '';
  if (!url.hostname || !isAllowedHost(url.hostname, allowedHosts) || !/\/latest\.yml$/i.test(url.pathname)) return '';
  return url.toString();
}

function validateAssetUrl(value, baseUrl, allowedHosts) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_METADATA_URL_LENGTH) return '';
  let url;
  try {
    url = new URL(value.trim(), baseUrl);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.hostname.endsWith('.')
    || !url.hostname || !isAllowedHost(url.hostname, allowedHosts)) return '';
  return url.toString();
}

function isSha512(value) {
  if (typeof value !== 'string') return false;
  if (/^[a-f0-9]{128}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9+/]{86}==?$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').length === 64;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function copyOptionalManifestFields(target, source, fields) {
  for (const field of fields) {
    if (typeof source[field] === 'string' && Buffer.byteLength(source[field]) <= MAX_METADATA_TEXT_BYTES) {
      target[field] = source[field];
    }
  }
}

function copyOptionalFileFields(target, source) {
  if (Number.isSafeInteger(source.size) && source.size >= 0) target.size = source.size;
  if (source.isAdminRightsRequired === true) target.isAdminRightsRequired = true;
}

function normalizeManifest(manifest, metadataUrl, allowedHosts) {
  if (!isPlainObject(manifest) || !parseSemver(manifest.version)) {
    throw new UpdateMetadataError('Manifest must contain a valid semver version');
  }
  if (manifest.files !== undefined && !Array.isArray(manifest.files)) {
    throw new UpdateMetadataError('Manifest files must be an array');
  }
  if (manifest.files?.length > MAX_METADATA_FILES) {
    throw new UpdateMetadataError('Manifest contains too many files');
  }

  const normalized = { version: manifest.version };
  copyOptionalManifestFields(normalized, manifest, [
    'releaseName',
    'releaseNotes',
    'releaseDate',
    'minimumSystemVersion'
  ]);
  if (manifest.stagingPercentage !== undefined) {
    const stagingPercentage = Number(manifest.stagingPercentage);
    if ((typeof manifest.stagingPercentage !== 'number' && typeof manifest.stagingPercentage !== 'string')
      || !Number.isFinite(stagingPercentage) || stagingPercentage < 0 || stagingPercentage > 100) {
      throw new UpdateMetadataError('Manifest staging percentage is invalid');
    }
    normalized.stagingPercentage = stagingPercentage;
  }

  const sourceFiles = Array.isArray(manifest.files) ? manifest.files : [];
  const files = [];
  for (const file of sourceFiles) {
    if (!isPlainObject(file) || !isSha512(file.sha512)) {
      throw new UpdateMetadataError('Manifest files must contain sha512 checksums');
    }
    const fileUrl = validateAssetUrl(file.url || file.path, metadataUrl, allowedHosts);
    if (!fileUrl) throw new UpdateMetadataError('Manifest file URL is not an allowed HTTPS URL');
    const normalizedFile = { url: fileUrl, sha512: file.sha512 };
    copyOptionalFileFields(normalizedFile, file);
    if (file.path !== undefined) {
      const filePath = validateAssetUrl(file.path, metadataUrl, allowedHosts);
      if (!filePath) throw new UpdateMetadataError('Manifest file path is not an allowed HTTPS URL');
      normalizedFile.path = filePath;
    }
    files.push(normalizedFile);
  }
  if (manifest.files !== undefined) normalized.files = files;

  let hasUsableFile = files.length > 0;
  if (manifest.path !== undefined) {
    if (typeof manifest.path !== 'string' || !isSha512(manifest.sha512)) {
      throw new UpdateMetadataError('Manifest legacy path must contain a sha512 checksum');
    }
    normalized.path = validateAssetUrl(manifest.path, metadataUrl, allowedHosts);
    if (!normalized.path) throw new UpdateMetadataError('Manifest legacy path is not an allowed HTTPS URL');
    normalized.sha512 = manifest.sha512;
    hasUsableFile = true;
  }
  if (!hasUsableFile) throw new UpdateMetadataError('Manifest contains no usable update file');

  if (manifest.packages !== undefined) {
    if (!isPlainObject(manifest.packages)) throw new UpdateMetadataError('Manifest packages must be an object');
    const packages = {};
    for (const arch of ['x64', 'arm64', 'ia32']) {
      const packageInfo = manifest.packages[arch];
      if (!isPlainObject(packageInfo) || packageInfo.path === undefined) continue;
      if (!isSha512(packageInfo.sha512)) throw new UpdateMetadataError('Manifest package must contain a sha512 checksum');
      const packagePath = validateAssetUrl(packageInfo.path, metadataUrl, allowedHosts);
      if (!packagePath) throw new UpdateMetadataError('Manifest package path is not an allowed HTTPS URL');
      packages[arch] = { path: packagePath, sha512: packageInfo.sha512 };
      if (Number.isSafeInteger(packageInfo.size) && packageInfo.size >= 0) packages[arch].size = packageInfo.size;
      if (Number.isSafeInteger(packageInfo.blockMapSize) && packageInfo.blockMapSize >= 0) {
        packages[arch].blockMapSize = packageInfo.blockMapSize;
      }
    }
    if (Object.keys(packages).length) normalized.packages = packages;
  }
  const output = yaml.dump(normalized, { noRefs: true, lineWidth: -1 });
  if (Buffer.byteLength(output) > MAX_METADATA_BYTES) {
    throw new UpdateMetadataError('Normalized metadata response is too large');
  }
  return output;
}

function getResponseHeader(response, name) {
  if (!response) return '';
  if (response.headers && typeof response.headers.get === 'function') return response.headers.get(name) || '';
  const headers = response.headers || {};
  const key = Object.keys(headers).find(item => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : response[name];
  return Array.isArray(value) ? value[0] : String(value || '');
}

function ensureMetadataBodySize(body, maxBytes) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (value.length > maxBytes) throw new UpdateMetadataError('Metadata response is too large');
  return value.toString('utf8');
}

function fetchHttpsMetadata(url, { timeoutMs = METADATA_TIMEOUT_MS, maxBytes = MAX_METADATA_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      request?.destroy();
      finish(reject, new UpdateMetadataError('Metadata request timed out'));
    }, timeoutMs);
    request = https.get(url, {
      headers: { Accept: 'text/yaml, text/plain', 'User-Agent': 'SerialTerminal-Telemetry' }
    }, response => {
      const length = Number(response.headers['content-length'] || 0);
      if (length > maxBytes) {
        response.destroy();
        return finish(reject, new UpdateMetadataError('Metadata response is too large'));
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          finish(reject, new UpdateMetadataError('Metadata response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, {
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', error => finish(reject, error));
    });
    request.on('error', error => finish(reject, error));
  });
}

async function readMetadataResponse(response, maxBytes) {
  if (typeof response === 'string' || Buffer.isBuffer(response)) return ensureMetadataBodySize(response, maxBytes);
  if (!response || typeof response !== 'object') throw new UpdateMetadataError('Invalid metadata response');
  let body = response.body;
  if (body === undefined && typeof response.text === 'function') body = await response.text();
  if (body === undefined && response.data !== undefined) body = response.data;
  if (body === undefined) body = '';
  return ensureMetadataBodySize(body, maxBytes);
}

async function fetchAndNormalizeMetadata(metadataUrl, {
  allowedHosts,
  fetchMetadata = fetchHttpsMetadata,
  timeoutMs = METADATA_TIMEOUT_MS,
  maxBytes = MAX_METADATA_BYTES
}) {
  let currentUrl = metadataUrl;
  for (let redirects = 0; redirects <= MAX_METADATA_REDIRECTS; redirects++) {
    const validCurrentUrl = redirects === 0
      ? validateUpdateMetadataUrl(currentUrl, allowedHosts)
      : validateAssetUrl(currentUrl, metadataUrl, allowedHosts);
    if (!validCurrentUrl || isUpdateMetadataEntryUrl(validCurrentUrl)) {
      throw new UpdateMetadataError('Metadata URL is not an allowed HTTPS latest.yml URL');
    }
    let response;
    try {
      response = await fetchMetadata(currentUrl, { timeoutMs, maxBytes });
    } catch (error) {
      if (error instanceof UpdateMetadataError) throw error;
      throw new UpdateMetadataError(`Metadata request failed: ${error.message}`);
    }
    const status = typeof response === 'string' || Buffer.isBuffer(response)
      ? 200
      : Number(response?.statusCode ?? response?.status ?? 200);
    if (status >= 300 && status < 400) {
      if (redirects === MAX_METADATA_REDIRECTS) throw new UpdateMetadataError('Too many metadata redirects');
      const location = getResponseHeader(response, 'location');
      if (!location) throw new UpdateMetadataError('Metadata redirect has no location');
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new UpdateMetadataError('Metadata redirect URL is invalid');
      }
      if (!validateAssetUrl(nextUrl, currentUrl, allowedHosts) || isUpdateMetadataEntryUrl(nextUrl)) {
        throw new UpdateMetadataError('Metadata redirect URL is not allowed');
      }
      currentUrl = nextUrl;
      continue;
    }
    if (status < 200 || status >= 300) throw new UpdateMetadataError(`Metadata request returned HTTP ${status}`);
    const body = await readMetadataResponse(response, maxBytes);
    let manifest;
    try {
      manifest = yaml.load(body);
    } catch {
      throw new UpdateMetadataError('Metadata YAML is invalid');
    }
    return normalizeManifest(manifest, metadataUrl, allowedHosts);
  }
  throw new UpdateMetadataError('Too many metadata redirects');
}

function policyFromRow(row) {
  if (!row) return null;
  const value = (camel, snake) => row[camel] !== undefined ? row[camel] : row[snake];
  const priority = Number(value('priority', 'priority'));
  return {
    id: value('id', 'id'),
    metadataUrl: value('metadataUrl', 'metadata_url'),
    channel: value('channel', 'channel') || null,
    minClientVersion: value('minClientVersion', 'min_client_version') || null,
    maxClientVersion: value('maxClientVersion', 'max_client_version') || null,
    enabled: value('enabled', 'enabled') === true,
    legacy: value('legacy', 'legacy') === true,
    priority: Number.isSafeInteger(priority) ? priority : 0,
    createdAt: value('createdAt', 'created_at'),
    updatedAt: value('updatedAt', 'updated_at'),
    updatedBy: value('updatedBy', 'updated_by')
  };
}

function comparePolicyIds(left, right) {
  const leftId = String(left.id);
  const rightId = String(right.id);
  if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) return compareNumericStrings(leftId, rightId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function comparePolicies(left, right) {
  const priorityComparison = Number(right.priority) - Number(left.priority);
  return priorityComparison || comparePolicyIds(left, right);
}

function selectUpdatePolicy(rows, client) {
  const policies = rows.map(policyFromRow).filter(Boolean);
  if (client.legacy) {
    return policies.filter(policy => policy.enabled && policy.legacy).sort(comparePolicies)[0] || null;
  }
  return policies.filter(policy => {
    if (!policy.enabled || policy.legacy) return false;
    if (policy.channel && policy.channel !== (client.channel || '')) return false;
    if (!client.channel && policy.channel) return false;
    if (!client.version) return !policy.minClientVersion && !policy.maxClientVersion;
    if (policy.minClientVersion && compareSemver(client.version, policy.minClientVersion) < 0) return false;
    if (policy.maxClientVersion && compareSemver(client.version, policy.maxClientVersion) > 0) return false;
    return true;
  }).sort(comparePolicies)[0] || null;
}

function getClientUpdateHeaders(request) {
  const versionHeader = request.headers['x-serialterminal-version'];
  const channelHeader = request.headers['x-serialterminal-channel'];
  if ((versionHeader === undefined) !== (channelHeader === undefined)) {
    return { error: 'invalid_update_headers' };
  }
  if (versionHeader !== undefined && (typeof versionHeader !== 'string' || !parseSemver(versionHeader))) {
    return { error: 'invalid_update_headers' };
  }
  if (channelHeader !== undefined && (typeof channelHeader !== 'string' || !channelHeader.trim() || channelHeader.trim().length > 64)) {
    return { error: 'invalid_update_headers' };
  }
  return {
    legacy: versionHeader === undefined && channelHeader === undefined,
    version: versionHeader,
    channel: channelHeader === undefined ? null : channelHeader.trim()
  };
}

function validatePolicyPayload(payload, allowedHosts) {
  if (!isPlainObject(payload) || Object.keys(payload).length !== POLICY_FIELDS.length
    || POLICY_FIELDS.some(field => !Object.prototype.hasOwnProperty.call(payload, field))) return null;
  const metadataUrl = typeof payload.metadataUrl === 'string'
    ? validateUpdateMetadataUrl(payload.metadataUrl.trim(), allowedHosts) : '';
  if (!metadataUrl || isUpdateMetadataEntryUrl(metadataUrl)
    || typeof payload.enabled !== 'boolean' || typeof payload.legacy !== 'boolean'
    || !Number.isSafeInteger(payload.priority) || payload.priority < -2147483648 || payload.priority > 2147483647) return null;

  let channel = null;
  if (payload.channel !== null) {
    if (typeof payload.channel !== 'string') return null;
    channel = payload.channel.trim() || null;
    if (channel && channel.length > 64) return null;
  }
  const versions = {};
  for (const field of ['minClientVersion', 'maxClientVersion']) {
    if (payload[field] === null) {
      versions[field] = null;
    } else {
      if (typeof payload[field] !== 'string' || !parseSemver(payload[field].trim())) return null;
      versions[field] = payload[field].trim();
    }
  }
  if (versions.minClientVersion && versions.maxClientVersion
    && compareSemver(versions.minClientVersion, versions.maxClientVersion) > 0) return null;
  if (payload.legacy && (channel || versions.minClientVersion || versions.maxClientVersion)) return null;
  return {
    metadataUrl,
    channel,
    minClientVersion: versions.minClientVersion,
    maxClientVersion: versions.maxClientVersion,
    enabled: payload.enabled,
    legacy: payload.legacy,
    priority: payload.priority
  };
}

function isUpdateMetadataEntryUrl(value) {
  try {
    const candidate = new URL(value);
    const entry = new URL(UPDATE_METADATA_ENTRY_URL);
    return candidate.origin === entry.origin && candidate.pathname === entry.pathname;
  } catch {
    return false;
  }
}

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
  const allowedMetadataHosts = getHostRules(config.updateMetadataHosts);
  const fetchMetadata = config.fetchMetadata || fetchHttpsMetadata;
  const manifestHeaders = {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Vary: 'X-SerialTerminal-Version, X-SerialTerminal-Channel'
  };

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
      if (request.method === 'GET' && url.pathname === `${BASE}/api/v1/update-source`) {
        return sendJson(response, 200, { schemaVersion: 1, metadataUrl: UPDATE_METADATA_ENTRY_URL });
      }
      if (request.method === 'GET' && url.pathname === `${BASE}/latest.yml`) {
        const client = getClientUpdateHeaders(request);
        if (client.error) return sendJson(response, 400, { error: client.error }, manifestHeaders);
        const policy = selectUpdatePolicy(await store.getUpdatePolicies(), client);
        if (!policy) return sendJson(response, 404, { error: 'update_policy_not_found' }, manifestHeaders);
        if (isUpdateMetadataEntryUrl(policy.metadataUrl)) {
          return sendJson(response, 503, { error: 'update_metadata_unavailable' }, manifestHeaders);
        }
        try {
          const manifest = await fetchAndNormalizeMetadata(policy.metadataUrl, {
            allowedHosts: allowedMetadataHosts,
            fetchMetadata
          });
          return send(response, 200, manifest, 'text/yaml; charset=utf-8', manifestHeaders);
        } catch (error) {
          if (error instanceof UpdateMetadataError) {
            return sendJson(response, error.statusCode, { error: error.code }, manifestHeaders);
          }
          throw error;
        }
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
        if (request.method === 'GET' && url.pathname === `${BASE}/admin/api/update-policies`) {
          const policies = (await store.getUpdatePolicies()).map(policyFromRow);
          return sendJson(response, 200, { policies });
        }
        const policyIdMatch = new RegExp(`^${BASE}/admin/api/update-policies/([1-9][0-9]*)$`).exec(url.pathname);
        if ((request.method === 'POST' && url.pathname === `${BASE}/admin/api/update-policies`)
          || (request.method === 'PUT' && policyIdMatch)) {
          const csrf = request.headers['x-csrf-token'];
          if (validRequestMetadata(request) === false || hashToken(csrf || '') !== session.csrf_hash) {
            return sendJson(response, 403, { error: 'forbidden' });
          }
          if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
            return sendJson(response, 415, { error: 'content_type' });
          }
          const policy = validatePolicyPayload(JSON.parse(await readBody(request, 4096)), allowedMetadataHosts);
          if (!policy) return sendJson(response, 400, { error: 'invalid_update_policy' });
          const policyId = policyIdMatch?.[1] || null;
          const existingPolicies = await store.getUpdatePolicies();
          if (policy.legacy && existingPolicies.some(existing => {
            const current = policyFromRow(existing);
            return current.legacy && String(current.id) !== policyId;
          })) return sendJson(response, 409, { error: 'legacy_policy_conflict' });
          try {
            const saved = policyId
              ? await store.updateUpdatePolicy(policyId, policy, config.adminUsername, clock())
              : await store.createUpdatePolicy(policy, config.adminUsername, clock());
            if (!saved) return sendJson(response, 404, { error: 'policy_not_found' });
            return sendJson(response, request.method === 'POST' ? 201 : 200, policyFromRow(saved));
          } catch (error) {
            if (error?.code === '23505') return sendJson(response, 409, { error: 'legacy_policy_conflict' });
            throw error;
          }
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
    updateMetadataHosts: process.env.UPDATE_METADATA_HOSTS
      ? normalizeAllowedHosts(process.env.UPDATE_METADATA_HOSTS)
      : undefined,
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

module.exports = { createTelemetryServer, loadConfig, validateUpdateMetadataUrl };

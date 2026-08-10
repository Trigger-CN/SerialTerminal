'use strict';

const UPDATE_SOURCE_ENDPOINT = 'https://trigger-cn.top/serialterminal/api/v1/update-source';
const SERVER_UPDATE_METADATA_URL = 'https://trigger-cn.top/serialterminal/latest.yml';
const COS_UPDATE_METADATA_URL = 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml';
const GITHUB_UPDATE_METADATA_URL = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest.yml';
const RESOLVER_TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 4096;

function validateMetadataUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Update metadata URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('Update metadata URL must use HTTPS without credentials, fragments, or a custom port');
  }
  if (!url.hostname || !/\/latest\.yml$/i.test(url.pathname)) {
    throw new Error('Update metadata URL must point to latest.yml');
  }
  return url.toString();
}

function buildUpdateMetadataCandidates(primaryUrl) {
  return [...new Set([
    validateMetadataUrl(primaryUrl),
    SERVER_UPDATE_METADATA_URL,
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ])];
}

async function resolveUpdateMetadataUrl({
  fallbackUrl,
  fetchImpl = fetch,
  endpoint = UPDATE_SOURCE_ENDPOINT,
  timeoutMs = RESOLVER_TIMEOUT_MS,
  logger = console
}) {
  const fallback = validateMetadataUrl(fallbackUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'SerialTerminal-Update-Resolver' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentLength = Number(response.headers?.get?.('content-length') || 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error('response is too large');
    const body = await readLimitedResponse(response, MAX_RESPONSE_BYTES);
    const payload = JSON.parse(body);
    if (!payload || Object.keys(payload).length !== 2 || payload.schemaVersion !== 1 || typeof payload.metadataUrl !== 'string') {
      throw new Error('response schema is invalid');
    }
    return { metadataUrl: validateMetadataUrl(payload.metadataUrl), source: 'resolver' };
  } catch (error) {
    logger.warn(`Update source resolver unavailable; using fallback: ${error.message}`);
    return { metadataUrl: fallback, source: 'fallback' };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedResponse(response, maxBytes) {
  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw new Error('response is too large');
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('response is too large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

module.exports = {
  COS_UPDATE_METADATA_URL,
  GITHUB_UPDATE_METADATA_URL,
  MAX_RESPONSE_BYTES,
  RESOLVER_TIMEOUT_MS,
  SERVER_UPDATE_METADATA_URL,
  UPDATE_SOURCE_ENDPOINT,
  buildUpdateMetadataCandidates,
  resolveUpdateMetadataUrl,
  validateMetadataUrl
};

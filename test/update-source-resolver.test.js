'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COS_UPDATE_METADATA_URL,
  GITHUB_UPDATE_METADATA_URL,
  SERVER_UPDATE_METADATA_URL,
  buildUpdateMetadataCandidates,
  resolveUpdateMetadataUrl,
  validateMetadataUrl
} = require('../update-source-resolver');

const fallbackUrl = 'https://fallback.example/releases/latest/latest.yml';

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[name.toLowerCase()] || null; } },
    async text() { return body; }
  };
}

test('resolver accepts a valid HTTPS latest.yml source', async () => {
  const result = await resolveUpdateMetadataUrl({
    fallbackUrl,
    fetchImpl: async () => response(200, JSON.stringify({ schemaVersion: 1, metadataUrl: 'https://cdn.example/releases/latest/latest.yml' })),
    logger: { warn() {} }
  });
  assert.deepEqual(result, { metadataUrl: 'https://cdn.example/releases/latest/latest.yml', source: 'resolver' });
});

test('resolver falls back for network and schema failures', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async () => response(200, '{bad json'),
    async () => response(200, JSON.stringify({ schemaVersion: 2, metadataUrl: fallbackUrl })),
    async () => response(200, JSON.stringify({ schemaVersion: 1, metadataUrl: 'http://cdn.example/latest.yml' }))
  ]) {
    const result = await resolveUpdateMetadataUrl({ fallbackUrl, fetchImpl, logger: { warn() {} } });
    assert.deepEqual(result, { metadataUrl: fallbackUrl, source: 'fallback' });
  }
});

test('resolver rejects oversized responses and unsafe metadata URLs', async () => {
  const result = await resolveUpdateMetadataUrl({
    fallbackUrl,
    fetchImpl: async () => response(200, 'x'.repeat(4097)),
    logger: { warn() {} }
  });
  assert.equal(result.source, 'fallback');
  for (const value of [
    'http://example.com/latest.yml',
    'https://user:pass@example.com/latest.yml',
    'https://example.com:8443/latest.yml',
    'https://example.com/releases/channel.yml'
  ]) assert.throws(() => validateMetadataUrl(value));
});

test('metadata candidates fall back through server, COS, and GitHub without duplicates', () => {
  assert.deepEqual(buildUpdateMetadataCandidates('https://custom.example/releases/latest.yml'), [
    'https://custom.example/releases/latest.yml',
    SERVER_UPDATE_METADATA_URL,
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ]);
  assert.deepEqual(buildUpdateMetadataCandidates(SERVER_UPDATE_METADATA_URL), [
    SERVER_UPDATE_METADATA_URL,
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ]);
});

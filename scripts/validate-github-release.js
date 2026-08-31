'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Agent, fetch: undiciFetch } = require('undici');
const { compareReleaseTags, parseReleaseTag } = require('./validate-release-tag');

const GITHUB_API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function parseArguments(args) {
  const options = { files: [], promote: false };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--promote') {
      options.promote = true;
      continue;
    }
    if (name === '--files') {
      options.files = args.slice(index + 1);
      break;
    }
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  for (const name of ['owner', 'repo', 'tag']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (options.files.length === 0) throw new Error('Missing --files');
  parseReleaseTag(options.tag);
  return options;
}

function createGitHubReleaseValidator({
  token,
  fetchImpl = undiciFetch,
  apiRoot = GITHUB_API_ROOT,
  dispatcher = new Agent({ headersTimeout: REQUEST_TIMEOUT_MS, bodyTimeout: REQUEST_TIMEOUT_MS }),
  hashAsset
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const root = new URL(apiRoot);

  async function requestJson(endpoint, { allowNotFound = false, method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(new URL(endpoint, root), {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'SerialTerminal-Release-Validator',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        dispatcher,
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: controller.signal
      });
      if (allowNotFound && response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub API ${endpoint} returned HTTP ${response.status}`);
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function validate({ owner, repo, tag, files, promote = false }) {
    const releaseTag = parseReleaseTag(tag);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
    if (!releaseTag.prerelease) {
      const latest = await requestJson(`${base}/latest`, { allowNotFound: true });
      if (latest && compareReleaseTags(tag, latest.tag_name) < 0) {
        throw new Error(`GitHub latest cannot move backward from ${latest.tag_name} to ${tag}`);
      }
    }

    let release = await requestJson(`${base}/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    if (!release) {
      for (let page = 1; page <= 3 && !release; page++) {
        const releases = await requestJson(`${base}?per_page=100&page=${page}`);
        release = releases.find(item => item.tag_name === tag) || null;
        if (releases.length < 100) break;
      }
    }
    if (!release) return { releaseExists: false, verifiedAssets: 0 };
    if (release.prerelease !== releaseTag.prerelease) {
      throw new Error(`GitHub release prerelease status does not match ${tag}`);
    }
    const localFiles = new Map();
    for (const filePath of files) {
      const name = path.basename(filePath);
      if (localFiles.has(name)) throw new Error(`Duplicate local release asset: ${name}`);
      const { size } = await fs.promises.stat(filePath);
      localFiles.set(name, { filePath, size, sha512: await hashFile(filePath) });
    }

    const seenAssets = new Set();
    for (const asset of release.assets || []) {
      if (seenAssets.has(asset.name)) throw new Error(`Duplicate GitHub release asset: ${asset.name}`);
      seenAssets.add(asset.name);
      const local = localFiles.get(asset.name);
      if (!local) throw new Error(`Unexpected GitHub release asset for ${tag}: ${asset.name}`);
      if (asset.size !== local.size) throw new Error(`GitHub release asset size mismatch: ${asset.name}`);
      const remote = hashAsset
        ? await hashAsset(asset, local.size)
        : await hashGitHubAsset(asset, local.size, { token, fetchImpl, dispatcher, apiHostname: root.hostname });
      if (remote.size !== local.size || remote.sha512 !== local.sha512) {
        throw new Error(`GitHub immutable release asset differs from local release: ${asset.name}`);
      }
    }
    const requireCompleteRelease = promote || !release.draft;
    if (requireCompleteRelease && seenAssets.size !== localFiles.size) {
      const missing = [...localFiles.keys()].filter(name => !seenAssets.has(name));
      throw new Error(`GitHub release is missing required asset(s): ${missing.join(', ')}`);
    }
    if (promote) {
      if (release.draft) {
        await requestJson(`${base}/${release.id}`, {
          method: 'PATCH',
          body: { draft: false, make_latest: releaseTag.prerelease ? 'false' : 'true' }
        });
      }
    }
    return { releaseExists: true, promoted: Boolean(promote && release.draft), verifiedAssets: seenAssets.size };
  }

  return { validate };
}

async function hashGitHubAsset(asset, maxBytes, { token, fetchImpl, dispatcher, apiHostname }) {
  let currentUrl = validateGitHubDownloadUrl(asset.url, apiHostname);
  let sendAuthorization = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetchImpl(currentUrl, {
        headers: {
          Accept: 'application/octet-stream',
          ...(sendAuthorization ? { Authorization: `Bearer ${token}` } : {}),
          'User-Agent': 'SerialTerminal-Release-Validator',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        dispatcher,
        redirect: 'manual',
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('GitHub asset redirect is invalid');
        currentUrl = validateGitHubDownloadUrl(new URL(location, currentUrl).toString());
        sendAuthorization = false;
        continue;
      }
      if (!response.ok) throw new Error(`GitHub asset download returned HTTP ${response.status}`);
      return hashResponse(response, maxBytes);
    }
    throw new Error('Too many GitHub asset redirects');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function validateGitHubDownloadUrl(value, requiredHostname = '') {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('GitHub asset URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.hostname.endsWith('.')) {
    throw new Error('GitHub asset URL must use safe HTTPS');
  }
  if (requiredHostname && url.hostname !== requiredHostname) throw new Error('GitHub API asset URL has an unexpected host');
  if (!requiredHostname && !isGitHubDownloadHostname(url.hostname)) throw new Error('GitHub asset redirect has an unexpected host');
  return url.toString();
}

function isGitHubDownloadHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'github.com' || value.endsWith('.github.com') || value.endsWith('.githubusercontent.com');
}

async function hashFile(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('GitHub release asset is larger than the local file');
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('GitHub release asset is larger than the local file');
    hash.update(chunk);
  }
  return { size, sha512: hash.digest('hex') };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const validator = createGitHubReleaseValidator({ token: process.env.GITHUB_TOKEN });
  const result = await validator.validate(options);
  console.log(`GitHub release preflight complete: ${result.verifiedAssets} existing asset(s) verified`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createGitHubReleaseValidator,
  hashGitHubAsset,
  parseArguments,
  validateGitHubDownloadUrl
};

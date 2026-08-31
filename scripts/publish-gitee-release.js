'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Agent, fetch: undiciFetch } = require('undici');
const yaml = require('js-yaml');
const { parseReleaseTag } = require('./validate-release-tag');

const API_ROOT = 'https://gitee.com/api/v5';
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const GITEE_TIMEOUT_MS = 30 * 60 * 1000;
const PROGRESS_INTERVAL_MS = 5000;
const UPLOAD_HEARTBEAT_MS = 60 * 1000;

function parseArguments(args) {
  const options = { files: [] };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--files') {
      options.files = args.slice(index + 1);
      break;
    }
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  for (const name of ['owner', 'repo', 'tag', 'target', 'notes']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  return options;
}

function createGiteePublisher({
  token,
  fetchImpl = undiciFetch,
  downloadImpl = undiciFetch,
  apiRoot = API_ROOT,
  wait = delay,
  dispatcher = new Agent({ headersTimeout: GITEE_TIMEOUT_MS, bodyTimeout: GITEE_TIMEOUT_MS }),
  logger = console,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
}) {
  if (!token) throw new Error('GITEE_ACCESS_TOKEN is required');

  async function request(method, endpoint, { body, upload, allowNotFound = false, retry = true } = {}) {
    const url = new URL(`${apiRoot}${endpoint}`);
    url.searchParams.set('access_token', token);
    const retryDelays = retry ? RETRY_DELAYS_MS : [];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      const startedAt = now();
      logger.log(`[gitee] ${method} ${endpoint} attempt ${attempt + 1}/${retryDelays.length + 1}`);
      try {
        const options = { method, headers: {}, dispatcher };
        if (body) {
          options.headers['Content-Type'] = 'application/json';
          options.body = JSON.stringify(body);
        } else if (upload) {
          Object.assign(options.headers, upload.headers);
          options.body = upload.body;
          options.duplex = 'half';
        }
        const response = await fetchImpl(url, options);
        logger.log(`[gitee] ${method} ${endpoint} -> HTTP ${response.status} in ${formatDuration(now() - startedAt)}`);
        if (allowNotFound && response.status === 404) return null;
        if (response.ok) return response.status === 204 ? null : response.json();

        const details = (await response.text()).slice(0, 500);
        if (!isRetryableStatus(response.status) || attempt === retryDelays.length) {
          throw new Error(`Gitee API ${method} ${endpoint} failed: HTTP ${response.status}${details ? ` ${details}` : ''}`);
        }
      } catch (error) {
        logger.error(`[gitee] ${method} ${endpoint} attempt ${attempt + 1} failed after ${formatDuration(now() - startedAt)}: ${formatError(error)}`);
        if (attempt === retryDelays.length || /^Gitee API .* failed: HTTP (?!429|5\d\d)/.test(error.message)) {
          throw new Error(`Gitee API ${method} ${endpoint} failed after ${attempt + 1} attempt(s): ${error.message}`, { cause: error });
        }
      }
      logger.log(`[gitee] retrying ${method} ${endpoint} in ${formatDuration(retryDelays[attempt])}`);
      await wait(retryDelays[attempt]);
    }
  }

  async function publish({ owner, repo, tag, target, name, notes, files = [] }) {
    const releaseTag = parseReleaseTag(tag);
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases`;
    const releaseBody = {
      tag_name: tag,
      target_commitish: target,
      name: name || tag,
      body: notes,
      prerelease: releaseTag.prerelease
    };
    let release = await request('GET', `${base}/tags/${encodeURIComponent(tag)}`, { allowNotFound: true });
    const releaseExists = Boolean(release);
    if (!release) {
      release = await request('POST', base, { body: releaseBody });
    }

    if (files.length === 0) {
      return releaseExists ? request('PATCH', `${base}/${release.id}`, { body: releaseBody }) : release;
    }

    const attachmentsEndpoint = `${base}/${release.id}/attach_files`;
    let attachments = await request('GET', attachmentsEndpoint);
    const assetUrls = new Map();

    async function verifyExistingAttachment(attachment, source, fileName) {
      const downloadUrl = validateAttachmentUrl(getAttachmentUrl(attachment));
      const expectedHash = source.sha512 || (source.buffer ? hashBuffer(source.buffer) : await hashFile(source.filePath));
      const remote = await downloadAndHashAttachment(downloadUrl, source.size, {
        downloadImpl,
        dispatcher
      });
      if (remote.size !== source.size || remote.sha512 !== expectedHash) {
        throw new Error(`Gitee immutable attachment differs from local release: ${fileName}`);
      }
      logger.log(`[gitee] immutable attachment already matches: ${fileName}`);
      return attachment;
    }

    async function uploadAttachment(source, fileName) {
      const upload = createMultipartUpload(source, fileName, {
        logger,
        now,
        progressIntervalMs: PROGRESS_INTERVAL_MS
      });
      const startedAt = now();
      logger.log(`[gitee] upload start: ${fileName}, ${formatBytes(source.size)}, content-length ${formatBytes(upload.contentLength)}`);
      const heartbeat = setIntervalImpl(() => {
        logger.log(`[gitee] upload heartbeat: ${fileName}, ${formatBytes(upload.transferred())}/${formatBytes(source.size)} read, waiting ${formatDuration(now() - startedAt)} for Gitee response`);
      }, UPLOAD_HEARTBEAT_MS);
      try {
        const uploaded = await request('POST', attachmentsEndpoint, { upload, retry: false });
        logger.log(`[gitee] upload accepted: ${fileName}, ${formatBytes(upload.transferred())} sent in ${formatDuration(now() - startedAt)}`);
        return uploaded;
      } catch (uploadError) {
        logger.error(`[gitee] upload uncertain: ${fileName}, ${formatBytes(upload.transferred())}/${formatBytes(source.size)} sent in ${formatDuration(now() - startedAt)}, ${formatError(uploadError)}`);
        // A timed-out upload may have completed on Gitee even though no response arrived.
        for (const waitMilliseconds of RETRY_DELAYS_MS) {
          logger.log(`[gitee] checking remote attachment ${fileName} in ${formatDuration(waitMilliseconds)}`);
          await wait(waitMilliseconds);
          attachments = await request('GET', attachmentsEndpoint);
          const uploaded = attachments.find(item => item.name === fileName);
          logger.log(`[gitee] remote attachment check: ${attachments.length} attachment(s), ${fileName} ${uploaded ? 'found' : 'not found'}`);
          if (uploaded) {
            await verifyExistingAttachment(uploaded, source, fileName);
            logger.log(`[gitee] upload recovered from remote state: ${fileName}`);
            return uploaded;
          }
        }
        throw uploadError;
      } finally {
        clearIntervalImpl(heartbeat);
      }
    }

    const uploadFiles = [...files].sort((left, right) => {
      const leftIsMetadata = /(?:^|[\\/])latest(?:-linux)?\.yml$/i.test(left);
      const rightIsMetadata = /(?:^|[\\/])latest(?:-linux)?\.yml$/i.test(right);
      return Number(leftIsMetadata) - Number(rightIsMetadata);
    });
    const artifactSources = [];
    const metadataPaths = [];
    for (const filePath of uploadFiles) {
      const fileName = path.basename(filePath);
      if (/^latest(?:-linux)?\.yml$/i.test(fileName)) {
        metadataPaths.push(filePath);
        continue;
      }
      const { size } = await fs.promises.stat(filePath);
      const source = { filePath, size, sha512: await hashFile(filePath) };
      const existing = attachments.find(item => item.name === fileName);
      if (existing) {
        await verifyExistingAttachment(existing, source, fileName);
        assetUrls.set(fileName, validateAttachmentUrl(getAttachmentUrl(existing)));
      }
      artifactSources.push({ fileName, source, existing });
    }

    const existingMetadata = metadataPaths
      .map(filePath => attachments.find(item => item.name === path.basename(filePath)))
      .filter(Boolean);
    if (existingMetadata.length > 0 && artifactSources.some(item => !item.existing)) {
      throw new Error('Gitee release has metadata but is missing one or more immutable artifacts');
    }
    const preparedMetadata = [];
    if (artifactSources.every(item => item.existing)) {
      for (const filePath of metadataPaths) {
        const fileName = path.basename(filePath);
        const source = await createMetadataSource(filePath, assetUrls);
        const existing = attachments.find(item => item.name === fileName);
        if (existing) await verifyExistingAttachment(existing, source, fileName);
        preparedMetadata.push({ fileName, source, existing });
      }
    }

    for (const item of artifactSources) {
      if (item.existing) continue;
      const uploaded = await uploadAttachment(item.source, item.fileName);
      assetUrls.set(item.fileName, validateAttachmentUrl(getAttachmentUrl(uploaded)));
      attachments = await request('GET', attachmentsEndpoint);
    }
    if (preparedMetadata.length === 0) {
      for (const filePath of metadataPaths) {
        preparedMetadata.push({
          fileName: path.basename(filePath),
          source: await createMetadataSource(filePath, assetUrls),
          existing: null
        });
      }
    }
    for (const item of preparedMetadata) {
      if (item.existing) {
        assetUrls.set(item.fileName, validateAttachmentUrl(getAttachmentUrl(item.existing)));
        continue;
      }
      const uploaded = await uploadAttachment(item.source, item.fileName);
      assetUrls.set(item.fileName, validateAttachmentUrl(getAttachmentUrl(uploaded)));
      attachments = await request('GET', attachmentsEndpoint);
    }
    if (releaseExists) release = await request('PATCH', `${base}/${release.id}`, { body: releaseBody });
    return release;
  }

  return { publish };
}

function getAttachmentUrl(attachment) {
  return attachment?.browser_download_url || attachment?.download_url || attachment?.url || '';
}

async function createMetadataSource(filePath, assetUrls) {
  const metadata = yaml.load(await fs.promises.readFile(filePath, 'utf8'));
  for (const file of metadata.files || []) {
    const assetUrl = assetUrls.get(path.basename(String(file.url || '')));
    if (assetUrl) file.url = assetUrl;
  }
  const installerUrl = assetUrls.get(path.basename(String(metadata.path || '')));
  if (installerUrl) metadata.path = installerUrl;
  const buffer = Buffer.from(yaml.dump(metadata), 'utf8');
  return { buffer, size: buffer.length, sha512: hashBuffer(buffer) };
}

function validateAttachmentUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('Gitee attachment URL is invalid');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || url.hostname.endsWith('.')) {
    throw new Error('Gitee attachment URL must use safe HTTPS');
  }
  if (!isGiteeHostname(url.hostname)) throw new Error('Gitee attachment URL has an unexpected host');
  return url.toString();
}

function isGiteeHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'gitee.com' || normalized.endsWith('.gitee.com');
}

async function downloadAndHashAttachment(value, maxBytes, { downloadImpl, dispatcher }) {
  let currentUrl = validateAttachmentUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await downloadImpl(currentUrl, {
      method: 'GET',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'SerialTerminal-Gitee-Publisher' },
      redirect: 'manual',
      dispatcher
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.('location');
      if (!location || redirects === 3) throw new Error('Gitee attachment redirect is invalid');
      currentUrl = validateAttachmentUrl(new URL(location, currentUrl).toString());
      continue;
    }
    if (!response.ok) throw new Error(`Gitee attachment download failed: HTTP ${response.status}`);
    return hashResponse(response, maxBytes);
  }
  throw new Error('Too many Gitee attachment redirects');
}

function hashBuffer(buffer) {
  return createHash('sha512').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashResponse(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('Gitee attachment is larger than the local release');
  const hash = createHash('sha512');
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Gitee attachment is larger than the local release');
      hash.update(chunk);
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());
    size = buffer.length;
    if (size > maxBytes) throw new Error('Gitee attachment is larger than the local release');
    hash.update(buffer);
  }
  return { size, sha512: hash.digest('hex') };
}

function createMultipartUpload(source, fileName, { logger, now, progressIntervalMs }) {
  const boundary = `----serialterminal-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const safeFileName = fileName.replace(/["\r\n]/g, '_');
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
    'Content-Type: application/octet-stream\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = prefix.length + source.size + suffix.length;
  let transferred = 0;
  const startedAt = now();
  let lastProgressAt = startedAt;

  async function *body() {
    yield prefix;
    const chunks = source.buffer ? [source.buffer] : fs.createReadStream(source.filePath);
    for await (const chunk of chunks) {
      transferred += chunk.length;
      const currentTime = now();
      if (currentTime - lastProgressAt >= progressIntervalMs || transferred === source.size) {
        const elapsed = Math.max(currentTime - startedAt, 1);
        const percentage = source.size === 0 ? 100 : transferred / source.size * 100;
        logger.log(`[gitee] upload progress: ${fileName}, ${formatBytes(transferred)}/${formatBytes(source.size)} (${percentage.toFixed(1)}%), ${formatSpeed(transferred, elapsed)}`);
        lastProgressAt = currentTime;
      }
      yield chunk;
    }
    yield suffix;
    logger.log(`[gitee] upload body complete: ${fileName}, ${formatBytes(transferred)} read; waiting for Gitee response`);
  }

  return {
    body: body(),
    contentLength,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(contentLength)
    },
    transferred: () => transferred
  };
}

function formatError(error) {
  const parts = [];
  const visited = new Set();
  for (let current = error; current && !visited.has(current); current = current.cause) {
    visited.add(current);
    const identity = [current.name, current.code].filter(Boolean).join('/');
    const message = current.message || String(current);
    parts.push(`${identity ? `${identity}: ` : ''}${message}`);
  }
  return parts.join(' <- cause: ');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(2)} ${units[unit]}`;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds >= 60 * 1000) {
    const minutes = Math.floor(milliseconds / (60 * 1000));
    const seconds = Math.floor(milliseconds % (60 * 1000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

function formatSpeed(bytes, milliseconds) {
  return `${formatBytes(bytes / (milliseconds / 1000))}/s avg`;
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const notes = await fs.promises.readFile(options.notes, 'utf8');
  for (const filePath of options.files) {
    await fs.promises.access(filePath, fs.constants.R_OK);
  }
  const publisher = createGiteePublisher({ token: process.env.GITEE_ACCESS_TOKEN });
  const release = await publisher.publish({ ...options, notes, name: `SerialTerminal ${options.tag.replace(/^v/, '')}` });
  console.log(`Published Gitee release ${release.tag_name || options.tag} with ${options.files.length} artifact(s)`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  createGiteePublisher,
  createMultipartUpload,
  downloadAndHashAttachment,
  formatError,
  parseArguments,
  validateAttachmentUrl
};

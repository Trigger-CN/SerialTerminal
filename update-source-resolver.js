'use strict';

const GITEE_LATEST_RELEASE_API_URL = 'https://gitee.com/api/v5/repos/trigger-cn/SerialTerminal/releases/latest';
const DYNAMIC_UPDATE_METADATA_URL = 'https://trigger-cn.top/serialterminal/latest.yml';
const COS_UPDATE_METADATA_URL = 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/latest.yml';
const GITHUB_UPDATE_METADATA_URL = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest.yml';
const GITHUB_LINUX_UPDATE_METADATA_URL = 'https://github.com/Trigger-CN/SerialTerminal/releases/latest/download/latest-linux.yml';
const RESOLVER_TIMEOUT_MS = 3000;
const MAX_GITEE_RESPONSE_BYTES = 256 * 1024;
const MAX_UPDATE_METADATA_BYTES = 512 * 1024;

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
  if (!url.hostname || !/\/latest(?:-linux)?\.yml$/i.test(url.pathname)) {
    throw new Error('Update metadata URL must point to latest.yml or latest-linux.yml');
  }
  return url.toString();
}

function buildUpdateMetadataCandidates(giteeMetadataUrl, platform = 'win32') {
  if (platform === 'linux') return [GITHUB_LINUX_UPDATE_METADATA_URL];
  const candidates = [DYNAMIC_UPDATE_METADATA_URL];
  if (giteeMetadataUrl) {
    const url = validateMetadataUrl(giteeMetadataUrl);
    if (!isGiteeHostname(new URL(url).hostname)) {
      throw new Error('Primary update metadata URL must use Gitee');
    }
    candidates.push(url);
  }
  return [...new Set([...candidates, COS_UPDATE_METADATA_URL, GITHUB_UPDATE_METADATA_URL])];
}

function getUpdateChannel(metadataUrl, updateInfo, platform = 'win32', packageType = '') {
  const extension = getUpdateArtifactExtension(platform, packageType);
  const pattern = new RegExp(`${extension}(?:$|[?#])`, 'i');
  const installer = Array.isArray(updateInfo?.files)
    ? updateInfo.files.find(file => pattern.test(String(file?.url || file?.name || '')))
    : null;
  const installerUrl = installer?.url || updateInfo?.path;
  let url;
  try {
    url = new URL(installerUrl || metadataUrl, metadataUrl);
  } catch {
    return '';
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.myqcloud.com')) return 'Tencent COS';
  if (hostname === 'github.com' || hostname.endsWith('.githubusercontent.com')) return 'GitHub';
  if (hostname === 'gitee.com' || hostname.endsWith('.gitee.com')) return 'Gitee';
  if (hostname === 'trigger-cn.top' || hostname.endsWith('.trigger-cn.top')) return 'Trigger-CN';
  return hostname;
}

function compareUpdateVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumericStrings(leftVersion.numbers[index], rightVersion.numbers[index]);
    if (comparison) return comparison;
  }
  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length); index++) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftIsNumber = /^(0|[1-9][0-9]*)$/.test(leftPart);
    const rightIsNumber = /^(0|[1-9][0-9]*)$/.test(rightPart);
    if (leftIsNumber && rightIsNumber) return compareNumericStrings(leftPart, rightPart);
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isSameUpdate(left, right, platform = 'win32', packageType = '') {
  if (!left || !right || left.version !== right.version) return false;
  const leftChecksum = getInstallerChecksum(left, platform, packageType);
  const rightChecksum = getInstallerChecksum(right, platform, packageType);
  return Boolean(leftChecksum && rightChecksum && leftChecksum === rightChecksum);
}

function isUpdateSourceConsistent(metadataUrl, updateInfo, platform = 'win32', packageType = '') {
  if (validateMetadataUrl(metadataUrl) === DYNAMIC_UPDATE_METADATA_URL) return true;
  const metadataChannel = getUpdateChannel(metadataUrl);
  const installerChannel = getUpdateChannel(metadataUrl, updateInfo, platform, packageType);
  return Boolean(metadataChannel && metadataChannel === installerChannel);
}

async function runUpdateSourceFallback(sources, attempt, {
  isCancelled = () => false,
  logger = console
} = {}) {
  const failures = [];
  for (const [index, source] of sources.entries()) {
    try {
      return await attempt(source, index);
    } catch (error) {
      if (isCancelled()) throw error;
      const channel = getUpdateChannel(source) || source;
      failures.push(`${channel}: ${error.message}`);
      logger.warn(`Update download source failed: ${source}`, error);
    }
  }
  throw new Error(`All update download sources failed: ${failures.join('; ')}`);
}

function selectUpdateReleaseCandidates(releases, platform = 'win32', packageType = '') {
  if (!Array.isArray(releases) || releases.length === 0) return [];
  const selected = releases.reduce((best, candidate) => (
    compareUpdateVersions(candidate.info?.version, best.info?.version) > 0 ? candidate : best
  ));
  return releases.filter(candidate => isSameUpdate(selected.info, candidate.info, platform, packageType));
}

async function resolveGiteeUpdateMetadataUrl({
  fetchImpl = fetch,
  endpoint = GITEE_LATEST_RELEASE_API_URL,
  timeoutMs = RESOLVER_TIMEOUT_MS,
  logger = console
} = {}) {
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
    if (contentLength > MAX_GITEE_RESPONSE_BYTES) throw new Error('response is too large');
    const release = JSON.parse(await readLimitedResponse(response, MAX_GITEE_RESPONSE_BYTES));
    const metadataAsset = Array.isArray(release?.assets)
      ? release.assets.find(asset => asset?.name === 'latest.yml')
      : null;
    const metadataUrl = validateMetadataUrl(
      metadataAsset?.browser_download_url || metadataAsset?.download_url || metadataAsset?.url || ''
    );
    if (!isGiteeHostname(new URL(metadataUrl).hostname)) {
      throw new Error('Gitee release metadata URL must use Gitee');
    }
    return metadataUrl;
  } catch (error) {
    logger.warn(`Gitee update metadata unavailable; using fallback sources: ${error.message}`);
    return '';
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

function parseVersion(value) {
  const identifier = '(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)';
  const match = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`).exec(String(value || ''));
  if (!match) throw new Error(`Invalid update version: ${value}`);
  return {
    numbers: match.slice(1, 4),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compareNumericStrings(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function isStableUpdateVersion(value) {
  return parseVersion(value).prerelease.length === 0;
}

function getUpdateArtifactExtension(platform = 'win32', packageType = '') {
  if (platform !== 'linux') return '\\.exe';
  return packageType === 'deb' ? '\\.deb' : '\\.AppImage';
}

function getInstallerChecksum(info, platform = 'win32', packageType = '') {
  const extension = getUpdateArtifactExtension(platform, packageType);
  const pattern = new RegExp(`${extension}(?:$|[?#])`, 'i');
  if (Array.isArray(info?.files) && info.files.length > 0) {
    const installer = info.files.find(file => pattern.test(String(file?.url || file?.name || '')));
    return installer?.sha512 || '';
  }
  return pattern.test(String(info?.path || '')) ? info?.sha512 || '' : '';
}

function isGiteeHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'gitee.com' || normalized.endsWith('.gitee.com');
}

module.exports = {
  COS_UPDATE_METADATA_URL,
  DYNAMIC_UPDATE_METADATA_URL,
  GITEE_LATEST_RELEASE_API_URL,
  GITHUB_LINUX_UPDATE_METADATA_URL,
  GITHUB_UPDATE_METADATA_URL,
  MAX_GITEE_RESPONSE_BYTES,
  MAX_UPDATE_METADATA_BYTES,
  RESOLVER_TIMEOUT_MS,
  buildUpdateMetadataCandidates,
  compareUpdateVersions,
  getUpdateArtifactExtension,
  getUpdateChannel,
  isSameUpdate,
  isStableUpdateVersion,
  isUpdateSourceConsistent,
  resolveGiteeUpdateMetadataUrl,
  readLimitedResponse,
  runUpdateSourceFallback,
  selectUpdateReleaseCandidates,
  validateMetadataUrl
};

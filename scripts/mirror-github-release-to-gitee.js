'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Agent, fetch: undiciFetch } = require('undici');
const { createGiteePublisher, formatError } = require('./publish-gitee-release');

const GITHUB_API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 5000, 10000];
const DEFAULT_COS_RELEASES_ROOT = 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases';

function parseArguments(args) {
  const options = { 'cos-releases-root': DEFAULT_COS_RELEASES_ROOT };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name.startsWith('--') || !args[index + 1]) throw new Error(`Invalid argument: ${name}`);
    options[name.slice(2)] = args[++index];
  }
  for (const name of ['github-owner', 'github-repo', 'gitee-owner', 'gitee-repo', 'tag', 'target']) {
    if (!options[name]) throw new Error(`Missing --${name}`);
  }
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.tag)) {
    throw new Error(`Invalid release tag: ${options.tag}`);
  }
  return options;
}

function createGitHubReleaseClient({
  fetchImpl = undiciFetch,
  apiRoot = GITHUB_API_ROOT,
  wait = delay,
  dispatcher = new Agent({ headersTimeout: REQUEST_TIMEOUT_MS, bodyTimeout: REQUEST_TIMEOUT_MS }),
  logger = console
} = {}) {
  async function request(url, { retry = true } = {}) {
    const retryDelays = retry ? RETRY_DELAYS_MS : [];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      logger.log(`[github] GET ${url} attempt ${attempt + 1}/${retryDelays.length + 1}`);
      try {
        const response = await fetchImpl(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'SerialTerminal-Gitee-Release-Mirror',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          dispatcher,
          redirect: 'follow'
        });
        if (!response.ok) {
          const details = (await response.text()).slice(0, 500);
          const error = new Error(`GitHub request failed: HTTP ${response.status}${details ? ` ${details}` : ''}`);
          error.status = response.status;
          throw error;
        }
        return response;
      } catch (error) {
        if (attempt === retryDelays.length || (error.status && error.status !== 429 && error.status < 500)) throw error;
        await wait(retryDelays[attempt]);
      }
    }
  }

  async function getRelease(owner, repo, tag) {
    const response = await request(`${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`);
    return response.json();
  }

  async function download(url, destination) {
    const response = await request(url, { retry: false });
    await pipeline(response.body, fs.createWriteStream(destination));
  }

  return { download, getRelease };
}

function selectWindowsInstaller(release, tag) {
  const version = tag.replace(/^v/, '');
  const expectedName = `SerialTerminal-Setup-${version}.exe`;
  const matches = (release.assets || []).filter(asset => asset.name === expectedName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one GitHub release asset named ${expectedName}, found ${matches.length}`);
  }
  return matches[0];
}

async function mirrorRelease(options, {
  githubClient = createGitHubReleaseClient(),
  giteePublisher = createGiteePublisher({ token: process.env.GITEE_ACCESS_TOKEN }),
  outputDirectory = path.resolve('release-mirror'),
  downloadOptions = {}
} = {}) {
  const release = await githubClient.getRelease(options['github-owner'], options['github-repo'], options.tag);
  const installer = selectWindowsInstaller(release, options.tag);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const installerPath = path.join(outputDirectory, installer.name);
  const cosUrl = `${options['cos-releases-root'].replace(/\/$/, '')}/${encodeURIComponent(options.tag)}/${encodeURIComponent(installer.name)}`;
  await downloadInstallerWithFallback({
    sources: [
      { name: 'COS', url: cosUrl },
      { name: 'GitHub', url: installer.browser_download_url }
    ],
    destination: installerPath,
    expectedSize: installer.size,
    download: githubClient.download,
    ...downloadOptions
  });
  return giteePublisher.publish({
    owner: options['gitee-owner'],
    repo: options['gitee-repo'],
    tag: options.tag,
    target: options.target,
    name: release.name || `SerialTerminal ${options.tag.replace(/^v/, '')}`,
    notes: release.body || '',
    files: [installerPath]
  });
}

async function downloadInstallerWithFallback({
  sources,
  destination,
  expectedSize,
  download,
  retryDelays = RETRY_DELAYS_MS,
  wait = delay,
  logger = console
}) {
  const temporaryPath = `${destination}.part`;
  const failures = [];
  for (const source of sources) {
    if (!source.url) {
      failures.push(`${source.name}: missing URL`);
      continue;
    }
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      await fs.promises.rm(temporaryPath, { force: true });
      logger.log(`[mirror] download ${source.name} attempt ${attempt + 1}/${retryDelays.length + 1}: ${source.url}`);
      try {
        await download(source.url, temporaryPath);
        const stat = await fs.promises.stat(temporaryPath);
        if (stat.size !== expectedSize) {
          throw new Error(`size mismatch: expected ${expectedSize}, received ${stat.size}`);
        }
        await fs.promises.rm(destination, { force: true });
        await fs.promises.rename(temporaryPath, destination);
        logger.log(`[mirror] download accepted from ${source.name}: ${stat.size} bytes`);
        return source.name;
      } catch (error) {
        failures.push(`${source.name} attempt ${attempt + 1}: ${error.message}`);
        logger.warn(`[mirror] download failed from ${source.name}: ${error.message}`);
        if (attempt < retryDelays.length) await wait(retryDelays[attempt]);
      }
    }
  }
  await fs.promises.rm(temporaryPath, { force: true });
  throw new Error(`All installer download sources failed: ${failures.join('; ')}`);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const release = await mirrorRelease(options);
  console.log(`Mirrored GitHub release ${release.tag_name || options.tag} to Gitee`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_COS_RELEASES_ROOT,
  createGitHubReleaseClient,
  downloadInstallerWithFallback,
  mirrorRelease,
  parseArguments,
  selectWindowsInstaller
};

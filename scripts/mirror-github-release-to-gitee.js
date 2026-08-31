'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Agent, fetch: undiciFetch } = require('undici');
const yaml = require('js-yaml');
const { createGiteePublisher, formatError } = require('./publish-gitee-release');
const { parseReleaseTag } = require('./validate-release-tag');
const { getArtifactName, verifyUpdateArtifacts } = require('./update-artifact-integrity');

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
  parseReleaseTag(options.tag);
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

function selectWindowsUpdateAssets(release, tag) {
  const version = tag.replace(/^v/, '');
  const expectedNames = [
    `SerialTerminal-Setup-${version}.exe`,
    `SerialTerminal-Setup-${version}.exe.blockmap`,
    'latest.yml'
  ];
  return expectedNames.map(expectedName => {
    const matches = (release.assets || []).filter(asset => asset.name === expectedName);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one GitHub release asset named ${expectedName}, found ${matches.length}`);
    }
    return matches[0];
  });
}

async function mirrorRelease(options, {
  githubClient = createGitHubReleaseClient(),
  giteePublisher = createGiteePublisher({ token: process.env.GITEE_ACCESS_TOKEN }),
  outputDirectory = path.resolve('release-mirror'),
  downloadOptions = {}
} = {}) {
  const release = await githubClient.getRelease(options['github-owner'], options['github-repo'], options.tag);
  const assets = selectWindowsUpdateAssets(release, options.tag);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const [installerAsset, blockmapAsset, metadataAsset] = assets;
  const metadataPath = path.join(outputDirectory, metadataAsset.name);
  await downloadInstallerWithFallback({
    sources: [{ name: 'GitHub', url: metadataAsset.browser_download_url }],
    destination: metadataPath,
    expectedSize: metadataAsset.size,
    download: githubClient.download,
    ...downloadOptions
  });
  const metadata = yaml.load(await fs.promises.readFile(metadataPath, 'utf8'));
  const expectedChecksum = (metadata?.files || []).find(file => getArtifactName(file?.url || file?.name) === installerAsset.name)?.sha512
    || (getArtifactName(metadata?.path) === installerAsset.name ? metadata.sha512 : '');
  if (typeof expectedChecksum !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(expectedChecksum)) {
    throw new Error(`Update metadata has no valid SHA-512 for ${installerAsset.name}`);
  }
  const files = [];
  for (const asset of [installerAsset, blockmapAsset]) {
    const destination = path.join(outputDirectory, asset.name);
    const cosUrl = `${options['cos-releases-root'].replace(/\/$/, '')}/${encodeURIComponent(options.tag)}/${encodeURIComponent(asset.name)}`;
    const sources = asset === installerAsset ? [
          { name: 'COS', url: cosUrl },
          { name: 'GitHub', url: asset.browser_download_url }
        ] : [{ name: 'GitHub', url: asset.browser_download_url }];
    await downloadInstallerWithFallback({
      sources,
      destination,
      expectedSize: asset.size,
      expectedSha512: asset === installerAsset ? expectedChecksum : '',
      download: githubClient.download,
      ...downloadOptions
    });
    files.push(destination);
  }
  await verifyUpdateArtifacts({
    metadataPath,
    installerPath: path.join(outputDirectory, installerAsset.name),
    expectedVersion: parseReleaseTag(options.tag).version
  });
  files.push(metadataPath);
  return giteePublisher.publish({
    owner: options['gitee-owner'],
    repo: options['gitee-repo'],
    tag: options.tag,
    target: options.target,
    name: release.name || `SerialTerminal ${options.tag.replace(/^v/, '')}`,
    notes: release.body || '',
    files
  });
}

async function downloadInstallerWithFallback({
  sources,
  destination,
  expectedSize,
  expectedSha512,
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
        if (expectedSha512) {
          const actual = await sha512File(temporaryPath);
          if (actual !== expectedSha512) throw new Error('SHA-512 mismatch');
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

async function sha512File(filePath) {
  const hash = require('node:crypto').createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
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
  selectWindowsUpdateAssets
};

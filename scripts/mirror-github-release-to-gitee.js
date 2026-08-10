'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Agent, fetch: undiciFetch } = require('undici');
const { createGiteePublisher, formatError } = require('./publish-gitee-release');

const GITHUB_API_ROOT = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

function parseArguments(args) {
  const options = {};
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
  async function request(url, destination) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      logger.log(`[github] GET ${url} attempt ${attempt + 1}/${RETRY_DELAYS_MS.length + 1}`);
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
        if (!destination) return response.json();
        await pipeline(response.body, fs.createWriteStream(destination));
        return;
      } catch (error) {
        if (attempt === RETRY_DELAYS_MS.length || (error.status && error.status !== 429 && error.status < 500)) throw error;
        await wait(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async function getRelease(owner, repo, tag) {
    return request(`${apiRoot}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`);
  }

  async function downloadAsset(asset, destination) {
    if (!asset?.browser_download_url) throw new Error('GitHub release asset has no browser_download_url');
    await request(asset.browser_download_url, destination);
  }

  return { downloadAsset, getRelease };
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
  outputDirectory = path.resolve('release-mirror')
} = {}) {
  const release = await githubClient.getRelease(options['github-owner'], options['github-repo'], options.tag);
  const installer = selectWindowsInstaller(release, options.tag);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const installerPath = path.join(outputDirectory, installer.name);
  await githubClient.downloadAsset(installer, installerPath);
  const stat = await fs.promises.stat(installerPath);
  if (stat.size !== installer.size) {
    throw new Error(`Downloaded installer size mismatch: expected ${installer.size}, received ${stat.size}`);
  }
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

module.exports = { createGitHubReleaseClient, mirrorRelease, parseArguments, selectWindowsInstaller };

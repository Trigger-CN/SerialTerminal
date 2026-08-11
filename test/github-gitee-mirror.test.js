'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  downloadInstallerWithFallback,
  mirrorRelease,
  parseArguments,
  selectWindowsInstaller
} = require('../scripts/mirror-github-release-to-gitee');

test('release mirror arguments require an exact semantic version tag', () => {
  const args = [
    '--github-owner', 'Trigger-CN', '--github-repo', 'SerialTerminal',
    '--gitee-owner', 'trigger-cn', '--gitee-repo', 'SerialTerminal',
    '--tag', 'v1.2.3-rc.1', '--target', 'abc123',
    '--cos-releases-root', 'https://cos.example/releases'
  ];
  assert.deepEqual(parseArguments(args), {
    'github-owner': 'Trigger-CN',
    'github-repo': 'SerialTerminal',
    'gitee-owner': 'trigger-cn',
    'gitee-repo': 'SerialTerminal',
    tag: 'v1.2.3-rc.1',
    target: 'abc123',
    'cos-releases-root': 'https://cos.example/releases'
  });
  assert.throws(() => parseArguments(args.map(value => value === 'v1.2.3-rc.1' ? 'release-test' : value)), /Invalid release tag/);
});

test('release mirror selects only the exact Windows installer name', () => {
  const expected = { name: 'SerialTerminal-Setup-1.2.3.exe', size: 42 };
  const release = { assets: [expected, { name: 'SerialTerminal-Setup-1.2.3.exe.blockmap' }] };
  assert.equal(selectWindowsInstaller(release, 'v1.2.3'), expected);
  assert.throws(() => selectWindowsInstaller({ assets: [] }, 'v1.2.3'), /found 0/);
});

test('release mirror downloads the COS installer first and publishes the GitHub body to Gitee', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-mirror-'));
  const calls = [];
  const installer = { name: 'SerialTerminal-Setup-1.2.3.exe', size: 9, browser_download_url: 'https://example.test/setup.exe' };
  try {
    const result = await mirrorRelease({
      'github-owner': 'Trigger-CN',
      'github-repo': 'SerialTerminal',
      'gitee-owner': 'trigger-cn',
      'gitee-repo': 'SerialTerminal',
      tag: 'v1.2.3',
      target: 'abc123',
      'cos-releases-root': 'https://cos.example/releases'
    }, {
      outputDirectory,
      githubClient: {
        async getRelease(owner, repo, tag) {
          calls.push({ type: 'get', owner, repo, tag });
          return { name: 'SerialTerminal 1.2.3', body: 'Release changes', assets: [installer] };
        },
        async download(url, destination) {
          calls.push({ type: 'download', url, destination });
          await fs.promises.writeFile(destination, 'installer');
        }
      },
      giteePublisher: {
        async publish(options) {
          calls.push({ type: 'publish', options });
          return { tag_name: options.tag };
        }
      }
    });

    assert.equal(result.tag_name, 'v1.2.3');
    assert.deepEqual(calls[0], { type: 'get', owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3' });
    assert.equal(calls[1].url, 'https://cos.example/releases/v1.2.3/SerialTerminal-Setup-1.2.3.exe');
    assert.equal(calls[2].options.notes, 'Release changes');
    assert.equal(calls[2].options.target, 'abc123');
    assert.deepEqual(calls[2].options.files, [path.join(outputDirectory, installer.name)]);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

test('release mirror rejects downloads with the wrong size from every source', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-mirror-'));
  try {
    await assert.rejects(() => mirrorRelease({
      'github-owner': 'Trigger-CN', 'github-repo': 'SerialTerminal',
      'gitee-owner': 'trigger-cn', 'gitee-repo': 'SerialTerminal',
      tag: 'v1.2.3', target: 'abc123', 'cos-releases-root': 'https://cos.example/releases'
    }, {
      outputDirectory,
      githubClient: {
        async getRelease() {
          return { assets: [{ name: 'SerialTerminal-Setup-1.2.3.exe', size: 100, browser_download_url: 'https://example.test' }] };
        },
        async download(url, destination) {
          await fs.promises.writeFile(destination, 'short');
        }
      },
      giteePublisher: { async publish() { throw new Error('must not publish'); } },
      downloadOptions: { retryDelays: [], logger: { log() {}, warn() {} } }
    }), /All installer download sources failed/);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

test('installer download retries COS three times before falling back to GitHub', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-mirror-'));
  const destination = path.join(outputDirectory, 'setup.exe');
  const calls = [];
  const waits = [];
  try {
    const source = await downloadInstallerWithFallback({
      sources: [
        { name: 'COS', url: 'https://cos.example/setup.exe' },
        { name: 'GitHub', url: 'https://github.example/setup.exe' }
      ],
      destination,
      expectedSize: 9,
      retryDelays: [2000, 5000, 10000],
      wait: async milliseconds => waits.push(milliseconds),
      logger: { log() {}, warn() {} },
      async download(url, temporaryPath) {
        calls.push(url);
        if (url.includes('cos.example')) throw new Error('COS unavailable');
        await fs.promises.writeFile(temporaryPath, 'installer');
      }
    });

    assert.equal(source, 'GitHub');
    assert.equal(calls.filter(url => url.includes('cos.example')).length, 4);
    assert.equal(calls.filter(url => url.includes('github.example')).length, 1);
    assert.deepEqual(waits, [2000, 5000, 10000]);
    assert.equal(await fs.promises.readFile(destination, 'utf8'), 'installer');
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

test('installer download stops retrying when COS recovers', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-mirror-'));
  const destination = path.join(outputDirectory, 'setup.exe');
  let attempts = 0;
  try {
    const source = await downloadInstallerWithFallback({
      sources: [
        { name: 'COS', url: 'https://cos.example/setup.exe' },
        { name: 'GitHub', url: 'https://github.example/setup.exe' }
      ],
      destination,
      expectedSize: 9,
      retryDelays: [1, 1, 1],
      wait: async () => {},
      logger: { log() {}, warn() {} },
      async download(url, temporaryPath) {
        attempts++;
        assert.match(url, /cos\.example/);
        if (attempts < 3) throw new Error('temporary failure');
        await fs.promises.writeFile(temporaryPath, 'installer');
      }
    });

    assert.equal(source, 'COS');
    assert.equal(attempts, 3);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

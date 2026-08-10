'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  mirrorRelease,
  parseArguments,
  selectWindowsInstaller
} = require('../scripts/mirror-github-release-to-gitee');

test('release mirror arguments require an exact semantic version tag', () => {
  const args = [
    '--github-owner', 'Trigger-CN', '--github-repo', 'SerialTerminal',
    '--gitee-owner', 'trigger-cn', '--gitee-repo', 'SerialTerminal',
    '--tag', 'v1.2.3-rc.1', '--target', 'abc123'
  ];
  assert.deepEqual(parseArguments(args), {
    'github-owner': 'Trigger-CN',
    'github-repo': 'SerialTerminal',
    'gitee-owner': 'trigger-cn',
    'gitee-repo': 'SerialTerminal',
    tag: 'v1.2.3-rc.1',
    target: 'abc123'
  });
  assert.throws(() => parseArguments(args.map(value => value === 'v1.2.3-rc.1' ? 'release-test' : value)), /Invalid release tag/);
});

test('release mirror selects only the exact Windows installer name', () => {
  const expected = { name: 'SerialTerminal-Setup-1.2.3.exe', size: 42 };
  const release = { assets: [expected, { name: 'SerialTerminal-Setup-1.2.3.exe.blockmap' }] };
  assert.equal(selectWindowsInstaller(release, 'v1.2.3'), expected);
  assert.throws(() => selectWindowsInstaller({ assets: [] }, 'v1.2.3'), /found 0/);
});

test('release mirror downloads the GitHub installer and publishes the GitHub body to Gitee', async () => {
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
      target: 'abc123'
    }, {
      outputDirectory,
      githubClient: {
        async getRelease(owner, repo, tag) {
          calls.push({ type: 'get', owner, repo, tag });
          return { name: 'SerialTerminal 1.2.3', body: 'Release changes', assets: [installer] };
        },
        async downloadAsset(asset, destination) {
          calls.push({ type: 'download', asset, destination });
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
    assert.equal(calls[2].options.notes, 'Release changes');
    assert.equal(calls[2].options.target, 'abc123');
    assert.deepEqual(calls[2].options.files, [path.join(outputDirectory, installer.name)]);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

test('release mirror rejects a truncated installer download', async () => {
  const outputDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-mirror-'));
  try {
    await assert.rejects(() => mirrorRelease({
      'github-owner': 'Trigger-CN', 'github-repo': 'SerialTerminal',
      'gitee-owner': 'trigger-cn', 'gitee-repo': 'SerialTerminal',
      tag: 'v1.2.3', target: 'abc123'
    }, {
      outputDirectory,
      githubClient: {
        async getRelease() {
          return { assets: [{ name: 'SerialTerminal-Setup-1.2.3.exe', size: 100, browser_download_url: 'https://example.test' }] };
        },
        async downloadAsset(asset, destination) {
          await fs.promises.writeFile(destination, 'short');
        }
      },
      giteePublisher: { async publish() { throw new Error('must not publish'); } }
    }), /size mismatch/);
  } finally {
    await fs.promises.rm(outputDirectory, { recursive: true, force: true });
  }
});

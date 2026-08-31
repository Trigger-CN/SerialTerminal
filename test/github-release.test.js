'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  createGitHubReleaseValidator,
  parseArguments,
  validateGitHubDownloadUrl
} = require('../scripts/validate-github-release');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; }
  };
}

test('GitHub release preflight arguments require strict release inputs', () => {
  assert.deepEqual(parseArguments([
    '--owner', 'Trigger-CN', '--repo', 'SerialTerminal', '--tag', 'v1.2.3', '--files', 'one.exe'
  ]), {
    owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: ['one.exe'], promote: false
  });
  assert.throws(() => parseArguments([
    '--owner', 'Trigger-CN', '--repo', 'SerialTerminal', '--tag', 'v1.2.3+build.1', '--files', 'one.exe'
  ]), /Invalid release tag/);
});

test('GitHub release preflight rejects stable rollback', async () => {
  const validator = createGitHubReleaseValidator({
    token: 'secret',
    async fetchImpl(url) {
      assert.match(url.pathname, /releases\/latest$/);
      return response(200, { tag_name: 'v1.2.4' });
    }
  });
  await assert.rejects(() => validator.validate({
    owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: [__filename]
  }), /cannot move backward from v1\.2\.4 to v1\.2\.3/);
});

test('GitHub release preflight verifies existing assets and permits missing assets', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'serialterminal-github-release-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const existingPath = path.join(directory, 'existing.exe');
  const missingPath = path.join(directory, 'missing.yml');
  await fs.promises.writeFile(existingPath, 'existing bytes');
  await fs.promises.writeFile(missingPath, 'missing bytes');
  const existing = await fs.promises.readFile(existingPath);
  const requests = [];
  const validator = createGitHubReleaseValidator({
    token: 'secret',
    async fetchImpl(url) {
      requests.push(url.pathname);
      if (url.pathname.endsWith('/latest')) return response(200, { tag_name: 'v1.2.3' });
      return response(200, {
        tag_name: 'v1.2.3',
        draft: true,
        prerelease: false,
        assets: [{ name: 'existing.exe', size: existing.length, url: 'https://api.github.com/assets/1' }]
      });
    },
    async hashAsset() {
      return { size: existing.length, sha512: createHash('sha512').update(existing).digest('hex') };
    }
  });
  const result = await validator.validate({
    owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: [existingPath, missingPath]
  });
  assert.deepEqual(result, { releaseExists: true, promoted: false, verifiedAssets: 1 });
  assert.deepEqual(requests, [
    '/repos/Trigger-CN/SerialTerminal/releases/latest',
    '/repos/Trigger-CN/SerialTerminal/releases/tags/v1.2.3'
  ]);
});

test('GitHub release preflight rejects changed and unexpected same-tag assets', async () => {
  const validator = createGitHubReleaseValidator({
    token: 'secret',
    async fetchImpl(url) {
      if (url.pathname.endsWith('/latest')) return response(404, {});
      return response(200, {
        draft: true,
        prerelease: false,
        assets: [{ name: 'unexpected.exe', size: 1, url: 'https://api.github.com/assets/1' }]
      });
    },
    async hashAsset() {
      throw new Error('should not download unexpected assets');
    }
  });
  await assert.rejects(() => validator.validate({
    owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: [__filename]
  }), /Unexpected GitHub release asset/);
});

test('GitHub release promotion verifies a draft and publishes it only after validation', async () => {
  const calls = [];
  const local = await fs.promises.readFile(__filename);
  const validator = createGitHubReleaseValidator({
    token: 'secret',
    async fetchImpl(url, options) {
      calls.push({ path: url.pathname, method: options.method || 'GET', body: options.body });
      if (url.pathname.endsWith('/latest')) return response(404, {});
      if (url.pathname.endsWith('/tags/v1.2.3')) return response(404, {});
      if (url.pathname.endsWith('/releases')) return response(200, [{
        id: 7, tag_name: 'v1.2.3', draft: true, prerelease: false,
        assets: [{ name: path.basename(__filename), size: local.length, url: 'https://api.github.com/assets/1' }]
      }]);
      if (options.method === 'PATCH') return response(200, { id: 7, draft: false });
      throw new Error(`unexpected request ${url}`);
    },
    async hashAsset() {
      return { size: local.length, sha512: createHash('sha512').update(local).digest('hex') };
    }
  });
  const result = await validator.validate({ owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: [__filename], promote: true });
  assert.equal(result.promoted, true);
  assert.equal(calls.at(-1).method, 'PATCH');
  assert.deepEqual(JSON.parse(calls.at(-1).body), { draft: false, make_latest: 'true' });
});

test('GitHub release promotion rejects a draft with missing assets', async () => {
  const validator = createGitHubReleaseValidator({
    token: 'secret',
    async fetchImpl(url) {
      if (url.pathname.endsWith('/latest')) return response(404, {});
      return response(200, { id: 7, tag_name: 'v1.2.3', draft: true, prerelease: false, assets: [] });
    }
  });
  await assert.rejects(() => validator.validate({
    owner: 'Trigger-CN', repo: 'SerialTerminal', tag: 'v1.2.3', files: [__filename], promote: true
  }), /missing required asset/);
});

test('GitHub asset URLs reject credentials, custom ports, and unrelated redirects', () => {
  assert.equal(
    validateGitHubDownloadUrl('https://api.github.com/repos/example/assets/1', 'api.github.com'),
    'https://api.github.com/repos/example/assets/1'
  );
  assert.throws(() => validateGitHubDownloadUrl('https://user@api.github.com/assets/1', 'api.github.com'));
  assert.throws(() => validateGitHubDownloadUrl('https://example.com/asset'));
});

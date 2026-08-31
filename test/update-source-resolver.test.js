'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COS_UPDATE_METADATA_URL,
  DYNAMIC_UPDATE_METADATA_URL,
  GITEE_LATEST_RELEASE_API_URL,
  GITHUB_LINUX_UPDATE_METADATA_URL,
  GITHUB_UPDATE_METADATA_URL,
  buildUpdateMetadataCandidates,
  compareUpdateVersions,
  getUpdateArtifactExtension,
  getUpdateChannel,
  isSameUpdate,
  isStableUpdateVersion,
  isUpdateSourceConsistent,
  resolveGiteeUpdateMetadataUrl,
  runUpdateSourceFallback,
  selectUpdateReleaseCandidates,
  validateMetadataUrl
} = require('../update-source-resolver');

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get(name) { return headers[name.toLowerCase()] || null; } },
    async text() { return body; }
  };
}

test('resolver rejects unsafe metadata URLs', () => {
  for (const value of [
    'http://example.com/latest.yml',
    'https://user:pass@example.com/latest.yml',
    'https://example.com:8443/latest.yml',
    'https://example.com/releases/channel.yml'
  ]) assert.throws(() => validateMetadataUrl(value));
});

test('metadata candidates use the dynamic endpoint before external fallbacks', () => {
  const giteeUrl = 'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/latest.yml';
  assert.deepEqual(buildUpdateMetadataCandidates(giteeUrl), [
    DYNAMIC_UPDATE_METADATA_URL,
    giteeUrl,
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ]);
  assert.deepEqual(buildUpdateMetadataCandidates(''), [
    DYNAMIC_UPDATE_METADATA_URL,
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ]);
  assert.throws(() => buildUpdateMetadataCandidates('https://custom.example/releases/latest.yml'), /must use Gitee/);
  assert.deepEqual(buildUpdateMetadataCandidates('', 'linux'), [GITHUB_LINUX_UPDATE_METADATA_URL]);
});

test('Gitee resolver selects latest.yml from the latest release assets', async () => {
  const metadataUrl = 'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/latest.yml';
  const result = await resolveGiteeUpdateMetadataUrl({
    fetchImpl: async url => {
      assert.equal(url, GITEE_LATEST_RELEASE_API_URL);
      return response(200, JSON.stringify({
        assets: [
          { name: 'setup.exe', browser_download_url: 'https://gitee.com/setup.exe' },
          { name: 'latest.yml', browser_download_url: metadataUrl }
        ]
      }));
    },
    logger: { warn() {} }
  });
  assert.equal(result, metadataUrl);

  const missing = await resolveGiteeUpdateMetadataUrl({
    fetchImpl: async () => response(200, JSON.stringify({ assets: [] })),
    logger: { warn() {} }
  });
  assert.equal(missing, '');

  const oversized = await resolveGiteeUpdateMetadataUrl({
    fetchImpl: async () => response(200, 'x', { 'content-length': String(300 * 1024) }),
    logger: { warn() {} }
  });
  assert.equal(oversized, '');
});

test('update versions and installer checksums gate source fallback', () => {
  assert.equal(compareUpdateVersions('1.2.3', '1.2.2'), 1);
  assert.equal(compareUpdateVersions('1.2.3', '1.2.3-rc.1'), 1);
  assert.equal(compareUpdateVersions('1.2.3-rc.2', '1.2.3-rc.10'), -1);
  assert.equal(compareUpdateVersions('1.2.3+build.2', '1.2.3+build.1'), 0);
  assert.equal(compareUpdateVersions('900719925474099300.0.0', '900719925474099299.0.0'), 1);
  assert.throws(() => compareUpdateVersions('latest', '1.2.3'), /Invalid update version/);
  assert.throws(() => compareUpdateVersions('1.2.3-01', '1.2.3'), /Invalid update version/);
  assert.equal(isStableUpdateVersion('1.2.3+build.1'), true);
  assert.equal(isStableUpdateVersion('1.2.3-preview.1'), false);

  const update = { version: '1.2.3', files: [{ url: 'setup.exe', sha512: 'checksum' }] };
  assert.equal(isSameUpdate(update, {
    version: '1.2.3', files: [{ url: 'https://gitee.com/setup.exe', sha512: 'checksum' }]
  }), true);
  assert.equal(isSameUpdate(update, {
    version: '1.2.3', files: [{ url: 'setup.exe', sha512: 'different' }]
  }), false);
  assert.equal(isSameUpdate(update, {
    version: '1.2.4', files: [{ url: 'setup.exe', sha512: 'checksum' }]
  }), false);
  assert.equal(isSameUpdate(update, {
    version: '1.2.3', files: [{ url: 'latest.yml', sha512: 'checksum' }], sha512: 'checksum'
  }), false);
  assert.equal(isSameUpdate(update, {
    version: '1.2.3', path: 'setup.exe', sha512: 'checksum'
  }), true);
  assert.equal(isSameUpdate(
    { version: '1.2.3', path: 'SerialTerminal-1.2.3.AppImage', sha512: 'checksum' },
    { version: '1.2.3', files: [{ url: 'SerialTerminal-1.2.3.AppImage', sha512: 'checksum' }] },
    'linux'
  ), true);
  const linuxUpdate = {
    version: '1.2.3',
    files: [
      { url: 'SerialTerminal-1.2.3.AppImage', sha512: 'appimage' },
      { url: 'serialterminal_1.2.3_amd64.deb', sha512: 'deb' }
    ]
  };
  assert.equal(getUpdateArtifactExtension('linux', 'deb'), '\\.deb');
  assert.equal(isSameUpdate(linuxUpdate, {
    ...linuxUpdate,
    files: [
      { url: 'SerialTerminal-1.2.3.AppImage', sha512: 'appimage' },
      { url: 'serialterminal_1.2.3_amd64.deb', sha512: 'changed' }
    ]
  }, 'linux', 'deb'), false);
  assert.equal(isSameUpdate(linuxUpdate, {
    ...linuxUpdate,
    files: [
      { url: 'SerialTerminal-1.2.3.AppImage', sha512: 'changed' },
      { url: 'serialterminal_1.2.3_amd64.deb', sha512: 'deb' }
    ]
  }, 'linux', 'deb'), true);
  assert.equal(isUpdateSourceConsistent(
    'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/latest.yml',
    { files: [{ url: 'SerialTerminal-Setup-1.2.3.exe' }] }
  ), true);
  assert.equal(isUpdateSourceConsistent(
    'https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1.2.3/latest.yml',
    { files: [{ url: 'https://cos.example/SerialTerminal-Setup-1.2.3.exe' }] }
  ), false);
  assert.equal(isUpdateSourceConsistent(
    DYNAMIC_UPDATE_METADATA_URL,
    { files: [{ url: 'https://github.com/Trigger-CN/SerialTerminal/releases/download/v1/setup.exe' }] }
  ), true);
  assert.equal(isUpdateSourceConsistent(
    GITHUB_LINUX_UPDATE_METADATA_URL,
    { files: [{ url: 'SerialTerminal-1.2.3.AppImage' }] },
    'linux'
  ), true);
});

test('update download fallback tries the supplied dynamic and external sources in order', async () => {
  const sources = [
    DYNAMIC_UPDATE_METADATA_URL,
    'https://gitee.com/releases/latest.yml',
    COS_UPDATE_METADATA_URL,
    GITHUB_UPDATE_METADATA_URL
  ];
  const attempts = [];
  const result = await runUpdateSourceFallback(sources, async source => {
    attempts.push(source);
    if (source !== GITHUB_UPDATE_METADATA_URL) throw new Error('unavailable');
    return 'downloaded';
  }, { logger: { warn() {} } });
  assert.equal(result, 'downloaded');
  assert.deepEqual(attempts, sources);

  let cancelled = false;
  const cancelledAttempts = [];
  await assert.rejects(() => runUpdateSourceFallback(sources, async source => {
    cancelledAttempts.push(source);
    cancelled = true;
    throw new Error('cancelled');
  }, { isCancelled: () => cancelled, logger: { warn() {} } }), /cancelled/);
  assert.deepEqual(cancelledAttempts, [sources[0]]);
});

test('release selection uses the highest version and preserves source priority for matching builds', () => {
  const releases = [
    { metadataUrl: 'gitee', info: { version: '1.2.3', files: [{ url: 'setup.exe', sha512: 'old' }] } },
    { metadataUrl: 'cos', info: { version: '1.2.4', files: [{ url: 'setup.exe', sha512: 'new' }] } },
    { metadataUrl: 'github', info: { version: '1.2.4', files: [{ url: 'setup.exe', sha512: 'new' }] } }
  ];
  assert.deepEqual(selectUpdateReleaseCandidates(releases).map(item => item.metadataUrl), ['cos', 'github']);
  releases[0].info = { version: '1.2.4', files: [{ url: 'setup.exe', sha512: 'new' }] };
  assert.deepEqual(selectUpdateReleaseCandidates(releases).map(item => item.metadataUrl), ['gitee', 'cos', 'github']);
  assert.deepEqual(selectUpdateReleaseCandidates([]), []);
});

test('update channel follows the installer URL and falls back to the metadata host', () => {
  assert.equal(getUpdateChannel(COS_UPDATE_METADATA_URL, {
    files: [{ url: 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/v1/setup.exe' }]
  }), 'Tencent COS');
  assert.equal(getUpdateChannel(GITHUB_UPDATE_METADATA_URL, {
    files: [{ url: 'SerialTerminal-Setup-1.2.3.exe' }]
  }), 'GitHub');
  assert.equal(getUpdateChannel(GITHUB_LINUX_UPDATE_METADATA_URL, {
    files: [{ url: 'SerialTerminal-1.2.3.AppImage' }]
  }, 'linux'), 'GitHub');
  assert.equal(getUpdateChannel('https://gitee.com/trigger-cn/SerialTerminal/releases/download/v1/latest.yml', {
    files: [{ url: 'SerialTerminal-Setup-1.2.3.exe' }]
  }), 'Gitee');
  assert.equal(getUpdateChannel('https://updates.example.com/latest.yml', {}), 'updates.example.com');
});

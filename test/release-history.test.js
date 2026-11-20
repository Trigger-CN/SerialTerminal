'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReleaseList,
  classifyVersion,
  compareVersions,
  isTrustedReleaseDownloadUrl,
  parseReleaseTag,
  pickChecksumAsset,
  pickInstallerAsset
} = require('../src/common/release-history');

// ---------------------------------------------------------------------------
// tag 解析
// ---------------------------------------------------------------------------

test('release tags accept only stable vX.Y.Z', () => {
  assert.equal(parseReleaseTag('v0.4.2'), '0.4.2');
  assert.equal(parseReleaseTag('v0.3.16'), '0.3.16');
  assert.equal(parseReleaseTag('v1.0.0'), '1.0.0');
});

test('release tags reject prerelease and malformed values', () => {
  assert.equal(parseReleaseTag('v0.4.2-beta.1'), null);
  assert.equal(parseReleaseTag('v0.4'), null);
  assert.equal(parseReleaseTag('0.4.2'), null);
  assert.equal(parseReleaseTag(''), null);
  assert.equal(parseReleaseTag(null), null);
});

// ---------------------------------------------------------------------------
// 版本比较与状态分类
// ---------------------------------------------------------------------------

test('version comparison handles multi-digit segments', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0, '0.10.0 必须大于 0.9.0');
  assert.ok(compareVersions('0.3.16', '0.4.0') < 0);
  assert.equal(compareVersions('0.4.2', '0.4.2'), 0);
});

test('version state distinguishes current from older and newer', () => {
  assert.equal(classifyVersion('0.4.2', '0.4.2'), 'same');
  assert.equal(classifyVersion('0.4.1', '0.4.2'), 'older');
  assert.equal(classifyVersion('0.5.0', '0.4.2'), 'newer');
});

// ---------------------------------------------------------------------------
// 资产挑选
// ---------------------------------------------------------------------------

const WIN_ASSETS = [
  { name: 'latest.yml', size: 100, browser_download_url: 'https://github.com/Trigger-CN/SerialTerminal/releases/download/v0.4.2/latest.yml' },
  { name: 'SerialTerminal-Setup-0.4.2.exe', size: 89653248, browser_download_url: 'https://github.com/Trigger-CN/SerialTerminal/releases/download/v0.4.2/SerialTerminal-Setup-0.4.2.exe' },
  { name: 'SerialTerminal-Setup-0.4.2.exe.blockmap', size: 102400, browser_download_url: 'https://github.com/Trigger-CN/SerialTerminal/releases/download/v0.4.2/SerialTerminal-Setup-0.4.2.exe.blockmap' }
];

test('windows installer selection ignores blockmap', () => {
  const asset = pickInstallerAsset(WIN_ASSETS, 'win32');
  assert.equal(asset.name, 'SerialTerminal-Setup-0.4.2.exe');
});

test('linux installer prefers deb over AppImage', () => {
  const assets = [
    { name: 'SerialTerminal-0.4.2.AppImage', browser_download_url: 'https://github.com/a/b/releases/download/v0.4.2/x.AppImage' },
    { name: 'serialterminal_0.4.2_amd64.deb', browser_download_url: 'https://github.com/a/b/releases/download/v0.4.2/x.deb' }
  ];
  assert.equal(pickInstallerAsset(assets, 'linux').name, 'serialterminal_0.4.2_amd64.deb');
});

test('linux falls back to AppImage when deb is missing', () => {
  const assets = [
    { name: 'SerialTerminal-0.4.2.AppImage', browser_download_url: 'https://github.com/a/b/releases/download/v0.4.2/x.AppImage' }
  ];
  assert.equal(pickInstallerAsset(assets, 'linux').name, 'SerialTerminal-0.4.2.AppImage');
});

test('installer selection returns null when platform has no package', () => {
  const linuxOnly = [
    { name: 'serialterminal_0.4.2_amd64.deb', browser_download_url: 'https://github.com/a/b/releases/download/v0.4.2/x.deb' }
  ];
  assert.equal(pickInstallerAsset(linuxOnly, 'win32'), null);
  assert.equal(pickInstallerAsset([], 'win32'), null);
  assert.equal(pickInstallerAsset(null, 'win32'), null);
});

test('checksum metadata asset follows platform', () => {
  assert.equal(pickChecksumAsset(WIN_ASSETS, 'win32').name, 'latest.yml');
  const linuxAssets = [{ name: 'latest-linux.yml', browser_download_url: 'https://example.test/latest-linux.yml' }];
  assert.equal(pickChecksumAsset(linuxAssets, 'linux').name, 'latest-linux.yml');
});

// ---------------------------------------------------------------------------
// 列表构建
// ---------------------------------------------------------------------------

function makeRelease(tagName, extra = {}) {
  return {
    tag_name: tagName,
    draft: false,
    prerelease: false,
    published_at: '2026-11-19T13:55:36Z',
    html_url: `https://github.com/Trigger-CN/SerialTerminal/releases/tag/${tagName}`,
    body: 'notes',
    assets: WIN_ASSETS,
    ...extra
  };
}

test('release list is sorted newest first and keeps state labels', () => {
  const list = buildReleaseList(
    [makeRelease('v0.4.1'), makeRelease('v0.4.2'), makeRelease('v0.3.16')],
    { currentVersion: '0.4.2', platform: 'win32' }
  );
  assert.deepEqual(list.map(item => item.version), ['0.4.2', '0.4.1', '0.3.16']);
  assert.deepEqual(list.map(item => item.state), ['same', 'older', 'older']);
});

test('release list marks versions newer than current', () => {
  const list = buildReleaseList(
    [makeRelease('v0.5.0'), makeRelease('v0.4.2')],
    { currentVersion: '0.4.2', platform: 'win32' }
  );
  assert.equal(list[0].state, 'newer');
  assert.equal(list[1].state, 'same');
});

test('release list skips drafts and prereleases', () => {
  const list = buildReleaseList(
    [
      makeRelease('v0.5.0', { draft: true }),
      makeRelease('v0.4.3', { prerelease: true }),
      makeRelease('v0.4.2')
    ],
    { currentVersion: '0.4.2', platform: 'win32' }
  );
  assert.deepEqual(list.map(item => item.version), ['0.4.2']);
});

test('release list skips releases without a package for the platform', () => {
  const list = buildReleaseList(
    [
      makeRelease('v0.4.2'),
      makeRelease('v0.4.1', { assets: [{ name: 'serialterminal_0.4.1_amd64.deb', browser_download_url: 'https://github.com/a/b/releases/download/v0.4.1/x.deb' }] })
    ],
    { currentVersion: '0.4.2', platform: 'win32' }
  );
  assert.deepEqual(list.map(item => item.version), ['0.4.2']);
});

test('release list exposes the fields the dialog renders', () => {
  const [item] = buildReleaseList([makeRelease('v0.4.2')], { currentVersion: '0.4.2', platform: 'win32' });
  assert.equal(item.version, '0.4.2');
  assert.equal(item.tag, 'v0.4.2');
  assert.equal(item.publishedAt, '2026-11-19');
  assert.equal(item.assetName, 'SerialTerminal-Setup-0.4.2.exe');
  assert.equal(item.sizeBytes, 89653248);
  assert.match(item.downloadUrl, /releases\/download\/v0\.4\.2\/SerialTerminal-Setup-0\.4\.2\.exe$/);
});

test('release list tolerates malformed input', () => {
  assert.deepEqual(buildReleaseList(null, { currentVersion: '0.4.2' }), []);
  assert.deepEqual(buildReleaseList([null, {}, { tag_name: 'v0.4.2' }], { currentVersion: '0.4.2', platform: 'win32' }), []);
});

test('release list respects the limit', () => {
  const releases = ['v0.4.2', 'v0.4.1', 'v0.4.0'].map(tag => makeRelease(tag));
  const list = buildReleaseList(releases, { currentVersion: '0.4.2', platform: 'win32', limit: 2 });
  assert.equal(list.length, 2);
});

// ---------------------------------------------------------------------------
// 下载地址校验
// ---------------------------------------------------------------------------

test('trusted download url requires https github release path', () => {
  assert.equal(
    isTrustedReleaseDownloadUrl('https://github.com/Trigger-CN/SerialTerminal/releases/download/v0.4.2/SerialTerminal-Setup-0.4.2.exe'),
    true
  );
});

test('untrusted download urls are rejected', () => {
  const bad = [
    'http://github.com/Trigger-CN/SerialTerminal/releases/download/v0.4.2/a.exe',      // 非 https
    'https://evil.example/Trigger-CN/SerialTerminal/releases/download/v0.4.2/a.exe',   // 非 github 主机
    'https://github.com/Other/Repo/releases/download/v0.4.2/a.exe',                    // 非预期仓库
    'https://github.com/Trigger-CN/SerialTerminal/raw/main/a.exe',                     // 非 release 路径
    '', null, undefined
  ];
  for (const url of bad) {
    assert.equal(isTrustedReleaseDownloadUrl(url), false, `应当拒绝: ${url}`);
  }
});

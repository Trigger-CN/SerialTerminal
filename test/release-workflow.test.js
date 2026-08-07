'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('release builds use a supported Windows toolchain', () => {
  assert.match(workflow, /uses: actions\/checkout@v6/);
  assert.match(workflow, /uses: actions\/setup-node@v6/);
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node)@v4/);
  assert.match(workflow, /os: windows-2022/);
  assert.match(workflow, /uses: microsoft\/setup-msbuild@v2/);
  assert.match(workflow, /uses: ilammy\/msvc-dev-cmd@v1/);
  assert.equal(packageJson.build.nsis.artifactName, '${productName}-Setup-${version}.${ext}');
  assert.match(workflow, /name: Verify Windows release artifact names/);
  assert.match(workflow, /dist\/SerialTerminal-Setup-\$VERSION\.exe\.blockmap/);
  assert.match(workflow, /path: SerialTerminal-Setup-\$VERSION\.exe/);
});

test('test script discovers files consistently across platforms', () => {
  const testRunner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');

  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.js');
  assert.match(testRunner, /file\.endsWith\('\.test\.js'\)/);
  assert.match(testRunner, /spawnSync\(process\.execPath, \['--test', \.\.\.testFiles\]/);
});

test('release build jobs never publish directly through electron-builder', () => {
  assert.equal(packageJson.scripts['dist:win'], 'electron-builder --win -c.npmRebuild=false --publish never');
  assert.equal(packageJson.scripts['dist:linux'], 'electron-builder --linux -c.npmRebuild=false --publish never');
  assert.match(workflow, /run: \$\{\{ matrix\.command \}\}/);
  assert.doesNotMatch(workflow, /matrix\.command \}\} --/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v3/);
});

test('release uploads exclude unpacked application directories', () => {
  assert.doesNotMatch(workflow, /dist\/\*\*/);
  assert.match(workflow, /dist\/\*\.exe/);
  assert.match(workflow, /dist\/\*\.AppImage/);
  assert.match(workflow, /dist\/\*\.deb/);
  assert.match(workflow, /dist\/latest\.yml/);
  assert.match(workflow, /dist\/latest-linux\.yml/);
  assert.match(workflow, /fail_on_unmatched_files: true/);
});

test('release notes summarize commits since the previous tag', () => {
  assert.match(workflow, /name: Generate release notes/);
  assert.match(workflow, /git describe --tags --abbrev=0/);
  assert.match(workflow, /git log "\$RANGE" --pretty=format:'- %s \(%h\)'/);
  assert.equal((workflow.match(/git log "\$RANGE"/g) || []).length, 1);
  assert.doesNotMatch(workflow, /### (?:Features|Fixes|Improvements|Documentation|Tests|Build|Other Changes)/);
  assert.match(workflow, /body_path: release-notes\.md/);
  assert.doesNotMatch(workflow, /generate_release_notes:\s*true/);
});

test('release publishes updater files without a self-hosted mirror', () => {
  assert.deepEqual(packageJson.build.publish, {
    provider: 'generic',
    url: 'https://gitee.com/trigger-cn/SerialTerminal/releases/download/'
  });
  assert.ok(packageJson.build.files.includes('!scripts/publish-gitee-release.js'));
  assert.doesNotMatch(workflow, /MIRROR_SSH_PRIVATE_KEY|serialterminal-deploy|43\.157\.13\.24|\bscp\b/);
  assert.doesNotMatch(workflow, /Publish Windows update mirror|SerialTerminalPackages|publish-update-mirror/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v3/);
});

test('release synchronizes the commit, tag, and artifacts to Gitee', () => {
  assert.match(workflow, /GITEE_SSH_PRIVATE_KEY: \$\{\{ secrets\.GITEE_SSH_PRIVATE_KEY \}\}/);
  assert.match(workflow, /GITEE_ACCESS_TOKEN: \$\{\{ secrets\.GITEE_ACCESS_TOKEN \}\}/);
  assert.match(workflow, /git remote add gitee git@gitee\.com:trigger-cn\/SerialTerminal\.git/);
  assert.match(workflow, /git push gitee "\$\{GITHUB_SHA\}:refs\/heads\/main" "refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
  assert.doesNotMatch(workflow, /git push[^\n]*(?:--force|--mirror)/);
  assert.match(workflow, /node scripts\/publish-gitee-release\.js/);
  assert.match(workflow, /dist\/\*\.exe[\s\S]*dist\/\*\.AppImage[\s\S]*dist\/latest-linux\.yml/);
  assert.match(workflow, /gitee\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB\/OvYN/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
});

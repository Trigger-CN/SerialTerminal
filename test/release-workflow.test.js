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
  assert.match(workflow, /COS_ROOT='https:\/\/tst-update-package-1316411824\.cos\.ap-hongkong\.myqcloud\.com\/releases'/);
  assert.match(workflow, /SerialTerminal-Setup-\$VERSION\.exe/);
  assert.doesNotMatch(workflow, /generate_release_notes:\s*true/);
});

test('release publishes updater files to Tencent COS', () => {
  assert.deepEqual(packageJson.build.publish, {
    provider: 'generic',
    url: 'https://tst-update-package-1316411824.cos.ap-hongkong.myqcloud.com/releases/latest/'
  });
  assert.ok(packageJson.build.files.includes('!scripts/publish-cos-release.js'));
  assert.ok(packageJson.build.files.includes('!scripts/publish-gitee-release.js'));
  assert.doesNotMatch(workflow, /MIRROR_SSH_PRIVATE_KEY|serialterminal-deploy|43\.157\.13\.24|\bscp\b/);
  assert.doesNotMatch(workflow, /Publish Windows update mirror|SerialTerminalPackages|publish-update-mirror/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v3/);
});

test('release synchronizes code to Gitee and artifacts to COS', () => {
  assert.match(workflow, /publish:[\s\S]*uses: actions\/setup-node@v6[\s\S]*node-version: 22\.12\.0[\s\S]*run: npm ci --ignore-scripts/);
  assert.match(workflow, /GITEE_SSH_PRIVATE_KEY: \$\{\{ secrets\.GITEE_SSH_PRIVATE_KEY \}\}/);
  assert.match(workflow, /GITEE_ACCESS_TOKEN: \$\{\{ secrets\.GITEE_ACCESS_TOKEN \}\}/);
  assert.match(workflow, /COS_SECRET_ID: \$\{\{ secrets\.COS_SECRET_ID \}\}/);
  assert.match(workflow, /COS_SECRET_KEY: \$\{\{ secrets\.COS_SECRET_KEY \}\}/);
  assert.match(workflow, /COS_BUCKET: \$\{\{ secrets\.COS_BUCKET \}\}/);
  assert.match(workflow, /COS_REGION: \$\{\{ secrets\.COS_REGION \}\}/);
  assert.match(workflow, /git remote add gitee git@gitee\.com:trigger-cn\/SerialTerminal\.git/);
  assert.match(workflow, /git push gitee "\$\{GITHUB_SHA\}:refs\/heads\/main"/);
  assert.match(workflow, /git push gitee --force "refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
  assert.doesNotMatch(workflow, /git push gitee[^\n]*--mirror/);
  assert.match(workflow, /node scripts\/publish-cos-release\.js/);
  assert.match(workflow, /name: Verify public COS downloads/);
  assert.match(workflow, /curl --fail --silent --show-error --retry 3 --output \/dev\/null "\$COS_ROOT\/latest\/latest\.yml"/);
  assert.match(workflow, /--range 0-0 --output \/dev\/null/);
  assert.match(workflow, /node scripts\/publish-gitee-release\.js/);
  assert.match(workflow, /--notes release-notes\.md \\\s*--files \\\s*dist\/latest\.yml \\\s*dist\/latest-linux\.yml/);
  assert.doesNotMatch(workflow, /Publish Gitee release notes[\s\S]*dist\/\*\.exe/);
  assert.match(workflow, /dist\/\*\.exe[\s\S]*dist\/\*\.AppImage[\s\S]*dist\/latest-linux\.yml/);
  assert.match(workflow, /gitee\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB\/OvYN/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
});

test('release prunes COS versions only after all publication steps succeed', () => {
  const verifyIndex = workflow.indexOf('name: Verify public COS downloads');
  const giteeIndex = workflow.indexOf('name: Publish Gitee release notes');
  const pruneIndex = workflow.indexOf('name: Remove old COS releases');

  assert.ok(verifyIndex >= 0 && verifyIndex < pruneIndex);
  assert.ok(giteeIndex >= 0 && giteeIndex < pruneIndex);
  assert.match(workflow.slice(pruneIndex), /node scripts\/publish-cos-release\.js --prune-only/);
});

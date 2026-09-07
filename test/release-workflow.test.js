'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const giteeWorkflow = fs.readFileSync(path.join(__dirname, '..', '.workflow', 'gitee-release.yml'), 'utf8');
const recoveryWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'recover-release.yml'), 'utf8');
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
  assert.match(workflow, /uses: softprops\/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228/);
  assert.match(workflow, /prerelease: \$\{\{ contains\(github\.ref_name, '-'\) \}\}/);
  assert.match(workflow, /concurrency:\s*\n\s+group: serialterminal-release-publish\s*\n\s+cancel-in-progress: false/);
  assert.match(workflow, /overwrite_files: false/);
  assert.match(workflow, /draft: true/);
  assert.match(workflow, /name: Promote verified GitHub release[\s\S]*--promote/);
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
  assert.ok(packageJson.build.files.includes('!scripts/mirror-github-release-to-gitee.js'));
  assert.ok(packageJson.build.files.includes('!scripts/validate-github-release.js'));
  assert.doesNotMatch(workflow, /MIRROR_SSH_PRIVATE_KEY|serialterminal-deploy|43\.157\.13\.24|\bscp\b/);
  assert.doesNotMatch(workflow, /Publish Windows update mirror|SerialTerminalPackages|publish-update-mirror/);
  assert.match(workflow, /uses: softprops\/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228/);
});

test('release promotes COS stable latest only after GitHub and Gitee verification', () => {
  assert.match(workflow, /publish:[\s\S]*uses: actions\/setup-node@v6[\s\S]*node-version: 22\.12\.0[\s\S]*run: npm ci --ignore-scripts/);
  assert.match(workflow, /GITEE_SSH_PRIVATE_KEY: \$\{\{ secrets\.GITEE_SSH_PRIVATE_KEY \}\}/);
  assert.doesNotMatch(workflow, /GITEE_ACCESS_TOKEN|Publish Gitee release notes|publish-gitee-release\.js/);
  assert.match(workflow, /COS_SECRET_ID: \$\{\{ secrets\.COS_SECRET_ID \}\}/);
  assert.match(workflow, /COS_SECRET_KEY: \$\{\{ secrets\.COS_SECRET_KEY \}\}/);
  assert.match(workflow, /COS_BUCKET: \$\{\{ secrets\.COS_BUCKET \}\}/);
  assert.match(workflow, /COS_REGION: \$\{\{ secrets\.COS_REGION \}\}/);
  assert.match(workflow, /git remote add gitee git@gitee\.com:trigger-cn\/SerialTerminal\.git/);
  assert.match(workflow, /git push gitee "\$\{GITHUB_SHA\}:refs\/heads\/main"/);
  assert.match(workflow, /git push gitee "refs\/tags\/\$\{GITHUB_REF_NAME\}"/);
  assert.doesNotMatch(workflow, /git push gitee --force/);
  assert.doesNotMatch(workflow, /git push gitee[^\n]*--mirror/);
  assert.match(workflow, /name: Verify local Windows update artifacts[\s\S]*node scripts\/update-artifact-integrity\.js/);
  assert.match(workflow, /name: Validate GitHub release promotion[\s\S]*node scripts\/validate-github-release\.js/);
  assert.match(workflow, /make_latest: false/);

  const draftIndex = workflow.indexOf('uses: softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228');
  const cosPublishIndex = workflow.indexOf('name: Publish release artifacts to COS');
  const cosVerifyIndex = workflow.indexOf('name: Verify public COS downloads');
  const githubPromoteIndex = workflow.indexOf('name: Promote verified GitHub release');
  const giteePushIndex = workflow.indexOf('name: Synchronize release commit and tag to Gitee');
  const giteeVerifyIndex = workflow.indexOf('name: Wait for and verify public Gitee release');
  const latestPromoteIndex = workflow.indexOf('name: Promote stable COS latest');
  const latestVerifyIndex = workflow.indexOf('name: Verify stable COS latest');
  const pruneIndex = workflow.indexOf('name: Remove old COS releases');

  assert.ok(draftIndex < cosPublishIndex);
  assert.ok(cosPublishIndex < cosVerifyIndex);
  assert.ok(cosVerifyIndex < githubPromoteIndex);
  assert.ok(githubPromoteIndex < giteePushIndex);
  assert.ok(giteePushIndex < giteeVerifyIndex);
  assert.ok(giteeVerifyIndex < latestPromoteIndex);
  assert.ok(latestPromoteIndex < latestVerifyIndex);
  assert.ok(latestVerifyIndex < pruneIndex);

  const cosPublish = workflow.slice(cosPublishIndex, cosVerifyIndex);
  assert.match(cosPublish, /dist\/\*\.exe[\s\S]*dist\/\*\.exe\.blockmap[\s\S]*dist\/latest\.yml/);
  assert.doesNotMatch(cosPublish, /AppImage|\.deb|latest-linux\.yml|--promote-latest/);
  assert.match(workflow.slice(giteeVerifyIndex, latestPromoteIndex), /update-artifact-integrity\.js/);
  assert.match(workflow.slice(latestPromoteIndex, latestVerifyIndex), /if: \$\{\{ !contains\(github\.ref_name, '-'\) \}\}[\s\S]*--promote-latest --tag/);
  assert.match(workflow.slice(latestVerifyIndex, pruneIndex), /if: \$\{\{ !contains\(github\.ref_name, '-'\) \}\}[\s\S]*update-artifact-integrity\.js/);
  assert.match(workflow.slice(pruneIndex), /node scripts\/publish-cos-release\.js --prune-only/);
  assert.match(workflow, /gitee\.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEKxHSJ7084RmkJ4YdEi5tngynE8aZe2uEoVVsB\/OvYN/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
});

test('release recovery validates and reuses an exact failed run before promotion', () => {
  assert.match(recoveryWorkflow, /workflow_dispatch:/);
  assert.match(recoveryWorkflow, /actions: read/);
  assert.match(recoveryWorkflow, /contents: write/);
  assert.match(recoveryWorkflow, /name: Validate recovery source[\s\S]*head_branch: tag[\s\S]*head_sha: tagSha[\s\S]*conclusion: 'failure'/);
  assert.match(recoveryWorkflow, /uses: actions\/download-artifact@v4[\s\S]*run-id: \$\{\{ inputs\.run_id \}\}[\s\S]*github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(recoveryWorkflow, /name: Verify recovered Windows update artifacts[\s\S]*update-artifact-integrity\.js/);
  assert.doesNotMatch(recoveryWorkflow, /softprops\/action-gh-release|publish-cos-release\.js[\s\S]*--files/);
  const verifyCosIndex = recoveryWorkflow.indexOf('name: Verify public COS downloads');
  const promoteGitHubIndex = recoveryWorkflow.indexOf('name: Promote verified GitHub release');
  const syncGiteeIndex = recoveryWorkflow.indexOf('name: Synchronize release commit and tag to Gitee');
  const verifyGiteeIndex = recoveryWorkflow.indexOf('name: Wait for and verify public Gitee release');
  const promoteCosIndex = recoveryWorkflow.indexOf('name: Promote stable COS latest');
  assert.ok(verifyCosIndex < promoteGitHubIndex);
  assert.ok(promoteGitHubIndex < syncGiteeIndex);
  assert.ok(syncGiteeIndex < verifyGiteeIndex);
  assert.ok(verifyGiteeIndex < promoteCosIndex);
  assert.match(recoveryWorkflow, /git push gitee "\$TAG_SHA:refs\/heads\/main"/);
  assert.doesNotMatch(recoveryWorkflow, /git push[^\n]*--force/);
});


test('Gitee tag pipeline mirrors and verifies all Windows updater assets', () => {
  assert.match(giteeWorkflow, /tags:[\s\S]*include:[\s\S]*\^v\\d\+\\\.\\d\+\\\.\\d\+/);
  assert.match(giteeWorkflow, /nodeVersion: 14\.16\.0/);
  assert.match(giteeWorkflow, /variables:\s*\r?\n\s+global:\s*\r?\n\s+- CI_GITEE_ACCESS_TOKEN/);
  assert.match(giteeWorkflow, /set -eu/);
  assert.match(giteeWorkflow, /node-v22\.12\.0-linux-x64\.tar\.xz/);
  assert.match(giteeWorkflow, /22982235e1b71fa8850f82edd09cdae7e3f32df1764a9ec298c72d25ef2c164f[\s\S]*sha256sum --check/);
  assert.match(giteeWorkflow, /export PATH="\/tmp\/node-v22\.12\.0-linux-x64\/bin:\$PATH"/);
  assert.match(giteeWorkflow, /npm ci --ignore-scripts/);
  assert.match(giteeWorkflow, /git fetch --force origin 'refs\/tags\/\*:refs\/tags\/\*'/);
  assert.match(giteeWorkflow, /TAGS="\$\(git tag --points-at "\$GITEE_COMMIT"/);
  assert.match(giteeWorkflow, /wc -l\)" -eq 1/);
  assert.match(giteeWorkflow, /GITEE_ACCESS_TOKEN="\$CI_GITEE_ACCESS_TOKEN" node/);
  assert.match(giteeWorkflow, /node scripts\/mirror-github-release-to-gitee\.js/);
  assert.match(giteeWorkflow, /--tag "\$TAG" --target "\$GITEE_COMMIT"/);
  assert.match(giteeWorkflow, /--cos-releases-root "https:\/\/tst-update-package-1316411824\.cos\.ap-hongkong\.myqcloud\.com\/releases"/);
  assert.match(giteeWorkflow, /GITEE_RELEASE_ROOT="https:\/\/gitee\.com\/trigger-cn\/SerialTerminal\/releases\/download\/\$TAG"/);
  assert.match(giteeWorkflow, /--location.*--output \/tmp\/latest\.yml "\$GITEE_RELEASE_ROOT\/latest\.yml"/);
  assert.match(giteeWorkflow, /node scripts\/update-artifact-integrity\.js/);
  assert.match(giteeWorkflow, /SerialTerminal-Setup-\$VERSION\.exe\.blockmap/);
  assert.equal((giteeWorkflow.match(/--range 0-0 --output \/dev\/null/g) || []).length, 1);
});

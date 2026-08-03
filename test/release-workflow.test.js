'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const mirrorPublisher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'publish-update-mirror.sh'), 'utf8');

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
  assert.match(workflow, /Features/);
  assert.match(workflow, /Fixes/);
  assert.match(workflow, /Other Changes/);
  assert.match(workflow, /\(\[\^ \]\+\[\[:space:\]\]\+\)\?/);
  assert.match(workflow, /body_path: release-notes\.md/);
  assert.doesNotMatch(workflow, /generate_release_notes:\s*true/);
});

test('release publishes Windows updater files to the self-hosted mirror', () => {
  assert.deepEqual(packageJson.build.publish, {
    provider: 'generic',
    url: 'https://trigger-cn.top/serialterminal/'
  });
  assert.ok(packageJson.build.files.includes('!scripts/publish-update-mirror.sh'));
  assert.match(workflow, /MIRROR_SSH_PRIVATE_KEY: \$\{\{ secrets\.MIRROR_SSH_PRIVATE_KEY \}\}/);
  assert.match(workflow, /scp dist\/latest\.yml dist\/\*\.exe dist\/\*\.exe\.blockmap/);
  assert.match(workflow, /serialterminal-deploy@43\.157\.13\.24/);
  assert.match(workflow, /43\.157\.13\.24 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJGra2UcB4l6SAhzwZkrR6uNEF6h7729fQa7JRXaHrnc/);
  assert.doesNotMatch(workflow, /ssh-keyscan/);
  assert.match(workflow, /scp scripts\/publish-update-mirror\.sh/);
  assert.match(workflow, /Invalid release version/);
  assert.match(workflow, /SerialTerminalPackages\/bin\/publish/);
  assert.match(mirrorPublisher, /public_installer=.*latest\.yml/);
  assert.match(mirrorPublisher, /mv -Tf "\$PUBLIC\/latest\.yml\.new" "\$PUBLIC\/latest\.yml"/);
  assert.ok(
    workflow.indexOf('uses: softprops/action-gh-release@v3') < workflow.indexOf('name: Publish Windows update mirror'),
    'GitHub Release should be published before the mirror'
  );
});

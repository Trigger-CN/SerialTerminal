'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('release builds use a supported Windows toolchain', () => {
  assert.match(workflow, /os: windows-2022/);
  assert.match(workflow, /uses: microsoft\/setup-msbuild@v2/);
  assert.match(workflow, /uses: ilammy\/msvc-dev-cmd@v1/);
});

test('release build jobs never publish directly through electron-builder', () => {
  assert.equal(packageJson.scripts['dist:win'], 'electron-builder --win -c.npmRebuild=false --publish never');
  assert.equal(packageJson.scripts['dist:linux'], 'electron-builder --linux -c.npmRebuild=false --publish never');
  assert.match(workflow, /run: \$\{\{ matrix\.command \}\}/);
  assert.doesNotMatch(workflow, /matrix\.command \}\} --/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v2/);
});

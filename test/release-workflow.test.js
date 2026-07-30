'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'release.yml'), 'utf8');

test('release builds use a supported Windows toolchain', () => {
  assert.match(workflow, /os: windows-2022/);
  assert.match(workflow, /uses: microsoft\/setup-msbuild@v2/);
  assert.match(workflow, /uses: ilammy\/msvc-dev-cmd@v1/);
});

test('release build jobs never publish directly through electron-builder', () => {
  assert.match(workflow, /\$\{\{ matrix\.command \}\} -- --publish never/);
  assert.match(workflow, /needs: build/);
  assert.match(workflow, /uses: softprops\/action-gh-release@v2/);
});

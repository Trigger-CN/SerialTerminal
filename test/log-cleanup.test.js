'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanupExpiredLogFiles } = require('../log-cleanup');

const DAY_MS = 24 * 60 * 60 * 1000;

function createFile(directory, name, mtime) {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, name);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

test('cleanup deletes expired log files recursively and removes empty folders', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialterminal-log-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const now = Date.now();
  const oldTime = new Date(now - 8 * DAY_MS);
  const recentTime = new Date(now - 6 * DAY_MS);
  const expiredText = createFile(directory, 'old.txt', oldTime);
  const expiredLog = createFile(directory, 'old.LOG', oldTime);
  const expiredBinary = createFile(directory, 'old.bin', oldTime);
  const recentLog = createFile(directory, 'recent.txt', recentTime);
  const unrelated = createFile(directory, 'notes.json', oldTime);
  const nestedDirectory = path.join(directory, '2026-08-01');
  fs.mkdirSync(nestedDirectory);
  const nestedLog = createFile(nestedDirectory, 'old.txt', oldTime);
  const unrelatedDirectory = path.join(directory, 'archive');
  fs.mkdirSync(unrelatedDirectory);
  const unrelatedNestedLog = createFile(unrelatedDirectory, 'old.txt', oldTime);

  const result = await cleanupExpiredLogFiles(directory, 7, { now });

  assert.deepEqual(new Set(result.deleted), new Set([expiredText, expiredLog, expiredBinary, nestedLog]));
  assert.deepEqual(result.failed, []);
  assert.equal(fs.existsSync(recentLog), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(fs.existsSync(nestedDirectory), false);
  assert.equal(fs.existsSync(unrelatedNestedLog), true);
});

test('cleanup skips active log files even when expired', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'serialterminal-log-active-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const now = Date.now();
  const activeLog = createFile(directory, 'active.txt', new Date(now - 8 * DAY_MS));

  const result = await cleanupExpiredLogFiles(directory, 7, { now, activePaths: [activeLog] });

  assert.deepEqual(result.deleted, []);
  assert.equal(fs.existsSync(activeLog), true);
});

test('disabled cleanup does not access the directory', async () => {
  const result = await cleanupExpiredLogFiles('invalid\0path', 0);
  assert.deepEqual(result, { deleted: [], failed: [] });
});

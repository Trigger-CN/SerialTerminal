'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const testDirectory = path.join(__dirname, '..', 'test');
const testFiles = fs.readdirSync(testDirectory)
  .filter(file => file.endsWith('.test.js'))
  .sort()
  .map(file => path.join(testDirectory, file));

if (testFiles.length === 0) {
  console.error('No test files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('closing a serial session rotates the main text log path', () => {
  assert.match(main, /function ensureMainLogFilePath\(\)[\s\S]*?while \(fs\.existsSync\(mainLogFilePath\)\)[\s\S]*?`\$\{baseName\}_\$\{suffix\}\$\{extension\}`/);
  assert.match(main, /function closeMainLogSession\(\{ notify = true \} = \{\}\) \{[\s\S]*?saveLog\(\{ notify \}\);[\s\S]*?if \(logBuffer\.length === 0\) \{[\s\S]*?mainLogFilePath = '';[\s\S]*?\}/);
  assert.match(main, /ipcMain\.on\('flush-tab-logs'[\s\S]*?if \(currentConfig\.saveAllTabsLogToFiles\)[\s\S]*?else \{\s*closeMainLogSession\(\);/);
  assert.match(main, /function cleanupSerialConnection[\s\S]*?if \(!currentConfig\.saveAllTabsLogToFiles\) \{[\s\S]*?saveLog\(\);/);
  assert.doesNotMatch(main, /port\.on\('close',[\s\S]*?writeLog\('\\\r\\n\[SERIAL DISCONNECTED\]\\r\\n'\);\s*saveLog\(\);/);
});

test('enabling per-tab logs closes the previous main log session', () => {
  assert.match(main, /!currentConfig\.saveAllTabsLogToFiles && normalized\.saveAllTabsLogToFiles\) \{\s*closeMainLogSession\(\);/);
});

test('manual tab exports remember their last successful directory independently', () => {
  assert.match(main, /manualExportDirectory: app\.getPath\('documents'\)/);
  assert.match(main, /const exportDirectory = currentConfig\.manualExportDirectory \|\| app\.getPath\('documents'\)/);
  assert.match(main, /await fs\.promises\.writeFile\([\s\S]*?saveConfig\(\{ manualExportDirectory: path\.dirname\(result\.filePath\) \}\)/);
  assert.doesNotMatch(main, /defaultPath = path\.join\(currentConfig\.logPath/);
});

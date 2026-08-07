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

test('application diagnostics capture main and renderer process failures', () => {
  assert.match(main, /process\.on\('uncaughtException'/);
  assert.match(main, /process\.on\('unhandledRejection'/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /renderer-diagnostic-log/);
  assert.match(main, /log\.transports\.file\.getFile\(\)\.path/);
});

test('local Electron crash dumps are enabled without uploading data', () => {
  assert.match(main, /const \{ app,[\s\S]*crashReporter \} = require\('electron'\)/);
  assert.match(main, /app\.setPath\('crashDumps', crashDumpsPath\)/);
  assert.match(main, /crashReporter\.start\(\{[\s\S]*uploadToServer: false,[\s\S]*compress: true/);
  assert.match(main, /crashDumpsPath/);
});

test('expired log cleanup runs at startup, daily, and after settings change', () => {
  assert.match(main, /logRetentionDays = oneOf\(Number\(source\.logRetentionDays\), LOG_RETENTION_DAYS, 0\)/);
  assert.match(main, /function getActiveLogFilePaths\(\)[\s\S]*mainLogFilePath, rawBinaryLogPath[\s\S]*entry\.filePath/);
  assert.match(main, /function startLogCleanupTimer\(\)[\s\S]*runLogCleanup\(\)[\s\S]*setInterval\(runLogCleanup, LOG_CLEANUP_INTERVAL_MS\)/);
  assert.match(main, /logCleanupSettingsChanged[\s\S]*currentConfig = normalized;[\s\S]*if \(logCleanupSettingsChanged\) startLogCleanupTimer\(\)/);
  assert.match(main, /app\.whenReady\(\)[\s\S]*startLogCleanupTimer\(\)/);
  assert.match(main, /app\.on\('before-quit'[\s\S]*clearInterval\(logCleanupTimer\)/);
});

test('resetting preferences preserves the telemetry installation identity', () => {
  assert.match(main, /ipcMain\.on\('reset-config'[\s\S]*telemetryState = \{[\s\S]*telemetryInstallationId[\s\S]*telemetryLastReportedVersion/);
  assert.match(main, /currentConfig = loadConfig\(\);\s*currentConfig = normalizeConfig\(\{ \.\.\.currentConfig, \.\.\.telemetryState \}, currentConfig\)/);
});

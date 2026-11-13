'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const { createFixture } = require('./main-serial-fixture');

test('closing main logs rotates each group and enabling tab mode flushes all pending text', () => {
  const f = createFixture();
  f.run("getOrCreateSerialSession('default','COM_A');getOrCreateSerialSession('g-1','COM_B');writeLog('A','default');writeLog('B','g-1');saveConfig({saveAllTabsLogToFiles:true})");
  assert.equal(f.text('COM_A'), 'A');
  assert.equal(f.text('COM_B'), 'B');
  assert.equal(f.run("getGroupLogState('default').text.filePath"), '');
});

test('disabling Shell logging flushes only Shell sessions and keeps serial entries', () => {
  const f = createFixture({saveAllTabsLogToFiles:true,saveShellTabsLogToFiles:true});
  f.run("writeTabLog('tab-shell-1','Shell','SHELL');writeTabLog('tab-main','Main','SERIAL');saveConfig({saveShellTabsLogToFiles:false});writeTabLog('tab-shell-1','Shell','IGNORED')");
  assert.equal(f.text('_shell'),'SHELL');
  assert.equal(f.run("tabLogBuffers.has('tab-main')"),true);
  assert.equal(f.run("tabLogBuffers.has('tab-shell-1')"),false);
});


test('date folders rotate every group text, tab and RAW stream', () => {
  const f = createFixture({logCreateDateFolder:true,saveAllTabsLogToFiles:true});
  f.run("getOrCreateSerialSession('default','COM_A');getOrCreateSerialSession('g-1','COM_B');writeTabLog('tab-main','Main','OLD_A');writeTabLog('tab-main-g-1','Main','OLD_B','g-1');bufferRawSerialBytes(Buffer.from('RAW'),'g-1')");
  f.date('2026-11-14');
  f.run("writeTabLog('tab-main','Main','NEW_A');writeTabLog('tab-main-g-1','Main','NEW_B','g-1');flushPendingLogs()");
  const text = date => [...f.files].filter(([p]) => p.includes(date)).map(([,b]) => b.toString()).join('');
  assert.match(text('2026-11-13'), /OLD_A/);
  assert.match(text('2026-11-13'), /OLD_B/);
  assert.match(text('2026-11-13'), /RAW/);
  assert.doesNotMatch(text('2026-11-14'), /OLD|RAW/);
  assert.match(text('2026-11-14'), /NEW_A/);
  assert.match(text('2026-11-14'), /NEW_B/);
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
  assert.match(main, /const \{ app,[^\n]*crashReporter \} = require\('electron'\)/);
  assert.match(main, /app\.setPath\('crashDumps', crashDumpsPath\)/);
  assert.match(main, /crashReporter\.start\(\{[\s\S]*uploadToServer: false,[\s\S]*compress: true/);
  assert.match(main, /crashDumpsPath/);
});

test('expired log cleanup runs at startup, daily, and after settings change', () => {
  assert.match(main, /logRetentionDays = oneOf\(Number\(source\.logRetentionDays\), LOG_RETENTION_DAYS, 0\)/);
  assert.match(main, /function getActiveLogFilePaths\(\)[\s\S]*groupLogStates\.values\(\)[\s\S]*group\.text\.filePath[\s\S]*entry\.filePath/);
  assert.match(main, /function startLogCleanupTimer\(\)[\s\S]*runLogCleanup\(\)[\s\S]*setInterval\(runLogCleanup, LOG_CLEANUP_INTERVAL_MS\)/);
  assert.match(main, /logCleanupSettingsChanged[\s\S]*currentConfig = normalized;[\s\S]*if \(logCleanupSettingsChanged\) startLogCleanupTimer\(\)/);
  assert.match(main, /app\.whenReady\(\)[\s\S]*startLogCleanupTimer\(\)/);
  assert.match(main, /app\.on\('before-quit'[\s\S]*clearInterval\(logCleanupTimer\)/);
});

test('resetting preferences preserves the telemetry installation identity', () => {
  assert.match(main, /ipcMain\.on\('reset-config'[\s\S]*telemetryState = \{[\s\S]*telemetryInstallationId[\s\S]*telemetryLastReportedVersion/);
  assert.match(main, /currentConfig = loadConfig\(\);\s*currentConfig = normalizeConfig\(\{ \.\.\.currentConfig, \.\.\.telemetryState \}, currentConfig\)/);
});

test('turning automatic logging off flushes all tabs and prevents new writes after reconnect', async () => {
  const f = createFixture({saveAllTabsLogToFiles:true});
  await f.connect('default','COM_A');
  f.run("writeTabLog('tab-main','Main','BEFORE');saveConfig({logEnabled:false})");
  assert.equal(f.text('COM_A'),'BEFORE');
  await f.connect('default','COM_A');
  f.run("writeTabLog('tab-main','Main','AFTER');flushPendingLogs()");
  assert.equal(f.text('COM_A'),'BEFORE');
  assert.equal(f.run('tabLogBuffers.size'),0);
});

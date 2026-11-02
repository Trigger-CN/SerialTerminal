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

test('Shell tab logging is opt-in and flushes buffered Shell sessions when disabled', () => {
  assert.match(main, /function writeTabLog\(tabId, title, data\) \{[\s\S]*?tabId\.startsWith\('tab-shell-'\) && !currentConfig\.saveShellTabsLogToFiles/);
  assert.match(main, /function closeShellTabLogSessions\([\s\S]*?tabId\.startsWith\('tab-shell-'\)[\s\S]*?flushTabLogEntrySync\(tabId, entry\)[\s\S]*?tabLogBuffers\.delete\(tabId\)/);
  assert.match(main, /currentConfig\.saveShellTabsLogToFiles && !normalized\.saveShellTabsLogToFiles\) \{\s*closeShellTabLogSessions\(\);/);
});


test('date folders apply to main, tab, and raw logs and rotate at midnight', () => {
  assert.match(main, /logCreateDateFolder: false/);
  assert.match(main, /normalized\.logCreateDateFolder = normalizeBoolean\(source\.logCreateDateFolder, false\)/);
  assert.match(main, /function rotateLogFilesForCurrentDate\(\)[\s\S]*?flushRawBinaryLogSync\(\)[\s\S]*?saveAllTabLogs\(\{ notify: false, closeEntries: false \}\)[\s\S]*?saveLog\(\{ notify: false \}\)[\s\S]*?mainLogFilePath = '';[\s\S]*?rawBinaryLogPath = '';[\s\S]*?entry\.filePath = ''/);
  assert.match(main, /function writeLog\(data\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?ensureMainLogFilePath\(\)/);
  assert.match(main, /function writeTabLog\(tabId, title, data\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?ensureTabLogFile\(tabId\)/);
  assert.match(main, /function bufferRawSerialBytes\(data\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?ensureRawBinaryLogPath\(\)/);
  assert.match(main, /function ensureTabLogFile\(tabId\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?path\.join\(logDirectory, buildLogFileName/);
  assert.match(main, /function ensureMainLogFilePath\(\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?path\.join\(logDirectory, fileName\)/);
  assert.match(main, /function ensureRawBinaryLogPath\(\)[\s\S]*?rotateLogFilesForCurrentDate\(\)[\s\S]*?path\.join\(logDirectory, fileName\)/);
  assert.match(main, /normalized\.logCreateDateFolder !== currentConfig\.logCreateDateFolder/);
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

test('disabling automatic logging stops every file write path, including per-tab logs', () => {
  // writeTabLog 必须在分流前统一检查总开关，否则分标签页分支会绕过它继续 append。
  assert.match(main, /function writeTabLog\(tabId, title, data\) \{[\s\S]*?if \(!currentConfig\.logEnabled\) return;[\s\S]*?if \(tabId\.startsWith\('tab-shell-'\) && !currentConfig\.saveShellTabsLogToFiles\)/);
  // 分标签页刷盘与单标签页刷盘同样要受总开关约束。
  assert.match(main, /function saveAllTabLogs\([\s\S]*?if \(!currentConfig\.logEnabled \|\| !currentConfig\.saveAllTabsLogToFiles \|\| tabLogBuffers\.size === 0\) return;/);
  assert.match(main, /ipcMain\.on\('flush-tab-log'[\s\S]*?if \(!currentConfig\.logEnabled \|\| !currentConfig\.saveAllTabsLogToFiles \|\| !payload\.tabId\) \{ return; \}/);
  // 周期性刷盘在关闭后必须直接返回，不能创建空文件。
  assert.match(main, /function flushPendingLogs\(\{ notify = false \} = \{\}\) \{[\s\S]*?if \(!currentConfig\.logEnabled\) return;[\s\S]*?flushRawBinaryLogSync\(\);/);
  // 串口重连不能无条件重建主日志条目。
  assert.match(main, /if \(currentConfig\.logEnabled && currentConfig\.saveAllTabsLogToFiles\) \{\s*const title = 'Main_Terminal';/);
});

test('turning automatic logging off flushes and closes log sessions', () => {
  assert.match(main, /function closeLogSessionsForDisabled\(\) \{[\s\S]*?flushRawBinaryLogSync\(\)[\s\S]*?saveAllTabLogs\(\{ notify: false \}\)[\s\S]*?tabLogBuffers\.clear\(\)[\s\S]*?mainLogFilePath = '';[\s\S]*?rawBinaryLogPath = '';/);
  assert.match(main, /if \(currentConfig\.logEnabled && !normalized\.logEnabled\) \{[\s\S]*?closeLogSessionsForDisabled\(\);/);
});

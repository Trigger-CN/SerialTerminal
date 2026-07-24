const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { SerialPort } = require('serialport');
const iconv = require('iconv-lite');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const fontList = require('font-list');
const { t, getLanguage } = require('./i18n');
const { buildSerialWriteBuffer } = require('./serial-codec');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;

let mainWindow;
let prefsWindow;
let updatePromptState = {
  startupCheckInProgress: false,
  manualCheckInProgress: false,
  downloadInitiatedByPrompt: false,
  latestInfo: null
};
const configPath = path.join(app.getPath('userData'), 'config.json');
const CONFIG_VERSION = 3;
const SERIAL_MODES = new Set(['text', 'hex']);
const SERIAL_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);

function oneOf(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeConfig(config, defaults) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const normalized = { ...defaults, ...source, configVersion: CONFIG_VERSION };
  const oldSerial = source.lastSerialOptions && typeof source.lastSerialOptions === 'object'
    ? source.lastSerialOptions
    : {};
  const legacyEncoding = oneOf(oldSerial.encoding, new Set(['utf8', 'ascii', 'gbk', 'hex']), 'utf8');
  const migratedMode = legacyEncoding === 'hex' ? 'hex' : 'text';
  const migratedEncoding = legacyEncoding === 'hex' ? 'utf8' : legacyEncoding;
  normalized.lastSerialOptions = {
    ...defaults.lastSerialOptions,
    ...oldSerial,
    path: typeof oldSerial.path === 'string' ? oldSerial.path : defaults.lastSerialOptions.path,
    baudRate: typeof oldSerial.baudRate === 'string' || Number.isFinite(oldSerial.baudRate)
      ? String(oldSerial.baudRate)
      : defaults.lastSerialOptions.baudRate,
    dataBits: ['5', '6', '7', '8'].includes(String(oldSerial.dataBits))
      ? String(oldSerial.dataBits)
      : defaults.lastSerialOptions.dataBits,
    stopBits: ['1', '1.5', '2'].includes(String(oldSerial.stopBits))
      ? String(oldSerial.stopBits)
      : defaults.lastSerialOptions.stopBits,
    parity: oneOf(oldSerial.parity, new Set(['none', 'even', 'odd', 'mark', 'space']), defaults.lastSerialOptions.parity),
    receiveDisplayMode: oneOf(oldSerial.receiveDisplayMode, SERIAL_MODES, migratedMode),
    receiveEncoding: oneOf(oldSerial.receiveEncoding, SERIAL_ENCODINGS, migratedEncoding),
    sendMode: oneOf(oldSerial.sendMode, SERIAL_MODES, migratedMode),
    sendEncoding: oneOf(oldSerial.sendEncoding, SERIAL_ENCODINGS, migratedEncoding),
    appendCrLf: normalizeBoolean(oldSerial.appendCrLf,
      normalizeBoolean(source.mainInputSettings?.appendCrLf,
        normalizeBoolean(source.autoSendSettings?.appendCrLf, false))),
    newlineMode: oneOf(oldSerial.newlineMode, new Set(['crlf', 'lf', 'cr']), 'crlf')
  };
  delete normalized.lastSerialOptions.encoding;

  const oldHex = source.hexDisplaySettings && typeof source.hexDisplaySettings === 'object'
    ? source.hexDisplaySettings
    : {};
  const idleFlushMs = Number(oldHex.idleFlushMs);
  normalized.hexDisplaySettings = {
    bytesPerLine: oneOf(Number(oldHex.bytesPerLine), new Set([8, 16, 24, 32]), 16),
    showOffset: normalizeBoolean(oldHex.showOffset, true),
    showAscii: normalizeBoolean(oldHex.showAscii, true),
    uppercase: normalizeBoolean(oldHex.uppercase, true),
    idleFlushMs: Number.isFinite(idleFlushMs) && idleFlushMs >= 0 && idleFlushMs <= 1000
      ? idleFlushMs
      : 50
  };

  const oldMainInput = source.mainInputSettings && typeof source.mainInputSettings === 'object'
    ? source.mainInputSettings
    : {};
  normalized.mainInputSettings = {
    visible: normalizeBoolean(oldMainInput.visible, true),
    sendOnEnter: normalizeBoolean(oldMainInput.sendOnEnter, true)
  };

  const oldAutoSend = source.autoSendSettings && typeof source.autoSendSettings === 'object'
    ? source.autoSendSettings
    : {};
  normalized.autoSendSettings = {
    enabled: normalizeBoolean(oldAutoSend.enabled, false),
    interval: Number.isFinite(Number(oldAutoSend.interval)) && Number(oldAutoSend.interval) >= 10
      ? Number(oldAutoSend.interval)
      : 1000,
    content: typeof oldAutoSend.content === 'string'
      ? oldAutoSend.content
      : (typeof oldAutoSend.text === 'string' ? oldAutoSend.text : '')
  };

  const usedQuickIds = new Set();
  normalized.quickSendList = Array.isArray(source.quickSendList)
    ? source.quickSendList.filter(item => item && typeof item === 'object').map((item, index) => {
        let id = typeof item.id === 'string' && item.id ? item.id : `quick-${index + 1}`;
        if (usedQuickIds.has(id)) {
          let suffix = 2;
          while (usedQuickIds.has(`${id}-${suffix}`)) suffix++;
          id = `${id}-${suffix}`;
        }
        usedQuickIds.add(id);
        return {
          id,
          label: typeof item.label === 'string' ? item.label : '',
          content: typeof item.content === 'string'
            && Number(source.configVersion || 0) < CONFIG_VERSION
            && normalized.lastSerialOptions.appendCrLf
            && /\r\n$/.test(item.content)
            ? item.content.slice(0, -2)
            : (typeof item.content === 'string' ? item.content : '')
        };
      })
    : [];

  normalized.filterTabs = Array.isArray(source.filterTabs)
    ? source.filterTabs.filter(tab => tab && typeof tab === 'object').map(tab => ({
        ...tab,
        dataMode: oneOf(tab.dataMode, SERIAL_MODES, migratedMode)
      }))
    : [];
  normalized.saveRawSerialToFile = normalizeBoolean(source.saveRawSerialToFile, false);
  const rawBufferAutoFlushMB = Number(source.rawBufferAutoFlushMB);
  normalized.rawBufferAutoFlushMB = Number.isFinite(rawBufferAutoFlushMB)
    ? Math.min(1024, Math.max(1, rawBufferAutoFlushMB))
    : defaults.rawBufferAutoFlushMB;
  normalized.rawLogFileNameFormat = typeof source.rawLogFileNameFormat === 'string' && source.rawLogFileNameFormat.trim()
    ? source.rawLogFileNameFormat
    : 'raw_%Y-%m-%d_%H-%M-%S.bin';
  return normalized;
}

// Runtime Display Settings (Initialized from config later)
let displaySettings = {
    showTimestamp: false,
    showLineNumbers: false
};

function loadConfig() {
  const defaults = {
    configVersion: CONFIG_VERSION,
    fontSize: 14,
    fontFamily: 'Consolas',
    fontFamilyZh: '"Microsoft YaHei"',
    foreground: '#cccccc',
    background: '#000000',
    timestampColor: '#00ff00',
    lineNoColor: '#ffff00',
    logEnabled: false,
    saveAllTabsLogToFiles: false,
    rawBufferAutoFlushMB: 10,
    saveRawSerialToFile: false,
    rawLogFileNameFormat: 'raw_%Y-%m-%d_%H-%M-%S.bin',
    stripAnsiInLog: true,
    logPath: path.join(app.getPath('documents'), 'SerialTerminalLogs'),
    logFileNameFormat: 'log_%Y-%m-%d_%H-%M-%S.txt',
    logFileSuffix: '.txt',
    logEncoding: 'utf8',
    highlightRules: [
        { regex: "\\b(error|fail|failed|fatal)\\b", color: "#ff4d4f", enabled: true, caseSensitive: false, useRegex: true },
        { regex: "\\b(warn|warning)\\b", color: "#faad14", enabled: true, caseSensitive: false, useRegex: true },
        { regex: "\\b(info|debug|trace)\\b", color: "#1890ff", enabled: true, caseSensitive: false, useRegex: true },
        { regex: "\\b(success|ok|done)\\b", color: "#52c41a", enabled: true, caseSensitive: false, useRegex: true },
        { regex: "\\b\\d+(\\.\\d+)?\\b", color: "#13c2c2", enabled: true, caseSensitive: true, useRegex: true },
        { regex: "[+\\-*/=<>!&|%^~]+", color: "#eb2f96", enabled: true, caseSensitive: true, useRegex: true }
    ],
    showTimestamp: false,
    showLineNumbers: false,
    scrollbackLimit: 100000,
    historyBufferSize: 5000000,
    mouseWheelScrollLines: 3,
    filterHistory: [],
    windowBounds: {
      width: 1000,
      height: 700
    },
    filterTabs: [],
    shellTabs: [],
    shellProfiles: [
      { name: 'CMD', executable: 'cmd.exe', args: [], shellType: 'cmd' },
      { name: 'PowerShell', executable: 'powershell.exe', args: ['-NoLogo'], shellType: 'powershell' }
    ],
    defaultShellProfile: '',
    workspaceLayout: {
      splitEnabled: false,
      orientation: 'horizontal',
      activePaneId: 'pane-1',
        paneSizes: {
          'pane-1': 0.5,
          'pane-2': 0.5
        },
      panes: [
        {
          id: 'pane-1',
          activeTabId: 'tab-main',
          tabIds: ['tab-main']
        },
        {
          id: 'pane-2',
          activeTabId: null,
          tabIds: []
        }
      ]
    },
    mainInputSettings: {
      visible: true,
      sendOnEnter: true
    },
    autoSendSettings: {
      enabled: false,
      interval: 1000,
      content: ''
    },
    quickSendList: [],
    hexDisplaySettings: {
      bytesPerLine: 16,
      showOffset: true,
      showAscii: true,
      uppercase: true,
      idleFlushMs: 50
    },
    skippedUpdateVersion: '',
    lastSerialOptions: {
        path: '',
        baudRate: '9600',
        dataBits: '8',
        stopBits: '1',
        parity: 'none',
        receiveDisplayMode: 'text',
        receiveEncoding: 'utf8',
        sendMode: 'text',
        sendEncoding: 'utf8',
        appendCrLf: false,
        newlineMode: 'crlf'
    }
  };

  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const normalized = normalizeConfig(saved, defaults);
      if (JSON.stringify(saved) !== JSON.stringify(normalized)) {
        fs.writeFileSync(configPath, JSON.stringify(normalized, null, 2));
      }
      return normalized;
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }
  return normalizeConfig(defaults, defaults);
}

let currentConfig = loadConfig();
let terminalContextMenuState = null;
const shellSessions = new Map();

// Initialize display settings from config
displaySettings.showTimestamp = currentConfig.showTimestamp;
displaySettings.showLineNumbers = currentConfig.showLineNumbers;

let logBuffer = [];
let logBufferByteCount = 0;
let mainLogFilePath = '';
let tabLogBuffers = new Map();
let textLogFlushError = null;
let tabLogFlushError = null;
let rawBinaryBuffers = [];
let rawBinaryByteCount = 0;
let rawBinaryLogPath = '';
let rawBinaryFlushError = null;
let rawBinaryLogOverflowNotified = false;
let textLogOverflowNotified = false;
let tabLogOverflowNotified = false;
let logFlushTimer = null;
const logErrorNoticeKeys = new Set();
const LOG_AUTO_FLUSH_INTERVAL_MS = 5000;

function getAutoFlushThreshold() {
  const mb = Number(currentConfig.rawBufferAutoFlushMB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024;
}

function notifyLogError(kind, error, details = {}) {
  const message = error?.message || String(error || 'Unknown log write error');
  const noticeKey = `${kind}:${details.paused ? 'paused' : 'write'}:${message}`;
  if (logErrorNoticeKeys.has(noticeKey)) return;
  logErrorNoticeKeys.add(noticeKey);
  log.error(`Log write failed (${kind}):`, error);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-error', { kind, message, ...details });
  }
}

function clearLogErrorNotice(kind) {
  for (const key of Array.from(logErrorNoticeKeys)) {
    if (key.startsWith(`${kind}:`)) logErrorNoticeKeys.delete(key);
  }
}

function shouldAcceptMoreCachedLog(kind, byteCount, error, wasNotified) {
  if (!error || byteCount < getAutoFlushThreshold()) return true;
  if (!wasNotified) {
    notifyLogError(kind, error, { paused: true });
  }
  return false;
}

function ensureTabLogFile(tabId) {
  const entry = tabLogBuffers.get(tabId);
  if (!entry) return '';
  if (entry.filePath) return entry.filePath;
  ensureLogDirectory();
  entry.filePath = path.join(currentConfig.logPath, buildLogFileName({ tabTitle: entry.title || tabId }));
  tabLogBuffers.set(tabId, entry);
  return entry.filePath;
}

function appendToTabLogSync(tabId, data) {
  if (!data) return;
  const filePath = ensureTabLogFile(tabId);
  if (!filePath) return;
  const buffer = iconv.encode(data, currentConfig.logEncoding);
  fs.appendFileSync(filePath, buffer);
}

function flushTabLogEntrySync(tabId, entry) {
  if (!entry || !Array.isArray(entry.buffer) || entry.buffer.length === 0) return true;
  const allData = entry.buffer.join('');
  if (!allData) {
    entry.buffer = [];
    entry.byteCount = 0;
    return true;
  }
  try {
    appendToTabLogSync(tabId, allData);
    entry.buffer = [];
    entry.byteCount = 0;
    tabLogFlushError = null;
    tabLogOverflowNotified = false;
    clearLogErrorNotice('tab');
    return true;
  } catch (error) {
    tabLogFlushError = error;
    notifyLogError('tab', error, { tabId });
    return false;
  }
}

function buildRawLogFileName() {
  let fileName = formatFileName(currentConfig.rawLogFileNameFormat || 'raw_%Y-%m-%d_%H-%M-%S.bin');
  fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
  fileName = fileName.replace(/\.+$/g, '');
  if (!fileName) fileName = 'raw';
  if (!fileName.toLowerCase().endsWith('.bin')) fileName += '.bin';
  return fileName;
}

function ensureMainLogFilePath() {
  if (mainLogFilePath) return mainLogFilePath;
  ensureLogDirectory();
  mainLogFilePath = path.join(currentConfig.logPath, buildLogFileName({}));
  return mainLogFilePath;
}

function ensureRawBinaryLogPath() {
  if (rawBinaryLogPath) return rawBinaryLogPath;
  ensureLogDirectory();
  const fileName = buildRawLogFileName();
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  rawBinaryLogPath = path.join(currentConfig.logPath, fileName);
  let suffix = 2;
  while (fs.existsSync(rawBinaryLogPath)) {
    rawBinaryLogPath = path.join(currentConfig.logPath, `${baseName}_${suffix}${extension}`);
    suffix++;
  }
  return rawBinaryLogPath;
}

function flushRawBinaryLogSync() {
  if (rawBinaryBuffers.length === 0) return true;
  const snapshot = rawBinaryBuffers;
  const byteCount = rawBinaryByteCount;
  try {
    fs.appendFileSync(ensureRawBinaryLogPath(), Buffer.concat(snapshot, byteCount));
    rawBinaryBuffers = [];
    rawBinaryByteCount = 0;
    rawBinaryFlushError = null;
    rawBinaryLogOverflowNotified = false;
    clearLogErrorNotice('raw');
    return true;
  } catch (error) {
    rawBinaryFlushError = error;
    notifyLogError('raw', error);
    return false;
  }
}

function bufferRawSerialBytes(data) {
  if (!currentConfig.saveRawSerialToFile || !Buffer.isBuffer(data) || data.length === 0) return;
  if (!shouldAcceptMoreCachedLog('raw', rawBinaryByteCount, rawBinaryFlushError, rawBinaryLogOverflowNotified)) {
    rawBinaryLogOverflowNotified = true;
    return;
  }
  rawBinaryBuffers.push(Buffer.from(data));
  rawBinaryByteCount += data.length;
  if (rawBinaryByteCount >= getAutoFlushThreshold()) {
    flushRawBinaryLogSync();
  }
}

function sanitizeFileNamePart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatFileName(format, extra = {}) {
  const now = new Date();
  let formatted = String(format || 'log_%Y-%m-%d_%H-%M-%S')
    .replace('%Y', now.getFullYear())
    .replace('%m', String(now.getMonth() + 1).padStart(2, '0'))
    .replace('%d', String(now.getDate()).padStart(2, '0'))
    .replace('%H', String(now.getHours()).padStart(2, '0'))
    .replace('%M', String(now.getMinutes()).padStart(2, '0'))
    .replace('%S', String(now.getSeconds()).padStart(2, '0'));

  if (typeof extra.tabTitle === 'string') {
    formatted = formatted.replace(/%tab/g, sanitizeFileNamePart(extra.tabTitle) || 'tab');
  }

  return formatted;
}

function buildLogFileName(extra = {}) {
  let fileName = formatFileName(currentConfig.logFileNameFormat, extra);

  const hasTabTag = String(currentConfig.logFileNameFormat || '').includes('%tab');
  if (!hasTabTag && typeof extra.tabTitle === 'string' && extra.tabTitle) {
    const safeTitle = sanitizeFileNamePart(extra.tabTitle).replace(/\s+/g, '_');
    if (safeTitle) {
      fileName = safeTitle + '_' + fileName;
    }
  }

  fileName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!fileName) fileName = 'log';
  return fileName;
}


function ensureLogDirectory() {
  if (!fs.existsSync(currentConfig.logPath)) {
    fs.mkdirSync(currentConfig.logPath, { recursive: true });
  }
}

function saveLog({ notify = true } = {}) {
  try {
    if (logBuffer.length === 0) return;
    if (currentConfig.saveAllTabsLogToFiles) {
      logBuffer = [];
      logBufferByteCount = 0;
      return;
    }
    const snapshot = logBuffer;
    const byteCount = logBufferByteCount;
    const allData = snapshot.join('');
    if (!allData) return;
    const filePath = ensureMainLogFilePath();
    fs.appendFileSync(filePath, iconv.encode(allData, currentConfig.logEncoding));
    if (logBuffer === snapshot) {
      logBuffer = [];
      logBufferByteCount = 0;
    } else {
      logBuffer.splice(0, snapshot.length);
      logBufferByteCount = Math.max(0, logBufferByteCount - byteCount);
    }
    textLogFlushError = null;
    textLogOverflowNotified = false;
    clearLogErrorNotice('text');
    if (notify && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-saved', { path: filePath });
    }
  } catch (err) {
    textLogFlushError = err;
    notifyLogError('text', err);
  }
}

function saveAllTabLogs({ notify = true, closeEntries = true } = {}) {
  if (!currentConfig.saveAllTabsLogToFiles || tabLogBuffers.size === 0) return;
  const savedPaths = [];
  const completedTabIds = [];
  for (const [tabId, entry] of tabLogBuffers.entries()) {
    if (!flushTabLogEntrySync(tabId, entry)) {
      tabLogBuffers.set(tabId, entry);
      continue;
    }
    if (entry.filePath && fs.existsSync(entry.filePath)) savedPaths.push(entry.filePath);
    if (closeEntries) completedTabIds.push(tabId);
  }
  completedTabIds.forEach(tabId => tabLogBuffers.delete(tabId));
  if (notify && savedPaths.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('all-tabs-log-saved', { paths: savedPaths });
  }
}

function stripAnsi(str) {
  if (typeof str !== 'string' || !str) return str || '';
  if (currentConfig.stripAnsiInLog === false) return str;
  // Only strip SGR sequences (color/style codes ending with 'm'),
  // avoiding false positives on raw binary data that contains other CSI sequences.
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeLog(data) {
  if (!currentConfig.logEnabled || !data || currentConfig.saveAllTabsLogToFiles) return;
  if (!shouldAcceptMoreCachedLog('text', logBufferByteCount, textLogFlushError, textLogOverflowNotified)) {
    textLogOverflowNotified = true;
    return;
  }
  logBuffer.push(data);
  logBufferByteCount += Buffer.byteLength(data);
  if (logBufferByteCount >= getAutoFlushThreshold()) {
    saveLog({ notify: false });
  }
}

function writeTabLog(tabId, title, data) {
  if (!tabId || typeof data !== 'string' || !data) return;
  const clean = stripAnsi(data);
  if (tabId === 'tab-main' && currentConfig.logEnabled) {
    writeLog(clean);
  }
  if (!currentConfig.saveAllTabsLogToFiles) return;
  const existing = tabLogBuffers.get(tabId) || { title: '', buffer: [], filePath: '', byteCount: 0 };
  if (!shouldAcceptMoreCachedLog('tab', existing.byteCount || 0, tabLogFlushError, tabLogOverflowNotified)) {
    tabLogOverflowNotified = true;
    return;
  }
  existing.title = title || existing.title || tabId;
  existing.buffer.push(clean);
  existing.byteCount = (existing.byteCount || 0) + Buffer.byteLength(clean);
  if (existing.byteCount >= getAutoFlushThreshold()) {
    flushTabLogEntrySync(tabId, existing);
  }
  tabLogBuffers.set(tabId, existing);
}

function flushPendingLogs({ notify = false } = {}) {
  flushRawBinaryLogSync();
  if (currentConfig.saveAllTabsLogToFiles) {
    saveAllTabLogs({ notify, closeEntries: false });
  } else {
    saveLog({ notify });
  }
}

function startLogAutoFlushTimer() {
  if (logFlushTimer) clearInterval(logFlushTimer);
  logFlushTimer = setInterval(() => flushPendingLogs({ notify: false }), LOG_AUTO_FLUSH_INTERVAL_MS);
}

function saveConfig(config) {
  const merged = { ...currentConfig, ...config };
  for (const key of ['lastSerialOptions', 'hexDisplaySettings', 'mainInputSettings', 'autoSendSettings']) {
    if (config && config[key] && typeof config[key] === 'object') {
      merged[key] = { ...currentConfig[key], ...config[key] };
    }
  }
  if (config?.lastSerialOptions && typeof config.lastSerialOptions.encoding === 'string') {
    const legacyEncoding = config.lastSerialOptions.encoding;
    merged.lastSerialOptions.receiveDisplayMode = legacyEncoding === 'hex' ? 'hex' : 'text';
    merged.lastSerialOptions.sendMode = legacyEncoding === 'hex' ? 'hex' : 'text';
    if (legacyEncoding !== 'hex' && SERIAL_ENCODINGS.has(legacyEncoding)) {
      merged.lastSerialOptions.receiveEncoding = legacyEncoding;
      merged.lastSerialOptions.sendEncoding = legacyEncoding;
    }
  }
  if (config?.autoSendSettings && typeof config.autoSendSettings.text === 'string'
      && typeof config.autoSendSettings.content !== 'string') {
    merged.autoSendSettings.content = config.autoSendSettings.text;
  }
  const normalized = normalizeConfig(merged, currentConfig);
  const rawLogDestinationChanged = normalized.logPath !== currentConfig.logPath
    || normalized.rawLogFileNameFormat !== currentConfig.rawLogFileNameFormat;
  const textLogDestinationChanged = normalized.logPath !== currentConfig.logPath
    || normalized.logFileNameFormat !== currentConfig.logFileNameFormat
    || normalized.logEncoding !== currentConfig.logEncoding;
  if (currentConfig.logEnabled && textLogDestinationChanged) {
    if (currentConfig.saveAllTabsLogToFiles) saveAllTabLogs();
    else saveLog();
  }
  if (currentConfig.saveRawSerialToFile
      && (!normalized.saveRawSerialToFile || rawLogDestinationChanged)
      && !flushRawBinaryLogSync()) {
    throw rawBinaryFlushError || new Error('Failed to flush pending raw serial log');
  }
  if (textLogDestinationChanged) {
    mainLogFilePath = '';
  }
  if (rawLogDestinationChanged) {
    rawBinaryLogPath = '';
  }
  if (currentConfig.saveAllTabsLogToFiles && !normalized.saveAllTabsLogToFiles) {
    saveAllTabLogs();
  } else if (!currentConfig.saveAllTabsLogToFiles && normalized.saveAllTabsLogToFiles) {
    saveLog();
  }
  currentConfig = normalized;
  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
}

function findShellProfile(shellTypeOrName) {
  const profiles = Array.isArray(currentConfig.shellProfiles) ? currentConfig.shellProfiles : [];
  if (!profiles.length) {
    return null;
  }
  const search = String(shellTypeOrName || 'auto').toLowerCase();
  // First try exact name match
  const byName = profiles.find(p => String(p.name || '').toLowerCase() === search);
  if (byName) return byName;
  // Then try shellType match
  const byType = profiles.find(p => String(p.shellType || '').toLowerCase() === search);
  if (byType) return byType;
  // Return first profile as fallback
  return profiles[0] || null;
}

function getDefaultShellPath(shellType = 'auto') {
  const profile = findShellProfile(shellType);
  if (profile && profile.executable) {
    return profile.executable;
  }
  if (process.platform === 'win32') {
    switch (String(shellType || 'auto').toLowerCase()) {
      case 'cmd': return process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
      case 'powershell': return 'powershell.exe';
      case 'pwsh': return 'pwsh.exe';
      default: return process.env.COMSPEC || 'C:\\Windows\\System32\\cmd.exe';
    }
  }
  switch (String(shellType || 'auto').toLowerCase()) {
    case 'bash': return '/bin/bash';
    case 'zsh': return '/bin/zsh';
    default: return process.env.SHELL || '/bin/bash';
  }
}

function getShellLaunchArgs(shellPath, shellTypeOrName) {
  const profile = findShellProfile(shellTypeOrName);
  if (profile && Array.isArray(profile.args) && profile.args.length > 0) {
    return profile.args;
  }
  if (process.platform !== 'win32') {
    return ['-i'];
  }

  const lowerShellPath = String(shellPath || '').toLowerCase();
  if (lowerShellPath.includes('powershell')) {
    return ['-NoLogo'];
  }

  return [];
}

function createShellSession(tabId, options = {}) {
  if (!tabId || shellSessions.has(tabId)) {
    return shellSessions.get(tabId) || null;
  }

  const shellType = typeof options.shellType === 'string' ? options.shellType : 'auto';
  const shellPath = getDefaultShellPath(shellType);
  const session = {
    tabId,
    shellPath,
    shellType,
    cols: Math.max(1, Number(options.cols) || 80),
    rows: Math.max(1, Number(options.rows) || 24),
    cwd: process.cwd(),
    ptyProcess: null
  };

  const ptyProcess = pty.spawn(shellPath, getShellLaunchArgs(shellPath, shellType), {
    name: 'xterm-color',
    cols: session.cols,
    rows: session.rows,
    cwd: session.cwd,
    env: process.env
  });

  session.ptyProcess = ptyProcess;
  shellSessions.set(tabId, session);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell-tab-output', { tabId, data });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    shellSessions.delete(tabId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell-tab-exit', { tabId, exitCode, signal });
    }
  });

  return session;
}

function closeShellSession(tabId) {
  const session = shellSessions.get(tabId);
  if (!session) return false;
  shellSessions.delete(tabId);
  try {
    session.ptyProcess?.kill();
  } catch (error) {
    log.warn(`Failed to close shell session ${tabId}:`, error);
  }
  return true;
}

function tr(key, params = {}) {
  return t(getLanguage(currentConfig.language), key, params);
}

function createWindow() {
  const windowBounds = currentConfig.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1000,
    height: windowBounds.height || 700,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

  // Open DevTools automatically for debugging
  // mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      console.log(`[RENDERER] ${message} (${sourceId}:${line})`);
  });

  mainWindow.on('resize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    saveConfig({
      windowBounds: {
        width: bounds.width,
        height: bounds.height
      }
    });
  });
}

function createPrefsWindow() {
  if (prefsWindow) {
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 750,
    height: 650,
    parent: mainWindow,
    modal: true,
    title: 'Preferences',
    backgroundColor: '#252526',
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  prefsWindow.loadFile('preferences.html');
  prefsWindow.on('closed', () => {
    prefsWindow = null;
  });
}

function getReleaseUrl() {
  const pkg = require('./package.json');
  if (pkg.homepage) return pkg.homepage;
  const repoUrl = pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : '';
  if (repoUrl.includes('github.com')) {
    return repoUrl.replace(/\.git$/i, '').replace(/#.*$/, '') + '/releases/latest';
  }
  return 'https://github.com/Trigger-CN/SerialTerminal/releases/latest';
}

function getGithubRepoInfo() {
  const pkg = require('./package.json');
  const repoUrl = pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : '';
  const matched = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i);
  if (!matched) {
    return null;
  }
  return {
    owner: matched[1],
    repo: matched[2]
  };
}

async function fetchGithubReleaseNotes(version) {
  const repoInfo = getGithubRepoInfo();
  if (!repoInfo || !version) return '';

  const tagsToTry = [`v${version}`, version];

  for (const tag of tagsToTry) {
    const apiUrl = `https://api.github.com/repos/${repoInfo.owner}/${repoInfo.repo}/releases/tags/${encodeURIComponent(tag)}`;
    try {
      const response = await fetch(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': `${app.getName()}/${app.getVersion()}`
        }
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      return typeof data.body === 'string' ? data.body.trim() : '';
    } catch (error) {
      log.warn(`Failed to fetch release notes for tag ${tag}:`, error);
    }
  }

  return '';
}

async function promptForAvailableUpdate(info, isStartupPrompt = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const version = info?.version || '';
  const detailLines = [];
  if (info?.releaseName) detailLines.push(`${tr('updateDialog.releaseLabel')} ${info.releaseName}`);
  if (info?.releaseDate) detailLines.push(`${tr('updateDialog.dateLabel')} ${new Date(info.releaseDate).toLocaleString()}`);
  const releaseNotes = await fetchGithubReleaseNotes(version);

  if (!releaseNotes) {
    detailLines.push('', tr('updateDialog.releaseNotesLabel'), tr('updateDialog.releaseNotesUnavailable'));
  } else {
    detailLines.push('', tr('updateDialog.releaseNotesLabel'), releaseNotes.slice(0, 1200));
  }

  const buttons = [
    tr('updateDialog.updateNow'),
    tr('updateDialog.notNow'),
    tr('updateDialog.skipThisVersion')
  ];
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons,
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: tr('updateDialog.softwareUpdateTitle'),
    message: tr('updateDialog.versionAvailable', { version }),
    detail: `${isStartupPrompt ? tr('updateDialog.foundOnStartup') : tr('updateDialog.newUpdateAvailable')}${detailLines.length ? `\n\n${detailLines.join('\n')}` : ''}`
  });

  if (result.response === 0) {
    updatePromptState.downloadInitiatedByPrompt = true;
    autoUpdater.downloadUpdate();
    return;
  }

  if (result.response === 2 && version) {
    saveConfig({ skippedUpdateVersion: version });
  }
}

async function promptToInstallDownloadedUpdate(info) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const version = info?.version || tr('updateDialog.newVersionFallback');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: [tr('updateDialog.installAndRestart'), tr('updateDialog.later')],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: tr('updateDialog.updateReadyTitle'),
    message: tr('updateDialog.versionDownloaded', { version }),
    detail: tr('updateDialog.restartToInstall')
  });

  if (result.response === 0) {
    autoUpdater.quitAndInstall();
  }
}

function checkForAppUpdates({ manual = false } = {}) {
  if (!app.isPackaged || process.env.NODE_ENV === 'development') {
    if (manual) {
      setTimeout(() => {
        sendUpdateStatusToPrefs('not-available', { version: 'Development' });
      }, 200);
    }
    return;
  }

  updatePromptState.manualCheckInProgress = manual;
  updatePromptState.startupCheckInProgress = !manual;
  updatePromptState.downloadInitiatedByPrompt = false;
  autoUpdater.checkForUpdates();
}

app.whenReady().then(() => {
  createWindow();
  startLogAutoFlushTimer();
  checkForAppUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-about-info', () => {
  const pkg = require('./package.json');
  let author = pkg.author || 'Your Name';
  if (typeof author === 'object' && author.name) {
      author = author.name;
      if (author.email) {
          author += ` <${author.email}>`;
      }
  }
  return {
    version: app.getVersion(),
    author: author,
    github: pkg.homepage || (pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : 'https://github.com/your/repo')
  };
});

app.on('before-quit', () => {
  if (logFlushTimer) clearInterval(logFlushTimer);
  Array.from(shellSessions.keys()).forEach(tabId => closeShellSession(tabId));
  flushRawBinaryLogSync();
  saveLog();
  saveAllTabLogs();
});

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(prefsWindow || mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('select-shell-executable', async () => {
  const result = await dialog.showOpenDialog(prefsWindow || mainWindow, {
    title: tr('prefs.selectShellExecutable') || 'Select Shell Executable',
    filters: [
      { name: 'Executable Files', extensions: ['exe', 'bat', 'cmd', 'com'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled) {
    return null;
  } else {
    return result.filePaths[0];
  }
});

ipcMain.handle('get-config', () => {
  return currentConfig;
});

ipcMain.on('open-prefs', () => {
  createPrefsWindow();
});

ipcMain.on('update-display-settings', (event, settings) => {
    displaySettings = { ...displaySettings, ...settings };
    
    // Save to config
    currentConfig = { ...currentConfig, ...settings };
    saveConfig(currentConfig);
});

ipcMain.on('reset-config', (event) => {
  // Delete config file
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  
  // Reload defaults
  currentConfig = loadConfig();
  
  // Update runtime settings
  displaySettings.showTimestamp = currentConfig.showTimestamp;
  displaySettings.showLineNumbers = currentConfig.showLineNumbers;
  
  // Save defaults back to file (optional, but good for consistency)
  saveConfig(currentConfig);
  
  // Broadcast updates
  if (mainWindow) {
    mainWindow.webContents.send('config-updated', currentConfig);
    mainWindow.webContents.send('update-display-settings', displaySettings);
  }
});

ipcMain.on('open-config-folder', () => {
    shell.showItemInFolder(configPath);
});

ipcMain.on('open-log-folder', () => {
    const logDir = currentConfig.logPath;
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }
    shell.openPath(logDir);
});

ipcMain.on('save-config', (event, config) => {
  try {
    saveConfig(config);
    if (mainWindow) {
      mainWindow.webContents.send('config-updated', currentConfig);
    }
  } catch (error) {
    log.error('Failed to save config:', error);
    if (!event.sender.isDestroyed()) {
      event.sender.send('config-save-error', error?.message || String(error));
    }
  }
});

ipcMain.handle('save-config-request', (event, config) => {
  saveConfig(config);
  if (mainWindow) {
    mainWindow.webContents.send('config-updated', currentConfig);
  }
  return { ok: true };
});

ipcMain.on('write-tab-log', (event, payload = {}) => {
  writeTabLog(payload.tabId, payload.title, payload.data);
});

ipcMain.on('flush-tab-logs', () => {
  if (currentConfig.saveAllTabsLogToFiles) {
    saveAllTabLogs();
  } else {
    saveLog();
  }
});

ipcMain.on('flush-tab-log', (event, payload = {}) => {
  if (!currentConfig.saveAllTabsLogToFiles || !payload.tabId) { return; }
  const entry = tabLogBuffers.get(payload.tabId);
  if (!entry || !Array.isArray(entry.buffer) || entry.buffer.length === 0) { return; }
  if (flushTabLogEntrySync(payload.tabId, entry)) {
    const filePath = entry.filePath || '';
    tabLogBuffers.delete(payload.tabId);
    if (filePath && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-saved', { path: filePath });
    }
  }
});

ipcMain.on('show-terminal-context-menu', (event, payload = {}) => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!browserWindow || browserWindow.isDestroyed()) return;

  terminalContextMenuState = {
    tabId: payload.tabId || '',
    terminalType: payload.terminalType || 'main',
    paneId: payload.paneId || 'pane-1'
  };

  const hasSelection = Boolean(payload.hasSelection);
  const isConnected = Boolean(payload.isConnected);
  const canLocateInMain = Boolean(payload.canLocateInMain);
  const terminalType = payload.terminalType === 'filter'
    ? 'filter'
    : (payload.terminalType === 'shell' ? 'shell' : 'main');
  const labels = payload.labels || {};

  const sendAction = (action) => {
    event.sender.send('terminal-context-menu-action', {
      action,
      tabId: terminalContextMenuState?.tabId || '',
      terminalType,
      paneId: terminalContextMenuState?.paneId || 'pane-1'
    });
  };

  const withIcon = (icon, label, fallback) => `${String(icon || '').padEnd(5, ' ')} ${label || fallback}`;

  const template = [
    {
      label: withIcon('[+]', labels.newFilterTab, 'New Filter Tab'),
      click: () => sendAction('new-filter-tab')
    },
    {
      label: withIcon('[>]', labels.newShellTab, 'New Shell Tab'),
      click: () => sendAction('new-shell-tab')
    },
    {
      label: withIcon('[H]', labels.splitHorizontal, 'Move Tab to Right Split'),
      enabled: terminalType !== 'main' && Boolean(payload.tabId),
      click: () => sendAction('split-horizontal')
    },
    {
      label: withIcon('[V]', labels.splitVertical, 'Move Tab to Bottom Split'),
      enabled: terminalType !== 'main' && Boolean(payload.tabId),
      click: () => sendAction('split-vertical')
    },
    {
      label: withIcon('[x]', labels.closeSplit, 'Close Split'),
      enabled: Boolean(payload.splitEnabled),
      click: () => sendAction('close-split')
    }
  ];

  if (terminalType === 'main') {
    template.push(
      { type: 'separator' },
      {
        label: withIcon('[P]', labels.pasteAndSend, 'Paste and Send'),
        enabled: isConnected,
        click: () => sendAction('paste-send')
      },
      {
        label: withIcon('[S]', labels.sendSelection, 'Send Selection'),
        enabled: hasSelection && isConnected,
        click: () => sendAction('send-selection')
      },
      {
        label: withIcon('[F]', labels.createFilterFromSelection, 'Create Filter Tab from Selection'),
        enabled: hasSelection,
        click: () => sendAction('create-filter-from-selection')
      },
      { type: 'separator' },
      {
        label: withIcon('[C]', labels.copy, 'Copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: withIcon('[A]', labels.copyAll, 'Copy All'),
        click: () => sendAction('copy-all')
      },
      {
        label: withIcon('[?]', labels.findSelection, 'Find Selection'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: withIcon('[!]', labels.clearTerminal, 'Clear Terminal'),
        click: () => sendAction('clear-terminal')
      }
    );
    if (payload.receiveDisplayMode === 'hex') {
      template.push({
        label: withIcon('[0]', labels.clearAndResetHex, 'Clear and Reset Hex Offset'),
        click: () => sendAction('clear-and-reset-hex')
      });
    }
  } else if (terminalType === 'filter') {
    template.push(
      { type: 'separator' },
      {
        label: withIcon('[M]', labels.moveToOtherPane, 'Move to Other Pane'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('move-to-other-pane')
      },
      {
        label: withIcon('[X]', labels.closeFilterTab, 'Close Filter Tab'),
        click: () => sendAction('close-filter-tab')
      },
      { type: 'separator' },
      {
        label: withIcon('[=]', labels.useSelectionAsFilter, 'Use Selection as Filter'),
        enabled: hasSelection,
        click: () => sendAction('use-selection-as-filter')
      },
      {
        label: withIcon('[+]', labels.appendSelectionToFilter, 'Append Selection to Filter'),
        enabled: hasSelection,
        click: () => sendAction('append-selection-to-filter')
      },
      {
        label: withIcon('[L]', labels.locateInMainTerminal, 'Locate in Main Terminal'),
        enabled: canLocateInMain,
        click: () => sendAction('locate-in-main-terminal')
      },
      {
        label: withIcon('[Aa]', labels.toggleMatchCase, 'Toggle Match Case'),
        type: 'checkbox',
        checked: Boolean(payload.caseSensitive),
        click: () => sendAction('toggle-case-sensitive')
      },
      {
        label: withIcon('.* ', labels.toggleRegex, 'Toggle Regex'),
        type: 'checkbox',
        checked: Boolean(payload.useRegex),
        click: () => sendAction('toggle-regex')
      },
      {
        label: withIcon('[C]', labels.copy, 'Copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: withIcon('[A]', labels.copyAll, 'Copy All'),
        click: () => sendAction('copy-all')
      },
      {
        label: withIcon('[?]', labels.findSelection, 'Find Selection'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: withIcon('[!]', labels.clearTerminal, 'Clear Terminal'),
        click: () => sendAction('clear-terminal')
      }
    );
  } else {
    template.push(
      { type: 'separator' },
      {
        label: withIcon('[M]', labels.moveToOtherPane, 'Move to Other Pane'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('move-to-other-pane')
      },
      {
        label: withIcon('[R]', labels.restartShell, 'Restart Shell'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('restart-shell')
      },
      {
        label: withIcon('[X]', labels.closeShellTab, 'Close Shell Tab'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('close-shell-tab')
      },
      { type: 'separator' },
      {
        label: withIcon('[>]', labels.newShellTab, 'New Shell Tab'),
        click: () => sendAction('new-shell-tab')
      },
      { type: 'separator' },
      {
        label: withIcon('[P]', labels.pasteAndSend, 'Paste and Send'),
        click: () => sendAction('paste-send')
      },
      {
        label: withIcon('[S]', labels.sendSelection, 'Send Selection'),
        enabled: hasSelection,
        click: () => sendAction('send-selection')
      },
      {
        label: withIcon('[C]', labels.copy, 'Copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: withIcon('[A]', labels.copyAll, 'Copy All'),
        click: () => sendAction('copy-all')
      },
      {
        label: withIcon('[?]', labels.findSelection, 'Find Selection'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: withIcon('[!]', labels.clearTerminal, 'Clear Terminal'),
        click: () => sendAction('clear-terminal')
      }
    );
  }

  const menu = Menu.buildFromTemplate(template);
  menu.popup({ window: browserWindow });
});

ipcMain.handle('get-system-fonts', async () => {
    try {
        const fonts = await fontList.getFonts();
        // Remove quotes from font names (font-list often returns them wrapped in quotes)
        return fonts.map(f => f.replace(/^"|"$/g, ''));
    } catch (err) {
        log.error('Failed to get system fonts:', err);
        return [];
    }
});

// Auto Updater Events
function sendUpdateStatusToPrefs(status, data) {
    if (prefsWindow && !prefsWindow.isDestroyed()) {
        prefsWindow.webContents.send('update-status', { status, data });
    }
}

autoUpdater.on('checking-for-update', () => {
    sendUpdateStatusToPrefs('checking');
});

autoUpdater.on('update-available', (info) => {
  updatePromptState.latestInfo = info;
    sendUpdateStatusToPrefs('available', info);

  if (currentConfig.skippedUpdateVersion && currentConfig.skippedUpdateVersion === info.version) {
    updatePromptState.startupCheckInProgress = false;
    updatePromptState.manualCheckInProgress = false;
    return;
  }

  promptForAvailableUpdate(info, updatePromptState.startupCheckInProgress).catch(err => {
    log.error('Failed to show update prompt:', err);
  });
});

autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatusToPrefs('not-available', info);
  updatePromptState.startupCheckInProgress = false;
  updatePromptState.manualCheckInProgress = false;
});

autoUpdater.on('error', (err) => {
    sendUpdateStatusToPrefs('error', err.message);
  updatePromptState.startupCheckInProgress = false;
  updatePromptState.manualCheckInProgress = false;
});

autoUpdater.on('download-progress', (progressObj) => {
    sendUpdateStatusToPrefs('download-progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
    sendUpdateStatusToPrefs('downloaded', info);
  saveConfig({ skippedUpdateVersion: '' });
  updatePromptState.startupCheckInProgress = false;
  updatePromptState.manualCheckInProgress = false;

  if (updatePromptState.downloadInitiatedByPrompt) {
    promptToInstallDownloadedUpdate(info).catch(err => {
      log.error('Failed to show install prompt:', err);
    });
  }
});

ipcMain.on('check-for-updates', () => {
  checkForAppUpdates({ manual: true });
});

ipcMain.handle('open-release-page', () => {
  return shell.openExternal(getReleaseUrl());
});

ipcMain.on('quit-and-install', () => {
    autoUpdater.quitAndInstall();
});

ipcMain.handle('create-shell-tab-session', async (event, payload = {}) => {
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
  if (!tabId) {
    throw new Error('Missing shell tab id');
  }

  const session = createShellSession(tabId, payload);
  if (!session) {
    throw new Error('Failed to create shell session');
  }

  return {
    shellPath: session.shellPath,
    cols: session.cols,
    rows: session.rows
  };
});

ipcMain.handle('get-shell-profiles', async () => {
  const profiles = Array.isArray(currentConfig.shellProfiles) ? currentConfig.shellProfiles : [];
  const defaultName = currentConfig.defaultShellProfile || '';
  return {
    profiles: profiles.map(p => ({
      name: p.name || '',
      executable: p.executable || '',
      args: Array.isArray(p.args) ? p.args : [],
      shellType: p.shellType || 'auto'
    })),
    defaultName
  };
});

ipcMain.on('shell-tab-input', (event, payload = {}) => {
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
  const data = typeof payload.data === 'string' ? payload.data : '';
  const session = shellSessions.get(tabId);
  if (!session || !data) return;
  session.ptyProcess.write(data);
});

ipcMain.on('resize-shell-tab', (event, payload = {}) => {
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
  const cols = Math.max(1, Number(payload.cols) || 0);
  const rows = Math.max(1, Number(payload.rows) || 0);
  const session = shellSessions.get(tabId);
  if (!session || !cols || !rows) return;
  session.cols = cols;
  session.rows = rows;
  try {
    session.ptyProcess.resize(cols, rows);
  } catch (error) {
    log.warn(`Failed to resize shell session ${tabId}:`, error);
  }
});

ipcMain.on('close-shell-tab-session', (event, payload = {}) => {
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
  if (!tabId) return;
  closeShellSession(tabId);
});

// Serial Port Setup
let currentSerialPort = null;
let serialSendEncoding = 'utf8';
let serialNewlineMode = 'crlf';
let serialCleanupComplete = true;
let serialSessionId = 0;
let serialConnectInProgress = false;
const THROUGHPUT_SAMPLE_MS = 1000;
const THROUGHPUT_HISTORY_LENGTH = 30;
let throughputTimer = null;
let throughputState = {
  connected: false,
  rxCurrentBytes: 0,
  txCurrentBytes: 0,
  rxHistory: Array(THROUGHPUT_HISTORY_LENGTH).fill(0),
  txHistory: Array(THROUGHPUT_HISTORY_LENGTH).fill(0)
};

function createEmptyThroughputHistory() {
  return Array(THROUGHPUT_HISTORY_LENGTH).fill(0);
}

function sendThroughputUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('serial-throughput-update', {
      connected: throughputState.connected,
      rxHistory: [...throughputState.rxHistory],
      txHistory: [...throughputState.txHistory],
      rxBytesPerSecond: throughputState.rxCurrentBytes,
      txBytesPerSecond: throughputState.txCurrentBytes
    });
  }
}

function resetThroughputState(connected = false) {
  throughputState.connected = connected;
  throughputState.rxCurrentBytes = 0;
  throughputState.txCurrentBytes = 0;
  throughputState.rxHistory = createEmptyThroughputHistory();
  throughputState.txHistory = createEmptyThroughputHistory();
}

function stopThroughputSampling() {
  if (throughputTimer) {
    clearInterval(throughputTimer);
    throughputTimer = null;
  }
}

function startThroughputSampling() {
  stopThroughputSampling();
  throughputTimer = setInterval(() => {
    throughputState.rxHistory.push(throughputState.rxCurrentBytes);
    throughputState.txHistory.push(throughputState.txCurrentBytes);
    if (throughputState.rxHistory.length > THROUGHPUT_HISTORY_LENGTH) {
      throughputState.rxHistory.shift();
    }
    if (throughputState.txHistory.length > THROUGHPUT_HISTORY_LENGTH) {
      throughputState.txHistory.shift();
    }
    sendThroughputUpdate();
    throughputState.rxCurrentBytes = 0;
    throughputState.txCurrentBytes = 0;
  }, THROUGHPUT_SAMPLE_MS);
}

function initializeThroughputState() {
  resetThroughputState(true);
  sendThroughputUpdate();
  startThroughputSampling();
}

function notifySerialDisconnected(message = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('serial-disconnected', message);
  }
}

function cleanupSerialConnection(message = null, port = currentSerialPort) {
  if (port && currentSerialPort && port !== currentSerialPort) return;
  if (serialCleanupComplete) return;
  serialCleanupComplete = true;
  serialSessionId++;
  stopThroughputSampling();
  resetThroughputState(false);
  sendThroughputUpdate();
  flushRawBinaryLogSync();
  const disconnectMsg = message || 'Serial port disconnected';
  currentSerialPort = null;
  if (!currentConfig.saveAllTabsLogToFiles) {
    saveLog();
  }
  notifySerialDisconnected(disconnectMsg);
}

function writeSerialPayload(request) {
  if (!currentSerialPort || !currentSerialPort.isOpen) {
    return Promise.resolve({ ok: false, code: 'SERIAL_NOT_OPEN', message: 'Serial port is not open' });
  }
  if (request?.sessionId !== undefined && request.sessionId !== serialSessionId) {
    return Promise.resolve({ ok: false, code: 'STALE_SERIAL_SESSION', message: 'Serial connection has changed' });
  }

  const built = buildSerialWriteBuffer(request, {
    defaultEncoding: serialSendEncoding,
    defaultNewlineMode: serialNewlineMode
  });
  if (!built.ok) return Promise.resolve(built);

  const port = currentSerialPort;
  return new Promise(resolve => {
    try {
      port.write(built.bytes, error => {
        if (error) {
          resolve({ ok: false, code: 'SERIAL_WRITE_FAILED', message: error.message });
          return;
        }
        throughputState.txCurrentBytes += built.bytes.length;
        resolve({ ok: true, bytesWritten: built.bytes.length });
      });
    } catch (error) {
      resolve({ ok: false, code: 'SERIAL_WRITE_FAILED', message: error.message });
    }
  });
}

ipcMain.handle('list-ports', async () => {
  return await SerialPort.list();
});

ipcMain.handle('connect-serial', async (event, options = {}) => {
  if (serialConnectInProgress) {
    throw new Error('A serial connection attempt is already in progress');
  }
  serialConnectInProgress = true;
  const { path, baudRate, dataBits, stopBits, parity, encoding, sendEncoding, newlineMode } = options;
  try {
    if (currentSerialPort && currentSerialPort.isOpen) {
      await new Promise(resolve => currentSerialPort.close(resolve));
      cleanupSerialConnection();
    } else if (currentSerialPort && !serialCleanupComplete) {
      throw new Error('A serial port is still opening');
    }
    if (rawBinaryBuffers.length > 0 && !flushRawBinaryLogSync()) {
      throw new Error(`Failed to flush pending raw serial log: ${rawBinaryFlushError?.message || 'unknown error'}`);
    }

    serialSendEncoding = oneOf(sendEncoding || encoding, SERIAL_ENCODINGS, 'utf8');
    serialNewlineMode = newlineMode || 'crlf';
    serialCleanupComplete = false;
    serialSessionId++;
    const connectionSessionId = serialSessionId;
    rawBinaryBuffers = [];
    rawBinaryByteCount = 0;
    rawBinaryLogPath = '';
    rawBinaryFlushError = null;

    return await new Promise((resolve, reject) => {
    const port = new SerialPort({
        path,
        baudRate: parseInt(baudRate),
        dataBits: parseInt(dataBits || 8),
        stopBits: parseFloat(stopBits || 1),
        parity: parity || 'none',
        autoOpen: false
    });
    currentSerialPort = port;

    port.open((err) => {
        if (err) {
            cleanupSerialConnection(null, port);
            reject(err.message);
            return;
        }
        writeLog(`\r\n[SERIAL CONNECTED] ${path} ${baudRate} ${dataBits}N${stopBits}\r\n`);
        if (currentConfig.saveAllTabsLogToFiles) {
          const title = 'Main_Terminal';
          tabLogBuffers.set('tab-main', { title, buffer: [], byteCount: 0, filePath: '' });
        }
        initializeThroughputState();
        resolve({ ok: true, sessionId: connectionSessionId });
    });

    port.on('data', (data) => {
      if (currentSerialPort !== port || serialCleanupComplete) return;
      throughputState.rxCurrentBytes += data.length;
      bufferRawSerialBytes(data);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-output-bytes', {
          bytes: new Uint8Array(data),
          receivedAt: Date.now(),
          sessionId: connectionSessionId
        });
      }
    });

    port.on('error', (err) => {
      if (currentSerialPort !== port || serialCleanupComplete) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-error', err.message);
      }
      writeLog(`\n[SERIAL ERROR] ${err.message}\n`);
    });

    port.on('close', () => {
      if (currentSerialPort !== port || serialCleanupComplete) return;
      writeLog('\r\n[SERIAL DISCONNECTED]\r\n');
      saveLog();
      cleanupSerialConnection('Serial port disconnected', port);
    });
    });
  } finally {
    serialConnectInProgress = false;
  }
});

ipcMain.handle('serial-write', (event, request) => writeSerialPayload(request));

ipcMain.on('disconnect-serial', () => {
  serialSessionId++;
  if (currentSerialPort && currentSerialPort.isOpen) {
    currentSerialPort.close();
  } else {
    cleanupSerialConnection();
  }
});

ipcMain.on('renderer-log', (event, msg) => {
    console.log('[RENDERER]', msg);
});

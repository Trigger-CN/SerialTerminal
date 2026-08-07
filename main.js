const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const { createTelemetryReporter, UUID_PATTERN } = require('./telemetry-reporter');
const pty = require('node-pty');
const { SerialPort } = require('serialport');
const iconv = require('iconv-lite');
const { autoUpdater } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const log = require('electron-log');
const fontList = require('font-list');
const { t, getLanguage } = require('./i18n');
const { buildSerialWriteBuffer } = require('./serial-codec');
const { normalizeIntegerSetting } = require('./config-values');
const { cleanupExpiredLogFiles } = require('./log-cleanup');
const {
  findShellProfile: findConfiguredShellProfile,
  normalizeShellProfiles,
  resolveDefaultShellProfileId
} = require('./shell-profiles');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;
const UPDATE_FEED = { provider: 'github', owner: 'Trigger-CN', repo: 'SerialTerminal' };
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_PROMPT_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MAIN_WINDOW_TITLE = 'SerialTerminal by Trigger-CN';
autoUpdater.setFeedURL(UPDATE_FEED);
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let mainWindow;
let prefsWindow;
let updateDownloadWindow;
let updateCheckTimer;
let updateDownloadToken = null;
let updatePromptState = {
  phase: 'idle',
  checkSource: null,
  latestInfo: null,
  latestProgress: null,
  promptPromise: null
};
const configPath = path.join(app.getPath('userData'), 'config.json');
const CONFIG_VERSION = 7;
const SERIAL_MODES = new Set(['text', 'hex']);
const SERIAL_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);
const LOG_RETENTION_DAYS = new Set([0, 7, 30, 60]);
const DEFAULT_SHORTCUTS = {
  sendMainInput: 'Ctrl+Enter',
  toggleSendHistory: 'Alt+H',
  historyPrevious: 'Alt+Up',
  historyNext: 'Alt+Down',
  focusSearch: 'Ctrl+F',
  clearActiveTerminal: 'Ctrl+L',
  refreshPorts: 'Ctrl+R',
  toggleSerialConnection: 'Ctrl+Shift+D'
};
const SIDEBAR_TAB_IDS = new Set(['tab-settings', 'tab-search', 'tab-send']);
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MENU_ICON_DIRECTORY = path.join(__dirname, 'assets', 'menu-icons');
const APP_ICON_PATH = path.join(__dirname, 'assets', process.platform === 'win32' ? 'app.ico' : 'icon-512x512.png');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.serialterminal.app');
}

const crashDumpsPath = path.join(app.getPath('userData'), 'crash-dumps');
app.setPath('crashDumps', crashDumpsPath);
crashReporter.start({
  companyName: 'Trigger-CN',
  productName: 'SerialTerminal',
  uploadToServer: false,
  compress: true,
  extra: {
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }
});

process.on('uncaughtException', (error) => {
  log.error('Uncaught main-process exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled main-process rejection:', reason);
});

log.info('Application starting', {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  logFile: log.transports.file.getFile().path,
  crashDumpsPath
});

function menuIcon(name) {
  const icon = path.join(MENU_ICON_DIRECTORY, `${name}.png`);
  return fs.existsSync(icon) ? { icon } : {};
}

function oneOf(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeMainInputHistoryLimit(value) {
  return normalizeIntegerSetting(value, 'mainInputHistoryLimit');
}

function normalizeMainInputHistory(history, limit) {
  if (!Array.isArray(history) || limit <= 0) return [];
  return history.filter(item => item && typeof item === 'object' && typeof item.content === 'string' && item.content)
    .map(item => ({
      mode: oneOf(item.mode, SERIAL_MODES, 'text'),
      content: item.content
    }))
    .slice(-limit);
}

function normalizeShortcuts(shortcuts) {
  const source = shortcuts && typeof shortcuts === 'object' && !Array.isArray(shortcuts) ? shortcuts : {};
  const normalized = { ...DEFAULT_SHORTCUTS };
  Object.keys(DEFAULT_SHORTCUTS).forEach(action => {
    if (typeof source[action] === 'string') normalized[action] = source[action].trim();
  });
  return normalized;
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
    sendEncoding: oneOf(oldSerial.sendEncoding, SERIAL_ENCODINGS, migratedEncoding),
    newlineMode: oneOf(oldSerial.newlineMode, new Set(['crlf', 'lf', 'cr']), 'crlf')
  };
  delete normalized.lastSerialOptions.encoding;
  delete normalized.lastSerialOptions.sendMode;
  delete normalized.lastSerialOptions.appendCrLf;

  const oldHex = source.hexDisplaySettings && typeof source.hexDisplaySettings === 'object'
    ? source.hexDisplaySettings
    : {};
  normalized.hexDisplaySettings = {
    bytesPerLine: oneOf(Number(oldHex.bytesPerLine), new Set([8, 16, 24, 32]), 16),
    showOffset: normalizeBoolean(oldHex.showOffset, true),
    showAscii: normalizeBoolean(oldHex.showAscii, true),
    uppercase: normalizeBoolean(oldHex.uppercase, true),
    idleFlushMs: normalizeIntegerSetting(oldHex.idleFlushMs, 'hexIdleFlushMs')
  };

  const oldMainInput = source.mainInputSettings && typeof source.mainInputSettings === 'object'
    ? source.mainInputSettings
    : {};
  normalized.mainInputSettings = {
    visible: normalizeBoolean(oldMainInput.visible, true),
    sendOnEnter: normalizeBoolean(oldMainInput.sendOnEnter, true),
    mode: oneOf(oldMainInput.mode, SERIAL_MODES, oneOf(oldSerial.sendMode, SERIAL_MODES, migratedMode)),
    appendCrLf: normalizeBoolean(oldMainInput.appendCrLf, normalizeBoolean(oldSerial.appendCrLf, false)),
    historyLimit: normalizeMainInputHistoryLimit(oldMainInput.historyLimit)
  };
  const oldHighlightColors = source.highlightColors && typeof source.highlightColors === 'object'
    ? source.highlightColors
    : {};
  normalized.highlightColors = {};
  for (const type of ['search', 'filter', 'selection']) {
    const colors = oldHighlightColors[type] && typeof oldHighlightColors[type] === 'object'
      ? oldHighlightColors[type]
      : {};
    normalized.highlightColors[type] = {
      background: HEX_COLOR_PATTERN.test(colors.background || '')
        ? colors.background
        : defaults.highlightColors[type].background,
      foreground: HEX_COLOR_PATTERN.test(colors.foreground || '')
        ? colors.foreground
        : defaults.highlightColors[type].foreground
    };
  }
  normalized.sidebarCollapsed = normalizeBoolean(source.sidebarCollapsed, false);
  normalized.activeSidebarTab = oneOf(source.activeSidebarTab, SIDEBAR_TAB_IDS, defaults.activeSidebarTab);
  normalized.lastWelcomeVersion = typeof source.lastWelcomeVersion === 'string'
    ? source.lastWelcomeVersion
    : defaults.lastWelcomeVersion;
  normalized.lastUpdatePromptVersion = typeof source.lastUpdatePromptVersion === 'string'
    ? source.lastUpdatePromptVersion
    : defaults.lastUpdatePromptVersion;
  normalized.lastUpdatePromptAt = Number.isFinite(source.lastUpdatePromptAt) && source.lastUpdatePromptAt >= 0
    ? source.lastUpdatePromptAt
    : defaults.lastUpdatePromptAt;
  normalized.mainInputHistory = normalizeMainInputHistory(source.mainInputHistory, normalized.mainInputSettings.historyLimit);
  normalized.shortcuts = normalizeShortcuts(source.shortcuts);
  normalized.fontSize = normalizeIntegerSetting(source.fontSize, 'fontSize');
  const legacyScrollbackLimit = Number(source.configVersion || 0) < 5 && source.scrollbackLimit === 100000
    ? 20000
    : source.scrollbackLimit;
  normalized.scrollbackLimit = normalizeIntegerSetting(legacyScrollbackLimit, 'scrollbackLimit');
  normalized.historyBufferSize = normalizeIntegerSetting(source.historyBufferSize, 'historyBufferSize');
  normalized.mouseWheelScrollLines = normalizeIntegerSetting(source.mouseWheelScrollLines, 'mouseWheelScrollLines');
  normalized.telemetryEnabled = normalizeBoolean(source.telemetryEnabled, true);
  normalized.telemetryInstallationId = UUID_PATTERN.test(source.telemetryInstallationId || '')
    ? source.telemetryInstallationId
    : '';
  normalized.telemetryLastReportedDate = /^\d{4}-\d{2}-\d{2}$/.test(source.telemetryLastReportedDate || '')
    ? source.telemetryLastReportedDate
    : '';
  normalized.telemetryLastReportedVersion = typeof source.telemetryLastReportedVersion === 'string'
    ? source.telemetryLastReportedVersion.trim()
    : '';

  normalized.shellProfiles = normalizeShellProfiles(source.shellProfiles, defaults.shellProfiles);
  normalized.defaultShellProfileId = resolveDefaultShellProfileId(source, normalized.shellProfiles);
  delete normalized.defaultShellProfile;
  normalized.shellTabs = Array.isArray(source.shellTabs)
    ? source.shellTabs.filter(tab => tab && typeof tab === 'object').map(tab => {
        const selector = typeof tab.profileId === 'string' && tab.profileId
          ? tab.profileId
          : (typeof tab.shellType === 'string' ? tab.shellType : '');
        const profile = findConfiguredShellProfile(normalized.shellProfiles, selector);
        const normalizedTab = { ...tab, profileId: profile?.id || '' };
        delete normalizedTab.shellType;
        return normalizedTab;
      })
    : [];

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
        const trigger = item.autoTrigger && typeof item.autoTrigger === 'object' ? item.autoTrigger : {};
        return {
          id,
          label: typeof item.label === 'string' ? item.label : '',
          mode: oneOf(item.mode, SERIAL_MODES, normalized.mainInputSettings.mode),
          appendCrLf: normalizeBoolean(item.appendCrLf,
            Number(source.configVersion || 0) < 7 && normalizeBoolean(oldSerial.appendCrLf, false)),
          content: typeof item.content === 'string'
            && Number(source.configVersion || 0) < 3
            && normalizeBoolean(oldSerial.appendCrLf, false)
            && /\r\n$/.test(item.content)
            ? item.content.slice(0, -2)
            : (typeof item.content === 'string' ? item.content : ''),
          sidebarShortcut: {
            enabled: normalizeBoolean(item.sidebarShortcut?.enabled, false),
            text: typeof item.sidebarShortcut?.text === 'string' ? item.sidebarShortcut.text : '',
            backgroundColor: typeof item.sidebarShortcut?.backgroundColor === 'string'
              && /^#[0-9a-f]{6}$/i.test(item.sidebarShortcut.backgroundColor)
              ? item.sidebarShortcut.backgroundColor
              : ''
          },
          autoTrigger: {
            enabled: normalizeBoolean(trigger.enabled, false),
            text: typeof trigger.text === 'string' ? trigger.text : '',
            useRegex: normalizeBoolean(trigger.useRegex, false),
            caseSensitive: normalizeBoolean(trigger.caseSensitive, false),
            wholeWord: normalizeBoolean(trigger.wholeWord, false)
          }
        };
      })
    : [];
  const quickSendIds = new Set(normalized.quickSendList.map(item => item.id));
  normalized.sidebarQuickSendOrder = Array.isArray(source.sidebarQuickSendOrder)
    ? [...new Set(source.sidebarQuickSendOrder.filter(id => typeof id === 'string' && quickSendIds.has(id)))]
    : [];

  normalized.filterTabs = Array.isArray(source.filterTabs)
    ? source.filterTabs.filter(tab => tab && typeof tab === 'object').map(tab => ({
        ...tab,
        dataMode: oneOf(tab.dataMode, SERIAL_MODES, migratedMode)
      }))
    : [];
  normalized.saveRawSerialToFile = normalizeBoolean(source.saveRawSerialToFile, false);
  normalized.manualExportDirectory = typeof source.manualExportDirectory === 'string' && source.manualExportDirectory.trim()
    ? source.manualExportDirectory
    : defaults.manualExportDirectory;
  normalized.logIncludeTimestamp = normalizeBoolean(source.logIncludeTimestamp, false);
  normalized.logIncludeLineNumbers = normalizeBoolean(source.logIncludeLineNumbers, false);
  normalized.rawBufferAutoFlushMB = normalizeIntegerSetting(source.rawBufferAutoFlushMB, 'rawBufferAutoFlushMB');
  normalized.rawLogFileNameFormat = typeof source.rawLogFileNameFormat === 'string' && source.rawLogFileNameFormat.trim()
    ? source.rawLogFileNameFormat
    : 'raw_%Y-%m-%d_%H-%M-%S.bin';
  normalized.logRetentionDays = oneOf(Number(source.logRetentionDays), LOG_RETENTION_DAYS, 0);
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
    timestampColor: '#808080',
    lineNoColor: '#67986f',
    highlightColors: {
      search: { background: '#f5d90a', foreground: '#000000' },
      filter: { background: '#535353', foreground: '#ffffff' },
      selection: { background: '#073ca8', foreground: '#ffffff' }
    },
    logEnabled: false,
    saveAllTabsLogToFiles: false,
    logIncludeTimestamp: false,
    logIncludeLineNumbers: false,
    rawBufferAutoFlushMB: 10,
    saveRawSerialToFile: false,
    rawLogFileNameFormat: 'raw_%Y-%m-%d_%H-%M-%S.bin',
    stripAnsiInLog: true,
    logPath: path.join(app.getPath('documents'), 'SerialTerminalLogs'),
    logRetentionDays: 0,
    manualExportDirectory: app.getPath('documents'),
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
    scrollbackLimit: 20000,
    historyBufferSize: 5000000,
    mouseWheelScrollLines: 3,
    telemetryEnabled: true,
    telemetryInstallationId: '',
    telemetryLastReportedDate: '',
    telemetryLastReportedVersion: '',
    filterHistory: [],
    windowBounds: {
      width: 1000,
      height: 700
    },
    filterTabs: [],
    shellTabs: [],
    shellProfiles: [
      { id: 'shell-cmd', name: 'CMD', executable: 'cmd.exe', args: [], shellType: 'cmd' },
      { id: 'shell-powershell', name: 'PowerShell', executable: 'powershell.exe', args: ['-NoLogo'], shellType: 'powershell' }
    ],
    defaultShellProfileId: '',
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
      sendOnEnter: true,
      mode: 'text',
      appendCrLf: false,
      historyLimit: 20
    },
    sidebarCollapsed: false,
    activeSidebarTab: 'tab-settings',
    lastWelcomeVersion: '',
    lastUpdatePromptVersion: '',
    lastUpdatePromptAt: 0,
    mainInputHistory: [],
    shortcuts: DEFAULT_SHORTCUTS,
    autoSendSettings: {
      enabled: false,
      interval: 1000,
      content: ''
    },
    quickSendList: [],
    sidebarQuickSendOrder: [],
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
        sendEncoding: 'utf8',
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
      log.error('Failed to load config:', e);
    }
  }
  return normalizeConfig(defaults, defaults);
}

let currentConfig = loadConfig();
let telemetryReporter;
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
let logCleanupTimer = null;
let logCleanupInFlight = false;
let logCleanupPending = false;
const logErrorNoticeKeys = new Set();
const LOG_AUTO_FLUSH_INTERVAL_MS = 5000;
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  const fileName = buildLogFileName({});
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  mainLogFilePath = path.join(currentConfig.logPath, fileName);
  let suffix = 2;
  while (fs.existsSync(mainLogFilePath)) {
    mainLogFilePath = path.join(currentConfig.logPath, `${baseName}_${suffix}${extension}`);
    suffix++;
  }
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

function closeMainLogSession({ notify = true } = {}) {
  saveLog({ notify });
  if (logBuffer.length === 0) {
    mainLogFilePath = '';
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

function getActiveLogFilePaths() {
  const activePaths = [mainLogFilePath, rawBinaryLogPath];
  tabLogBuffers.forEach(entry => activePaths.push(entry.filePath));
  return activePaths.filter(Boolean);
}

async function runLogCleanup() {
  if (currentConfig.logRetentionDays <= 0) return;
  if (logCleanupInFlight) {
    logCleanupPending = true;
    return;
  }

  logCleanupInFlight = true;
  try {
    const result = await cleanupExpiredLogFiles(currentConfig.logPath, currentConfig.logRetentionDays, {
      activePaths: getActiveLogFilePaths()
    });
    if (result.deleted.length > 0) log.info(`Deleted ${result.deleted.length} expired log file(s)`);
    result.failed.forEach(({ filePath, error }) => {
      log.warn(`Failed to delete expired log file ${filePath}:`, error);
    });
  } catch (error) {
    log.warn('Failed to clean up expired log files:', error);
  } finally {
    logCleanupInFlight = false;
    if (logCleanupPending) {
      logCleanupPending = false;
      runLogCleanup();
    }
  }
}

function startLogCleanupTimer() {
  if (logCleanupTimer) clearInterval(logCleanupTimer);
  logCleanupTimer = null;
  if (currentConfig.logRetentionDays <= 0) return;
  runLogCleanup();
  logCleanupTimer = setInterval(runLogCleanup, LOG_CLEANUP_INTERVAL_MS);
}

function saveConfig(config) {
  const merged = { ...currentConfig, ...config };
  for (const key of ['lastSerialOptions', 'hexDisplaySettings', 'mainInputSettings', 'autoSendSettings', 'highlightColors']) {
    if (config && config[key] && typeof config[key] === 'object') {
      merged[key] = { ...currentConfig[key], ...config[key] };
    }
  }
  if (config?.lastSerialOptions && typeof config.lastSerialOptions.encoding === 'string') {
    const legacyEncoding = config.lastSerialOptions.encoding;
    merged.lastSerialOptions.receiveDisplayMode = legacyEncoding === 'hex' ? 'hex' : 'text';
    merged.mainInputSettings.mode = legacyEncoding === 'hex' ? 'hex' : 'text';
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
  const logCleanupSettingsChanged = normalized.logPath !== currentConfig.logPath
    || normalized.logRetentionDays !== currentConfig.logRetentionDays;
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
    closeMainLogSession();
  }
  currentConfig = normalized;
  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
  telemetryReporter?.configure(currentConfig);
  if (logCleanupSettingsChanged) startLogCleanupTimer();
}

function persistTelemetryState(state) {
  currentConfig = normalizeConfig({ ...currentConfig, ...state }, currentConfig);
  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
}

telemetryReporter = createTelemetryReporter({
  getAppVersion: () => app.getVersion(),
  isReleaseBuild: () => {
    if (!app.isPackaged) return false;
    try {
      const releaseVersion = fs.readFileSync(path.join(__dirname, 'release-build.txt'), 'utf8').trim();
      return releaseVersion === app.getVersion();
    } catch {
      return false;
    }
  },
  onStateChange: persistTelemetryState,
  logger: log
});

function findShellProfile(shellTypeOrName) {
  const profiles = Array.isArray(currentConfig.shellProfiles) ? currentConfig.shellProfiles : [];
  return findConfiguredShellProfile(profiles, shellTypeOrName);
}

function getDefaultShellPath(shellType = '') {
  const profile = shellType ? findShellProfile(shellType) : null;
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
  const profile = shellTypeOrName ? findShellProfile(shellTypeOrName) : null;
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

  const profileSelector = typeof options.profileId === 'string' && options.profileId
    ? options.profileId
    : (typeof options.shellType === 'string' ? options.shellType : '');
  const shellPath = getDefaultShellPath(profileSelector);
  const session = {
    tabId,
    shellPath,
    profileSelector,
    cols: Math.max(1, Number(options.cols) || 80),
    rows: Math.max(1, Number(options.rows) || 24),
    cwd: process.cwd(),
    ptyProcess: null
  };

  const ptyProcess = pty.spawn(shellPath, getShellLaunchArgs(shellPath, profileSelector), {
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

function formatAppVersion(version) {
  const normalizedVersion = String(version || '').replace(/^v/i, '');
  return normalizedVersion ? `v${normalizedVersion}` : '';
}

function getMainWindowTitle() {
  const currentVersion = formatAppVersion(app.getVersion());
  const latestVersion = formatAppVersion(updatePromptState.latestInfo?.version);
  const updateSuffix = latestVersion ? ` 有新版本：${latestVersion}` : '';
  return `${MAIN_WINDOW_TITLE} ${currentVersion}${updateSuffix}`;
}

function updateMainWindowTitle() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(getMainWindowTitle());
  }
}

function createWindow() {
  const windowBounds = currentConfig.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: windowBounds.width || 1000,
    height: windowBounds.height || 700,
    title: getMainWindowTitle(),
    icon: APP_ICON_PATH,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('page-title-updated', event => {
    event.preventDefault();
    updateMainWindowTitle();
  });

  // Open DevTools automatically for debugging
  // mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      const details = `(${sourceId}:${line})`;
      if (level >= 2) log.error(`[RENDERER] ${message} ${details}`);
      else log.info(`[RENDERER] ${message} ${details}`);
    });

    mainWindow.webContents.on('render-process-gone', (event, details) => {
      log.error('Renderer process exited:', details);
    });

    mainWindow.webContents.on('unresponsive', () => {
      log.warn('Renderer became unresponsive');
    });

    mainWindow.webContents.on('responsive', () => {
      log.info('Renderer became responsive');
    });

    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      log.error('Renderer failed to load:', {
        errorCode,
        errorDescription,
        validatedURL,
        isMainFrame
      });
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

function createPrefsWindow(focusTab = null) {
  if (prefsWindow) {
    prefsWindow.focus();
    if (focusTab) {
      const sendFocusTab = () => prefsWindow?.webContents.send('focus-preferences-tab', focusTab);
      if (prefsWindow.webContents.isLoading()) {
        prefsWindow.webContents.once('did-finish-load', sendFocusTab);
      } else {
        sendFocusTab();
      }
    }
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 750,
    height: 680,
    parent: mainWindow,
    modal: false,
    title: 'Preferences',
    icon: APP_ICON_PATH,
    backgroundColor: '#252526',
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  prefsWindow.loadFile('preferences.html');
  prefsWindow.webContents.once('did-finish-load', () => {
    if (focusTab) {
      prefsWindow.webContents.send('focus-preferences-tab', focusTab);
    }
  });
  prefsWindow.on('closed', () => {
    prefsWindow = null;
  });
}

function sendUpdateDownloadStatus(status, data) {
  if (updateDownloadWindow && !updateDownloadWindow.isDestroyed()) {
    if (status === 'error' || status === 'cancelled') updateDownloadWindow.setClosable(true);
    updateDownloadWindow.webContents.send('update-download-status', { status, data });
  }
}

function closeUpdateDownloadWindow() {
  if (!updateDownloadWindow || updateDownloadWindow.isDestroyed()) return;
  updateDownloadWindow.setClosable(true);
  updateDownloadWindow.close();
}

function getManualUpdateDownloadUrl(info) {
  const exeFile = Array.isArray(info?.files)
    ? info.files.find(file => /\.exe$/i.test(file?.name || file?.url || ''))
    : null;
  if (exeFile?.url) {
    try {
      return new URL(String(exeFile.url)).toString();
    } catch (error) {
      log.warn('Failed to resolve GitHub update URL:', error);
    }
  }
  return getReleaseUrl();
}

function createUpdateDownloadWindow(info) {
  if (updateDownloadWindow && !updateDownloadWindow.isDestroyed()) {
    updateDownloadWindow.focus();
    return;
  }

  updateDownloadWindow = new BrowserWindow({
    width: 460,
    height: 260,
    minWidth: 460,
    minHeight: 260,
    maxWidth: 460,
    maxHeight: 260,
    parent: mainWindow,
    title: tr('updateDialog.softwareUpdateTitle'),
    icon: APP_ICON_PATH,
    backgroundColor: '#252526',
    autoHideMenuBar: true,
    minimizable: true,
    closable: false,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  updateDownloadWindow.loadFile('update-progress.html');
  updateDownloadWindow.webContents.once('did-finish-load', () => {
    updateDownloadWindow?.webContents.send('update-download-init', {
      version: info?.version || '',
      title: tr('updateDialog.softwareUpdateTitle'),
      downloading: tr('prefs.downloading'),
      downloaded: tr('updateDialog.versionDownloaded'),
      installAndRestart: tr('updateDialog.installAndRestart'),
      restartToInstall: tr('updateDialog.restartToInstall'),
      manualDownloadHint: tr('updateDialog.manualDownloadHint'),
      manualDownload: tr('updateDialog.manualDownload'),
      manualDownloadUrl: getManualUpdateDownloadUrl(info),
      cancel: tr('prefs.cancelDownload'),
      cancelled: tr('prefs.downloadCancelled')
    });
    if (updatePromptState.phase === 'downloaded') {
      sendUpdateDownloadStatus('downloaded', updatePromptState.latestInfo);
    } else if (updatePromptState.latestProgress) {
      sendUpdateDownloadStatus('progress', updatePromptState.latestProgress);
    }
  });
  updateDownloadWindow.on('closed', () => {
    updateDownloadWindow = null;
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
    startUpdateDownload(info);
    return;
  }

  if (result.response === 2 && version) {
    saveConfig({ skippedUpdateVersion: version });
  }
}

function startUpdateDownload(info) {
  if (updatePromptState.phase === 'downloading' || updatePromptState.phase === 'downloaded') {
    createUpdateDownloadWindow(updatePromptState.latestInfo || info);
    return;
  }

  updatePromptState.latestInfo = info;
  updatePromptState.latestProgress = null;
  createUpdateDownloadWindow(info);
  beginUpdateDownload();
}

function beginUpdateDownload() {
  if (updateDownloadToken || updatePromptState.phase === 'downloaded') return;

  updatePromptState.phase = 'downloading';
  const token = new CancellationToken();
  updateDownloadToken = token;

  autoUpdater.downloadUpdate(token).catch(error => {
    if (!token.cancelled) log.error('Failed to download update:', error);
  }).finally(() => {
    if (updateDownloadToken !== token) return;

    updateDownloadToken = null;
    if (token.cancelled) {
      updatePromptState.phase = 'available';
      updatePromptState.latestProgress = null;
      sendUpdateDownloadStatus('cancelled');
      closeUpdateDownloadWindow();
    }
  });
}

function cancelUpdateDownload() {
  if (updatePromptState.phase !== 'downloading' || !updateDownloadToken) return false;
  updateDownloadToken.cancel();
  return true;
}

function shouldShowAutomaticUpdatePrompt(info, now = Date.now()) {
  const version = typeof info?.version === 'string' ? info.version : '';
  if (!version || currentConfig.skippedUpdateVersion === version) return false;
  if (currentConfig.lastUpdatePromptVersion !== version) return true;
  return now - currentConfig.lastUpdatePromptAt >= UPDATE_PROMPT_INTERVAL_MS;
}

function recordUpdatePrompt(info, now = Date.now()) {
  const version = typeof info?.version === 'string' ? info.version : '';
  if (!version) return;
  saveConfig({ lastUpdatePromptVersion: version, lastUpdatePromptAt: now });
}

function offerAvailableUpdate(info, isStartupPrompt) {
  if (updatePromptState.promptPromise) return updatePromptState.promptPromise;
  recordUpdatePrompt(info);
  updatePromptState.phase = 'prompting';
  updatePromptState.promptPromise = promptForAvailableUpdate(info, isStartupPrompt)
    .catch(error => {
      log.error('Failed to show update prompt:', error);
    })
    .finally(() => {
      updatePromptState.promptPromise = null;
      updatePromptState.checkSource = null;
      if (updatePromptState.phase === 'prompting') updatePromptState.phase = 'available';
    });
  return updatePromptState.promptPromise;
}

function sendCurrentUpdateStatusToPrefs() {
  if (updatePromptState.phase === 'downloaded') {
    sendUpdateStatusToPrefs('downloaded', updatePromptState.latestInfo);
  } else if (updatePromptState.phase === 'downloading' && updatePromptState.latestProgress) {
    sendUpdateStatusToPrefs('download-progress', updatePromptState.latestProgress);
  } else if (updatePromptState.latestInfo) {
    sendUpdateStatusToPrefs('available', updatePromptState.latestInfo);
  }
}

function checkForAppUpdates({ manual = false, scheduled = false } = {}) {
  if (!app.isPackaged || process.env.NODE_ENV === 'development') {
    if (manual) {
      setTimeout(() => {
        sendUpdateStatusToPrefs('not-available', { version: 'Development' });
      }, 200);
    }
    return;
  }

  if (updatePromptState.phase === 'downloading' || updatePromptState.phase === 'downloaded') {
    if (scheduled) return;
    sendCurrentUpdateStatusToPrefs();
    createUpdateDownloadWindow(updatePromptState.latestInfo);
    return;
  }
  if (updatePromptState.phase === 'checking') {
    if (manual) updatePromptState.checkSource = 'manual';
    return;
  }
  if (updatePromptState.phase === 'prompting') {
    sendCurrentUpdateStatusToPrefs();
    return;
  }
  if (updatePromptState.phase === 'available' && updatePromptState.latestInfo) {
    if (scheduled) {
      updatePromptState.phase = 'checking';
      updatePromptState.checkSource = 'scheduled';
      autoUpdater.checkForUpdates().catch(error => {
        log.error('Failed to check for updates:', error);
      });
      return;
    }
    sendCurrentUpdateStatusToPrefs();
    offerAvailableUpdate(updatePromptState.latestInfo, false);
    return;
  }

  updatePromptState.phase = 'checking';
  updatePromptState.checkSource = manual ? 'manual' : scheduled ? 'scheduled' : 'startup';
  autoUpdater.checkForUpdates().catch(error => {
    log.error('Failed to check for updates:', error);
  });
}

app.whenReady().then(() => {
  createWindow();
  startLogAutoFlushTimer();
  startLogCleanupTimer();
  telemetryReporter.configure(currentConfig);
  checkForAppUpdates();
  updateCheckTimer = setInterval(() => {
    checkForAppUpdates({ scheduled: true });
  }, UPDATE_CHECK_INTERVAL_MS);

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
  telemetryReporter.stop();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
  if (logFlushTimer) clearInterval(logFlushTimer);
  if (logCleanupTimer) clearInterval(logCleanupTimer);
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

ipcMain.on('open-prefs', (event, options = {}) => {
  createPrefsWindow(typeof options.focusTab === 'string' ? options.focusTab : null);
});

ipcMain.on('update-display-settings', (event, settings) => {
    displaySettings = { ...displaySettings, ...settings };
    
    // Save to config
    currentConfig = { ...currentConfig, ...settings };
    saveConfig(currentConfig);
});

ipcMain.on('reset-config', (event) => {
  const telemetryState = {
    telemetryInstallationId: currentConfig.telemetryInstallationId,
    telemetryLastReportedDate: currentConfig.telemetryLastReportedDate,
    telemetryLastReportedVersion: currentConfig.telemetryLastReportedVersion
  };
  // Delete config file
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
  
  // Reload defaults
  currentConfig = loadConfig();
  currentConfig = normalizeConfig({ ...currentConfig, ...telemetryState }, currentConfig);
  
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

ipcMain.handle('save-current-tab-log', async (event, payload = {}) => {
  const now = new Date();
  const timestamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-') + '_' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('-');
  const title = sanitizeFileNamePart(payload.title) || 'Terminal';
  const exportDirectory = currentConfig.manualExportDirectory || app.getPath('documents');
  const defaultPath = path.join(exportDirectory, `${title}_${timestamp}.txt`);
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const result = await dialog.showSaveDialog(owner, {
    title: tr('main.saveCurrentTab'),
    defaultPath,
    filters: [
      { name: 'Text Files', extensions: ['txt', 'log'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, typeof payload.content === 'string' ? payload.content : '', 'utf8');
  saveConfig({ manualExportDirectory: path.dirname(result.filePath) });
  return { canceled: false, filePath: result.filePath };
});

ipcMain.on('save-config', (event, config) => {
  try {
    saveConfig(config);
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
    closeMainLogSession();
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

  const template = [
    {
      label: labels.newFilterTab || 'New Filter Tab',
      ...menuIcon('filter_alt'),
      click: () => sendAction('new-filter-tab')
    },
    {
      label: labels.newShellTab || 'New Shell Tab',
      ...menuIcon('terminal'),
      click: () => sendAction('new-shell-tab')
    },
    {
      label: labels.splitHorizontal || 'Move Tab to Right Split',
      ...menuIcon('vertical_split'),
      enabled: Boolean(payload.tabId),
      click: () => sendAction('split-horizontal')
    },
    {
      label: labels.splitVertical || 'Move Tab to Bottom Split',
      ...menuIcon('horizontal_split'),
      enabled: Boolean(payload.tabId),
      click: () => sendAction('split-vertical')
    },
    {
      label: labels.closeSplit || 'Close Split',
      ...menuIcon('close_fullscreen'),
      enabled: Boolean(payload.splitEnabled),
      click: () => sendAction('close-split')
    }
  ];

  if (terminalType === 'main') {
    template.push(
      { type: 'separator' },
      {
        label: labels.pasteAndSend || 'Paste and Send',
        ...menuIcon('content_paste_go'),
        enabled: isConnected,
        click: () => sendAction('paste-send')
      },
      {
        label: labels.sendSelection || 'Send Selection',
        ...menuIcon('send'),
        enabled: hasSelection && isConnected,
        click: () => sendAction('send-selection')
      },
      {
        label: labels.createFilterFromSelection || 'Create Filter Tab from Selection',
        ...menuIcon('filter_alt'),
        enabled: hasSelection,
        click: () => sendAction('create-filter-from-selection')
      },
      { type: 'separator' },
      {
        label: labels.copy || 'Copy',
        ...menuIcon('content_copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: labels.copyAll || 'Copy All',
        ...menuIcon('copy_all'),
        click: () => sendAction('copy-all')
      },
      {
        label: labels.findSelection || 'Find Selection',
        ...menuIcon('search'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: labels.clearTerminal || 'Clear Terminal',
        ...menuIcon('delete_sweep'),
        click: () => sendAction('clear-terminal')
      }
    );
    if (payload.receiveDisplayMode === 'hex') {
      template.push({
        label: labels.clearAndResetHex || 'Clear and Reset Hex Offset',
        ...menuIcon('restart_alt'),
        click: () => sendAction('clear-and-reset-hex')
      });
    }
  } else if (terminalType === 'filter') {
    template.push(
      { type: 'separator' },
      {
        label: labels.moveToOtherPane || 'Move to Other Pane',
        ...menuIcon('swap_horiz'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('move-to-other-pane')
      },
      {
        label: labels.closeFilterTab || 'Close Filter Tab',
        ...menuIcon('close'),
        click: () => sendAction('close-filter-tab')
      },
      { type: 'separator' },
      {
        label: labels.useSelectionAsFilter || 'Use Selection as Filter',
        ...menuIcon('filter_alt'),
        enabled: hasSelection,
        click: () => sendAction('use-selection-as-filter')
      },
      {
        label: labels.appendSelectionToFilter || 'Append Selection to Filter',
        ...menuIcon('playlist_add'),
        enabled: hasSelection,
        click: () => sendAction('append-selection-to-filter')
      },
      {
        label: labels.locateInMainTerminal || 'Locate in Main Terminal',
        ...menuIcon('my_location'),
        enabled: canLocateInMain,
        click: () => sendAction('locate-in-main-terminal')
      },
      {
        label: labels.toggleMatchCase || 'Toggle Match Case',
        ...menuIcon('match_case'),
        type: 'checkbox',
        checked: Boolean(payload.caseSensitive),
        click: () => sendAction('toggle-case-sensitive')
      },
      {
        label: labels.toggleWholeWord || 'Toggle Whole Word',
        ...menuIcon('match_word'),
        type: 'checkbox',
        checked: Boolean(payload.wholeWord),
        click: () => sendAction('toggle-whole-word')
      },
      {
        label: labels.toggleRegex || 'Toggle Regex',
        ...menuIcon('regular_expression'),
        type: 'checkbox',
        checked: Boolean(payload.useRegex),
        click: () => sendAction('toggle-regex')
      },
      {
        label: labels.copy || 'Copy',
        ...menuIcon('content_copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: labels.copyAll || 'Copy All',
        ...menuIcon('copy_all'),
        click: () => sendAction('copy-all')
      },
      {
        label: labels.findSelection || 'Find Selection',
        ...menuIcon('search'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: labels.clearTerminal || 'Clear Terminal',
        ...menuIcon('delete_sweep'),
        click: () => sendAction('clear-terminal')
      }
    );
  } else {
    template.push(
      { type: 'separator' },
      {
        label: labels.moveToOtherPane || 'Move to Other Pane',
        ...menuIcon('swap_horiz'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('move-to-other-pane')
      },
      {
        label: labels.restartShell || 'Restart Shell',
        ...menuIcon('restart_alt'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('restart-shell')
      },
      {
        label: labels.closeShellTab || 'Close Shell Tab',
        ...menuIcon('close'),
        enabled: Boolean(payload.tabId),
        click: () => sendAction('close-shell-tab')
      },
      { type: 'separator' },
      {
        label: labels.newShellTab || 'New Shell Tab',
        ...menuIcon('terminal'),
        click: () => sendAction('new-shell-tab')
      },
      { type: 'separator' },
      {
        label: labels.pasteAndSend || 'Paste and Send',
        ...menuIcon('content_paste_go'),
        click: () => sendAction('paste-send')
      },
      {
        label: labels.sendSelection || 'Send Selection',
        ...menuIcon('send'),
        enabled: hasSelection,
        click: () => sendAction('send-selection')
      },
      {
        label: labels.copy || 'Copy',
        ...menuIcon('content_copy'),
        enabled: hasSelection,
        click: () => {
          if (payload.selectedText) {
            clipboard.writeText(payload.selectedText);
          }
        }
      },
      {
        label: labels.copyAll || 'Copy All',
        ...menuIcon('copy_all'),
        click: () => sendAction('copy-all')
      },
      {
        label: labels.findSelection || 'Find Selection',
        ...menuIcon('search'),
        enabled: hasSelection,
        click: () => sendAction('find-selection')
      },
      {
        label: labels.clearTerminal || 'Clear Terminal',
        ...menuIcon('delete_sweep'),
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
  updateMainWindowTitle();
  sendUpdateStatusToPrefs('available', info);

  if (updatePromptState.checkSource === 'scheduled') {
    if (shouldShowAutomaticUpdatePrompt(info)) {
      offerAvailableUpdate(info, false);
    } else {
      updatePromptState.phase = 'available';
      updatePromptState.checkSource = null;
    }
    return;
  }

  const isStartupPrompt = updatePromptState.checkSource === 'startup';
  if (isStartupPrompt && !shouldShowAutomaticUpdatePrompt(info)) {
    updatePromptState.phase = 'available';
    updatePromptState.checkSource = null;
    return;
  }

  offerAvailableUpdate(info, isStartupPrompt);
});

autoUpdater.on('update-not-available', (info) => {
  sendUpdateStatusToPrefs('not-available', info);
  updatePromptState.latestInfo = null;
  updatePromptState.phase = 'idle';
  updatePromptState.checkSource = null;
  updateMainWindowTitle();
});

autoUpdater.on('error', (err) => {
  sendUpdateStatusToPrefs('error', err.message);
  sendUpdateDownloadStatus('error', err.message);
  updatePromptState.phase = updatePromptState.latestInfo ? 'available' : 'idle';
  updatePromptState.checkSource = null;
});

autoUpdater.on('download-progress', (progressObj) => {
  updatePromptState.latestProgress = progressObj;
  sendUpdateStatusToPrefs('download-progress', progressObj);
  sendUpdateDownloadStatus('progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  updateDownloadToken = null;
  updatePromptState.phase = 'downloaded';
  updatePromptState.latestInfo = info;
  updatePromptState.latestProgress = null;
  sendUpdateStatusToPrefs('downloaded', info);
  sendUpdateDownloadStatus('downloaded', info);
  saveConfig({ skippedUpdateVersion: '' });
});

ipcMain.on('cancel-update-download', event => {
  if (BrowserWindow.fromWebContents(event.sender) !== updateDownloadWindow) return;
  cancelUpdateDownload();
});

ipcMain.on('check-for-updates', () => {
  checkForAppUpdates({ manual: true });
});

ipcMain.handle('open-release-page', () => {
  return shell.openExternal(getReleaseUrl());
});

ipcMain.handle('open-update-download-url', (event, url) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  return shell.openExternal(url);
});

ipcMain.on('quit-and-install', event => {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  const isTrustedSource = sourceWindow === updateDownloadWindow || sourceWindow === prefsWindow;
  if (updatePromptState.phase !== 'downloaded' || !isTrustedSource) return;
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
  const defaultId = currentConfig.defaultShellProfileId || '';
  return {
    profiles: profiles.map(p => ({
      id: p.id || '',
      name: p.name || '',
      executable: p.executable || '',
      args: Array.isArray(p.args) ? p.args : [],
      shellType: p.shellType || 'auto'
    })),
    defaultId
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
let serialOutputQueue = [];
let serialOutputFlushScheduled = false;
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

function flushSerialOutputQueue() {
  serialOutputFlushScheduled = false;
  if (!serialOutputQueue.length || !mainWindow || mainWindow.isDestroyed()) {
    serialOutputQueue = [];
    return;
  }
  const queued = serialOutputQueue;
  serialOutputQueue = [];
  const sessionId = queued[0].sessionId;
  const byteCount = queued.reduce((total, entry) => total + entry.data.length, 0);
  const bytes = Buffer.concat(queued.map(entry => entry.data), byteCount);
  mainWindow.webContents.send('serial-output-bytes', {
    bytes: new Uint8Array(bytes),
    sessionId
  });
}

function queueSerialOutput(data, sessionId) {
  if (serialOutputQueue.length && serialOutputQueue[0].sessionId !== sessionId) {
    flushSerialOutputQueue();
  }
  serialOutputQueue.push({ data: Buffer.from(data), sessionId });
  if (!serialOutputFlushScheduled) {
    serialOutputFlushScheduled = true;
    setImmediate(flushSerialOutputQueue);
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
          queueSerialOutput(data, connectionSessionId);
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
        log.info('[RENDERER]', msg);
    });

    ipcMain.on('renderer-diagnostic-log', (event, payload = {}) => {
      const message = typeof payload.message === 'string' ? payload.message : 'Unknown renderer diagnostic';
      log.error('[RENDERER DIAGNOSTIC]', {
        message,
        stack: typeof payload.stack === 'string' ? payload.stack : '',
        source: typeof payload.source === 'string' ? payload.source : ''
      });
    });

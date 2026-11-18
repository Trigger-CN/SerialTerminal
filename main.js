const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, net, crashReporter } = require('electron');
const path = require('path');
const fs = require('fs');
const { createTelemetryReporter, UUID_PATTERN } = require('./telemetry-reporter');
const pty = require('node-pty');
const { SerialPort } = require('serialport');
const iconv = require('iconv-lite');
const { autoUpdater, Provider } = require('electron-updater');
const { CancellationToken } = require('builder-util-runtime');
const log = require('electron-log');
const yaml = require('js-yaml');
const fontList = require('font-list');
const { t, getLanguage } = require('./i18n');
const { buildSerialWriteBuffer } = require('./serial-codec');
const { normalizeFontWeight, normalizeIntegerSetting } = require('./config-values');
const { normalizeBaudRate, normalizeCustomBaudRates, isStandardBaudRate } = require('./baud-rates');
const { normalizeSearchHistory } = require('./search-history');
const {
  migrateSerialGroupsConfig,
  needsSerialGroupsMigration
} = require('./serial-groups-config');
const { WORKSPACE_CONFIG_VERSION, migrateWorkspaceLayoutConfig } = require('./workspace-layout-state');
const { cleanupExpiredLogFiles } = require('./log-cleanup');
const { SerialPortClaimTable, normalizePortKey } = require('./serial-port-claims');
const { formatLocalDate, getLogDirectory } = require('./log-directory');
const { ChartParserWorkerClient, discoverChartFieldsInWorker } = require('./chart-parser-worker-client');
const {
  DYNAMIC_UPDATE_METADATA_URL,
  buildUpdateMetadataCandidates,
  compareUpdateVersions,
  getUpdateChannel,
  isSameUpdate,
  isStableUpdateVersion,
  isUpdateSourceConsistent,
  MAX_UPDATE_METADATA_BYTES,
  readLimitedResponse,
  resolveGiteeUpdateMetadataUrl,
  runUpdateSourceFallback,
  selectUpdateReleaseCandidates
} = require('./update-source-resolver');
const {
  findShellProfile: findConfiguredShellProfile,
  normalizeShellProfiles,
  resolveDefaultShellProfileId
} = require('./shell-profiles');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;
const GITEE_OWNER = 'trigger-cn';
const GITEE_REPO = 'SerialTerminal';
const GITEE_API_BASE = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}`;
const GITEE_RELEASE_PAGE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases`;
const GITHUB_RELEASE_PAGE = `https://github.com/Trigger-CN/${GITEE_REPO}/releases`;
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
const UPDATE_PROMPT_INTERVAL_MS = 8 * 60 * 60 * 1000;
const UPDATE_CHANNEL = 'stable';
const UPDATE_METADATA_TIMEOUT_MS = 5000;
const MAIN_WINDOW_TITLE = 'SerialTerminal by Trigger-CN';
const UPDATE_PACKAGE_TYPE = process.platform === 'linux' && autoUpdater.constructor?.name === 'DebUpdater'
  ? 'deb'
  : process.platform === 'linux' ? 'AppImage' : 'exe';
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

class UpdateMetadataProvider extends Provider {
  constructor(configuration, updater, runtimeOptions) {
    super(runtimeOptions);
    this.metadataUrl = new URL(configuration.metadataUrl);
    this.selectionHeaders = configuration.selectionHeaders || undefined;
  }

  async getLatestVersion() {
    const rawData = await fetchUpdateMetadata(this.metadataUrl, this.selectionHeaders);
    return yaml.load(rawData);
  }

  resolveFiles(updateInfo) {
    const files = updateInfo.files || [{ url: updateInfo.path, sha512: updateInfo.sha512 }];
    return files.map(info => ({
      url: new URL(info.url, this.metadataUrl),
      info
    }));
  }
}

async function fetchUpdateMetadata(metadataUrl, selectionHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_METADATA_TIMEOUT_MS);
  let currentUrl = new URL(metadataUrl);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (currentUrl.protocol !== 'https:' || currentUrl.username || currentUrl.password || currentUrl.hash
        || currentUrl.port || currentUrl.hostname.endsWith('.')) {
        throw new Error('Update metadata redirect URL is unsafe');
      }
      const response = await net.fetch(currentUrl.toString(), {
        headers: {
          Accept: 'text/yaml, text/plain',
          'User-Agent': `${app.getName()}/${app.getVersion()}`,
          ...(selectionHeaders || {})
        },
        redirect: 'manual',
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        if (selectionHeaders || redirects === 3) throw new Error('Update metadata redirect is not allowed');
        const location = response.headers.get('location');
        if (!location) throw new Error('Update metadata redirect has no location');
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (!response.ok) throw new Error(`Update metadata request returned HTTP ${response.status}`);
      const contentLength = Number(response.headers.get('content-length') || 0);
      if (contentLength > MAX_UPDATE_METADATA_BYTES) throw new Error('Update metadata response is too large');
      return await readLimitedResponse(response, MAX_UPDATE_METADATA_BYTES);
    }
    throw new Error('Too many update metadata redirects');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

let mainWindow;
let prefsWindow;
let updateDownloadWindow;
let updateCheckTimer;
let updateDownloadToken = null;
let updateFeedFallbackActive = false;
let updateDownloadFallbackActive = false;
let updateMetadataCandidates = buildUpdateMetadataCandidates('', process.platform);
let updateMetadataCandidatesPromise = Promise.resolve(updateMetadataCandidates);
const chartParserClients = new Map();
let activeUpdateMetadataUrl = updateMetadataCandidates[0];
let updatePromptState = {
  phase: 'idle',
  checkSource: null,
  latestInfo: null,
  latestProgress: null,
  promptPromise: null
};
const configPath = path.join(app.getPath('userData'), 'config.json');
// v14 → v15 迁移前写入的备份。只在配置尚未迁移过时生成一次，
// 后续启动不覆盖，保证用户回退旧版本时还能拿回原件。
const configBackupPath = path.join(app.getPath('userData'), 'config.v14.backup.json');
const CONFIG_VERSION = WORKSPACE_CONFIG_VERSION;
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
const WINDOWS_TITLE_BAR_HEIGHT = 32;

function themedTitleBar(backgroundColor) {
  return process.platform === 'win32' ? {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: backgroundColor,
      symbolColor: '#cccccc',
      height: WINDOWS_TITLE_BAR_HEIGHT
    }
  } : {};
}

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
  const lastBaudRate = normalizeBaudRate(oldSerial.baudRate) || defaults.lastSerialOptions.baudRate;
  normalized.customBaudRates = normalizeCustomBaudRates([
    ...normalizeCustomBaudRates(source.customBaudRates),
    ...(!isStandardBaudRate(lastBaudRate) ? [lastBaudRate] : [])
  ]);
  normalized.lastSerialOptions = {
    ...defaults.lastSerialOptions,
    ...oldSerial,
    path: typeof oldSerial.path === 'string' ? oldSerial.path : defaults.lastSerialOptions.path,
    baudRate: lastBaudRate,
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
  const oldSearch = source.searchSettings && typeof source.searchSettings === 'object'
    ? source.searchSettings
    : {};
  normalized.searchSettings = {
    historyLimit: normalizeIntegerSetting(oldSearch.historyLimit, 'searchHistoryLimit')
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
  const oldTerminalWallpaper = source.terminalWallpaper && typeof source.terminalWallpaper === 'object'
    ? source.terminalWallpaper
    : {};
  const wallpaperOpacity = Number(oldTerminalWallpaper.overlayOpacity);
  normalized.terminalWallpaper = {
    path: typeof oldTerminalWallpaper.path === 'string' ? oldTerminalWallpaper.path.trim() : '',
    overlayOpacity: Number.isFinite(wallpaperOpacity)
      ? Math.min(100, Math.max(0, Math.round(wallpaperOpacity)))
      : defaults.terminalWallpaper.overlayOpacity
  };
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
  normalized.searchHistory = normalizeSearchHistory(source.searchHistory, normalized.searchSettings.historyLimit);
  normalized.shortcuts = normalizeShortcuts(source.shortcuts);
  normalized.fontSize = normalizeIntegerSetting(source.fontSize, 'fontSize');
  normalized.fontWeight = normalizeFontWeight(source.fontWeight);
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

  const usedShellQuickCommandIds = new Set();
  normalized.shellQuickCommands = Array.isArray(source.shellQuickCommands)
    ? source.shellQuickCommands.filter(item => item && typeof item === 'object').map((item, index) => {
        let id = typeof item.id === 'string' && item.id ? item.id : `shell-quick-${index + 1}`;
        if (usedShellQuickCommandIds.has(id)) {
          let suffix = 2;
          while (usedShellQuickCommandIds.has(`${id}-${suffix}`)) suffix++;
          id = `${id}-${suffix}`;
        }
        usedShellQuickCommandIds.add(id);
        return {
          id,
          label: typeof item.label === 'string' ? item.label.trim().slice(0, 60) : '',
          command: typeof item.command === 'string' ? item.command.slice(0, 1024 * 1024) : '',
          appendEnter: normalizeBoolean(item.appendEnter, true)
        };
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
  const usedQuickGroupIds = new Set();
  normalized.quickSendGroups = Array.isArray(source.quickSendGroups)
    ? source.quickSendGroups.filter(group => group && typeof group === 'object').map((group, index) => {
        let id = typeof group.id === 'string' && group.id ? group.id : `quick-group-${index + 1}`;
        if (usedQuickGroupIds.has(id)) {
          let suffix = 2;
          while (usedQuickGroupIds.has(`${id}-${suffix}`)) suffix++;
          id = `${id}-${suffix}`;
        }
        usedQuickGroupIds.add(id);
        return {
          id,
          name: typeof group.name === 'string' && group.name.trim() ? group.name.trim().slice(0, 60) : `Group ${index + 1}`,
          collapsed: normalizeBoolean(group.collapsed, false)
        };
      })
    : [];
  normalized.quickSendUngroupedCollapsed = normalizeBoolean(source.quickSendUngroupedCollapsed, false);
  normalized.quickSendAutoTriggerEnabled = normalizeBoolean(source.quickSendAutoTriggerEnabled, true);
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
          groupId: typeof item.groupId === 'string' && usedQuickGroupIds.has(item.groupId) ? item.groupId : null,
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
        dataMode: oneOf(tab.dataMode, SERIAL_MODES, migratedMode),
        showSentOnly: normalizeBoolean(tab.showSentOnly, false)
      }))
    : [];
  normalized.chartTabs = Array.isArray(source.chartTabs)
    ? source.chartTabs.filter(tab => tab && typeof tab === 'object').map(tab => ({
        ...tab,
        id: typeof tab.id === 'string' ? tab.id : '',
        title: typeof tab.title === 'string' ? tab.title.slice(0, 100) : '',
        paneId: tab.paneId === 'pane-2' ? 'pane-2' : 'pane-1',
        encoding: oneOf(tab.encoding, SERIAL_ENCODINGS, 'utf8'),
        parserMode: oneOf(tab.parserMode, new Set(['key-value', 'template', 'regex']), 'key-value'),
        sampleLine: typeof tab.sampleLine === 'string' ? tab.sampleLine.slice(0, 64 * 1024) : '',
        lineMarker: typeof tab.lineMarker === 'string' ? tab.lineMarker.slice(0, 500) : '',
        keyValueSeparator: ['=', ':', 'auto'].includes(tab.keyValueSeparator) ? tab.keyValueSeparator : 'auto',
        template: typeof tab.template === 'string' ? tab.template.slice(0, 2000) : '',
        pattern: typeof tab.pattern === 'string' ? tab.pattern.slice(0, 2000) : '',
        fields: Array.isArray(tab.fields) ? tab.fields.filter(field => field && typeof field.key === 'string').slice(0, 16) : [],
        windowDurationMs: Math.max(1000, Math.min(24 * 60 * 60 * 1000, Number(tab.windowDurationMs) || 60000)),
        maxPoints: Math.max(1000, Math.min(1000000, Number(tab.maxPoints) || 200000)),
        maxDurationMs: Math.max(60000, Math.min(24 * 60 * 60 * 1000, Number(tab.maxDurationMs) || 1800000)),
        yAxisMode: tab.yAxisMode === 'fixed' ? 'fixed' : 'auto',
        yMin: Number.isFinite(Number(tab.yMin)) ? Number(tab.yMin) : 0,
        yMax: Number.isFinite(Number(tab.yMax)) ? Number(tab.yMax) : 100,
        yIncludeZero: tab.yIncludeZero === true,
        yMargin: Math.max(0, Math.min(1, Number.isFinite(Number(tab.yMargin)) ? Number(tab.yMargin) : 0.08))
      }))
    : [];
  normalized.clearAllLogsIncludesShell = normalizeBoolean(source.clearAllLogsIncludesShell, false);
  normalized.scrollToBottomOnSend = normalizeBoolean(source.scrollToBottomOnSend, true);
  normalized.echoSentData = normalizeBoolean(source.echoSentData, true);
  normalized.echoSentDataBothFormats = normalizeBoolean(source.echoSentDataBothFormats, false);
  normalized.echoSentDataInFilterTabs = normalizeBoolean(source.echoSentDataInFilterTabs, true);
  normalized.echoSentDataHighlightColor = HEX_COLOR_PATTERN.test(source.echoSentDataHighlightColor || '')
    ? source.echoSentDataHighlightColor
    : defaults.echoSentDataHighlightColor;
  normalized.saveShellTabsLogToFiles = normalizeBoolean(source.saveShellTabsLogToFiles, false);
  normalized.saveRawSerialToFile = normalizeBoolean(source.saveRawSerialToFile, false);
  normalized.manualExportDirectory = typeof source.manualExportDirectory === 'string' && source.manualExportDirectory.trim()
    ? source.manualExportDirectory
    : defaults.manualExportDirectory;
  normalized.logIncludeTimestamp = normalizeBoolean(source.logIncludeTimestamp, false);
  normalized.logIncludeLineNumbers = normalizeBoolean(source.logIncludeLineNumbers, false);
  normalized.logCreateDateFolder = normalizeBoolean(source.logCreateDateFolder, false);
  normalized.rawBufferAutoFlushMB = normalizeIntegerSetting(source.rawBufferAutoFlushMB, 'rawBufferAutoFlushMB');
  normalized.rawLogFileNameFormat = typeof source.rawLogFileNameFormat === 'string' && source.rawLogFileNameFormat.trim()
    ? source.rawLogFileNameFormat
    : 'raw_%Y-%m-%d_%H-%M-%S.bin';
  normalized.logRetentionDays = oneOf(Number(source.logRetentionDays), LOG_RETENTION_DAYS, 0);
  // 配置 v14 → v15：把旧的全字段搬进 serialGroups[0]。
  //
  // 放在 normalizeConfig 的最后一步而不是 loadConfig 里，是因为归一化可能被反复调用，
  // 而迁移本身必须是幂等的：migrateSerialGroupsConfig 用「有没有 serialGroups 键」
  // 判断是否已迁移，所以重复执行只会重算一次归一化，不会造出第二个分组。
  // 旧字段一律保留，用户回退到 v14 时仍能读到完整配置。
  return migrateWorkspaceLayoutConfig(migrateSerialGroupsConfig(normalized));
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
    fontWeight: 400,
    fontFamily: 'Consolas',
    fontFamilyZh: '"Microsoft YaHei"',
    foreground: '#cec7bb',
    background: '#080808',
    terminalWallpaper: {
      path: '',
      overlayOpacity: 55
    },
    timestampColor: '#808080',
    lineNoColor: '#67986f',
    highlightColors: {
      search: { background: '#f5d90a', foreground: '#000000' },
      filter: { background: '#535353', foreground: '#ffffff' },
      selection: { background: '#073ca8', foreground: '#ffffff' }
    },
    logEnabled: false,
    saveAllTabsLogToFiles: false,
    scrollToBottomOnSend: true,
    echoSentData: true,
    echoSentDataBothFormats: false,
    echoSentDataInFilterTabs: true,
    echoSentDataHighlightColor: '#1e3a5f',
    clearAllLogsIncludesShell: false,
    saveShellTabsLogToFiles: false,
    logIncludeTimestamp: false,
    logIncludeLineNumbers: false,
    rawBufferAutoFlushMB: 10,
    saveRawSerialToFile: false,
    rawLogFileNameFormat: 'raw_%Y-%m-%d_%H-%M-%S.bin',
    stripAnsiInLog: true,
    logPath: path.join(app.getPath('documents'), 'SerialTerminalLogs'),
    logCreateDateFolder: false,
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
        { regex: "[+\\-*/=<>!&|%^~]+", color: "#fec320", enabled: true, caseSensitive: true, useRegex: true }
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
    shellQuickCommands: [],
    chartTabs: [],
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
    searchSettings: {
      historyLimit: 20
    },
    sidebarCollapsed: false,
    activeSidebarTab: 'tab-settings',
    lastWelcomeVersion: '',
    lastUpdatePromptVersion: '',
    lastUpdatePromptAt: 0,
    mainInputHistory: [],
    searchHistory: [],
    shortcuts: DEFAULT_SHORTCUTS,
    autoSendSettings: {
      enabled: false,
      interval: 1000,
      content: ''
    },
    quickSendList: [],
    quickSendAutoTriggerEnabled: true,
    quickSendGroups: [],
    quickSendUngroupedCollapsed: false,
    sidebarQuickSendOrder: [],
    hexDisplaySettings: {
      bytesPerLine: 16,
      showOffset: true,
      showAscii: true,
      uppercase: true,
      idleFlushMs: 50
    },
    skippedUpdateVersion: '',
    customBaudRates: [],
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
      // 迁移前先备份 v14 原件。
      //
      // 只在「尚未迁移过」时备份：已经迁移过的配置再备份，会把真正的 v14 原件覆盖成 v15，
      // 用户回退时就无据可依。备份失败不能阻断启动，否则一次磁盘问题就让用户打不开程序。
      if (needsSerialGroupsMigration(saved) && !fs.existsSync(configBackupPath)) {
        try {
          fs.writeFileSync(configBackupPath, JSON.stringify(saved, null, 2));
          log.info(`Config backup written before v15 migration: ${configBackupPath}`);
        } catch (backupError) {
          log.error('Failed to write config backup before migration:', backupError);
        }
      }
      // Preserve the last legacy layout before the versioned snapshot becomes authoritative.
      const layoutBackupPath = path.join(app.getPath('userData'), 'config.v15.backup.json');
      if (Number(saved.configVersion || 0) < CONFIG_VERSION && !fs.existsSync(layoutBackupPath)) {
        try {
          fs.writeFileSync(layoutBackupPath, JSON.stringify(saved, null, 2));
        } catch (error) {
          log.error('Failed to back up legacy workspace config:', error);
          return normalizeConfig(saved, defaults);
        }
      }
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

// 多串口日志归属：每个分组的日志写到以端口号命名的子文件夹。
// 日志层级固定为 <logPath>/[日期]/<端口号>/，日期目录必须在外层：
// log-cleanup.js 只递归匹配 ^\d{4}-\d{2}-\d{2}$ 的目录，
// 若把端口目录放外层，过期日志永远不会被清理。
const SERIAL_LOG_FOLDER_SHELL = '_shell';
// 串口分组默认 id。日志层在模块顶层就会引用它，因此必须先于所有使用者声明（const 有 TDZ）。
const DEFAULT_SERIAL_GROUP_ID = 'default';

const groupLogStates = new Map();
const tabLogBuffers = new Map();
let activeLogDate = '';
let logDateRotationInProgress = false;

function getGroupLogState(groupId) {
  const id = normalizeSerialGroupId(groupId);
  if (!groupLogStates.has(id)) {
    groupLogStates.set(id, {
      groupId: id,
      text: { buffer: [], byteCount: 0, filePath: '', flushError: null, overflowNotified: false },
      raw: { buffer: [], byteCount: 0, filePath: '', flushError: null, overflowNotified: false }
    });
  }
  return groupLogStates.get(id);
}
let logFlushTimer = null;
let logCleanupTimer = null;
let logCleanupInFlight = false;
let logCleanupPending = false;
const logErrorNoticeKeys = new Set();
const LOG_AUTO_FLUSH_INTERVAL_MS = 5000;
const LOG_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function buildPortLogFolderName(portPath, groupId) {
  // 必须取 basename：Linux 的 /dev/ttyUSB0 直接当目录名会产生非法字符。
  const base = path.basename(String(portPath || '').trim());
  const safe = sanitizeFileNamePart(base).replace(/[. ]+$/g, '');
  // 端口名缺失时退回 groupId，避免多个分组撞进同一个目录。
  return safe || normalizeSerialGroupId(groupId);
}

function resolveLogFolderName(groupId) {
  const id = normalizeSerialGroupId(groupId);
  if (id === SERIAL_LOG_FOLDER_SHELL) return SERIAL_LOG_FOLDER_SHELL;
  const session = getSerialSession(id);
  return buildPortLogFolderName(session?.portPath, id);
}

function getAutoFlushThreshold() {
  const mb = Number(currentConfig.rawBufferAutoFlushMB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024;
}

function notifyLogError(kind, error, details = {}) {
  const message = error?.message || String(error || 'Unknown log write error');
  const noticeKey = `${kind}:${details.groupId || ''}:${details.tabId || ''}:${details.paused ? 'paused' : 'write'}:${message}`;
  if (logErrorNoticeKeys.has(noticeKey)) return;
  logErrorNoticeKeys.add(noticeKey);
  log.error(`Log write failed (${kind}):`, error);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log-error', { kind, message, ...details });
  }
}

function clearLogErrorNotice(kind, { groupId = '', tabId = '' } = {}) {
  for (const key of Array.from(logErrorNoticeKeys)) {
    if (key.startsWith(`${kind}:${groupId}:${tabId}:`)) logErrorNoticeKeys.delete(key);
  }
}

function shouldAcceptMoreCachedLog(kind, byteCount, error, wasNotified, details = {}) {
  if (!error || byteCount < getAutoFlushThreshold()) return true;
  if (!wasNotified) {
    notifyLogError(kind, error, { ...details, paused: true });
  }
  return false;
}

function ensureTabLogFile(tabId) {
  const entry = tabLogBuffers.get(tabId);
  if (!entry) return '';
  rotateLogFilesForCurrentDate();
  // 本标签持有独立文件路径；只在成功刷盘后轮转。
  if (entry.filePath) return entry.filePath;
  entry.filePath = createUniqueLogFilePath(entry.groupId, buildLogFileName({ tabTitle: entry.title || tabId }));
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
  rotateLogFilesForCurrentDate();
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
    entry.flushError = null;
    entry.overflowNotified = false;
    clearLogErrorNotice('tab', { groupId: entry.groupId, tabId });
    return true;
  } catch (error) {
    entry.flushError = error;
    notifyLogError('tab', error, { tabId, groupId: entry.groupId });
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

function ensureMainLogFilePath(groupId = DEFAULT_SERIAL_GROUP_ID) {
  rotateLogFilesForCurrentDate();
  const state = getGroupLogState(groupId).text;
  if (state.filePath) return state.filePath;
  state.filePath = createUniqueLogFilePath(groupId, buildLogFileName({}));
  return state.filePath;
}

function createUniqueLogFilePath(groupId, fileName) {
  const logDirectory = ensureLogDirectory(groupId);
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  const activePaths = new Set(getActiveLogFilePaths());
  let filePath = path.join(logDirectory, fileName);
  let suffix = 2;
  while (fs.existsSync(filePath) || activePaths.has(filePath)) {
    filePath = path.join(logDirectory, `${baseName}_${suffix}${extension}`);
    suffix++;
  }
  return filePath;
}

function ensureRawBinaryLogPath(groupId = DEFAULT_SERIAL_GROUP_ID) {
  rotateLogFilesForCurrentDate();
  const state = getGroupLogState(groupId).raw;
  if (state.filePath) return state.filePath;
  state.filePath = createUniqueLogFilePath(groupId, buildRawLogFileName());
  return state.filePath;
}

function flushRawBinaryLogSync(groupId) {
  rotateLogFilesForCurrentDate();
  const groups = groupId === undefined ? [...groupLogStates.values()] : [getGroupLogState(groupId)];
  let ok = true;
  for (const group of groups) {
    const state = group.raw;
    if (!state.buffer.length) continue;
    try {
      fs.appendFileSync(ensureRawBinaryLogPath(group.groupId), Buffer.concat(state.buffer, state.byteCount));
      state.buffer = [];
      state.byteCount = 0;
      state.flushError = null;
      state.overflowNotified = false;
      clearLogErrorNotice('raw', { groupId: group.groupId });
    } catch (error) {
      state.flushError = error;
      notifyLogError('raw', error, { groupId: group.groupId });
      ok = false;
    }
  }
  return ok;
}

function bufferRawSerialBytes(data, groupId = DEFAULT_SERIAL_GROUP_ID) {
  if (!currentConfig.saveRawSerialToFile || !Buffer.isBuffer(data) || data.length === 0) return;
  rotateLogFilesForCurrentDate();
  const group = getGroupLogState(groupId);
  const state = group.raw;
  ensureRawBinaryLogPath(group.groupId);
  if (!shouldAcceptMoreCachedLog('raw', state.byteCount, state.flushError, state.overflowNotified, { groupId: group.groupId })) {
    state.overflowNotified = true;
    return;
  }
  state.buffer.push(Buffer.from(data));
  state.byteCount += data.length;
  if (state.byteCount >= getAutoFlushThreshold()) flushRawBinaryLogSync(group.groupId);
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


function rotateLogFilesForCurrentDate() {
  if (!currentConfig.logCreateDateFolder || logDateRotationInProgress) return;
  const today = formatLocalDate();
  if (!activeLogDate) {
    activeLogDate = today;
    return;
  }
  if (activeLogDate === today) return;
  logDateRotationInProgress = true;
  try {
    flushRawBinaryLogSync();
    if (currentConfig.saveAllTabsLogToFiles) saveAllTabLogs({ notify: false, closeEntries: false });
    else saveLog({ notify: false });
  } finally {
    logDateRotationInProgress = false;
  }
  resetEmptyLogPaths();
  activeLogDate = today;
}

function ensureLogDirectory(groupId = DEFAULT_SERIAL_GROUP_ID) {
  rotateLogFilesForCurrentDate();
  // 日期目录在外层，端口目录在内层：log-cleanup 只递归匹配日期格式的目录名。
  const baseDirectory = getLogDirectory(currentConfig.logPath, currentConfig.logCreateDateFolder);
  const logDirectory = path.join(baseDirectory, resolveLogFolderName(groupId));
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory, { recursive: true });
  }
  return logDirectory;
}

function saveLog({ notify = true, groupId } = {}) {
  rotateLogFilesForCurrentDate();
  const groups = groupId === undefined ? [...groupLogStates.values()] : [getGroupLogState(groupId)];
  let ok = true;
  for (const group of groups) {
    const state = group.text;
    if (!state.buffer.length) continue;
    try {
      const filePath = ensureMainLogFilePath(group.groupId);
      fs.appendFileSync(filePath, iconv.encode(state.buffer.join(''), currentConfig.logEncoding));
      state.buffer = [];
      state.byteCount = 0;
      state.flushError = null;
      state.overflowNotified = false;
      clearLogErrorNotice('text', { groupId: group.groupId });
      if (notify && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('log-saved', { path: filePath, groupId: group.groupId });
      }
    } catch (error) {
      state.flushError = error;
      notifyLogError('text', error, { groupId: group.groupId });
      ok = false;
    }
  }
  return ok;
}

function resetEmptyLogPaths({ text = true, raw = true, groupId } = {}) {
  for (const group of groupLogStates.values()) {
    if (groupId !== undefined && group.groupId !== groupId) continue;
    if (text && !group.text.buffer.length) group.text.filePath = '';
    if (raw && !group.raw.buffer.length) group.raw.filePath = '';
  }
  if (text) tabLogBuffers.forEach(entry => {
    if ((groupId === undefined || entry.groupId === groupId) && !entry.buffer.length) entry.filePath = '';
  });
}

function closeMainLogSession({ notify = true, groupId } = {}) {
  const ok = saveLog({ notify, groupId });
  resetEmptyLogPaths({ raw: false, groupId });
  return ok;
}

function saveAllTabLogs({ notify = true, closeEntries = true, groupId } = {}) {
  if (!currentConfig.logEnabled || !currentConfig.saveAllTabsLogToFiles || tabLogBuffers.size === 0) return true;
  const savedPaths = [];
  let ok = true;
  for (const [tabId, entry] of tabLogBuffers.entries()) {
    if (groupId !== undefined && entry.groupId !== groupId) continue;
    if (!flushTabLogEntrySync(tabId, entry)) {
      ok = false;
      continue;
    }
    if (entry.filePath && fs.existsSync(entry.filePath)) savedPaths.push(entry.filePath);
    if (closeEntries) tabLogBuffers.delete(tabId);
  }
  if (notify && savedPaths.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('all-tabs-log-saved', { paths: savedPaths });
  }
  return ok;
}

function closeShellTabLogSessions({ notify = true } = {}) {
  let ok = true;
  const savedPaths = [];
  for (const [tabId, entry] of tabLogBuffers.entries()) {
    if (!tabId.startsWith('tab-shell-')) continue;
    if (!flushTabLogEntrySync(tabId, entry)) { ok = false; continue; }
    if (entry.filePath && fs.existsSync(entry.filePath)) savedPaths.push(entry.filePath);
    tabLogBuffers.delete(tabId);
  }
  if (notify && savedPaths.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('all-tabs-log-saved', { paths: savedPaths });
  }
  return ok;
}

// 关闭自动日志时把已缓冲内容落盘并清空所有日志会话，避免重新开启后接写到旧文件。
function closeLogSessionsForDisabled() {
  const rawOk = flushRawBinaryLogSync();
  const textOk = currentConfig.saveAllTabsLogToFiles
    ? saveAllTabLogs({ notify: false })
    : saveLog({ notify: false });
  resetEmptyLogPaths();
  if (!rawOk || !textOk) throw new Error('Failed to flush pending logs');
}

function stripAnsi(str) {
  if (typeof str !== 'string' || !str) return str || '';
  if (currentConfig.stripAnsiInLog === false) return str;
  // Only strip SGR sequences (color/style codes ending with 'm'),
  // avoiding false positives on raw binary data that contains other CSI sequences.
  if (!str.includes('\x1b')) return str;
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function writeLog(data, groupId = DEFAULT_SERIAL_GROUP_ID) {
  if (!currentConfig.logEnabled || !data || currentConfig.saveAllTabsLogToFiles) return;
  rotateLogFilesForCurrentDate();
  const group = getGroupLogState(groupId);
  const state = group.text;
  ensureMainLogFilePath(group.groupId);
  if (!shouldAcceptMoreCachedLog('text', state.byteCount, state.flushError, state.overflowNotified, { groupId: group.groupId })) {
    state.overflowNotified = true;
    return;
  }
  state.buffer.push(data);
  state.byteCount += Buffer.byteLength(data);
  if (state.byteCount >= getAutoFlushThreshold()) saveLog({ notify: false, groupId: group.groupId });
}

function writeTabLog(tabId, title, data, groupId = DEFAULT_SERIAL_GROUP_ID) {
  if (!tabId || typeof data !== 'string' || !data) return;
  // 自动日志总开关关闭后必须整体停止写盘，否则分标签页分支会继续追加到旧文件。
  if (!currentConfig.logEnabled) return;
  if (tabId.startsWith('tab-shell-') && !currentConfig.saveShellTabsLogToFiles) return;
  const clean = stripAnsi(data);
  if (tabId === (normalizeSerialGroupId(groupId) === DEFAULT_SERIAL_GROUP_ID ? 'tab-main' : `tab-main-${normalizeSerialGroupId(groupId)}`)) {
    writeLog(clean, groupId);
  }
  if (!currentConfig.saveAllTabsLogToFiles) return;
  // 每个标签页的日志归属它所在的分组，Shell 固定 _shell。
  const logGroupId = tabId.startsWith('tab-shell-')
    ? SERIAL_LOG_FOLDER_SHELL
    : normalizeSerialGroupId(groupId);
  const existing = tabLogBuffers.get(tabId) || { title: title || tabId, buffer: [], filePath: '', byteCount: 0, groupId: logGroupId };
  existing.groupId = logGroupId;
  tabLogBuffers.set(tabId, existing);
  rotateLogFilesForCurrentDate();
  ensureTabLogFile(tabId);
  if (!shouldAcceptMoreCachedLog('tab', existing.byteCount || 0, existing.flushError, existing.overflowNotified, { groupId: logGroupId, tabId })) {
    existing.overflowNotified = true;
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
  // 自动日志关闭后不再进行任何周期性刷盘，避免空缓冲也去创建文件。
  if (!currentConfig.logEnabled) return;
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
  const activePaths = [...groupLogStates.values()].flatMap(group => [group.text.filePath, group.raw.filePath]);
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
  for (const key of ['lastSerialOptions', 'hexDisplaySettings', 'mainInputSettings', 'searchSettings', 'autoSendSettings', 'highlightColors', 'terminalWallpaper']) {
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
    || normalized.logCreateDateFolder !== currentConfig.logCreateDateFolder
    || normalized.rawLogFileNameFormat !== currentConfig.rawLogFileNameFormat;
  const textLogDestinationChanged = normalized.logPath !== currentConfig.logPath
    || normalized.logCreateDateFolder !== currentConfig.logCreateDateFolder
    || normalized.logFileNameFormat !== currentConfig.logFileNameFormat
    || normalized.logEncoding !== currentConfig.logEncoding;
  const logCleanupSettingsChanged = normalized.logPath !== currentConfig.logPath
    || normalized.logRetentionDays !== currentConfig.logRetentionDays;
  if (currentConfig.logEnabled && textLogDestinationChanged) {
    const ok = currentConfig.saveAllTabsLogToFiles ? saveAllTabLogs() : saveLog();
    if (!ok) throw new Error('Failed to flush pending text logs');
  }
  if (currentConfig.saveRawSerialToFile
      && (!normalized.saveRawSerialToFile || rawLogDestinationChanged)
      && !flushRawBinaryLogSync()) {
    throw new Error('Failed to flush pending raw serial log');
  }
  if (textLogDestinationChanged || rawLogDestinationChanged) {
    resetEmptyLogPaths({ text: textLogDestinationChanged, raw: rawLogDestinationChanged });
  }
  if (normalized.logCreateDateFolder !== currentConfig.logCreateDateFolder) activeLogDate = '';
  if (currentConfig.saveShellTabsLogToFiles && !normalized.saveShellTabsLogToFiles) {
    if (!closeShellTabLogSessions()) throw new Error('Failed to flush pending Shell logs');
  }
  if (currentConfig.saveAllTabsLogToFiles && !normalized.saveAllTabsLogToFiles) {
    if (!saveAllTabLogs()) throw new Error('Failed to flush pending tab logs');
  } else if (!currentConfig.saveAllTabsLogToFiles && normalized.saveAllTabsLogToFiles) {
    if (!closeMainLogSession()) throw new Error('Failed to flush pending text logs');
  }
  if (currentConfig.logEnabled && !normalized.logEnabled) {
    // 关闭自动日志总开关：先把已缓冲内容落盘并清空会话，避免切换后仍向旧文件追加。
    closeLogSessionsForDisabled();
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
    name: 'xterm-256color',
    cols: session.cols,
    rows: session.rows,
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    useConpty: process.platform === 'win32',
    useConptyDll: process.platform === 'win32'
  });

  session.ptyProcess = ptyProcess;
  shellSessions.set(tabId, session);

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shell-tab-output', { tabId, data });
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    if (shellSessions.get(tabId) !== session) return;
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
    const title = getMainWindowTitle();
    mainWindow.setTitle(title);
    mainWindow.webContents.send('window-title-updated', title);
  }
}

function getChartParserClientKey(webContentsId, clientId) {
  return `${webContentsId}:${String(clientId || '').slice(0, 100)}`;
}

function closeChartParserClients(webContentsId) {
  const prefix = `${webContentsId}:`;
  for (const [key, client] of chartParserClients) {
    if (!key.startsWith(prefix)) continue;
    client.close();
    chartParserClients.delete(key);
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
    ...themedTitleBar('#1e1e1e'),
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  const mainWebContentsId = mainWindow.webContents.id;

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
      closeChartParserClients(mainWebContentsId);
      log.error('Renderer process exited:', details);
    });

    mainWindow.webContents.on('destroyed', () => {
      closeChartParserClients(mainWebContentsId);
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
    ...themedTitleBar('#252526'),
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
  const artifactPattern = new RegExp(`\\.${UPDATE_PACKAGE_TYPE}(?:$|[?#])`, 'i');
  const artifactFile = Array.isArray(info?.files)
    ? info.files.find(file => artifactPattern.test(file?.name || file?.url || ''))
    : null;
  if (artifactFile?.url) {
    try {
      return new URL(String(artifactFile.url), activeUpdateMetadataUrl).toString();
    } catch (error) {
      log.warn('Failed to resolve manual update URL:', error);
    }
  }
  return getReleaseUrl();
}

function withUpdateChannel(info) {
  if (!info || typeof info !== 'object') return info;
  const updateChannel = getUpdateChannel(activeUpdateMetadataUrl, info, process.platform, UPDATE_PACKAGE_TYPE)
    || info.updateChannel
    || updatePromptState.latestInfo?.updateChannel
    || '';
  return { ...info, updateChannel };
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
    ...themedTitleBar('#252526'),
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
      updateChannelLabel: tr('updateDialog.updateChannel'),
      updateChannel: info?.updateChannel || getUpdateChannel(activeUpdateMetadataUrl, info, process.platform, UPDATE_PACKAGE_TYPE),
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
  return process.platform === 'linux' ? GITHUB_RELEASE_PAGE : GITEE_RELEASE_PAGE;
}

async function checkUpdateSources() {
  updateFeedFallbackActive = true;
  try {
    let lastError;
    const validateUpdateInfo = (metadataUrl, info, expectedInfo = info) => {
      compareUpdateVersions(info?.version, info?.version);
      if (UPDATE_CHANNEL === 'stable' && !isStableUpdateVersion(info?.version)) {
        throw new Error('Stable update metadata cannot select a prerelease version');
      }
      if (!isSameUpdate(info, info, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update metadata does not contain a supported installer SHA-512');
      }
      if (!isUpdateSourceConsistent(metadataUrl, info, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update metadata points to an installer on a different source');
      }
      if (!isSameUpdate(expectedInfo, info, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update metadata changed during verification');
      }
      if (getUpdateChannel(metadataUrl, expectedInfo, process.platform, UPDATE_PACKAGE_TYPE)
        !== getUpdateChannel(metadataUrl, info, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update metadata source changed during verification');
      }
      return info;
    };
    const checkMetadataSource = async (metadataUrl, description) => {
      try {
        log.info(`Checking ${description} update metadata source: ${metadataUrl}`);
        const provider = new UpdateMetadataProvider(
          { metadataUrl, selectionHeaders: getUpdateMetadataSelectionHeaders(metadataUrl) },
          autoUpdater,
          autoUpdater.createProviderRuntimeOptions()
        );
        const info = await provider.getLatestVersion();
        validateUpdateInfo(metadataUrl, info);
        return { metadataUrl, info };
      } catch (error) {
        lastError = error;
        log.warn(`Update metadata source failed: ${metadataUrl}`, error);
        return null;
      }
    };

    const dynamicPromise = process.platform === 'win32'
      ? checkMetadataSource(DYNAMIC_UPDATE_METADATA_URL, 'dynamic')
      : Promise.resolve(null);
    const fallbackReleasesPromise = (async () => {
      const giteeMetadataUrl = process.platform === 'win32'
        ? await resolveGiteeUpdateMetadataUrl({ logger: log })
        : '';
      const candidates = buildUpdateMetadataCandidates(giteeMetadataUrl, process.platform)
        .filter(metadataUrl => metadataUrl !== DYNAMIC_UPDATE_METADATA_URL);
      return (await Promise.all(candidates.map(metadataUrl => checkMetadataSource(metadataUrl, 'fallback'))))
        .filter(Boolean);
    })();
    const dynamicRelease = await dynamicPromise;
    const releases = dynamicRelease ? [dynamicRelease] : await fallbackReleasesPromise;
    if (!releases.length) throw lastError || new Error('No update metadata source is available');

    const selectedReleases = dynamicRelease
      ? [dynamicRelease]
      : selectUpdateReleaseCandidates(releases, process.platform, UPDATE_PACKAGE_TYPE);
    updateMetadataCandidates = selectedReleases
      .map(candidate => candidate.metadataUrl);
    const matchingFallbackReleasesPromise = dynamicRelease
      ? fallbackReleasesPromise.then(fallbackReleases => fallbackReleases
          .filter(release => isSameUpdate(dynamicRelease.info, release.info, process.platform, UPDATE_PACKAGE_TYPE)))
      : Promise.resolve(selectedReleases);
    updateMetadataCandidatesPromise = matchingFallbackReleasesPromise
      .then(fallbackReleases => {
          updateMetadataCandidates = [
            ...(dynamicRelease ? [dynamicRelease.metadataUrl] : []),
            ...fallbackReleases.map(candidate => candidate.metadataUrl)
          ];
          return updateMetadataCandidates;
        });
    const runVerifiedUpdaterCheck = async release => {
      const { metadataUrl, info: expectedInfo } = release;
      activeUpdateMetadataUrl = metadataUrl;
      configureUpdateFeed(metadataUrl);
      const result = await autoUpdater.checkForUpdates();
      const info = validateUpdateInfo(metadataUrl, result?.updateInfo || result?.versionInfo, expectedInfo);
      if (result?.isUpdateAvailable) handleVerifiedUpdateAvailable(info);
      else handleVerifiedUpdateNotAvailable(info);
      return result;
    };
    for (const release of selectedReleases) {
      try {
        return await runVerifiedUpdaterCheck(release);
      } catch (error) {
        lastError = error;
        log.warn(`Verified update metadata source failed during updater check: ${release.metadataUrl}`, error);
      }
    }
    if (dynamicRelease) {
      const fallbackReleases = await matchingFallbackReleasesPromise;
      for (const release of fallbackReleases) {
        try {
          return await runVerifiedUpdaterCheck(release);
        } catch (error) {
          lastError = error;
          log.warn(`Verified fallback metadata source failed during updater check: ${release.metadataUrl}`, error);
        }
      }
    }
    throw lastError || new Error('No verified update metadata source is available');
  } catch (error) {
    if (updatePromptState.phase === 'checking') {
      sendUpdateStatusToPrefs('error', error.message);
      updatePromptState.phase = 'idle';
      updatePromptState.checkSource = null;
    }
    throw error;
  } finally {
    updateFeedFallbackActive = false;
  }
}

function getUpdateMetadataSelectionHeaders(metadataUrl) {
  if (metadataUrl !== DYNAMIC_UPDATE_METADATA_URL) return undefined;
  return {
    'X-SerialTerminal-Version': app.getVersion(),
    'X-SerialTerminal-Channel': UPDATE_CHANNEL
  };
}

function configureUpdateFeed(metadataUrl) {
  autoUpdater.setFeedURL({
    provider: 'custom',
    updateProvider: UpdateMetadataProvider,
    metadataUrl,
    selectionHeaders: getUpdateMetadataSelectionHeaders(metadataUrl)
  });
}

async function fetchGiteeReleaseNotes(version) {
  if (!version) return '';

  const tagsToTry = [`v${version}`, version];

  for (const tag of tagsToTry) {
    const apiUrl = `${GITEE_API_BASE}/releases/tags/${encodeURIComponent(tag)}`;
    try {
      const response = await fetch(apiUrl, {
        headers: { Accept: 'application/json', 'User-Agent': `${app.getName()}/${app.getVersion()}` }
      });

      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      return typeof data.body === 'string' ? data.body.trim() : '';
    } catch (error) {
      log.warn(`Failed to fetch Gitee release notes for tag ${tag}:`, error);
    }
  }

  return '';
}

async function promptForAvailableUpdate(info, isStartupPrompt = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const version = info?.version || '';
  const detailLines = [];
  if (info?.updateChannel) detailLines.push(`${tr('updateDialog.updateChannel')}: ${info.updateChannel}`);
  if (info?.releaseName) detailLines.push(`${tr('updateDialog.releaseLabel')} ${info.releaseName}`);
  if (info?.releaseDate) detailLines.push(`${tr('updateDialog.dateLabel')} ${new Date(info.releaseDate).toLocaleString()}`);
  const releaseNotes = await fetchGiteeReleaseNotes(version);

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

  downloadUpdateWithFallback(token).catch(error => {
    if (!token.cancelled) {
      log.error('Failed to download update:', error);
      updatePromptState.phase = 'available';
      sendUpdateStatusToPrefs('error', error.message);
      sendUpdateDownloadStatus('error', error.message);
    }
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

async function downloadUpdateWithFallback(token) {
  const expectedInfo = updatePromptState.latestInfo;
  updateDownloadFallbackActive = true;
  try {
    await updateMetadataCandidatesPromise;
    return await runUpdateSourceFallback(updateMetadataCandidates, async (metadataUrl, index) => {
      configureUpdateFeed(metadataUrl);
      const result = await autoUpdater.checkForUpdates();
      if (!result?.isUpdateAvailable) throw new Error('Selected update is not available from this source');
      const sourceInfo = result?.updateInfo || result?.versionInfo;
      if (!isSameUpdate(expectedInfo, sourceInfo, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update version or SHA-512 does not match the selected release');
      }
      if (UPDATE_CHANNEL === 'stable' && !isStableUpdateVersion(sourceInfo?.version)) {
        throw new Error('Stable update metadata cannot select a prerelease version');
      }
      if (!isUpdateSourceConsistent(metadataUrl, sourceInfo, process.platform, UPDATE_PACKAGE_TYPE)) {
        throw new Error('Update metadata points to an installer on a different source');
      }
      activeUpdateMetadataUrl = metadataUrl;
      autoUpdater.disableDifferentialDownload = getUpdateChannel(metadataUrl, sourceInfo, process.platform, UPDATE_PACKAGE_TYPE) === 'Gitee';
      updatePromptState.latestInfo = withUpdateChannel({ ...sourceInfo, updateChannel: '' });
      log.info(`Downloading update from source ${index + 1}/${updateMetadataCandidates.length}: ${metadataUrl}`);
      return autoUpdater.downloadUpdate(token);
    }, {
      isCancelled: () => token.cancelled,
      logger: log
    });
  } finally {
    updateDownloadFallbackActive = false;
  }
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

function showScheduledUpdateToast(info) {
  recordUpdatePrompt(info);
  updatePromptState.phase = 'available';
  updatePromptState.checkSource = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scheduled-update-available', { version: info?.version || '' });
  }
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
      checkUpdateSources().catch(error => {
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
  checkUpdateSources().catch(error => {
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

ipcMain.handle('select-terminal-wallpaper', async () => {
  const result = await dialog.showOpenDialog(prefsWindow || mainWindow, {
    title: tr('prefs.selectTerminalWallpaper'),
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
    ],
    properties: ['openFile']
  });
  return result.canceled ? null : result.filePaths[0];
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
    mainWindow.webContents.send('config-updated', currentConfig, { scope: 'reset-workspace' });
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

ipcMain.handle('save-chart-csv', async (event, payload = {}) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const exportDirectory = currentConfig.manualExportDirectory || app.getPath('documents');
  const title = sanitizeFileNamePart(payload.title) || 'Chart';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog(owner, {
    title: 'Export Chart CSV',
    defaultPath: path.join(exportDirectory, `${title}_${timestamp}.csv`),
    filters: [{ name: 'CSV Files', extensions: ['csv'] }]
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.promises.writeFile(result.filePath, typeof payload.content === 'string' ? payload.content : '', 'utf8');
  saveConfig({ manualExportDirectory: path.dirname(result.filePath) });
  return { canceled: false, filePath: result.filePath };
});

ipcMain.on('chart-parser-start', (event, payload = {}) => {
  const clientId = typeof payload.clientId === 'string' ? payload.clientId.slice(0, 100) : '';
  if (!clientId) return;
  const key = getChartParserClientKey(event.sender.id, clientId);
  chartParserClients.get(key)?.close();
  const send = message => {
    if (!event.sender.isDestroyed()) event.sender.send('chart-parser-result', { clientId, ...message });
  };
  try {
    chartParserClients.set(key, new ChartParserWorkerClient({
      config: payload.config,
      onSamples: samples => send({ type: 'samples', samples }),
      onStats: stats => send({ type: 'stats', stats }),
      onError: error => send({ type: 'error', message: error.message })
    }));
  } catch (error) {
    send({ type: 'error', message: error.message });
  }
});

ipcMain.on('chart-parser-push', (event, payload = {}) => {
  const key = getChartParserClientKey(event.sender.id, payload.clientId);
  chartParserClients.get(key)?.push(payload.record);
});

ipcMain.on('chart-parser-reset', (event, payload = {}) => {
  const key = getChartParserClientKey(event.sender.id, payload.clientId);
  chartParserClients.get(key)?.reset();
});

ipcMain.on('chart-parser-close', (event, payload = {}) => {
  const key = getChartParserClientKey(event.sender.id, payload.clientId);
  chartParserClients.get(key)?.close();
  chartParserClients.delete(key);
});

ipcMain.handle('chart-parser-discover', (event, payload = {}) => {
  return discoverChartFieldsInWorker(payload.sampleLine, payload.config);
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
    mainWindow.webContents.send('config-updated', currentConfig, { scope: 'settings' });
  }
  return { ok: true };
});

ipcMain.on('write-tab-log', (event, payload = {}) => {
  // groupId 决定日志落到哪个端口目录。渲染层必须逐条带上它，否则多分组下
  // 所有主终端日志都会挤进默认分组的目录。
  writeTabLog(payload.tabId, payload.title, payload.data, payload.groupId);
});

ipcMain.on('flush-tab-logs', () => {
  if (currentConfig.saveAllTabsLogToFiles) {
    saveAllTabLogs();
  } else {
    closeMainLogSession();
  }
});

ipcMain.on('flush-tab-log', (event, payload = {}) => {
  if (!currentConfig.logEnabled || !currentConfig.saveAllTabsLogToFiles || !payload.tabId) { return; }
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
    paneId: payload.paneId || 'pane-1',
    // 分组级动作（split-group-*）必须知道「用户右键的是哪一个分组」。
    // 不回传它，渲染侧就只能拿激活分组凑数：实测在两个分组已分屏、激活的是 g-1 时
    // 右键 g-2 选分屏，被记进参与者表的仍是 g-1，g-2 永远进不来。
    groupId: payload.groupId || ''
  };

  const hasSelection = Boolean(payload.hasSelection);
  const isConnected = Boolean(payload.isConnected);
  const canLocateInMain = Boolean(payload.canLocateInMain);
  const isMultiGroup = Boolean(payload.isMultiGroup);
  // 'tab' = 单分组时右键某个普通标签：只给组内 pane 分屏那几项。
  // 多分组仍走 'group'（分组级菜单），两者作用面不同，不要合并。
  const terminalType = ['main', 'filter', 'shell', 'chart', 'group', 'tab'].includes(payload.terminalType)
    ? payload.terminalType
    : 'main';
  const canSplitTab = Boolean(payload.canSplit);
  const labels = payload.labels || {};

  const sendAction = (action) => {
    event.sender.send('terminal-context-menu-action', {
      action,
      tabId: terminalContextMenuState?.tabId || '',
      terminalType,
      paneId: terminalContextMenuState?.paneId || 'pane-1',
      groupId: terminalContextMenuState?.groupId || ''
    });
  };

  // 分组级分屏走单独的一套菜单：动作作用于「分组」而不是某个标签页。
  // 它与下面的组内 pane 分屏（split-horizontal / split-vertical）是两件事，
  // 后者把单个标签移动另一个 pane，前者决定哪些分组并排显示。
  //
  //
  // 'tab' 是单分组专用：此时分组级分屏无对象（candidates < 2），直接给组内 pane 分屏。
  // canSplit 为假（该组 pane 里只有一个标签）时置灰而不是隐藏：移走唯一标签会被
  // reconcileEmptyPanes 立即折叠回一个 pane，用户看到的是「点了没反应」。
  //
  // 三种「新建」项与二级标签行上的按钮**走同一个创建入口**：按钮 click 里调的是
  // createShellTab / createFilterTab / createChartTab，这里只是把它发出去，
  // 由渲染侧同一个 handleTerminalContextMenuAction 转发，避免两条创建路径。
  const paneNewTabItems = (labels_, send) => [
    {
      label: labels_.newShellTab || 'New Shell Tab',
      ...menuIcon('terminal'),
      click: () => send('new-shell-tab')
    },
    {
      label: labels_.newFilterTab || 'New Filter Tab',
      ...menuIcon('filter_alt'),
      click: () => send('new-filter-tab')
    },
    {
      label: labels_.newChartTab || 'New Chart Tab',
      ...menuIcon('show_chart'),
      click: () => send('new-chart-tab')
    }
  ];
  const template = terminalType === 'tab' ? [
    ...paneNewTabItems(labels, sendAction),
    { type: 'separator' },
    {
      label: labels.splitHorizontal || 'Move Tab to Right Split',
      ...menuIcon('vertical_split'),
      enabled: canSplitTab,
      click: () => sendAction('split-horizontal')
    },
    {
      label: labels.splitVertical || 'Move Tab to Bottom Split',
      ...menuIcon('horizontal_split'),
      enabled: canSplitTab,
      click: () => sendAction('split-vertical')
    },
    {
      label: labels.closeSplit || 'Close Split',
      ...menuIcon('close_fullscreen'),
      enabled: Boolean(payload.splitEnabled),
      click: () => sendAction('close-split')
    },
    { type: 'separator' },
    {
      // Shell 独立成列的**唯一显式入口**：拖拽只能把它停到某列列首行，
      // 想让它自占一列（用户原话「右键 shell 标签建立第三个分屏」）必须走这里。
      // 已经在独立列里时换成反向项，否则用户点进去就出不来了。
      label: payload.shellOwnColumn
        ? (labels.joinGroupColumn || 'Move into Group Column')
        : (labels.detachToOwnColumn || 'Detach to Own Column'),
      ...menuIcon('vertical_split'),
      enabled: Boolean(payload.canDetach),
      click: () => sendAction(payload.shellOwnColumn ? 'join-group-column' : 'detach-to-own-column')
    }
  ] : terminalType === 'group' ? [
    {
      label: labels.groupSplitHorizontal || 'Split Groups Left/Right',
      ...menuIcon('vertical_split'),
      enabled: isMultiGroup,
      click: () => sendAction('split-group-horizontal')
    },
    {
      label: labels.groupSplitVertical || 'Split Groups Top/Bottom',
      ...menuIcon('horizontal_split'),
      enabled: isMultiGroup,
      click: () => sendAction('split-group-vertical')
    },
    {
      label: labels.groupSplitClose || 'Close Group Split',
      ...menuIcon('close_fullscreen'),
      enabled: Boolean(payload.groupSplitEnabled),
      click: () => sendAction('close-group-split')
    },
    { type: 'separator' },
    ...paneNewTabItems(labels, sendAction),
    { type: 'separator' },
    {
      label: labels.addSerialPort || 'Add Serial Port',
      ...menuIcon('add'),
      click: () => sendAction('add-serial-group')
    }
  ] : terminalType === 'chart' ? [
    {
      label: payload.paused ? (labels.chartResume || 'Resume') : (labels.chartPause || 'Pause'),
      ...menuIcon(payload.paused ? 'play_arrow' : 'pause'),
      click: () => sendAction('toggle-chart-paused')
    },
    {
      label: labels.chartLive || 'Return to Live',
      ...menuIcon('restart_alt'),
      enabled: Boolean(payload.canReturnToLive),
      click: () => sendAction('chart-return-live')
    },
    {
      label: labels.chartClear || 'Clear Chart',
      ...menuIcon('delete_sweep'),
      click: () => sendAction('clear-chart')
    },
    { type: 'separator' },
    {
      label: labels.chartExportWindow || 'Export Current Window CSV',
      ...menuIcon('save'),
      enabled: Boolean(payload.canExportWindow),
      click: () => sendAction('export-chart-window')
    },
    {
      label: labels.chartExportAll || 'Export All Raw Data CSV',
      ...menuIcon('save'),
      enabled: Boolean(payload.canExportAll),
      click: () => sendAction('export-chart-all')
    },
    { type: 'separator' },
    {
      label: labels.chartSettings || 'Chart Settings',
      ...menuIcon('settings'),
      click: () => sendAction('chart-settings')
    },
    {
      label: labels.moveToOtherPane || 'Move to Other Pane',
      ...menuIcon('swap_horiz'),
      enabled: Boolean(payload.tabId),
      click: () => sendAction('move-to-other-pane')
    },
    {
      label: labels.chartClose || 'Close Chart Tab',
      ...menuIcon('close'),
      click: () => sendAction('close-chart-tab')
    }
  ] : [
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
  } else if (terminalType === 'shell') {
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
        label: labels.toggleShellTextMode || 'Text Mode (select text)',
        ...menuIcon('text_select_move_forward'),
        type: 'checkbox',
        checked: Boolean(payload.shellTextMode),
        click: () => sendAction('toggle-shell-text-mode')
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

  // 「重命名」对所有标签类型都可用：分组标签改分组名，其余标签改自己的标题。
  // 放在模板末尾统一追加，避免四套分支各写一份而语义漂移。
  template.push(
    { type: 'separator' },
    {
      label: labels.renameTabMenu || labels.renameTab || 'Rename…',
      ...menuIcon('playlist_add'),
      click: () => sendAction('rename-tab')
    }
  );

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
  if (updateFeedFallbackActive || updateDownloadFallbackActive) return;
  sendUpdateStatusToPrefs('checking');
});

function handleVerifiedUpdateAvailable(info) {
  info = withUpdateChannel(info);
  updatePromptState.latestInfo = info;
  updateMainWindowTitle();
  sendUpdateStatusToPrefs('available', info);

  if (updatePromptState.checkSource === 'scheduled') {
    if (shouldShowAutomaticUpdatePrompt(info)) {
      showScheduledUpdateToast(info);
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
}

function handleVerifiedUpdateNotAvailable(info) {
  info = withUpdateChannel(info);
  sendUpdateStatusToPrefs('not-available', info);
  updatePromptState.latestInfo = null;
  updatePromptState.phase = 'idle';
  updatePromptState.checkSource = null;
  updateMainWindowTitle();
}

autoUpdater.on('update-available', (info) => {
  if (updateFeedFallbackActive || updateDownloadFallbackActive) return;
  handleVerifiedUpdateAvailable(info);
});

autoUpdater.on('update-not-available', (info) => {
  if (updateFeedFallbackActive || updateDownloadFallbackActive) return;
  handleVerifiedUpdateNotAvailable(info);
});

autoUpdater.on('error', (err) => {
  if (updateFeedFallbackActive || updateDownloadFallbackActive) return;
  sendUpdateStatusToPrefs('error', err.message);
  sendUpdateDownloadStatus('error', err.message);
  updatePromptState.phase = updatePromptState.latestInfo ? 'available' : 'idle';
  updatePromptState.checkSource = null;
});

autoUpdater.on('download-progress', (progressObj) => {
  progressObj = { ...progressObj, updateChannel: updatePromptState.latestInfo?.updateChannel || '' };
  updatePromptState.latestProgress = progressObj;
  sendUpdateStatusToPrefs('download-progress', progressObj);
  sendUpdateDownloadStatus('progress', progressObj);
});

autoUpdater.on('update-downloaded', (info) => {
  info = withUpdateChannel(info);
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

ipcMain.on('shell-tab-binary-input', (event, payload = {}) => {
  const tabId = typeof payload.tabId === 'string' ? payload.tabId : '';
  const bytes = Array.isArray(payload.bytes) ? payload.bytes : [];
  const session = shellSessions.get(tabId);
  if (!session || !bytes.length || bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) return;
  session.ptyProcess.write(Buffer.from(bytes));
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
// 多串口：每一条串口连接是一个独立会话，按 groupId 隔离。
// 单串口模式（renderer 不传 groupId）统一使用 DEFAULT_SERIAL_GROUP_ID（已在文件前部声明）。
const serialSessions = new Map();
// 同一个物理端口同一时刻只允许一个分组占用。驱动通常会拒绝重复打开，
// 但那不是应用保证（部分虚拟串口/复合设备允许共享打开），因此在应用层显式拦住。
const serialPortClaims = new SerialPortClaimTable();
const THROUGHPUT_SAMPLE_MS = 1000;
const THROUGHPUT_HISTORY_LENGTH = 30;
let throughputTimer = null;

function normalizeSerialGroupId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return id || DEFAULT_SERIAL_GROUP_ID;
}

function createSerialSession(groupId, portPath) {
  return {
    groupId,
    portPath: typeof portPath === 'string' ? portPath : '',
    port: null,
    sessionId: 0,
    sendEncoding: 'utf8',
    newlineMode: 'crlf',
    cleanupComplete: true,
    connectInProgress: false,
    claimToken: null,
    cancelConnect: false,
    // 输出队列按 sessionId 分桶：不同会话的字节永远不会合进同一条 IPC 消息。
    outputBuckets: new Map(),
    outputFlushScheduled: false,
    throughput: {
      connected: false,
      rxCurrentBytes: 0,
      txCurrentBytes: 0,
      rxHistory: createEmptyThroughputHistory(),
      txHistory: createEmptyThroughputHistory()
    }
  };
}

function getSerialSession(groupId) {
  return serialSessions.get(normalizeSerialGroupId(groupId)) || null;
}

function getOrCreateSerialSession(groupId, portPath) {
  const id = normalizeSerialGroupId(groupId);
  let session = serialSessions.get(id);
  if (!session) {
    session = createSerialSession(id, portPath);
    serialSessions.set(id, session);
  } else if (typeof portPath === 'string' && portPath) {
    session.portPath = portPath;
  }
  return session;
}


function createEmptyThroughputHistory() {
  return Array(THROUGHPUT_HISTORY_LENGTH).fill(0);
}

function sendThroughputUpdate(session = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!session) return;
  mainWindow.webContents.send('serial-throughput-update', {
    groupId: session.groupId,
    connected: session.throughput.connected,
    rxHistory: [...session.throughput.rxHistory],
    txHistory: [...session.throughput.txHistory],
    rxBytesPerSecond: session.throughput.rxCurrentBytes,
    txBytesPerSecond: session.throughput.txCurrentBytes
  });
}

function resetThroughputState(session, connected = false) {
  if (!session) return;
  session.throughput.connected = connected;
  session.throughput.rxCurrentBytes = 0;
  session.throughput.txCurrentBytes = 0;
  session.throughput.rxHistory = createEmptyThroughputHistory();
  session.throughput.txHistory = createEmptyThroughputHistory();
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
    for (const session of serialSessions.values()) {
      session.throughput.rxHistory.push(session.throughput.rxCurrentBytes);
      session.throughput.txHistory.push(session.throughput.txCurrentBytes);
      if (session.throughput.rxHistory.length > THROUGHPUT_HISTORY_LENGTH) {
        session.throughput.rxHistory.shift();
      }
      if (session.throughput.txHistory.length > THROUGHPUT_HISTORY_LENGTH) {
        session.throughput.txHistory.shift();
      }
      sendThroughputUpdate(session);
      session.throughput.rxCurrentBytes = 0;
      session.throughput.txCurrentBytes = 0;
    }
  }, THROUGHPUT_SAMPLE_MS);
}

function initializeThroughputState(session) {
  resetThroughputState(session, true);
  sendThroughputUpdate(session);
  startThroughputSampling();
}

function notifySerialDisconnected(message = null, groupId = DEFAULT_SERIAL_GROUP_ID) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('serial-disconnected', message, { groupId, sessionId: getSerialSession(groupId)?.connectionSessionId, requestId: getSerialSession(groupId)?.rendererRequestId });
  }
}

// 每个会话、每个 sessionId 一个桶。不同串口的字节永远不会进入同一条 IPC 消息，
// 从根上消除“整批贴上 queued[0].sessionId”导致的串流。
function flushSerialOutputQueue() {
  for (const session of serialSessions.values()) {
    session.outputFlushScheduled = false;
    const buckets = session.outputBuckets;
    if (!buckets.size) continue;
    session.outputBuckets = new Map();
    if (!mainWindow || mainWindow.isDestroyed()) continue;
    for (const [bucketSessionId, entries] of buckets.entries()) {
      if (!entries.length) continue;
      const receivedAt = entries[0].receivedAt;
      const byteCount = entries.reduce((total, entry) => total + entry.data.length, 0);
      const bytes = Buffer.concat(entries.map(entry => entry.data), byteCount);
      mainWindow.webContents.send('serial-output-bytes', {
        bytes: new Uint8Array(bytes),
        sessionId: bucketSessionId,
        groupId: session.groupId,
        receivedAt
      });
    }
  }
}

function queueSerialOutput(session, data, sessionId) {
  if (!session) return;
  let entries = session.outputBuckets.get(sessionId);
  if (!entries) {
    entries = [];
    session.outputBuckets.set(sessionId, entries);
  }
  entries.push({ data: Buffer.from(data), receivedAt: Date.now() });
  if (!session.outputFlushScheduled) {
    session.outputFlushScheduled = true;
    setImmediate(flushSerialOutputQueue);
  }
}

function cleanupSerialConnection(message = null, port = null, groupId = DEFAULT_SERIAL_GROUP_ID) {
  const session = getSerialSession(groupId);
  if (!session) {
    // 没有该分组的会话时，保持旧行为：仍通知一次断开，避免 UI 卡在已连接状态。
    notifySerialDisconnected(message || 'Serial port disconnected', groupId);
    return;
  }
  // 只丢弃不属于本分组、或不属于当前连接的事件；其他分组的事件不得被误判为幽灵事件。
  if (port && port !== session.port) return;
  if (session.cleanupComplete) return;
  session.cleanupComplete = true;
  session.sessionId++;
  serialPortClaims.releasePort(session.groupId, session.portPath, session.claimToken);
  session.claimToken = null;
  resetThroughputState(session, false);
  sendThroughputUpdate(session);
  flushRawBinaryLogSync(session.groupId);
  const disconnectMsg = message || 'Serial port disconnected';
  session.port = null;
  if (currentConfig.saveAllTabsLogToFiles) {
    saveAllTabLogs({ groupId: session.groupId, notify: false });
  } else {
    closeMainLogSession({ groupId: session.groupId, notify: false });
  }
  resetEmptyLogPaths({ groupId: session.groupId });
  notifySerialDisconnected(disconnectMsg, session.groupId);
}

function writeSerialPayload(request) {
  const groupId = normalizeSerialGroupId(request?.groupId);
  const session = getSerialSession(groupId);
  if (!session || !session.port || !session.port.isOpen) {
    return Promise.resolve({ ok: false, code: 'SERIAL_NOT_OPEN', message: 'Serial port is not open' });
  }
  if (request?.sessionId !== undefined && request.sessionId !== session.sessionId) {
    return Promise.resolve({ ok: false, code: 'STALE_SERIAL_SESSION', message: 'Serial connection has changed' });
  }

  const built = buildSerialWriteBuffer(request, {
    defaultEncoding: session.sendEncoding,
    defaultNewlineMode: session.newlineMode
  });
  if (!built.ok) return Promise.resolve(built);

  const port = session.port;
  const sessionId = session.sessionId;
  return new Promise(resolve => {
    try {
      port.write(built.bytes, error => {
        if (error) {
          resolve({ ok: false, code: 'SERIAL_WRITE_FAILED', message: error.message });
          return;
        }
        if (session.port !== port || session.sessionId !== sessionId || session.cleanupComplete) {
          resolve({ ok: false, code: 'STALE_SERIAL_SESSION', message: 'Serial connection has changed' });
          return;
        }
        session.throughput.txCurrentBytes += built.bytes.length;
        resolve({ ok: true, bytesWritten: built.bytes.length, sessionId });
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
  const { path, baudRate, dataBits, stopBits, parity, encoding, sendEncoding, newlineMode } = options;
  const groupId = normalizeSerialGroupId(options.groupId);
  const session = getOrCreateSerialSession(groupId);
  if (session.connectInProgress) throw new Error('A serial connection attempt is already in progress');
  // 端口占用必须**在**动本分组旧连接之前判：否则把 g-1 从 COM6 换到已被 g-2
  // 占用的 COM7 时，会先把 g-1 的 COM6 断开，才发现不能连，白白丢了一条好连接。
  const claim = serialPortClaims.claim(groupId, path, { retainExisting: true });
  if (!claim.ok) {
    if (claim.reason === 'port-in-use') {
      // 用固定 token 回传，让渲染层能翻译成本地化的友好提示；
      // 同时保留人能看懂的英文句子，方便日志排查。
      throw new Error(`SERIAL_PORT_IN_USE|${normalizePortKey(path)}|${claim.ownerGroupId}|Port ${normalizePortKey(path)} is already opened by serial group \`${claim.ownerGroupId}\``);
    }
    throw new Error('No serial port selected');
  }
  session.connectInProgress = true;
  session.cancelConnect = false;
  try {
    // 只影响本分组：其他分组已打开的端口不会被关闭。
    if (session.port && session.port.isOpen) {
      const oldPort = session.port;
      await new Promise((resolve, reject) => oldPort.close(error => error ? reject(error) : resolve()));
      cleanupSerialConnection(null, oldPort, groupId);
    } else if (session.port && !session.cleanupComplete) {
      throw new Error('A serial port is still opening');
    }
    if (session.cancelConnect) throw new Error('Serial connection cancelled');
    const rawOk = flushRawBinaryLogSync(groupId);
    const textOk = currentConfig.saveAllTabsLogToFiles
      ? saveAllTabLogs({ groupId, notify: false })
      : closeMainLogSession({ groupId, notify: false });
    if (!rawOk || !textOk) throw new Error('Failed to flush pending serial logs');
    resetEmptyLogPaths({ groupId });

    session.sendEncoding = oneOf(sendEncoding || encoding, SERIAL_ENCODINGS, 'utf8');
    session.newlineMode = newlineMode || 'crlf';
    session.cleanupComplete = false;
    session.sessionId++;
    const connectionSessionId = session.sessionId;
    session.connectionSessionId = connectionSessionId;
    session.rendererRequestId = options.requestId;
    session.outputBuckets = new Map();
    session.claimToken = claim.token;

    return await new Promise((resolve, reject) => {
    const port = new SerialPort({
        path,
        baudRate: parseInt(baudRate),
        dataBits: parseInt(dataBits || 8),
        stopBits: parseFloat(stopBits || 1),
        parity: parity || 'none',
        autoOpen: false
    });
    session.port = port;
    session.portPath = path || session.portPath;

    port.open((err) => {
        if (err) {
            serialPortClaims.releasePort(groupId, path, claim.token);
            cleanupSerialConnection(null, port, groupId);
            reject(err.message);
            return;
        }
        if (session.cancelConnect || session.port !== port || session.sessionId !== connectionSessionId) {
          port.close(error => {
            if (error) { reject(error); return; }
            cleanupSerialConnection(null, port, groupId);
            reject(new Error('Serial connection cancelled'));
          });
          return;
        }
        writeLog(`\r\n[SERIAL CONNECTED] ${path} ${baudRate} ${dataBits}N${stopBits}\r\n`, groupId);
        initializeThroughputState(session);
        resolve({ ok: true, sessionId: connectionSessionId, groupId });
    });

        port.on('data', (data) => {
      if (session.port !== port || session.cleanupComplete || session.sessionId !== connectionSessionId) return;
      session.throughput.rxCurrentBytes += data.length;
      bufferRawSerialBytes(data, groupId);
          queueSerialOutput(session, data, connectionSessionId);
    });

    port.on('error', (err) => {
      if (session.port !== port || session.cleanupComplete) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-error', err.message, { groupId, sessionId: connectionSessionId });
      }
      writeLog(`\n[SERIAL ERROR] ${err.message}\n`, groupId);
    });

    port.on('close', () => {
      if (session.port !== port || session.cleanupComplete) return;
      writeLog('\r\n[SERIAL DISCONNECTED]\r\n', groupId);
      cleanupSerialConnection('Serial port disconnected', port, groupId);
    });
    });
  } catch (error) {
    serialPortClaims.releasePort(groupId, path, claim.token);
    if (session.port?.isOpen && normalizePortKey(session.portPath) === claim.portKey) {
      session.claimToken = serialPortClaims.claim(groupId, session.portPath, { retainExisting: true }).token;
    }
    if (session.claimToken === claim.token && !session.port?.isOpen) {
      cleanupSerialConnection(null, session.port, groupId);
    }
    throw error;
  } finally {
    session.connectInProgress = false;
  }
});

ipcMain.handle('serial-write', (event, request) => writeSerialPayload(request));

ipcMain.on('disconnect-serial', (event, payload = {}) => {
  const groupId = normalizeSerialGroupId(payload?.groupId);
  const session = getSerialSession(groupId);
  if (!session) {
    serialPortClaims.releaseGroup(groupId);
    return;
  }
  if (session.connectInProgress) session.cancelConnect = true;
  session.sessionId++;
  if (session.port && session.port.isOpen) {
    session.port.close();
  } else if (!session.connectInProgress) {
    cleanupSerialConnection(null, null, groupId);
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

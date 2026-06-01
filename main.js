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
// Store recent serial output
let serialHistoryBuffer = '';
// MAX_HISTORY_LENGTH is now in config (historyBufferSize)

const configPath = path.join(app.getPath('userData'), 'config.json');

// Runtime Display Settings (Initialized from config later)
let displaySettings = {
    showTimestamp: false,
    showLineNumbers: false
};

function loadConfig() {
  const defaults = {
    fontSize: 14,
    fontFamily: 'Consolas',
    fontFamilyZh: '"Microsoft YaHei"',
    foreground: '#cccccc',
    background: '#000000',
    timestampColor: '#00ff00',
    lineNoColor: '#ffff00',
    logEnabled: false,
    saveAllTabsLogToFiles: false,
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
      sendOnEnter: true,
      appendCrLf: false
    },
    skippedUpdateVersion: '',
    lastSerialOptions: {
        path: '',
        baudRate: '9600',
        dataBits: '8',
        stopBits: '1',
        parity: 'none',
        encoding: 'utf8',
        newlineMode: 'crlf'
    }
  };

  if (fs.existsSync(configPath)) {
    try {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return { ...defaults, ...saved };
    } catch (e) {
      console.error('Failed to load config:', e);
    }
  }
  return defaults;
}

let currentConfig = loadConfig();
let terminalContextMenuState = null;
const shellSessions = new Map();

// Initialize display settings from config
displaySettings.showTimestamp = currentConfig.showTimestamp;
displaySettings.showLineNumbers = currentConfig.showLineNumbers;

let logBuffer = [];
let tabLogBuffers = new Map();

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

function saveBufferToFile(data, extra = {}) {
  ensureLogDirectory();
  const fileName = buildLogFileName(extra);
  const fullPath = path.join(currentConfig.logPath, fileName);
  const buffer = iconv.encode(data, currentConfig.logEncoding);
  fs.writeFileSync(fullPath, buffer);
  return fullPath;
}

function saveLog() {
  if (logBuffer.length === 0) return;
  if (currentConfig.saveAllTabsLogToFiles) {
    logBuffer = [];
    return;
  }
  
  // Even if logEnabled is currently false, if we have data, we should probably save it
  // as it was collected when logging was enabled.
  
  try {
      const allData = logBuffer.join('');
      const fullPath = saveBufferToFile(allData);
      console.log('Log saved to:', fullPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-saved', { path: fullPath });
      }
  } catch (err) {
      console.error('Failed to save log:', err);
  }
  
  logBuffer = [];
}

function saveAllTabLogs() {
  if (!currentConfig.saveAllTabsLogToFiles || tabLogBuffers.size === 0) {
    return;
  }

  const savedPaths = [];
  for (const [tabId, entry] of tabLogBuffers.entries()) {
    if (!entry || !Array.isArray(entry.buffer) || entry.buffer.length === 0) continue;
    try {
      const fullPath = saveBufferToFile(entry.buffer.join(''), { tabTitle: entry.title || tabId });
      savedPaths.push(fullPath);
    } catch (err) {
      console.error(`Failed to save tab log for ${tabId}:`, err);
    }
  }

  tabLogBuffers.clear();

  if (savedPaths.length && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('all-tabs-log-saved', { paths: savedPaths });
  }
}

function writeLog(data) {
  if (currentConfig.logEnabled) {
    logBuffer.push(data);
  }
}

function writeTabLog(tabId, title, data) {
  if (!currentConfig.saveAllTabsLogToFiles || !tabId || !data) {
    return;
  }
  const existing = tabLogBuffers.get(tabId) || { title: '', buffer: [] };
  existing.title = title || existing.title || tabId;
  existing.buffer.push(data);
  tabLogBuffers.set(tabId, existing);
}

function saveConfig(config) {
  currentConfig = { ...currentConfig, ...config };
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
  Array.from(shellSessions.keys()).forEach(tabId => closeShellSession(tabId));
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

ipcMain.handle('get-history', () => {
  return serialHistoryBuffer;
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
  saveConfig(config);
  if (mainWindow) {
    mainWindow.webContents.send('config-updated', currentConfig);
  }
});

ipcMain.on('write-tab-log', (event, payload = {}) => {
  writeTabLog(payload.tabId, payload.title, payload.data);
});

ipcMain.on('flush-tab-logs', () => {
  saveAllTabLogs();
});

ipcMain.on('flush-tab-log', (event, payload = {}) => {
  if (!currentConfig.saveAllTabsLogToFiles || !payload.tabId) {
    return;
  }
  const entry = tabLogBuffers.get(payload.tabId);
  if (!entry || !Array.isArray(entry.buffer) || entry.buffer.length === 0) {
    return;
  }
  try {
    const fullPath = saveBufferToFile(entry.buffer.join(''), { tabTitle: entry.title || payload.tabId });
    tabLogBuffers.delete(payload.tabId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('log-saved', { path: fullPath });
    }
  } catch (err) {
    console.error(`Failed to flush tab log for ${payload.tabId}:`, err);
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
let serialEncoding = 'utf8';
let serialNewlineMode = 'crlf'; // 'crlf', 'lf', 'cr' (applies to receive: LF->CRLF if crlf, etc. AND send logic)
let serialDecoderStream = null;
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

function cleanupSerialConnection(message = null) {
  stopThroughputSampling();
  resetThroughputState(false);
  sendThroughputUpdate();

  if (serialDecoderStream) {
    try {
      serialDecoderStream.end();
    } catch (e) {
      console.error('Failed to close decoder stream:', e);
    }
    serialDecoderStream = null;
  }

  currentSerialPort = null;
  if (!currentConfig.saveAllTabsLogToFiles) {
    saveLog();
  }
  notifySerialDisconnected(message);
}

function handleSerialData(str) {
    // Newline Mode (Receive):
    // If mode is CRLF or Auto, usually we want to ensure newlines render correctly in xterm.
    // xterm expects \r\n for a new line.
    // If we receive just \n and mode is CRLF, we might want to map \n -> \r\n.
    if (serialNewlineMode === 'crlf') {
        str = str.replace(/\r?\n/g, '\r\n');
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('serial-output', str);
    }
    
    // Update history buffer
    serialHistoryBuffer += str;
    const maxLen = currentConfig.historyBufferSize || 5000000;
    if (serialHistoryBuffer.length > maxLen) {
        serialHistoryBuffer = serialHistoryBuffer.slice(serialHistoryBuffer.length - maxLen);
    }

    writeLog(str);
}

ipcMain.handle('list-ports', async () => {
  return await SerialPort.list();
});

ipcMain.handle('connect-serial', async (event, { path, baudRate, dataBits, stopBits, parity, encoding, newlineMode }) => {
  if (currentSerialPort && currentSerialPort.isOpen) {
    await new Promise(resolve => currentSerialPort.close(resolve));
    cleanupSerialConnection();
  }

  serialEncoding = encoding || 'utf8';
  serialNewlineMode = newlineMode || 'crlf';
  serialDecoderStream = null;

  return new Promise((resolve, reject) => {
    currentSerialPort = new SerialPort({
        path,
        baudRate: parseInt(baudRate),
        dataBits: parseInt(dataBits || 8),
        stopBits: parseFloat(stopBits || 1),
        parity: parity || 'none',
        autoOpen: false
    });

    if (serialEncoding !== 'hex') {
        serialDecoderStream = iconv.decodeStream(serialEncoding);
        serialDecoderStream.on('data', handleSerialData);
        serialDecoderStream.on('error', (err) => {
             console.error('Decoder stream error:', err);
        });
    }

    currentSerialPort.open((err) => {
        if (err) {
            cleanupSerialConnection();
            reject(err.message);
            return;
        }
        writeLog(`\r\n[SERIAL CONNECTED] ${path} ${baudRate} ${dataBits}N${stopBits}\r\n`);
        initializeThroughputState();
        resolve(true);
    });

    currentSerialPort.on('data', (data) => {
      throughputState.rxCurrentBytes += data.length;
      if (serialEncoding === 'hex') {
          let str = data.toString('hex').match(/.{1,2}/g).join(' ') + ' ';
          handleSerialData(str);
      } else if (serialDecoderStream) {
          serialDecoderStream.write(data);
      } else {
          handleSerialData(data.toString());
      }
    });

    currentSerialPort.on('error', (err) => {
      mainWindow.webContents.send('serial-error', err.message);
      writeLog(`\n[SERIAL ERROR] ${err.message}\n`);
    });

    currentSerialPort.on('close', () => {
      writeLog('\r\n[SERIAL DISCONNECTED]\r\n');
      saveLog();
      cleanupSerialConnection('Serial port disconnected');
    });
  });
});

ipcMain.on('serial-input', (event, data) => {
  if (currentSerialPort && currentSerialPort.isOpen) {
    let buffer;
    
    // Newline Mode (Send):
    // xterm sends \r when Enter is pressed.
    // We should map \r to the desired sequence.
    let str = data;
    if (str === '\r') {
        if (serialNewlineMode === 'crlf') str = '\r\n';
        else if (serialNewlineMode === 'lf') str = '\n';
        // if 'cr', leave as \r
    }

    if (serialEncoding === 'hex') {
        // In hex mode, we might expect user to type hex?
        // Or we just send ASCII as is?
        // Usually Hex view is read-only or specific input.
        // For now, let's just send ASCII if they type in terminal,
        // or we could try to interpret hex string if we had a separate input box.
        // Assuming terminal input is just chars.
        buffer = Buffer.from(str, 'utf8');
    } else {
        buffer = iconv.encode(str, serialEncoding);
    }

    throughputState.txCurrentBytes += buffer.length;
    currentSerialPort.write(buffer);
    writeLog(str);
  }
});

ipcMain.on('disconnect-serial', () => {
  if (currentSerialPort && currentSerialPort.isOpen) {
    currentSerialPort.close();
  } else {
    cleanupSerialConnection();
  }
});

ipcMain.on('renderer-log', (event, msg) => {
    console.log('[RENDERER]', msg);
});

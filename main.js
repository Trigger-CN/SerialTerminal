const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');
const { SerialPort } = require('serialport');
const iconv = require('iconv-lite');

let mainWindow;
let prefsWindow;
const filterWindows = new Set();
// Store recent serial output to populate new filter windows
let serialHistoryBuffer = '';
const MAX_HISTORY_LENGTH = 100000; // Keep last 100KB characters

const configPath = path.join(app.getPath('userData'), 'config.json');

// Runtime Display Settings (Initialized from config later)
let displaySettings = {
    showTimestamp: false,
    showLineNumbers: false
};

function loadConfig() {
  const defaults = {
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    foreground: '#cccccc',
    background: '#000000',
    timestampColor: '#00ff00',
    lineNoColor: '#ffff00',
    logEnabled: false,
    logPath: path.join(app.getPath('documents'), 'SerialTerminalLogs'),
    logFileNameFormat: 'log_%Y-%m-%d_%H-%M-%S.txt',
    logEncoding: 'utf8',
    highlightRules: [],
    showTimestamp: false,
    showLineNumbers: false,
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

// Initialize display settings from config
displaySettings.showTimestamp = currentConfig.showTimestamp;
displaySettings.showLineNumbers = currentConfig.showLineNumbers;

let logBuffer = [];

function formatFileName(format) {
  const now = new Date();
  return format
    .replace('%Y', now.getFullYear())
    .replace('%m', String(now.getMonth() + 1).padStart(2, '0'))
    .replace('%d', String(now.getDate()).padStart(2, '0'))
    .replace('%H', String(now.getHours()).padStart(2, '0'))
    .replace('%M', String(now.getMinutes()).padStart(2, '0'))
    .replace('%S', String(now.getSeconds()).padStart(2, '0'));
}

function saveLog() {
  if (logBuffer.length === 0) return;
  
  // Even if logEnabled is currently false, if we have data, we should probably save it
  // as it was collected when logging was enabled.
  
  if (!fs.existsSync(currentConfig.logPath)) {
    try {
        fs.mkdirSync(currentConfig.logPath, { recursive: true });
    } catch (e) {
        console.error('Failed to create log dir:', e);
        return;
    }
  }

  const fileName = formatFileName(currentConfig.logFileNameFormat);
  const fullPath = path.join(currentConfig.logPath, fileName);
  
  try {
      const allData = logBuffer.join('');
      const buffer = iconv.encode(allData, currentConfig.logEncoding);
      fs.writeFileSync(fullPath, buffer);
      console.log('Log saved to:', fullPath);
  } catch (err) {
      console.error('Failed to save log:', err);
  }
  
  logBuffer = [];
}

function writeLog(data) {
  if (currentConfig.logEnabled) {
    logBuffer.push(data);
  }
}

function saveConfig(config) {
  currentConfig = { ...currentConfig, ...config };
  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true, // Hide the menu bar
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

function createPrefsWindow() {
  if (prefsWindow) {
    prefsWindow.focus();
    return;
  }

  prefsWindow = new BrowserWindow({
    width: 700,
    height: 500,
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

function createFilterWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('filter.html');
  filterWindows.add(win);

  // Send history to new window once it's ready
  win.webContents.once('did-finish-load', () => {
      win.webContents.send('update-display-settings', displaySettings);
      if (serialHistoryBuffer) {
          win.webContents.send('serial-output', serialHistoryBuffer);
      }
  });

  win.on('closed', () => {
    filterWindows.delete(win);
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-about-info', () => {
  const pkg = require('./package.json');
  return {
    version: app.getVersion(),
    author: pkg.author || 'Your Name',
    github: pkg.homepage || (pkg.repository ? (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url) : 'https://github.com/your/repo')
  };
});

app.on('before-quit', () => {
  saveLog();
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

ipcMain.handle('get-config', () => {
  return currentConfig;
});

ipcMain.on('open-prefs', () => {
  createPrefsWindow();
});

ipcMain.on('create-filter-window', () => {
  createFilterWindow();
});

ipcMain.on('update-display-settings', (event, settings) => {
    displaySettings = { ...displaySettings, ...settings };
    
    // Save to config
    currentConfig = { ...currentConfig, ...settings };
    saveConfig(currentConfig);

    // Broadcast to all filter windows
    for (const win of filterWindows) {
        if (!win.isDestroyed()) {
            win.webContents.send('update-display-settings', displaySettings);
        }
    }
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
  
  for (const win of filterWindows) {
      if (!win.isDestroyed()) {
          win.webContents.send('config-updated', currentConfig);
          win.webContents.send('update-display-settings', displaySettings);
      }
  }
});

ipcMain.on('open-config-folder', () => {
    shell.showItemInFolder(configPath);
});

ipcMain.on('save-config', (event, config) => {
  saveConfig(config);
  if (mainWindow) {
    mainWindow.webContents.send('config-updated', currentConfig);
  }
  for (const win of filterWindows) {
      if (!win.isDestroyed()) {
          win.webContents.send('config-updated', currentConfig);
      }
  }
});

// PTY Setup
const osShell = process.env[process.platform === 'win32' ? 'COMSPEC' : 'SHELL'];
let ptyProcess = null;

ipcMain.on('terminal-input', (event, data) => {
  if (ptyProcess) {
    ptyProcess.write(data);
    writeLog(data);
  }
});

ipcMain.on('spawn-terminal', (event) => {
  if (ptyProcess) return;

  ptyProcess = pty.spawn(osShell, [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env
  });

  ptyProcess.onData((data) => {
    mainWindow.webContents.send('terminal-output', data);
    writeLog(data);
  });
});

// Serial Port Setup
let currentSerialPort = null;
let serialEncoding = 'utf8';
let serialNewlineMode = 'crlf'; // 'crlf', 'lf', 'cr' (applies to receive: LF->CRLF if crlf, etc. AND send logic)
let serialDecoderStream = null;

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
    
    // Broadcast to filter windows
    let broadcastCount = 0;
    for (const win of filterWindows) {
        if (!win.isDestroyed()) {
            win.webContents.send('serial-output', str);
            broadcastCount++;
        }
    }
    // if (broadcastCount > 0) console.log(`Broadcasted to ${broadcastCount} filter windows`);

    // Update history buffer
    serialHistoryBuffer += str;
    if (serialHistoryBuffer.length > MAX_HISTORY_LENGTH) {
        serialHistoryBuffer = serialHistoryBuffer.slice(serialHistoryBuffer.length - MAX_HISTORY_LENGTH);
    }

    writeLog(str);
}

ipcMain.handle('list-ports', async () => {
  return await SerialPort.list();
});

ipcMain.handle('connect-serial', async (event, { path, baudRate, dataBits, stopBits, parity, encoding, newlineMode }) => {
  if (currentSerialPort && currentSerialPort.isOpen) {
    await new Promise(resolve => currentSerialPort.close(resolve));
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
        // Use streaming decoder to handle split multi-byte characters
        serialDecoderStream = iconv.decodeStream(serialEncoding);
        serialDecoderStream.on('data', handleSerialData);
        serialDecoderStream.on('error', (err) => {
             console.error('Decoder stream error:', err);
             // Fallback or ignore?
        });
    }
    
    currentSerialPort.open((err) => {
        if (err) {
            reject(err.message);
            return;
        }
        writeLog(`\r\n[SERIAL CONNECTED] ${path} ${baudRate} ${dataBits}N${stopBits}\r\n`);
        resolve(true);
    });

    currentSerialPort.on('data', (data) => {
      if (serialEncoding === 'hex') {
          let str = data.toString('hex').match(/.{1,2}/g).join(' ') + ' ';
          handleSerialData(str);
      } else if (serialDecoderStream) {
          serialDecoderStream.write(data);
      } else {
          // Fallback if no stream (shouldn't happen if not hex)
          handleSerialData(data.toString());
      }
    });

    currentSerialPort.on('error', (err) => {
      mainWindow.webContents.send('serial-error', err.message);
      writeLog(`\n[SERIAL ERROR] ${err.message}\n`);
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

    currentSerialPort.write(buffer);
    writeLog(str);
  }
});

ipcMain.on('disconnect-serial', () => {
  if (currentSerialPort && currentSerialPort.isOpen) {
    currentSerialPort.close();
    writeLog('\r\n[SERIAL DISCONNECTED]\r\n');
    
    // Save logs on disconnect
    saveLog();
  }
});

ipcMain.on('renderer-log', (event, msg) => {
    console.log('[RENDERER]', msg);
});

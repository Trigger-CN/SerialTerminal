const { ipcRenderer } = require('electron');
const fs = require('fs');
const { pathToFileURL } = require('url');

window.addEventListener('error', (event) => {
    ipcRenderer.send('renderer-diagnostic-log', {
        source: 'window.error',
        message: event.message || 'Unknown renderer error',
        stack: event.error?.stack || `${event.filename || ''}:${event.lineno || 0}:${event.colno || 0}`
    });
});

window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    ipcRenderer.send('renderer-diagnostic-log', {
        source: 'unhandledrejection',
        message: reason?.message || String(reason || 'Unknown renderer rejection'),
        stack: reason?.stack || ''
    });
});
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const { TerminalUnicodeWidthAddon } = require('./terminal-unicode-width');
const iconv = require('iconv-lite');
const { t, getLanguage } = require('./i18n');
const { createWorkspaceManager, normalizeWorkspaceLayoutShape } = require('./workspace-manager');
const { getHorizontalInsertionIndex } = require('./tab-reorder');
const { parseHexInput, buildSerialWriteBuffer } = require('./serial-codec');
const { HexStreamFormatter } = require('./hex-formatter');
const { serializeTerminalBuffer } = require('./terminal-buffer-text');
const { translateConptyMouseMode } = require('./shell-mouse-compat');
const uPlot = require('uplot');
const { SerialTextStream } = require('./serial-text-stream');
const { ChartParserIpcClient, discoverChartFieldsInWorker } = require('./chart-parser-ipc-client');
const { ChartDataModel } = require('./chart-data-model');
const { ChartView } = require('./chart-view');
const { buildChartCsv } = require('./chart-csv');
const {
    getVerticalInsertionIndex,
    reorderQuickSendItems,
    moveQuickSendGroup,
    moveQuickSendItem,
    deleteQuickSendGroup,
    disableSidebarQuickSend,
    deleteQuickSendById
} = require('./quick-send-reorder');

const createMaterialIcon = (name, className = 'material-icon') => window.MaterialIcons.createIcon(name, className);
const TERMINAL_FONT_FAMILY = (config) => `${config.fontFamily}, ${config.fontFamilyZh}, "Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji", "Courier New", monospace`;

function enableTerminalUnicode11(term) {
    term.loadAddon(new TerminalUnicodeWidthAddon());
}

const SEND_LIMITS = Object.freeze({ main: 1024 * 1024, quick: 1024 * 1024, auto: 64 * 1024, paste: 1024 * 1024, terminal: 1024 * 1024 });
const SUPPORTED_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);

let currentConfig = null;
let currentLanguage = 'en';
let isApplyingConfig = false;
let receiveDisplayMode = 'text';
let receiveEncoding = 'utf8';
let sendEncoding = 'utf8';
let newlineMode = 'crlf';
let textDecoder = null;
let quickTriggerDecoder = null;
let quickTriggerBuffer = '';
let appliedHexSettingsKey = '';
let serialWriteChain = Promise.resolve();
let serialSessionId = 0;
let serialConnectInProgress = false;
let serialReconnectInProgress = false;
let serialDisconnectWaiters = [];
// let currentMode = 'terminal'; // Removed temporarily

// Display Settings
let showTimestamp = false;
let showLineNumbers = false;
let serialLineCounter = 1;
let logIncludeTimestamp = false;
let logIncludeLineNumbers = false;
let logLineCounter = 1;
let serialNewLine = true;
let lastCharWasCR = false;

// Color settings
let timestampColor = '#808080';
let lineNoColor = '#67986f';
let highlightRules = [];
let highlightColors = {
    search: { background: '#f5d90a', foreground: '#000000' },
    filter: { background: '#535353', foreground: '#ffffff' },
    selection: { background: '#073ca8', foreground: '#ffffff' }
};
let mouseWheelScrollLines = 3;

const DEFAULT_WORKSPACE_LAYOUT = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: {
        'pane-1': 0.5,
        'pane-2': 0.5
    },
    panes: [
        { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
        { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
};

let workspaceLayout = cloneWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
let workspaceManager = null;
let lastAppliedWorkspaceLayoutKey = '';
let isRestoringWorkspaceSession = false;
let isDraggingWorkspaceSplitter = false;
let scheduledUpdateToast = null;
let scheduledUpdateToastTimer = null;
let scheduledUpdateToastRemoveTimer = null;

function tr(key, params = {}) {
    return t(currentLanguage, key, params);
}

function trFallback(key, fallback, params = {}) {
    const value = tr(key, params);
    return value === key ? fallback.replace(/\{(\w+)\}/g, (_, name) => params[name] ?? '') : value;
}

function cloneWorkspaceLayout(layout) {
    return JSON.parse(JSON.stringify(layout || DEFAULT_WORKSPACE_LAYOUT));
}

function ensureWorkspaceLayoutShape(layout) {
    return normalizeWorkspaceLayoutShape(layout);
}

function hexToAnsi(hex) {
    if (!hex) return '';
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
}

function hexToAnsiBackground(hex) {
    if (!hex) return '';
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `\x1b[48;2;${r};${g};${b}m`;
}

function getTerminalTheme(config) {
    return {
        background: getTerminalWallpaperPath(config) ? 'rgba(0, 0, 0, 0)' : config.background,
        foreground: config.foreground,
        cursor: config.foreground,
        selectionBackground: config.highlightColors.selection.background,
        selectionForeground: config.highlightColors.selection.foreground
    };
}

function getTerminalWallpaperPath(config) {
    const wallpaperPath = config.terminalWallpaper?.path;
    return typeof wallpaperPath === 'string' && wallpaperPath && fs.existsSync(wallpaperPath) ? wallpaperPath : '';
}

let terminalWallpaperLoadId = 0;

function applyTerminalWallpaper(config) {
    const wallpaperPath = getTerminalWallpaperPath(config);
    const loadId = ++terminalWallpaperLoadId;
    document.documentElement.style.setProperty('--terminal-background-color', config.background || '#000000');
    document.documentElement.style.setProperty('--terminal-wallpaper-image', 'none');
    document.documentElement.style.setProperty('--terminal-wallpaper-overlay', '0');
    if (!wallpaperPath) return;

    const imageUrl = pathToFileURL(wallpaperPath).href;
    const image = new Image();
    image.onload = () => {
        if (loadId !== terminalWallpaperLoadId) return;
        const overlayOpacity = Math.min(100, Math.max(0, Number(config.terminalWallpaper?.overlayOpacity) || 0)) / 100;
        document.documentElement.style.setProperty('--terminal-wallpaper-image', `url("${imageUrl}")`);
        document.documentElement.style.setProperty('--terminal-wallpaper-overlay', String(overlayOpacity));
    };
    image.src = imageUrl;
}

const showTimestampCb = document.getElementById('show-timestamp');
const showLinenoCb = document.getElementById('show-lineno');
const mainSendInput = document.getElementById('main-send-input');
const mainInputHistoryBtn = document.getElementById('main-input-history-btn');
const mainInputHistoryMenu = document.getElementById('main-input-history-menu');
const mainSendBtn = document.getElementById('main-send-btn');
const mainAddQuickSendBtn = document.getElementById('main-add-quick-send-btn');
const mainSendLast = document.getElementById('main-send-last');
const mainActionStatus = document.getElementById('main-action-status');
const mainInputPanel = document.getElementById('main-input-panel');
const mainSendHexCb = document.getElementById('main-send-hex');
const mainSendAppendCrlfCb = document.getElementById('main-send-append-crlf');
const sidebar = document.getElementById('sidebar');
const sidebarExpandBtn = document.getElementById('sidebar-expand-btn');
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
const sidebarConnectBtn = document.getElementById('sidebar-connect-btn');
const sidebarClearBtn = document.getElementById('sidebar-clear-btn');
const sidebarPrefsBtn = document.getElementById('sidebar-prefs-btn');
const sidebarInputBtn = document.getElementById('sidebar-input-btn');
const sidebarShellBtn = document.getElementById('sidebar-shell-btn');
const sidebarThroughputCompact = document.getElementById('sidebar-throughput-compact');
const sidebarThroughputRx = document.getElementById('sidebar-throughput-rx');
const sidebarThroughputTx = document.getElementById('sidebar-throughput-tx');
const mainSendOnEnterCb = document.getElementById('main-send-on-enter');
const mainInputValidation = document.getElementById('main-input-validation');
const receiveModeSelect = document.getElementById('receive-mode-select');
const receiveEncodingSelect = document.getElementById('receive-encoding-select');
const sendEncodingSelect = document.getElementById('send-encoding-select');
const toggleMainInputBtn = document.getElementById('toggle-main-input');
const toggleShellSidebarBtn = document.getElementById('toggle-shell-sidebar');
const shellSidebar = document.getElementById('shell-sidebar');
const shellSidebarCloseBtn = document.getElementById('shell-sidebar-close-btn');
const shellSessionList = document.getElementById('shell-session-list');
const shellProfileBtns = document.getElementById('shell-profile-btns');
const shellManageProfilesBtn = document.getElementById('shell-manage-profiles-btn');
const shellAutoCrlfCb = document.getElementById('shell-auto-crlf');
const shellClearOnRestartCb = document.getElementById('shell-clear-on-restart');
const workspaceRootEl = document.getElementById('workspace-root');
const workspaceSplitterEl = document.getElementById('workspace-splitter');
let suppressMainInputFocus = false;
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
let activeShortcuts = { ...DEFAULT_SHORTCUTS };
let welcomeGuideChecked = false;

function setActionStatus(message) {
    if (mainActionStatus) {
        mainActionStatus.textContent = message || trFallback('main.ready', 'Ready');
    }
}

setActionStatus(trFallback('main.ready', 'Ready'));

showTimestampCb.addEventListener('change', (e) => {
    showTimestamp = e.target.checked;
    ipcRenderer.send('update-display-settings', { showTimestamp });
});

showLinenoCb.addEventListener('change', (e) => {
    showLineNumbers = e.target.checked;
    ipcRenderer.send('update-display-settings', { showLineNumbers });
    if (!showLineNumbers) {
        // Optional: Reset counter when disabled? 
        // Or keep it running? Usually keep it running or reset is fine.
        // Let's not reset, just hide.
    } else {
        // If enabling, maybe we want to start counting or continue?
        // If we are mid-stream, it picks up.
    }
});

function getPrefix() {
    let s = '';
    const reset = '\x1b[0m';
    
    if (showTimestamp) {
        const now = new Date();
        const time = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
        const color = hexToAnsi(timestampColor);
        s += `${color}[${time}]${reset} `;
    }
    if (showLineNumbers) {
        const lineNo = String(serialLineCounter).padStart(4, '0');
        const color = hexToAnsi(lineNoColor);
        s += `${color}[${lineNo}]${reset} `;
        serialLineCounter++;
    }
    return s;
}

function getLogPrefix() {
    let s = '';
    if (logIncludeTimestamp) {
        const now = new Date();
        const time = now.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(now.getMilliseconds()).padStart(3, '0');
        s += `[${time}] `;
    }
    if (logIncludeLineNumbers) {
        s += `[${String(logLineCounter).padStart(4, '0')}] `;
        logLineCounter++;
    }
    return s;
}

function collectGlobalHighlightMatches(text) {
    const matches = [];
    if (highlightRules && highlightRules.length > 0) {
        highlightRules.forEach(rule => {
            if (!rule.enabled || !rule.regex) return;
            try {
                let pattern = rule.regex;
                
                // Determine flags
                // Legacy support for (?i) prefix, overriding caseSensitive if present
                let isCaseSensitive = rule.caseSensitive;
                if (pattern.startsWith('(?i)')) {
                    pattern = pattern.substring(4);
                    isCaseSensitive = false;
                }
                
                const flags = isCaseSensitive ? 'g' : 'gi';
                
                // Handle useRegex flag (if useRegex is false, escape special characters)
                if (rule.useRegex === false) {
                    pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                }
                
                const re = new RegExp(pattern, flags);
                let match;
                while ((match = re.exec(text)) !== null) {
                    // Prevent infinite loop for empty matches
                    if (match[0].length === 0) {
                        re.lastIndex++;
                        continue;
                    }
                    matches.push({
                        start: match.index,
                        end: match.index + match[0].length,
                        color: rule.color,
                        isFilterMatch: false
                    });
                }
            } catch (e) {
                // Ignore invalid regex
            }
        });
    }
    return matches;
}

function applyHighlighting(text, filterRegex = null, globalMatches = null) {
    if (!text) return text;
    const matches = (globalMatches || collectGlobalHighlightMatches(text)).map(match => ({ ...match }));

    // Apply filter regex highlight
    if (filterRegex) {
        try {
            // Ensure regex has 'g' flag for multiple matches in a line
            const flags = filterRegex.flags.includes('g') ? filterRegex.flags : filterRegex.flags + 'g';
            const re = new RegExp(filterRegex.source, flags);
            let match;
            while ((match = re.exec(text)) !== null) {
                // Prevent infinite loop for empty matches
                if (match[0].length === 0) {
                    re.lastIndex++;
                    continue;
                }
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    isFilterMatch: true
                });
            }
        } catch (e) {
            // Ignore invalid regex
        }
    }

    if (matches.length === 0) return text;

    // Sort matches by start index
    matches.sort((a, b) => a.start - b.start);

    // Merge overlapping matches (prioritizing filter match)
    const mergedMatches = [];
    let currentMatch = matches[0];

    for (let i = 1; i < matches.length; i++) {
        const nextMatch = matches[i];
        if (nextMatch.start < currentMatch.end) {
            // Overlap detected
            currentMatch.end = Math.max(currentMatch.end, nextMatch.end);
            // If any of the overlapping matches is a filter match, mark the merged block as filter match
            if (nextMatch.isFilterMatch) {
                currentMatch.isFilterMatch = true;
            } else if (!currentMatch.isFilterMatch && nextMatch.color) {
                // Only overwrite color if current match is not a filter match
                currentMatch.color = nextMatch.color;
            }
        } else {
            mergedMatches.push(currentMatch);
            currentMatch = nextMatch;
        }
    }
    mergedMatches.push(currentMatch);

    let result = '';
    let lastIndex = 0;

    for (const m of mergedMatches) {
        if (m.start < lastIndex) continue; 
        
        result += text.substring(lastIndex, m.start);
        
        // \x1b[48;5;236m is a dark gray background. \x1b[1m is bold.
        if (m.isFilterMatch) {
            result += hexToAnsiBackground(highlightColors.filter.background)
                + hexToAnsi(highlightColors.filter.foreground)
                + '\x1b[1m' + text.substring(m.start, m.end) + '\x1b[0m';
        } else {
            // Normal highlight rule
            result += hexToAnsi(m.color) + text.substring(m.start, m.end) + '\x1b[0m';
        }
        
        lastIndex = m.end;
    }
    
    result += text.substring(lastIndex);
    return result;
}

class SerialDataParser {
    constructor() {
        this.incomingBuffer = '';
        this.isNewLine = true;
    }

    parse(data) {
        if (!data) return [];
        
        this.incomingBuffer += data;
        const parts = this.incomingBuffer.split(/(\r\n|\r|\n)/);
        
        if (parts.length === 1) {
            if (this.incomingBuffer.length > 10000) {
                const lineContent = this.incomingBuffer;
                this.incomingBuffer = '';
                
                const prefix = this.isNewLine ? getPrefix() : '';
                this.isNewLine = false; // Next chunk is continuation
                return [{ text: lineContent, delimiter: '', prefix }];
            }
            return [];
        }
        
        const incompleteLine = parts.pop();
        this.incomingBuffer = incompleteLine;
        
        const lines = [];
        for (let i = 0; i < parts.length; i += 2) {
            const prefix = this.isNewLine ? getPrefix() : '';
            lines.push({
                text: parts[i],
                delimiter: parts[i + 1],
                prefix
            });
            this.isNewLine = true; // After delimiter, next line is new
        }
        return lines;
    }

    flush() {
        if (!this.incomingBuffer) return [];
        const line = {
            text: this.incomingBuffer,
            delimiter: '',
            prefix: this.isNewLine ? getPrefix() : ''
        };
        this.incomingBuffer = '';
        this.isNewLine = false;
        return [line];
    }
}

const dataParser = new SerialDataParser();
let serialOutputQueue = [];
let serialOutputQueuedBytes = 0;
let serialOutputFlushScheduled = false;
let serialOutputFlushTimer = null;
let lastSerialOutputFlushAt = 0;
const SERIAL_OUTPUT_MAX_FPS = 30;
const SERIAL_OUTPUT_FRAME_MS = 1000 / SERIAL_OUTPUT_MAX_FPS;
const SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES = 1024 * 1024;
const TERMINAL_PENDING_OUTPUT_LIMIT = 2 * 1024 * 1024;
const terminalWriteStates = new WeakMap();

function drainTerminalOutput(term, state) {
    if (state.writing || !state.pending.length) return;
    const chunks = state.pending;
    state.pending = [];
    state.pendingLength = 0;
    const skipped = state.skipped;
    state.skipped = false;
    state.writing = true;
    const output = `${skipped ? '\r\n[Display output skipped to limit memory usage]\r\n' : ''}${chunks.join('')}`;
    try {
        term.write(output, () => {
            state.writing = false;
            if (state.resetAfterWrite) {
                state.resetAfterWrite = false;
                term.reset();
            }
            drainTerminalOutput(term, state);
        });
    } catch (error) {
        state.writing = false;
        state.pending = [];
        state.pendingLength = 0;
    }
}

function writeTerminalOutput(term, output) {
    if (!term || !output) return;
    let state = terminalWriteStates.get(term);
    if (!state) {
        state = { writing: false, pending: [], pendingLength: 0, skipped: false, resetAfterWrite: false };
        terminalWriteStates.set(term, state);
    }
    const displayOutput = output.length > TERMINAL_PENDING_OUTPUT_LIMIT
        ? output.slice(-TERMINAL_PENDING_OUTPUT_LIMIT)
        : output;
    if (displayOutput.length !== output.length) state.skipped = true;
    state.pending.push(displayOutput);
    state.pendingLength += displayOutput.length;
    while (state.pendingLength > TERMINAL_PENDING_OUTPUT_LIMIT && state.pending.length > 1) {
        state.pendingLength -= state.pending.shift().length;
        state.skipped = true;
    }
    drainTerminalOutput(term, state);
}

function clearTerminalOutput(term) {
    const state = terminalWriteStates.get(term);
    if (state) {
        state.pending = [];
        state.pendingLength = 0;
        state.skipped = false;
        state.resetAfterWrite = state.writing;
    }
    term.reset();
}

function scheduleSerialOutputFlush() {
    if (serialOutputFlushScheduled) return;
    serialOutputFlushScheduled = true;
    const delay = Math.max(0, SERIAL_OUTPUT_FRAME_MS - (performance.now() - lastSerialOutputFlushAt));
    serialOutputFlushTimer = setTimeout(() => {
        serialOutputFlushTimer = null;
        requestAnimationFrame(flushSerialOutputQueue);
    }, delay);
}

function flushSerialOutputQueue() {
    serialOutputFlushScheduled = false;
    lastSerialOutputFlushAt = performance.now();
    if (!serialOutputQueue.length) return;
    const queued = serialOutputQueue;
    serialOutputQueue = [];
    serialOutputQueuedBytes = 0;
    const bytes = Buffer.concat(queued);
    processQuickSendAutoTriggers(bytes);
    if (receiveDisplayMode === 'hex') {
        hexFormatter.push(bytes);
    } else {
        if (!textDecoder) createTextDecoder();
        const text = textDecoder.write(bytes);
        if (text) writeTextLines(dataParser.parse(text));
    }
    if (serialOutputQueue.length && !serialOutputFlushScheduled) {
        scheduleSerialOutputFlush();
    }
}

function flushPendingSerialOutput() {
    if (serialOutputFlushScheduled) {
        if (serialOutputFlushTimer) clearTimeout(serialOutputFlushTimer);
        serialOutputFlushTimer = null;
        serialOutputFlushScheduled = false;
        flushSerialOutputQueue();
    }
}

function queueSerialOutput(bytes) {
    serialOutputQueue.push(bytes);
    serialOutputQueuedBytes += bytes.length;
    if (serialOutputQueuedBytes >= SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES) {
        flushPendingSerialOutput();
        return;
    }
    scheduleSerialOutputFlush();
}

function writeTextLines(lines) {
    if (!lines.length) return;
    const formattedLines = lines.map(line => {
        const globalMatches = collectGlobalHighlightMatches(line.text);
        return {
            ...line,
            logPrefix: getLogPrefix(),
            globalMatches,
            highlighted: applyHighlighting(line.text, null, globalMatches)
        };
    });
    const mainOutput = formattedLines.map(line => `${line.prefix}${line.highlighted}${line.delimiter ? '\r\n' : ''}`).join('');
    if (mainOutput) {
        writeTerminalOutput(serialTerm, mainOutput);
        writeMainTabLog(formattedLines.map(line => `${line.logPrefix}${line.highlighted}${line.delimiter}`).join(''));
    }
    filterTabs.forEach(tab => {
        if (tab.dataMode !== 'text') return;
        const formatted = formattedLines.map(({ text, delimiter, prefix, logPrefix, globalMatches }) => {
            if (tab.filterRegex && !tab.filterRegex.test(text)) return null;
            const highlighted = applyHighlighting(text, tab.filterRegex, globalMatches);
            return {
                terminal: `${prefix}${highlighted}${delimiter ? '\r\n' : ''}`,
                log: `${logPrefix}${highlighted}${delimiter}`
            };
        }).filter(Boolean);
        const output = formatted.map(line => line.terminal).join('');
        if (output) {
            writeTerminalOutput(tab.term, output);
            writeFilterTabLog(tab, formatted.map(line => line.log).join(''));
        }
    });
}

function writeHexLines(lines) {
    if (!lines.length) return;
    const formattedLines = lines.map(line => ({
        text: line.output.replace(/\r?\n$/, ''),
        prefix: getPrefix(),
        logPrefix: getLogPrefix(),
        globalMatches: null,
        highlighted: ''
    }));
    formattedLines.forEach(line => {
        line.globalMatches = collectGlobalHighlightMatches(line.text);
        line.highlighted = applyHighlighting(line.text, null, line.globalMatches);
    });
    const mainOutput = formattedLines.map(({ text, prefix }) => `${prefix}${text}\r\n`).join('');
    writeTerminalOutput(serialTerm, mainOutput);
    writeMainTabLog(formattedLines.map(({ text, logPrefix }) => `${logPrefix}${text}\r\n`).join(''));
    filterTabs.forEach(tab => {
        if (tab.dataMode !== 'hex') return;
        const matched = formattedLines.map(({ text, prefix, logPrefix, globalMatches }) => {
            if (tab.filterRegex && !tab.filterRegex.test(text)) return null;
            const highlighted = applyHighlighting(text, tab.filterRegex, globalMatches);
            return {
                terminal: `${prefix}${highlighted}\r\n`,
                log: `${logPrefix}${highlighted}\r\n`
            };
        }).filter(Boolean);
        const output = matched.map(line => line.terminal).join('');
        if (output) {
            writeTerminalOutput(tab.term, output);
            writeFilterTabLog(tab, matched.map(line => line.log).join(''));
        }
    });
}

const hexFormatter = new HexStreamFormatter({}, writeHexLines);

function createTextDecoder() {
    textDecoder = iconv.getDecoder(SUPPORTED_ENCODINGS.has(receiveEncoding) ? receiveEncoding : 'utf8');
}

function createQuickTriggerDecoder() {
    quickTriggerDecoder = iconv.getDecoder(SUPPORTED_ENCODINGS.has(receiveEncoding) ? receiveEncoding : 'utf8');
}

function resetQuickTriggerReceive() {
    quickTriggerDecoder = null;
    quickTriggerBuffer = '';
}

function flushTextReceive() {
    if (textDecoder) {
        const finalText = textDecoder.end();
        if (finalText) writeTextLines(dataParser.parse(finalText));
        textDecoder = null;
    }
    writeTextLines(dataParser.flush());
}

function resetTextReceive() {
    textDecoder = null;
    dataParser.isNewLine = true;
    dataParser.incomingBuffer = '';
    if (receiveDisplayMode === 'text') createTextDecoder();
}

function updateFilterModeStatuses() {
    filterTabs.forEach(tab => {
        const paused = tab.dataMode !== receiveDisplayMode;
        if (tab.modeStatus) {
            tab.modeStatus.textContent = paused
                ? `${tab.dataMode.toUpperCase()} ${trFallback('main.filterPaused', 'paused')}`
                : tab.dataMode.toUpperCase();
            tab.modeStatus.classList.toggle('paused', paused);
        }
    });
}

function switchReceiveMode(nextMode, { persist = true } = {}) {
    const normalized = nextMode === 'hex' ? 'hex' : 'text';
    flushPendingSerialOutput();
    if (normalized !== receiveDisplayMode) {
        if (receiveDisplayMode === 'text') flushTextReceive();
        else hexFormatter.flush();
        receiveDisplayMode = normalized;
        if (normalized === 'text') createTextDecoder();
        else hexFormatter.reset({ resetOffset: false });
    } else if (normalized === 'text' && !textDecoder) {
        createTextDecoder();
    }
    if (receiveModeSelect) receiveModeSelect.value = normalized;
    if (receiveEncodingSelect) receiveEncodingSelect.disabled = normalized === 'hex';
    updateFilterModeStatuses();
    if (persist && !isApplyingConfig) saveSerialModeConfig();
}

function switchReceiveEncoding(nextEncoding, { persist = true } = {}) {
    const normalized = SUPPORTED_ENCODINGS.has(nextEncoding) ? nextEncoding : 'utf8';
    if (normalized !== receiveEncoding) {
        if (receiveDisplayMode === 'text') flushTextReceive();
        receiveEncoding = normalized;
        if (receiveDisplayMode === 'text') createTextDecoder();
        resetQuickTriggerReceive();
    }
    if (receiveEncodingSelect) receiveEncodingSelect.value = normalized;
    if (persist && !isApplyingConfig) saveSerialModeConfig();
}

function getTerminalPlainText(targetTerm) {
    return serializeTerminalBuffer(targetTerm?.buffer?.active);
}

async function writeClipboardText(text) {
    if (!text) return false;
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        ipcRenderer.send('renderer-log', 'Failed to write clipboard text from renderer');
        return false;
    }
}

async function readClipboardText() {
    try {
        return await navigator.clipboard.readText();
    } catch {
        ipcRenderer.send('renderer-log', 'Failed to read clipboard text from renderer');
        return '';
    }
}

function getContextMenuLabels() {
    return {
        copy: tr('main.contextCopy'),
        copyAll: tr('main.contextCopyAll'),
        findSelection: tr('main.contextFindSelection'),
        clearTerminal: tr('main.contextClearTerminal'),
        clearAndResetHex: trFallback('main.contextClearAndResetHex', 'Clear and Reset Hex Offset'),
        pasteAndSend: tr('main.contextPasteAndSend'),
        sendSelection: tr('main.contextSendSelection'),
        createFilterFromSelection: tr('main.contextCreateFilterFromSelection'),
        useSelectionAsFilter: tr('main.contextUseSelectionAsFilter'),
        appendSelectionToFilter: tr('main.contextAppendSelectionToFilter'),
        locateInMainTerminal: tr('main.contextLocateInMainTerminal'),
        toggleMatchCase: tr('main.contextToggleMatchCase'),
        toggleWholeWord: tr('main.wholeWord'),
        toggleRegex: tr('main.contextToggleRegex'),
        closeFilterTab: tr('main.contextCloseFilterTab'),
        splitHorizontal: tr('main.splitHorizontal'),
        splitVertical: tr('main.splitVertical'),
        moveToOtherPane: tr('main.moveToOtherPane'),
        closeSplit: tr('main.closeSplit'),
        newFilterTab: tr('main.newFilterTab'),
        newShellTab: tr('main.newShellTab'),
        closeShellTab: tr('main.contextCloseShellTab'),
        restartShell: tr('main.contextRestartShell'),
        toggleShellTextMode: tr('main.contextToggleShellTextMode'),
        newCmdTab: tr('main.newCmdTab'),
        newPowerShellTab: tr('main.newPowerShellTab'),
        newBashTab: tr('main.newBashTab'),
        chartPause: tr('main.chartPause'),
        chartResume: tr('main.chartResume'),
        chartLive: tr('main.chartLive'),
        chartClear: tr('main.chartClear'),
        chartExportWindow: tr('main.chartExportWindow'),
        chartExportAll: tr('main.chartExportAll'),
        chartSettings: tr('main.chartSettings'),
        chartClose: tr('main.chartClose')
    };
}

function stripShellMouseReports(tabState, data) {
    const input = `${tabState.mouseInputSequenceCarry || ''}${data || ''}`;
    const reportPattern = /\x1b\[<\d+(?:;\d+){2}[Mm]|\x1b\[\d+;\d+;\d+M|\x1bM[\s\S]{3}/g;
    const filtered = input.replace(reportPattern, '');
    let carry = '';
    for (let length = Math.min(8, filtered.length); length > 0; length--) {
        const suffix = filtered.slice(-length);
        if (/^\x1b(?:\[<?[0-9;]*|M[\s\S]{0,2})$/.test(suffix)) {
            carry = suffix;
            break;
        }
    }
    tabState.mouseInputSequenceCarry = carry;
    return carry ? filtered.slice(0, -carry.length) : filtered;
}

function setShellTextMode(tabState, enabled) {
    if (!tabState?.term) return;
    const mouseService = tabState.term._core?.coreMouseService;
    if (!mouseService) return;
    if (enabled) {
        if (tabState.shellMouseTrackingMode === undefined) {
            tabState.shellMouseTrackingMode = tabState.term.modes?.mouseTrackingMode || 'none';
        }
        // xterm otherwise consumes drag events for the shell instead of starting selection.
        mouseService._activeProtocol = 'NONE';
        mouseService._onProtocolChange?.fire(0);
        tabState.term.element?.classList.remove('enable-mouse-events');
    } else if (tabState.shellMouseTrackingMode !== undefined) {
        const protocolByMode = { none: 'NONE', x10: 'X10', vt200: 'VT200', drag: 'DRAG', any: 'ANY' };
        const protocol = protocolByMode[tabState.shellMouseTrackingMode] || 'NONE';
        mouseService._activeProtocol = protocol;
        mouseService._onProtocolChange?.fire(mouseService._protocols[protocol]?.events || 0);
        tabState.term.element?.classList.toggle('enable-mouse-events', protocol !== 'NONE');
        delete tabState.shellMouseTrackingMode;
    }
}

function bindShellTextModeWheel(tabState, element) {
    const target = tabState?.term?.element || element;
    if (!target) return;
    target.addEventListener('wheel', (event) => {
        if (!tabState.textMode) return;
        event.preventDefault();
        event.stopPropagation();
        const lines = mouseWheelScrollLines || 3;
        tabState.term.scrollLines(event.deltaY > 0 ? lines : -lines);
    }, { passive: false, capture: true });
}

function requestTerminalContextMenu(payload) {
    ipcRenderer.send('show-terminal-context-menu', {
        ...payload,
        labels: getContextMenuLabels()
    });
}

function getLogicalTerminalBufferLine(buffer, lineIndex) {
    if (!buffer || lineIndex < 0 || lineIndex >= buffer.length) return null;

    let start = lineIndex;
    while (start > 0 && buffer.getLine(start)?.isWrapped) start--;

    let end = lineIndex;
    while (end + 1 < buffer.length && buffer.getLine(end + 1)?.isWrapped) end++;

    let text = '';
    for (let index = start; index <= end; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        text += line.translateToString(index === end);
    }
    return { text, start, end };
}

function countLogicalLineOccurrencesAfter(buffer, target) {
    let occurrenceFromEnd = 1;
    for (let index = target.end + 1; index < buffer.length;) {
        const line = getLogicalTerminalBufferLine(buffer, index);
        if (!line) break;
        if (line.text === target.text) occurrenceFromEnd++;
        index = line.end + 1;
    }
    return occurrenceFromEnd;
}

function getTerminalBufferLineContextByEvent(term, element, event) {
    if (!term?.buffer?.active || !element) return null;

    const rect = element.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const rowHeight = rect.height / Math.max(1, term.rows || 1);
    const viewportRow = Math.max(0, Math.min((term.rows || 1) - 1, Math.floor(relativeY / Math.max(1, rowHeight))));
    const buffer = term.buffer.active;
    const bufferBaseY = buffer.viewportY || 0;
    const bufferLineIndex = bufferBaseY + viewportRow;
    const line = getLogicalTerminalBufferLine(buffer, bufferLineIndex);
    if (!line) return null;
    return {
        text: line.text,
        occurrenceFromEnd: countLogicalLineOccurrencesAfter(buffer, line)
    };
}

function bindTerminalContextMenu({ terminalType, term, element, getTabState }) {
    if (!element) return;
    element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const tabState = typeof getTabState === 'function' ? getTabState() : null;
        if (tabState && terminalType === 'filter') {
            tabState.contextLine = getTerminalBufferLineContextByEvent(term, element, event);
        }
        requestTerminalContextMenu({
            terminalType,
            paneId: resolvePaneId(tabState?.paneId, tabState?.id, 'tab-main'),
            tabId: tabState?.id || (terminalType === 'main' ? 'tab-main' : ''),
            hasSelection: term.hasSelection(),
            selectedText: term.hasSelection() ? term.getSelection() : '',
            isConnected,
            splitEnabled: isSplitEnabled(),
            filterText: tabState?.filterText || '',
            canLocateInMain: Boolean(tabState?.contextLine?.text),
            caseSensitive: Boolean(tabState?.caseSensitive),
            wholeWord: Boolean(tabState?.wholeWord),
            useRegex: Boolean(tabState?.useRegex),
            shellTextMode: Boolean(tabState?.textMode),
            receiveDisplayMode
        });
    });
}

function bindTerminalWheel(term, element) {
    if (!term || !element) return;
    // Bind to the xterm viewport element to intercept wheel before xterm's own handler
    const target = term.element || element;
    target.addEventListener('wheel', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const lines = mouseWheelScrollLines || 3;
        const delta = event.deltaY > 0 ? lines : -lines;
        term.scrollLines(delta);
    }, { passive: false, capture: true });
}

function locateInMainTerminal(context) {
    if (!context?.text || !serialTerm?.buffer?.active) return false;
    const buffer = serialTerm.buffer.active;
    let remainingOccurrence = Math.max(1, Number(context.occurrenceFromEnd) || 1);
    let match = null;
    for (let index = buffer.length - 1; index >= 0;) {
        const line = getLogicalTerminalBufferLine(buffer, index);
        if (!line) break;
        if (line.text === context.text && --remainingOccurrence === 0) {
            match = line;
            break;
        }
        index = line.start - 1;
    }
    if (!match) return false;

    switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main');
    requestAnimationFrame(() => {
        serialTerm.scrollToLine(match.start);
        serialTerm.selectLines(match.start, match.end);
    });
    return true;
}

function setSearchFromText(text) {
    if (!text) return;
    showSidebarTab('tab-search');
    searchInput.value = text;
    resetSearchState();
    refreshSearchCount({ force: true });
}

function focusSearchWithActiveSelection() {
    setSidebarCollapsed(false);
    const target = getActiveSearchTarget();
    const selectedText = target?.term?.hasSelection?.() ? target.term.getSelection() : '';
    if (selectedText) {
        setSearchFromText(selectedText);
    } else {
        showSidebarTab('tab-search');
    }
    searchInput?.focus();
    searchInput?.select();
}

function clearTerminalByTabId(tabId) {
    if (!tabId || tabId === 'tab-main') {
        if (receiveDisplayMode === 'hex') hexFormatter.reset({ resetOffset: false });
        else resetTextReceive();
        clearTerminalOutput(serialTerm);
        serialLineCounter = 1;
        logLineCounter = 1;
        return;
    }
    const filterTab = filterTabs.find(t => t.id === tabId);
    if (filterTab) {
        clearTerminalOutput(filterTab.term);
        filterTab.contextLine = null;
        return;
    }
    const shellTab = getShellTabState(tabId);
    if (shellTab) {
        shellTab.term.clear();
    }
}

function restartShellTab(tabId) {
    const shellTab = getShellTabState(tabId);
    if (!shellTab) return;
    ipcRenderer.send('close-shell-tab-session', { tabId });
    shellTab.mouseModeSequenceCarry = '';
    shellTab.mouseInputSequenceCarry = '';
    shellTab.term.reset();
    shellTab.btn?.classList.remove('exited');
    shellTab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
    ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: shellTab.term.cols, rows: shellTab.term.rows, profileId: shellTab.profileId || '' })
        .then(() => {
            shellTab.sessionReady = true;
            ipcRenderer.send('resize-shell-tab', { tabId, cols: shellTab.term.cols, rows: shellTab.term.rows });
            setActionStatus(tr('main.shellStarting'));
        })
        .catch((error) => {
            shellTab.term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
        });
}

async function handleTerminalContextMenuAction(payload = {}) {
    const { action, tabId, terminalType, paneId } = payload;
    const isFilter = terminalType === 'filter';
    const isShell = terminalType === 'shell';
    const isChart = terminalType === 'chart';
    const filterTab = isFilter ? filterTabs.find(tab => tab.id === tabId) : null;
    const shellTab = isShell ? getShellTabState(tabId) : null;
    const chartTab = isChart ? getChartTabState(tabId) : null;
    const targetTerm = isChart ? null : (isFilter ? filterTab?.term : (isShell ? shellTab?.term : serialTerm));
    if ((isChart && !chartTab) || (!isChart && !targetTerm && action !== 'paste-send')) return;

    switch (action) {
        case 'copy-all': {
            const text = getTerminalPlainText(targetTerm);
            if (text) {
                await writeClipboardText(text);
            }
            break;
        }
        case 'find-selection': {
            const text = targetTerm?.getSelection();
            if (text) {
                setSearchFromText(text);
            }
            break;
        }
        case 'clear-terminal': {
            clearTerminalByTabId(tabId || 'tab-main');
            setActionStatus(trFallback('main.terminalCleared', 'Terminal cleared'));
            break;
        }
        case 'clear-reset-hex':
        case 'clear-and-reset-hex':
        case 'reset-hex-offset': {
            clearTerminalByTabId('tab-main');
            hexFormatter.reset({ resetOffset: true });
            setActionStatus(trFallback('main.hexOffsetReset', 'Terminal cleared and Hex offset reset'));
            break;
        }
        case 'paste-send': {
            const text = await readClipboardText();
            if (text) {
                if (isShell && shellTab) {
                    shellTab.term.paste(text);
                } else if (isConnected) {
                    await sendSerialRequest({ mode: 'text', content: text, source: 'paste' }, SEND_LIMITS.paste);
                }
            }
            break;
        }
        case 'send-selection': {
            const text = targetTerm?.getSelection();
            if (text && isShell && shellTab) {
                ipcRenderer.send('shell-tab-input', { tabId: shellTab.id, data: text });
            } else if (text && isConnected) {
                await sendSerialRequest({ mode: 'text', content: text, source: 'selection' }, SEND_LIMITS.paste);
            }
            break;
        }
        case 'create-filter-from-selection': {
            const text = targetTerm?.getSelection();
            if (text) {
                createFilterTab({ filterText: text, caseSensitive: false, useRegex: false, dataMode: receiveDisplayMode }, resolvePaneId(paneId, tabId));
                setActionStatus('已用选中文本新建过滤标签页');
            }
            break;
        }
        case 'new-filter-tab': {
            createFilterTab({}, resolvePaneId(paneId, tabId));
            setActionStatus('已新建过滤标签页');
            break;
        }
        case 'split-horizontal': {
            if (!tabId) break;
            const sourcePaneId = resolvePaneId(paneId, tabId);
            workspaceLayout.orientation = 'horizontal';
            moveTabToPane(tabId, getOtherPaneId(sourcePaneId));
            setActionStatus('已将标签页移入左右分屏');
            break;
        }
        case 'split-vertical': {
            if (!tabId) break;
            const sourcePaneId = resolvePaneId(paneId, tabId);
            workspaceLayout.orientation = 'vertical';
            moveTabToPane(tabId, getOtherPaneId(sourcePaneId));
            setActionStatus('已将标签页移入上下分屏');
            break;
        }
        case 'move-to-other-pane': {
            if (!tabId) break;
            const sourcePaneId = resolvePaneId(paneId, tabId);
            const targetPaneId = getOtherPaneId(sourcePaneId);
            moveTabToPane(tabId, targetPaneId);
            setActionStatus('已移动标签页到另一个分屏');
            break;
        }
        case 'close-split': {
            collapseSplit();
            setActionStatus('已关闭分屏');
            break;
        }
        case 'toggle-chart-paused': {
            if (chartTab) toggleChartPaused(chartTab);
            break;
        }
        case 'chart-return-live': {
            chartTab?.view?.returnToLive();
            break;
        }
        case 'clear-chart': {
            if (chartTab) clearChartDataSession(chartTab);
            break;
        }
        case 'export-chart-window': {
            if (chartTab) await exportChartSamples('window', chartTab);
            break;
        }
        case 'export-chart-all': {
            if (chartTab) await exportChartSamples('all', chartTab);
            break;
        }
        case 'chart-settings': {
            if (chartTab) openChartSettings(chartTab);
            break;
        }
        case 'close-chart-tab': {
            if (chartTab) closeChartTab(chartTab.id);
            break;
        }
        case 'use-selection-as-filter': {
            const text = targetTerm?.getSelection();
            if (filterTab && text) {
                const input = filterTab.element.querySelector('.filter-input');
                input.value = text;
                filterTab.filterText = text;
                filterTab.updateRegex();
            }
            break;
        }
        case 'append-selection-to-filter': {
            const text = targetTerm?.getSelection();
            if (filterTab && text) {
                const input = filterTab.element.querySelector('.filter-input');
                input.value = `${input.value || ''}${text}`;
                filterTab.filterText = input.value;
                filterTab.updateRegex();
            }
            break;
        }
        case 'locate-in-main-terminal': {
            if (!filterTab) break;
            if (!locateInMainTerminal(filterTab.contextLine)) {
                setActionStatus(tr('main.searchResultZero'));
            }
            break;
        }
        case 'toggle-case-sensitive': {
            if (filterTab) {
                filterTab.caseSensitive = !filterTab.caseSensitive;
                filterTab.caseBtn.classList.toggle('active', filterTab.caseSensitive);
                filterTab.updateRegex();
            }
            break;
        }
        case 'toggle-whole-word': {
            if (filterTab) {
                filterTab.wholeWord = !filterTab.wholeWord;
                filterTab.wordBtn.classList.toggle('active', filterTab.wholeWord);
                filterTab.updateRegex();
            }
            break;
        }
        case 'toggle-regex': {
            if (filterTab) {
                filterTab.useRegex = !filterTab.useRegex;
                filterTab.regexBtn.classList.toggle('active', filterTab.useRegex);
                filterTab.updateRegex();
            }
            break;
        }
        case 'close-filter-tab': {
            if (filterTab) {
                closeFilterTab(filterTab.id);
            }
            break;
        }
        case 'new-shell-tab': {
            createShellTab({ profileId: getDefaultShellProfileId() }, resolvePaneId(paneId, tabId));
            setActionStatus(tr('main.shellStarting'));
            break;
        }
        case 'close-shell-tab': {
            if (shellTab) {
                closeShellTab(shellTab.id);
            }
            break;
        }
        case 'restart-shell': {
            if (shellTab) {
                restartShellTab(shellTab.id);
            }
            break;
        }
        case 'toggle-shell-text-mode': {
            if (shellTab) {
                shellTab.textMode = !shellTab.textMode;
                setShellTextMode(shellTab, shellTab.textMode);
                updateShellTextMode(shellTab);
            }
            break;
        }
    }
}

// Initialize Terminals
/*
const term = new Terminal({ cursorBlink: true });
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(document.getElementById('terminal-container'));
*/

const serialTerm = new Terminal({ 
    cursorBlink: true,
    allowProposedApi: true,
    allowTransparency: true,
    scrollback: 20000
});
const serialFitAddon = new FitAddon();
const serialSearchAddon = new SearchAddon();
serialTerm.loadAddon(serialFitAddon);
serialTerm.loadAddon(serialSearchAddon);
enableTerminalUnicode11(serialTerm);
serialTerm.open(document.getElementById('serial-container'));
const mainTabButton = document.querySelector('.main-tab[data-target="tab-main"]');
if (mainTabButton) {
    mainTabButton.addEventListener('click', () => {
        switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main');
    });
}

function bindChartContextMenu(tab) {
    tab.element.addEventListener('contextmenu', event => {
        event.preventDefault();
        const range = tab.view?.viewRange;
        requestTerminalContextMenu({
            terminalType: 'chart',
            paneId: resolvePaneId(tab.paneId, tab.id),
            tabId: tab.id,
            splitEnabled: isSplitEnabled(),
            paused: tab.paused,
            canReturnToLive: Boolean(tab.view?.fullRange && !tab.view.following),
            canExportWindow: Boolean(range && tab.model?.query(range[0], range[1]).length),
            canExportAll: Boolean(tab.model?.samples.length)
        });
    });
}

async function showWelcomeGuideForCurrentVersion(config) {
    if (welcomeGuideChecked) return;
    welcomeGuideChecked = true;
    try {
        const aboutInfo = await ipcRenderer.invoke('get-about-info');
        const version = typeof aboutInfo?.version === 'string' ? aboutInfo.version : '';
        if (!version || config.lastWelcomeVersion === version) return;
        serialTerm.write(buildWelcomeGuideOutput(version));
        config.lastWelcomeVersion = version;
        ipcRenderer.send('save-config', { lastWelcomeVersion: version });
    } catch (error) {
        console.error('Failed to show welcome guide:', error);
    }
}

function buildWelcomeGuideOutput(version) {
    const reset = '\x1b[0m';
    const banner = [
        '██╗ ████████╗███████╗████████╗',
        '╚██╗╚══██╔══╝██╔════╝╚══██╔══╝',
        ' ╚██╗  ██║   ███████╗   ██║   ',
        ' ██╔╝  ██║   ╚════██║   ██║   ',
        '██╔╝   ██║   ███████║   ██║   ',
        '╚═╝    ╚═╝   ╚══════╝   ╚═╝   '
    ];
    const bannerColors = ['45;212;191', '34;211;238', '56;189;248', '96;165;250', '129;140;248', '192;132;252'];
    const bannerOutput = banner.map((line, index) => `\x1b[1;38;2;${bannerColors[index]}m${line}${reset}`).join('\r\n');
    const guideLines = tr('main.welcomeGuide', { version }).split('\n').map((line, index, lines) => {
        if (index === 0) return `\x1b[1;38;2;94;234;212m${line}${reset}`;
        const feature = line.match(/^(\d+\.\s*)([^:：]+)([:：])(.*)$/);
        if (feature) {
            return `\x1b[1;38;2;250;204;21m${feature[1]}${reset}`
                + `\x1b[1;38;2;96;165;250m${feature[2]}${feature[3]}${reset}`
                + `\x1b[38;2;203;213;225m${feature[4]}${reset}`;
        }
        if (index === lines.length - 1) return `\x1b[38;2;192;132;252m${line}${reset}`;
        return line;
    }).join('\r\n');
    const clearHint = `\x1b[1;38;2;251;191;36m${tr('main.welcomeClearHint')}${reset}`;
    return `${bannerOutput}\r\n\r\n${guideLines}\r\n\r\n${clearHint}\r\n\r\n`;
}
bindTerminalContextMenu({
    terminalType: 'main',
    term: serialTerm,
    element: document.getElementById('serial-container')
});
bindTerminalWheel(serialTerm, document.getElementById('serial-container'));

// Filter Tabs Management
let filterTabs = [];
let nextFilterTabId = 1;
let shellTabs = [];
let nextShellTabId = 1;
let chartTabs = [];
let nextChartTabId = 1;
let renameTabState = null;
const renameTabDialog = document.getElementById('rename-tab-dialog');
const renameTabInput = document.getElementById('rename-tab-input');

function getPaneDom(paneId) {
    return document.getElementById(paneId);
}

function getPaneTabsList(paneId) {
    return document.getElementById(`${paneId}-tabs-list`);
}

function getPaneTabsContent(paneId) {
    return document.getElementById(`${paneId}-tabs-content`);
}

function getShellTabState(tabId) {
    return shellTabs.find(tab => tab.id === tabId) || null;
}

function getChartTabState(tabId) {
    return chartTabs.find(tab => tab.id === tabId) || null;
}

function persistWorkspaceLayout() {
    if (!currentConfig) return;
    currentConfig.workspaceLayout = cloneWorkspaceLayout(workspaceLayout);
    ipcRenderer.send('save-config', { workspaceLayout: currentConfig.workspaceLayout });
}

workspaceManager = createWorkspaceManager({
    getLayout: () => workspaceLayout,
    setLayout: (nextLayout) => {
        workspaceLayout = nextLayout;
    },
    cloneLayout: cloneWorkspaceLayout,
    normalizeLayout: ensureWorkspaceLayoutShape,
    persistLayout: persistWorkspaceLayout,
    getPaneDom,
    getPaneTabsList,
    getPaneTabsContent,
    onTabActivated: ({ tabId, paneId }) => {
        window.dispatchEvent(new CustomEvent('main-tab-changed', { detail: { tabId, paneId } }));
    },
    onTabMoved: ({ tabId, targetPaneId }) => {
        const filterTab = filterTabs.find(tab => tab.id === tabId);
        if (filterTab) {
            filterTab.paneId = targetPaneId;
            persistFilterTabs();
            return;
        }
        const shellTab = getShellTabState(tabId);
        if (shellTab) {
            shellTab.paneId = targetPaneId;
            persistShellTabs();
            return;
        }
        const chartTab = getChartTabState(tabId);
        if (chartTab) {
            chartTab.paneId = targetPaneId;
            persistChartTabs();
        }
    },
    fitWorkspace: fitWorkspaceTerminals
});

let workspaceFitFrame = null;

function fitWorkspaceTerminals() {
    if (workspaceFitFrame !== null) return;
    workspaceFitFrame = requestAnimationFrame(() => {
        workspaceFitFrame = null;
        serialFitAddon.fit();
        filterTabs.forEach(tab => {
            const paneEl = getPaneDom(tab.paneId || getTabPaneId(tab.id));
            const tabPane = document.getElementById(tab.id);
            if (!paneEl || paneEl.hidden || !tabPane || !isTabActive(tab.id)) return;
            tab.fitAddon.fit();
        });
        shellTabs.forEach(tab => {
            const paneEl = getPaneDom(tab.paneId || getTabPaneId(tab.id));
            const tabPane = document.getElementById(tab.id);
            if (!paneEl || paneEl.hidden || !tabPane || !isTabActive(tab.id)) return;
            tab.fitAddon.fit();
            const sizeChanged = tab.lastFitCols !== tab.term.cols || tab.lastFitRows !== tab.term.rows;
            tab.lastFitCols = tab.term.cols;
            tab.lastFitRows = tab.term.rows;
            if (!isDraggingWorkspaceSplitter && sizeChanged) {
                ipcRenderer.send('resize-shell-tab', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows });
            }
        });
        chartTabs.forEach(tab => {
            if (isTabActive(tab.id)) tab.view?.resize();
        });
    });
}

function getPaneById(paneId) {
    return workspaceManager.getPaneById(paneId);
}

function isSplitEnabled() {
    return workspaceManager.isSplitEnabled();
}

function getOrientation() {
    return workspaceManager.getOrientation();
}

function normalizeWorkspaceLayout(layout) {
    return workspaceManager.normalizeWorkspaceLayout(layout);
}

function getActivePane() {
    return workspaceManager.getActivePane();
}

function getActiveTabId(fallbackTabId = 'tab-main') {
    return workspaceManager.getActiveTabId(fallbackTabId);
}

function getActiveTabInfo(fallbackTabId = 'tab-main') {
    return workspaceManager.getActiveTabInfo(fallbackTabId);
}

function resolvePaneId(paneId, tabId, fallbackTabId = 'tab-main') {
    return workspaceManager.resolvePaneId(paneId, tabId, fallbackTabId);
}

function getOtherPaneId(paneId) {
    return workspaceManager.getOtherPaneId(paneId);
}

function getTabPaneId(tabId, fallbackPaneId = 'pane-1') {
    return workspaceManager.getTabPaneId(tabId, fallbackPaneId);
}

function isTabActive(tabId) {
    return workspaceManager.isTabActive(tabId);
}

function getPaneIdForTabId(tabId) {
    return workspaceManager.getPaneIdForTabId(tabId);
}

function ensurePaneActiveTab(paneId) {
    return workspaceManager.ensurePaneActiveTab(paneId);
}

function setActivePane(paneId, options = {}) {
    return workspaceManager.setActivePane(paneId, options);
}

function switchPaneTab(paneId, tabId, options = {}) {
    return workspaceManager.switchPaneTab(paneId, tabId, options);
}

window.__switchWorkspaceTab = switchPaneTab;

function ensurePaneTabMembership(paneId, tabId) {
    return workspaceManager.ensurePaneTabMembership(paneId, tabId);
}

function applyWorkspaceLayoutToDom() {
    return workspaceManager.applyLayoutToDom();
}

function enableSplit(orientation) {
    return workspaceManager.enableSplit(orientation);
}

function moveTabToPane(tabId, targetPaneId, options = {}) {
    return workspaceManager.moveTabToPane(tabId, targetPaneId, options);
}

let workspaceTabDragState = null;

function getWorkspaceTabDropTarget(clientX, clientY) {
    return ['pane-1', 'pane-2'].map(paneId => ({ paneId, list: getPaneTabsList(paneId) }))
        .find(({ list }) => {
            if (!list || list.closest('.workspace-pane')?.hidden) return false;
            const rect = list.getBoundingClientRect();
            return clientX >= rect.left && clientX <= rect.right
                && clientY >= rect.top - 6 && clientY <= rect.bottom + 6;
        }) || null;
}

function updateWorkspaceTabDrag(state, clientX, clientY) {
    if (!state.dragging) return;
    state.preview.style.left = `${Math.max(4, Math.min(clientX + 10, window.innerWidth - state.preview.offsetWidth - 4))}px`;
    state.preview.style.top = `${Math.max(4, Math.min(clientY + 10, window.innerHeight - state.preview.offsetHeight - 4))}px`;
    state.indicator.remove();
    state.targetPaneId = null;
    state.insertionIndex = null;

    const target = getWorkspaceTabDropTarget(clientX, clientY);
    if (!target) return;
    const listRect = target.list.getBoundingClientRect();
    const edgeSize = Math.min(36, listRect.width / 4);
    if (clientX < listRect.left + edgeSize) {
        target.list.scrollLeft -= Math.ceil((listRect.left + edgeSize - clientX) / 4);
    } else if (clientX > listRect.right - edgeSize) {
        target.list.scrollLeft += Math.ceil((clientX - (listRect.right - edgeSize)) / 4);
    }
    const tabs = Array.from(target.list.querySelectorAll('.main-tab')).filter(tab => tab !== state.tabButton);
    const insertionIndex = getHorizontalInsertionIndex(tabs.map(tab => tab.getBoundingClientRect()), clientX);
    target.list.insertBefore(state.indicator, tabs[insertionIndex] || null);
    state.targetPaneId = target.paneId;
    state.insertionIndex = insertionIndex;
}

function startWorkspaceTabDrag(state) {
    state.dragging = true;
    state.tabButton.classList.add('workspace-tab-dragging');
    const preview = state.tabButton.cloneNode(true);
    preview.classList.remove('active', 'workspace-tab-dragging');
    preview.classList.add('workspace-tab-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.querySelectorAll('button, [tabindex]').forEach(element => { element.tabIndex = -1; });
    preview.style.width = `${state.tabButton.getBoundingClientRect().width}px`;
    document.body.appendChild(preview);
    state.preview = preview;
    state.indicator = document.createElement('span');
    state.indicator.className = 'workspace-tab-drop-indicator';
    state.indicator.setAttribute('aria-hidden', 'true');
    updateWorkspaceTabDrag(state, state.lastX, state.lastY);
}

function finishWorkspaceTabDrag(state) {
    state.preview?.remove();
    state.indicator?.remove();
    state.tabButton.classList.remove('workspace-tab-dragging');
    if (state.dragging && state.targetPaneId && state.insertionIndex !== null) {
        moveTabToPane(state.tabId, state.targetPaneId, { insertionIndex: state.insertionIndex });
        state.tabButton.dataset.suppressClickUntil = String(performance.now() + 300);
    }
}

function bindWorkspaceTabDragging() {
    ['pane-1', 'pane-2'].forEach(paneId => {
        getPaneTabsList(paneId)?.addEventListener('pointerdown', event => {
            const tabButton = event.target.closest('.main-tab');
            if (!tabButton || event.target.closest('.main-tab-close')) return;
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
            workspaceTabDragState = {
                pointerId: event.pointerId,
                tabId: tabButton.dataset.target,
                tabButton,
                startX: event.clientX,
                startY: event.clientY,
                lastX: event.clientX,
                lastY: event.clientY,
                dragging: false
            };
        });
    });
    document.addEventListener('pointermove', event => {
        const state = workspaceTabDragState;
        if (!state || state.pointerId !== event.pointerId) return;
        state.lastX = event.clientX;
        state.lastY = event.clientY;
        if (!state.dragging && Math.hypot(event.clientX - state.startX, event.clientY - state.startY) >= 6) {
            startWorkspaceTabDrag(state);
        }
        if (state.dragging) {
            event.preventDefault();
            updateWorkspaceTabDrag(state, event.clientX, event.clientY);
        }
    }, { passive: false });
    const finish = event => {
        const state = workspaceTabDragState;
        if (!state || state.pointerId !== event.pointerId) return;
        workspaceTabDragState = null;
        finishWorkspaceTabDrag(state);
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    document.addEventListener('click', event => {
        const tabButton = event.target.closest?.('.main-tab');
        if (tabButton && performance.now() < Number(tabButton.dataset.suppressClickUntil || 0)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

bindWorkspaceTabDragging();

function collapseSplit() {
    return workspaceManager.collapseSplit();
}

function addTabToPane(tabId, paneId, options = {}) {
    return workspaceManager.addTabToPane(tabId, paneId, options);
}

function setPaneSizes(pane1Ratio, options = {}) {
    return workspaceManager.setPaneSizes(pane1Ratio, options);
}

function bindWorkspaceSplitter() {
    if (!workspaceRootEl || !workspaceSplitterEl) return;

    let rafId = null;
    let pendingRatio = null;

    const flushPaneResize = () => {
        rafId = null;
        if (pendingRatio === null) return;
        setPaneSizes(pendingRatio, { persist: false });
        fitWorkspaceTerminals();
        pendingRatio = null;
    };

    const handlePointerMove = (event) => {
        if (!isSplitEnabled()) return;
        const isVertical = getOrientation() === 'vertical';
        const rect = workspaceRootEl.getBoundingClientRect();
        const total = isVertical ? rect.height : rect.width;
        const offset = isVertical ? (event.clientY - rect.top) : (event.clientX - rect.left);
        if (total <= 0) return;
        pendingRatio = offset / total;
        if (rafId === null) {
            rafId = requestAnimationFrame(flushPaneResize);
        }
    };

    const handlePointerUp = () => {
        if (rafId !== null) {
            cancelAnimationFrame(rafId);
            flushPaneResize();
        }
        isDraggingWorkspaceSplitter = false;
        workspaceRootEl.classList.remove('resizing');
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp);
        persistWorkspaceLayout();
        fitWorkspaceTerminals();
    };

    workspaceSplitterEl.addEventListener('pointerdown', (event) => {
        if (!isSplitEnabled()) return;
        event.preventDefault();
        isDraggingWorkspaceSplitter = true;
        workspaceRootEl.classList.add('resizing');
        document.addEventListener('pointermove', handlePointerMove);
        document.addEventListener('pointerup', handlePointerUp);
    });
}

function bindWorkspacePaneTransitionFit() {
    if (!workspaceRootEl) return;

    workspaceRootEl.addEventListener('transitionend', (event) => {
        if (event.propertyName !== 'flex-basis' || isDraggingWorkspaceSplitter) return;
        if (event.target?.id !== 'pane-1' && event.target?.id !== 'pane-2') return;
        fitWorkspaceTerminals();
    });

    sidebar?.addEventListener('transitionend', (event) => {
        if (event.target !== sidebar || event.propertyName !== 'width') return;
        fitWorkspaceTerminals();
    });
}

function removeTabFromWorkspace(tabId, options = {}) {
    return workspaceManager.removeTab(tabId, options);
}

function restoreWorkspaceLayout(layout, options = {}) {
    return workspaceManager.restoreLayout(layout, options);
}

function getNextTabId() {
    return nextFilterTabId++;
}

function syncNextFilterTabId(tabId) {
    const match = String(tabId || '').match(/^tab-filter-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextFilterTabId) {
        nextFilterTabId = numericId + 1;
    }
}

function getNextShellTabId() {
    return nextShellTabId++;
}

function syncNextShellTabId(tabId) {
    const match = String(tabId || '').match(/^tab-shell-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextShellTabId) {
        nextShellTabId = numericId + 1;
    }
}

function updateTabTitles() {
    filterTabs.forEach((tab, index) => {
        const displayIndex = index + 1;
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const title = tab.title?.trim() || `${tr('main.filter')} ${displayIndex}`;
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = title;
        tab.btn.replaceChildren(titleEl);
        if (tab.dataMode === 'hex') {
            const badge = document.createElement('span');
            badge.className = 'mode-badge hex';
            badge.textContent = 'HEX';
            tab.btn.appendChild(badge);
        }
        tab.btn.appendChild(closeBtn);
    });
    shellTabs.forEach((tab, index) => {
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const profile = currentConfig?.shellProfiles?.find(item => item.id === tab.profileId);
        const defaultTitle = profile?.name?.trim() || tr('main.shellTitle', { index: index + 1 });
        const title = tab.title?.trim() || defaultTitle;
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = title;
        tab.btn.replaceChildren(titleEl);
        if (tab.textMode) {
            const badge = document.createElement('span');
            badge.className = 'mode-badge text';
            badge.textContent = 'TEXT';
            tab.btn.appendChild(badge);
        }
        tab.btn.appendChild(closeBtn);
    });
    chartTabs.forEach((tab, index) => {
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        const titleEl = document.createElement('span');
        titleEl.className = 'main-tab-title';
        titleEl.textContent = tab.title?.trim() || `${tr('main.chart')} ${index + 1}`;
        tab.btn.replaceChildren(titleEl);
        tab.btn.appendChild(closeBtn);
    });
}

function getMainTabTitle() {
    return 'Main_Terminal';
}

function getFilterTabLogTitle(tabState) {
    if (!tabState) return 'Filter';
    if (tabState.title?.trim()) return tabState.title.trim();
    const index = filterTabs.indexOf(tabState);
    return index >= 0 ? `Filter_${index + 1}` : 'Filter';
}

function getShellTabLogTitle(tabState) {
    if (!tabState) return 'Shell';
    if (tabState.title?.trim()) return tabState.title.trim();
    const index = shellTabs.indexOf(tabState);
    return index >= 0 ? `Shell_${index + 1}` : 'Shell';
}

function writeTabLog(tabId, title, data) {
    if (!tabId || typeof data !== 'string' || !data) {
        return;
    }
    ipcRenderer.send('write-tab-log', { tabId, title, data });
}

function writeMainTabLog(data) {
    writeTabLog('tab-main', getMainTabTitle(), data);
}

function writeFilterTabLog(tabState, data) {
    if (!tabState) return;
    writeTabLog(tabState.id, getFilterTabLogTitle(tabState), data);
}

function writeShellTabLog(tabState, data) {
    if (!tabState) return;
    writeTabLog(tabState.id, getShellTabLogTitle(tabState), data);
}

function getDefaultShellProfileId() {
    const profiles = Array.isArray(currentConfig?.shellProfiles) ? currentConfig.shellProfiles : [];
    if (!profiles.length) return '';
    const defaultId = currentConfig?.defaultShellProfileId || '';
    if (defaultId) {
        const found = profiles.find(p => p.id === defaultId);
        if (found) return found.id;
    }
    return '';
}

function persistShellTabs() {
    ipcRenderer.send('save-config', {
        shellTabs: shellTabs.map(tab => ({
            id: tab.id,
            title: tab.title || '',
            paneId: tab.paneId || getTabPaneId(tab.id),
            profileId: tab.profileId || ''
        }))
    });
}

function createShellTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-shell-${getNextShellTabId()}`;
    syncNextShellTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const profileId = typeof initialState.profileId === 'string' && initialState.profileId
        ? initialState.profileId
        : (typeof initialState.shellType === 'string' ? initialState.shellType : '');

    const tabList = getPaneTabsList(resolvedPaneId);
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    const shellTitle = document.createElement('span');
    shellTitle.className = 'main-tab-title';
    shellTitle.textContent = tr('main.shell');
    const shellClose = document.createElement('span');
    shellClose.className = 'main-tab-close';
    shellClose.title = tr('main.closeTab');
    shellClose.appendChild(createMaterialIcon('close'));
    tabBtn.append(shellTitle, shellClose);
    tabBtn.onclick = (e) => {
        if (e.target.closest('.main-tab-close')) return;
        switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeShellTab(tabId);
    };
    tabBtn.ondblclick = (e) => {
        if (!e.target.closest('.main-tab-close')) {
            const tabState = shellTabs.find(tab => tab.id === tabId);
            if (tabState) openRenameTabDialog(tabState);
        }
    };
    tabList.appendChild(tabBtn);

    const tabContent = getPaneTabsContent(resolvedPaneId);
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;

    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);

    const term = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 20000) : 20000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    enableTerminalUnicode11(term);
    term.open(terminalWrapper);

    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontWeight: currentConfig.fontWeight,
            fontFamily: TERMINAL_FONT_FAMILY(currentConfig),
            theme: getTerminalTheme(currentConfig)
        };
    }

    const tabState = {
        id: tabId,
        paneId: resolvedPaneId,
        title: initialState.title || '',
        profileId,
        term,
        fitAddon,
        searchAddon,
        element: tabPane,
        btn: tabBtn,
        sessionReady: false,
        sessionCreateTimer: null,
        mouseModeSequenceCarry: '',
        mouseInputSequenceCarry: '',
        shellMouseTrackingMode: undefined,
        textMode: false,
        closed: false
    };

    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, 'shell'));
    term.onData((data) => {
        if (tabState.textMode) {
            data = stripShellMouseReports(tabState, data);
            if (!data) return;
        }
        ipcRenderer.send('shell-tab-input', { tabId, data });
    });
    term.onBinary((data) => {
        ipcRenderer.send('shell-tab-binary-input', {
            tabId,
            bytes: Array.from(data, character => character.charCodeAt(0) & 0xff)
        });
    });
    bindTerminalContextMenu({
        terminalType: 'shell',
        term,
        element: terminalWrapper,
        getTabState: () => tabState
    });
    bindShellTextModeWheel(tabState, terminalWrapper);

    shellTabs.push(tabState);
    updateTabTitles();
    addTabToPane(tabId, resolvedPaneId, { activate: false, persist: false });
    if (!isRestoringWorkspaceSession) {
        switchPaneTab(resolvedPaneId, tabId, { persist: false });
        persistShellTabs();
        persistWorkspaceLayout();
        setActionStatus(tr('main.shellStarting'));
    }

    tabState.sessionCreateTimer = setTimeout(() => {
        tabState.sessionCreateTimer = null;
        if (tabState.closed || !shellTabs.includes(tabState)) return;
        fitAddon.fit();
        ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: term.cols, rows: term.rows, profileId })
            .then(() => {
                if (tabState.closed || !shellTabs.includes(tabState)) {
                    ipcRenderer.send('close-shell-tab-session', { tabId });
                    return;
                }
                tabState.sessionReady = true;
                ipcRenderer.send('resize-shell-tab', { tabId, cols: term.cols, rows: term.rows });
            })
            .catch((error) => {
                if (tabState.closed) return;
                term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
            });
    }, 50);
}

function closeShellTab(tabId) {
    const index = shellTabs.findIndex(t => t.id === tabId);
    if (index === -1) return;
    const tab = shellTabs[index];
    tab.closed = true;
    if (tab.sessionCreateTimer !== null) {
        clearTimeout(tab.sessionCreateTimer);
        tab.sessionCreateTimer = null;
    }
    ipcRenderer.send('flush-tab-log', { tabId });
    tab.term.dispose();
    tab.element.remove();
    tab.btn.remove();
    shellTabs.splice(index, 1);
    ipcRenderer.send('close-shell-tab-session', { tabId });
    const { nextActiveTabId } = removeTabFromWorkspace(tabId, { persist: false });
    persistShellTabs();
    updateTabTitles();
    const nextPaneId = nextActiveTabId ? getPaneIdForTabId(nextActiveTabId) : getPaneIdForTabId('tab-main');
    if (nextActiveTabId) {
        switchPaneTab(nextPaneId, nextActiveTabId, { persist: false });
    } else {
        switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main', { persist: false });
    }
    persistWorkspaceLayout();
    setActionStatus(tr('main.shellClosed'));
}

function restoreShellSessions() {
    shellTabs.forEach(tab => {
        tab.mouseModeSequenceCarry = '';
        tab.term.reset();
        tab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
        ipcRenderer.invoke('create-shell-tab-session', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows, profileId: tab.profileId || '' })
            .then(() => {
                tab.sessionReady = true;
                ipcRenderer.send('resize-shell-tab', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows });
            })
            .catch((error) => {
                tab.term.writeln(`\r\n[ERROR] ${tr('main.shellStartFailed', { error: error?.message || error })}\r\n`);
            });
    });
}

function createFilterTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-filter-${getNextTabId()}`;
    syncNextFilterTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    
    // 1. Create Tab Button
    const tabList = getPaneTabsList(resolvedPaneId);
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    
    // The initial title will be updated by updateTabTitles() right after
    const filterTitle = document.createElement('span');
    filterTitle.className = 'main-tab-title';
    filterTitle.textContent = tr('main.filter');
    const filterClose = document.createElement('span');
    filterClose.className = 'main-tab-close';
    filterClose.title = tr('main.closeTab');
    filterClose.appendChild(createMaterialIcon('close'));
    tabBtn.append(filterTitle, filterClose);
    
    tabBtn.onclick = (e) => {
        if (e.target.closest('.main-tab-close')) return;
        switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    tabBtn.ondblclick = (e) => {
        if (!e.target.closest('.main-tab-close')) {
            const tabState = filterTabs.find(tab => tab.id === tabId);
            if (tabState) openRenameTabDialog(tabState);
        }
    };
    
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeFilterTab(tabId);
    };
    
    tabList.appendChild(tabBtn);
    
    // 2. Create Tab Pane
    const tabContent = getPaneTabsContent(resolvedPaneId);
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;
    
    const filterHeader = document.createElement('div');
    filterHeader.className = "filter-header";
    filterHeader.innerHTML = `
        <div class="filter-input-wrapper">
            <input type="text" class="filter-input" placeholder="${tr('main.filterText')}" style="width: 100%; padding-right: 24px;">
            <button type="button" class="filter-dropdown-btn" title="${tr('main.sendHistory')}"><span class="material-icon-placeholder" data-material-icon="arrow_drop_down"></span></button>
            <div class="filter-history-dropdown"></div>
        </div>
        <div class="filter-toggles" style="display: flex; gap: 4px; margin-right: 8px;">
            <button type="button" class="filter-toggle-btn filter-case-btn" title="${tr('main.matchCase')}"><span class="material-icon-placeholder" data-material-icon="match_case"></span></button>
            <button type="button" class="filter-toggle-btn filter-word-btn" title="${tr('main.wholeWord')}"><span class="material-icon-placeholder" data-material-icon="match_word"></span></button>
            <button type="button" class="filter-toggle-btn filter-regex-btn" title="${tr('main.useRegex')}"><span class="material-icon-placeholder" data-material-icon="regular_expression"></span></button>
        </div>
        <span class="filter-mode-status" role="status"></span>
    `;
    window.MaterialIcons.upgrade(filterHeader);
    
    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    
    tabPane.appendChild(filterHeader);
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);
    
    // 3. Initialize Terminal
    const term = new Terminal({
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 20000) : 20000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    enableTerminalUnicode11(term);
    term.open(terminalWrapper);
    
    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontWeight: currentConfig.fontWeight,
            fontFamily: TERMINAL_FONT_FAMILY(currentConfig),
            theme: getTerminalTheme(currentConfig)
        };
    }
    
    // 4. Setup State and Events
    const tabState = {
        id: tabId,
        paneId: resolvedPaneId,
        term,
        fitAddon,
        searchAddon,
        filterRegex: null,
        title: initialState.title || '',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
        filterText: '',
        dataMode: initialState.dataMode === 'hex' ? 'hex' : (initialState.dataMode === 'text' ? 'text' : receiveDisplayMode),
        contextLine: null,
        element: tabPane,
        btn: tabBtn
    };
    
    const input = filterHeader.querySelector('.filter-input');
    const dropdownBtn = filterHeader.querySelector('.filter-dropdown-btn');
    const caseBtn = filterHeader.querySelector('.filter-case-btn');
    const wordBtn = filterHeader.querySelector('.filter-word-btn');
    const regexBtn = filterHeader.querySelector('.filter-regex-btn');
    const dropdownMenu = filterHeader.querySelector('.filter-history-dropdown');
    const modeStatus = filterHeader.querySelector('.filter-mode-status');
    tabState.modeStatus = modeStatus;

    input.addEventListener('focus', () => {
        suppressMainInputFocus = true;
    });

    input.addEventListener('blur', () => {
        setTimeout(() => {
            suppressMainInputFocus = document.activeElement?.classList?.contains('filter-input') === true;
        }, 0);
    });
    
    // History dropdown logic
    function renderDropdown() {
        const history = currentConfig ? (currentConfig.filterHistory || []) : [];
        dropdownMenu.innerHTML = '';
        
        if (history.length === 0) {
            dropdownMenu.innerHTML = `<div class="filter-history-item" style="color: #666; cursor: default;">${tr('common.noHistory')}</div>`;
            return;
        }
        
        history.forEach(item => {
            const div = document.createElement('div');
            div.className = 'filter-history-item';
            div.textContent = item;
            div.onclick = () => {
                input.value = item;
                updateRegex();
                dropdownMenu.classList.remove('open');
            };
            dropdownMenu.appendChild(div);
        });
    }

    dropdownBtn.onclick = (e) => {
        e.stopPropagation();
        const isShowing = dropdownMenu.classList.contains('open');

        // Hide all other dropdowns
        document.querySelectorAll('.filter-history-dropdown').forEach(d => d.classList.remove('open'));

        if (!isShowing) {
            renderDropdown();
            dropdownMenu.classList.add('open');
        }
    };

    const outsideClickListener = (e) => {
        if (!filterHeader.contains(e.target)) {
            dropdownMenu.classList.remove('open');
        }
    };
    
    // Close dropdown when clicking outside
    document.addEventListener('click', outsideClickListener);

    // Store listener to remove it later
    tabState.outsideClickListener = outsideClickListener;

    // Case Match Button Logic
    caseBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.caseSensitive = !tabState.caseSensitive;
        if (tabState.caseSensitive) {
            caseBtn.classList.add('active');
        } else {
            caseBtn.classList.remove('active');
        }
        updateRegex();
    };

    wordBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.wholeWord = !tabState.wholeWord;
        wordBtn.classList.toggle('active', tabState.wholeWord);
        updateRegex();
    };

    // Regex Button Logic
    regexBtn.onclick = (e) => {
        e.stopPropagation();
        tabState.useRegex = !tabState.useRegex;
        if (tabState.useRegex) {
            regexBtn.classList.add('active');
        } else {
            regexBtn.classList.remove('active');
        }
        updateRegex();
    };

    function updateRegex() {
        tabState.filterText = input.value;
        if (!input.value) {
            tabState.filterRegex = null;
            input.style.borderColor = 'var(--border-color)';
            persistFilterTabs();
            return;
        }
        try {
            const flags = tabState.caseSensitive ? '' : 'i';
            let pattern = input.value;
            if (!tabState.useRegex) {
                // Escape regex characters if regex mode is off
                pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            if (tabState.wholeWord) {
                pattern = `\\b(?:${pattern})\\b`;
            }
            tabState.filterRegex = new RegExp(pattern, flags);
            input.style.borderColor = 'var(--border-color)';
        } catch (e) {
            tabState.filterRegex = null;
            input.style.borderColor = 'var(--danger-color)';
        }
        persistFilterTabs({ debounce: true });
    }

    tabState.updateRegex = updateRegex;
    tabState.caseBtn = caseBtn;
    tabState.wordBtn = wordBtn;
    tabState.regexBtn = regexBtn;
    
    function saveFilterHistory(val) {
        if (!val) return;
        let history = currentConfig.filterHistory || [];
        // Remove if exists to move it to the top
        history = history.filter(item => item !== val);
        history.unshift(val);
        // Keep max 20
        if (history.length > 20) history = history.slice(0, 20);
        
        currentConfig.filterHistory = history;
        ipcRenderer.send('save-config', { filterHistory: history });
    }

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            updateRegex();
            saveFilterHistory(input.value.trim());
            dropdownMenu.classList.remove('open');
        }
    });

    input.addEventListener('blur', () => {
        // Save on blur if there's text
        if (input.value.trim()) {
            saveFilterHistory(input.value.trim());
        }
    });
    
    input.addEventListener('input', updateRegex);
    
    // Setup copy/paste for filter terminal
    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, 'serial'));
    bindTerminalContextMenu({
        terminalType: 'filter',
        term,
        element: terminalWrapper,
        getTabState: () => tabState
    });
    bindTerminalWheel(term, terminalWrapper);

    if (typeof initialState.filterText === 'string') {
        input.value = initialState.filterText;
    }
    if (initialState.caseSensitive) {
        tabState.caseSensitive = true;
        caseBtn.classList.add('active');
    }
    if (initialState.wholeWord) {
        tabState.wholeWord = true;
        wordBtn.classList.add('active');
    }
    if (initialState.useRegex) {
        tabState.useRegex = true;
        regexBtn.classList.add('active');
    }
    updateRegex();
    
    filterTabs.push(tabState);
    updateTabTitles();
    updateFilterModeStatuses();
    addTabToPane(tabId, resolvedPaneId, { activate: false, persist: false });
    if (!isRestoringWorkspaceSession) {
        switchPaneTab(resolvedPaneId, tabId, { persist: false });
        persistFilterTabs();
        persistWorkspaceLayout();
        setActionStatus(`已创建过滤标签页：${tabBtn.textContent.trim()}`);
    }
    
    // Fit terminal after a short delay to ensure DOM is rendered
    setTimeout(() => {
        fitAddon.fit();
    }, 50);
}

function closeFilterTab(tabId) {
    const index = filterTabs.findIndex(t => t.id === tabId);
    if (index > -1) {
        const tab = filterTabs[index];
        ipcRenderer.send('flush-tab-log', { tabId });
        tab.term.dispose();
        if (tab.outsideClickListener) {
            document.removeEventListener('click', tab.outsideClickListener);
        }
        tab.element.remove();
        tab.btn.remove();
        filterTabs.splice(index, 1);
        const { paneId, nextActiveTabId } = removeTabFromWorkspace(tabId, { persist: false });
        persistFilterTabs();
        
        updateTabTitles();

        const nextPaneId = nextActiveTabId ? getPaneIdForTabId(nextActiveTabId) : getPaneIdForTabId('tab-main');
        if (nextActiveTabId) {
            switchPaneTab(nextPaneId, nextActiveTabId, { persist: false });
        } else {
            switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main', { persist: false });
        }

        persistWorkspaceLayout();
        setActionStatus('已关闭过滤标签页');
    }
}

let persistFilterTabsTimer = null;

function persistFilterTabs({ debounce = false } = {}) {
    if (isApplyingConfig) return;
    const save = () => {
        persistFilterTabsTimer = null;
        const savedTabs = filterTabs.map(tab => ({
            id: tab.id,
            title: tab.title || '',
            filterText: tab.filterText || '',
            caseSensitive: tab.caseSensitive,
            wholeWord: tab.wholeWord,
            useRegex: tab.useRegex,
            dataMode: tab.dataMode,
            paneId: tab.paneId || getTabPaneId(tab.id)
        }));
        if (currentConfig) currentConfig.filterTabs = savedTabs;
        ipcRenderer.send('save-config', { filterTabs: savedTabs });
    };
    if (persistFilterTabsTimer !== null) {
        clearTimeout(persistFilterTabsTimer);
        persistFilterTabsTimer = null;
    }
    if (debounce) {
        persistFilterTabsTimer = setTimeout(save, 250);
        return;
    }
    save();
}

function updateShellTextMode(tabState) {
    if (!tabState?.btn) return;
    tabState.btn.classList.toggle('shell-text-mode', Boolean(tabState.textMode));
    tabState.btn.title = tabState.textMode ? tr('main.shellTextModeEnabled') : '';
    updateTabTitles();
}

const chartSettingsDialog = document.getElementById('chart-settings-dialog');
const chartParserMode = document.getElementById('chart-parser-mode');
const chartEncoding = document.getElementById('chart-encoding');
const chartLineMarker = document.getElementById('chart-line-marker');
const chartKeySeparator = document.getElementById('chart-key-separator');
const chartTemplateInput = document.getElementById('chart-template-input');
const chartRegexInput = document.getElementById('chart-regex-input');
const chartSampleLine = document.getElementById('chart-sample-line');
const chartSampleStatus = document.getElementById('chart-sample-status');
const chartFieldsList = document.getElementById('chart-fields-list');
const chartFieldsToggle = document.getElementById('chart-fields-toggle');
const chartFieldsSelectedCount = document.getElementById('chart-fields-selected-count');
const chartYAxisMode = document.getElementById('chart-y-axis-mode');
const chartYMin = document.getElementById('chart-y-min');
const chartYMax = document.getElementById('chart-y-max');
const chartYMargin = document.getElementById('chart-y-margin');
const chartYIncludeZero = document.getElementById('chart-y-include-zero');
const chartWindowDuration = document.getElementById('chart-window-duration');
const chartMaxPoints = document.getElementById('chart-max-points');
const chartMaxDuration = document.getElementById('chart-max-duration');
const chartParsingGuideDialog = document.getElementById('chart-parsing-guide-dialog');
const chartParsingGuideOpen = document.getElementById('chart-parsing-guide-open');
const chartParsingGuideClose = document.getElementById('chart-parsing-guide-close');
const chartParsingGuideDone = document.getElementById('chart-parsing-guide-done');
const chartExportDialog = document.getElementById('chart-export-dialog');
const chartExportStatus = document.getElementById('chart-export-status');
const chartExportWindow = document.getElementById('chart-export-window');
const chartExportAll = document.getElementById('chart-export-all');
let chartSettingsState = null;
let chartExportState = null;
let chartParsingGuideTrigger = null;

function serializeChartTab(tab) {
    return {
        id: tab.id,
        paneId: tab.paneId || getTabPaneId(tab.id),
        title: tab.title || '',
        encoding: tab.encoding || 'utf8',
        parserMode: tab.parserMode || 'key-value',
        sampleLine: tab.sampleLine || '',
        lineMarker: tab.lineMarker || '',
        keyValueSeparator: ['=', ':', 'auto'].includes(tab.keyValueSeparator) ? tab.keyValueSeparator : 'auto',
        template: tab.template || '',
        pattern: tab.pattern || '',
        fields: (tab.fields || []).map(field => ({ ...field })),
        windowDurationMs: tab.windowDurationMs || 60000,
        maxPoints: tab.maxPoints || 200000,
        maxDurationMs: tab.maxDurationMs || 1800000,
        yAxisMode: tab.yAxisMode === 'fixed' ? 'fixed' : 'auto',
        yMin: tab.yMin,
        yMax: tab.yMax,
        yIncludeZero: tab.yIncludeZero === true,
        yMargin: tab.yMargin ?? 0.08
    };
}

function updateChartStats(tab) {
    if (!tab.stats || !tab.model || !tab.view?.viewRange) return;
    const [start, end] = tab.view.viewRange;
    const estimated = tab.summaryHistory;
    tab.stats.replaceChildren();
    tab.model.fields.forEach(field => {
        const stats = estimated ? tab.model.overviewStats(field.key, start, end) : tab.model.stats(field.key, start, end);
        if (!stats) return;
        const precision = field.precision ?? 2;
        const unit = field.displayUnit ? ` ${field.displayUnit}` : '';
        const item = document.createElement('span');
        item.className = 'chart-series-stat';
        item.innerHTML = `<span class="chart-series-swatch"></span><strong></strong> cur ${Number(stats.current).toFixed(precision)}${unit} · min ${Number(stats.min).toFixed(precision)} · max ${Number(stats.max).toFixed(precision)} · avg ${Number(stats.average).toFixed(precision)}`;
        item.querySelector('.chart-series-swatch').style.backgroundColor = field.color;
        item.querySelector('strong').textContent = field.label || field.key;
        tab.stats.appendChild(item);
    });
    if (estimated) {
        const note = document.createElement('span');
        note.className = 'chart-stats-estimated';
        note.textContent = tr('main.chartStatsEstimated');
        tab.stats.appendChild(note);
    }
}

function clearChartDataSession(tab) {
    tab.stream?.reset();
    tab.parserWorker?.reset();
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.summaryHistory = false;
    tab.model?.clear();
    tab.stats?.replaceChildren();
    tab.view?.setData([[], ...(tab.model?.fields || []).map(() => [])]);
    updateChartStatus(tab);
}

function closeChartExport() {
    chartExportState = null;
    chartExportDialog.classList.add('hidden');
}

function openChartExport(tab) {
    if (!tab.model?.samples.length) {
        setActionStatus(tr('main.chartNoExportData'));
        return;
    }
    chartExportState = tab;
    const range = tab.view?.viewRange;
    const windowSamples = range ? tab.model.query(range[0], range[1]) : [];
    chartExportWindow.disabled = windowSamples.length === 0;
    chartExportAll.disabled = tab.model.samples.length === 0;
    chartExportStatus.textContent = windowSamples.length
        ? tr('main.chartExportWindowCount', { count: windowSamples.length }) + (tab.summaryHistory ? tr('main.chartExportSummaryWarning') : '')
        : tr('main.chartExportNoWindowData');
    chartExportDialog.classList.remove('hidden');
    (chartExportWindow.disabled ? chartExportAll : chartExportWindow).focus();
}

async function exportChartSamples(scope, targetTab = chartExportState) {
    const tab = targetTab;
    if (!tab?.model) return;
    const range = tab.view?.viewRange;
    const samples = scope === 'window' && range ? tab.model.query(range[0], range[1]) : tab.model.samples;
    if (!samples.length) return;
    const suffix = scope === 'window' ? tr('main.chartExportWindow') : tr('main.chartExportAll');
    const result = await ipcRenderer.invoke('save-chart-csv', {
        title: `${tab.title || tr('main.chart')} ${suffix}`,
        content: buildChartCsv(samples, tab.model.fields)
    });
    if (result?.filePath) setActionStatus(`${tr('main.chartExported')}: ${result.filePath}`);
    if (tab === chartExportState) closeChartExport();
}

function persistChartTabs() {
    if (isApplyingConfig) return;
    const savedTabs = chartTabs.map(serializeChartTab);
    if (currentConfig) currentConfig.chartTabs = savedTabs;
    ipcRenderer.send('save-config', { chartTabs: savedTabs });
}

function getChartParserConfig(tab) {
    return {
        mode: tab.parserMode,
        marker: tab.lineMarker,
        keyValueSeparator: tab.keyValueSeparator,
        template: tab.template,
        pattern: tab.pattern,
        fields: tab.fields
    };
}

function updateChartStatus(tab) {
    if (!tab.status) return;
    tab.status.classList.toggle('error', Boolean(tab.parserError));
    if (tab.parserError) {
        tab.status.textContent = tab.parserError;
        return;
    }
    if (tab.paused) {
        tab.status.textContent = tr('main.chartPaused');
        return;
    }
    if (!tab.fields?.some(field => field.role === 'series' && field.visible !== false)) {
        tab.status.textContent = tr('main.chartNoFields');
        return;
    }
    if (!tab.model?.samples.length) {
        tab.status.textContent = tr('main.chartWaiting');
        return;
    }
    const details = [`${tab.model.samples.length.toLocaleString()} ${tr('main.chartSamples')}`];
    if (tab.parserDropped) details.push(`${tab.parserDropped.toLocaleString()} ${tr('main.chartDropped')}`);
    if (tab.summaryHistory) details.push(tr('main.chartSummaryHistory'));
    tab.status.textContent = details.join(' · ');
}

function toggleChartPaused(tab) {
    tab.paused = !tab.paused;
    tab.stream?.reset();
    tab.parserWorker?.reset();
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.pauseButton.title = tr(tab.paused ? 'main.chartResume' : 'main.chartPause');
    tab.pauseButton.replaceChildren(createMaterialIcon(tab.paused ? 'play_arrow' : 'pause'));
    updateChartStatus(tab);
}

function scheduleChartRender(tab) {
    if (!tab || tab.closed || tab.renderFrame !== null || !isTabActive(tab.id)) return;
    tab.renderFrame = requestAnimationFrame(() => {
        tab.renderFrame = null;
        if (!tab.view || !tab.model) return;
        tab.view.setData(tab.model.toAlignedData(), tab.model.toOverviewAlignedData());
        updateChartStatus(tab);
        updateChartStats(tab);
    });
}

function configureChartTab(tab) {
    tab.stream?.dispose();
    tab.parserWorker?.close();
    tab.view?.destroy();
    tab.plotArea.replaceChildren();
    tab.timelineHost.replaceChildren();
    tab.model = null;
    tab.parserWorker = null;
    tab.view = null;
    tab.parserError = '';
    tab.parserDropped = 0;
    tab.summaryHistory = false;
    const activeFields = (tab.fields || []).filter(field => field.role === 'sequence' || field.visible !== false);
    if (!activeFields.some(field => field.role !== 'sequence')) {
        updateChartStatus(tab);
        return;
    }
    tab.status.classList.remove('error');
    tab.model = new ChartDataModel({ fields: activeFields, maxPoints: tab.maxPoints, maxDurationMs: tab.maxDurationMs });
    tab.parserWorker = new ChartParserIpcClient({
        config: { ...getChartParserConfig(tab), fields: activeFields },
        onSamples: samples => {
            if (tab.closed) return;
            tab.parserError = '';
            let changed = false;
            samples.forEach(sample => { if (tab.model?.append(sample)) changed = true; });
            if (changed) scheduleChartRender(tab);
            else updateChartStatus(tab);
        },
        onError: error => {
            if (tab.closed) return;
            tab.parserError = error.message;
            updateChartStatus(tab);
        },
        onStats: stats => {
            tab.parserDropped = stats.dropped;
            updateChartStatus(tab);
        }
    });
    tab.stream = new SerialTextStream({
        encoding: tab.encoding,
        onRecord: record => {
            if (tab.closed || tab.paused || record.partial) return;
            tab.parserWorker?.push(record);
        }
    });
    tab.view = new ChartView({
        uPlot,
        mainHost: tab.plotArea,
        timelineHost: tab.timelineHost,
        navigator: tab.navigator,
        fields: activeFields,
        windowDurationMs: tab.windowDurationMs,
        yAxis: { mode: tab.yAxisMode, min: tab.yMin, max: tab.yMax, includeZero: tab.yIncludeZero, margin: tab.yMargin },
        onFollowChange: following => tab.liveButton.classList.toggle('hidden', following),
        onDataModeChange: summaryHistory => {
            tab.summaryHistory = summaryHistory;
            updateChartStatus(tab);
        },
        onViewRangeChange: () => updateChartStats(tab)
    });
    updateChartStatus(tab);
}

function createChartTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-chart-${getNextChartTabId()}`;
    syncNextChartTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const tabBtn = document.createElement('button');
    tabBtn.className = 'main-tab';
    tabBtn.type = 'button';
    tabBtn.id = `${tabId}-button`;
    tabBtn.setAttribute('role', 'tab');
    tabBtn.setAttribute('aria-controls', tabId);
    tabBtn.setAttribute('aria-selected', 'false');
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    const title = document.createElement('span');
    title.className = 'main-tab-title';
    title.textContent = tr('main.chart');
    const close = document.createElement('span');
    close.className = 'main-tab-close';
    close.title = tr('main.closeTab');
    close.appendChild(createMaterialIcon('close'));
    tabBtn.append(title, close);
    getPaneTabsList(resolvedPaneId).appendChild(tabBtn);

    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane chart-tab';
    tabPane.id = tabId;
    tabPane.setAttribute('role', 'tabpanel');
    tabPane.setAttribute('aria-labelledby', tabBtn.id);
    tabPane.dataset.paneId = resolvedPaneId;
    tabPane.innerHTML = `
        <div class="chart-toolbar">
            <div class="chart-status" role="status"></div>
            <div class="chart-toolbar-actions">
                <button class="secondary chart-settings-btn" type="button" title="${tr('main.chartSettings')}"><span class="material-icon-placeholder" data-material-icon="settings"></span></button>
                <button class="secondary chart-pause-btn" type="button" title="${tr('main.chartPause')}"><span class="material-icon-placeholder" data-material-icon="pause"></span></button>
                <button class="secondary chart-clear-btn" type="button" title="${tr('main.chartClear')}"><span class="material-icon-placeholder" data-material-icon="delete_sweep"></span></button>
                <button class="secondary chart-export-btn" type="button" title="${tr('main.chartExport')}"><span class="material-icon-placeholder" data-material-icon="save"></span></button>
                <button class="secondary chart-live-btn hidden" type="button"><span class="material-icon-placeholder" data-material-icon="update"></span><span>${tr('main.chartLive')}</span></button>
            </div>
        </div>
        <div class="chart-series-stats"></div>
        <div class="chart-main-host"></div>
        <div class="chart-timeline-shell">
            <div class="chart-timeline-host"></div>
            <div class="chart-navigator"><div class="chart-navigator-window" role="slider" tabindex="0" aria-label="Chart time window" hidden><span class="chart-navigator-handle start"></span><span class="chart-navigator-handle end"></span></div></div>
        </div>`;
    window.MaterialIcons.upgrade(tabPane);
    getPaneTabsContent(resolvedPaneId).appendChild(tabPane);

    const tab = {
        id: tabId, paneId: resolvedPaneId, title: initialState.title || '', element: tabPane, btn: tabBtn,
        encoding: initialState.encoding || receiveEncoding || 'utf8', parserMode: initialState.parserMode || 'key-value',
        sampleLine: initialState.sampleLine || '', lineMarker: initialState.lineMarker || '',
        keyValueSeparator: ['=', ':', 'auto'].includes(initialState.keyValueSeparator) ? initialState.keyValueSeparator : 'auto', template: initialState.template || '', pattern: initialState.pattern || '',
        fields: Array.isArray(initialState.fields) ? initialState.fields.map(field => ({ ...field })) : [],
        windowDurationMs: initialState.windowDurationMs || 60000, maxPoints: initialState.maxPoints || 200000,
        maxDurationMs: initialState.maxDurationMs || 1800000, paused: false, closed: false, renderFrame: null,
        yAxisMode: initialState.yAxisMode === 'fixed' ? 'fixed' : 'auto', yMin: Number(initialState.yMin ?? 0), yMax: Number(initialState.yMax ?? 100),
        yIncludeZero: initialState.yIncludeZero === true, yMargin: Number(initialState.yMargin ?? 0.08),
        parserWorker: null, parserError: '', parserDropped: 0, summaryHistory: false,
        status: tabPane.querySelector('.chart-status'), stats: tabPane.querySelector('.chart-series-stats'), plotArea: tabPane.querySelector('.chart-main-host'),
        timelineHost: tabPane.querySelector('.chart-timeline-host'), navigator: tabPane.querySelector('.chart-navigator'),
        liveButton: tabPane.querySelector('.chart-live-btn'), pauseButton: tabPane.querySelector('.chart-pause-btn')
    };
    tabBtn.onclick = event => {
        if (!event.target.closest('.main-tab-close')) switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    close.onclick = () => closeChartTab(tabId);
    tabBtn.ondblclick = event => { if (!event.target.closest('.main-tab-close')) openRenameTabDialog(tab); };
    tabPane.querySelector('.chart-settings-btn').onclick = () => openChartSettings(tab);
    tab.pauseButton.onclick = () => toggleChartPaused(tab);
    tabPane.querySelector('.chart-clear-btn').onclick = () => {
        clearChartDataSession(tab);
    };
    tabPane.querySelector('.chart-export-btn').onclick = () => openChartExport(tab);
    tab.liveButton.onclick = () => tab.view?.returnToLive();
    bindChartContextMenu(tab);

    chartTabs.push(tab);
    updateTabTitles();
    addTabToPane(tabId, resolvedPaneId, { activate: false, persist: false });
    if (tab.fields.length) configureChartTab(tab);
    else updateChartStatus(tab);
    if (!isRestoringWorkspaceSession) {
        switchPaneTab(resolvedPaneId, tabId, { persist: false });
        persistChartTabs();
        persistWorkspaceLayout();
        setTimeout(() => openChartSettings(tab), 0);
    }
    return tab;
}

function closeChartTab(tabId) {
    const index = chartTabs.findIndex(tab => tab.id === tabId);
    if (index < 0) return;
    const tab = chartTabs[index];
    tab.closed = true;
    if (tab.renderFrame !== null) cancelAnimationFrame(tab.renderFrame);
    tab.stream?.dispose();
    tab.parserWorker?.close();
    tab.view?.destroy();
    tab.element.remove();
    tab.btn.remove();
    chartTabs.splice(index, 1);
    const { nextActiveTabId } = removeTabFromWorkspace(tabId, { persist: false });
    persistChartTabs();
    updateTabTitles();
    const nextId = nextActiveTabId || 'tab-main';
    switchPaneTab(getPaneIdForTabId(nextId), nextId, { persist: false });
    persistWorkspaceLayout();
}

function renderChartFieldCandidates(fields) {
    chartFieldsList.replaceChildren();
    if (!fields.length) {
        const empty = document.createElement('div');
        empty.className = 'chart-fields-empty';
        empty.textContent = tr('main.chartNoFields');
        chartFieldsList.appendChild(empty);
        updateChartFieldSelectionState();
        return;
    }
    fields.forEach(field => {
        const row = document.createElement('div');
        row.className = 'chart-field-row';
        row.dataset.key = field.key;
        row.setAttribute('role', 'row');
        row.innerHTML = `<label class="chart-field-visible-cell"><input class="chart-field-visible" type="checkbox" ${field.visible ? 'checked' : ''}><span class="visually-hidden"></span></label>
            <span class="chart-field-key" role="cell"></span><input class="chart-field-label" type="text"><input class="chart-field-color" type="color">
            <span class="chart-field-value"></span><input class="chart-field-unit" type="text">
            <select class="chart-field-display-unit"><option value="">-</option><option value="us">us</option><option value="ms">ms</option><option value="s">s</option></select>
            <input class="chart-field-precision" type="number" min="0" max="8" title="${tr('main.chartPrecision')}">`;
        row.querySelector('.chart-field-key').textContent = field.key;
        row.querySelector('.chart-field-visible').setAttribute('aria-label', `${tr('main.chartFieldVisible')}: ${field.key}`);
        row.querySelector('.chart-field-value').textContent = String(field.sampleValue);
        row.querySelector('.chart-field-unit').value = field.sourceUnit || '';
        row.querySelector('.chart-field-label').value = field.label || field.key;
        row.querySelector('.chart-field-color').value = field.color || '#4fc3f7';
        row.querySelector('.chart-field-display-unit').value = field.displayUnit || '';
        row.querySelector('.chart-field-precision').value = field.precision ?? 2;
        row._field = field;
        chartFieldsList.appendChild(row);
    });
    updateChartFieldSelectionState();
}

function updateChartFieldSelectionState() {
    const checkboxes = Array.from(chartFieldsList.querySelectorAll('.chart-field-visible'));
    const selected = checkboxes.filter(checkbox => checkbox.checked).length;
    const selectable = Math.min(16, checkboxes.length);
    chartFieldsSelectedCount.textContent = tr('main.chartFieldsSelected', { count: selected, max: 16 });
    chartFieldsSelectedCount.classList.toggle('limit', selected >= 16);
    chartFieldsToggle.checked = selectable > 0 && selected === selectable;
    chartFieldsToggle.indeterminate = selected > 0 && selected < selectable;
    chartFieldsToggle.disabled = checkboxes.length === 0;
}

function mergeChartFieldPreferences(fields, savedFields = []) {
    const savedByKey = new Map(savedFields.map(field => [field.key, field]));
    return fields.map(field => {
        const saved = savedByKey.get(field.key);
        return saved ? { ...field, ...saved, sampleValue: field.sampleValue, type: field.type, sourceUnit: saved.sourceUnit || field.sourceUnit } : field;
    });
}

function readChartDialogConfig() {
    return {
        mode: chartParserMode.value,
        marker: chartLineMarker.value,
        keyValueSeparator: chartKeySeparator.value,
        template: chartTemplateInput.value,
        pattern: chartRegexInput.value
    };
}

function updateChartSettingsMode() {
    document.getElementById('chart-separator-group').classList.toggle('hidden', chartParserMode.value !== 'key-value');
    document.getElementById('chart-template-group').classList.toggle('hidden', chartParserMode.value !== 'template');
    document.getElementById('chart-regex-group').classList.toggle('hidden', chartParserMode.value !== 'regex');
    document.querySelectorAll('.chart-y-fixed').forEach(element => element.classList.toggle('hidden', chartYAxisMode.value !== 'fixed'));
    const fixedYAxis = chartYAxisMode.value === 'fixed';
    chartYMargin.disabled = fixedYAxis;
    chartYIncludeZero.disabled = fixedYAxis;
    chartYIncludeZero.closest('.chart-checkbox-setting')?.classList.toggle('disabled', fixedYAxis);
}

let chartDiscoveryTimer = null;
let chartDiscoveryRequest = 0;

async function discoverChartDialogFields() {
    const request = ++chartDiscoveryRequest;
    try {
        chartSampleStatus.textContent = tr('main.chartParsingSample');
        chartSampleStatus.className = 'input-validation';
        const fields = mergeChartFieldPreferences(
            await discoverChartFieldsInWorker(chartSampleLine.value, readChartDialogConfig()),
            chartSettingsState?.fields || []
        );
        if (request !== chartDiscoveryRequest || !chartSettingsState) return;
        renderChartFieldCandidates(fields);
        chartSampleStatus.textContent = fields.length ? tr('main.chartFieldsFound', { count: fields.length }) : tr('main.chartNoFields');
        chartSampleStatus.className = `input-validation ${fields.length ? 'valid' : 'invalid'}`;
    } catch (error) {
        if (request !== chartDiscoveryRequest || !chartSettingsState) return;
        renderChartFieldCandidates([]);
        chartSampleStatus.textContent = error.message;
        chartSampleStatus.className = 'input-validation invalid';
    }
}

function openChartSettings(tab) {
    chartSettingsState = tab;
    chartParserMode.value = tab.parserMode;
    chartEncoding.value = tab.encoding;
    chartLineMarker.value = tab.lineMarker;
    chartKeySeparator.value = tab.keyValueSeparator;
    chartTemplateInput.value = tab.template;
    chartRegexInput.value = tab.pattern;
    chartSampleLine.value = tab.sampleLine;
    chartYAxisMode.value = tab.yAxisMode;
    chartYMin.value = tab.yMin;
    chartYMax.value = tab.yMax;
    chartYMargin.value = Math.round(tab.yMargin * 100);
    chartYIncludeZero.checked = tab.yIncludeZero;
    chartWindowDuration.value = Math.round(tab.windowDurationMs / 1000);
    chartMaxPoints.value = tab.maxPoints;
    chartMaxDuration.value = Math.round(tab.maxDurationMs / 60000);
    updateChartSettingsMode();
    if (tab.sampleLine) discoverChartDialogFields();
    else renderChartFieldCandidates(tab.fields || []);
    chartSettingsDialog.classList.remove('hidden');
    chartSampleLine.focus();
}

function closeChartSettings() {
    chartDiscoveryRequest++;
    clearTimeout(chartDiscoveryTimer);
    chartDiscoveryTimer = null;
    chartSettingsState = null;
    chartSettingsDialog.classList.add('hidden');
}

function openChartParsingGuide() {
    chartParsingGuideTrigger = document.activeElement;
    chartParsingGuideDialog.classList.remove('hidden');
    chartParsingGuideClose.focus();
}

function closeChartParsingGuide() {
    chartParsingGuideDialog.classList.add('hidden');
    chartParsingGuideTrigger?.focus();
    chartParsingGuideTrigger = null;
}

async function saveChartSettings() {
    const tab = chartSettingsState;
    if (!tab) return;
    const fields = Array.from(chartFieldsList.querySelectorAll('.chart-field-row')).map(row => {
        const field = row._field;
        const visible = row.querySelector('.chart-field-visible').checked;
        return {
            ...field,
            visible,
            role: field.role === 'sequence' && !visible ? 'sequence' : 'series',
            label: row.querySelector('.chart-field-label').value.trim() || field.key,
            color: row.querySelector('.chart-field-color').value,
            sourceUnit: row.querySelector('.chart-field-unit').value.trim(),
            displayUnit: row.querySelector('.chart-field-display-unit').value,
            precision: Math.max(0, Math.min(8, Number(row.querySelector('.chart-field-precision').value) || 0))
        };
    });
    const activeFields = fields.filter(field => field.role === 'series' && field.visible);
    const invalidUnit = activeFields.some(field => field.displayUnit && field.sourceUnit !== field.displayUnit && (!['us', 'ms', 's'].includes(field.sourceUnit) || !['us', 'ms', 's'].includes(field.displayUnit)));
    const yMin = Number(chartYMin.value);
    const yMax = Number(chartYMax.value);
    const invalidYAxis = chartYAxisMode.value === 'fixed' && (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMin >= yMax);
    if (!activeFields.length || activeFields.length > 16 || invalidUnit || invalidYAxis) {
        chartSampleStatus.textContent = !activeFields.length
            ? tr('main.chartSelectField')
            : activeFields.length > 16
                ? tr('main.chartTooManyFields', { max: 16 })
                : invalidUnit
                    ? tr('main.chartInvalidUnit')
                    : tr('main.chartInvalidYAxis');
        chartSampleStatus.className = 'input-validation invalid';
        return;
    }
    try {
        const discovered = await discoverChartFieldsInWorker(chartSampleLine.value, readChartDialogConfig());
        if (!discovered.length || activeFields.some(field => !discovered.some(candidate => candidate.key === field.key))) {
            throw new Error(tr('main.chartSampleInvalid'));
        }
    } catch (error) {
        chartSampleStatus.textContent = error.message;
        chartSampleStatus.className = 'input-validation invalid';
        return;
    }
    if (tab !== chartSettingsState) return;
    tab.parserMode = chartParserMode.value;
    tab.encoding = chartEncoding.value;
    tab.lineMarker = chartLineMarker.value;
    tab.keyValueSeparator = chartKeySeparator.value;
    tab.template = chartTemplateInput.value;
    tab.pattern = chartRegexInput.value;
    tab.sampleLine = chartSampleLine.value;
    tab.fields = fields;
    tab.yAxisMode = chartYAxisMode.value;
    tab.yMin = yMin;
    tab.yMax = yMax;
    tab.yIncludeZero = chartYIncludeZero.checked;
    tab.yMargin = Math.max(0, Math.min(1, Number(chartYMargin.value) / 100 || 0));
    tab.windowDurationMs = Math.max(1000, Math.min(86400000, Number(chartWindowDuration.value) * 1000 || 60000));
    tab.maxPoints = Math.max(1000, Math.min(1000000, Number(chartMaxPoints.value) || 200000));
    tab.maxDurationMs = Math.max(60000, Math.min(86400000, Number(chartMaxDuration.value) * 60000 || 1800000));
    configureChartTab(tab);
    persistChartTabs();
    closeChartSettings();
    scheduleChartRender(tab);
}

[chartParserMode, chartLineMarker, chartKeySeparator, chartTemplateInput, chartRegexInput, chartSampleLine].forEach(element => {
    element?.addEventListener('input', () => {
        updateChartSettingsMode();
        clearTimeout(chartDiscoveryTimer);
        chartDiscoveryTimer = setTimeout(discoverChartDialogFields, 150);
    });
});
chartYAxisMode?.addEventListener('change', updateChartSettingsMode);
chartFieldsList?.addEventListener('change', event => {
    if (event.target.classList.contains('chart-field-visible')) updateChartFieldSelectionState();
});
chartFieldsToggle?.addEventListener('change', () => {
    const checkboxes = Array.from(chartFieldsList.querySelectorAll('.chart-field-visible'));
    checkboxes.forEach((checkbox, index) => { checkbox.checked = chartFieldsToggle.checked && index < 16; });
    updateChartFieldSelectionState();
});
document.getElementById('chart-settings-close')?.addEventListener('click', closeChartSettings);
document.getElementById('chart-settings-cancel')?.addEventListener('click', closeChartSettings);
document.getElementById('chart-settings-save')?.addEventListener('click', saveChartSettings);
chartParsingGuideOpen?.addEventListener('click', openChartParsingGuide);
chartParsingGuideClose?.addEventListener('click', closeChartParsingGuide);
chartParsingGuideDone?.addEventListener('click', closeChartParsingGuide);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !chartParsingGuideDialog?.classList.contains('hidden')) closeChartParsingGuide();
});
document.getElementById('chart-export-close')?.addEventListener('click', closeChartExport);
chartExportWindow?.addEventListener('click', () => exportChartSamples('window'));
chartExportAll?.addEventListener('click', () => exportChartSamples('all'));

function openRenameTabDialog(tabState) {
    if (!tabState) return;
    renameTabState = tabState;
    renameTabInput.value = tabState.title || '';
    renameTabDialog.classList.remove('hidden');
    renameTabInput.focus();
    renameTabInput.select();
}

function closeRenameTabDialog() {
    renameTabState = null;
    renameTabDialog.classList.add('hidden');
}

function saveRenamedTab() {
    if (!renameTabState) return;
    renameTabState.title = renameTabInput.value.trim();
    updateTabTitles();
    if (filterTabs.includes(renameTabState)) persistFilterTabs();
    if (shellTabs.includes(renameTabState)) persistShellTabs();
    if (chartTabs.includes(renameTabState)) persistChartTabs();
    closeRenameTabDialog();
}

document.getElementById('rename-tab-dialog-close').addEventListener('click', closeRenameTabDialog);
document.getElementById('rename-tab-dialog-cancel').addEventListener('click', closeRenameTabDialog);
document.getElementById('rename-tab-dialog-save').addEventListener('click', saveRenamedTab);
renameTabInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') saveRenamedTab();
    if (event.key === 'Escape') closeRenameTabDialog();
});

document.getElementById('pane-1-new-filter-tab-btn')?.addEventListener('click', () => createFilterTab({}, 'pane-1'));
document.getElementById('pane-2-new-filter-tab-btn')?.addEventListener('click', () => createFilterTab({}, 'pane-2'));
document.getElementById('pane-1-new-shell-tab-btn')?.addEventListener('click', () => createShellTab({ profileId: getDefaultShellProfileId() }, 'pane-1'));
document.getElementById('pane-2-new-shell-tab-btn')?.addEventListener('click', () => createShellTab({ profileId: getDefaultShellProfileId() }, 'pane-2'));
document.getElementById('pane-1-new-chart-tab-btn')?.addEventListener('click', () => createChartTab({}, 'pane-1'));
document.getElementById('pane-2-new-chart-tab-btn')?.addEventListener('click', () => createChartTab({}, 'pane-2'));

document.querySelectorAll('.workspace-pane').forEach(paneEl => {
    paneEl.addEventListener('mousedown', () => {
        setActivePane(paneEl.dataset.paneId);
    });
});

window.addEventListener('main-tab-changed', (e) => {
    const tabId = e.detail.tabId;
    const paneId = e.detail.paneId || getPaneIdForTabId(tabId);
    setTimeout(() => {
        if (tabId === 'tab-main') {
            serialFitAddon.fit();
        } else {
            const tab = filterTabs.find(t => t.id === tabId);
            if (tab) {
                tab.fitAddon.fit();
            } else {
                const shellTab = getShellTabState(tabId);
                if (shellTab) {
                    shellTab.fitAddon.fit();
                    ipcRenderer.send('resize-shell-tab', { tabId: shellTab.id, cols: shellTab.term.cols, rows: shellTab.term.rows });
                } else {
                    const chartTab = getChartTabState(tabId);
                    if (chartTab) {
                        chartTab.view?.resize();
                        scheduleChartRender(chartTab);
                    }
                }
            }
        }
        setActivePane(paneId, { persist: false });
    }, 0);
});

function createTerminalKeyHandler(targetTerm, terminalType = 'serial') {
    return (arg) => {
        if (arg.type !== 'keydown') return true;

        const ctrlKey = arg.ctrlKey;
        const key = arg.key.toLowerCase();

        if (ctrlKey && key === 'c') {
            if (targetTerm.hasSelection()) {
                navigator.clipboard.writeText(targetTerm.getSelection());
                return false;
            }
            return true;
        }

        if (ctrlKey && key === 'v') {
            if (terminalType === 'shell') return false;
            navigator.clipboard.readText().then(text => {
                if (!text) return;
                sendSerialRequest({ mode: 'text', content: text, source: 'paste' }, SEND_LIMITS.paste);
            });
            return false;
        }

        return true;
    };
}

// Smart Copy/Paste Handling
serialTerm.attachCustomKeyEventHandler(createTerminalKeyHandler(serialTerm, 'serial'));
ipcRenderer.on('terminal-context-menu-action', (event, payload) => {
    suppressMainInputFocus = true;
    handleTerminalContextMenuAction(payload)
        .catch(console.error)
        .finally(() => {
            setTimeout(() => {
                suppressMainInputFocus = document.activeElement?.classList?.contains('filter-input') === true;
            }, 0);
        });
});

let mainInputHistory = [];
let mainInputHistoryIndex = -1;
let mainInputHistoryDraft = null;
let mainInputHistoryLimit = 20;
const mainInputDrafts = { text: '', hex: '' };
let mainInputMode = 'text';

function validateSendContent(mode, content, encoding, maxBytes) {
    if (mode === 'hex') return parseHexInput(content, { maxBytes });
    if (!content) return { ok: false, code: 'EMPTY_INPUT', message: 'Input is empty', position: 0 };
    const result = buildSerialWriteBuffer({ mode: 'text', content, encoding }, { maxBytes });
    return result.ok ? { ...result, normalized: content } : result;
}

function formatValidation(result, mode, appendCrLf = false) {
    if (!result.ok) {
        const suffix = result.token ? `: ${result.token}` : (Number.isInteger(result.position) ? ` @ ${result.position + 1}` : '');
        return trFallback(`main.hexError.${result.code}`, result.message || result.code) + suffix;
    }
    const count = result.byteCount + (appendCrLf ? 2 : 0);
    return mode === 'hex'
        ? trFallback('main.hexValidBytes', 'Valid Hex, {count} bytes', { count })
        : trFallback('main.textCountBytes', '{chars} characters, {count} bytes', { chars: String(result.normalized).length, count });
}

async function sendSerialRequest(request, maxBytes = SEND_LIMITS.main, { silent = false } = {}) {
    if (!isConnected) {
        const result = { ok: false, code: 'SERIAL_NOT_OPEN', message: trFallback('main.serialNotOpen', 'Serial port is not connected') };
        if (!silent) setActionStatus(result.message);
        return result;
    }
    const profileRequest = {
        ...request,
        mode: request.mode === 'hex' ? 'hex' : 'text',
        encoding: sendEncoding,
        appendCrLf: request.source === 'terminal' ? false : request.appendCrLf === true
    };
    const validation = validateSendContent(profileRequest.mode, profileRequest.content, profileRequest.encoding, maxBytes - (profileRequest.appendCrLf ? 2 : 0));
    if (!validation.ok) {
        if (!silent) setActionStatus(formatValidation(validation, profileRequest.mode));
        return validation;
    }
    try {
        const requestSessionId = serialSessionId;
        const writeRequest = {
            mode: profileRequest.mode, content: profileRequest.content,
            encoding: profileRequest.encoding, appendCrLf: profileRequest.appendCrLf,
            source: request.source || 'renderer', terminalEnter: request.terminalEnter === true,
            newlineMode: request.newlineMode || newlineMode, sessionId: requestSessionId
        };
        const pendingWrite = serialWriteChain.then(() => {
            if (!isConnected || requestSessionId !== serialSessionId) {
                return { ok: false, code: 'STALE_SERIAL_SESSION', message: 'Serial connection has changed' };
            }
            return ipcRenderer.invoke('serial-write', writeRequest);
        });
        serialWriteChain = pendingWrite.catch(() => undefined);
        const result = await pendingWrite;
        if (!silent) setActionStatus(result.ok
            ? trFallback('main.bytesSent', 'Sent {count} bytes', { count: result.bytesWritten })
            : trFallback('main.serialWriteFailed', 'Write failed: {error}', { error: result.message || result.code }));
        return result;
    } catch (error) {
        const result = { ok: false, code: 'SERIAL_WRITE_FAILED', message: error?.message || String(error) };
        if (!silent) setActionStatus(trFallback('main.serialWriteFailed', 'Write failed: {error}', { error: result.message }));
        return result;
    }
}

function putTextInMainInput(text, mode = mainInputMode) {
    switchMainInputMode(mode, { persist: true });
    mainSendInput.value = text;
    mainInputDrafts[mode] = text;
    updateMainInputState();
    setMainInputPanelVisible(true, true);
    focusMainInput();
}

function updateMainInputHeight() {
    if (!mainSendInput) return;
    mainSendInput.style.height = 'auto';
    mainSendInput.style.height = `${Math.min(mainSendInput.scrollHeight, 180)}px`;
}

function setLastSentPreview(text) {
    if (!mainSendLast) return;
    if (!text) {
        mainSendLast.textContent = tr('main.lastSentNone');
        return;
    }
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const [firstLine = ''] = normalized.split('\n');
    const preview = `${firstLine}${normalized.includes('\n') ? '…' : ''}`;
    mainSendLast.textContent = tr('main.lastSent', { value: preview || tr('common.none') });
}

function setMainInputPanelVisible(visible, persist = true) {
    if (!mainInputPanel) return;
    mainInputPanel.classList.toggle('hidden', !visible);
    toggleMainInputBtn?.classList.toggle('active', visible);
    sidebarInputBtn?.classList.toggle('active', visible);
    fitWorkspaceTerminals();

    if (persist) {
        saveMainInputSettings();
    }

}

function setSidebarCollapsed(collapsed, persist = true) {
    hideQuickSendDisconnectedToast();
    const isCollapsed = collapsed === true;
    sidebar?.classList.toggle('sidebar-collapsed', isCollapsed);
    if (sidebarExpandBtn) {
        sidebarExpandBtn.title = tr(isCollapsed ? 'main.expandSidebar' : 'main.collapseSidebar');
        sidebarExpandBtn.setAttribute('aria-label', sidebarExpandBtn.title);
    }
    if (persist && !isApplyingConfig) {
        ipcRenderer.send('save-config', { sidebarCollapsed: isCollapsed });
    }
    fitWorkspaceTerminals();
}

function toggleShellSidebar() {
    if (!shellSidebar) return;
    const isHidden = shellSidebar.classList.contains('hidden');
    shellSidebar.classList.toggle('hidden', !isHidden);
    toggleShellSidebarBtn?.classList.toggle('active', isHidden);
    sidebarShellBtn?.classList.toggle('active', isHidden);
}

function updateShellSessionList() {
    if (!shellSessionList) return;
    const items = shellSessionList.querySelectorAll('.shell-session-item');
    const emptyMsg = shellSessionList.querySelector('.shell-session-empty');
    if (items.length === 0) {
        if (!emptyMsg) {
            const msg = document.createElement('div');
            msg.className = 'shell-session-empty';
            msg.setAttribute('data-i18n', 'main.noActiveShellSessions');
            msg.textContent = tr('main.noActiveShellSessions') || 'No active shell sessions';
            shellSessionList.appendChild(msg);
        }
    } else {
        if (emptyMsg) emptyMsg.remove();
    }
}

function addShellSessionItem(tabId, title, paneId) {
    if (!shellSessionList) return;
    const emptyMsg = shellSessionList.querySelector('.shell-session-empty');
    if (emptyMsg) emptyMsg.remove();

    const item = document.createElement('div');
    item.className = 'shell-session-item';
    item.dataset.tabId = tabId;
    item.dataset.paneId = paneId;
    const itemName = document.createElement('span');
    itemName.className = 'shell-session-item-name';
    itemName.title = title;
    itemName.textContent = title;
    const itemClose = document.createElement('button');
    itemClose.className = 'shell-session-item-close';
    itemClose.title = tr('main.closeTab');
    itemClose.appendChild(createMaterialIcon('close'));
    item.append(itemName, itemClose);
    item.querySelector('.shell-session-item-name').addEventListener('click', () => {
        if (typeof window.__switchWorkspaceTab === 'function') {
            window.__switchWorkspaceTab(tabId, paneId);
        }
    });
    item.querySelector('.shell-session-item-close').addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof window.__closeShellTab === 'function') {
            window.__closeShellTab(tabId, paneId);
        }
        item.remove();
        updateShellSessionList();
    });
    shellSessionList.appendChild(item);
}

function removeShellSessionItem(tabId) {
    if (!shellSessionList) return;
    const item = shellSessionList.querySelector(`.shell-session-item[data-tab-id="${tabId}"]`);
    if (item) {
        item.remove();
        updateShellSessionList();
    }
}

function setActiveShellSessionItem(tabId) {
    if (!shellSessionList) return;
    shellSessionList.querySelectorAll('.shell-session-item').forEach(el => el.classList.remove('active'));
    if (tabId) {
        const item = shellSessionList.querySelector(`.shell-session-item[data-tab-id="${tabId}"]`);
        if (item) item.classList.add('active');
    }
}

async function loadShellProfiles() {
    if (!shellProfileBtns) return;
    try {
        const result = await ipcRenderer.invoke('get-shell-profiles');
        const profiles = result.profiles || result;
        const defaultId = result.defaultId || '';
        shellProfileBtns.innerHTML = '';
        if (!profiles || !profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'shell-session-empty';
            empty.textContent = tr('main.noShellProfiles') || 'No shell profiles configured';
            shellProfileBtns.appendChild(empty);
            return;
        }
        profiles.forEach(profile => {
            const isDefault = profile.id === defaultId;
            const btn = document.createElement('button');
            btn.className = 'secondary shell-new-btn';
            btn.title = `${profile.name} (${profile.executable})${isDefault ? ' — ' + (tr('main.defaultProfile') || 'Default') : ''}`;
            const profileName = document.createElement('span');
            profileName.textContent = profile.name;
            btn.appendChild(profileName);
            if (isDefault) {
                const defaultIcon = createMaterialIcon('check_circle');
                defaultIcon.classList.add('default-profile-icon');
                defaultIcon.title = tr('main.defaultProfile') || 'Default';
                btn.appendChild(defaultIcon);
            }
            btn.addEventListener('click', () => {
                createShellTab({ profileId: profile.id, title: profile.name }, getActivePane()?.id || 'pane-1');
            });
            shellProfileBtns.appendChild(btn);
        });
    } catch (error) {
        console.error('Failed to load shell profiles:', error);
    }
}

function bindShellSidebarEvents() {
    toggleShellSidebarBtn?.addEventListener('click', () => {
        toggleShellSidebar();
        if (shellSidebar && !shellSidebar.classList.contains('hidden')) {
            loadShellProfiles();
        }
    });

    shellSidebarCloseBtn?.addEventListener('click', () => {
        if (shellSidebar) {
            shellSidebar.classList.add('hidden');
            toggleShellSidebarBtn?.classList.remove('active');
            sidebarShellBtn?.classList.remove('active');
        }
    });

    shellManageProfilesBtn?.addEventListener('click', () => {
        ipcRenderer.send('open-prefs', { focusTab: 'shell-profiles' });
    });

    shellAutoCrlfCb?.addEventListener('change', () => {
        ipcRenderer.send('update-shell-options', {
            autoCRLF: shellAutoCrlfCb?.checked
        });
    });

    shellClearOnRestartCb?.addEventListener('change', () => {
        ipcRenderer.send('update-shell-options', {
            clearOnRestart: shellClearOnRestartCb?.checked
        });
    });
}

function showSidebarTab(tabId, persist = true) {
    const normalizedTabId = ['tab-settings', 'tab-search', 'tab-send'].includes(tabId) ? tabId : 'tab-settings';
    const button = document.querySelector(`.sidebar-tab[data-target="${normalizedTabId}"]`);
    const pane = document.getElementById(normalizedTabId);
    if (!button || !pane) return false;
    document.querySelectorAll('.sidebar-tab-pane').forEach(tabPane => {
        tabPane.classList.toggle('active', tabPane === pane);
    });
    document.querySelectorAll('.sidebar-tab').forEach(tabButton => {
        const selected = tabButton === button;
        tabButton.classList.toggle('active', selected);
        tabButton.setAttribute('aria-selected', String(selected));
    });
    if (currentConfig) currentConfig.activeSidebarTab = normalizedTabId;
    if (persist && !isApplyingConfig) ipcRenderer.send('save-config', { activeSidebarTab: normalizedTabId });
    return true;
}

function getNextChartTabId() {
    return nextChartTabId++;
}

function syncNextChartTabId(tabId) {
    const match = String(tabId || '').match(/^tab-chart-(\d+)$/);
    if (!match) return;
    const numericId = Number(match[1]);
    if (Number.isFinite(numericId) && numericId >= nextChartTabId) nextChartTabId = numericId + 1;
}

function bindSidebarToolbarEvents() {
    document.querySelectorAll('.sidebar-tab').forEach(button => {
        button.addEventListener('click', () => showSidebarTab(button.dataset.target));
    });
    document.getElementById('open-prefs')?.addEventListener('click', () => {
        ipcRenderer.send('open-prefs');
    });
    const toggle = () => setSidebarCollapsed(!sidebar?.classList.contains('sidebar-collapsed'));
    sidebarExpandBtn?.addEventListener('click', toggle);
    sidebarCollapseBtn?.addEventListener('click', toggle);
    sidebarConnectBtn?.addEventListener('click', () => connectBtn?.click());
    sidebarClearBtn?.addEventListener('click', () => document.getElementById('clear-btn')?.click());
    sidebarPrefsBtn?.addEventListener('click', () => document.getElementById('open-prefs')?.click());
    sidebarInputBtn?.addEventListener('click', () => toggleMainInputBtn?.click());
    sidebarShellBtn?.addEventListener('click', () => toggleShellSidebarBtn?.click());
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function focusMainInput() {
    if (!mainSendInput) return;
    if (suppressMainInputFocus) return;
    mainSendInput.focus();
    const len = mainSendInput.value.length;
    mainSendInput.setSelectionRange(len, len);
}

function normalizeMainInputHistoryLimit(value) {
    const limit = Number.parseInt(value, 10);
    return Number.isFinite(limit) ? Math.min(200, Math.max(0, limit)) : 20;
}

function normalizeMainInputHistory(history, limit = mainInputHistoryLimit) {
    if (!Array.isArray(history) || limit <= 0) return [];
    return history.filter(item => item && typeof item === 'object' && typeof item.content === 'string' && item.content)
        .map(item => ({ mode: item.mode === 'hex' ? 'hex' : 'text', content: item.content }))
        .slice(-limit);
}

function formatMainInputHistoryPreview(entry) {
    const normalized = String(entry.content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const [firstLine = ''] = normalized.split('\n');
    const suffix = normalized.includes('\n') ? '...' : '';
    return `[${entry.mode.toUpperCase()}] ${firstLine || tr('common.emptyContent')}${suffix}`;
}

function saveMainInputHistory() {
    if (isApplyingConfig) return;
    if (currentConfig) currentConfig.mainInputHistory = mainInputHistory;
    ipcRenderer.send('save-config', { mainInputHistory });
}

function renderMainInputHistoryMenu() {
    if (!mainInputHistoryMenu || !mainInputHistoryBtn) return;
    mainInputHistoryMenu.innerHTML = '';
    mainInputHistoryBtn.disabled = mainInputHistory.length === 0;
    if (!mainInputHistory.length) {
        mainInputHistoryMenu.classList.add('hidden');
        return;
    }

    mainInputHistory.slice().reverse().forEach(entry => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'main-input-history-item';
        item.textContent = formatMainInputHistoryPreview(entry);
        item.title = entry.content;
        item.addEventListener('click', () => {
            mainInputHistoryMenu.classList.add('hidden');
            mainInputHistoryIndex = -1;
            mainInputHistoryDraft = null;
            putTextInMainInput(entry.content, entry.mode);
        });
        mainInputHistoryMenu.appendChild(item);
    });
}

function toggleMainInputHistoryMenu() {
    if (!mainInputHistoryMenu || !mainInputHistory.length) return;
    mainInputHistoryMenu.classList.toggle('hidden');
}

function normalizeShortcutKeyName(key) {
    if (key === ' ') return 'Space';
    if (key === 'ArrowUp') return 'Up';
    if (key === 'ArrowDown') return 'Down';
    if (key === 'ArrowLeft') return 'Left';
    if (key === 'ArrowRight') return 'Right';
    if (key.length === 1) return key.toUpperCase();
    return key;
}

function shortcutFromEvent(event) {
    const key = normalizeShortcutKeyName(event.key);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

function normalizeShortcutSettings(shortcuts = {}) {
    const normalized = { ...DEFAULT_SHORTCUTS };
    Object.keys(DEFAULT_SHORTCUTS).forEach(action => {
        if (typeof shortcuts[action] === 'string') normalized[action] = shortcuts[action].trim();
    });
    return normalized;
}

function isEditableShortcutTarget(target) {
    if (!target) return false;
    if (target === mainSendInput || target === searchInput) return false;
    if (target.closest?.('.xterm')) return false;
    return target.matches?.('input, textarea, select, [contenteditable="true"]') === true;
}

function getShortcutAction(combo) {
    return Object.entries(activeShortcuts).find(([, value]) => value && value === combo)?.[0] || '';
}

function handleAppShortcut(event) {
    const combo = shortcutFromEvent(event);
    if (!combo) return;
    const action = getShortcutAction(combo);
    if (!action) return;
    if (isEditableShortcutTarget(event.target)) return;

    event.preventDefault();
    event.stopPropagation();

    switch (action) {
        case 'sendMainInput':
            sendMainInputBuffer();
            break;
        case 'toggleSendHistory':
            toggleMainInputHistoryMenu();
            break;
        case 'historyPrevious':
            navigateMainInputHistory(1);
            break;
        case 'historyNext':
            navigateMainInputHistory(-1);
            break;
        case 'focusSearch':
            focusSearchWithActiveSelection();
            break;
        case 'clearActiveTerminal':
            clearActiveTerminal();
            break;
        case 'refreshPorts':
            refreshPorts();
            break;
        case 'toggleSerialConnection':
            toggleSerialConnection();
            break;
    }
}

function pushMainInputHistory(entry) {
    if (!entry?.content) return;
    if (mainInputHistoryLimit <= 0) return;
    const normalizedEntry = { mode: entry.mode === 'hex' ? 'hex' : 'text', content: entry.content };
    const existingIndex = mainInputHistory.findIndex(item => item.mode === normalizedEntry.mode && item.content === normalizedEntry.content);
    if (existingIndex >= 0) {
        mainInputHistory.splice(existingIndex, 1);
    }
    mainInputHistory.push(normalizedEntry);
    mainInputHistory = normalizeMainInputHistory(mainInputHistory, mainInputHistoryLimit);
    mainInputHistoryIndex = -1;
    mainInputHistoryDraft = null;
    renderMainInputHistoryMenu();
    saveMainInputHistory();
}

function navigateMainInputHistory(direction) {
    if (!mainInputHistory.length) return;

    if (mainInputHistoryIndex === -1) {
        mainInputHistoryDraft = getMainInputRequest();
    }

    const nextIndex = mainInputHistoryIndex + direction;
    if (nextIndex < -1 || nextIndex >= mainInputHistory.length) {
        return;
    }

    mainInputHistoryIndex = nextIndex;
    const entry = mainInputHistoryIndex === -1 ? mainInputHistoryDraft : mainInputHistory[mainInputHistory.length - 1 - mainInputHistoryIndex];
    switchMainInputMode(entry.mode, { persist: true });
    mainSendInput.value = entry.content;
    mainInputDrafts[entry.mode] = entry.content;
    updateMainInputHeight();
    const appendCrLf = mainSendAppendCrlfCb?.checked === true;
    const validation = validateSendContent(mainInputMode, entry.content, sendEncoding, SEND_LIMITS.main - (appendCrLf ? 2 : 0));
    mainInputValidation.textContent = formatValidation(validation, mainInputMode, appendCrLf);
    mainInputValidation.classList.toggle('valid', validation.ok);
    mainInputValidation.classList.toggle('invalid', !validation.ok && entry.content.length > 0);
    mainSendBtn.disabled = !validation.ok;
    mainAddQuickSendBtn.disabled = !validation.ok;
    mainSendInput.placeholder = mainInputMode === 'hex' ? 'AA 55 01 FF' : tr('main.sendInputPlaceholder');
    focusMainInput();
}

function isMainInputCaretOnFirstLine() {
    const caretStart = mainSendInput.selectionStart ?? 0;
    return !mainSendInput.value.slice(0, caretStart).includes('\n');
}

function isMainInputCaretOnLastLine() {
    const caretEnd = mainSendInput.selectionEnd ?? 0;
    return !mainSendInput.value.slice(caretEnd).includes('\n');
}

function clearMainInput() {
    mainSendInput.value = '';
    mainInputHistoryIndex = -1;
    mainInputHistoryDraft = null;
    updateMainInputState();
}

function getMainInputRequest() {
    return {
        mode: mainInputMode,
        content: mainSendInput.value,
        encoding: sendEncoding,
        appendCrLf: mainSendAppendCrlfCb?.checked === true
    };
}

function updateMainInputState() {
    updateMainInputHeight();
    const request = getMainInputRequest();
    mainInputDrafts[request.mode] = request.content;
    const validation = validateSendContent(request.mode, request.content, request.encoding, SEND_LIMITS.main - (request.appendCrLf ? 2 : 0));
    mainInputValidation.textContent = formatValidation(validation, request.mode, request.appendCrLf);
    mainInputValidation.classList.toggle('valid', validation.ok);
    mainInputValidation.classList.toggle('invalid', !validation.ok && request.content.length > 0);
    mainSendBtn.disabled = !validation.ok;
    mainAddQuickSendBtn.disabled = !validation.ok;
    mainSendInput.placeholder = request.mode === 'hex' ? 'AA 55 01 FF' : tr('main.sendInputPlaceholder');
}

function switchMainInputMode(mode, { persist = true } = {}) {
    const normalized = mode === 'hex' ? 'hex' : 'text';
    const oldMode = mainInputMode;
    if (oldMode !== normalized) mainInputDrafts[oldMode] = mainSendInput.value;
    mainInputMode = normalized;
    mainSendInput.value = mainInputDrafts[normalized];
    if (mainSendHexCb) mainSendHexCb.checked = normalized === 'hex';
    updateMainInputState();
    if (persist && !isApplyingConfig) saveMainInputSettings();
}

async function sendMainInputBuffer() {
    const request = { ...getMainInputRequest(), source: 'main-input' };
    if (!request.content) {
        focusMainInput();
        return;
    }
    const result = await sendSerialRequest(request, SEND_LIMITS.main);
    if (result.ok) {
        pushMainInputHistory({ mode: request.mode, content: request.content });
        const preview = request.mode === 'hex' ? parseHexInput(request.content).normalized : request.content;
        setLastSentPreview(preview);
    }
    focusMainInput();
}

function buildQuickSendLabel(content) {
    const normalized = String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const [firstLine = ''] = normalized.split('\n');
    if (!firstLine) return tr('main.quickSendDefaultLabel');
    return firstLine.length > 8 ? `${firstLine.slice(0, 8)}...` : firstLine;
}

function addMainInputToQuickSend() {
    const content = mainSendInput?.value;
    if (!content) {
        focusMainInput();
        return;
    }

    quickSendList.push({
        id: createQuickSendId(),
        label: buildQuickSendLabel(content),
        mode: mainInputMode,
        appendCrLf: mainSendAppendCrlfCb?.checked === true,
        content,
        sidebarShortcut: {
            enabled: false,
            text: '',
            backgroundColor: ''
        },
        autoTrigger: {
            enabled: false,
            text: '',
            useRegex: false,
            caseSensitive: false,
            wholeWord: false
        }
    });
    renderQuickSendLists();
    saveQuickSendList();
    setActionStatus('已将当前输入加入快捷发送');
    focusMainInput();
}

function saveMainInputSettings() {
    ipcRenderer.send('save-config', {
        mainInputSettings: {
            visible: !mainInputPanel?.classList.contains('hidden'),
            sendOnEnter: mainSendOnEnterCb?.checked !== false,
            mode: mainInputMode,
            appendCrLf: mainSendAppendCrlfCb?.checked === true,
            historyLimit: mainInputHistoryLimit
        }
    });
}

function bindMainInputEvents() {
    if (!mainSendInput) return;

    document.addEventListener('keydown', handleAppShortcut, true);

    mainSendInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && mainSendOnEnterCb?.checked) {
            event.preventDefault();
            sendMainInputBuffer();
            return;
        }

        if (event.key === 'ArrowUp' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isMainInputCaretOnFirstLine()) {
            event.preventDefault();
            navigateMainInputHistory(1);
            return;
        }

        if (event.key === 'ArrowDown' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && isMainInputCaretOnLastLine()) {
            event.preventDefault();
            navigateMainInputHistory(-1);
            return;
        }
    });

    mainSendInput.addEventListener('input', updateMainInputState);
    mainSendBtn.addEventListener('click', sendMainInputBuffer);
    mainAddQuickSendBtn?.addEventListener('click', addMainInputToQuickSend);
    mainSendHexCb?.addEventListener('change', () => switchMainInputMode(mainSendHexCb.checked ? 'hex' : 'text'));
    mainSendAppendCrlfCb?.addEventListener('change', () => {
        updateMainInputState();
        saveMainInputSettings();
    });
    mainInputHistoryBtn?.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleMainInputHistoryMenu();
    });
    document.addEventListener('click', (event) => {
        if (mainInputHistoryMenu?.classList.contains('hidden')) return;
        if (mainInputHistoryMenu.contains(event.target) || mainInputHistoryBtn?.contains(event.target)) return;
        mainInputHistoryMenu.classList.add('hidden');
    });
    mainSendOnEnterCb?.addEventListener('change', saveMainInputSettings);
    toggleMainInputBtn?.addEventListener('click', () => {
        const visible = mainInputPanel?.classList.contains('hidden');
        setMainInputPanelVisible(visible, true);
    });

    updateMainInputState();
    setLastSentPreview('');
}

function applyMainInputConfig(config) {
    const settings = config.mainInputSettings || {};
    mainInputHistoryLimit = normalizeMainInputHistoryLimit(settings.historyLimit);
    mainInputHistory = normalizeMainInputHistory(config.mainInputHistory, mainInputHistoryLimit);
    renderMainInputHistoryMenu();
    setMainInputPanelVisible(settings.visible !== false, false);
    if (mainSendOnEnterCb) {
        mainSendOnEnterCb.checked = settings.sendOnEnter !== false;
    }
    if (mainSendAppendCrlfCb) mainSendAppendCrlfCb.checked = settings.appendCrLf === true;
    switchMainInputMode(settings.mode, { persist: false });
}

bindMainInputEvents();
bindWorkspaceSplitter();
bindWorkspacePaneTransitionFit();
bindShellSidebarEvents();
bindSidebarToolbarEvents();

function getSerialOptionsFromUi() {
    return {
        path: document.getElementById('port-select')?.value || currentConfig?.lastSerialOptions?.path || '',
        baudRate: typeof getBaudRate === 'function' ? getBaudRate() : (currentConfig?.lastSerialOptions?.baudRate || '9600'),
        dataBits: document.getElementById('data-bits-select')?.value || '8',
        stopBits: document.getElementById('stop-bits-select')?.value || '1',
        parity: document.getElementById('parity-select')?.value || 'none',
        receiveDisplayMode, receiveEncoding, sendEncoding, newlineMode
    };
}

function saveSerialModeConfig() {
    if (isApplyingConfig) return;
    const lastSerialOptions = getSerialOptionsFromUi();
    if (currentConfig) currentConfig.lastSerialOptions = lastSerialOptions;
    ipcRenderer.send('save-config', { lastSerialOptions });
}

function switchSendEncoding(nextEncoding, { persist = true, refresh = true } = {}) {
    sendEncoding = SUPPORTED_ENCODINGS.has(nextEncoding) ? nextEncoding : 'utf8';
    if (sendEncodingSelect) sendEncodingSelect.value = sendEncoding;
    if (refresh) refreshSendConsumers();
    if (persist && !isApplyingConfig) saveSendEncoding();
}

function refreshSendConsumers() {
    updateMainInputState();
    if (typeof updateAutoSendValidation === 'function') {
        updateAutoSendValidation();
        updateAutoSendState();
    }
    if (typeof updateQuickSendValidation === 'function') updateQuickSendValidation();
    if (typeof renderQuickSendLists === 'function') renderQuickSendLists();
}

function saveSendEncoding() {
    const lastSerialOptions = getSerialOptionsFromUi();
    const config = { lastSerialOptions };
    if (autoSendEnableCb) {
        config.autoSendSettings = getAutoSendSettings();
        appliedAutoSendKey = JSON.stringify(config.autoSendSettings);
    }
    if (currentConfig) {
        currentConfig.lastSerialOptions = lastSerialOptions;
        if (config.autoSendSettings) currentConfig.autoSendSettings = config.autoSendSettings;
    }
    ipcRenderer.send('save-config', config);
}

receiveModeSelect?.addEventListener('change', () => switchReceiveMode(receiveModeSelect.value));
receiveEncodingSelect?.addEventListener('change', () => switchReceiveEncoding(receiveEncodingSelect.value));
sendEncodingSelect?.addEventListener('change', () => switchSendEncoding(sendEncodingSelect.value));
document.getElementById('newline-mode-select')?.addEventListener('change', event => {
    newlineMode = event.target.value;
    saveSerialModeConfig();
});

function applyConfig(config) {
    isApplyingConfig = true;
    try {
    currentConfig = config;
    setSidebarCollapsed(config.sidebarCollapsed === true, false);
    showSidebarTab(config.activeSidebarTab, false);
    sidebarShellBtn?.classList.toggle('active', shellSidebar && !shellSidebar.classList.contains('hidden'));
    activeShortcuts = normalizeShortcutSettings(config.shortcuts);
    let sendEncodingChanged = false;
    currentLanguage = getLanguage(config.language);
    highlightRules = config.highlightRules || [];
    highlightColors = config.highlightColors;
    const normalizedWorkspaceLayout = normalizeWorkspaceLayout(config.workspaceLayout);
    const normalizedWorkspaceLayoutKey = JSON.stringify(normalizedWorkspaceLayout);
    
    // Update local color settings
    timestampColor = config.timestampColor || '#808080';
    lineNoColor = config.lineNoColor || '#67986f';
    mouseWheelScrollLines = config.mouseWheelScrollLines || 3;
    
    // Update Checkboxes
    showTimestamp = config.showTimestamp || false;
    showLineNumbers = config.showLineNumbers || false;
    logIncludeTimestamp = config.logIncludeTimestamp === true;
    logIncludeLineNumbers = config.logIncludeLineNumbers === true;
    if (showTimestampCb) showTimestampCb.checked = showTimestamp;
    if (showLinenoCb) showLinenoCb.checked = showLineNumbers;

    const options = {
        fontSize: config.fontSize,
        fontWeight: config.fontWeight,
        fontFamily: TERMINAL_FONT_FAMILY(config),
        scrollback: config.scrollbackLimit || 20000,
        theme: getTerminalTheme(config)
    };
    applyTerminalWallpaper(config);
    serialTerm.options = options;
    
    // Apply options to all filter tabs
    filterTabs.forEach(tab => {
        tab.term.options = options;
        tab.fitAddon.fit();
    });
    shellTabs.forEach(tab => {
        tab.term.options = options;
        tab.fitAddon.fit();
    });
    chartTabs.forEach(tab => tab.view?.resize());
    if (searchState.current > 0 && searchState.matches[searchState.current - 1]) {
        decorateActiveSearchMatch(getActiveSearchTarget().term, searchState.matches[searchState.current - 1]);
    }
    
    document.body.style.background = config.background;
    document.documentElement.style.setProperty('--chart-log-background', config.background || '#000000');

    document.querySelectorAll('[data-i18n]').forEach(el => {
        let translated = tr(el.dataset.i18n);
        if (el.closest('button')?.querySelector('svg[data-material-icon="add"]')) {
            translated = translated.replace(/^\s*\+\s*/, '');
        }
        el.textContent = translated === el.dataset.i18n && el.dataset.i18nFallback
            ? el.dataset.i18nFallback
            : translated;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
        el.title = tr(el.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = tr(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const translated = tr(el.dataset.i18nAriaLabel);
        if (translated !== el.dataset.i18nAriaLabel) el.setAttribute('aria-label', translated);
    });
    
    // Restore Serial Settings
    if (config.lastSerialOptions) {
        const previousSendEncoding = sendEncoding;
        // Elements are defined below, but this function runs async or after load
        const baud = document.getElementById('baud-select');
        const baudInput = document.getElementById('baud-custom-input');
        const baudWrapper = document.getElementById('baud-custom-wrapper');
        
        if (baud && config.lastSerialOptions.baudRate) {
            // Check if saved baud is in standard list
            const exists = Array.from(baud.options).some(opt => opt.value === config.lastSerialOptions.baudRate);
            if (exists) {
                baud.value = config.lastSerialOptions.baudRate;
                baud.style.display = 'block';
                if (baudWrapper) baudWrapper.style.display = 'none';
            } else {
                // It's a custom baud rate
                baud.value = 'custom';
                baud.style.display = 'none';
                if (baudWrapper) {
                    baudWrapper.style.display = 'flex';
                    if (baudInput) baudInput.value = config.lastSerialOptions.baudRate;
                }
            }
        }
        
        const db = document.getElementById('data-bits-select');
        if (db) db.value = config.lastSerialOptions.dataBits;
        
        const sb = document.getElementById('stop-bits-select');
        if (sb) sb.value = config.lastSerialOptions.stopBits;
        
        const par = document.getElementById('parity-select');
        if (par) par.value = config.lastSerialOptions.parity;
        
        const nl = document.getElementById('newline-mode-select');
        if (nl) nl.value = config.lastSerialOptions.newlineMode;
        newlineMode = config.lastSerialOptions.newlineMode || 'crlf';
        switchReceiveEncoding(config.lastSerialOptions.receiveEncoding, { persist: false });
        switchReceiveMode(config.lastSerialOptions.receiveDisplayMode, { persist: false });
        switchSendEncoding(config.lastSerialOptions.sendEncoding, { persist: false, refresh: false });
        sendEncodingChanged = previousSendEncoding !== sendEncoding;
        
        // Refresh ports to update selection based on config
        refreshPorts();
    }

    applyMainInputConfig(config);
    const hexSettingsKey = JSON.stringify(config.hexDisplaySettings || {});
    if (appliedHexSettingsKey && appliedHexSettingsKey !== hexSettingsKey) hexFormatter.flush();
    hexFormatter.configure(config.hexDisplaySettings || {});
    appliedHexSettingsKey = hexSettingsKey;
    const autoSendChanged = applyAutoSendConfig(config.autoSendSettings || {});
    quickSendGroups = Array.isArray(config.quickSendGroups) ? config.quickSendGroups.map(normalizeQuickSendGroup) : [];
    quickSendUngroupedCollapsed = config.quickSendUngroupedCollapsed === true;
    quickSendList = Array.isArray(config.quickSendList) ? config.quickSendList.map(normalizeQuickSendItem) : [];
    sidebarQuickSendOrder = Array.isArray(config.sidebarQuickSendOrder)
        ? config.sidebarQuickSendOrder.filter(id => typeof id === 'string')
        : [];
    normalizeSidebarQuickSendOrder();
    renderQuickSendLists();
    updateQuickSendValidation();
    if (sendEncodingChanged || autoSendChanged) {
        updateAutoSendValidation();
        updateAutoSendState();
    }

    // Preload shell profiles for the sidebar
    loadShellProfiles();

    const layoutTabToPaneMap = new Map();
    const layoutTabIdsByPane = {
        'pane-1': [],
        'pane-2': []
    };
    normalizedWorkspaceLayout.panes.forEach(pane => {
        if (Array.isArray(pane.tabIds)) {
            pane.tabIds.forEach(tabId => {
                if (typeof tabId === 'string') {
                    layoutTabToPaneMap.set(tabId, pane.id);
                    if (pane.id === 'pane-1' || pane.id === 'pane-2') {
                        layoutTabIdsByPane[pane.id].push(tabId);
                    }
                }
            });
        }
    });

    if (filterTabs.length === 0 && Array.isArray(config.filterTabs) && config.filterTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneFilterQueue = {
                'pane-1': layoutTabIdsByPane['pane-1'].filter(id => /^tab-filter-\d+$/.test(id)),
                'pane-2': layoutTabIdsByPane['pane-2'].filter(id => /^tab-filter-\d+$/.test(id))
            };
            config.filterTabs.forEach(tabConfig => {
                const targetPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || 'pane-1';
                if (!tabConfig.id) {
                    const queue = paneFilterQueue[targetPaneId] || [];
                    const nextId = queue.shift();
                    if (nextId) {
                        tabConfig.id = nextId;
                    }
                }
                createFilterTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
    }

    if (shellTabs.length === 0 && Array.isArray(config.shellTabs) && config.shellTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneShellQueue = {
                'pane-1': layoutTabIdsByPane['pane-1'].filter(id => /^tab-shell-\d+$/.test(id)),
                'pane-2': layoutTabIdsByPane['pane-2'].filter(id => /^tab-shell-\d+$/.test(id))
            };
            config.shellTabs.forEach(tabConfig => {
                const targetPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || 'pane-1';
                if (!tabConfig.id) {
                    const queue = paneShellQueue[targetPaneId] || [];
                    const nextId = queue.shift();
                    if (nextId) {
                        tabConfig.id = nextId;
                    }
                }
                createShellTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
        restoreShellSessions();
    }

    if (chartTabs.length === 0 && Array.isArray(config.chartTabs) && config.chartTabs.length > 0) {
        isRestoringWorkspaceSession = true;
        try {
            const paneChartQueue = {
                'pane-1': layoutTabIdsByPane['pane-1'].filter(id => /^tab-chart-\d+$/.test(id)),
                'pane-2': layoutTabIdsByPane['pane-2'].filter(id => /^tab-chart-\d+$/.test(id))
            };
            config.chartTabs.forEach(tabConfig => {
                const targetPaneId = tabConfig.paneId || layoutTabToPaneMap.get(tabConfig.id) || 'pane-1';
                if (!tabConfig.id) tabConfig.id = paneChartQueue[targetPaneId]?.shift();
                createChartTab(tabConfig, targetPaneId);
            });
        } finally {
            isRestoringWorkspaceSession = false;
        }
    }

    if (normalizedWorkspaceLayoutKey !== lastAppliedWorkspaceLayoutKey) {
        restoreWorkspaceLayout(normalizedWorkspaceLayout, { persist: true });
        lastAppliedWorkspaceLayoutKey = JSON.stringify(cloneWorkspaceLayout(workspaceLayout));
    }

    serialFitAddon.fit();

    fitWorkspaceTerminals();
    } finally {
        isApplyingConfig = false;
    }
}

/*
// Mode Switching
window.setMode = (mode) => {
    currentMode = mode;
    
    // UI Updates
    document.getElementById('mode-terminal').classList.toggle('active', mode === 'terminal');
    document.getElementById('mode-serial').classList.toggle('active', mode === 'serial');
    
    document.getElementById('serial-controls').style.display = mode === 'serial' ? 'flex' : 'none';
    document.getElementById('terminal-container').style.display = mode === 'terminal' ? 'block' : 'none';
    document.getElementById('serial-container').style.display = mode === 'serial' ? 'block' : 'none';
    
    // Refit the visible terminal
    setTimeout(() => {
        if (mode === 'terminal') fitAddon.fit();
        else serialFitAddon.fit();
    }, 0);
};
*/

// Config IPC
ipcRenderer.invoke('get-config').then(config => {
    applyConfig(config);
    showWelcomeGuideForCurrentVersion(config);
});
ipcRenderer.on('config-updated', (event, config) => applyConfig(config));

function hideScheduledUpdateToast(animate = true) {
    if (scheduledUpdateToastTimer) clearTimeout(scheduledUpdateToastTimer);
    scheduledUpdateToastTimer = null;
    const toast = scheduledUpdateToast;
    if (!toast) return;
    if (scheduledUpdateToastRemoveTimer) clearTimeout(scheduledUpdateToastRemoveTimer);
    scheduledUpdateToastRemoveTimer = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!animate || reduceMotion) {
        toast.remove();
        scheduledUpdateToast = null;
        return;
    }
    toast.classList.add('scheduled-update-toast-hiding');
    scheduledUpdateToastRemoveTimer = setTimeout(() => {
        toast.remove();
        if (scheduledUpdateToast === toast) scheduledUpdateToast = null;
        scheduledUpdateToastRemoveTimer = null;
    }, 180);
}

function showScheduledUpdateToast({ version = '' } = {}) {
    hideScheduledUpdateToast(false);
    const toast = document.createElement('div');
    toast.className = 'scheduled-update-toast';
    toast.setAttribute('role', 'status');

    const content = document.createElement('div');
    content.className = 'scheduled-update-toast-content';
    const title = document.createElement('div');
    title.className = 'scheduled-update-toast-title';
    title.textContent = trFallback('main.updateToastTitle', 'New version available');
    const message = document.createElement('div');
    message.className = 'scheduled-update-toast-message';
    message.textContent = trFallback(
        'main.updateToastMessage',
        'Version {version} is available. Update it from Settings > About.',
        { version }
    );
    content.append(title, message);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'scheduled-update-toast-close';
    closeButton.title = trFallback('main.closeUpdateToast', 'Close');
    closeButton.setAttribute('aria-label', closeButton.title);
    closeButton.appendChild(createMaterialIcon('close'));
    closeButton.onclick = () => hideScheduledUpdateToast();

    toast.append(content, closeButton);
    document.body.appendChild(toast);
    scheduledUpdateToast = toast;
    scheduledUpdateToastTimer = setTimeout(hideScheduledUpdateToast, 5000);
}

ipcRenderer.on('scheduled-update-available', (_event, info) => showScheduledUpdateToast(info));

ipcRenderer.on('shell-tab-output', (event, payload = {}) => {
    const tab = getShellTabState(payload.tabId);
    if (tab && typeof payload.data === 'string') {
        const translatedData = translateConptyMouseMode(tab, payload.data);
        tab.term.write(translatedData, () => {
            if (tab.textMode) setShellTextMode(tab, true);
        });
        writeShellTabLog(tab, payload.data);
    }
});

ipcRenderer.on('shell-tab-exit', (event, payload = {}) => {
    const tab = getShellTabState(payload.tabId);
    if (tab) {
        tab.sessionReady = false;
        tab.term.writeln(`\r\n[${tr('main.shellExited', { code: payload.exitCode ?? 0 })}]\r\n`);
        tab.btn?.classList.add('exited');
    }
});

// Serial Logic
serialTerm.onData((data) => {
    if (!isConnected) {
        return;
    }
    sendSerialRequest({
        mode: 'text', content: data, encoding: sendEncoding, source: 'terminal',
        terminalEnter: data === '\r', newlineMode
    }, SEND_LIMITS.terminal).then(result => {
        if (result.ok) serialTerm.write(data === '\r' ? '\r\n' : data);
    });
});
ipcRenderer.on('serial-output-bytes', (event, payload = {}) => {
    if (serialConnectInProgress && Number.isInteger(payload.sessionId) && payload.sessionId !== serialSessionId) {
        serialSessionId = payload.sessionId;
    }
    if (payload.sessionId !== undefined && payload.sessionId !== serialSessionId) return;
    const bytes = payload.bytes instanceof Uint8Array ? payload.bytes : Uint8Array.from(payload.bytes || []);
    if (!bytes.length) return;
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const receivedAt = Number.isFinite(payload.receivedAt) ? payload.receivedAt : Date.now();
    chartTabs.forEach(tab => tab.stream?.write(buffer, receivedAt));
    queueSerialOutput(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
});
ipcRenderer.on('serial-error', (event, err) => {
    const errMsg = '\r\n\x1b[31m[ERROR] ' + err + '\x1b[0m\r\n';
    serialTerm.write(errMsg);
    writeMainTabLog(errMsg);
    filterTabs.forEach(tab => {
        tab.term.write(errMsg);
        writeFilterTabLog(tab, errMsg);
    });
});

const THROUGHPUT_BAR_COUNT = 30;

function formatThroughput(bytesPerSecond) {
    if (bytesPerSecond >= 1024 * 1024) {
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
    if (bytesPerSecond >= 1024) {
        return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
    }
    return `${bytesPerSecond} B/s`;
}

function ensureThroughputSvg(chartEl, type) {
    if (!chartEl.querySelector('svg')) {
        chartEl.innerHTML = ''; // clear any existing
        const svgNS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(svgNS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.style.overflow = "visible";
        svg.style.display = "block";

        const area = document.createElementNS(svgNS, "path");
        area.setAttribute("class", `throughput-area ${type}`);
        area.setAttribute("fill", type === 'rx' ? 'var(--accent-color)' : 'var(--warning-color)');
        area.setAttribute("opacity", "0.2");
        area.setAttribute("stroke", "none");

        const path = document.createElementNS(svgNS, "path");
        path.setAttribute("class", `throughput-line ${type}`);
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", type === 'rx' ? 'var(--accent-color)' : 'var(--warning-color)');
        path.setAttribute("stroke-width", "2");
        path.setAttribute("vector-effect", "non-scaling-stroke");
        path.setAttribute("stroke-linejoin", "round");

        svg.appendChild(area);
        svg.appendChild(path);
        chartEl.appendChild(svg);
    }
}

function renderThroughputChart(chartEl, history) {
    const values = history.slice(-THROUGHPUT_BAR_COUNT);
    while (values.length < THROUGHPUT_BAR_COUNT) {
        values.unshift(0);
    }
    const maxValue = Math.max(1, ...values);

    const svg = chartEl.querySelector('svg');
    if (!svg) return;
    const path = svg.querySelector('.throughput-line');
    const area = svg.querySelector('.throughput-area');

    let d = "";
    let areaD = "";
    const step = 100 / (THROUGHPUT_BAR_COUNT - 1);

    values.forEach((value, index) => {
        const normalized = value === 0 ? 0 : (value / maxValue) * 100;
        const x = index * step;
        // Invert Y axis, keep within 2-100 to avoid stroke clipping at top
        const y = 100 - (normalized * 0.98);

        if (index === 0) {
            d += `M ${x},${y} `;
            areaD += `M ${x},100 L ${x},${y} `;
        } else {
            d += `L ${x},${y} `;
            areaD += `L ${x},${y} `;
        }
    });

    if (areaD) {
        areaD += `L 100,100 Z`;
        area.setAttribute("d", areaD);
    }
    if (d) {
        path.setAttribute("d", d);
    }
}

function updateThroughputPanel({ connected, rxHistory, txHistory, rxBytesPerSecond, txBytesPerSecond }) {
    throughputPanel.classList.toggle('inactive', !connected);
    throughputRxRate.textContent = formatThroughput(rxBytesPerSecond || 0);
    throughputTxRate.textContent = formatThroughput(txBytesPerSecond || 0);
    if (sidebarThroughputRx) sidebarThroughputRx.textContent = formatThroughput(rxBytesPerSecond || 0);
    if (sidebarThroughputTx) sidebarThroughputTx.textContent = formatThroughput(txBytesPerSecond || 0);
    sidebarThroughputCompact?.classList.toggle('inactive', !connected);
    renderThroughputChart(throughputRxChart, rxHistory || []);
    renderThroughputChart(throughputTxChart, txHistory || []);
}

ipcRenderer.on('serial-throughput-update', (event, payload) => {
    updateThroughputPanel(payload);
});

function updateSerialConnectionState(connected) {
    isConnected = connected;
    if (connected) {
        quickSendDisconnectedClicks = new WeakMap();
        hideQuickSendDisconnectedToast();
    }
    const label = document.getElementById('connect-btn-label');
    if (label) {
        const translationKey = connected ? 'main.disconnect' : 'main.connect';
        label.dataset.i18n = translationKey;
        label.textContent = tr(translationKey);
    }
    connectBtn.classList.toggle('connect-action', !connected);
    connectBtn.classList.toggle('disconnect-action', connected);
    sidebarConnectBtn?.classList.toggle('connect-action', !connected);
    sidebarConnectBtn?.classList.toggle('disconnect-action', connected);
    if (sidebarConnectBtn) {
        sidebarConnectBtn.title = tr(connected ? 'main.disconnect' : 'main.connect');
        sidebarConnectBtn.setAttribute('aria-label', sidebarConnectBtn.title);
    }
    setActionStatus(connected ? tr('main.connected') : tr('main.disconnected'));
}

function disconnectSerial() {
    serialSessionId++;
    serialWriteChain = Promise.resolve();
    stopAutoSendRuntime();
    resetQuickTriggerReceive();
    chartTabs.forEach(tab => {
        tab.stream?.flush();
        tab.stream?.reset();
    });
    updateSerialConnectionState(false);
    ipcRenderer.send('disconnect-serial');
}

function waitForSerialDisconnected() {
    return new Promise(resolve => {
        serialDisconnectWaiters.push(resolve);
    });
}

ipcRenderer.on('serial-disconnected', (event, message) => {
    serialSessionId++;
    serialWriteChain = Promise.resolve();
    if (receiveDisplayMode === 'hex') hexFormatter.flush();
    else flushTextReceive();
    stopAutoSendRuntime();
    resetQuickTriggerReceive();
    chartTabs.forEach(tab => {
        tab.stream?.flush();
        tab.stream?.reset();
    });
    updateSerialConnectionState(false);
    if (message) {
        const notice = `\r\n\x1b[33m[INFO] ${message}\x1b[0m\r\n`;
        serialTerm.write(notice);
        writeMainTabLog(notice);
        filterTabs.forEach(tab => {
            tab.term.write(notice);
            writeFilterTabLog(tab, notice);
        });
        setActionStatus(message);
    }
    ipcRenderer.send('flush-tab-logs');
    const waiters = serialDisconnectWaiters;
    serialDisconnectWaiters = [];
    waiters.forEach(resolve => resolve());
});

ipcRenderer.on('log-saved', (event, payload = {}) => {
    const filePath = payload.path || '';
    setActionStatus(filePath ? `日志已保存：${filePath}` : '日志已保存');
});

ipcRenderer.on('all-tabs-log-saved', (event, payload = {}) => {
    const count = Array.isArray(payload.paths) ? payload.paths.length : 0;
    setActionStatus(count > 0 ? `已保存 ${count} 个标签页日志文件` : '标签页日志已保存');
});

ipcRenderer.on('log-error', (event, payload = {}) => {
    const message = trFallback(
        'main.logWriteFailed',
        'Log write failed ({kind}): {error}{paused}',
        {
            kind: payload.kind || 'log',
            error: payload.message || 'unknown error',
            paused: payload.paused ? trFallback('main.logWritePaused', ' Logging paused to protect memory.') : ''
        }
    );
    setActionStatus(message);
});

const portSelect = document.getElementById('port-select');
const baudSelect = document.getElementById('baud-select');
const baudCustomWrapper = document.getElementById('baud-custom-wrapper');
const baudCustomInput = document.getElementById('baud-custom-input');
const baudCustomCancel = document.getElementById('baud-custom-cancel');
const connectBtn = document.getElementById('connect-btn');
const clearBtn = document.getElementById('clear-btn');
const throughputPanel = document.getElementById('throughput-panel');
const throughputRxChart = document.getElementById('throughput-rx-chart');
const throughputTxChart = document.getElementById('throughput-tx-chart');
const throughputRxRate = document.getElementById('throughput-rx-rate');
const throughputTxRate = document.getElementById('throughput-tx-rate');

// Baud Rate Custom Logic
baudSelect.addEventListener('change', () => {
    if (baudSelect.value === 'custom') {
        baudSelect.style.display = 'none';
        baudCustomWrapper.style.display = 'flex';
        baudCustomInput.focus();
        return;
    }
    applySerialParameterChange({ reconnect: true });
});

baudCustomCancel.addEventListener('click', () => {
    baudCustomWrapper.style.display = 'none';
    baudSelect.style.display = 'block';
    baudSelect.value = '115200'; // Reset to default
    applySerialParameterChange({ reconnect: true });
});

function saveCustomBaudRate() {
    if (baudSelect.value === 'custom' && baudCustomInput.value.trim()) {
        applySerialParameterChange({ reconnect: true });
    }
}

baudCustomInput.addEventListener('change', saveCustomBaudRate);
baudCustomInput.addEventListener('blur', saveCustomBaudRate);

['data-bits-select', 'stop-bits-select', 'parity-select'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveSerialModeConfig);
});

function applySerialParameterChange({ reconnect = false } = {}) {
    saveSerialModeConfig();
    if (reconnect && isConnected && !serialConnectInProgress && !serialReconnectInProgress) {
        reconnectSerialFromUi();
    }
}

function getBaudRate() {
    if (baudSelect.value === 'custom') {
        return baudCustomInput.value;
    }
    return baudSelect.value;
}

const refreshBtn = document.getElementById('refresh-btn');

let isConnected = false;

ensureThroughputSvg(throughputRxChart, 'rx');
ensureThroughputSvg(throughputTxChart, 'tx');
updateThroughputPanel({
    connected: false,
    rxHistory: Array(THROUGHPUT_BAR_COUNT).fill(0),
    txHistory: Array(THROUGHPUT_BAR_COUNT).fill(0),
    rxBytesPerSecond: 0,
    txBytesPerSecond: 0
});

async function refreshPorts() {
    const selectedPath = portSelect.value;
    const preferredPath = selectedPath || currentConfig?.lastSerialOptions?.path || '';
    const ports = await ipcRenderer.invoke('list-ports');
    portSelect.innerHTML = '<option value="">Select Port</option>';
    let hasPreferredPath = false;
    ports.forEach(port => {
        const opt = document.createElement('option');
        opt.value = port.path;
        opt.textContent = `${port.path} ${port.manufacturer || ''}`;
        if (preferredPath === port.path) {
            opt.selected = true;
            hasPreferredPath = true;
        }
        portSelect.appendChild(opt);
    });
    if (preferredPath && !hasPreferredPath) {
        portSelect.value = '';
    }
    setActionStatus(`已刷新串口列表，共 ${ports.length} 个端口`);
}

refreshBtn.addEventListener('click', refreshPorts);

portSelect.addEventListener('change', () => {
    if (isConnected && !serialConnectInProgress) {
        disconnectSerial();
        setActionStatus(trFallback('main.serialDisconnected', 'Serial port disconnected'));
    }
});

function clearActiveTerminal() {
    const { tabId: activeTabId } = getActiveTabInfo();
    if (!activeTabId) return;
    clearTerminalByTabId(activeTabId);
}

clearBtn.addEventListener('click', clearActiveTerminal);

const openLogFolderBtn = document.getElementById('open-log-folder-btn');
openLogFolderBtn.addEventListener('click', () => {
    ipcRenderer.send('open-log-folder');
    setActionStatus('已打开日志文件夹');
});

function getActiveTerminalExport() {
    const activeTabId = getActiveTabId();
    if (activeTabId === 'tab-main') {
        return { title: getMainTabTitle(), content: getTerminalPlainText(serialTerm) };
    }
    const filterTab = filterTabs.find(tab => tab.id === activeTabId);
    if (filterTab) {
        return { title: getFilterTabLogTitle(filterTab), content: getTerminalPlainText(filterTab.term) };
    }
    const shellTab = getShellTabState(activeTabId);
    if (shellTab) {
        return { title: shellTab.title || getShellTabLogTitle(shellTab), content: getTerminalPlainText(shellTab.term) };
    }
    return { title: getMainTabTitle(), content: getTerminalPlainText(serialTerm) };
}

document.getElementById('save-current-tab-btn').addEventListener('click', async () => {
    try {
        const result = await ipcRenderer.invoke('save-current-tab-log', getActiveTerminalExport());
        if (result?.filePath) {
            setActionStatus(trFallback('main.currentTabSaved', 'Current tab saved: {path}', { path: result.filePath }));
        }
    } catch (error) {
        setActionStatus(trFallback('main.currentTabSaveFailed', 'Failed to save current tab: {error}', {
            error: error?.message || String(error)
        }));
    }
});

async function connectSerialFromUi({ reconnecting = false } = {}) {
    if (serialConnectInProgress) return;
    const path = portSelect.value;
    const baudRate = getBaudRate();
    const dataBits = document.getElementById('data-bits-select').value;
    const stopBits = document.getElementById('stop-bits-select').value;
    const parity = document.getElementById('parity-select').value;
    newlineMode = document.getElementById('newline-mode-select').value;

    if (!path) return;
    serialConnectInProgress = true;
    serialWriteChain = Promise.resolve();
    hexFormatter.reset({ resetOffset: true });
    resetTextReceive();
    resetQuickTriggerReceive();
    connectBtn.disabled = true;
    if (reconnecting) setActionStatus(`正在应用新的波特率 ${baudRate}...`);
    try {
        const connectResult = await ipcRenderer.invoke('connect-serial', {
            path,
            baudRate,
            dataBits,
            stopBits,
            parity,
            sendEncoding,
            newlineMode
        });
        serialSessionId = Number.isInteger(connectResult?.sessionId) ? connectResult.sessionId : serialSessionId + 1;
        chartTabs.forEach(clearChartDataSession);

        ipcRenderer.send('save-config', {
            lastSerialOptions: {
                path,
                baudRate,
                dataBits,
                stopBits,
                parity,
                receiveDisplayMode,
                receiveEncoding,
                sendEncoding,
                newlineMode
            }
        });

        updateSerialConnectionState(true);
        updateAutoSendState();

        serialLineCounter = 1;
        logLineCounter = 1;
        serialNewLine = true;

        serialTerm.write(`\r\n\x1b[32m--- Connected to ${path} at ${baudRate} baud (${dataBits}N${stopBits}) ---\x1b[0m\r\n`);
        setActionStatus(reconnecting ? `已重新连接串口 ${path} @ ${baudRate}` : `已连接串口 ${path} @ ${baudRate}`);
    } catch (err) {
        setActionStatus(reconnecting ? `串口重连失败：${err}` : `串口连接失败：${err}`);
        alert((reconnecting ? 'Failed to reconnect: ' : 'Failed to connect: ') + err);
    } finally {
        serialConnectInProgress = false;
        connectBtn.disabled = false;
    }
}

async function reconnectSerialFromUi() {
    if (serialReconnectInProgress || serialConnectInProgress) return;
    if (!isConnected) {
        await connectSerialFromUi({ reconnecting: true });
        return;
    }

    const baudRate = getBaudRate();
    serialReconnectInProgress = true;
    connectBtn.disabled = true;
    setActionStatus(`正在应用新的波特率 ${baudRate}...`);
    try {
        const disconnected = waitForSerialDisconnected();
        disconnectSerial();
        await disconnected;
        await connectSerialFromUi({ reconnecting: true });
    } finally {
        serialReconnectInProgress = false;
        if (!serialConnectInProgress) connectBtn.disabled = false;
    }
}

async function toggleSerialConnection() {
    if (serialConnectInProgress) return;
    hideQuickSendDisconnectedToast();
    if (isConnected) {
        disconnectSerial();
    } else {
        await connectSerialFromUi();
    }
}

connectBtn.addEventListener('click', toggleSerialConnection);

// refreshPorts(); // Moved to config load chain

window.addEventListener('resize', () => {
    fitWorkspaceTerminals();
});

// Search Logic
const searchInput = document.getElementById('search-input');
const searchTargetLabel = document.getElementById('search-target-label');
const findNextBtn = document.getElementById('find-next-btn');
const findPrevBtn = document.getElementById('find-prev-btn');
const searchRegex = document.getElementById('search-regex');
const searchCase = document.getElementById('search-case');
const searchWord = document.getElementById('search-word');
const searchResultCount = document.getElementById('search-result-count');
let searchDebounceTimer = null;
const searchState = {
    key: '',
    total: 0,
    current: 0,
    regexError: '',
    matches: []
};
let activeSearchDecoration = null;

function getActiveSearchTarget() {
    const activeTabId = getActiveTabId();
    if (activeTabId === 'tab-main') {
        return {
            id: 'tab-main',
            label: tr('main.mainTerminal'),
            term: serialTerm,
            addon: serialSearchAddon
        };
    }

    const filterTab = filterTabs.find(tab => tab.id === activeTabId);
    if (filterTab) {
        return {
            id: filterTab.id,
            label: getFilterTabLogTitle(filterTab),
            term: filterTab.term,
            addon: filterTab.searchAddon
        };
    }

    const shellTab = getShellTabState(activeTabId);
    if (shellTab) {
        return {
            id: shellTab.id,
            label: shellTab.btn?.textContent?.trim() || getShellTabLogTitle(shellTab),
            term: shellTab.term,
            addon: shellTab.searchAddon
        };
    }

    return {
        id: 'tab-main',
        label: tr('main.mainTerminal'),
        term: serialTerm,
        addon: serialSearchAddon
    };
}

function updateSearchTargetLabel() {
    if (!searchTargetLabel) return;
    const target = getActiveSearchTarget();
    searchTargetLabel.textContent = trFallback('main.searchTarget', 'Target: {target}', { target: target.label });
}

function setSearchButtonsEnabled(enabled) {
    if (findNextBtn) findNextBtn.disabled = !enabled;
    if (findPrevBtn) findPrevBtn.disabled = !enabled;
}

function clearSearchDecorations(addon) {
    if (typeof addon?.clearDecorations === 'function') addon.clearDecorations();
    else if (typeof addon?.clearActiveDecoration === 'function') addon.clearActiveDecoration();
}

function clearSearchSelection(target = getActiveSearchTarget()) {
    activeSearchDecoration?.decoration?.dispose();
    activeSearchDecoration?.marker?.dispose();
    activeSearchDecoration = null;
    clearSearchDecorations(target.addon);
    if (typeof target.term?.clearSelection === 'function') target.term.clearSelection();
}

function decorateActiveSearchMatch(term, match) {
    activeSearchDecoration?.decoration?.dispose();
    activeSearchDecoration?.marker?.dispose();
    activeSearchDecoration = null;
    if (typeof term?.registerMarker !== 'function' || typeof term?.registerDecoration !== 'function') return;
    const buffer = term.buffer?.active;
    const cursorLine = (buffer?.baseY || 0) + (buffer?.cursorY || 0);
    const marker = term.registerMarker(match.line - cursorLine);
    if (!marker) return;
    const decoration = term.registerDecoration({
        marker,
        x: match.column,
        width: match.length,
        backgroundColor: highlightColors.search.background,
        foregroundColor: highlightColors.search.foreground,
        layer: 'top'
    });
    if (!decoration) {
        marker.dispose();
        return;
    }
    activeSearchDecoration = { decoration, marker };
}

function updateSearchResultCount(current = 0, resultCount = 0, regexError = '') {
    if (!searchResultCount) return;

    if (!searchInput.value) {
        searchResultCount.textContent = tr('main.searchResultEmpty');
        setSearchButtonsEnabled(false);
        return;
    }

    if (regexError) {
        searchResultCount.textContent = trFallback('main.searchRegexInvalid', 'Invalid regex: {error}', { error: regexError });
        setSearchButtonsEnabled(false);
        return;
    }

    if (!resultCount) {
        searchResultCount.textContent = tr('main.searchResultZero');
        setSearchButtonsEnabled(false);
        return;
    }

    setSearchButtonsEnabled(true);
    searchResultCount.textContent = tr('main.searchResultCount', {
        current,
        total: resultCount
    });
}

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRegex() {
    const term = searchInput.value;
    if (!term) return { regex: null, error: '' };

    let pattern = term;
    if (!searchRegex.checked) {
        pattern = escapeRegex(pattern);
    }
    if (searchWord.checked) {
        pattern = `\\b(?:${pattern})\\b`;
    }

    try {
        return { regex: new RegExp(pattern, searchCase.checked ? 'g' : 'gi'), error: '' };
    } catch (error) {
        return { regex: null, error: error.message || String(error) };
    }
}

function getSearchBufferVersion(term) {
    const buffer = term?.buffer?.active;
    if (!buffer) return '0:0:0:';
    const lastLine = buffer.length > 0 ? buffer.getLine(buffer.length - 1)?.translateToString(true) || '' : '';
    return `${buffer.length}:${buffer.baseY || 0}:${buffer.cursorY || 0}:${lastLine.length}:${lastLine.slice(-64)}`;
}

function buildSearchKey(target) {
    return JSON.stringify({
        query: searchInput.value,
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked,
        target: target.id,
        buffer: getSearchBufferVersion(target.term)
    });
}

function refreshSearchCount({ force = false } = {}) {
    updateSearchTargetLabel();
    const target = getActiveSearchTarget();
    const key = buildSearchKey(target);
    if (!force && key === searchState.key) {
        updateSearchResultCount(searchState.current, searchState.total, searchState.regexError);
        return searchState;
    }

    searchState.key = key;
    const { regex, error } = buildSearchRegex();
    searchState.regexError = error;
    if (!regex) {
        searchState.total = 0;
        searchState.current = 0;
        updateSearchResultCount(0, 0, error);
        return searchState;
    }

    const term = target.term;
    const bufferLines = term.buffer.active.length;
    const matches = [];
    for (let i = 0; i < bufferLines; i++) {
        const line = term.buffer.active.getLine(i);
        const text = line ? line.translateToString(true) : '';
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const value = match[0] || '';
            matches.push({ line: i, column: match.index, length: Math.max(1, value.length) });
            if (value.length === 0) regex.lastIndex++;
        }
    }

    searchState.matches = matches;
    searchState.total = matches.length;
    if (!searchState.total) {
        searchState.current = 0;
        updateSearchResultCount(0, 0);
        return searchState;
    }

    if (searchState.current > searchState.total) {
        searchState.current = 0;
    }
    updateSearchResultCount(searchState.current, searchState.total);
    return searchState;
}

function scheduleSearchRefresh() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => refreshSearchCount({ force: true }), 200);
}

function resetSearchState() {
    searchState.key = '';
    searchState.total = 0;
    searchState.current = 0;
    searchState.regexError = '';
    searchState.matches = [];
}

function scrollSearchMatchIntoCenter(term, line) {
    if (typeof term?.scrollToLine !== 'function') return;
    const visibleRows = Math.max(1, Number(term.rows) || 1);
    term.scrollToLine(Math.max(0, line - Math.floor(visibleRows / 2)));
}

function selectSearchMatch(index) {
    const target = getActiveSearchTarget();
    if (!searchState.total || index < 1 || index > searchState.total) {
        clearSearchSelection(target);
        return false;
    }
    const match = searchState.matches[index - 1];
    if (!match) return false;
    scrollSearchMatchIntoCenter(target.term, match.line);
    target.term.clearSelection?.();
    decorateActiveSearchMatch(target.term, match);
    searchState.current = index;
    updateSearchResultCount(searchState.current, searchState.total);
    return true;
}

function getSearchOptions() {
    return {
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked,
        incremental: false 
    };
}

findNextBtn.addEventListener('click', () => {
    refreshSearchCount();
    if (searchState.regexError || !searchState.total) return;
    const nextIndex = searchState.current >= searchState.total ? 1 : searchState.current + 1;
    selectSearchMatch(nextIndex);
});

findPrevBtn.addEventListener('click', () => {
    refreshSearchCount();
    if (searchState.regexError || !searchState.total) return;
    const previousIndex = searchState.current <= 1 ? searchState.total : searchState.current - 1;
    selectSearchMatch(previousIndex);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (e.shiftKey) {
             findPrevBtn.click();
        } else {
             findNextBtn.click();
        }
    }
});

searchInput.addEventListener('input', () => {
    resetSearchState();
    clearSearchSelection();
    if (!searchInput.value) {
        clearTimeout(searchDebounceTimer);
        updateSearchResultCount(0, 0);
        return;
    }
    scheduleSearchRefresh();
});

[searchRegex, searchCase, searchWord].forEach(control => {
    control.addEventListener('change', () => {
        resetSearchState();
        clearSearchSelection();
        if (!searchInput.value) {
            updateSearchResultCount(0, 0);
            return;
        }
        refreshSearchCount({ force: true });
    });
});

window.addEventListener('main-tab-changed', () => {
    clearTimeout(searchDebounceTimer);
    resetSearchState();
    updateSearchTargetLabel();
    if (!searchInput.value) {
        updateSearchResultCount(0, 0);
        return;
    }
    refreshSearchCount({ force: true });
});

updateSearchTargetLabel();
updateSearchResultCount(0, 0);

// Remove legacy filter window btn reference
// document.getElementById('new-filter-window-btn').addEventListener('click', ...);

// --- Auto Send & Quick Send Logic ---

let autoSendTimer = null;
let autoSendInFlight = false;
let autoSendGeneration = 0;
let appliedAutoSendKey = '';
const autoSendEnableCb = document.getElementById('auto-send-enable');
const autoSendIntervalInput = document.getElementById('auto-send-interval');
const autoSendTextInput = document.getElementById('auto-send-text');
const autoSendValidation = document.getElementById('auto-send-validation');

const quickSendListEl = document.getElementById('quick-send-list');
const sidebarQuickSendListEl = document.getElementById('sidebar-quick-send-list');
const openQuickSendDialogBtn = document.getElementById('open-quick-send-dialog-btn');
const quickSendDialog = document.getElementById('quick-send-dialog');
const quickSendDialogTitle = document.getElementById('quick-send-dialog-title');
const quickSendDialogCloseBtn = document.getElementById('quick-send-dialog-close');
const quickSendDialogCancelBtn = document.getElementById('quick-send-dialog-cancel');
const quickSendLabelInput = document.getElementById('quick-send-label');
const quickSendGroupSelect = document.getElementById('quick-send-group-select');
const quickSendNewGroupNameInput = document.getElementById('quick-send-new-group-name');
const addQuickSendGroupBtn = document.getElementById('add-quick-send-group-btn');
const quickSendGroupDeleteDialog = document.getElementById('quick-send-group-delete-dialog');
const quickSendGroupDeleteMessage = document.getElementById('quick-send-group-delete-message');
const quickSendGroupDeleteCancelBtn = document.getElementById('quick-send-group-delete-cancel');
const quickSendGroupDeleteConfirmBtn = document.getElementById('quick-send-group-delete-confirm');
const quickSendGroupDialog = document.getElementById('quick-send-group-dialog');
const quickSendGroupDialogTitle = document.getElementById('quick-send-group-dialog-title');
const quickSendGroupDialogCloseBtn = document.getElementById('quick-send-group-dialog-close');
const quickSendGroupDialogCancelBtn = document.getElementById('quick-send-group-dialog-cancel');
const quickSendGroupDialogSaveBtn = document.getElementById('quick-send-group-dialog-save');
const quickSendGroupDialogSaveLabel = quickSendGroupDialogSaveBtn.querySelector('span:last-child');
const quickSendGroupNameInput = document.getElementById('quick-send-group-name');
const quickSendContentInput = document.getElementById('quick-send-content');
const quickSendModeInputs = Array.from(document.querySelectorAll('input[name="quick-send-mode"]'));
const quickSendAppendCrlfInput = document.getElementById('quick-send-append-crlf');
const quickSendTriggerEnableInput = document.getElementById('quick-send-trigger-enable');
const quickSendTriggerTextInput = document.getElementById('quick-send-trigger-text');
const quickSendTriggerRegexInput = document.getElementById('quick-send-trigger-regex');
const quickSendTriggerCaseInput = document.getElementById('quick-send-trigger-case');
const quickSendTriggerWordInput = document.getElementById('quick-send-trigger-word');
const quickSendSidebarEnableInput = document.getElementById('quick-send-sidebar-enable');
const quickSendSidebarTextInput = document.getElementById('quick-send-sidebar-text');
const quickSendSidebarColorInput = document.getElementById('quick-send-sidebar-color');
const quickSendSidebarControls = document.getElementById('quick-send-sidebar-controls');
const addQuickSendBtn = document.getElementById('add-quick-send-btn');
const addQuickSendBtnLabel = addQuickSendBtn.querySelector('span:last-child');
const quickSendValidation = document.getElementById('quick-send-validation');

let quickSendList = [];
let quickSendGroups = [];
let sidebarQuickSendOrder = [];
let deletingQuickSendGroupId = '';
let quickSendGroupDeleteTrigger = null;
let editingQuickSendGroupId = '';
let quickSendGroupDialogTrigger = null;
let quickSendUngroupedCollapsed = false;
let quickSendGroupDragState = null;
const quickSendCollapseAnimations = new WeakMap();
const quickSendTriggerInFlight = new Set();
const quickSendFlashTimers = new WeakMap();
const quickSendClickTimers = new WeakMap();
let quickSendDisconnectedClicks = new WeakMap();
let quickSendDisconnectedToast = null;
let quickSendDisconnectedToastTimer = null;
let quickSendDisconnectedToastRemoveTimer = null;

function stopAutoSendRuntime() {
    autoSendGeneration++;
    if (autoSendTimer) clearTimeout(autoSendTimer);
    autoSendTimer = null;
    autoSendInFlight = false;
}

function getAutoSendRequest() {
    return {
        mode: 'text', content: autoSendTextInput.value,
        encoding: sendEncoding, appendCrLf: false,
        source: 'auto-send'
    };
}

function updateAutoSendValidation() {
    const request = getAutoSendRequest();
    const result = validateSendContent(request.mode, request.content, request.encoding, SEND_LIMITS.auto - (request.appendCrLf ? 2 : 0));
    autoSendValidation.textContent = formatValidation(result, request.mode, request.appendCrLf);
    autoSendValidation.classList.toggle('valid', result.ok);
    autoSendValidation.classList.toggle('invalid', !result.ok && request.content.length > 0);
    autoSendEnableCb.disabled = !result.ok;
    autoSendTextInput.placeholder = request.mode === 'hex' ? 'AA 55 01 FF' : tr('main.autoSendText');
    if (!result.ok && autoSendEnableCb.checked) {
        autoSendEnableCb.checked = false;
        stopAutoSendRuntime();
    }
    return result;
}

async function runAutoSendTick() {
    if (!autoSendEnableCb.checked || autoSendInFlight) return;
    const generation = autoSendGeneration;
    const interval = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
    if (!isConnected) {
        autoSendValidation.textContent = trFallback('main.autoSendWaiting', 'Waiting for serial connection');
        autoSendTimer = setTimeout(() => {
            if (generation === autoSendGeneration) runAutoSendTick();
        }, interval);
        return;
    }
    const request = getAutoSendRequest();
    if (!updateAutoSendValidation().ok) return;
    autoSendInFlight = true;
    const result = await sendSerialRequest(request, SEND_LIMITS.auto, { silent: true });
    if (generation !== autoSendGeneration) return;
    autoSendInFlight = false;
    if (!result.ok) {
        autoSendEnableCb.checked = false;
        stopAutoSendRuntime();
        setActionStatus(trFallback('main.autoSendStopped', 'Auto send stopped: {error}', { error: result.message || result.code }));
        saveAutoSendSettings();
        return;
    }
    autoSendValidation.textContent = trFallback('main.bytesSent', 'Sent {count} bytes', { count: result.bytesWritten });
    autoSendTimer = setTimeout(() => {
        if (generation === autoSendGeneration) runAutoSendTick();
    }, interval);
}

function updateAutoSendState() {
    stopAutoSendRuntime();
    if (autoSendEnableCb.checked && updateAutoSendValidation().ok) {
        const generation = autoSendGeneration;
        const interval = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
        autoSendTimer = setTimeout(() => {
            if (generation === autoSendGeneration) runAutoSendTick();
        }, interval);
    }
}

function saveAutoSendSettings() {
    if (isApplyingConfig) return;
    const autoSendSettings = getAutoSendSettings();
    appliedAutoSendKey = JSON.stringify(autoSendSettings);
    ipcRenderer.send('save-config', { autoSendSettings });
}

function getAutoSendSettings() {
    return {
        enabled: autoSendEnableCb.checked,
        interval: Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000),
        content: autoSendTextInput.value
    };
}

function applyAutoSendConfig(settings) {
    const normalized = {
        enabled: settings.enabled === true,
        interval: Math.max(10, Number(settings.interval) || 1000),
        content: settings.content || ''
    };
    const settingsKey = JSON.stringify(normalized);
    if (settingsKey === appliedAutoSendKey) return false;
    appliedAutoSendKey = settingsKey;
    autoSendEnableCb.checked = normalized.enabled;
    autoSendIntervalInput.value = normalized.interval;
    autoSendTextInput.value = normalized.content;
    return true;
}

autoSendEnableCb.addEventListener('change', () => {
    updateAutoSendState();
    saveAutoSendSettings();
});

autoSendIntervalInput.addEventListener('change', () => {
    autoSendIntervalInput.value = Math.max(10, Number.parseInt(autoSendIntervalInput.value, 10) || 1000);
    updateAutoSendState();
    saveAutoSendSettings();
});
autoSendTextInput.addEventListener('input', updateAutoSendValidation);
autoSendTextInput.addEventListener('blur', saveAutoSendSettings);
let editingQuickSendId = '';
const QUICK_SEND_HOLD_MS = 420;
const QUICK_SEND_MOVE_THRESHOLD = 8;
const quickSendReorderContexts = [
    {
        container: quickSendListEl,
        compact: false,
        editMode: false,
        dragState: null,
        holdTimer: null,
        suppressClickUntil: 0
    },
    {
        container: sidebarQuickSendListEl,
        compact: true,
        editMode: false,
        dragState: null,
        holdTimer: null,
        suppressClickUntil: 0
    }
];

function getQuickSendReorderContext(compact) {
    return quickSendReorderContexts.find(context => context.compact === compact);
}

function getQuickSendReorderElements(context) {
    if (!context?.container) return [];
    return context.compact
        ? Array.from(context.container.children).filter(element => element.classList.contains('quick-send-item'))
        : Array.from(context.container.querySelectorAll('.quick-send-item'));
}

function clearQuickSendHoldTimer(context) {
    if (context?.holdTimer !== null) {
        clearTimeout(context.holdTimer);
        context.holdTimer = null;
    }
}

function syncQuickSendEditMode(context) {
    if (!context) return;
    context.container?.classList.toggle('quick-send-reorder-mode', context.editMode);
    getQuickSendReorderElements(context).forEach(element => {
        const isDragged = context.dragState?.element === element && context.dragState.dragging;
        element.setAttribute('aria-grabbed', isDragged ? 'true' : 'false');
        const deleteButton = element.querySelector('.quick-send-edit-delete-btn');
        if (deleteButton) {
            deleteButton.tabIndex = context.editMode ? 0 : -1;
            deleteButton.setAttribute('aria-hidden', context.editMode ? 'false' : 'true');
        }
    });
}

function applyQuickSendElementOrder(context, orderedIds) {
    if (context.compact) {
        sidebarQuickSendOrder = [...orderedIds];
        normalizeSidebarQuickSendOrder();
        return;
    }
    const byId = new Map(quickSendList.map(item => [item.id, item]));
    quickSendList = getQuickSendReorderElements(context).map(element => ({
        ...byId.get(element.dataset.quickId),
        groupId: element.closest('.quick-send-group')?.dataset.quickGroupId || null
    })).filter(item => item.id);
}

function cleanUpQuickSendDrag(context, state) {
    if (!context || !state || state.cleanedUp) return;
    state.cleanedUp = true;
    state.snapFallbackTimer && clearTimeout(state.snapFallbackTimer);
    state.expandTimer && clearTimeout(state.expandTimer);
    state.indicator?.remove();
    state.preview?.remove();
    state.element?.classList.remove('dragging', 'quick-send-drag-placeholder');
    try {
        if (state.element?.hasPointerCapture?.(state.pointerId)) {
            state.element.releasePointerCapture(state.pointerId);
        }
    } catch {
        // Pointer capture may already be released after pointerup/cancel.
    }
    if (context.dragState === state) context.dragState = null;
    syncQuickSendEditMode(context);
}

function cancelQuickSendDrag(context, { restoreOrder = true } = {}) {
    if (!context) return;
    clearQuickSendHoldTimer(context);
    const state = context.dragState;
    if (!state) return;
    const originalOrder = !state.committed && Array.isArray(state.originalOrder) ? state.originalOrder : null;
    const originalItems = !state.committed && Array.isArray(state.originalItems) ? state.originalItems : null;
    const originalGroups = !state.committed && Array.isArray(state.originalGroups) ? state.originalGroups : null;
    cleanUpQuickSendDrag(context, state);
    if (restoreOrder && (originalItems || originalOrder)) {
        if (context.compact) applyQuickSendElementOrder(context, originalOrder);
        else {
            quickSendList = originalItems;
            if (originalGroups) quickSendGroups = originalGroups;
        }
        renderQuickSendLists();
    }
}

function setQuickSendEditMode(context, enabled) {
    if (!context) return;
    const nextMode = enabled === true;
    if (!nextMode && context.dragState) {
        cancelQuickSendDrag(context, { restoreOrder: true });
    }
    context.editMode = nextMode;
    syncQuickSendEditMode(context);
}

function animateQuickSendReflow(previousRects, elements) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
    requestAnimationFrame(() => {
        elements.forEach(element => {
            const previous = previousRects.get(element.dataset.quickId);
            if (!previous || !element.isConnected) return;
            const current = element.getBoundingClientRect();
            const offset = previous.top - current.top;
            if (Math.abs(offset) < 1) return;
            element.animate([
                { transform: `translateY(${offset}px)` },
                { transform: 'translateY(0)' }
            ], {
                duration: 180,
                easing: 'cubic-bezier(.2,.8,.2,1)'
            });
        });
    });
}

function positionQuickSendIndicator(context, state) {
    if (!context?.container || !state.indicator?.isConnected) return;
    const listRect = context.container.getBoundingClientRect();
    const targetRect = state.element.getBoundingClientRect();
    const scrollOffset = context.compact ? 0 : context.container.scrollTop;
    state.indicator.style.top = `${targetRect.top - listRect.top + scrollOffset - 3}px`;
}

function updateQuickSendDropTarget(context, state, pointerY) {
    if (!context?.container || !state.dragging) return;
    if (!context.compact) {
        const groups = Array.from(context.container.querySelectorAll('.quick-send-group'));
        const targetGroup = groups.reduce((nearest, group) => {
            const rect = group.getBoundingClientRect();
            const distance = pointerY < rect.top ? rect.top - pointerY : (pointerY > rect.bottom ? pointerY - rect.bottom : 0);
            return !nearest || distance < nearest.distance ? { group, distance } : nearest;
        }, null)?.group;
        const body = targetGroup?.querySelector('.quick-send-group-items');
        if (!targetGroup || !body) return;
        const groupId = targetGroup.dataset.quickGroupId || null;
        const group = quickSendGroups.find(entry => entry.id === groupId);
        if (group?.collapsed && state.expandGroupId !== group.id) {
            clearTimeout(state.expandTimer);
            state.expandGroupId = group.id;
            state.expandTimer = setTimeout(() => {
                group.collapsed = false;
                state.temporarilyExpandedGroupIds.add(group.id);
                targetGroup.classList.remove('collapsed');
                targetGroup.querySelector('.quick-send-group-toggle')?.setAttribute('aria-expanded', 'true');
            }, 500);
        } else if (!group?.collapsed && state.expandGroupId !== (groupId || '')) {
            clearTimeout(state.expandTimer);
            state.expandGroupId = groupId || '';
        }
        const otherElements = Array.from(body.querySelectorAll('.quick-send-item')).filter(element => element !== state.element);
        const insertionIndex = getVerticalInsertionIndex(otherElements.map(element => element.getBoundingClientRect()), pointerY);
        const currentParent = state.element.parentElement;
        const currentIndex = Array.from(currentParent?.querySelectorAll('.quick-send-item') || []).indexOf(state.element);
        if (currentParent !== body || insertionIndex !== currentIndex) {
            const movingElements = getQuickSendReorderElements(context).filter(element => element !== state.element);
            const previousRects = new Map(movingElements.map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
            body.insertBefore(state.element, otherElements[insertionIndex] || null);
            animateQuickSendReflow(previousRects, movingElements);
        }
        state.targetGroupId = groupId;
        state.insertionIndex = insertionIndex;
        requestAnimationFrame(() => positionQuickSendIndicator(context, state));
        return;
    }
    const otherElements = getQuickSendReorderElements(context).filter(element => element !== state.element);
    const rects = otherElements.map(element => element.getBoundingClientRect());
    const insertionIndex = getVerticalInsertionIndex(rects, pointerY);
    const currentIndex = getQuickSendReorderElements(context).indexOf(state.element);

    if (insertionIndex !== currentIndex) {
        const previousRects = new Map(otherElements.map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
        const beforeElement = otherElements[insertionIndex] || state.indicator || null;
        if (beforeElement) {
            context.container.insertBefore(state.element, beforeElement);
        } else {
            context.container.appendChild(state.element);
        }
        animateQuickSendReflow(previousRects, otherElements);
    }

    state.insertionIndex = insertionIndex;
    requestAnimationFrame(() => positionQuickSendIndicator(context, state));
}

function scrollQuickSendDuringDrag(context, pointerY) {
    const scroller = context?.compact ? context.container?.parentElement : context?.container;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const edgeSize = Math.min(42, rect.height / 4);
    if (pointerY < rect.top + edgeSize) {
        scroller.scrollTop -= Math.ceil((rect.top + edgeSize - pointerY) / 5);
    } else if (pointerY > rect.bottom - edgeSize) {
        scroller.scrollTop += Math.ceil((pointerY - (rect.bottom - edgeSize)) / 5);
    }
}

function updateQuickSendDragPosition(context, state, clientX, clientY) {
    if (!state.preview || !state.dragging) return;
    const maxLeft = Math.max(4, window.innerWidth - state.previewRect.width - 4);
    const maxTop = Math.max(4, window.innerHeight - state.previewRect.height - 4);
    const left = Math.max(4, Math.min(clientX - state.pointerOffsetX, maxLeft));
    const top = Math.max(4, Math.min(clientY - state.pointerOffsetY, maxTop));
    const tilt = Math.max(-4, Math.min(4, (clientX - state.startX) / 12));
    state.preview.style.left = `${left}px`;
    state.preview.style.top = `${top}px`;
    state.preview.style.setProperty('--quick-send-drag-tilt', `${tilt}deg`);
    scrollQuickSendDuringDrag(context, clientY);
    updateQuickSendDropTarget(context, state, clientY);
}

function startQuickSendDrag(context, state) {
    if (!context || !state || state !== context.dragState || state.dragging || !state.element?.isConnected) return;
    clearQuickSendHoldTimer(context);
    setQuickSendEditMode(context, true);

    const rect = state.element.getBoundingClientRect();
    state.dragging = true;
    state.originalOrder = getQuickSendReorderElements(context).map(element => element.dataset.quickId);
    state.originalItems = context.compact ? null : quickSendList.map(item => ({ ...item }));
    state.originalGroups = context.compact ? null : quickSendGroups.map(group => ({ ...group }));
    state.temporarilyExpandedGroupIds = new Set();
    state.pointerOffsetX = Math.max(0, Math.min(rect.width, state.lastX - rect.left));
    state.pointerOffsetY = Math.max(0, Math.min(rect.height, state.lastY - rect.top));
    state.previewRect = rect;
    state.element.classList.add('dragging', 'quick-send-drag-placeholder');

    const preview = state.element.cloneNode(true);
    preview.classList.remove('dragging', 'quick-send-drag-placeholder');
    preview.classList.add('quick-send-drag-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.removeAttribute('draggable');
    preview.removeAttribute('aria-grabbed');
    preview.querySelectorAll('button, [tabindex]').forEach(element => { element.tabIndex = -1; });
    preview.style.width = `${rect.width}px`;
    preview.style.height = `${rect.height}px`;
    preview.style.left = `${rect.left}px`;
    preview.style.top = `${rect.top}px`;
    document.body.appendChild(preview);
    state.preview = preview;

    const indicator = document.createElement('div');
    indicator.className = 'quick-send-drop-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    context.container.appendChild(indicator);
    state.indicator = indicator;

    try {
        state.element.setPointerCapture?.(state.pointerId);
    } catch {
        // Pointer capture is optional; document listeners keep the drag working.
    }
    context.suppressClickUntil = performance.now() + 600;
    navigator.vibrate?.(12);
    syncQuickSendEditMode(context);
    updateQuickSendDragPosition(context, state, state.lastX, state.lastY);
}

function finishQuickSendDrag(context, state) {
    if (!context || !state || state !== context.dragState || !state.dragging || state.finishing) return;
    state.finishing = true;
    clearQuickSendHoldTimer(context);
    context.suppressClickUntil = performance.now() + 600;

    const orderedElements = getQuickSendReorderElements(context);
    orderedElements.forEach((element, index) => { element.dataset.index = String(index); });
    applyQuickSendElementOrder(context, orderedElements.map(element => element.dataset.quickId));
    state.committed = true;
    if (!context.compact && state.temporarilyExpandedGroupIds.size) {
        state.temporarilyExpandedGroupIds.forEach(groupId => {
            const group = quickSendGroups.find(entry => entry.id === groupId);
            if (group) group.collapsed = true;
        });
        saveQuickSendList();
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
        return;
    }
    saveQuickSendList();
    state.indicator?.remove();
    state.indicator = null;

    const targetRect = state.element?.getBoundingClientRect();
    const previewRect = state.preview?.getBoundingClientRect();
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduceMotion || !targetRect || !previewRect || targetRect.width === 0 || targetRect.height === 0
        || typeof state.preview.animate !== 'function') {
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
        return;
    }

    let cleanedUp = false;
    const finishVisuals = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        cleanUpQuickSendDrag(context, state);
        renderQuickSendLists();
    };
    const animation = state.preview.animate([
        {
            left: `${previewRect.left}px`,
            top: `${previewRect.top}px`,
            transform: getComputedStyle(state.preview).transform,
            opacity: 1
        },
        {
            left: `${targetRect.left}px`,
            top: `${targetRect.top}px`,
            transform: 'rotate(0deg) scale(1)',
            opacity: 0.45
        }
    ], {
        duration: 190,
        easing: 'cubic-bezier(.2,.85,.25,1)',
        fill: 'forwards'
    });
    animation.addEventListener('finish', finishVisuals, { once: true });
    animation.addEventListener('cancel', finishVisuals, { once: true });
    state.snapFallbackTimer = setTimeout(finishVisuals, 260);
}

function beginQuickSendPointer(context, event, element) {
    if (!context || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    if (context.dragState?.finishing) return;
    quickSendReorderContexts.forEach(otherContext => {
        if (otherContext !== context && otherContext.dragState) {
            cancelQuickSendDrag(otherContext, { restoreOrder: true });
        }
    });
    cancelQuickSendDrag(context, { restoreOrder: true });

    const state = {
        pointerId: event.pointerId,
        element,
        itemId: element.dataset.quickId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        dragging: false,
        finishing: false
    };
    context.dragState = state;

    if (!context.editMode) {
        context.holdTimer = setTimeout(() => {
            if (context.dragState !== state) return;
            startQuickSendDrag(context, state);
        }, QUICK_SEND_HOLD_MS);
    }
}

function getQuickSendPointerContext(event) {
    return quickSendReorderContexts.find(context => {
        const state = context.dragState;
        return state && !state.finishing && event.pointerId === state.pointerId;
    });
}

function handleQuickSendPointerMove(event) {
    const context = getQuickSendPointerContext(event);
    const state = context?.dragState;
    if (!context || !state) return;
    state.lastX = event.clientX;
    state.lastY = event.clientY;

    if (!state.dragging) {
        const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
        if (context.editMode && distance >= QUICK_SEND_MOVE_THRESHOLD) {
            startQuickSendDrag(context, state);
        } else if (!context.editMode && distance >= QUICK_SEND_MOVE_THRESHOLD) {
            clearQuickSendHoldTimer(context);
            context.dragState = null;
        }
    }

    if (state.dragging) {
        event.preventDefault();
        updateQuickSendDragPosition(context, state, event.clientX, event.clientY);
    }
}

function handleQuickSendPointerUp(event) {
    const context = getQuickSendPointerContext(event);
    const state = context?.dragState;
    if (!context || !state) return;
    clearQuickSendHoldTimer(context);
    if (state.dragging) {
        event.preventDefault();
        finishQuickSendDrag(context, state);
    } else {
        context.dragState = null;
    }
}

function handleQuickSendPointerCancel(event) {
    const context = getQuickSendPointerContext(event);
    if (context) cancelQuickSendDrag(context, { restoreOrder: true });
}

function createQuickSendId() {
    return `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createQuickSendGroupId() {
    return `quick-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeQuickSendGroup(group = {}) {
    return {
        id: typeof group.id === 'string' && group.id ? group.id : createQuickSendGroupId(),
        name: typeof group.name === 'string' && group.name.trim()
            ? group.name.trim().slice(0, 60)
            : trFallback('main.quickSendGroupDefault', 'New Group'),
        collapsed: group.collapsed === true
    };
}

function normalizeQuickSendItem(item = {}) {
    const trigger = item.autoTrigger && typeof item.autoTrigger === 'object' ? item.autoTrigger : {};
    return {
        id: typeof item.id === 'string' && item.id ? item.id : createQuickSendId(),
        groupId: typeof item.groupId === 'string' && quickSendGroups.some(group => group.id === item.groupId)
            ? item.groupId
            : null,
        label: typeof item.label === 'string' ? item.label : '',
        mode: item.mode === 'hex' ? 'hex' : 'text',
        appendCrLf: item.appendCrLf === true,
        content: typeof item.content === 'string' ? item.content : '',
        sidebarShortcut: {
            enabled: item.sidebarShortcut?.enabled === true,
            text: typeof item.sidebarShortcut?.text === 'string' ? item.sidebarShortcut.text : '',
            backgroundColor: /^#[0-9a-f]{6}$/i.test(item.sidebarShortcut?.backgroundColor || '')
                ? item.sidebarShortcut.backgroundColor
                : ''
        },
        autoTrigger: {
            enabled: trigger.enabled === true,
            text: typeof trigger.text === 'string' ? trigger.text : '',
            useRegex: trigger.useRegex === true,
            caseSensitive: trigger.caseSensitive === true,
            wholeWord: trigger.wholeWord === true
        }
    };
}

function buildQuickTriggerRegex(trigger = {}) {
    const text = typeof trigger.text === 'string' ? trigger.text : '';
    if (!text) return { ok: true, regex: null };
    let pattern = text;
    if (trigger.useRegex !== true) {
        pattern = escapeRegex(pattern);
    }
    if (trigger.wholeWord === true) {
        pattern = `\\b(?:${pattern})\\b`;
    }
    try {
        return { ok: true, regex: new RegExp(pattern, trigger.caseSensitive === true ? '' : 'i') };
    } catch (error) {
        return { ok: false, message: trFallback('main.quickTriggerRegexInvalid', 'Auto-trigger regex is invalid: {error}', { error: error.message }) };
    }
}

function getQuickEditorItem() {
    const selectedGroupId = quickSendGroupSelect.value;
    return normalizeQuickSendItem({
        id: editingQuickSendId || createQuickSendId(),
        groupId: selectedGroupId && selectedGroupId !== '__new__' ? selectedGroupId : null,
        label: quickSendLabelInput.value.trim(),
        mode: quickSendModeInputs.find(input => input.checked)?.value === 'hex' ? 'hex' : 'text',
        appendCrLf: quickSendAppendCrlfInput.checked,
        content: quickSendContentInput.value,
        sidebarShortcut: {
            enabled: quickSendSidebarEnableInput.checked,
            text: quickSendSidebarTextInput.value.trim(),
            backgroundColor: quickSendSidebarColorInput.value
        },
        autoTrigger: {
            enabled: quickSendTriggerEnableInput.checked,
            text: quickSendTriggerTextInput.value,
            useRegex: quickSendTriggerRegexInput.checked,
            caseSensitive: quickSendTriggerCaseInput.checked,
            wholeWord: quickSendTriggerWordInput.checked
        }
    });
}

function closeQuickSendDialog() {
    quickSendDialog.classList.add('hidden');
    editingQuickSendId = '';
    quickSendLabelInput.value = '';
    quickSendGroupSelect.value = '';
    quickSendNewGroupNameInput.value = '';
    quickSendNewGroupNameInput.classList.add('hidden');
    quickSendContentInput.value = '';
    quickSendModeInputs.forEach(input => { input.checked = input.value === 'text'; });
    quickSendAppendCrlfInput.checked = false;
    quickSendTriggerEnableInput.checked = false;
    quickSendTriggerTextInput.value = '';
    quickSendTriggerRegexInput.checked = false;
    quickSendTriggerCaseInput.checked = false;
    quickSendTriggerWordInput.checked = false;
    quickSendSidebarEnableInput.checked = false;
    quickSendSidebarTextInput.value = '';
    quickSendSidebarColorInput.value = '#333333';
    updateQuickSidebarEditorState();
    renderQuickSendLists();
}

function updateQuickSidebarEditorState() {
    const enabled = quickSendSidebarEnableInput.checked;
    quickSendSidebarTextInput.disabled = !enabled;
    quickSendSidebarColorInput.disabled = !enabled;
    quickSendSidebarControls.classList.toggle('controls-disabled', !enabled);
}

function openQuickSendDialog(itemId = '') {
    editingQuickSendId = itemId;
    const item = quickSendList.find(entry => entry.id === itemId) || null;
    renderQuickSendGroupOptions(item?.groupId || null);
    quickSendLabelInput.value = item?.label || '';
    quickSendContentInput.value = item?.content || '';
    quickSendModeInputs.forEach(input => { input.checked = input.value === (item?.mode || mainInputMode); });
    quickSendAppendCrlfInput.checked = item?.appendCrLf === true;
    quickSendTriggerEnableInput.checked = item?.autoTrigger?.enabled === true;
    quickSendTriggerTextInput.value = item?.autoTrigger?.text || '';
    quickSendTriggerRegexInput.checked = item?.autoTrigger?.useRegex === true;
    quickSendTriggerCaseInput.checked = item?.autoTrigger?.caseSensitive === true;
    quickSendTriggerWordInput.checked = item?.autoTrigger?.wholeWord === true;
    quickSendSidebarEnableInput.checked = item?.sidebarShortcut?.enabled === true;
    quickSendSidebarTextInput.value = item?.sidebarShortcut?.text || '';
    quickSendSidebarColorInput.value = item?.sidebarShortcut?.backgroundColor || '#333333';
    updateQuickSidebarEditorState();
    const editing = Boolean(item);
    quickSendDialogTitle.textContent = editing
        ? trFallback('main.editQuickSend', 'Edit Quick Send')
        : trFallback('main.addQuickSend', 'Add Quick Send');
    addQuickSendBtnLabel.textContent = editing
        ? trFallback('main.updateItem', 'Update Item')
        : tr('main.addToList');
    updateQuickSendValidation();
    renderQuickSendLists();
    quickSendDialog.classList.remove('hidden');
    requestAnimationFrame(() => (editing ? quickSendContentInput : quickSendLabelInput).focus());
}

function renderQuickSendGroupOptions(selectedGroupId = null) {
    quickSendGroupSelect.innerHTML = '';
    quickSendGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group.id;
        option.textContent = group.name;
        quickSendGroupSelect.appendChild(option);
    });
    const ungrouped = document.createElement('option');
    ungrouped.value = '';
    ungrouped.textContent = trFallback('main.quickSendUngrouped', 'Ungrouped');
    quickSendGroupSelect.appendChild(ungrouped);
    const createOption = document.createElement('option');
    createOption.value = '__new__';
    createOption.textContent = trFallback('main.quickSendCreateGroup', '+ New Group');
    quickSendGroupSelect.appendChild(createOption);
    quickSendGroupSelect.value = selectedGroupId || '';
}

function createNamedQuickSendGroup(name) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) return null;
    const group = normalizeQuickSendGroup({ id: createQuickSendGroupId(), name: trimmed, collapsed: false });
    quickSendGroups.push(group);
    return group;
}

function updateQuickSendValidation() {
    const item = getQuickEditorItem();
    const result = validateSendContent(item.mode, item.content, sendEncoding, SEND_LIMITS.quick - (item.appendCrLf ? 2 : 0));
    const triggerResult = !item.autoTrigger.enabled
        ? { ok: true, regex: null }
        : (!item.autoTrigger.text
            ? { ok: false, message: trFallback('main.quickTriggerTextRequired', 'Auto trigger needs match text') }
            : buildQuickTriggerRegex(item.autoTrigger));
    const groupResult = quickSendGroupSelect.value !== '__new__' || quickSendNewGroupNameInput.value.trim()
        ? { ok: true }
        : { ok: false, message: trFallback('main.quickSendGroupNameRequired', 'Enter a group name') };
    quickSendValidation.textContent = !groupResult.ok
        ? groupResult.message
        : triggerResult.ok
        ? formatValidation(result, item.mode, item.appendCrLf)
        : triggerResult.message;
    quickSendValidation.classList.toggle('valid', result.ok && triggerResult.ok && groupResult.ok);
    quickSendValidation.classList.toggle('invalid', (!result.ok && item.content.length > 0) || !triggerResult.ok || !groupResult.ok);
    addQuickSendBtn.disabled = !result.ok || !triggerResult.ok || !groupResult.ok;
    quickSendContentInput.placeholder = item.mode === 'hex' ? 'AA 55 01 FF' : tr('main.contentMultiLine');
    return { ...result, ok: result.ok && triggerResult.ok && groupResult.ok };
}

async function triggerQuickSendItem(item) {
    if (quickSendTriggerInFlight.has(item.id)) return;
    quickSendTriggerInFlight.add(item.id);
    try {
        flashQuickSendItem(item.id);
        const result = await sendSerialRequest({ mode: item.mode, content: item.content, appendCrLf: item.appendCrLf, source: 'quick-send-trigger' }, SEND_LIMITS.quick, { silent: true });
        const label = item.label || item.content;
        setActionStatus(result.ok
            ? trFallback('main.quickTriggerSent', 'Auto-trigger sent: {label}', { label })
            : trFallback('main.quickTriggerFailed', 'Auto-trigger failed: {error}', { error: result.message || result.code }));
    } finally {
        quickSendTriggerInFlight.delete(item.id);
    }
}

function showQuickSendClickResult(button, ok) {
    if (!button) return;
    const className = ok ? 'quick-send-click-success' : 'quick-send-click-failed';
    const previousTimer = quickSendClickTimers.get(button);
    if (previousTimer) clearTimeout(previousTimer);
    button.classList.remove('quick-send-click-success', 'quick-send-click-failed');
    void button.offsetWidth;
    button.classList.add(className);
    const timer = setTimeout(() => {
        button.classList.remove(className);
        quickSendClickTimers.delete(button);
    }, 320);
    quickSendClickTimers.set(button, timer);
}

function hideQuickSendDisconnectedToast(animate = true) {
    if (quickSendDisconnectedToastTimer) clearTimeout(quickSendDisconnectedToastTimer);
    quickSendDisconnectedToastTimer = null;
    const toast = quickSendDisconnectedToast;
    if (!toast) return;
    if (quickSendDisconnectedToastRemoveTimer) clearTimeout(quickSendDisconnectedToastRemoveTimer);
    quickSendDisconnectedToastRemoveTimer = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (!animate || reduceMotion) {
        toast.remove();
        quickSendDisconnectedToast = null;
        return;
    }
    toast.classList.add('quick-send-toast-hiding');
    quickSendDisconnectedToastRemoveTimer = setTimeout(() => {
        toast.remove();
        if (quickSendDisconnectedToast === toast) quickSendDisconnectedToast = null;
        quickSendDisconnectedToastRemoveTimer = null;
    }, 180);
}

function showQuickSendDisconnectedToast(button) {
    if (!button?.isConnected) return;
    hideQuickSendDisconnectedToast(false);

    const toast = document.createElement('div');
    toast.className = 'quick-send-disconnected-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = trFallback('main.quickSendDisconnectedToast', 'Hold on, did you forget to open the serial port?');
    document.body.appendChild(toast);

    const buttonRect = button.getBoundingClientRect();
    const toastRect = toast.getBoundingClientRect();
    const gap = 8;
    const edge = 8;
    const fitsRight = buttonRect.right + gap + toastRect.width <= window.innerWidth - edge;
    const left = fitsRight
        ? buttonRect.right + gap
        : buttonRect.left - gap - toastRect.width;
    toast.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - toastRect.width - edge))}px`;
    toast.style.top = `${Math.max(edge, Math.min(
        buttonRect.top + (buttonRect.height - toastRect.height) / 2,
        window.innerHeight - toastRect.height - edge
    ))}px`;
    quickSendDisconnectedToast = toast;
    quickSendDisconnectedToastTimer = setTimeout(hideQuickSendDisconnectedToast, 3000);
}

function recordQuickSendDisconnectedClick(button) {
    const now = performance.now();
    const previous = quickSendDisconnectedClicks.get(button);
    const count = previous && now - previous.lastClick <= 2000 ? previous.count + 1 : 1;
    quickSendDisconnectedClicks.set(button, { count, lastClick: now });
    if (count >= 3) showQuickSendDisconnectedToast(button);
}

function flashQuickSendItem(itemId, className = 'auto-trigger-flash', duration = 1300) {
    if (!itemId) return;
    document.querySelectorAll(`.quick-send-item[data-quick-id="${CSS.escape(itemId)}"] .quick-send-main-btn`).forEach(button => {
        button.classList.remove('auto-trigger-flash', 'quick-send-click-success', 'quick-send-click-failed');
        void button.offsetWidth;
        button.classList.add(className);
        const previousTimer = quickSendFlashTimers.get(button);
        if (previousTimer) clearTimeout(previousTimer);
        const timer = setTimeout(() => {
            button.classList.remove(className);
            quickSendFlashTimers.delete(button);
        }, duration);
        quickSendFlashTimers.set(button, timer);
    });
}

function processQuickSendAutoTriggers(bytes) {
    const triggerItems = quickSendList.filter(item => item.autoTrigger?.enabled === true && item.autoTrigger.text);
    if (!triggerItems.length) return;
    if (!quickTriggerDecoder) createQuickTriggerDecoder();
    const text = quickTriggerDecoder.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!text) return;
    quickTriggerBuffer = (quickTriggerBuffer + text).slice(-4096);
    const matchedItems = [];
    triggerItems.forEach(item => {
        const triggerResult = buildQuickTriggerRegex(item.autoTrigger);
        if (triggerResult.ok && triggerResult.regex?.test(quickTriggerBuffer)) {
            matchedItems.push(item);
        }
    });
    if (!matchedItems.length) return;
    quickTriggerBuffer = '';
    matchedItems.forEach(triggerQuickSendItem);
}

function normalizeSidebarQuickSendOrder() {
    const groupOrder = new Map(quickSendGroups.map((group, index) => [group.id, index]));
    const itemOrder = new Map(quickSendList.map((item, index) => [item.id, index]));
    const enabledIds = quickSendList
        .filter(item => item.sidebarShortcut?.enabled === true)
        .sort((a, b) => {
            const aGroup = groupOrder.get(a.groupId) ?? quickSendGroups.length;
            const bGroup = groupOrder.get(b.groupId) ?? quickSendGroups.length;
            return aGroup - bGroup || itemOrder.get(a.id) - itemOrder.get(b.id);
        })
        .map(item => item.id);
    const enabledIdSet = new Set(enabledIds);
    const orderedIds = [...new Set(sidebarQuickSendOrder.filter(id => enabledIdSet.has(id)))];
    sidebarQuickSendOrder = [...orderedIds, ...enabledIds.filter(id => !orderedIds.includes(id))];
}

function animateQuickSendRemoval(element, onComplete) {
    let completed = false;
    const complete = () => {
        if (completed) return;
        completed = true;
        onComplete();
    };

    if (!element?.isConnected) {
        complete();
        return;
    }
    if (element.classList.contains('quick-send-removing')) return;
    element.classList.add('quick-send-removing');

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    if (reduceMotion || typeof element.animate !== 'function') {
        complete();
        return;
    }

    const animation = element.animate([
        { opacity: 1 },
        { opacity: 0 }
    ], {
        duration: 220,
        easing: 'ease-out',
        fill: 'forwards'
    });
    animation.addEventListener('finish', complete, { once: true });
    animation.addEventListener('cancel', complete, { once: true });
}

function removeSidebarQuickSendShortcut(item, element) {
    if (!item?.id) return;
    animateQuickSendRemoval(element, () => {
        const result = disableSidebarQuickSend(quickSendList, sidebarQuickSendOrder, item.id);
        if (!result.changed) return;
        quickSendList = result.quickSendList;
        sidebarQuickSendOrder = result.sidebarQuickSendOrder;
        saveQuickSendList();
        renderQuickSendLists();
        setActionStatus(trFallback('main.quickSendSidebarRemoved', 'Removed sidebar shortcut: {label}', { label: item.label || item.content }));
    });
}

function deleteQuickSendItem(item, element) {
    if (!item?.id) return;
    animateQuickSendRemoval(element, () => {
        const result = deleteQuickSendById(quickSendList, sidebarQuickSendOrder, item.id);
        if (!result.changed) return;
        if (editingQuickSendId === item.id) closeQuickSendDialog();
        quickSendList = result.quickSendList;
        sidebarQuickSendOrder = result.sidebarQuickSendOrder;
        saveQuickSendList();
        renderQuickSendLists();
        setActionStatus(trFallback('main.quickSendDeleted', 'Deleted quick command: {label}', { label: item.label || item.content }));
    });
}

function setQuickSendGroupCollapsed(groupId, collapsed) {
    const section = Array.from(quickSendListEl.querySelectorAll('.quick-send-group'))
        .find(element => (element.dataset.quickGroupId || '') === (groupId || ''));
    const body = section?.querySelector('.quick-send-group-items');
    const toggle = section?.querySelector('.quick-send-group-toggle');
    if (groupId) {
        const group = quickSendGroups.find(entry => entry.id === groupId);
        if (!group || group.collapsed === collapsed) return;
        group.collapsed = collapsed;
        saveQuickSendList();
    } else {
        if (quickSendUngroupedCollapsed === collapsed) return;
        quickSendUngroupedCollapsed = collapsed;
        saveQuickSendList();
    }
    if (!section || !body) return renderQuickSendContainer(quickSendListEl);
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    toggle?.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    if (reduceMotion || typeof body.animate !== 'function') {
        section.classList.toggle('collapsed', collapsed);
        return;
    }
    if (!collapsed) section.classList.remove('collapsed');
    const height = body.scrollHeight;
    quickSendCollapseAnimations.get(body)?.cancel();
    const animation = body.animate([
        { height: collapsed ? `${height}px` : '0px', opacity: collapsed ? 1 : 0 },
        { height: collapsed ? '0px' : `${height}px`, opacity: collapsed ? 0 : 1 }
    ], {
        duration: collapsed ? 140 : 160,
        easing: collapsed ? 'ease-in' : 'ease-out'
    });
    quickSendCollapseAnimations.set(body, animation);
    animation.addEventListener('finish', () => {
        section.classList.toggle('collapsed', collapsed);
        quickSendCollapseAnimations.delete(body);
    }, { once: true });
}

function closeQuickSendGroupDialog() {
    quickSendGroupDialog.classList.add('hidden');
    editingQuickSendGroupId = '';
    quickSendGroupNameInput.value = '';
    const trigger = quickSendGroupDialogTrigger;
    quickSendGroupDialogTrigger = null;
    if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
}

function openQuickSendGroupDialog(groupId = '', trigger = document.activeElement) {
    const group = quickSendGroups.find(entry => entry.id === groupId) || null;
    editingQuickSendGroupId = group?.id || '';
    quickSendGroupDialogTrigger = trigger;
    quickSendGroupDialogTitle.textContent = group
        ? trFallback('main.renameQuickSendGroup', 'Rename group')
        : trFallback('main.addQuickSendGroup', 'Add group');
    quickSendGroupDialogSaveLabel.textContent = group
        ? trFallback('main.saveGroupChanges', 'Save Changes')
        : trFallback('main.createQuickSendGroup', 'Create Group');
    quickSendGroupDialogSaveBtn.querySelector('svg[data-material-icon]')?.replaceWith(createMaterialIcon(group ? 'edit' : 'add'));
    quickSendGroupNameInput.value = group?.name || '';
    quickSendGroupDialogSaveBtn.disabled = !quickSendGroupNameInput.value.trim();
    quickSendGroupDialog.classList.remove('hidden');
    requestAnimationFrame(() => quickSendGroupNameInput.focus());
}

function saveQuickSendGroupDialog() {
    const name = quickSendGroupNameInput.value.trim().slice(0, 60);
    if (!name) return;
    const group = quickSendGroups.find(entry => entry.id === editingQuickSendGroupId);
    if (group) group.name = name;
    else createNamedQuickSendGroup(name);
    closeQuickSendGroupDialog();
    saveQuickSendList();
    renderQuickSendLists();
}

function closeQuickSendGroupDeleteDialog({ restoreFocus = true } = {}) {
    deletingQuickSendGroupId = '';
    quickSendGroupDeleteDialog.classList.add('hidden');
    const trigger = quickSendGroupDeleteTrigger;
    quickSendGroupDeleteTrigger = null;
    if (restoreFocus && trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
}

function openQuickSendGroupDeleteDialog(groupId, trigger = document.activeElement) {
    const group = quickSendGroups.find(entry => entry.id === groupId);
    if (!group) return;
    deletingQuickSendGroupId = groupId;
    quickSendGroupDeleteTrigger = trigger;
    const count = quickSendList.filter(item => item.groupId === groupId).length;
    quickSendGroupDeleteMessage.textContent = trFallback(
        'main.quickSendDeleteGroupMessage',
        'Delete "{name}" and its {count} commands? This cannot be undone.',
        { name: group.name, count }
    );
    quickSendGroupDeleteDialog.classList.remove('hidden');
    requestAnimationFrame(() => quickSendGroupDeleteCancelBtn.focus());
}

function createQuickSendGroupSection(group, itemElements) {
    const groupId = group?.id || '';
    const collapsed = group ? group.collapsed : quickSendUngroupedCollapsed;
    const section = document.createElement('section');
    section.className = `quick-send-group${collapsed ? ' collapsed' : ''}${group ? '' : ' ungrouped'}`;
    section.dataset.quickGroupId = groupId;
    const header = document.createElement('div');
    header.className = 'quick-send-group-header';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'quick-send-group-toggle';
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.appendChild(createMaterialIcon('arrow_drop_down'));
    const name = document.createElement('span');
    name.className = 'quick-send-group-name';
    name.textContent = group?.name || trFallback('main.quickSendUngrouped', 'Ungrouped');
    const count = document.createElement('span');
    count.className = 'quick-send-group-count';
    count.textContent = String(itemElements.length);
    toggle.append(name, count);
    toggle.addEventListener('click', event => {
        event.stopPropagation();
        const currentCollapsed = group
            ? group.collapsed
            : section.classList.contains('collapsed');
        setQuickSendGroupCollapsed(groupId, !currentCollapsed);
    });
    header.appendChild(toggle);
    if (group) {
        const dragHandle = document.createElement('span');
        dragHandle.className = 'quick-send-group-handle';
        dragHandle.draggable = true;
        dragHandle.title = trFallback('main.dragToReorder', 'Drag to reorder');
        dragHandle.appendChild(createMaterialIcon('drag_indicator'));
        dragHandle.addEventListener('dragstart', event => {
            quickSendGroupDragState = { groupId: group.id, insertionIndex: quickSendGroups.indexOf(group) };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', group.id);
            requestAnimationFrame(() => section.classList.add('group-dragging'));
        });
        dragHandle.addEventListener('dragend', () => {
            quickSendGroupDragState = null;
            quickSendListEl.classList.remove('quick-send-group-drag-active');
            quickSendListEl.querySelectorAll('.quick-send-group-drop-before, .quick-send-group-drop-after')
                .forEach(element => element.classList.remove('quick-send-group-drop-before', 'quick-send-group-drop-after'));
            section.classList.remove('group-dragging');
        });
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'quick-send-group-action';
        edit.title = trFallback('main.renameQuickSendGroup', 'Rename group');
        edit.appendChild(createMaterialIcon('edit'));
        edit.addEventListener('click', event => openQuickSendGroupDialog(group.id, event.currentTarget));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quick-send-group-action delete';
        remove.title = trFallback('main.deleteQuickSendGroup', 'Delete group');
        remove.appendChild(createMaterialIcon('delete'));
        remove.addEventListener('click', event => openQuickSendGroupDeleteDialog(group.id, event.currentTarget));
        header.append(dragHandle, edit, remove);
    }
    const body = document.createElement('div');
    body.className = 'quick-send-group-items';
    itemElements.forEach(element => body.appendChild(element));
    section.append(header, body);
    return section;
}

function updateQuickSendGroupDropTarget(pointerY) {
    if (!quickSendGroupDragState) return;
    const sections = Array.from(quickSendListEl.querySelectorAll('.quick-send-group:not(.ungrouped)'))
        .filter(section => section.dataset.quickGroupId !== quickSendGroupDragState.groupId);
    const insertionIndex = getVerticalInsertionIndex(
        sections.map(section => section.getBoundingClientRect()),
        pointerY
    );
    quickSendGroupDragState.insertionIndex = insertionIndex;
    quickSendListEl.classList.add('quick-send-group-drag-active');
    quickSendListEl.querySelectorAll('.quick-send-group-drop-before, .quick-send-group-drop-after')
        .forEach(element => element.classList.remove('quick-send-group-drop-before', 'quick-send-group-drop-after'));
    if (sections[insertionIndex]) sections[insertionIndex].classList.add('quick-send-group-drop-before');
    else sections.at(-1)?.classList.add('quick-send-group-drop-after');
}

quickSendListEl.addEventListener('dragover', event => {
    if (!quickSendGroupDragState) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    updateQuickSendGroupDropTarget(event.clientY);
});

quickSendListEl.addEventListener('drop', event => {
    if (!quickSendGroupDragState) return;
    event.preventDefault();
    const { groupId, insertionIndex } = quickSendGroupDragState;
    quickSendGroupDragState = null;
    quickSendGroups = moveQuickSendGroup(quickSendGroups, groupId, insertionIndex);
    saveQuickSendList();
    renderQuickSendLists();
});

function renderQuickSendContainer(container, compact = false) {
    if (!container) return;
    const context = getQuickSendReorderContext(compact);
    if (context?.dragState) cancelQuickSendDrag(context, { restoreOrder: false });
    const previousRects = new Map(getQuickSendReorderElements(context)
        .map(element => [element.dataset.quickId, element.getBoundingClientRect()]));
    container.innerHTML = '';
    const items = compact
        ? sidebarQuickSendOrder.map(id => quickSendList.find(item => item.id === id)).filter(Boolean)
        : quickSendList;
    items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `quick-send-item${compact ? ' quick-send-item-compact' : ''}`;
        div.setAttribute('role', 'listitem');
        div.setAttribute('aria-grabbed', 'false');
        div.dataset.index = String(index);
        div.dataset.quickId = item.id;
        div.addEventListener('pointerdown', event => beginQuickSendPointer(context, event, div));
        
        // If this item is being edited, highlight it
        if (item.id === editingQuickSendId) {
            div.classList.add('editing');
        }

        const btn = document.createElement('button');
        const label = document.createElement('span');
        label.className = 'quick-send-label';
        label.textContent = compact ? (item.sidebarShortcut?.text || item.label || item.content) : (item.label || item.content);
        const validation = validateSendContent(item.mode, item.content, sendEncoding, SEND_LIMITS.quick - (item.appendCrLf ? 2 : 0));
        btn.title = validation.ok ? `${validation.normalized} (${validation.byteCount + (item.appendCrLf ? 2 : 0)} B)` : validation.message;
        btn.className = compact ? 'quick-send-main-btn sidebar-tool-btn' : 'quick-send-main-btn';
            if (compact) {
            btn.style.backgroundColor = item.sidebarShortcut?.backgroundColor || 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-primary)';
                const textLength = [...label.textContent].length;
                btn.style.fontSize = `${Math.max(8, Math.min(13, 15 - textLength * 0.35))}px`;
                const previousItem = items[index - 1];
                if (previousItem && (previousItem.groupId || null) !== (item.groupId || null)) div.classList.add('quick-send-group-break');
            }
            const groupName = quickSendGroups.find(group => group.id === item.groupId)?.name
                || trFallback('main.quickSendUngrouped', 'Ungrouped');
            btn.title = compact ? `${groupName} / ${item.label || item.content}` : (item.label || item.content);
        btn.append(label);
        if (!compact && item.mode === 'hex') {
            btn.classList.add('has-mode-badge');
            const modeBadge = document.createElement('span');
            modeBadge.className = 'mode-badge hex quick-send-mode-badge';
            modeBadge.textContent = 'HEX';
            btn.append(modeBadge);
        }
        
        btn.addEventListener('click', async event => {
            if (performance.now() < context.suppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const result = await sendSerialRequest({ mode: item.mode, content: item.content, appendCrLf: item.appendCrLf, source: 'quick-send' }, SEND_LIMITS.quick);
            showQuickSendClickResult(btn, result?.ok === true);
            if (result?.code === 'SERIAL_NOT_OPEN') recordQuickSendDisconnectedClick(btn);
        });

        div.appendChild(btn);

        const editDeleteBtn = document.createElement('button');
        editDeleteBtn.type = 'button';
        editDeleteBtn.className = `quick-send-edit-delete-btn ${compact ? 'compact' : 'full'}`;
        editDeleteBtn.title = compact
            ? trFallback('main.removeQuickSendSidebar', 'Remove from sidebar')
            : trFallback('main.deleteQuickSend', 'Delete quick command');
        editDeleteBtn.tabIndex = -1;
        editDeleteBtn.setAttribute('aria-hidden', 'true');
        editDeleteBtn.setAttribute('aria-label', compact
            ? trFallback('main.removeQuickSendSidebarLabel', 'Remove sidebar shortcut: {label}', { label: item.label || item.content })
            : trFallback('main.deleteQuickSendLabel', 'Delete quick command: {label}', { label: item.label || item.content }));
        editDeleteBtn.appendChild(createMaterialIcon('close'));
        editDeleteBtn.addEventListener('pointerdown', event => event.stopPropagation());
        editDeleteBtn.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (compact) removeSidebarQuickSendShortcut(item, div);
            else deleteQuickSendItem(item, div);
        });
        div.appendChild(editDeleteBtn);

        if (!compact) {
            // Actions are overlaid on the left and revealed on hover/focus.
            const actionDiv = document.createElement('div');
            actionDiv.className = 'quick-send-actions';
            actionDiv.addEventListener('pointerdown', event => event.stopPropagation());
            actionDiv.addEventListener('focusin', () => {
                div.classList.add('actions-focused');
            });
            actionDiv.addEventListener('focusout', event => {
                if (!actionDiv.contains(event.relatedTarget)) div.classList.remove('actions-focused');
            });

            const editBtn = document.createElement('button');
            editBtn.className = 'quick-send-action-btn';
        editBtn.title = trFallback('main.edit', 'Edit');
            editBtn.appendChild(createMaterialIcon('edit'));
            editBtn.addEventListener('click', event => {
                event.stopPropagation();
                openQuickSendDialog(item.id);
                setActionStatus(trFallback('main.editingQuickSend', 'Editing quick command: {label}', { label: item.label || item.content }));
            });

            const delBtn = document.createElement('button');
            delBtn.className = 'quick-send-action-btn delete';
        delBtn.title = trFallback('main.delete', 'Delete');
            delBtn.appendChild(createMaterialIcon('delete'));
            delBtn.addEventListener('click', event => {
                event.stopPropagation();
                deleteQuickSendItem(item, div);
            });

            actionDiv.appendChild(delBtn);
            actionDiv.appendChild(editBtn);
            div.appendChild(actionDiv);
        }
        
        if (!compact || item.sidebarShortcut?.enabled === true) container.appendChild(div);
    });
    if (!compact) {
        const itemElements = Array.from(container.querySelectorAll('.quick-send-item'));
        const elementsByGroup = groupId => itemElements.filter(element => {
            const item = quickSendList.find(entry => entry.id === element.dataset.quickId);
            return (item?.groupId || '') === groupId;
        });
        container.innerHTML = '';
        quickSendGroups.forEach(group => container.appendChild(createQuickSendGroupSection(group, elementsByGroup(group.id))));
        container.appendChild(createQuickSendGroupSection(null, elementsByGroup('')));
    }
    requestAnimationFrame(() => {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true) return;
        const elements = compact ? Array.from(container.children) : Array.from(container.querySelectorAll('.quick-send-item'));
        elements.forEach(element => {
            const previous = previousRects.get(element.dataset.quickId);
            if (!previous) return;
            const current = element.getBoundingClientRect();
            const offset = previous.top - current.top;
            if (Math.abs(offset) < 1) return;
            element.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], {
                duration: compact ? 220 : 280,
                easing: 'cubic-bezier(.2,.8,.2,1)'
            });
        });
    });
    syncQuickSendEditMode(context);
}

function renderQuickSendLists() {
    normalizeSidebarQuickSendOrder();
    renderQuickSendContainer(quickSendListEl);
    renderQuickSendContainer(sidebarQuickSendListEl, true);
}

function saveQuickSendList() {
    if (isApplyingConfig) return;
    normalizeSidebarQuickSendOrder();
    ipcRenderer.send('save-config', {
        quickSendGroups: quickSendGroups.map(normalizeQuickSendGroup),
        quickSendUngroupedCollapsed,
        quickSendList: quickSendList.map(normalizeQuickSendItem),
        sidebarQuickSendOrder
    });
}

document.addEventListener('pointermove', handleQuickSendPointerMove, { passive: false });
document.addEventListener('pointerup', handleQuickSendPointerUp);
document.addEventListener('pointercancel', handleQuickSendPointerCancel);
document.addEventListener('pointerdown', event => {
    quickSendReorderContexts.forEach(context => {
        if (context.editMode && !context.container?.contains(event.target)) setQuickSendEditMode(context, false);
    });
}, true);
quickSendReorderContexts.forEach(context => {
    context.container?.addEventListener('contextmenu', event => {
        if (context.editMode || context.dragState) event.preventDefault();
    });
});
window.addEventListener('blur', () => {
    quickSendReorderContexts.forEach(context => {
        if (context.dragState) cancelQuickSendDrag(context, { restoreOrder: true });
    });
});

addQuickSendBtn.addEventListener('click', () => {
    if (updateQuickSendValidation().ok) {
        if (quickSendGroupSelect.value === '__new__') {
            const group = createNamedQuickSendGroup(quickSendNewGroupNameInput.value);
            if (!group) {
                quickSendNewGroupNameInput.focus();
                return;
            }
            renderQuickSendGroupOptions(group.id);
        }
        const item = getQuickEditorItem();
        const editingIndex = quickSendList.findIndex(entry => entry.id === editingQuickSendId);
        if (editingIndex > -1) {
            const previousGroupId = quickSendList[editingIndex].groupId || null;
            quickSendList[editingIndex] = item;
            if (previousGroupId !== item.groupId) {
                const targetCount = quickSendList.filter(entry => entry.id !== item.id && entry.groupId === item.groupId).length;
                quickSendList = moveQuickSendItem(quickSendList, item.id, item.groupId, targetCount);
            }
        } else {
            quickSendList.push(item);
        }
        saveQuickSendList();
        closeQuickSendDialog();
    }
});
quickSendContentInput.addEventListener('input', updateQuickSendValidation);
quickSendGroupSelect.addEventListener('change', () => {
    const creating = quickSendGroupSelect.value === '__new__';
    quickSendNewGroupNameInput.classList.toggle('hidden', !creating);
    if (creating) requestAnimationFrame(() => quickSendNewGroupNameInput.focus());
    updateQuickSendValidation();
});
quickSendNewGroupNameInput.addEventListener('input', updateQuickSendValidation);
quickSendModeInputs.forEach(input => input.addEventListener('change', updateQuickSendValidation));
quickSendAppendCrlfInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerEnableInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerTextInput.addEventListener('input', updateQuickSendValidation);
quickSendTriggerRegexInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerCaseInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerWordInput.addEventListener('change', updateQuickSendValidation);
quickSendSidebarEnableInput.addEventListener('change', () => {
    updateQuickSidebarEditorState();
    updateQuickSendValidation();
});
quickSendSidebarTextInput.addEventListener('input', updateQuickSendValidation);
quickSendSidebarColorInput.addEventListener('input', updateQuickSendValidation);
openQuickSendDialogBtn.addEventListener('click', () => openQuickSendDialog());
addQuickSendGroupBtn.addEventListener('click', () => {
    openQuickSendGroupDialog('', addQuickSendGroupBtn);
});
quickSendGroupNameInput.addEventListener('input', () => {
    quickSendGroupDialogSaveBtn.disabled = !quickSendGroupNameInput.value.trim();
});
quickSendGroupNameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !quickSendGroupDialogSaveBtn.disabled) saveQuickSendGroupDialog();
});
quickSendGroupDialogSaveBtn.addEventListener('click', saveQuickSendGroupDialog);
quickSendGroupDialogCloseBtn.addEventListener('click', closeQuickSendGroupDialog);
quickSendGroupDialogCancelBtn.addEventListener('click', closeQuickSendGroupDialog);
quickSendGroupDeleteCancelBtn.addEventListener('click', closeQuickSendGroupDeleteDialog);
quickSendGroupDeleteConfirmBtn.addEventListener('click', () => {
    const group = quickSendGroups.find(entry => entry.id === deletingQuickSendGroupId);
    if (!group) return closeQuickSendGroupDeleteDialog();
    const result = deleteQuickSendGroup(quickSendGroups, quickSendList, sidebarQuickSendOrder, group.id);
    quickSendGroups = result.quickSendGroups;
    quickSendList = result.quickSendList;
    sidebarQuickSendOrder = result.sidebarQuickSendOrder;
    closeQuickSendGroupDeleteDialog({ restoreFocus: false });
    saveQuickSendList();
    renderQuickSendLists();
    setActionStatus(trFallback('main.quickSendGroupDeleted', 'Deleted group: {name}', { name: group.name }));
    requestAnimationFrame(() => quickSendListEl.querySelector('.quick-send-group-toggle')?.focus());
});
quickSendDialogCloseBtn.addEventListener('click', closeQuickSendDialog);
quickSendDialogCancelBtn.addEventListener('click', closeQuickSendDialog);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !quickSendGroupDialog.classList.contains('hidden')) {
        closeQuickSendGroupDialog();
    } else if (event.key === 'Escape' && !quickSendGroupDeleteDialog.classList.contains('hidden')) {
        closeQuickSendGroupDeleteDialog();
    } else if (event.key === 'Escape' && !quickSendDialog.classList.contains('hidden')) {
        closeQuickSendDialog();
    } else if (event.key === 'Escape' && quickSendReorderContexts.some(context => context.editMode)) {
        quickSendReorderContexts.forEach(context => setQuickSendEditMode(context, false));
    }
});

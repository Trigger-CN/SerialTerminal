const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');
const iconv = require('iconv-lite');
const { t, getLanguage } = require('./i18n');
const { createWorkspaceManager } = require('./workspace-manager');
const { parseHexInput, buildSerialWriteBuffer } = require('./serial-codec');
const { HexStreamFormatter } = require('./hex-formatter');

const SEND_LIMITS = Object.freeze({ main: 1024 * 1024, quick: 1024 * 1024, auto: 64 * 1024, paste: 1024 * 1024, terminal: 1024 * 1024 });
const SUPPORTED_ENCODINGS = new Set(['utf8', 'ascii', 'gbk']);

let currentConfig = null;
let currentLanguage = 'en';
let isApplyingConfig = false;
let receiveDisplayMode = 'text';
let receiveEncoding = 'utf8';
let sendMode = 'text';
let sendEncoding = 'utf8';
let sendAppendCrLf = false;
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
let timestampColor = '#00ff00';
let lineNoColor = '#ffff00';
let highlightRules = [];
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
    const normalized = cloneWorkspaceLayout(DEFAULT_WORKSPACE_LAYOUT);
    const source = layout && typeof layout === 'object' ? layout : {};
    normalized.splitEnabled = source.splitEnabled === true;
    normalized.orientation = source.orientation === 'vertical' ? 'vertical' : 'horizontal';
    normalized.activePaneId = source.activePaneId === 'pane-2' ? 'pane-2' : 'pane-1';
    const sourceSizes = source.paneSizes && typeof source.paneSizes === 'object' ? source.paneSizes : {};
    const pane1Size = Number(sourceSizes['pane-1']);
    const pane2Size = Number(sourceSizes['pane-2']);
    if (Number.isFinite(pane1Size) && pane1Size > 0 && pane1Size < 1) {
        normalized.paneSizes['pane-1'] = pane1Size;
    }
    if (Number.isFinite(pane2Size) && pane2Size > 0 && pane2Size < 1) {
        normalized.paneSizes['pane-2'] = pane2Size;
    }
    const totalSize = normalized.paneSizes['pane-1'] + normalized.paneSizes['pane-2'];
    if (totalSize > 0) {
        normalized.paneSizes['pane-1'] /= totalSize;
        normalized.paneSizes['pane-2'] /= totalSize;
    }

    if (Array.isArray(source.panes)) {
        source.panes.forEach(pane => {
            const target = normalized.panes.find(item => item.id === pane.id);
            if (!target) return;
            target.activeTabId = typeof pane.activeTabId === 'string' ? pane.activeTabId : target.activeTabId;
            target.tabIds = Array.isArray(pane.tabIds) ? pane.tabIds.filter(id => typeof id === 'string') : target.tabIds;
        });
    }

    if (!normalized.panes[0].tabIds.includes('tab-main')) {
        normalized.panes[0].tabIds.unshift('tab-main');
    }

    return normalized;
}

function hexToAnsi(hex) {
    if (!hex) return '';
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `\x1b[38;2;${r};${g};${b}m`;
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
const sendModeSelect = document.getElementById('send-mode-select');
const sendEncodingSelect = document.getElementById('send-encoding-select');
const sendAppendCrlfCb = document.getElementById('send-append-crlf');
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

function applyHighlighting(text, filterRegex = null) {
    if (!text) return text;
    
    let matches = [];

    // Apply global highlight rules
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
            // Filter match: Dark gray background + bold text
            result += '\x1b[48;5;238m\x1b[1m' + text.substring(m.start, m.end) + '\x1b[0m';
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

function writeTextLines(lines) {
    if (!lines.length) return;
    const logLines = lines.map(line => ({ line, prefix: getLogPrefix() }));
    const mainOutput = lines.map(line => formatLineForTerminal(line)).join('');
    if (mainOutput) {
        serialTerm.write(mainOutput);
        writeMainTabLog(logLines.map(({ line, prefix }) => formatLineForLog(line, prefix)).join(''));
    }
    filterTabs.forEach(tab => {
        if (tab.dataMode !== 'text') return;
        const output = lines.map(line => formatLineForTerminal(line, tab.filterRegex)).join('');
        if (output) {
            tab.term.write(output);
            writeFilterTabLog(tab, logLines.map(({ line, prefix }) => formatLineForLog(line, prefix, tab.filterRegex)).join(''));
        }
    });
}

function writeHexLines(lines) {
    if (!lines.length) return;
    const formattedLines = lines.map(line => ({
        text: line.output.replace(/\r?\n$/, ''),
        prefix: getPrefix(),
        logPrefix: getLogPrefix()
    }));
    const mainOutput = formattedLines.map(({ text, prefix }) => `${prefix}${text}\r\n`).join('');
    serialTerm.write(mainOutput);
    writeMainTabLog(formattedLines.map(({ text, logPrefix }) => `${logPrefix}${text}\r\n`).join(''));
    filterTabs.forEach(tab => {
        if (tab.dataMode !== 'hex') return;
        const matched = formattedLines.filter(({ text }) => !tab.filterRegex || tab.filterRegex.test(text));
        const output = matched.map(({ text, prefix }) => `${prefix}${applyHighlighting(text, tab.filterRegex)}\r\n`).join('');
        if (output) {
            tab.term.write(output);
            writeFilterTabLog(tab, matched.map(({ text, logPrefix }) => `${logPrefix}${applyHighlighting(text, tab.filterRegex)}\r\n`).join(''));
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

function formatLineForTerminal(lineObj, filterRegex = null) {
    if (filterRegex && !filterRegex.test(lineObj.text)) {
        return '';
    }
    
    let output = lineObj.prefix + applyHighlighting(lineObj.text, filterRegex);
    if (lineObj.delimiter) {
        output += '\r\n'; // Normalize to xterm newline
    }
    return output;
}

function formatLineForLog(lineObj, prefix = '', filterRegex = null) {
    if (filterRegex && !filterRegex.test(lineObj.text)) {
        return '';
    }
    let output = prefix + applyHighlighting(lineObj.text, filterRegex);
    if (lineObj.delimiter) {
        output += '\r\n';
    }
    return output;
}

function getTerminalPlainText(targetTerm) {
    if (!targetTerm?.buffer?.active) return '';
    const buffer = targetTerm.buffer.active;
    const lines = [];
    for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        if (!line) continue;
        lines.push(line.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/g, '');
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
        newCmdTab: tr('main.newCmdTab'),
        newPowerShellTab: tr('main.newPowerShellTab'),
        newBashTab: tr('main.newBashTab')
    };
}

function requestTerminalContextMenu(payload) {
    ipcRenderer.send('show-terminal-context-menu', {
        ...payload,
        labels: getContextMenuLabels()
    });
}

function getTerminalBufferLineTextByEvent(term, element, event) {
    if (!term?.buffer?.active || !element) return '';

    const rect = element.getBoundingClientRect();
    const relativeY = event.clientY - rect.top;
    const rowHeight = rect.height / Math.max(1, term.rows || 1);
    const viewportRow = Math.max(0, Math.min((term.rows || 1) - 1, Math.floor(relativeY / Math.max(1, rowHeight))));
    const bufferBaseY = term.buffer.active.viewportY || 0;
    const bufferLineIndex = bufferBaseY + viewportRow;
    const line = term.buffer.active.getLine(bufferLineIndex);
    return line ? line.translateToString(true) : '';
}

function bindTerminalContextMenu({ terminalType, term, element, getTabState }) {
    if (!element) return;
    element.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const tabState = typeof getTabState === 'function' ? getTabState() : null;
        if (tabState && terminalType === 'filter') {
            tabState.contextLineText = getTerminalBufferLineTextByEvent(term, element, event);
        }
        requestTerminalContextMenu({
            terminalType,
            paneId: resolvePaneId(tabState?.paneId, tabState?.id, 'tab-main'),
            tabId: tabState?.id || '',
            hasSelection: term.hasSelection(),
            selectedText: term.hasSelection() ? term.getSelection() : '',
            isConnected,
            splitEnabled: isSplitEnabled(),
            filterText: tabState?.filterText || '',
            canLocateInMain: Boolean(tabState?.contextLineText),
            caseSensitive: Boolean(tabState?.caseSensitive),
            useRegex: Boolean(tabState?.useRegex),
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

function extractDisplayedLineNumber(text) {
    const match = String(text || '').match(/\[(\d{4,})\]/);
    return match ? Number(match[1]) : null;
}

function locateInMainTerminalByLineNumber(lineNo) {
    if (!lineNo) return false;
    const searchText = `[${String(lineNo).padStart(4, '0')}]`;
    if (typeof switchMainTab === 'function') {
        switchPaneTab(getPaneIdForTabId('tab-main'), 'tab-main');
    }
    if (typeof showSidebarTab === 'function') {
        showSidebarTab('tab-search');
    }
    searchInput.value = searchText;
    searchRegex.checked = false;
    searchCase.checked = true;
    searchWord.checked = false;
    resetSearchState();
    selectFirstSearchResult({ force: true });
    return true;
}

function setSearchFromText(text) {
    if (!text) return;
    if (typeof showSidebarTab === 'function') {
        showSidebarTab('tab-search');
    }
    searchInput.value = text;
    resetSearchState();
    selectFirstSearchResult({ force: true });
}

function focusSearchWithActiveSelection() {
    setSidebarCollapsed(false);
    const target = getActiveSearchTarget();
    const selectedText = target?.term?.hasSelection?.() ? target.term.getSelection() : '';
    if (selectedText) {
        setSearchFromText(selectedText);
        return;
    }
    showSidebarTab('tab-search');
    searchInput?.focus();
    searchInput?.select();
}

function clearTerminalByTabId(tabId) {
    if (!tabId || tabId === 'tab-main') {
        if (receiveDisplayMode === 'hex') hexFormatter.reset({ resetOffset: false });
        else resetTextReceive();
        serialTerm.clear();
        serialLineCounter = 1;
        logLineCounter = 1;
        return;
    }
    const filterTab = filterTabs.find(t => t.id === tabId);
    if (filterTab) {
        filterTab.term.clear();
        filterTab.contextLineText = '';
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
    shellTab.term.clear();
    shellTab.btn?.classList.remove('exited');
    shellTab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
    ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: shellTab.term.cols, rows: shellTab.term.rows, shellType: shellTab.shellType || 'auto' })
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
    const filterTab = isFilter ? filterTabs.find(tab => tab.id === tabId) : null;
    const shellTab = isShell ? getShellTabState(tabId) : null;
    const targetTerm = isFilter ? filterTab?.term : (isShell ? shellTab?.term : serialTerm);
    if (!targetTerm && action !== 'paste-send') return;

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
                    ipcRenderer.send('shell-tab-input', { tabId: shellTab.id, data: text });
                } else if (sendMode === 'hex') {
                    putTextInMainInput(text, 'hex');
                } else if (isConnected) {
                    await sendSerialRequest({ mode: sendMode, content: text, encoding: sendEncoding, source: 'paste' }, SEND_LIMITS.paste);
                }
            }
            break;
        }
        case 'send-selection': {
            const text = targetTerm?.getSelection();
            if (text && isShell && shellTab) {
                ipcRenderer.send('shell-tab-input', { tabId: shellTab.id, data: text });
            } else if (text && isConnected) {
                await sendSerialRequest({ mode: sendMode, content: text, encoding: sendEncoding, source: 'selection' }, SEND_LIMITS.paste);
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
            if (!tabId || tabId === 'tab-main') break;
            const sourcePaneId = resolvePaneId(paneId, tabId);
            workspaceLayout.orientation = 'horizontal';
            moveTabToPane(tabId, getOtherPaneId(sourcePaneId));
            setActionStatus('已将标签页移入左右分屏');
            break;
        }
        case 'split-vertical': {
            if (!tabId || tabId === 'tab-main') break;
            const sourcePaneId = resolvePaneId(paneId, tabId);
            workspaceLayout.orientation = 'vertical';
            moveTabToPane(tabId, getOtherPaneId(sourcePaneId));
            setActionStatus('已将标签页移入上下分屏');
            break;
        }
        case 'move-to-other-pane': {
            if (!tabId || tabId === 'tab-main') break;
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
            const lineNo = extractDisplayedLineNumber(filterTab.contextLineText || '');
            locateInMainTerminalByLineNumber(lineNo);
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
            createShellTab({ shellType: getDefaultShellType() }, resolvePaneId(paneId, tabId));
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
    scrollback: 100000 // Increase scrollback limit
});
const serialFitAddon = new FitAddon();
const serialSearchAddon = new SearchAddon();
serialTerm.loadAddon(serialFitAddon);
serialTerm.loadAddon(serialSearchAddon);
serialTerm.open(document.getElementById('serial-container'));
const mainTabButton = document.querySelector('.main-tab[data-target="tab-main"]');
if (mainTabButton) {
    mainTabButton.addEventListener('click', () => {
        switchPaneTab('pane-1', 'tab-main');
    });
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
        tab.btn.innerHTML = `${tr('main.filter')} ${displayIndex} <span class="mode-badge ${tab.dataMode}">${tab.dataMode === 'hex' ? 'HEX' : 'TXT'}</span> `;
        tab.btn.appendChild(closeBtn);
    });
    shellTabs.forEach((tab, index) => {
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        tab.title = tr('main.shellTitle', { index: index + 1 });
        tab.btn.innerHTML = `${tab.title} `;
        tab.btn.appendChild(closeBtn);
    });
}

function getMainTabTitle() {
    return 'Main_Terminal';
}

function getFilterTabLogTitle(tabState) {
    if (!tabState) return 'Filter';
    const index = filterTabs.indexOf(tabState);
    return index >= 0 ? `Filter_${index + 1}` : 'Filter';
}

function getShellTabLogTitle(tabState) {
    if (!tabState) return 'Shell';
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

function getDefaultShellType() {
    const profiles = Array.isArray(currentConfig?.shellProfiles) ? currentConfig.shellProfiles : [];
    if (!profiles.length) return 'auto';
    const defaultName = currentConfig?.defaultShellProfile || '';
    if (defaultName) {
        const found = profiles.find(p => p.name === defaultName);
        if (found) return found.shellType || found.name || 'auto';
    }
    return profiles[0].shellType || profiles[0].name || 'auto';
}

function persistShellTabs() {
    ipcRenderer.send('save-config', {
        shellTabs: shellTabs.map(tab => ({
            id: tab.id,
            title: tab.title || '',
            paneId: tab.paneId || getTabPaneId(tab.id),
            shellType: tab.shellType || 'auto'
        }))
    });
}

function createShellTab(initialState = {}, targetPaneId = null) {
    const tabId = typeof initialState.id === 'string' && initialState.id ? initialState.id : `tab-shell-${getNextShellTabId()}`;
    syncNextShellTabId(tabId);
    const resolvedPaneId = targetPaneId || initialState.paneId || getActivePane()?.id || 'pane-1';
    const shellType = typeof initialState.shellType === 'string' ? initialState.shellType : 'auto';

    const tabList = getPaneTabsList(resolvedPaneId);
    const tabBtn = document.createElement('div');
    tabBtn.className = 'main-tab';
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    tabBtn.innerHTML = `${tr('main.shell')} <span class="main-tab-close" title="${tr('main.closeTab')}">✕</span>`;
    tabBtn.onclick = (e) => {
        if (e.target.classList.contains('main-tab-close')) return;
        switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
    };
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeShellTab(tabId);
    };
    tabList.appendChild(tabBtn);

    const tabContent = getPaneTabsContent(resolvedPaneId);
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    tabPane.dataset.paneId = resolvedPaneId;

    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);

    const term = new Terminal({
        cursorBlink: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 100000) : 100000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(terminalWrapper);

    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontFamily: `${currentConfig.fontFamily}, ${currentConfig.fontFamilyZh}, "Courier New", monospace`,
            theme: {
                background: currentConfig.background,
                foreground: currentConfig.foreground,
                cursor: currentConfig.foreground
            }
        };
    }

    const tabState = {
        id: tabId,
        paneId: resolvedPaneId,
        title: initialState.title || '',
        shellType,
        term,
        fitAddon,
        searchAddon,
        element: tabPane,
        btn: tabBtn,
        sessionReady: false,
        sessionCreateTimer: null,
        closed: false
    };

    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term, 'shell', () => tabId));
    term.onData((data) => {
        ipcRenderer.send('shell-tab-input', { tabId, data });
    });
    bindTerminalContextMenu({
        terminalType: 'shell',
        term,
        element: terminalWrapper,
        getTabState: () => tabState
    });
    bindTerminalWheel(term, terminalWrapper);

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
        ipcRenderer.invoke('create-shell-tab-session', { tabId, cols: term.cols, rows: term.rows, shellType })
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
        tab.term.clear();
        tab.term.writeln(`\r\n[${tr('main.shellStarting')}]\r\n`);
        ipcRenderer.invoke('create-shell-tab-session', { tabId: tab.id, cols: tab.term.cols, rows: tab.term.rows, shellType: tab.shellType || 'auto' })
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
    const tabBtn = document.createElement('div');
    tabBtn.className = 'main-tab';
    tabBtn.dataset.target = tabId;
    tabBtn.dataset.paneId = resolvedPaneId;
    
    // The initial title will be updated by updateTabTitles() right after
    tabBtn.innerHTML = `${tr('main.filter')} <span class="main-tab-close" title="${tr('main.closeTab')}">✕</span>`;
    
    tabBtn.onclick = (e) => {
        if (e.target.classList.contains('main-tab-close')) return;
        switchPaneTab(tabBtn.dataset.paneId || getPaneIdForTabId(tabId), tabId);
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
    tabPane.dataset.paneId = resolvedPaneId;
    
    const filterHeader = document.createElement('div');
    filterHeader.className = "filter-header";
    filterHeader.innerHTML = `
        <div class="filter-input-wrapper">
            <input type="text" class="filter-input" placeholder="${tr('main.filterText')}" style="width: 100%; padding-right: 24px;">
            <div class="filter-dropdown-btn">▼</div>
            <div class="filter-history-dropdown"></div>
        </div>
        <div class="filter-toggles" style="display: flex; gap: 4px; margin-right: 8px;">
            <button class="filter-toggle-btn filter-case-btn" title="${tr('main.matchCase')}">Aa</button>
            <button class="filter-toggle-btn filter-regex-btn" title="${tr('main.useRegex')}">.*</button>
        </div>
        <span class="filter-mode-status" role="status"></span>
    `;
    
    const terminalWrapper = document.createElement('div');
    terminalWrapper.className = 'terminal-wrapper';
    terminalWrapper.id = `terminal-${tabId}`;
    
    tabPane.appendChild(filterHeader);
    tabPane.appendChild(terminalWrapper);
    tabContent.appendChild(tabPane);
    
    // 3. Initialize Terminal
    const term = new Terminal({ 
        cursorBlink: true,
        scrollback: currentConfig ? (currentConfig.scrollbackLimit || 100000) : 100000
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.open(terminalWrapper);
    
    if (currentConfig) {
        term.options = {
            fontSize: currentConfig.fontSize,
            fontFamily: `${currentConfig.fontFamily}, ${currentConfig.fontFamilyZh}, "Courier New", monospace`,
            theme: {
                background: currentConfig.background,
                foreground: currentConfig.foreground,
                cursor: currentConfig.foreground
            }
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
        caseSensitive: false,
        useRegex: false,
        filterText: '',
        dataMode: initialState.dataMode === 'hex' ? 'hex' : (initialState.dataMode === 'text' ? 'text' : receiveDisplayMode),
        contextLineText: '',
        element: tabPane,
        btn: tabBtn
    };
    
    const input = filterHeader.querySelector('.filter-input');
    const dropdownBtn = filterHeader.querySelector('.filter-dropdown-btn');
    const caseBtn = filterHeader.querySelector('.filter-case-btn');
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
            filterText: tab.filterText || '',
            caseSensitive: tab.caseSensitive,
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

document.getElementById('pane-1-new-filter-tab-btn')?.addEventListener('click', () => createFilterTab({}, 'pane-1'));
document.getElementById('pane-2-new-filter-tab-btn')?.addEventListener('click', () => createFilterTab({}, 'pane-2'));
document.getElementById('pane-1-new-shell-tab-btn')?.addEventListener('click', () => createShellTab({ shellType: getDefaultShellType() }, 'pane-1'));
document.getElementById('pane-2-new-shell-tab-btn')?.addEventListener('click', () => createShellTab({ shellType: getDefaultShellType() }, 'pane-2'));

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
                }
            }
        }
        setActivePane(paneId, { persist: false });
    }, 0);
});

function createTerminalKeyHandler(targetTerm, terminalType = 'serial', getTabId = null) {
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
            navigator.clipboard.readText().then(text => {
                if (!text) return;
                if (terminalType === 'shell') {
                    ipcRenderer.send('shell-tab-input', { tabId: typeof getTabId === 'function' ? getTabId() : '', data: text });
                } else if (sendMode === 'hex') {
                    putTextInMainInput(text, 'hex');
                } else {
                    sendSerialRequest({ mode: 'text', content: text, encoding: sendEncoding, source: 'paste' }, SEND_LIMITS.paste);
                }
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
        mode: sendMode,
        encoding: sendEncoding,
        appendCrLf: request.source === 'terminal' ? false : sendAppendCrLf
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

function putTextInMainInput(text, mode = sendMode) {
    switchMainInputMode(mode, { syncGlobal: true, persist: true });
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

    if (persist) {
        saveMainInputSettings();
    }

}

function setSidebarCollapsed(collapsed, persist = true) {
    const isCollapsed = collapsed === true;
    sidebar?.classList.toggle('sidebar-collapsed', isCollapsed);
    if (sidebarExpandBtn) {
        sidebarExpandBtn.textContent = '›';
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
    item.innerHTML = `
        <span class="shell-session-item-name" title="${title}">${title}</span>
        <button class="shell-session-item-close" title="Close session">✕</button>
    `;
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
        const defaultName = result.defaultName || '';
        shellProfileBtns.innerHTML = '';
        if (!profiles || !profiles.length) {
            const empty = document.createElement('div');
            empty.className = 'shell-session-empty';
            empty.textContent = tr('main.noShellProfiles') || 'No shell profiles configured';
            shellProfileBtns.appendChild(empty);
            return;
        }
        profiles.forEach(profile => {
            const isDefault = profile.name === defaultName;
            const btn = document.createElement('button');
            btn.className = 'secondary shell-new-btn';
            btn.title = `${profile.name} (${profile.executable})${isDefault ? ' — ' + (tr('main.defaultProfile') || 'Default') : ''}`;
            btn.innerHTML = `<span>${escapeHtml(profile.name)}</span>${isDefault ? ' <span style="font-size:10px;opacity:0.7;">⬤</span>' : ''}`;
            btn.addEventListener('click', () => {
                const shellType = profile.shellType || profile.name;
                createShellTab({ shellType }, getActivePane()?.id || 'pane-1');
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

function bindSidebarToolbarEvents() {
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
    switchMainInputMode(entry.mode, { syncGlobal: true, persist: true });
    mainSendInput.value = entry.content;
    mainInputDrafts[entry.mode] = entry.content;
    updateMainInputHeight();
    const validation = validateSendContent(sendMode, entry.content, sendEncoding, SEND_LIMITS.main - (sendAppendCrLf ? 2 : 0));
    mainInputValidation.textContent = formatValidation(validation, sendMode, sendAppendCrLf);
    mainInputValidation.classList.toggle('valid', validation.ok);
    mainInputValidation.classList.toggle('invalid', !validation.ok && entry.content.length > 0);
    mainSendBtn.disabled = !validation.ok;
    mainAddQuickSendBtn.disabled = !validation.ok;
    mainSendInput.placeholder = sendMode === 'hex' ? 'AA 55 01 FF' : tr('main.sendInputPlaceholder');
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
    return { mode: sendMode, content: mainSendInput.value, encoding: sendEncoding, appendCrLf: sendAppendCrLf };
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

function switchMainInputMode(mode, { syncGlobal = true, persist = true } = {}) {
    const normalized = mode === 'hex' ? 'hex' : 'text';
    const oldMode = mainInputMode;
    if (oldMode !== normalized) mainInputDrafts[oldMode] = mainSendInput.value;
    mainInputMode = normalized;
    mainSendInput.value = mainInputDrafts[normalized];
    if (syncGlobal) switchSendMode(normalized, { syncInput: false, persist });
    updateMainInputState();
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
        content,
        autoTrigger: {
            enabled: false,
            text: '',
            useRegex: false,
            caseSensitive: false,
            wholeWord: false
        }
    });
    renderQuickSendList();
    saveQuickSendList();
    setActionStatus('已将当前输入加入快捷发送');
    focusMainInput();
}

function saveMainInputSettings() {
    ipcRenderer.send('save-config', {
        mainInputSettings: {
            visible: !mainInputPanel?.classList.contains('hidden'),
            sendOnEnter: mainSendOnEnterCb?.checked !== false,
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
    switchMainInputMode(sendMode, { syncGlobal: false, persist: false });
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
        receiveDisplayMode, receiveEncoding, sendMode, sendEncoding, appendCrLf: sendAppendCrLf, newlineMode
    };
}

function saveSerialModeConfig() {
    if (isApplyingConfig) return;
    const lastSerialOptions = getSerialOptionsFromUi();
    if (currentConfig) currentConfig.lastSerialOptions = lastSerialOptions;
    ipcRenderer.send('save-config', { lastSerialOptions });
}

function switchSendMode(nextMode, { syncInput = true, persist = true, refresh = true } = {}) {
    sendMode = nextMode === 'hex' ? 'hex' : 'text';
    if (sendModeSelect) sendModeSelect.value = sendMode;
    if (sendEncodingSelect) sendEncodingSelect.disabled = sendMode === 'hex';
    if (syncInput) {
        switchMainInputMode(sendMode, { syncGlobal: false, persist: false });
    }
    if (refresh) refreshSharedSendConsumers();
    if (persist && !isApplyingConfig) {
        saveSharedSendProfile();
    }
}

function switchSendEncoding(nextEncoding, { persist = true, refresh = true } = {}) {
    sendEncoding = SUPPORTED_ENCODINGS.has(nextEncoding) ? nextEncoding : 'utf8';
    if (sendEncodingSelect) sendEncodingSelect.value = sendEncoding;
    if (refresh) refreshSharedSendConsumers();
    if (persist && !isApplyingConfig) saveSharedSendProfile();
}

function switchSendAppendCrLf(appendCrLf, { persist = true, refresh = true } = {}) {
    sendAppendCrLf = appendCrLf === true;
    if (sendAppendCrlfCb) sendAppendCrlfCb.checked = sendAppendCrLf;
    if (refresh) refreshSharedSendConsumers();
    if (persist && !isApplyingConfig) saveSharedSendProfile();
}

function refreshSharedSendConsumers() {
    updateMainInputState();
    if (typeof updateAutoSendValidation === 'function') {
        updateAutoSendValidation();
        updateAutoSendState();
    }
    if (typeof updateQuickSendValidation === 'function') updateQuickSendValidation();
    if (typeof renderQuickSendList === 'function') renderQuickSendList();
}

function saveSharedSendProfile() {
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
sendModeSelect?.addEventListener('change', () => switchSendMode(sendModeSelect.value));
sendEncodingSelect?.addEventListener('change', () => switchSendEncoding(sendEncodingSelect.value));
sendAppendCrlfCb?.addEventListener('change', () => switchSendAppendCrLf(sendAppendCrlfCb.checked));
document.getElementById('newline-mode-select')?.addEventListener('change', event => {
    newlineMode = event.target.value;
    saveSerialModeConfig();
});

function applyConfig(config) {
    isApplyingConfig = true;
    try {
    currentConfig = config;
    setSidebarCollapsed(config.sidebarCollapsed === true, false);
    sidebarShellBtn?.classList.toggle('active', shellSidebar && !shellSidebar.classList.contains('hidden'));
    activeShortcuts = normalizeShortcutSettings(config.shortcuts);
    let sendProfileChanged = false;
    currentLanguage = getLanguage(config.language);
    highlightRules = config.highlightRules || [];
    const normalizedWorkspaceLayout = normalizeWorkspaceLayout(config.workspaceLayout);
    const normalizedWorkspaceLayoutKey = JSON.stringify(normalizedWorkspaceLayout);
    
    // Update local color settings
    timestampColor = config.timestampColor || '#00ff00';
    lineNoColor = config.lineNoColor || '#ffff00';
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
        fontFamily: `${config.fontFamily}, ${config.fontFamilyZh}, "Courier New", monospace`,
        scrollback: config.scrollbackLimit || 100000,
        theme: {
            background: config.background,
            foreground: config.foreground,
            cursor: config.foreground
        }
    };
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
    
    document.body.style.background = config.background;

    document.title = tr('appTitle');
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const translated = tr(el.dataset.i18n);
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
        const previousSendProfileKey = JSON.stringify([sendMode, sendEncoding, sendAppendCrLf]);
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
        switchSendMode(config.lastSerialOptions.sendMode, { syncInput: false, persist: false, refresh: false });
        switchSendAppendCrLf(config.lastSerialOptions.appendCrLf, { persist: false, refresh: false });
        sendProfileChanged = previousSendProfileKey !== JSON.stringify([sendMode, sendEncoding, sendAppendCrLf]);
        
        // Refresh ports to update selection based on config
        refreshPorts();
    }

    applyMainInputConfig(config);
    const hexSettingsKey = JSON.stringify(config.hexDisplaySettings || {});
    if (appliedHexSettingsKey && appliedHexSettingsKey !== hexSettingsKey) hexFormatter.flush();
    hexFormatter.configure(config.hexDisplaySettings || {});
    appliedHexSettingsKey = hexSettingsKey;
    const autoSendChanged = applyAutoSendConfig(config.autoSendSettings || {});
    quickSendList = Array.isArray(config.quickSendList) ? config.quickSendList.map(normalizeQuickSendItem) : [];
    renderQuickSendList();
    updateQuickSendValidation();
    if (sendProfileChanged || autoSendChanged) {
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
});
ipcRenderer.on('config-updated', (event, config) => applyConfig(config));

ipcRenderer.on('shell-tab-output', (event, payload = {}) => {
    const tab = getShellTabState(payload.tabId);
    if (tab && typeof payload.data === 'string') {
        tab.term.write(payload.data);
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
    if (sendMode === 'hex') {
        setActionStatus(trFallback('main.hexUseInput', 'Hex mode: use the bottom input'));
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
    processQuickSendAutoTriggers(bytes);
    if (receiveDisplayMode === 'hex') {
        hexFormatter.push(bytes);
    } else {
        if (!textDecoder) createTextDecoder();
        const text = textDecoder.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        if (text) writeTextLines(dataParser.parse(text));
    }
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

        ipcRenderer.send('save-config', {
            lastSerialOptions: {
                path,
                baudRate,
                dataBits,
                stopBits,
                parity,
                receiveDisplayMode,
                receiveEncoding,
                sendMode,
                sendEncoding,
                appendCrLf: sendAppendCrLf,
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
    clearSearchDecorations(target.addon);
    if (typeof target.term?.clearSelection === 'function') target.term.clearSelection();
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

function selectFirstSearchResult({ force = true } = {}) {
    clearTimeout(searchDebounceTimer);
    const state = refreshSearchCount({ force });
    clearSearchSelection();
    if (!searchInput.value || state.regexError || !state.total) {
        searchState.current = 0;
        updateSearchResultCount(0, state.total, state.regexError);
        return false;
    }
    return selectSearchMatch(1);
}

function scheduleSearchSelection() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => selectFirstSearchResult({ force: true }), 200);
}

function resetSearchState() {
    searchState.key = '';
    searchState.total = 0;
    searchState.current = 0;
    searchState.regexError = '';
    searchState.matches = [];
}

function selectSearchMatch(index) {
    const target = getActiveSearchTarget();
    if (!searchState.total || index < 1 || index > searchState.total) {
        clearSearchSelection(target);
        return false;
    }
    const match = searchState.matches[index - 1];
    if (!match) return false;
    if (typeof target.term.scrollToLine === 'function') {
        target.term.scrollToLine(match.line);
    }
    if (typeof target.term.select === 'function') {
        target.term.select(match.column, match.line, match.length);
    }
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
    if (!searchInput.value) {
        clearTimeout(searchDebounceTimer);
        clearSearchSelection();
        updateSearchResultCount(0, 0);
        return;
    }
    scheduleSearchSelection();
});

[searchRegex, searchCase, searchWord].forEach(control => {
    control.addEventListener('change', () => {
        resetSearchState();
        if (!searchInput.value) {
            updateSearchResultCount(0, 0);
            return;
        }
        selectFirstSearchResult({ force: true });
    });
});

window.addEventListener('main-tab-changed', () => {
    resetSearchState();
    updateSearchTargetLabel();
    if (!searchInput.value) {
        updateSearchResultCount(0, 0);
        return;
    }
    scheduleSearchSelection();
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
const openQuickSendDialogBtn = document.getElementById('open-quick-send-dialog-btn');
const quickSendDialog = document.getElementById('quick-send-dialog');
const quickSendDialogTitle = document.getElementById('quick-send-dialog-title');
const quickSendDialogCloseBtn = document.getElementById('quick-send-dialog-close');
const quickSendDialogCancelBtn = document.getElementById('quick-send-dialog-cancel');
const quickSendLabelInput = document.getElementById('quick-send-label');
const quickSendContentInput = document.getElementById('quick-send-content');
const quickSendTriggerEnableInput = document.getElementById('quick-send-trigger-enable');
const quickSendTriggerTextInput = document.getElementById('quick-send-trigger-text');
const quickSendTriggerRegexInput = document.getElementById('quick-send-trigger-regex');
const quickSendTriggerCaseInput = document.getElementById('quick-send-trigger-case');
const quickSendTriggerWordInput = document.getElementById('quick-send-trigger-word');
const addQuickSendBtn = document.getElementById('add-quick-send-btn');
const quickSendValidation = document.getElementById('quick-send-validation');

let quickSendList = [];
const quickSendTriggerInFlight = new Set();
const quickSendFlashTimers = new WeakMap();

function stopAutoSendRuntime() {
    autoSendGeneration++;
    if (autoSendTimer) clearTimeout(autoSendTimer);
    autoSendTimer = null;
    autoSendInFlight = false;
}

function getAutoSendRequest() {
    return {
        mode: sendMode, content: autoSendTextInput.value,
        encoding: sendEncoding, appendCrLf: sendAppendCrLf,
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
let editingIndex = -1;
let draggedQuickSendIndex = -1;

function createQuickSendId() {
    return `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeQuickSendItem(item = {}) {
    const trigger = item.autoTrigger && typeof item.autoTrigger === 'object' ? item.autoTrigger : {};
    return {
        id: typeof item.id === 'string' && item.id ? item.id : createQuickSendId(),
        label: typeof item.label === 'string' ? item.label : '',
        content: typeof item.content === 'string' ? item.content : '',
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
    return normalizeQuickSendItem({
        id: editingIndex >= 0 ? quickSendList[editingIndex]?.id : createQuickSendId(),
        label: quickSendLabelInput.value.trim(),
        content: quickSendContentInput.value,
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
    editingIndex = -1;
    quickSendLabelInput.value = '';
    quickSendContentInput.value = '';
    quickSendTriggerEnableInput.checked = false;
    quickSendTriggerTextInput.value = '';
    quickSendTriggerRegexInput.checked = false;
    quickSendTriggerCaseInput.checked = false;
    quickSendTriggerWordInput.checked = false;
    renderQuickSendList();
}

function openQuickSendDialog(index = -1) {
    editingIndex = index;
    const item = index >= 0 ? quickSendList[index] : null;
    quickSendLabelInput.value = item?.label || '';
    quickSendContentInput.value = item?.content || '';
    quickSendTriggerEnableInput.checked = item?.autoTrigger?.enabled === true;
    quickSendTriggerTextInput.value = item?.autoTrigger?.text || '';
    quickSendTriggerRegexInput.checked = item?.autoTrigger?.useRegex === true;
    quickSendTriggerCaseInput.checked = item?.autoTrigger?.caseSensitive === true;
    quickSendTriggerWordInput.checked = item?.autoTrigger?.wholeWord === true;
    const editing = Boolean(item);
    quickSendDialogTitle.textContent = editing
        ? trFallback('main.editQuickSend', 'Edit Quick Send')
        : trFallback('main.addQuickSend', 'Add Quick Send');
    addQuickSendBtn.textContent = editing
        ? trFallback('main.updateItem', 'Update Item')
        : tr('main.addToList');
    updateQuickSendValidation();
    renderQuickSendList();
    quickSendDialog.classList.remove('hidden');
    requestAnimationFrame(() => (editing ? quickSendContentInput : quickSendLabelInput).focus());
}

function updateQuickSendValidation() {
    const item = getQuickEditorItem();
    const result = validateSendContent(sendMode, item.content, sendEncoding, SEND_LIMITS.quick - (sendAppendCrLf ? 2 : 0));
    const triggerResult = !item.autoTrigger.enabled
        ? { ok: true, regex: null }
        : (!item.autoTrigger.text
            ? { ok: false, message: trFallback('main.quickTriggerTextRequired', 'Auto trigger needs match text') }
            : buildQuickTriggerRegex(item.autoTrigger));
    quickSendValidation.textContent = triggerResult.ok
        ? formatValidation(result, sendMode, sendAppendCrLf)
        : triggerResult.message;
    quickSendValidation.classList.toggle('valid', result.ok && triggerResult.ok);
    quickSendValidation.classList.toggle('invalid', (!result.ok && item.content.length > 0) || !triggerResult.ok);
    addQuickSendBtn.disabled = !result.ok || !triggerResult.ok;
    quickSendContentInput.placeholder = sendMode === 'hex' ? 'AA 55 01 FF' : tr('main.contentMultiLine');
    return { ...result, ok: result.ok && triggerResult.ok };
}

async function triggerQuickSendItem(item) {
    if (quickSendTriggerInFlight.has(item.id)) return;
    quickSendTriggerInFlight.add(item.id);
    try {
        flashQuickSendItem(item.id);
        const result = await sendSerialRequest({ content: item.content, source: 'quick-send-trigger' }, SEND_LIMITS.quick, { silent: true });
        const label = item.label || item.content;
        setActionStatus(result.ok
            ? trFallback('main.quickTriggerSent', 'Auto-trigger sent: {label}', { label })
            : trFallback('main.quickTriggerFailed', 'Auto-trigger failed: {error}', { error: result.message || result.code }));
    } finally {
        quickSendTriggerInFlight.delete(item.id);
    }
}

function flashQuickSendItem(itemId) {
    if (!itemId) return;
    const itemEl = Array.from(quickSendListEl.querySelectorAll('.quick-send-item'))
        .find(element => element.dataset.quickId === itemId);
    const button = itemEl?.querySelector('.quick-send-main-btn');
    if (!button) return;
    button.classList.remove('auto-trigger-flash');
    void button.offsetWidth;
    button.classList.add('auto-trigger-flash');
    const previousTimer = quickSendFlashTimers.get(button);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
        button.classList.remove('auto-trigger-flash');
        quickSendFlashTimers.delete(button);
    }, 1300);
    quickSendFlashTimers.set(button, timer);
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

function moveQuickSendItem(fromIndex, toIndex) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= quickSendList.length || toIndex >= quickSendList.length) {
        return;
    }

    const [movedItem] = quickSendList.splice(fromIndex, 1);
    quickSendList.splice(toIndex, 0, movedItem);

    if (editingIndex === fromIndex) {
        editingIndex = toIndex;
    } else if (editingIndex > fromIndex && editingIndex <= toIndex) {
        editingIndex--;
    } else if (editingIndex < fromIndex && editingIndex >= toIndex) {
        editingIndex++;
    }

    saveQuickSendList();
    renderQuickSendList();
}

function renderQuickSendList() {
    quickSendListEl.innerHTML = '';
    
    quickSendList.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'quick-send-item';
        div.draggable = true;
        div.dataset.index = String(index);
        div.dataset.quickId = item.id;
        
        // If this item is being edited, highlight it
        if (index === editingIndex) {
            div.classList.add('editing');
        }

        div.addEventListener('dragstart', (event) => {
            draggedQuickSendIndex = index;
            div.classList.add('dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
            }
        });

        div.addEventListener('dragend', () => {
            draggedQuickSendIndex = -1;
            quickSendListEl.querySelectorAll('.quick-send-item').forEach(itemEl => {
                itemEl.classList.remove('dragging', 'drag-over');
            });
        });

        div.addEventListener('dragover', (event) => {
            event.preventDefault();
            if (draggedQuickSendIndex === -1 || draggedQuickSendIndex === index) {
                return;
            }
            event.dataTransfer.dropEffect = 'move';
            div.classList.add('drag-over');
        });

        div.addEventListener('dragleave', () => {
            div.classList.remove('drag-over');
        });

        div.addEventListener('drop', (event) => {
            event.preventDefault();
            div.classList.remove('drag-over');
            moveQuickSendItem(draggedQuickSendIndex, index);
        });

        const btn = document.createElement('button');
        const label = document.createElement('span');
        label.textContent = item.label || item.content;
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        const validation = validateSendContent(sendMode, item.content, sendEncoding, SEND_LIMITS.quick - (sendAppendCrLf ? 2 : 0));
        btn.title = validation.ok ? `${validation.normalized} (${validation.byteCount + (sendAppendCrLf ? 2 : 0)} B)` : validation.message;
        btn.className = 'quick-send-main-btn';
        btn.append(label);
        
        btn.addEventListener('click', async () => {
            await sendSerialRequest({ content: item.content, source: 'quick-send' }, SEND_LIMITS.quick);
        });
        
        // Actions are overlaid on the left and revealed on hover/focus.
        const actionDiv = document.createElement('div');
        actionDiv.className = 'quick-send-actions';
        actionDiv.addEventListener('focusin', () => {
            div.classList.add('actions-focused');
        });
        actionDiv.addEventListener('focusout', (event) => {
            if (!actionDiv.contains(event.relatedTarget)) {
                div.classList.remove('actions-focused');
            }
        });

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.className = 'quick-send-action-btn';
        editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => {
            openQuickSendDialog(index);
            setActionStatus(`正在编辑快捷指令：${item.label || item.content}`);
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.className = 'quick-send-action-btn delete';
        delBtn.title = 'Remove';
        delBtn.addEventListener('click', () => {
            // If deleting the item currently being edited, cancel edit mode
            if (editingIndex === index) {
                closeQuickSendDialog();
            } else if (editingIndex > index) {
                // Adjust index if deleting an item above the edited one
                editingIndex--;
            }
            
            quickSendList.splice(index, 1);
            saveQuickSendList();
            renderQuickSendList();
            setActionStatus(`已删除快捷指令：${item.label || item.content}`);
        });

        actionDiv.appendChild(delBtn);
        actionDiv.appendChild(editBtn);
        
        div.appendChild(btn);
        div.appendChild(actionDiv);
        
        quickSendListEl.appendChild(div);
    });
}

function saveQuickSendList() {
    if (isApplyingConfig) return;
    ipcRenderer.send('save-config', {
        quickSendList: quickSendList.map(normalizeQuickSendItem)
    });
}

addQuickSendBtn.addEventListener('click', () => {
    const item = getQuickEditorItem();
    if (updateQuickSendValidation().ok) {
        if (editingIndex > -1) {
            quickSendList[editingIndex] = item;
        } else {
            quickSendList.push(item);
        }
        saveQuickSendList();
        closeQuickSendDialog();
    }
});
quickSendContentInput.addEventListener('input', updateQuickSendValidation);
quickSendTriggerEnableInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerTextInput.addEventListener('input', updateQuickSendValidation);
quickSendTriggerRegexInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerCaseInput.addEventListener('change', updateQuickSendValidation);
quickSendTriggerWordInput.addEventListener('change', updateQuickSendValidation);
openQuickSendDialogBtn.addEventListener('click', () => openQuickSendDialog());
quickSendDialogCloseBtn.addEventListener('click', closeQuickSendDialog);
quickSendDialogCancelBtn.addEventListener('click', closeQuickSendDialog);
quickSendDialog.addEventListener('click', event => {
    if (event.target === quickSendDialog) closeQuickSendDialog();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !quickSendDialog.classList.contains('hidden')) {
        closeQuickSendDialog();
    }
});

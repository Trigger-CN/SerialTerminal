const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { SearchAddon } = require('@xterm/addon-search');

let currentConfig = null;
// let currentMode = 'terminal'; // Removed temporarily

// Display Settings
let showTimestamp = false;
let showLineNumbers = false;
let serialLineCounter = 1;
let serialNewLine = true;
let lastCharWasCR = false;

// Color settings
let timestampColor = '#00ff00';
let lineNoColor = '#ffff00';
let highlightRules = [];

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
}

const dataParser = new SerialDataParser();

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

// Filter Tabs Management
let filterTabs = [];
let nextFilterTabId = 1;

function getNextTabId() {
    return nextFilterTabId++;
}

function updateTabTitles() {
    filterTabs.forEach((tab, index) => {
        const displayIndex = index + 1;
        const closeBtn = tab.btn.querySelector('.main-tab-close');
        tab.btn.innerHTML = `Filter ${displayIndex} `;
        tab.btn.appendChild(closeBtn);
    });
}

function createFilterTab() {
    const internalId = getNextTabId();
    const tabId = `tab-filter-${internalId}`;
    
    // 1. Create Tab Button
    const tabList = document.getElementById('main-tabs-list');
    const tabBtn = document.createElement('div');
    tabBtn.className = 'main-tab';
    tabBtn.dataset.target = tabId;
    
    // The initial title will be updated by updateTabTitles() right after
    tabBtn.innerHTML = `Filter <span class="main-tab-close" title="Close Tab">✕</span>`;
    
    tabBtn.onclick = (e) => {
        if (e.target.classList.contains('main-tab-close')) return;
        switchMainTab(tabId);
    };
    
    tabBtn.querySelector('.main-tab-close').onclick = () => {
        closeFilterTab(tabId);
    };
    
    tabList.appendChild(tabBtn);
    
    // 2. Create Tab Pane
    const tabContent = document.getElementById('main-tabs-content');
    const tabPane = document.createElement('div');
    tabPane.className = 'main-tab-pane';
    tabPane.id = tabId;
    
    const filterHeader = document.createElement('div');
    filterHeader.className = "filter-header";
    filterHeader.innerHTML = `
        <div class="filter-input-wrapper">
            <input type="text" class="filter-input" placeholder="Filter text..." style="width: 100%; padding-right: 24px;">
            <div class="filter-dropdown-btn">▼</div>
            <div class="filter-history-dropdown"></div>
        </div>
        <div class="filter-toggles" style="display: flex; gap: 4px; margin-right: 8px;">
            <button class="filter-toggle-btn filter-case-btn" title="Match Case">Aa</button>
            <button class="filter-toggle-btn filter-regex-btn" title="Use Regular Expression">.*</button>
        </div>
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
            fontFamily: currentConfig.fontFamily,
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
        term,
        fitAddon,
        searchAddon,
        filterRegex: null,
        caseSensitive: false,
        useRegex: false,
        element: tabPane,
        btn: tabBtn
    };
    
    const input = filterHeader.querySelector('.filter-input');
    const dropdownBtn = filterHeader.querySelector('.filter-dropdown-btn');
    const caseBtn = filterHeader.querySelector('.filter-case-btn');
    const regexBtn = filterHeader.querySelector('.filter-regex-btn');
    const dropdownMenu = filterHeader.querySelector('.filter-history-dropdown');
    
    // History dropdown logic
    function renderDropdown() {
        const history = currentConfig ? (currentConfig.filterHistory || []) : [];
        dropdownMenu.innerHTML = '';
        
        if (history.length === 0) {
            dropdownMenu.innerHTML = '<div class="filter-history-item" style="color: #666; cursor: default;">No history</div>';
            return;
        }
        
        history.forEach(item => {
            const div = document.createElement('div');
            div.className = 'filter-history-item';
            div.textContent = item;
            div.onclick = () => {
                input.value = item;
                updateRegex();
                dropdownMenu.style.display = 'none';
            };
            dropdownMenu.appendChild(div);
        });
    }

    dropdownBtn.onclick = (e) => {
        e.stopPropagation();
        const isShowing = dropdownMenu.style.display === 'block';
        
        // Hide all other dropdowns
        document.querySelectorAll('.filter-history-dropdown').forEach(d => d.style.display = 'none');
        
        if (!isShowing) {
            renderDropdown();
            dropdownMenu.style.display = 'block';
        }
    };
    
    const outsideClickListener = (e) => {
        if (!filterHeader.contains(e.target)) {
            dropdownMenu.style.display = 'none';
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
        if (!input.value) {
            tabState.filterRegex = null;
            input.style.borderColor = 'var(--border-color)';
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
    }
    
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
            dropdownMenu.style.display = 'none';
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
    term.attachCustomKeyEventHandler(createTerminalKeyHandler(term));
    
    filterTabs.push(tabState);
    updateTabTitles();
    switchMainTab(tabId);
    
    // Fit terminal after a short delay to ensure DOM is rendered
    setTimeout(async () => {
        fitAddon.fit();
        
        // Load history for the new tab
        try {
            const history = await ipcRenderer.invoke('get-history');
            if (history) {
                // Save current line counter to avoid jumping
                const savedLineCounter = serialLineCounter;
                serialLineCounter = 1;
                
                const tempParser = new SerialDataParser();
                const lines = tempParser.parse(history);
                let tabOutput = '';
                lines.forEach(lineObj => {
                    tabOutput += formatLineForTerminal(lineObj, tabState.filterRegex);
                });
                if (tabOutput) term.write(tabOutput);
                
                // Restore line counter
                serialLineCounter = savedLineCounter;
            }
        } catch (e) {
            console.error('Failed to load history:', e);
        }
    }, 50);
}

function closeFilterTab(tabId) {
    const index = filterTabs.findIndex(t => t.id === tabId);
    if (index > -1) {
        const tab = filterTabs[index];
        tab.term.dispose();
        if (tab.outsideClickListener) {
            document.removeEventListener('click', tab.outsideClickListener);
        }
        tab.element.remove();
        tab.btn.remove();
        filterTabs.splice(index, 1);
        
        updateTabTitles();
        
        // Switch to main tab if we closed the active one
        if (tab.element.classList.contains('active')) {
            switchMainTab('tab-main');
        }
    }
}

document.getElementById('new-filter-tab-btn').addEventListener('click', createFilterTab);

window.addEventListener('main-tab-changed', (e) => {
    const tabId = e.detail.tabId;
    setTimeout(() => {
        if (tabId === 'tab-main') {
            serialFitAddon.fit();
        } else {
            const tab = filterTabs.find(t => t.id === tabId);
            if (tab) tab.fitAddon.fit();
        }
    }, 0);
});

function createTerminalKeyHandler(targetTerm) {
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
            if (targetTerm.hasSelection()) {
                navigator.clipboard.readText().then(text => {
                    if (text) {
                        ipcRenderer.send('serial-input', text);
                    }
                });
                return false;
            }
            return true;
        }

        return true;
    };
}

// Smart Copy/Paste Handling
serialTerm.attachCustomKeyEventHandler(createTerminalKeyHandler(serialTerm));

function applyConfig(config) {
    currentConfig = config;
    highlightRules = config.highlightRules || [];
    
    // Update local color settings
    timestampColor = config.timestampColor || '#00ff00';
    lineNoColor = config.lineNoColor || '#ffff00';
    
    // Update Checkboxes
    showTimestamp = config.showTimestamp || false;
    showLineNumbers = config.showLineNumbers || false;
    if (showTimestampCb) showTimestampCb.checked = showTimestamp;
    if (showLinenoCb) showLinenoCb.checked = showLineNumbers;

    const options = {
        fontSize: config.fontSize,
        fontFamily: config.fontFamily,
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
    
    document.body.style.background = config.background;
    
    // fitAddon.fit();
    serialFitAddon.fit();

    // Restore Serial Settings
    if (config.lastSerialOptions) {
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
        
        const enc = document.getElementById('encoding-select');
        if (enc) enc.value = config.lastSerialOptions.encoding;
        
        const nl = document.getElementById('newline-mode-select');
        if (nl) nl.value = config.lastSerialOptions.newlineMode;
        
        // Refresh ports to update selection based on config
        refreshPorts();
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

// Terminal Logic
/*
ipcRenderer.on('terminal-output', (event, data) => term.write(data));
term.onData((data) => ipcRenderer.send('terminal-input', data));
ipcRenderer.send('spawn-terminal');
*/

// Serial Logic
serialTerm.onData((data) => ipcRenderer.send('serial-input', data));
ipcRenderer.on('serial-output', (event, data) => {
    const lines = dataParser.parse(data);
    
    if (lines.length > 0) {
        let mainOutput = '';
        lines.forEach(lineObj => {
            mainOutput += formatLineForTerminal(lineObj, null);
        });
        if (mainOutput) serialTerm.write(mainOutput);
        
        // Broadcast to filter tabs
        filterTabs.forEach(tab => {
            let tabOutput = '';
            lines.forEach(lineObj => {
                tabOutput += formatLineForTerminal(lineObj, tab.filterRegex);
            });
            if (tabOutput) tab.term.write(tabOutput);
        });
    }
});
ipcRenderer.on('serial-error', (event, err) => {
    const errMsg = '\r\n\x1b[31m[ERROR] ' + err + '\x1b[0m\r\n';
    serialTerm.write(errMsg);
    filterTabs.forEach(tab => tab.term.write(errMsg));
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
    renderThroughputChart(throughputRxChart, rxHistory || []);
    renderThroughputChart(throughputTxChart, txHistory || []);
}

ipcRenderer.on('serial-throughput-update', (event, payload) => {
    updateThroughputPanel(payload);
});

function updateSerialConnectionState(connected) {
    isConnected = connected;
    connectBtn.textContent = connected ? '❌ Disconnect' : '⚡ Connect';
    statusDiv.textContent = connected ? 'Connected' : 'Disconnected';
    statusDot.classList.toggle('online', connected);
}

ipcRenderer.on('serial-disconnected', (event, message) => {
    updateSerialConnectionState(false);
    if (message) {
        const notice = `\r\n\x1b[33m[INFO] ${message}\x1b[0m\r\n`;
        serialTerm.write(notice);
        filterTabs.forEach(tab => tab.term.write(notice));
    }
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
    }
});

baudCustomCancel.addEventListener('click', () => {
    baudCustomWrapper.style.display = 'none';
    baudSelect.style.display = 'block';
    baudSelect.value = '115200'; // Reset to default
});

function getBaudRate() {
    if (baudSelect.value === 'custom') {
        return baudCustomInput.value;
    }
    return baudSelect.value;
}

const refreshBtn = document.getElementById('refresh-btn');
const statusDiv = document.getElementById('serial-status');
const statusDot = document.getElementById('status-dot');

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
    const ports = await ipcRenderer.invoke('list-ports');
    portSelect.innerHTML = '<option value="">Select Port</option>';
    ports.forEach(port => {
        const opt = document.createElement('option');
        opt.value = port.path;
        opt.textContent = `${port.path} ${port.manufacturer || ''}`;
        if (currentConfig && currentConfig.lastSerialOptions && currentConfig.lastSerialOptions.path === port.path) {
            opt.selected = true;
        }
        portSelect.appendChild(opt);
    });
}

refreshBtn.addEventListener('click', refreshPorts);

clearBtn.addEventListener('click', () => {
    const activeTabPane = document.querySelector('.main-tab-pane.active');
    if (!activeTabPane) return;

    if (activeTabPane.id === 'tab-main') {
        serialTerm.clear();
        serialLineCounter = 1;
        dataParser.isNewLine = true;
        dataParser.incomingBuffer = '';
    } else {
        const filterTab = filterTabs.find(t => t.id === activeTabPane.id);
        if (filterTab) {
            filterTab.term.clear();
        }
    }
});

connectBtn.addEventListener('click', async () => {
    if (isConnected) {
        ipcRenderer.send('disconnect-serial');
    } else {
        const path = portSelect.value;
        const baudRate = getBaudRate();
        const dataBits = document.getElementById('data-bits-select').value;
        const stopBits = document.getElementById('stop-bits-select').value;
        const parity = document.getElementById('parity-select').value;
        const encoding = document.getElementById('encoding-select').value;
        const newlineMode = document.getElementById('newline-mode-select').value;

        if (!path) return;
        try {
            await ipcRenderer.invoke('connect-serial', {
                path,
                baudRate,
                dataBits,
                stopBits,
                parity,
                encoding,
                newlineMode
            });

            ipcRenderer.send('save-config', {
                lastSerialOptions: {
                    path,
                    baudRate,
                    dataBits,
                    stopBits,
                    parity,
                    encoding,
                    newlineMode
                }
            });

            updateSerialConnectionState(true);

            serialLineCounter = 1;
            serialNewLine = true;

            serialTerm.write(`\r\n\x1b[32m--- Connected to ${path} at ${baudRate} baud (${dataBits}N${stopBits}) ---\x1b[0m\r\n`);
        } catch (err) {
            alert('Failed to connect: ' + err);
        }
    }
});

// refreshPorts(); // Moved to config load chain

window.addEventListener('resize', () => {
    // fitAddon.fit();
    serialFitAddon.fit();
});

// Search Logic
const searchInput = document.getElementById('search-input');
const findNextBtn = document.getElementById('find-next-btn');
const findPrevBtn = document.getElementById('find-prev-btn');
const searchRegex = document.getElementById('search-regex');
const searchCase = document.getElementById('search-case');
const searchWord = document.getElementById('search-word');

function getSearchOptions() {
    return {
        regex: searchRegex.checked,
        caseSensitive: searchCase.checked,
        wholeWord: searchWord.checked,
        incremental: false 
    };
}

findNextBtn.addEventListener('click', () => {
    serialSearchAddon.findNext(searchInput.value, getSearchOptions());
});

findPrevBtn.addEventListener('click', () => {
    serialSearchAddon.findPrevious(searchInput.value, getSearchOptions());
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        if (e.shiftKey) {
             serialSearchAddon.findPrevious(searchInput.value, getSearchOptions());
        } else {
             serialSearchAddon.findNext(searchInput.value, getSearchOptions());
        }
    }
});

// Remove legacy filter window btn reference
// document.getElementById('new-filter-window-btn').addEventListener('click', ...);

// --- Auto Send & Quick Send Logic ---

let autoSendTimer = null;
const autoSendEnableCb = document.getElementById('auto-send-enable');
const autoSendIntervalInput = document.getElementById('auto-send-interval');
const autoSendTextInput = document.getElementById('auto-send-text');

const quickSendListEl = document.getElementById('quick-send-list');
const quickSendLabelInput = document.getElementById('quick-send-label');
const quickSendContentInput = document.getElementById('quick-send-content');
const addQuickSendBtn = document.getElementById('add-quick-send-btn');

let quickSendList = [];

function updateAutoSendState() {
    if (autoSendTimer) {
        clearInterval(autoSendTimer);
        autoSendTimer = null;
    }

    if (autoSendEnableCb.checked) {
        const interval = parseInt(autoSendIntervalInput.value) || 1000;
        
        if (interval > 0) {
            autoSendTimer = setInterval(() => {
                if (isConnected) {
                    const text = autoSendTextInput.value;
                    if (text) {
                        ipcRenderer.send('serial-input', text);
                    }
                }
            }, interval);
        }
    }
}

function saveAutoSendSettings() {
    ipcRenderer.send('save-config', {
        autoSendSettings: {
            enabled: autoSendEnableCb.checked,
            interval: autoSendIntervalInput.value,
            text: autoSendTextInput.value
        }
    });
}

autoSendEnableCb.addEventListener('change', () => {
    updateAutoSendState();
    saveAutoSendSettings();
});

autoSendIntervalInput.addEventListener('change', () => {
    updateAutoSendState();
    saveAutoSendSettings();
});

// Only save on blur to avoid frequent config saves while typing
autoSendTextInput.addEventListener('blur', saveAutoSendSettings);

// We don't need an input listener for text because the timer reads the value dynamically


let editingIndex = -1;

function renderQuickSendList() {
    quickSendListEl.innerHTML = '';
    
    quickSendList.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'quick-send-item';
        
        // If this item is being edited, highlight it
        if (index === editingIndex) {
            div.classList.add('editing');
        }

        const btn = document.createElement('button');
        btn.textContent = item.label || item.content;
        btn.title = `Send: ${item.content}`;
        btn.className = 'quick-send-main-btn';
        
        btn.addEventListener('click', () => {
            if (isConnected) {
                ipcRenderer.send('serial-input', item.content);
            } else {
                // Optional: flash error or status?
            }
        });
        
        // Action buttons container (vertical stack)
        const actionDiv = document.createElement('div');
        actionDiv.className = 'quick-send-actions';

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.className = 'quick-send-action-btn';
        editBtn.title = 'Edit';
        editBtn.addEventListener('click', () => {
            editingIndex = index;
            quickSendLabelInput.value = item.label || '';
            quickSendContentInput.value = item.content || '';
            addQuickSendBtn.textContent = 'Update Item';
            addQuickSendBtn.classList.remove('secondary'); // Make it primary color to indicate action
            renderQuickSendList();
        });

        const delBtn = document.createElement('button');
        delBtn.textContent = '✕';
        delBtn.className = 'quick-send-action-btn delete';
        delBtn.title = 'Remove';
        delBtn.addEventListener('click', () => {
            // If deleting the item currently being edited, cancel edit mode
            if (editingIndex === index) {
                editingIndex = -1;
                addQuickSendBtn.textContent = '+ Add to List';
                addQuickSendBtn.classList.add('secondary');
                quickSendLabelInput.value = '';
                quickSendContentInput.value = '';
            } else if (editingIndex > index) {
                // Adjust index if deleting an item above the edited one
                editingIndex--;
            }
            
            quickSendList.splice(index, 1);
            saveQuickSendList();
            renderQuickSendList();
        });

        actionDiv.appendChild(editBtn);
        actionDiv.appendChild(delBtn);
        
        div.appendChild(btn);
        div.appendChild(actionDiv);
        
        quickSendListEl.appendChild(div);
    });
}

function saveQuickSendList() {
    ipcRenderer.send('save-config', {
        quickSendList: quickSendList
    });
}

addQuickSendBtn.addEventListener('click', () => {
    const label = quickSendLabelInput.value.trim();
    const content = quickSendContentInput.value;
    
    if (content) {
        if (editingIndex > -1) {
            // Update existing item
            quickSendList[editingIndex] = { label, content };
            editingIndex = -1;
            addQuickSendBtn.textContent = '+ Add to List';
            addQuickSendBtn.classList.add('secondary');
        } else {
            // Add new item
            quickSendList.push({ label, content });
        }
        
        quickSendLabelInput.value = '';
        quickSendContentInput.value = '';
        renderQuickSendList();
        saveQuickSendList();
    }
});

// Update applyConfig to load these settings
const originalApplyConfig = applyConfig;
applyConfig = function(config) {
    originalApplyConfig(config);
    
    // Auto Send Settings
    if (config.autoSendSettings) {
        autoSendEnableCb.checked = config.autoSendSettings.enabled || false;
        autoSendIntervalInput.value = config.autoSendSettings.interval || 1000;
        autoSendTextInput.value = config.autoSendSettings.text || '';
        
        // Only update runtime state, do not save back to config
        updateAutoSendState(); 
    }
    
    // Quick Send List
    if (config.quickSendList) {
        quickSendList = config.quickSendList;
        renderQuickSendList();
    }
};
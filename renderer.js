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

function applyHighlighting(text) {
    if (!highlightRules || highlightRules.length === 0) return text;
    if (!text) return text;

    const matches = [];
    highlightRules.forEach(rule => {
        if (!rule.enabled || !rule.regex) return;
        try {
            const re = new RegExp(rule.regex, 'g');
            let match;
            while ((match = re.exec(text)) !== null) {
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    color: rule.color
                });
            }
        } catch (e) {
            // Ignore invalid regex
        }
    });

    if (matches.length === 0) return text;

    matches.sort((a, b) => a.start - b.start);

    let result = '';
    let lastIndex = 0;

    for (const m of matches) {
        if (m.start < lastIndex) continue; 
        
        result += text.substring(lastIndex, m.start);
        result += hexToAnsi(m.color) + text.substring(m.start, m.end) + '\x1b[0m';
        lastIndex = m.end;
    }
    
    result += text.substring(lastIndex);
    return result;
}

function processSerialOutput(data) {
    // Handle split packet boundary (\r followed by \n)
    if (lastCharWasCR && data.startsWith('\n')) {
        data = data.substring(1);
    }
    
    if (data.length === 0) {
        lastCharWasCR = false; 
        return '';
    }
    
    lastCharWasCR = data.endsWith('\r');

    // Split by CRLF, CR, or LF
    const parts = data.split(/\r\n|\r|\n/);
    let output = '';

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = (i === parts.length - 1);

        if (isLast && part === '') {
            // Trailing empty string from split (meaning data ended with newline)
            serialNewLine = true;
            continue;
        }

        if (serialNewLine) {
            output += getPrefix();
            serialNewLine = false;
        }

        output += applyHighlighting(part);

        if (!isLast) {
            output += '\r\n'; 
            serialNewLine = true;
        }
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

const serialTerm = new Terminal({ cursorBlink: true });
const serialFitAddon = new FitAddon();
const serialSearchAddon = new SearchAddon();
serialTerm.loadAddon(serialFitAddon);
serialTerm.loadAddon(serialSearchAddon);
serialTerm.open(document.getElementById('serial-container'));

// Smart Copy/Paste Handling
serialTerm.attachCustomKeyEventHandler((arg) => {
    if (arg.type !== 'keydown') return true; // Only handle keydown events

    const ctrlKey = arg.ctrlKey;
    const key = arg.key.toLowerCase();

    // Ctrl+C: Copy if selection exists, otherwise send ^C
    if (ctrlKey && key === 'c') {
        if (serialTerm.hasSelection()) {
            navigator.clipboard.writeText(serialTerm.getSelection());
            // Optional: clear selection after copy
            // serialTerm.clearSelection(); 
            return false; // Prevent sending ^C to serial
        }
        return true; // Send ^C to serial
    }

    // Ctrl+V: Paste if selection exists, otherwise send ^V
    if (ctrlKey && key === 'v') {
        if (serialTerm.hasSelection()) {
            navigator.clipboard.readText().then(text => {
                if (text) {
                    ipcRenderer.send('serial-input', text);
                }
            });
            return false; // Prevent sending ^V to serial
        }
        return true; // Send ^V to serial
    }

    return true; // Allow all other keys
});

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
        theme: {
            background: config.background,
            foreground: config.foreground,
            cursor: config.foreground
        }
    };
    // term.options = options;
    serialTerm.options = options;
    
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
    serialTerm.write(processSerialOutput(data));
});
ipcRenderer.on('serial-error', (event, err) => {
    serialTerm.write('\r\n\x1b[31m[ERROR] ' + err + '\x1b[0m\r\n');
});

const portSelect = document.getElementById('port-select');
const baudSelect = document.getElementById('baud-select');
const baudCustomWrapper = document.getElementById('baud-custom-wrapper');
const baudCustomInput = document.getElementById('baud-custom-input');
const baudCustomCancel = document.getElementById('baud-custom-cancel');
const connectBtn = document.getElementById('connect-btn');

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

connectBtn.addEventListener('click', async () => {
    if (isConnected) {
        ipcRenderer.send('disconnect-serial');
        isConnected = false;
        connectBtn.textContent = '⚡ Connect';
        statusDiv.textContent = 'Disconnected';
        statusDot.classList.remove('online');
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

            // Save Serial Settings
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

            isConnected = true;
            connectBtn.textContent = '❌ Disconnect';
            statusDiv.textContent = 'Connected';
            statusDot.classList.add('online');

            // Reset display counters
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

document.getElementById('new-filter-window-btn').addEventListener('click', () => {
    ipcRenderer.send('create-filter-window');
});

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
        div.style.display = 'flex';
        div.style.gap = '5px';
        div.style.alignItems = 'center';
        
        // If this item is being edited, highlight it
        if (index === editingIndex) {
            div.style.border = '1px solid #007acc';
            div.style.borderRadius = '4px';
            div.style.padding = '2px';
        }

        const btn = document.createElement('button');
        btn.textContent = item.label || item.content;
        btn.title = `Send: ${item.content}`;
        btn.style.flex = '1';
        btn.style.textAlign = 'left';
        btn.style.overflow = 'hidden';
        btn.style.textOverflow = 'ellipsis';
        btn.style.whiteSpace = 'nowrap';
        btn.addEventListener('click', () => {
            if (isConnected) {
                ipcRenderer.send('serial-input', item.content);
            } else {
                // Optional: flash error or status?
            }
        });
        
        // Action buttons container (vertical stack)
        const actionDiv = document.createElement('div');
        actionDiv.style.display = 'flex';
        actionDiv.style.flexDirection = 'column';
        actionDiv.style.gap = '2px';

        const editBtn = document.createElement('button');
        editBtn.textContent = '✎';
        editBtn.className = 'secondary';
        editBtn.style.width = '24px';
        editBtn.style.height = '14px'; // Compact height
        editBtn.style.padding = '0';
        editBtn.style.fontSize = '10px';
        editBtn.style.lineHeight = '12px';
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
        delBtn.className = 'secondary';
        delBtn.style.width = '24px';
        delBtn.style.height = '14px'; // Compact height
        delBtn.style.padding = '0';
        delBtn.style.fontSize = '10px';
        delBtn.style.lineHeight = '12px';
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
            renderQuickSendList();
            saveQuickSendList();
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
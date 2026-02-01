const { ipcRenderer } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

// Error logging
window.onerror = function(message, source, lineno, colno, error) {
    ipcRenderer.send('renderer-log', `ERROR: ${message} at ${lineno}:${colno}`);
};

try {
    // Initialize Terminal
    const term = new Terminal({ 
        cursorBlink: true,
        convertEol: true // Help with newline handling
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    
    const container = document.getElementById('terminal-container');
    if (!container) {
        ipcRenderer.send('renderer-log', 'Container not found!');
    } else {
        term.open(container);
        ipcRenderer.send('renderer-log', 'Terminal opened');
    }

    // Apply Config
    ipcRenderer.invoke('get-config').then(config => {
        const options = {
            fontSize: config.fontSize,
            fontFamily: config.fontFamily,
            theme: {
                background: config.background,
                foreground: config.foreground,
                cursor: config.foreground
            }
        };
        term.options = options;
        document.body.style.background = config.background;
        
        // Sync local colors and display settings from config
        timestampColor = config.timestampColor || '#00ff00';
        lineNoColor = config.lineNoColor || '#ffff00';
        highlightRules = config.highlightRules || [];
        showTimestamp = config.showTimestamp || false;
        showLineNumbers = config.showLineNumbers || false;

        // Fit after a short delay to ensure layout is ready
        setTimeout(() => {
            fitAddon.fit();
            ipcRenderer.send('renderer-log', 'Terminal fitted');
        }, 100);
    }).catch(err => {
        ipcRenderer.send('renderer-log', 'Config load failed: ' + err);
    });

    // Resize Handler
    window.addEventListener('resize', () => {
        fitAddon.fit();
    });

    // Filtering Logic
    let buffer = '';
    let filterRegex = null;
    const filterInput = document.getElementById('filter-input');
    const filterEnable = document.getElementById('filter-enable');
    const clearBtn = document.getElementById('clear-btn');

    function updateFilter() {
        if (!filterEnable.checked) {
            filterRegex = null;
            filterInput.disabled = true;
            return;
        }
        
        filterInput.disabled = false;
        const pattern = filterInput.value;
        try {
            // Default to case-insensitive matching
            filterRegex = pattern ? new RegExp(pattern, 'i') : null;
            filterInput.style.borderColor = '#3c3c3c'; // Reset error style
        } catch (e) {
            filterRegex = null;
            filterInput.style.borderColor = 'red'; // Indicate error
        }
    }

    filterInput.addEventListener('input', updateFilter);
    filterEnable.addEventListener('change', updateFilter);

    clearBtn.addEventListener('click', () => {
        term.clear();
    });

    // State for handling split packets (CR+LF)
    let lastCharWasCR = false;

    // Display Settings (Synced from Main)
    let showTimestamp = false;
    let showLineNumbers = false;
    let serialLineCounter = 1;
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

    ipcRenderer.on('update-display-settings', (event, settings) => {
        if (settings.showTimestamp !== undefined) showTimestamp = settings.showTimestamp;
        if (settings.showLineNumbers !== undefined) showLineNumbers = settings.showLineNumbers;
    });

    ipcRenderer.on('config-updated', (event, config) => {
        highlightRules = config.highlightRules || [];
        timestampColor = config.timestampColor || '#00ff00';
        lineNoColor = config.lineNoColor || '#ffff00';
        showTimestamp = config.showTimestamp || false;
        showLineNumbers = config.showLineNumbers || false;

        document.body.style.background = config.background;
        
        // Update terminal options
        term.options.fontFamily = config.fontFamily;
        term.options.fontSize = config.fontSize;
        term.options.theme = {
            background: config.background,
            foreground: config.foreground,
            cursor: config.foreground
        };
    });

    ipcRenderer.on('serial-output', (event, data) => {
        // 1. Handle split CR+LF across chunks
        if (lastCharWasCR && data.startsWith('\n')) {
            data = data.substring(1);
        }
        if (data.length === 0) {
            lastCharWasCR = false;
            return;
        }
        lastCharWasCR = data.endsWith('\r');

        // 2. Normalize newlines to \n
        // This handles \r\n, \n, and \r (legacy Mac / some devices) as valid line breaks
        // This ensures consistent line processing even if the device sends mixed endings
        const normalized = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        buffer += normalized;
        
        // 3. Split by \n
        const lines = buffer.split('\n');
        
        // The last element is the remaining buffer (incomplete line)
        buffer = lines.pop(); 
        
        for (const line of lines) {
            // If filter is active, check regex
            if (filterRegex) {
                // Remove any remaining control chars for testing if needed, 
                // but usually raw match is fine.
                if (filterRegex.test(line)) {
                    term.writeln(getPrefix() + applyHighlighting(line));
                }
            } else {
                // If no filter, just print the line.
                // Using writeln ensures clean line breaks, solving "staircasing" or "one line overwrite" issues.
                term.writeln(getPrefix() + applyHighlighting(line));
            }
        }
    });

    // Handle errors
    ipcRenderer.on('serial-error', (event, err) => {
        term.write('\r\n\x1b[31m[ERROR] ' + err + '\x1b[0m\r\n');
    });
    
    term.write('\x1b[32mFilter Window Ready\x1b[0m\r\n');

} catch (err) {
    ipcRenderer.send('renderer-log', 'Fatal error in filter.js: ' + err.stack);
}

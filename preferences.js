const { ipcRenderer, shell } = require('electron');

const elements = {
  fontFamily: document.getElementById('fontFamily'),
  fontFamilyZh: document.getElementById('fontFamilyZh'),
  fontSize: document.getElementById('fontSize'),
  foreground: document.getElementById('foreground'),
  background: document.getElementById('background'),
  foregroundHex: document.getElementById('foreground-hex'),
  backgroundHex: document.getElementById('background-hex'),
  
  timestampColor: document.getElementById('timestampColor'),
  timestampColorHex: document.getElementById('timestampColor-hex'),
  lineNoColor: document.getElementById('lineNoColor'),
  lineNoColorHex: document.getElementById('lineNoColor-hex'),

  scrollbackLimit: document.getElementById('scrollbackLimit'),
  historyBufferSize: document.getElementById('historyBufferSize'),

  highlightRulesList: document.getElementById('highlight-rules-list'),
  addRuleBtn: document.getElementById('add-rule-btn'),
  
  logEnabled: document.getElementById('logEnabled'),
  logSettings: document.getElementById('log-settings'),
  logPath: document.getElementById('logPath'),
  logFileNameFormat: document.getElementById('logFileNameFormat'),
  logEncoding: document.getElementById('logEncoding'),
  browseBtn: document.getElementById('browse-btn'),
  
  saveBtn: document.getElementById('save-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  resetBtn: document.getElementById('reset-btn'),
  openConfigBtn: document.getElementById('open-config-btn'),

  // Update elements
  updateStatusContainer: document.getElementById('update-status-container'),
  updateProgressBar: document.getElementById('update-progress-bar'),
  updateProgressFill: document.getElementById('update-progress-fill'),
  checkUpdateBtn: document.getElementById('check-update-btn'),
  restartInstallBtn: document.getElementById('restart-install-btn')
};

function createRuleElement(rule = { enabled: true, regex: '', color: '#ff0000', caseSensitive: false, useRegex: true }) {
    const div = document.createElement('div');
    div.style.display = 'flex';
    div.style.gap = '4px';
    div.style.alignItems = 'center';
    div.style.background = '#333';
    div.style.padding = '6px';
    div.style.borderRadius = '6px';

    const enabledCb = document.createElement('input');
    enabledCb.type = 'checkbox';
    enabledCb.checked = rule.enabled;
    enabledCb.style.width = '16px';
    enabledCb.style.height = '16px';
    enabledCb.style.cursor = 'pointer';
    enabledCb.style.margin = '0 4px';
    enabledCb.title = 'Enable/Disable';

    const inputWrapper = document.createElement('div');
    inputWrapper.style.flex = '1';
    inputWrapper.style.display = 'flex';
    inputWrapper.style.position = 'relative';

    const regexInput = document.createElement('input');
    regexInput.type = 'text';
    regexInput.value = rule.regex;
    regexInput.placeholder = 'Regex (e.g. error)';
    regexInput.style.flex = '1';
    regexInput.style.paddingRight = '60px'; // Make room for buttons

    const togglesWrapper = document.createElement('div');
    togglesWrapper.style.position = 'absolute';
    togglesWrapper.style.right = '4px';
    togglesWrapper.style.top = '50%';
    togglesWrapper.style.transform = 'translateY(-50%)';
    togglesWrapper.style.display = 'flex';
    togglesWrapper.style.gap = '2px';

    // State for this rule (default useRegex to true for backwards compatibility)
    let isCaseSensitive = rule.caseSensitive === true;
    let isUseRegex = rule.useRegex !== false;

    const caseBtn = document.createElement('button');
    caseBtn.className = `filter-toggle-btn ${isCaseSensitive ? 'active' : ''}`;
    caseBtn.title = 'Match Case';
    caseBtn.textContent = 'Aa';
    caseBtn.style.height = '22px';
    caseBtn.style.padding = '0 4px';
    caseBtn.style.fontSize = '11px';
    
    caseBtn.onclick = (e) => {
        isCaseSensitive = !isCaseSensitive;
        caseBtn.classList.toggle('active', isCaseSensitive);
    };

    const regexBtn = document.createElement('button');
    regexBtn.className = `filter-toggle-btn ${isUseRegex ? 'active' : ''}`;
    regexBtn.title = 'Use Regular Expression';
    regexBtn.textContent = '.*';
    regexBtn.style.height = '22px';
    regexBtn.style.padding = '0 4px';
    regexBtn.style.fontSize = '11px';
    
    regexBtn.onclick = (e) => {
        isUseRegex = !isUseRegex;
        regexBtn.classList.toggle('active', isUseRegex);
    };

    togglesWrapper.appendChild(caseBtn);
    togglesWrapper.appendChild(regexBtn);
    
    inputWrapper.appendChild(regexInput);
    inputWrapper.appendChild(togglesWrapper);

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = rule.color;
    colorInput.style.width = '36px';
    colorInput.style.height = '28px';
    colorInput.style.padding = '1px';
    colorInput.style.border = 'none';
    colorInput.style.cursor = 'pointer';

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '✕';
    deleteBtn.className = 'secondary';
    deleteBtn.style.padding = '4px 8px';
    deleteBtn.title = 'Remove Rule';
    deleteBtn.onclick = () => div.remove();

    // Attach state getter for save function
    div.getRuleData = () => ({
        enabled: enabledCb.checked,
        regex: regexInput.value,
        color: colorInput.value,
        caseSensitive: isCaseSensitive,
        useRegex: isUseRegex
    });

    div.appendChild(enabledCb);
    div.appendChild(inputWrapper);
    div.appendChild(colorInput);
    div.appendChild(deleteBtn);

    return div;
}

elements.addRuleBtn.onclick = () => {
    elements.highlightRulesList.appendChild(createRuleElement());
};

async function init() {
  const config = await ipcRenderer.invoke('get-config');
  
  // Load system fonts
  try {
      const systemFonts = await ipcRenderer.invoke('get-system-fonts');
      if (systemFonts && systemFonts.length > 0) {
          const fontGroupEn = document.createElement('optgroup');
          fontGroupEn.label = "System Fonts";
          const fontGroupZh = document.createElement('optgroup');
          fontGroupZh.label = "System Fonts";
          
          systemFonts.forEach(font => {
              const optEn = document.createElement('option');
              // Format correctly for CSS font-family
              optEn.value = `"${font}"`;
              optEn.textContent = font;
              fontGroupEn.appendChild(optEn);

              const optZh = document.createElement('option');
              optZh.value = `"${font}"`;
              optZh.textContent = font;
              fontGroupZh.appendChild(optZh);
          });
          elements.fontFamily.appendChild(fontGroupEn);
          elements.fontFamilyZh.appendChild(fontGroupZh);
      }
  } catch (err) {
      console.error('Failed to load system fonts:', err);
  }

  elements.fontFamily.value = config.fontFamily;
  if (elements.fontFamily.value !== config.fontFamily) {
      const opt = document.createElement('option');
      opt.value = config.fontFamily;
      opt.textContent = config.fontFamily.replace(/"/g, '');
      elements.fontFamily.insertBefore(opt, elements.fontFamily.firstChild);
      elements.fontFamily.value = config.fontFamily;
  }

  elements.fontFamilyZh.value = config.fontFamilyZh;
  if (elements.fontFamilyZh.value !== config.fontFamilyZh) {
      const opt = document.createElement('option');
      opt.value = config.fontFamilyZh;
      opt.textContent = config.fontFamilyZh ? config.fontFamilyZh.replace(/"/g, '') : 'None';
      elements.fontFamilyZh.insertBefore(opt, elements.fontFamilyZh.firstChild);
      elements.fontFamilyZh.value = config.fontFamilyZh;
  }

  elements.fontSize.value = config.fontSize;
  elements.foreground.value = config.foreground;
  elements.background.value = config.background;
  elements.foregroundHex.textContent = config.foreground;
  elements.backgroundHex.textContent = config.background;

  elements.timestampColor.value = config.timestampColor || '#00ff00';
  elements.timestampColorHex.textContent = config.timestampColor || '#00ff00';
  elements.lineNoColor.value = config.lineNoColor || '#ffff00';
  elements.lineNoColorHex.textContent = config.lineNoColor || '#ffff00';
  
  elements.scrollbackLimit.value = config.scrollbackLimit || 100000;
  elements.historyBufferSize.value = config.historyBufferSize || 5000000;

  elements.logEnabled.checked = config.logEnabled;
  elements.logPath.value = config.logPath;
  elements.logFileNameFormat.value = config.logFileNameFormat;
  elements.logEncoding.value = config.logEncoding;
  
  toggleLogSettings(config.logEnabled);

  // Load rules
  if (config.highlightRules) {
      config.highlightRules.forEach(rule => {
          elements.highlightRulesList.appendChild(createRuleElement(rule));
      });
  }

  // Load About Info
  try {
      const aboutInfo = await ipcRenderer.invoke('get-about-info');
      const versionEl = document.getElementById('app-version');
      const authorEl = document.getElementById('app-author');
      const githubLink = document.getElementById('app-github');

      if (versionEl) versionEl.textContent = aboutInfo.version;
      if (authorEl) authorEl.textContent = aboutInfo.author;
      if (githubLink) {
          githubLink.textContent = aboutInfo.github;
          githubLink.onclick = (e) => {
              e.preventDefault();
              shell.openExternal(aboutInfo.github);
          };
      }
  } catch (err) {
      console.error('Failed to load about info:', err);
  }
}

function toggleLogSettings(enabled) {
  elements.logSettings.style.display = enabled ? 'block' : 'none';
}

elements.logEnabled.onchange = (e) => toggleLogSettings(e.target.checked);

elements.foreground.oninput = (e) => elements.foregroundHex.textContent = e.target.value;
elements.background.oninput = (e) => elements.backgroundHex.textContent = e.target.value;
elements.timestampColor.oninput = (e) => elements.timestampColorHex.textContent = e.target.value;
elements.lineNoColor.oninput = (e) => elements.lineNoColorHex.textContent = e.target.value;

elements.browseBtn.onclick = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) {
    elements.logPath.value = path;
  }
};

elements.saveBtn.onclick = () => {
  const rules = [];
  Array.from(elements.highlightRulesList.children).forEach(div => {
      rules.push(div.getRuleData());
  });

  const config = {
    fontFamily: elements.fontFamily.value,
    fontFamilyZh: elements.fontFamilyZh.value,
    fontSize: parseInt(elements.fontSize.value),
    foreground: elements.foreground.value,
    background: elements.background.value,
    timestampColor: elements.timestampColor.value,
    lineNoColor: elements.lineNoColor.value,
    scrollbackLimit: parseInt(elements.scrollbackLimit.value) || 100000,
    historyBufferSize: parseInt(elements.historyBufferSize.value) || 5000000,
    logEnabled: elements.logEnabled.checked,
    logPath: elements.logPath.value,
    logFileNameFormat: elements.logFileNameFormat.value,
    logEncoding: elements.logEncoding.value,
    highlightRules: rules
  };
  ipcRenderer.send('save-config', config);
  window.close();
};

elements.cancelBtn.onclick = () => {
  window.close();
};

elements.resetBtn.onclick = () => {
    if (confirm('Are you sure you want to reset all settings to defaults? This cannot be undone.')) {
        ipcRenderer.send('reset-config');
        window.close();
    }
};

elements.openConfigBtn.onclick = () => {
    ipcRenderer.send('open-config-folder');
};

// Update Logic
if (elements.checkUpdateBtn) {
    elements.checkUpdateBtn.onclick = () => {
        ipcRenderer.send('check-for-updates');
        if (elements.updateStatusContainer) {
            elements.updateStatusContainer.textContent = 'Checking for updates...';
            elements.updateStatusContainer.style.color = 'var(--text-secondary)';
        }
        elements.checkUpdateBtn.disabled = true;
    };
}

if (elements.restartInstallBtn) {
    elements.restartInstallBtn.onclick = () => {
        ipcRenderer.send('quit-and-install');
    };
}

ipcRenderer.on('update-status', (event, { status, data }) => {
    const statusEl = elements.updateStatusContainer;
    const progressEl = elements.updateProgressBar;
    const fillEl = elements.updateProgressFill;
    const checkBtn = elements.checkUpdateBtn;
    const restartBtn = elements.restartInstallBtn;

    if (!statusEl || !checkBtn) return;

    switch (status) {
        case 'checking':
            statusEl.textContent = 'Checking for updates...';
            checkBtn.disabled = true;
            if (progressEl) progressEl.style.display = 'none';
            if (restartBtn) restartBtn.style.display = 'none';
            break;
        case 'available':
            statusEl.textContent = `Update available: ${data.version}. Downloading...`;
            statusEl.style.color = 'var(--accent-color)';
            if (progressEl) progressEl.style.display = 'block';
            checkBtn.style.display = 'none';
            break;
        case 'not-available':
            statusEl.textContent = 'You are on the latest version.';
            statusEl.style.color = 'var(--text-secondary)';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'error':
            statusEl.textContent = `Error: ${data}`;
            statusEl.style.color = '#ff4444';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'download-progress':
            statusEl.textContent = `Downloading... ${Math.round(data.percent)}%`;
            if (fillEl) fillEl.style.width = `${data.percent}%`;
            break;
        case 'downloaded':
            statusEl.textContent = `Update downloaded (${data.version}). Ready to install.`;
            statusEl.style.color = '#00ff00';
            if (progressEl) progressEl.style.display = 'none';
            checkBtn.style.display = 'none';
            if (restartBtn) restartBtn.style.display = 'inline-block';
            break;
    }
});

// Wrap init in DOMContentLoaded to be safe, or just call it if document is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

const { ipcRenderer, shell } = require('electron');
const { t, getLanguage } = require('./i18n');

let currentLanguage = 'en';

function tr(key, params = {}) {
    return t(currentLanguage, key, params);
}

const elements = {
  fontFamily: document.getElementById('fontFamily'),
  fontFamilyZh: document.getElementById('fontFamilyZh'),
    languageSelect: document.getElementById('language-select'),
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
  mouseWheelScrollLines: document.getElementById('mouseWheelScrollLines'),

  highlightRulesList: document.getElementById('highlight-rules-list'),
  addRuleBtn: document.getElementById('add-rule-btn'),
  
  logEnabled: document.getElementById('logEnabled'),
    saveAllTabsLogToFiles: document.getElementById('saveAllTabsLogToFiles'),
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
  restartInstallBtn: document.getElementById('restart-install-btn'),

  // Shell profiles
  shellProfilesList: document.getElementById('shell-profiles-list'),
  addShellProfileBtn: document.getElementById('add-shell-profile-btn')
};

let shellProfiles = [];
let defaultShellProfileName = '';

function applyPrefsI18n() {
    document.title = tr('prefsTitle');

    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = tr(el.dataset.i18n);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = tr(el.dataset.i18nPlaceholder);
    });

    if (elements.addRuleBtn) elements.addRuleBtn.textContent = tr('prefs.addRule');
    if (elements.checkUpdateBtn) elements.checkUpdateBtn.textContent = tr('prefs.checkForUpdates');
    if (elements.restartInstallBtn) elements.restartInstallBtn.textContent = tr('prefs.restartInstall');
    if (elements.saveBtn) elements.saveBtn.textContent = tr('prefs.saveApply');
    if (elements.cancelBtn) elements.cancelBtn.textContent = tr('prefs.cancel');
    if (elements.resetBtn) elements.resetBtn.textContent = tr('prefs.resetDefaults');
    if (elements.openConfigBtn) elements.openConfigBtn.textContent = tr('prefs.openConfigFolder');
}

function populateLanguageOptions() {
    if (!elements.languageSelect) return;
    const options = [
        ['en', tr('languages.en')],
        ['zh-CN', tr('languages.zhCN')],
        ['zh-TW', tr('languages.zhTW')],
        ['fr', tr('languages.fr')],
        ['ru', tr('languages.ru')],
        ['de', tr('languages.de')]
    ];

    elements.languageSelect.innerHTML = '';
    options.forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        elements.languageSelect.appendChild(option);
    });
}

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
    enabledCb.title = tr('prefs.enableDisable');

    const inputWrapper = document.createElement('div');
    inputWrapper.style.flex = '1';
    inputWrapper.style.display = 'flex';
    inputWrapper.style.position = 'relative';

    const regexInput = document.createElement('input');
    regexInput.type = 'text';
    regexInput.value = rule.regex;
    regexInput.placeholder = tr('prefs.regexPlaceholder');
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
    caseBtn.title = tr('main.matchCase');
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
    regexBtn.title = tr('main.useRegex');
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
    deleteBtn.title = tr('prefs.removeRule');
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
    currentLanguage = getLanguage(config.language);
    applyPrefsI18n();
    populateLanguageOptions();
    if (elements.languageSelect) elements.languageSelect.value = currentLanguage;
  
  // Load system fonts
  try {
      const systemFonts = await ipcRenderer.invoke('get-system-fonts');
      if (systemFonts && systemFonts.length > 0) {
          const fontGroupEn = document.createElement('optgroup');
          fontGroupEn.label = tr('prefs.systemFonts');
          const fontGroupZh = document.createElement('optgroup');
          fontGroupZh.label = tr('prefs.systemFonts');
          
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
  elements.mouseWheelScrollLines.value = config.mouseWheelScrollLines || 3;

  elements.logEnabled.checked = config.logEnabled;
    elements.saveAllTabsLogToFiles.checked = config.saveAllTabsLogToFiles === true;
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

  // Load shell profiles
  shellProfiles = Array.isArray(config.shellProfiles) ? JSON.parse(JSON.stringify(config.shellProfiles)) : [];
  defaultShellProfileName = config.defaultShellProfile || '';
  renderShellProfiles();

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

// Shell Profiles Management
function renderShellProfiles() {
    if (!elements.shellProfilesList) return;
    elements.shellProfilesList.innerHTML = '';
    shellProfiles.forEach((profile, index) => {
        const card = createShellProfileCard(profile, index);
        elements.shellProfilesList.appendChild(card);
    });
}

function createShellProfileCard(profile, index) {
    const card = document.createElement('div');
    card.style.cssText = 'background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 8px;';

    // Row 1: Name + Delete button
    const row1 = document.createElement('div');
    row1.style.cssText = 'display: flex; gap: 6px; align-items: center;';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = profile.name || '';
    nameInput.placeholder = tr('prefs.shellProfileNamePlaceholder') || 'Profile name (e.g. Git Bash)';
    nameInput.style.cssText = 'flex: 1;';
    nameInput.onchange = () => { shellProfiles[index].name = nameInput.value; };
    const removeBtn = document.createElement('button');
    removeBtn.className = 'secondary danger';
    removeBtn.textContent = '✕';
    removeBtn.style.cssText = 'width: 28px; padding: 0 6px;';
    removeBtn.title = tr('prefs.removeRule');
    removeBtn.onclick = () => {
        shellProfiles.splice(index, 1);
        renderShellProfiles();
    };
    row1.appendChild(nameInput);
    row1.appendChild(removeBtn);
    card.appendChild(row1);

    // Row 2: Executable path
    const row2 = document.createElement('div');
    row2.style.cssText = 'display: flex; gap: 6px; align-items: center;';
    const execInput = document.createElement('input');
    execInput.type = 'text';
    execInput.value = profile.executable || '';
    execInput.placeholder = tr('prefs.shellProfileExecPlaceholder') || 'Executable path (e.g. C:\\path\\to\\shell.exe)';
    execInput.style.cssText = 'flex: 1; font-family: Consolas, monospace; font-size: 12px;';
    execInput.onchange = () => { shellProfiles[index].executable = execInput.value; };
    const browseBtn = document.createElement('button');
    browseBtn.className = 'secondary';
    browseBtn.textContent = '…';
    browseBtn.style.cssText = 'width: 28px; padding: 0 6px; font-weight: bold;';
    browseBtn.title = tr('prefs.browse');
    browseBtn.onclick = async () => {
        const result = await ipcRenderer.invoke('select-shell-executable');
        if (result) {
            execInput.value = result;
            shellProfiles[index].executable = result;
        }
    };
    row2.appendChild(execInput);
    row2.appendChild(browseBtn);
    card.appendChild(row2);

    // Row 3: Args + Shell Type
    const row3 = document.createElement('div');
    row3.style.cssText = 'display: flex; gap: 6px; align-items: center;';
    const argsInput = document.createElement('input');
    argsInput.type = 'text';
    argsInput.value = (profile.args || []).join(' ');
    argsInput.placeholder = tr('prefs.shellProfileArgsPlaceholder') || 'Arguments (e.g. -i -l)';
    argsInput.style.cssText = 'flex: 1; font-family: Consolas, monospace; font-size: 12px;';
    argsInput.onchange = () => { shellProfiles[index].args = argsInput.value.split(/\s+/).filter(Boolean); };
    const typeSelect = document.createElement('select');
    typeSelect.style.cssText = 'width: 110px; font-size: 12px;';
    ['auto', 'cmd', 'powershell', 'bash', 'zsh', 'pwsh'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t;
        if (profile.shellType === t || (!profile.shellType && t === 'auto')) opt.selected = true;
        typeSelect.appendChild(opt);
    });
    typeSelect.onchange = () => { shellProfiles[index].shellType = typeSelect.value; };
    row3.appendChild(argsInput);
    row3.appendChild(typeSelect);
    card.appendChild(row3);

    // Row 4: Set as default
    const row4 = document.createElement('div');
    row4.style.cssText = 'display: flex; align-items: center; gap: 6px;';
    const defaultCb = document.createElement('input');
    defaultCb.type = 'radio';
    defaultCb.name = 'default-shell-profile';
    defaultCb.value = profile.name || '';
    defaultCb.checked = profile.name === defaultShellProfileName;
    defaultCb.style.cssText = 'margin: 0 4px;';
    defaultCb.onchange = () => {
        if (defaultCb.checked) {
            defaultShellProfileName = profile.name;
            renderShellProfiles();
        }
    };
    const defaultLabel = document.createElement('span');
    defaultLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
    defaultLabel.textContent = tr('prefs.setAsDefaultShellProfile') || 'Set as default shell';
    row4.appendChild(defaultCb);
    row4.appendChild(defaultLabel);
    card.appendChild(row4);

    return card;
}

function addShellProfile() {
    shellProfiles.push({ name: '', executable: '', args: [], shellType: 'auto' });
    renderShellProfiles();
    // Scroll to bottom
    if (elements.shellProfilesList) {
        elements.shellProfilesList.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    }
}

if (elements.addShellProfileBtn) {
    elements.addShellProfileBtn.onclick = addShellProfile;
}

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
        language: elements.languageSelect.value,
    fontFamily: elements.fontFamily.value,
    fontFamilyZh: elements.fontFamilyZh.value,
    fontSize: parseInt(elements.fontSize.value),
    foreground: elements.foreground.value,
    background: elements.background.value,
    timestampColor: elements.timestampColor.value,
    lineNoColor: elements.lineNoColor.value,
    scrollbackLimit: parseInt(elements.scrollbackLimit.value) || 100000,
    historyBufferSize: parseInt(elements.historyBufferSize.value) || 5000000,
    mouseWheelScrollLines: parseInt(elements.mouseWheelScrollLines.value) || 3,
    logEnabled: elements.logEnabled.checked,
    saveAllTabsLogToFiles: elements.saveAllTabsLogToFiles.checked,
    logPath: elements.logPath.value,
    logFileNameFormat: elements.logFileNameFormat.value,
    logEncoding: elements.logEncoding.value,
    highlightRules: rules,
    shellProfiles,
    defaultShellProfile: defaultShellProfileName
  };
  ipcRenderer.send('save-config', config);
  window.close();
};

elements.cancelBtn.onclick = () => {
  window.close();
};

elements.resetBtn.onclick = () => {
    if (confirm(tr('prefs.confirmReset'))) {
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
            elements.updateStatusContainer.textContent = tr('prefs.checkingForUpdates');
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
            statusEl.textContent = tr('prefs.checkingForUpdates');
            checkBtn.disabled = true;
            if (progressEl) progressEl.style.display = 'none';
            if (restartBtn) restartBtn.style.display = 'none';
            break;
        case 'available':
            statusEl.textContent = tr('prefs.updateAvailableManual', { version: data.version });
            statusEl.style.color = 'var(--accent-color)';
            if (progressEl) progressEl.style.display = 'none';
            checkBtn.disabled = false;
            break;
        case 'not-available':
            statusEl.textContent = tr('prefs.latestVersion');
            statusEl.style.color = 'var(--text-secondary)';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'error':
            if (data && (data.includes('504') || data.includes('Cannot download') || data.includes('net::ERR_'))) {
                statusEl.innerHTML = `${tr('prefs.updateFailedNetwork')} <a href="#" id="manual-dl-link" style="color: var(--accent-color); text-decoration: underline; cursor: pointer;">${tr('prefs.downloadFromGithub')}</a>`;
                document.getElementById('manual-dl-link').onclick = (e) => {
                    e.preventDefault();
                    shell.openExternal('https://github.com/Trigger-CN/SerialTerminal/releases/latest');
                };
            } else {
                statusEl.textContent = tr('prefs.error', { message: data });
            }
            statusEl.style.color = '#ff4444';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'download-progress':
            statusEl.textContent = tr('prefs.downloading', { percent: Math.round(data.percent) });
            if (fillEl) fillEl.style.width = `${data.percent}%`;
            break;
        case 'downloaded':
            statusEl.textContent = tr('prefs.updateDownloaded', { version: data.version });
            statusEl.style.color = '#00ff00';
            if (progressEl) progressEl.style.display = 'none';
            checkBtn.style.display = 'none';
            if (restartBtn) restartBtn.style.display = 'inline-block';
            break;
    }
});

elements.languageSelect?.addEventListener('change', () => {
    currentLanguage = getLanguage(elements.languageSelect.value);
    applyPrefsI18n();
    populateLanguageOptions();
    elements.languageSelect.value = currentLanguage;
});

// Wrap init in DOMContentLoaded to be safe, or just call it if document is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

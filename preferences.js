const { ipcRenderer, shell } = require('electron');
const { randomUUID } = require('crypto');
const { t, getLanguage } = require('./i18n');
const { normalizeFontWeight, normalizeIntegerSetting } = require('./config-values');

const createMaterialIcon = (name, className = 'material-icon') => window.MaterialIcons.createIcon(name, className);

function translatedActionLabel(key) {
    return tr(key).replace(/^\s*\+\s*/, '');
}

let currentLanguage = 'en';

function tr(key, params = {}) {
    return t(currentLanguage, key, params);
}

function focusPreferencesTab(tabId) {
    const tabPane = document.getElementById(tabId);
    if (!tabPane || !tabPane.classList.contains('tab-pane')) return;

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === tabId);
    });
}

ipcRenderer.on('focus-preferences-tab', (_event, tabId) => {
    focusPreferencesTab(tabId);
});

const elements = {
  fontFamily: document.getElementById('fontFamily'),
  fontFamilyZh: document.getElementById('fontFamilyZh'),
    languageSelect: document.getElementById('language-select'),
  fontSize: document.getElementById('fontSize'),
  fontWeight: document.getElementById('fontWeight'),
  foreground: document.getElementById('foreground'),
  background: document.getElementById('background'),
  foregroundHex: document.getElementById('foreground-hex'),
  backgroundHex: document.getElementById('background-hex'),
  
  timestampColor: document.getElementById('timestampColor'),
  timestampColorHex: document.getElementById('timestampColor-hex'),
  lineNoColor: document.getElementById('lineNoColor'),
  lineNoColorHex: document.getElementById('lineNoColor-hex'),
  searchHighlightBackground: document.getElementById('searchHighlightBackground'),
  searchHighlightForeground: document.getElementById('searchHighlightForeground'),
  filterHighlightBackground: document.getElementById('filterHighlightBackground'),
  filterHighlightForeground: document.getElementById('filterHighlightForeground'),
  selectionHighlightBackground: document.getElementById('selectionHighlightBackground'),
  selectionHighlightForeground: document.getElementById('selectionHighlightForeground'),

  scrollbackLimit: document.getElementById('scrollbackLimit'),
  historyBufferSize: document.getElementById('historyBufferSize'),
  mouseWheelScrollLines: document.getElementById('mouseWheelScrollLines'),
  mainInputHistoryLimit: document.getElementById('mainInputHistoryLimit'),
  hexBytesPerLine: document.getElementById('hexBytesPerLine'),
  hexShowOffset: document.getElementById('hexShowOffset'),
  hexShowAscii: document.getElementById('hexShowAscii'),
  hexUppercase: document.getElementById('hexUppercase'),
  hexIdleFlushMs: document.getElementById('hexIdleFlushMs'),

  highlightRulesList: document.getElementById('highlight-rules-list'),
  addRuleBtn: document.getElementById('add-rule-btn'),
  resetHighlightRulesBtn: document.getElementById('reset-highlight-rules-btn'),
  
  logEnabled: document.getElementById('logEnabled'),
    saveAllTabsLogToFiles: document.getElementById('saveAllTabsLogToFiles'),
    stripAnsiInLog: document.getElementById('stripAnsiInLog'),
  logSettings: document.getElementById('log-settings'),
  logPath: document.getElementById('logPath'),
  logRetentionDays: document.getElementById('logRetentionDays'),
  logFileNameFormat: document.getElementById('logFileNameFormat'),
  logEncoding: document.getElementById('logEncoding'),
  logIncludeTimestamp: document.getElementById('logIncludeTimestamp'),
  logIncludeLineNumbers: document.getElementById('logIncludeLineNumbers'),
  rawBufferAutoFlushMB: document.getElementById('rawBufferAutoFlushMB'),
  saveRawSerialToFile: document.getElementById('saveRawSerialToFile'),
  rawLogFileNameFormat: document.getElementById('rawLogFileNameFormat'),
  browseBtn: document.getElementById('browse-btn'),
  
  saveBtn: document.getElementById('save-btn'),
  cancelBtn: document.getElementById('cancel-btn'),
  resetBtn: document.getElementById('reset-btn'),
  openConfigBtn: document.getElementById('open-config-btn'),
  telemetryEnabled: document.getElementById('telemetryEnabled'),

  // Update elements
  updateStatusContainer: document.getElementById('update-status-container'),
  updateProgressBar: document.getElementById('update-progress-bar'),
  updateProgressFill: document.getElementById('update-progress-fill'),
  checkUpdateBtn: document.getElementById('check-update-btn'),
  restartInstallBtn: document.getElementById('restart-install-btn'),

  // Shell profiles
  shellProfilesList: document.getElementById('shell-profiles-list'),
  addShellProfileBtn: document.getElementById('add-shell-profile-btn'),

  // Shortcuts
  shortcutsList: document.getElementById('shortcuts-list'),
  resetShortcutsBtn: document.getElementById('reset-shortcuts-btn')
};

let shellProfiles = [];
let defaultShellProfileId = '';

const DEFAULT_HEX_DISPLAY_SETTINGS = {
    bytesPerLine: 16,
    showOffset: true,
    showAscii: true,
    uppercase: true,
    idleFlushMs: 50
};
const DEFAULT_RAW_LOG_FILE_NAME_FORMAT = 'raw_%Y-%m-%d_%H-%M-%S.bin';
const DEFAULT_HIGHLIGHT_RULES = [
    { regex: "\\b(error|fail|failed|fatal)\\b", color: "#ff4d4f", enabled: true, caseSensitive: false, useRegex: true },
    { regex: "\\b(warn|warning)\\b", color: "#faad14", enabled: true, caseSensitive: false, useRegex: true },
    { regex: "\\b(info|debug|trace)\\b", color: "#1890ff", enabled: true, caseSensitive: false, useRegex: true },
    { regex: "\\b(success|ok|done)\\b", color: "#52c41a", enabled: true, caseSensitive: false, useRegex: true },
    { regex: "\\b\\d+(\\.\\d+)?\\b", color: "#13c2c2", enabled: true, caseSensitive: true, useRegex: true },
    { regex: "[+\\-*/=<>!&|%^~]+", color: "#eb2f96", enabled: true, caseSensitive: true, useRegex: true }
];
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
const SHORTCUT_ACTIONS = [
    ['sendMainInput', 'prefs.shortcutSendMainInput'],
    ['toggleSendHistory', 'prefs.shortcutToggleSendHistory'],
    ['historyPrevious', 'prefs.shortcutHistoryPrevious'],
    ['historyNext', 'prefs.shortcutHistoryNext'],
    ['focusSearch', 'prefs.shortcutFocusSearch'],
    ['clearActiveTerminal', 'prefs.shortcutClearActiveTerminal'],
    ['refreshPorts', 'prefs.shortcutRefreshPorts'],
    ['toggleSerialConnection', 'prefs.shortcutToggleSerialConnection']
];
let shortcutValues = { ...DEFAULT_SHORTCUTS };

function normalizeLogAutoFlushMB(value) {
    return normalizeIntegerSetting(value, 'rawBufferAutoFlushMB');
}

function normalizeMainInputHistoryLimit(value) {
    return normalizeIntegerSetting(value, 'mainInputHistoryLimit');
}

function normalizeHexDisplaySettings(settings = {}) {
    const bytesPerLine = Number.parseInt(settings.bytesPerLine, 10);
    return {
        bytesPerLine: [8, 16, 24, 32].includes(bytesPerLine) ? bytesPerLine : DEFAULT_HEX_DISPLAY_SETTINGS.bytesPerLine,
        showOffset: typeof settings.showOffset === 'boolean' ? settings.showOffset : DEFAULT_HEX_DISPLAY_SETTINGS.showOffset,
        showAscii: typeof settings.showAscii === 'boolean' ? settings.showAscii : DEFAULT_HEX_DISPLAY_SETTINGS.showAscii,
        uppercase: typeof settings.uppercase === 'boolean' ? settings.uppercase : DEFAULT_HEX_DISPLAY_SETTINGS.uppercase,
        idleFlushMs: normalizeIntegerSetting(settings.idleFlushMs, 'hexIdleFlushMs')
    };
}

function normalizeRawLogFileNameFormat(value) {
    let fileName = String(value || '').trim() || DEFAULT_RAW_LOG_FILE_NAME_FORMAT;
    fileName = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    if (!/\.bin$/i.test(fileName)) {
        fileName = fileName.replace(/\.[^.]+$/, '') + '.bin';
    }
    return fileName;
}

function applyPrefsI18n() {
    document.title = tr('prefsTitle');

    document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = el.closest('button') ? translatedActionLabel(el.dataset.i18n) : tr(el.dataset.i18n);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = tr(el.dataset.i18nPlaceholder);
    });

    document.querySelectorAll('[data-i18n-alt]').forEach(el => {
        el.alt = tr(el.dataset.i18nAlt);
    });

    renderShortcuts();
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

function formatShortcutFromEvent(event) {
    const key = normalizeShortcutKeyName(event.key);
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
    if (key === 'Backspace' || key === 'Delete') return '';
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    parts.push(key);
    return parts.join('+');
}

function normalizeShortcuts(shortcuts = {}) {
    const normalized = { ...DEFAULT_SHORTCUTS };
    Object.keys(DEFAULT_SHORTCUTS).forEach(action => {
        if (typeof shortcuts[action] === 'string') normalized[action] = shortcuts[action].trim();
    });
    return normalized;
}

function renderShortcuts() {
    if (!elements.shortcutsList) return;
    elements.shortcutsList.innerHTML = '';
    SHORTCUT_ACTIONS.forEach(([action, labelKey]) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: grid; grid-template-columns: minmax(160px, 1fr) 180px; gap: 10px; align-items: center; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px;';

        const label = document.createElement('label');
        label.textContent = tr(labelKey);
        label.style.margin = '0';

        const input = document.createElement('input');
        input.type = 'text';
        input.readOnly = true;
        input.value = shortcutValues[action] || '';
        input.placeholder = tr('prefs.shortcutDisabled');
        input.dataset.action = action;
        input.style.cssText = 'width: 100%; font-family: Consolas, monospace; cursor: pointer;';
        input.addEventListener('keydown', event => {
            event.preventDefault();
            event.stopPropagation();
            const next = formatShortcutFromEvent(event);
            shortcutValues[action] = next;
            input.value = next;
        });
        input.addEventListener('focus', () => input.select());

        row.appendChild(label);
        row.appendChild(input);
        elements.shortcutsList.appendChild(row);
    });
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
    caseBtn.appendChild(createMaterialIcon('match_case'));
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
    regexBtn.appendChild(createMaterialIcon('regular_expression'));
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
    deleteBtn.className = 'secondary';
    deleteBtn.appendChild(createMaterialIcon('delete'));
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

function renderHighlightRules(rules = []) {
    elements.highlightRulesList.innerHTML = '';
    rules.forEach(rule => {
        elements.highlightRulesList.appendChild(createRuleElement(rule));
    });
}

elements.addRuleBtn.onclick = () => {
    elements.highlightRulesList.appendChild(createRuleElement());
};

if (elements.resetHighlightRulesBtn) {
    elements.resetHighlightRulesBtn.onclick = () => {
        renderHighlightRules(DEFAULT_HIGHLIGHT_RULES);
    };
}

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

  elements.fontSize.value = String(normalizeIntegerSetting(config.fontSize, 'fontSize'));
  elements.fontWeight.value = String(normalizeFontWeight(config.fontWeight));
  elements.foreground.value = config.foreground;
  elements.background.value = config.background;
  elements.foregroundHex.textContent = config.foreground;
  elements.backgroundHex.textContent = config.background;

  elements.timestampColor.value = config.timestampColor || '#808080';
  elements.timestampColorHex.textContent = config.timestampColor || '#808080';
  elements.lineNoColor.value = config.lineNoColor || '#67986f';
  elements.lineNoColorHex.textContent = config.lineNoColor || '#67986f';
  const highlightColors = config.highlightColors || {};
  elements.searchHighlightBackground.value = highlightColors.search?.background || '#f5d90a';
  elements.searchHighlightForeground.value = highlightColors.search?.foreground || '#000000';
  elements.filterHighlightBackground.value = highlightColors.filter?.background || '#535353';
  elements.filterHighlightForeground.value = highlightColors.filter?.foreground || '#ffffff';
  elements.selectionHighlightBackground.value = highlightColors.selection?.background || '#073ca8';
  elements.selectionHighlightForeground.value = highlightColors.selection?.foreground || '#ffffff';
  [elements.searchHighlightBackground, elements.searchHighlightForeground, elements.filterHighlightBackground,
    elements.filterHighlightForeground, elements.selectionHighlightBackground, elements.selectionHighlightForeground]
    .forEach(input => document.getElementById(`${input.id}-hex`).textContent = input.value);
  
  elements.scrollbackLimit.value = String(normalizeIntegerSetting(config.scrollbackLimit, 'scrollbackLimit'));
  elements.historyBufferSize.value = String(normalizeIntegerSetting(config.historyBufferSize, 'historyBufferSize'));
  elements.mouseWheelScrollLines.value = String(normalizeIntegerSetting(config.mouseWheelScrollLines, 'mouseWheelScrollLines'));
  elements.mainInputHistoryLimit.value = String(normalizeMainInputHistoryLimit(config.mainInputSettings?.historyLimit));

  const hexDisplaySettings = normalizeHexDisplaySettings(config.hexDisplaySettings);
  elements.hexBytesPerLine.value = String(hexDisplaySettings.bytesPerLine);
  elements.hexShowOffset.checked = hexDisplaySettings.showOffset;
  elements.hexShowAscii.checked = hexDisplaySettings.showAscii;
  elements.hexUppercase.checked = hexDisplaySettings.uppercase;
  elements.hexIdleFlushMs.value = String(hexDisplaySettings.idleFlushMs);

  elements.logEnabled.checked = config.logEnabled;
    elements.saveAllTabsLogToFiles.checked = config.saveAllTabsLogToFiles === true;
    elements.stripAnsiInLog.checked = config.stripAnsiInLog !== false;
  elements.logPath.value = config.logPath;
  elements.logRetentionDays.value = ['0', '7', '30', '60'].includes(String(config.logRetentionDays))
    ? String(config.logRetentionDays)
    : '0';
  elements.logFileNameFormat.value = config.logFileNameFormat;
  elements.logEncoding.value = config.logEncoding;
  elements.logIncludeTimestamp.checked = config.logIncludeTimestamp === true;
  elements.logIncludeLineNumbers.checked = config.logIncludeLineNumbers === true;
  elements.rawBufferAutoFlushMB.value = String(normalizeLogAutoFlushMB(config.rawBufferAutoFlushMB));
  elements.saveRawSerialToFile.checked = config.saveRawSerialToFile === true;
  elements.rawLogFileNameFormat.value = normalizeRawLogFileNameFormat(config.rawLogFileNameFormat);
  elements.telemetryEnabled.checked = config.telemetryEnabled === true;
  
  toggleLogSettings(config.logEnabled);

  renderHighlightRules(config.highlightRules || []);

  shortcutValues = normalizeShortcuts(config.shortcuts);
  renderShortcuts();

  // Load shell profiles
  shellProfiles = Array.isArray(config.shellProfiles) ? JSON.parse(JSON.stringify(config.shellProfiles)) : [];
  defaultShellProfileId = config.defaultShellProfileId || '';
  renderShellProfiles();

  // Load About Info
  try {
      const aboutInfo = await ipcRenderer.invoke('get-about-info');
      const versionEl = document.getElementById('app-version');
      const authorEl = document.getElementById('app-author');
      const githubLink = document.getElementById('app-github');
      const relayRecommendationLink = document.getElementById('relay-recommendation');

      if (versionEl) versionEl.textContent = aboutInfo.version;
      if (authorEl) authorEl.textContent = aboutInfo.author;
      if (githubLink) {
          githubLink.textContent = aboutInfo.github;
          githubLink.onclick = (e) => {
              e.preventDefault();
              shell.openExternal(aboutInfo.github);
          };
      }
      if (relayRecommendationLink) {
          relayRecommendationLink.onclick = (e) => {
              e.preventDefault();
              shell.openExternal('https://lowapi.asdb.top/');
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
    removeBtn.appendChild(createMaterialIcon('delete'));
    removeBtn.style.cssText = 'width: 28px; padding: 0 6px;';
    removeBtn.title = tr('prefs.removeRule');
    removeBtn.onclick = () => {
        if (profile.id === defaultShellProfileId) defaultShellProfileId = '';
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
    browseBtn.appendChild(createMaterialIcon('folder_open'));
    browseBtn.style.cssText = 'width: 28px; padding: 0 6px;';
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
    row3.style.cssText = 'display: flex; gap: 6px; align-items: flex-start;';
    const argsContainer = document.createElement('div');
    argsContainer.style.cssText = 'display: flex; flex: 1; flex-direction: column; gap: 6px;';
    const args = Array.isArray(profile.args) ? profile.args : [];
    shellProfiles[index].args = args;

    const renderArgs = () => {
        argsContainer.innerHTML = '';
        args.forEach((arg, argIndex) => {
            const argRow = document.createElement('div');
            argRow.style.cssText = 'display: flex; gap: 6px;';
            const argsInput = document.createElement('input');
            argsInput.type = 'text';
            argsInput.value = arg;
            argsInput.placeholder = tr('prefs.shellProfileArgsPlaceholder') || 'Argument (e.g. -NoLogo)';
            argsInput.style.cssText = 'flex: 1; font-family: Consolas, monospace; font-size: 12px;';
            argsInput.oninput = () => { args[argIndex] = argsInput.value; };
            const removeArgBtn = document.createElement('button');
            removeArgBtn.className = 'secondary danger';
            removeArgBtn.appendChild(createMaterialIcon('delete'));
            removeArgBtn.style.cssText = 'width: 28px; padding: 0 6px;';
            removeArgBtn.title = tr('prefs.removeRule');
            removeArgBtn.onclick = () => {
                args.splice(argIndex, 1);
                renderArgs();
            };
            argRow.appendChild(argsInput);
            argRow.appendChild(removeArgBtn);
            argsContainer.appendChild(argRow);
        });

        const addArgBtn = document.createElement('button');
        addArgBtn.className = 'secondary';
        addArgBtn.appendChild(createMaterialIcon('add'));
        addArgBtn.style.cssText = 'width: 100%; padding: 2px 8px;';
        addArgBtn.title = tr('prefs.shellProfileArgsPlaceholder') || 'Add argument';
        addArgBtn.onclick = () => {
            args.push('');
            renderArgs();
            argsContainer.children[argsContainer.children.length - 2]?.querySelector('input')?.focus();
        };
        argsContainer.appendChild(addArgBtn);
    };
    renderArgs();
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
    row3.appendChild(argsContainer);
    row3.appendChild(typeSelect);
    card.appendChild(row3);

    // Row 4: Set as default
    const row4 = document.createElement('div');
    row4.style.cssText = 'display: flex; align-items: center; gap: 6px;';
    const defaultCb = document.createElement('input');
    defaultCb.type = 'radio';
    defaultCb.name = 'default-shell-profile';
    defaultCb.value = profile.id || '';
    defaultCb.checked = profile.id === defaultShellProfileId;
    defaultCb.style.cssText = 'margin: 0 4px;';
    defaultCb.onchange = () => {
        if (defaultCb.checked) {
            defaultShellProfileId = profile.id;
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
    shellProfiles.push({ id: randomUUID(), name: '', executable: '', args: [], shellType: 'auto' });
    renderShellProfiles();
    // Scroll to bottom
    if (elements.shellProfilesList) {
        elements.shellProfilesList.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
    }
}

if (elements.addShellProfileBtn) {
    elements.addShellProfileBtn.onclick = addShellProfile;
}

if (elements.resetShortcutsBtn) {
    elements.resetShortcutsBtn.onclick = () => {
        shortcutValues = { ...DEFAULT_SHORTCUTS };
        renderShortcuts();
    };
}

elements.foreground.oninput = (e) => elements.foregroundHex.textContent = e.target.value;
elements.background.oninput = (e) => elements.backgroundHex.textContent = e.target.value;
elements.timestampColor.oninput = (e) => elements.timestampColorHex.textContent = e.target.value;
elements.lineNoColor.oninput = (e) => elements.lineNoColorHex.textContent = e.target.value;
[elements.searchHighlightBackground, elements.searchHighlightForeground, elements.filterHighlightBackground,
  elements.filterHighlightForeground, elements.selectionHighlightBackground, elements.selectionHighlightForeground]
  .forEach(input => input.oninput = () => document.getElementById(`${input.id}-hex`).textContent = input.value);
elements.hexIdleFlushMs.onchange = () => {
    elements.hexIdleFlushMs.value = String(normalizeHexDisplaySettings({
        ...DEFAULT_HEX_DISPLAY_SETTINGS,
        idleFlushMs: elements.hexIdleFlushMs.value
    }).idleFlushMs);
};
elements.rawLogFileNameFormat.onchange = () => {
    elements.rawLogFileNameFormat.value = normalizeRawLogFileNameFormat(elements.rawLogFileNameFormat.value);
};
elements.rawBufferAutoFlushMB.onchange = () => {
    elements.rawBufferAutoFlushMB.value = String(normalizeLogAutoFlushMB(elements.rawBufferAutoFlushMB.value));
};
elements.mainInputHistoryLimit.onchange = () => {
    elements.mainInputHistoryLimit.value = String(normalizeMainInputHistoryLimit(elements.mainInputHistoryLimit.value));
};
[
    [elements.fontSize, 'fontSize'],
    [elements.scrollbackLimit, 'scrollbackLimit'],
    [elements.historyBufferSize, 'historyBufferSize'],
    [elements.mouseWheelScrollLines, 'mouseWheelScrollLines']
].forEach(([element, setting]) => {
    element.onchange = () => {
        element.value = String(normalizeIntegerSetting(element.value, setting));
    };
});

elements.browseBtn.onclick = async () => {
  const path = await ipcRenderer.invoke('select-directory');
  if (path) {
    elements.logPath.value = path;
  }
};

elements.saveBtn.onclick = async () => {
  const rules = [];
  Array.from(elements.highlightRulesList.children).forEach(div => {
      rules.push(div.getRuleData());
  });

  const hexDisplaySettings = normalizeHexDisplaySettings({
      bytesPerLine: elements.hexBytesPerLine.value,
      showOffset: elements.hexShowOffset.checked,
      showAscii: elements.hexShowAscii.checked,
      uppercase: elements.hexUppercase.checked,
      idleFlushMs: elements.hexIdleFlushMs.value
  });
  const rawLogFileNameFormat = normalizeRawLogFileNameFormat(elements.rawLogFileNameFormat.value);
  const existingMainInputSettings = await ipcRenderer.invoke('get-config').then(cfg => cfg.mainInputSettings || {}).catch(() => ({}));

  const config = {
        language: elements.languageSelect.value,
    fontFamily: elements.fontFamily.value,
    fontFamilyZh: elements.fontFamilyZh.value,
    fontSize: normalizeIntegerSetting(elements.fontSize.value, 'fontSize'),
    fontWeight: normalizeFontWeight(elements.fontWeight.value),
    foreground: elements.foreground.value,
    background: elements.background.value,
    timestampColor: elements.timestampColor.value,
    lineNoColor: elements.lineNoColor.value,
    highlightColors: {
      search: { background: elements.searchHighlightBackground.value, foreground: elements.searchHighlightForeground.value },
      filter: { background: elements.filterHighlightBackground.value, foreground: elements.filterHighlightForeground.value },
      selection: { background: elements.selectionHighlightBackground.value, foreground: elements.selectionHighlightForeground.value }
    },
    scrollbackLimit: normalizeIntegerSetting(elements.scrollbackLimit.value, 'scrollbackLimit'),
    historyBufferSize: normalizeIntegerSetting(elements.historyBufferSize.value, 'historyBufferSize'),
    mouseWheelScrollLines: normalizeIntegerSetting(elements.mouseWheelScrollLines.value, 'mouseWheelScrollLines'),
    mainInputSettings: {
        ...existingMainInputSettings,
        historyLimit: normalizeMainInputHistoryLimit(elements.mainInputHistoryLimit.value)
    },
    hexDisplaySettings,
    logEnabled: elements.logEnabled.checked,
    saveAllTabsLogToFiles: elements.saveAllTabsLogToFiles.checked,
    stripAnsiInLog: elements.stripAnsiInLog.checked,
    logPath: elements.logPath.value,
    logRetentionDays: Number(elements.logRetentionDays.value),
    logFileNameFormat: elements.logFileNameFormat.value,
    logEncoding: elements.logEncoding.value,
    logIncludeTimestamp: elements.logIncludeTimestamp.checked,
    logIncludeLineNumbers: elements.logIncludeLineNumbers.checked,
    rawBufferAutoFlushMB: normalizeLogAutoFlushMB(elements.rawBufferAutoFlushMB.value),
    saveRawSerialToFile: elements.saveRawSerialToFile.checked,
    rawLogFileNameFormat,
    telemetryEnabled: elements.telemetryEnabled.checked,
    highlightRules: rules,
    shortcuts: normalizeShortcuts(shortcutValues),
    shellProfiles,
    defaultShellProfileId
  };
  try {
    await ipcRenderer.invoke('save-config-request', config);
    window.close();
  } catch (error) {
    alert(error?.message || String(error));
  }
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
    const withChannel = message => data?.updateChannel
        ? `${message} ${tr('updateDialog.updateChannel')}: ${data.updateChannel}`
        : message;

    switch (status) {
        case 'checking':
            statusEl.textContent = tr('prefs.checkingForUpdates');
            checkBtn.disabled = true;
            if (progressEl) progressEl.style.display = 'none';
            if (restartBtn) restartBtn.style.display = 'none';
            break;
        case 'available':
            statusEl.textContent = withChannel(tr('prefs.updateAvailableManual', { version: data.version }));
            statusEl.style.color = 'var(--accent-color)';
            if (progressEl) progressEl.style.display = 'none';
            checkBtn.disabled = false;
            break;
        case 'not-available':
            statusEl.textContent = withChannel(tr('prefs.latestVersion'));
            statusEl.style.color = 'var(--text-secondary)';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'error':
            if (data && (data.includes('504') || data.includes('Cannot download') || data.includes('net::ERR_'))) {
                statusEl.innerHTML = `${tr('prefs.updateFailedNetwork')} <a href="#" id="manual-dl-link" style="color: var(--accent-color); text-decoration: underline; cursor: pointer;">${tr('updateDialog.manualDownload')}</a>`;
                document.getElementById('manual-dl-link').onclick = (e) => {
                    e.preventDefault();
                    shell.openExternal('https://gitee.com/trigger-cn/SerialTerminal/releases');
                };
            } else {
                statusEl.textContent = tr('prefs.error', { message: data });
            }
            statusEl.style.color = '#ff4444';
            checkBtn.disabled = false;
            if (progressEl) progressEl.style.display = 'none';
            break;
        case 'download-progress':
            statusEl.textContent = withChannel(tr('prefs.downloading', { percent: Math.round(data.percent) }));
            if (fillEl) fillEl.style.width = `${data.percent}%`;
            break;
        case 'downloaded':
            statusEl.textContent = withChannel(tr('prefs.updateDownloaded', { version: data.version }));
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

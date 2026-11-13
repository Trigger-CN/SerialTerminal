'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('main terminal tab uses only the renderer click binding', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const mainTab = html.match(/<button class="main-tab active"[^>]*data-target="tab-main"[^>]*>/)?.[0] || '';

  assert.ok(mainTab, 'main terminal tab markup was not found');
  assert.doesNotMatch(mainTab, /\sonclick=/);
  assert.doesNotMatch(html, /function\s+switchMainTab\s*\(/);
  assert.equal((renderer.match(/mainTabButton\.addEventListener\('click'/g) || []).length, 1);
});

test('main window title shows the installed version and available update', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(html, /<title>SerialTerminal by Trigger-CN<\/title>/);
  assert.match(main, /MAIN_WINDOW_TITLE = 'SerialTerminal by Trigger-CN'/);
  assert.match(main, /return `\$\{MAIN_WINDOW_TITLE\} \$\{currentVersion\}\$\{updateSuffix\}`/);
  assert.match(main, /` 有新版本：\$\{latestVersion\}`/);
  assert.match(main, /title: getMainWindowTitle\(\)/);
  assert.doesNotMatch(renderer, /document\.title\s*=/);
  assert.doesNotMatch(html, /<title[^>]*data-i18n=/);
});

test('Windows windows and installers use the multi-size application icon', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.match(main, /APP_ICON_PATH = path\.join\(__dirname, 'assets', process\.platform === 'win32' \? 'app\.ico' : 'icon-512x512\.png'\)/);
  assert.match(main, /app\.setAppUserModelId\('com\.serialterminal\.app'\)/);
  assert.equal((main.match(/icon: APP_ICON_PATH/g) || []).length, 3);
  assert.equal(packageJson.build.win.icon, 'assets/app.ico');
  assert.equal(packageJson.build.nsis.installerIcon, 'assets/app.ico');
  assert.equal(packageJson.build.nsis.uninstallerIcon, 'assets/app.ico');
  assert.equal(packageJson.build.nsis.installerHeaderIcon, 'assets/app.ico');
});

test('tabs and footer actions expose keyboard-accessible semantics', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const sidebarTabs = [...html.matchAll(/<button class="sidebar-tab[^>]*>/g)].map(match => match[0]);

  assert.equal(sidebarTabs.length, 3);
  sidebarTabs.forEach(tab => {
    assert.match(tab, /type="button"/);
    assert.match(tab, /role="tab"/);
    assert.match(tab, /aria-controls="tab-[^"]+"/);
    assert.match(tab, /aria-selected="(?:true|false)"/);
    assert.doesNotMatch(tab, /onclick=/);
  });
  ['open-prefs', 'toggle-main-input', 'toggle-shell-sidebar'].forEach(id => {
    const action = html.match(new RegExp(`<button id="${id}"[^>]*>`))?.[0] || '';
    assert.match(action, /type="button"/);
    assert.match(action, /aria-label=/);
  });
  assert.match(renderer, /createElement\('button'\)/);
  assert.match(renderer, /setAttribute\('aria-selected', 'false'\)/);
  assert.match(styles, /button:focus-visible/);
});

test('toggling the main input panel refits workspace terminals', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const setVisibility = renderer.match(/function setMainInputPanelVisible\(visible, persist = true\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(setVisibility, /mainInputPanel\.classList\.toggle\('hidden', !visible\)/);
  assert.match(setVisibility, /fitWorkspaceTerminals\(\)/);
});

test('shell profile management opens the matching preferences tab', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /send\('open-prefs', \{ focusTab: 'shell-profiles' \}\)/);
  assert.match(main, /createPrefsWindow\(typeof options\.focusTab === 'string' \? options\.focusTab : null\)/);
  assert.match(main, /send\('focus-preferences-tab', focusTab\)/);
  assert.match(main, /prefsWindow = new BrowserWindow\(\{\s*width: 750,\s*height: 680,/);
  assert.match(preferences, /ipcRenderer\.on\('focus-preferences-tab'/);
  assert.match(preferences, /focusPreferencesTab\(tabId\)/);
});

test('shell profile buttons pass the configured name to new shell tabs', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /createShellTab\(\{ profileId: profile\.id, title: profile\.name \}/);
  assert.match(renderer, /profile\?\.name\?\.trim\(\) \|\| tr\('main\.shellTitle'/);
});

test('right sidebar manages persistent quick commands for the active Shell tab', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  const shellSidebar = html.match(/<!-- Right Shell Sidebar -->[\s\S]*?<div id="shell-quick-command-dialog"/)?.[0] || '';
  assert.match(shellSidebar, /id="shell-quick-command-list"[^>]*role="list"/);
  assert.match(shellSidebar, /id="shell-quick-command-add"[^>]*data-i18n-title="main\.addShellQuickCommand"[^>]*data-i18n-aria-label="main\.addShellQuickCommand"/);
  assert.doesNotMatch(shellSidebar, /shell-session-list|activeShellSessions|noActiveShellSessions/);
  assert.match(html, /id="shell-quick-command-dialog"[\s\S]*aria-labelledby="shell-quick-command-dialog-title"/);
  assert.match(html, /id="shell-quick-command-append-enter" checked/);
  // 配置版本号已由 serial-groups-config.js 统一提供（v14 → v15），不再硬编码在 main.js。
  assert.match(main, /const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION/);
  assert.match(main, /normalized\.shellQuickCommands = Array\.isArray\(source\.shellQuickCommands\)/);
  assert.match(main, /shellQuickCommands: \[\]/);
  assert.match(renderer, /function getActiveShellTab\(\)[\s\S]*getActiveTabInfo\(\)[\s\S]*shellTabs\.find/);
  assert.match(renderer, /if \(!shellTab\.sessionReady\)/);
  assert.match(renderer, /const data = `\$\{item\.command\}\$\{item\.appendEnter \? '\\r' : ''\}`/);
  assert.match(renderer, /ipcRenderer\.send\('shell-tab-input', \{ tabId: shellTab\.id, data \}\)/);
  assert.match(renderer, /shellQuickCommands: shellQuickCommands\.map\(normalizeShellQuickCommand\)/);
  assert.doesNotMatch(renderer, /shellSessionList|addShellSessionItem|setActiveShellSessionItem/);
  assert.match(styles, /\.shell-quick-command-item\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto;/s);
});

test('about tab opens the relay recommendation externally with amber styling', () => {
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(html, /class="about-label relay-recommendation-label">高性价比中转站优选<\/span>/);
  assert.match(html, /id="relay-recommendation">https:\/\/lowapi\.asdb\.top\/<\/a>/);
  assert.match(html, /\.relay-recommendation-label\s*\{[^}]*color:\s*#f5b942;/s);
  assert.match(preferences, /shell\.openExternal\('https:\/\/lowapi\.asdb\.top\/'\)/);
});

test('collapsed sidebar scrolls only quick sends above fixed serial tools', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const toolbar = html.match(/<div class="sidebar-collapsed-toolbar"[\s\S]*?<\/div>\s*<!-- Persistent Header -->/)?.[0] || '';
  const scrollStart = toolbar.indexOf('class="sidebar-quick-send-scroll"');
  const quickListIndex = toolbar.indexOf('id="sidebar-quick-send-list"');
  const fixedToolsIndex = toolbar.indexOf('class="sidebar-fixed-tools"');
  const connectIndex = toolbar.indexOf('id="sidebar-connect-btn"');
  const expandIndex = toolbar.indexOf('id="sidebar-expand-btn"');

  assert.ok(scrollStart >= 0 && quickListIndex > scrollStart, 'quick-send scroll region was not found');
  assert.ok(fixedToolsIndex > quickListIndex && connectIndex > fixedToolsIndex, 'fixed serial tools must follow quick sends');
  assert.ok(expandIndex > connectIndex, 'expand button must remain outside both tool regions');
  assert.match(styles, /\.sidebar-quick-send-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.sidebar-quick-send-scroll\s*\{[^}]*width:\s*40px;/s);
  assert.match(styles, /\.sidebar-quick-send-list\s*\{[^}]*width:\s*40px;/s);
  assert.doesNotMatch(styles, /\.sidebar-fixed-tools\s*\{[^}]*overflow-y:/s);
  assert.match(styles, /\.sidebar-tool-btn#sidebar-expand-btn\s*\{[^}]*flex-shrink:\s*0;[^}]*margin-top:\s*8px;/s);
  assert.equal((toolbar.match(/data-material-icon=/g) || []).length, 6);
  assert.doesNotMatch(toolbar, /<svg\b/);
  assert.match(styles, /\.sidebar-tool-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*fill:\s*currentColor;/s);
});

test('expanded sidebar clears serial logs and includes Shell only when configured', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /class="sidebar-clear-actions"[\s\S]*id="clear-btn"[\s\S]*id="clear-all-logs-btn"/);
  assert.match(html, /id="clear-all-logs-btn"[^>]*data-i18n-title="main\.clearAllLogs"[^>]*data-i18n-aria-label="main\.clearAllLogs"/);
  assert.match(styles, /\.sidebar-clear-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 34px;/s);
  const clearAllLogTabs = renderer.match(/function clearAllLogTabs\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  // 清理范围必须按分组展开：每个分组都有自己的主标签与过滤页。
  // 原先断言写死的 'tab-main' 与模块级 filterTabs 只能覆盖一个分组，
  // 而按钮名字承诺的是「所有 Log 标签页」——这是实现修正，不是放宽断言。
  assert.match(clearAllLogTabs, /serialGroups\.forEach\(group => \{/);
  assert.match(clearAllLogTabs, /clearTerminalByTabId\(mainTabId\(group\.id\)\)/);
  assert.match(clearAllLogTabs, /filterTabsStore\.getList\(group\.id\)\.forEach\(tab => clearTerminalByTabId\(tab\.id\)\)/);
  assert.match(clearAllLogTabs, /currentConfig\?\.clearAllLogsIncludesShell === true/);
  assert.match(clearAllLogTabs, /shellTabs\.forEach\(tab => clearTerminalByTabId\(tab\.id\)\)/);
  assert.match(renderer, /clearAllLogsBtn\?\.addEventListener\('click', clearAllLogTabs\)/);
});

test('preferences persist the optional Shell clear and automatic log scopes', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(main, /const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION/);
  assert.match(main, /clearAllLogsIncludesShell: false/);
  assert.match(main, /saveShellTabsLogToFiles: false/);
  assert.match(main, /normalized\.clearAllLogsIncludesShell = normalizeBoolean\(source\.clearAllLogsIncludesShell, false\)/);
  assert.match(main, /normalized\.saveShellTabsLogToFiles = normalizeBoolean\(source\.saveShellTabsLogToFiles, false\)/);
  assert.match(html, /id="clearAllLogsIncludesShell"[\s\S]*?data-i18n="prefs\.clearAllLogsIncludesShell"/);
  assert.match(html, /id="saveShellTabsLogToFiles"[\s\S]*?data-i18n="prefs\.saveShellTabsLogToFiles"/);
  assert.match(preferences, /elements\.saveShellTabsLogToFiles\.disabled = !elements\.saveAllTabsLogToFiles\.checked/);
  assert.match(preferences, /elements\.saveAllTabsLogToFiles\.onchange = toggleShellLogSetting/);
  assert.match(preferences, /elements\.clearAllLogsIncludesShell\.checked = config\.clearAllLogsIncludesShell === true/);
  assert.match(preferences, /elements\.saveShellTabsLogToFiles\.checked = config\.saveShellTabsLogToFiles === true/);
  assert.match(preferences, /clearAllLogsIncludesShell: elements\.clearAllLogsIncludesShell\.checked/);
  assert.match(preferences, /saveShellTabsLogToFiles: elements\.saveShellTabsLogToFiles\.checked/);
});
test('sent data echo is configurable and available from both settings surfaces', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const prefsHtml = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(main, /echoSentData: true,/);
  assert.match(main, /echoSentDataBothFormats: false,/);
  assert.match(main, /echoSentDataInFilterTabs: true,/);
  assert.match(main, /echoSentDataHighlightColor: '#1e3a5f'/);
  assert.match(main, /normalized\.echoSentData = normalizeBoolean\(source\.echoSentData, true\)/);
  assert.match(main, /normalized\.echoSentDataHighlightColor = HEX_COLOR_PATTERN\.test/);

  // 左侧设置 tab 的三个开关。
  assert.match(html, /id="echo-sent-data"[\s\S]*?data-i18n="main\.echoSentData"/);
  assert.match(html, /id="echo-sent-data-both"[\s\S]*?data-i18n="main\.echoSentDataBoth"/);
  assert.match(html, /id="echo-sent-data-filter"[\s\S]*?data-i18n="main\.echoSentDataFilter"/);

  // 偏好设置窗口的三个开关，与左侧栏共享同一组配置键。
  assert.match(prefsHtml, /id="echoSentData"[\s\S]*?data-i18n="prefs\.echoSentData"/);
  assert.match(prefsHtml, /id="echoSentDataBothFormats"[\s\S]*?data-i18n="prefs\.echoSentDataBothFormats"/);
  assert.match(prefsHtml, /id="echoSentDataInFilterTabs"[\s\S]*?data-i18n="prefs\.echoSentDataInFilterTabs"/);
  assert.match(preferences, /echoSentData: elements\.echoSentData\.checked/);
  assert.match(preferences, /echoSentDataBothFormats: elements\.echoSentDataBothFormats\.checked/);
  assert.match(preferences, /echoSentDataInFilterTabs: elements\.echoSentDataInFilterTabs\.checked/);

  // 左侧栏开关变化时立即生效并持久化。
  //
  // 这五项的前缀/回显现在要先看"作用域"：全局共享时写顶层键（与改造前完全一致），
  // 每组独立时写 serialGroups[i].uiPrefs。三个 change 处理器因此改为走统一的
  // applyDisplayPrefChange(field, value)，由它根据作用域选择持久化目标。
  // 断言也因此改为验证"立即生效 + 持久化"这件事本身，而不是旧的某一行字面量：
  // 直写字面量会把持久化分支写死成只有全局一种。
  assert.match(renderer, /function applyDisplayPrefChange\(field, value\) \{[\s\S]*?setGroupDisplayPrefs\(groupId, \{ \[field\]: value \}\)[\s\S]*?ipcRenderer\.send\('update-display-settings', \{ \[field\]: next\[field\] \}\)/);
  assert.match(renderer, /echoSentDataCb\?\.addEventListener\('change'[\s\S]*?applyDisplayPrefChange\('echoSentData', e\.target\.checked\)/);
  assert.match(renderer, /echoSentDataBothCb\?\.addEventListener\('change'[\s\S]*?applyDisplayPrefChange\('echoSentDataBothFormats', e\.target\.checked\)/);
  assert.match(renderer, /echoSentDataFilterCb\?\.addEventListener\('change'[\s\S]*?applyDisplayPrefChange\('echoSentDataInFilterTabs', e\.target\.checked\)/);
  // 每组独立时必须把分组级副本落盘，否则重启即丢。
  assert.match(renderer, /displayPrefScope === DISPLAY_PREF_SCOPES\.PER_GROUP\) \{[\s\S]*?persistSerialGroups\(\)/);
});

test('sidebar settings group receive and send items under labelled sections', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  // 两个带标题的分组。
  assert.match(html, /<section class="settings-section" aria-labelledby="settings-receive-title">/);
  assert.match(html, /id="settings-receive-title" class="settings-section-title" data-i18n="main\.receiveSettings"/);
  assert.match(html, /<section class="settings-section" aria-labelledby="settings-send-title">/);
  assert.match(html, /id="settings-send-title" class="settings-section-title" data-i18n="main\.sendSettings"/);

  // 接收组内：接收模式/编码 + 显示时间、行号；不得混入发送项。
  const receiveSection = html.match(/aria-labelledby="settings-receive-title"[\s\S]*?<\/section>/)[0];
  assert.match(receiveSection, /id="receive-mode-select"/);
  assert.match(receiveSection, /id="receive-encoding-select"/);
  assert.match(receiveSection, /id="show-timestamp"/);
  assert.match(receiveSection, /id="show-lineno"/);
  assert.doesNotMatch(receiveSection, /id="send-encoding-select"/);
  assert.doesNotMatch(receiveSection, /id="echo-sent-data"/);

  // 发送组内：发送编码 + 发送回显三开关；不得混入接收项。
  const sendSection = html.match(/aria-labelledby="settings-send-title"[\s\S]*?<\/section>/)[0];
  assert.match(sendSection, /id="send-encoding-select"/);
  assert.match(sendSection, /id="echo-sent-data"/);
  assert.match(sendSection, /id="echo-sent-data-both"/);
  assert.match(sendSection, /id="echo-sent-data-filter"/);
  assert.doesNotMatch(sendSection, /id="receive-mode-select"/);
  assert.doesNotMatch(sendSection, /id="show-timestamp"/);

  // 分组容器保留原有样式类，保证主题与间距不依赖新选择器。
  assert.match(css, /\.settings-section-title \{[\s\S]*?text-transform: uppercase;/);
  assert.match(receiveSection, /class="settings-group"/);
  assert.match(sendSection, /class="settings-group"/);
});

test('sent records render as a single highlighted line and never touch the RX parser', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  // 整行背景：写前缀色 → 内容 → SGR 复位 → 整行换行。
  // 回显必须写进“该条发送所属分组”的终端与日志：改造后函数多了一个 groupId 参数，
  // 终端从运行时注册表取，日志调用必须把同一个 groupId 传下去。
  assert.match(renderer, /function renderSentRecord\(record, groupId = REGISTRY_DEFAULT_GROUP_ID\) \{[\s\S]*?hexToAnsiBackground\(echoSentDataHighlightColor\)/);
  assert.match(renderer, /const runtime = serialRuntimes\.get\(id\);[\s\S]*?writeTerminalOutput\(runtime\.term, `\$\{bg\}\$\{body\}\\x1b\[0m\\r\\n`\)/);
  assert.match(renderer, /writeMainTabLog\(`\$\{body\}\\r\\n`, id\)/);

  // 回显不得进入接收解析器，也不得占用接收行号计数器；只检查函数体自身，避免跨函数误判。
  const sentBody = renderer.match(/function renderSentRecord\(record, groupId = REGISTRY_DEFAULT_GROUP_ID\) \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(sentBody, /dataParser\.parse/);
  assert.doesNotMatch(sentBody, /serialLineCounter/);
  assert.doesNotMatch(sentBody, /processQuickSendAutoTriggers/);

  // 仅在实际写入成功后回显。
  assert.match(renderer, /if \(result\.ok\) \{\s*renderSentRecord\(\{/);

  // 开启“追加 CRLF”时，回显文本必须包含那 2 字节，与 header 中的字节数自洽。
  assert.match(renderer, /text: profileRequest\.mode === 'text'\s*\? `\$\{profileRequest\.content\}\$\{profileRequest\.appendCrLf \? '\\r\\n' : ''\}`/);
});

test('filter tabs can show sent data only and persist the choice', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  assert.match(renderer, /class="filter-toggle-btn filter-sent-only-btn"[\s\S]*?main\.showSentOnly/);
  assert.match(renderer, /function applySentOnlyMode\(enabled\) \{[\s\S]*?tabState\.showSentOnly = enabled;/);
  assert.match(renderer, /sentOnlyBtn\.onclick = \(e\) => \{[\s\S]*?applySentOnlyMode\(!tabState\.showSentOnly\)/);

  // 开启后接收路径必须跳过该标签页，否则发送历史会被接收内容冲淡。
  assert.match(renderer, /if \(tab\.showSentOnly === true \|\| tab\.dataMode !== 'text'\) return;/);
  assert.match(renderer, /if \(tab\.showSentOnly === true \|\| tab\.dataMode !== 'hex'\) return;/);

  assert.match(renderer, /showSentOnly: tab\.showSentOnly === true,/);
  assert.match(main, /showSentOnly: normalizeBoolean\(tab\.showSentOnly, false\)/);
});


test('custom baud rates are normalized, persisted, and restored as reusable options', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(main, /const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION/);
  assert.match(main, /customBaudRates: \[\]/);
  assert.match(main, /normalized\.customBaudRates = normalizeCustomBaudRates/);
  assert.match(main, /!isStandardBaudRate\(lastBaudRate\)/);
  assert.match(html, /option value="custom" data-i18n="main\.addCustomBaudRate"/);
  assert.match(html, /id="baud-custom-input"[^>]*min="1"[^>]*step="1"/);
  assert.match(html, /id="baud-custom-confirm"[^>]*data-i18n-title="main\.confirmCustomBaudRate"/);
  assert.match(renderer, /function renderCustomBaudRates\(customBaudRates, selectedBaudRate\)/);
  assert.match(renderer, /function restoreBaudRateConfig\(config\)/);
  assert.match(renderer, /function confirmCustomBaudRate\(\)/);
  assert.match(renderer, /ipcRenderer\.send\('save-config', \{ lastSerialOptions, customBaudRates \}\)/);
  assert.match(renderer, /baudCustomInput\.addEventListener\('keydown'/);
  assert.doesNotMatch(renderer, /baudCustomInput\.addEventListener\('(?:change|blur)'/);
});

test('sending text can auto-scroll the main terminal to the bottom', () => {
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(main, /scrollToBottomOnSend: true/);
  assert.match(main, /normalized\.scrollToBottomOnSend = normalizeBoolean\(source\.scrollToBottomOnSend, true\)/);
  assert.match(html, /id="scrollToBottomOnSend"[\s\S]*?data-i18n="prefs\.scrollToBottomOnSend"/);
  assert.match(preferences, /scrollToBottomOnSend: document\.getElementById\('scrollToBottomOnSend'\)/);
  assert.match(preferences, /elements\.scrollToBottomOnSend\.checked = config\.scrollToBottomOnSend !== false/);
  assert.match(preferences, /scrollToBottomOnSend: elements\.scrollToBottomOnSend\.checked/);
  assert.match(renderer, /let scrollToBottomOnSend = true/);
  assert.match(renderer, /scrollToBottomOnSend = config\.scrollToBottomOnSend !== false/);
});


test('serial output is batched per animation frame before terminal rendering', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  // 队列改为按 groupId 分桶后，函数签名多了一个带默认值的 groupId。
  // 默认值必须保留：单分组行为要与改造前逐字节一致。
  assert.match(renderer, /function queueSerialOutput\(bytes, groupId = REGISTRY_DEFAULT_GROUP_ID\)/);
  assert.match(renderer, /const SERIAL_OUTPUT_MAX_FPS = 30/);
  assert.match(renderer, /SERIAL_OUTPUT_FRAME_MS - \(performance\.now\(\) - lastSerialOutputFlushAt\)/);
  assert.match(renderer, /setTimeout\(\(\) => \{[\s\S]*requestAnimationFrame\(flushSerialOutputQueue\)/);
  // 分桶层自己负责每桶的 Buffer.concat；这里断言渲染层消费的是 drain() 的批次，
  // 且**不再**把整个队列一次 concat —— 那样就把两个分组的字节拼成一批了。
  assert.match(renderer, /for \(const batch of serialOutputBuckets\.drain\(\)\) \{\s*dispatchSerialBatch\(batch\.groupId, batch\.buffer\);/);
  assert.doesNotMatch(renderer, /const bytes = Buffer\.concat\(queued\)/);
  assert.match(renderer, /const buffer = Buffer\.from\(bytes\.buffer, bytes\.byteOffset, bytes\.byteLength\)[\s\S]*?queueSerialOutput\(buffer, groupId\)/);
  assert.match(main, /function queueSerialOutput\(session, data, sessionId\)/);
  assert.match(main, /setImmediate\(flushSerialOutputQueue\)/);
  assert.match(main, /Buffer\.concat\(entries\.map\(entry => entry\.data\), byteCount\)/);
  assert.match(main, /queueSerialOutput\(session, data, connectionSessionId\)/);
  assert.match(renderer, /function flushPendingSerialOutput\(\)/);
  // P4：比较基准从模块级 receiveDisplayMode 改为本分组切换前的值 previous，
  // 否则非默认分组的切换会拿默认分组的值做比较。两条不变量依然成立：
  // 先 flush 待处理输出，再判断是否需要真正切换。
  assert.match(renderer, /const previous = getGroupDisplay\(id\)\.receiveDisplayMode;[\s\S]*?flushPendingSerialOutput\(\);\s*if \(normalized !== previous\)/);
  // 日志写入必须把 groupId 透传给主进程：否则所有分组的主终端日志都会落进默认端口目录。
  assert.match(renderer, /ipcRenderer\.send\('write-tab-log', \{ tabId, title, data, groupId: resolveSerialGroupId\(groupId\) \}\)/);
  assert.match(main, /writeTabLog\(payload\.tabId, payload\.title, payload\.data, payload\.groupId\)/);
  assert.match(renderer, /const highlighted = applyHighlighting\(text, tab\.filterRegex, globalMatches\);[\s\S]*terminal:[\s\S]*log:/);
  assert.match(renderer, /function collectGlobalHighlightMatches\(text\)/);
  assert.match(renderer, /applyHighlighting\(text, tab\.filterRegex, globalMatches\)/);
  assert.match(renderer, /applyHighlighting\(line\.text, null, globalMatches\)/);
  assert.doesNotMatch(renderer, /formatLineForTerminal\(line, tab\.filterRegex\)/);
  assert.doesNotMatch(renderer, /formatLineForLog\(line, prefix, tab\.filterRegex\)/);
  assert.doesNotMatch(renderer, /matched\.map\(\(\{ text, logPrefix \}\) => `\$\{logPrefix\}\$\{applyHighlighting/);
});

test('terminal buffers use bounded defaults and reset fully when cleared', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preferencesHtml = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  assert.match(main, /const CONFIG_VERSION = SERIAL_GROUPS_CONFIG_VERSION/);
  assert.match(main, /source\.scrollbackLimit === 100000[\s\S]*?\? 20000/);
  assert.doesNotMatch(renderer, /scrollback:\s*100000/);
  // 主串口终端的构造已收进 `buildSerialTerminalOptions()` 模板，默认与后续分组共用同一份。
  // 断言目标从「某一行字面量」改成「模板本身」：因为模板才是唯一的真相源，
  // 若只看某次 new，后续分组用的模板未被约束时就会漏掉。
  //
  // 模板签名从空括号改成 `(config = currentConfig)`：新建分组的终端必须拿到设置里的
  // 字体/主题，而默认分组是模块加载期建的（那时 config 还是 null），所以模板必须能
  // 接受一个可缺省的 config。这两条一起把「模板必须带字体」变成可回归的事实——
  // 只约束 scrollback 的话，把字体字段删掉测试也不会红。
  assert.match(renderer, /function buildSerialTerminalOptions\(config = currentConfig\) \{[\s\S]*?scrollback:\s*config\.scrollbackLimit \|\| 20000/);
  assert.match(renderer, /function buildSerialTerminalOptions\(config = currentConfig\) \{[\s\S]*?fontFamily:\s*TERMINAL_FONT_FAMILY\(config\)/);
  assert.match(renderer, /function buildSerialTerminalOptions\(config = currentConfig\) \{[\s\S]*?theme:\s*getTerminalTheme\(config\)/);
  assert.match(renderer, /function createSerialRuntime\(groupId\)[\s\S]*?new Terminal\(buildSerialTerminalOptions\(\)\)/);
  // 清空必须清到“该 tabId 对应分组”的终端上：改造后终端不再是一个模块级常量，
  // 而是按 groupId 从运行时注册表取。
  assert.match(renderer, /function clearTerminalByTabId[\s\S]*?clearTerminalOutput\(getSerialTerm\(groupId\)\)/);
  assert.match(renderer, /clearTerminalOutput\(filterTab\.term\)/);
  assert.match(renderer, /const SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES = 1024 \* 1024/);
  // 水位判断下沉到分桶层，按分组各自评估；渲染层只负责响应 shouldFlush。
  assert.match(renderer, /if \(result\.shouldFlush\) \{\s*flushPendingSerialOutput\(\);\s*return;\s*\}/);
  assert.match(preferencesHtml, /id="scrollbackLimit" min="1000" max="100000"/);
  // 终端待写入缓冲以回滚行数为主上限，字节硬上限仅作为内存兑底。
  assert.match(renderer, /const TERMINAL_PENDING_OUTPUT_HARD_LIMIT = 32 \* 1024 \* 1024/);
  assert.match(renderer, /function getTerminalPendingLineLimit\(\) \{[\s\S]*?scrollbackLimit[\s\S]*?\? limit : 20000/);
  assert.match(renderer, /function writeTerminalOutput\(term, output\)/);
  assert.match(renderer, /term\.write\(output, \(\) => \{/);
  assert.match(renderer, /const dropped = appendPendingOutput\(state, output, \{[\s\S]*?maxLines: getTerminalPendingLineLimit\(\),[\s\S]*?maxBytes: TERMINAL_PENDING_OUTPUT_HARD_LIMIT/);
  assert.match(renderer, /if \(dropped > 0\) state\.skipped = true;/);
  // 单次写入按字节预算分批，并在 write 回调里让出一轮事件循环，避免恢复时巨型解析冻结界面。
  assert.match(renderer, /const TERMINAL_WRITE_BATCH_BYTES = 512 \* 1024/);
  assert.match(renderer, /const chunk = takePendingChunk\(state, TERMINAL_WRITE_BATCH_BYTES\)/);
  assert.match(renderer, /if \(state\.pending\.length\) scheduleTerminalDrain\(term, state\)/);
  assert.match(renderer, /function scheduleTerminalDrain\(term, state\) \{[\s\S]*?setTimeout\(\s*\(\) => \{[\s\S]*?drainTerminalOutput\(term, state\)/);
  assert.match(renderer, /Display output skipped to limit memory usage/);
  assert.match(renderer, /state\.resetAfterWrite = state\.writing/);
  assert.match(renderer, /if \(state\.resetAfterWrite\) \{[\s\S]*term\.reset\(\)/);
  // 主终端写入必须走“该分组的运行时”，不能再写死模块级的 serialTerm。
  assert.match(renderer, /writeTerminalOutput\(runtime\.term, mainOutput\)/);
  assert.match(renderer, /writeTerminalOutput\(tab\.term, output\)/);
});

test('anonymous activity statistics default to enabled and exclude server code from builds', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const releaseWorkflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.match(main, /telemetryEnabled: true/);
  assert.match(main, /normalized\.telemetryEnabled = normalizeBoolean\(source\.telemetryEnabled, true\)/);
  assert.match(main, /telemetryReporter\.configure\(currentConfig\)/);
  assert.match(main, /if \(!app\.isPackaged\) return false/);
  assert.match(main, /releaseVersion === app\.getVersion\(\)/);
  assert.match(releaseWorkflow, /printf '%s\\n' "\$\{GITHUB_REF_NAME#v\}" > release-build\.txt/);
  assert.match(main, /telemetryReporter\.stop\(\)/);
  assert.match(preferences, /id="telemetryEnabled"/);
  assert.ok(packageJson.build.files.includes('!telemetry-server/**'));
});

test('filter tabs locate exact logical lines in the main terminal', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /function getLogicalTerminalBufferLine\(buffer, lineIndex\)/);
  assert.match(renderer, /while \(start > 0 && buffer\.getLine\(start\)\?\.isWrapped\) start--/);
  assert.match(renderer, /line\.translateToString\(index === end\)/);
  assert.match(renderer, /occurrenceFromEnd: countLogicalLineOccurrencesAfter\(buffer, line\)/);
  assert.match(renderer, /function locateInMainTerminal\(context\)/);
  assert.match(renderer, /line\.text === context\.text && --remainingOccurrence === 0/);
  assert.match(renderer, /serialTerm\.scrollToLine\(match\.start\)/);
  assert.match(renderer, /serialTerm\.selectLines\(match\.start, match\.end\)/);
  assert.doesNotMatch(renderer, /locateInMainTerminalByLineNumber/);
});

test('collapsed quick-send shortcuts persist an independent order', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="sidebar-quick-send-list"[^>]*role="list"/);
  assert.match(html, /id="quick-send-sidebar-enable"/);
  assert.match(html, /id="quick-send-sidebar-text"/);
  assert.match(html, /id="quick-send-sidebar-color"/);
  assert.match(main, /sidebarShortcut: \{[\s\S]*enabled: normalizeBoolean\(item\.sidebarShortcut\?\.enabled/);
  assert.match(main, /normalized\.sidebarQuickSendOrder = Array\.isArray\(source\.sidebarQuickSendOrder\)/);
  assert.match(main, /normalized\.quickSendGroups = Array\.isArray\(source\.quickSendGroups\)/);
  assert.match(main, /normalized\.quickSendUngroupedCollapsed = normalizeBoolean\(source\.quickSendUngroupedCollapsed, false\)/);
  assert.match(main, /groupId: typeof item\.groupId === 'string' && usedQuickGroupIds\.has\(item\.groupId\) \? item\.groupId : null/);
  assert.match(renderer, /function renderQuickSendLists\(\)/);
  assert.match(renderer, /quickSendGroups: quickSendGroups\.map\(normalizeQuickSendGroup\)/);
  assert.match(renderer, /quickSendGroups = moveQuickSendGroup\(quickSendGroups, groupId, insertionIndex\)/);
  assert.match(renderer, /quickSendListEl\.addEventListener\('drop'/);
  assert.match(renderer, /quickSendUngroupedCollapsed,/);
  assert.match(renderer, /const currentCollapsed = group[\s\S]*?section\.classList\.contains\('collapsed'\)/);
  assert.doesNotMatch(renderer, /setQuickSendGroupCollapsed\(groupId, !collapsed\)/);
  assert.doesNotMatch(renderer, /window\.prompt\(/);
  assert.match(renderer, /renderQuickSendContainer\(quickSendListEl\)/);
  assert.match(renderer, /renderQuickSendContainer\(sidebarQuickSendListEl, true\)/);
  assert.match(renderer, /function applyQuickSendElementOrder\(context, orderedIds\)/);
  assert.match(renderer, /sidebarQuickSendOrder = \[\.\.\.orderedIds\]/);
  assert.match(renderer, /groupId: element\.closest\('\.quick-send-group'\)\?\.dataset\.quickGroupId \|\| null/);
  assert.match(renderer, /function beginQuickSendPointer\(context, event, element\)/);
  assert.match(renderer, /function handleQuickSendPointerMove\(event\)/);
  assert.match(renderer, /function handleQuickSendPointerUp\(event\)/);
  assert.match(renderer, /targetRect\.width === 0 \|\| targetRect\.height === 0[\s\S]*?cleanUpQuickSendDrag\(context, state\);\s*renderQuickSendLists\(\)/);
  assert.match(renderer, /quickSendList: quickSendList\.map\(normalizeQuickSendItem\),\s*sidebarQuickSendOrder/s);
  assert.match(renderer, /element\.animate\(\[\{ transform: `translateY\(\$\{offset\}px\)` \}/);
  assert.match(styles, /\.quick-send-item-compact\s*\{[^}]*width:\s*36px;[^}]*min-height:\s*36px;/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*display:\s*block;[^}]*max-height:\s*32px;/s);
  assert.doesNotMatch(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*-webkit-line-clamp:/s);
  assert.match(renderer, /compact \? 'quick-send-main-btn sidebar-tool-btn' : 'quick-send-main-btn'/);
  assert.match(styles, /\.quick-send-item-compact\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*flex:\s*0 0 36px;/s);
  assert.match(styles, /\.quick-send-main-btn:hover::before\s*\{[^}]*opacity:\s*0\.28;/s);
  assert.match(styles, /\.quick-send-label\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.quick-send-main-btn\s*\{[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s);
  assert.match(styles, /\.quick-send-main-btn\s*\{[^}]*transition:\s*transform 0\.12s ease;/s);
  assert.match(styles, /\.quick-send-main-btn::before\s*\{[^}]*transition:\s*opacity 0\.12s ease;[^}]*will-change:\s*opacity;/s);
  assert.match(styles, /\.quick-send-item:not\(\.quick-send-item-compact\) \.quick-send-main-btn\s*\{[^}]*padding-right:\s*30px;[^}]*padding-left:\s*30px;/s);
  assert.doesNotMatch(styles, /:hover \.quick-send-main-btn[^\{]*\{[^}]*padding-/s);
  assert.match(styles, /\.quick-send-label\s*\{[^}]*line-height:\s*16px;/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*line-height:\s*16px;/s);
  assert.match(styles, /\.quick-sidebar-controls\s*\{[^}]*grid-template-columns:/s);
  assert.match(renderer, /function updateQuickSidebarEditorState\(\)/);
  assert.match(renderer, /const QUICK_SEND_HOLD_MS = 420/);
  assert.match(renderer, /getVerticalInsertionIndex\(rects, pointerY\)/);
  assert.match(renderer, /document\.addEventListener\('pointermove', handleQuickSendPointerMove, \{ passive: false \}\)/);
  assert.match(renderer, /className = `quick-send-edit-delete-btn \$\{compact \? 'compact' : 'full'\}`/);
  assert.match(renderer, /editDeleteBtn\.addEventListener\('pointerdown',[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(renderer, /deleteButton\.tabIndex = context\.editMode \? 0 : -1/);
  assert.match(renderer, /deleteButton\.setAttribute\('aria-hidden', context\.editMode \? 'false' : 'true'\)/);
  assert.match(renderer, /function removeSidebarQuickSendShortcut\(item, element\)/);
  assert.match(renderer, /disableSidebarQuickSend\(quickSendList, sidebarQuickSendOrder, item\.id\)/);
  assert.match(renderer, /function deleteQuickSendItem\(item, element\)/);
  assert.match(renderer, /deleteQuickSendById\(quickSendList, sidebarQuickSendOrder, item\.id\)/);
  assert.match(renderer, /function animateQuickSendRemoval\(element, onComplete\)/);
  assert.match(renderer, /duration:\s*220/);
  assert.match(renderer, /animation\.addEventListener\('finish', complete, \{ once: true \}\)/);
  assert.doesNotMatch(`${renderer}\n${styles}`, /quick-send-shard|quick-send-shatter-dust|createQuickSendShatter/);
  assert.match(styles, /\.quick-send-reorder-mode \.quick-send-edit-delete-btn\s*\{[^}]*opacity:\s*1;[^}]*pointer-events:\s*auto;/s);
  assert.match(styles, /\.quick-send-edit-delete-btn\s*\{[^}]*border-radius:\s*50%;/s);
  assert.match(styles, /\.quick-send-edit-delete-btn\.compact\s*\{[^}]*top:\s*-7px;[^}]*right:\s*0;/s);
  assert.match(styles, /\.quick-send-edit-delete-btn\.full\s*\{[^}]*top:\s*50%;[^}]*right:\s*4px;/s);
  assert.match(styles, /\.quick-send-list-container\.quick-send-reorder-mode \.quick-send-item:not\(\.quick-send-drag-placeholder\) \.quick-send-main-btn/);
  assert.match(styles, /animation:\s*quick-send-jiggle 300ms ease-in-out infinite alternate/);
  assert.match(styles, /animation-delay:\s*-150ms/);
  assert.match(styles, /@keyframes quick-send-jiggle/);
  assert.match(styles, /\.quick-send-drag-preview\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1400;/s);
  assert.match(styles, /\.quick-send-drop-indicator\s*\{[^}]*position:\s*absolute;[^}]*background:\s*var\(--accent-hover\);/s);
  assert.match(styles, /\.quick-send-list-container \.quick-send-drop-indicator\s*\{[^}]*left:\s*10px;[^}]*right:\s*10px;[^}]*height:\s*2px;/s);
  assert.match(styles, /\.quick-send-list-container\s*\{[^}]*position:\s*relative;[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/s);
  assert.match(styles, /\.quick-send-item\.quick-send-removing\s*\{[^}]*pointer-events:\s*none;/s);
  assert.match(styles, /\.quick-send-item\.quick-send-removing\s*\{[^}]*will-change:\s*opacity;/s);
});
test('quick-send auto triggers have a persistent master switch', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  const masterToggle = html.match(/<input[^>]*id="quick-send-auto-trigger-enable"[^>]*>/)?.[0] || '';
  assert.match(masterToggle, /type="checkbox"/);
  assert.match(masterToggle, /\schecked(?:\s|>)/);
  assert.match(styles, /\.quick-send-master-check\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px;/s);
  assert.doesNotMatch(styles, /quick-send-master-switch-track/);
  assert.match(main, /quickSendAutoTriggerEnabled: true/);
  assert.match(main, /normalized\.quickSendAutoTriggerEnabled = normalizeBoolean\(source\.quickSendAutoTriggerEnabled, true\)/);
  assert.match(renderer, /applyQuickSendAutoTriggerConfig\(config\.quickSendAutoTriggerEnabled\)/);
  assert.match(renderer, /if \(!quickSendAutoTriggerEnabled\) return;\s*const triggerItems/);
  assert.match(renderer, /if \(quickSendAutoTriggerEnabled && !nextEnabled\) resetQuickTriggerReceive\(\)/);
  assert.match(renderer, /ipcRenderer\.send\('save-config', \{ quickSendAutoTriggerEnabled \}\)/);
  assert.doesNotMatch(renderer, /quickSendList\.map\([^\n]*autoTrigger[^\n]*enabled/);
});


test('full and compact quick-send clicks share one lightweight result pulse', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(renderer, /showQuickSendClickResult\(btn, result\?\.ok === true\)/);
  assert.match(renderer, /const className = ok \? 'quick-send-click-success' : 'quick-send-click-failed'/);
  assert.match(renderer, /function flashQuickSendItem\(itemId, className = 'auto-trigger-flash', duration = 1300\)/);
  assert.match(styles, /\.quick-send-main-btn\.quick-send-click-success::after\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--success-color\) 58%, transparent\);/s);
  assert.match(styles, /\.quick-send-main-btn\.quick-send-click-failed::after\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--danger-color\) 58%, transparent\);/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-main-btn\.quick-send-click-success\s*\{[^}]*box-shadow:\s*0 0 0 2px #237a27;/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-main-btn\.quick-send-click-failed\s*\{[^}]*box-shadow:\s*0 0 0 2px #9f2828;/s);
  assert.match(styles, /@keyframes quick-send-click-feedback\s*\{[^}]*opacity:\s*0\.82;[\s\S]*?opacity:\s*0;/s);
  assert.doesNotMatch(`${renderer}\n${styles}`, /quick-send-press|quick-send-send-flash|quick-send-send-failed/);
  assert.doesNotMatch(renderer, /pressFeedbackReady|quickSendPressTimers/);
});

test('Windows title bars match each window theme while preserving native controls', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const updateProgress = fs.readFileSync(path.join(root, 'update-progress.html'), 'utf8');
  const titlebar = fs.readFileSync(path.join(root, 'window-titlebar.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(main, /function themedTitleBar\(backgroundColor\)/);
  assert.match(main, /titleBarStyle: 'hidden'/);
  assert.match(main, /titleBarOverlay:\s*\{[\s\S]*color: backgroundColor,[\s\S]*symbolColor: '#cccccc',[\s\S]*height: WINDOWS_TITLE_BAR_HEIGHT/);
  assert.equal((main.match(/\.\.\.themedTitleBar\('#252526'\)/g) || []).length, 2);
  assert.match(main, /\.\.\.themedTitleBar\('#1e1e1e'\)/);
  [html, preferences, updateProgress].forEach(markup => assert.match(markup, /<script src="window-titlebar\.js"><\/script>/));
  assert.match(titlebar, /process\.platform === 'win32'/);
  assert.match(titlebar, /new MutationObserver\(updateTitle\)/);
  assert.match(titlebar, /ipcRenderer\.on\('window-title-updated'/);
  assert.match(styles, /html\.custom-titlebar \.main-container\s*\{[^}]*height:\s*100%;/s);
  assert.match(main, /mainWindow\.webContents\.send\('window-title-updated', title\)/);
  assert.match(styles, /-webkit-app-region:\s*drag/);
});

test('chart tabs discover sample fields and consume raw serial bytes independently', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /node_modules\/uplot\/dist\/uPlot\.min\.css/);
  assert.match(html, /id="pane-1-new-chart-tab-btn"/);
  assert.match(html, /id="chart-sample-line"/);
  assert.match(html, /id="chart-fields-list"/);
  assert.match(html, /id="chart-export-window"/);
  assert.match(html, /id="chart-export-all"/);
  assert.match(html, /id="chart-y-axis-mode"/);
  assert.match(html, /id="chart-parsing-guide-open"/);
  assert.match(html, /id="chart-parsing-guide-dialog"[^>]*class="app-dialog-overlay hidden"/);
  assert.match(html, /CPU USAGE: busy=\{a\} cpu_sleep=\{b\} bus_sleep=\{c\} subsys_sleep=\{d\}/);
  assert.match(html, /\(\?&lt;busy&gt;\[\-\+\]\?\\d\+/);
  assert.match(html, /class="chart-settings-section" aria-labelledby="chart-parser-section-title"/);
  assert.match(html, /class="chart-settings-section" aria-labelledby="chart-display-section-title"/);
  assert.match(html, /class="chart-settings-section" aria-labelledby="chart-retention-section-title"/);
  assert.match(html, /id="chart-fields-toggle"/);
  assert.match(html, /id="chart-fields-selected-count"/);
  assert.match(html, /class="chart-field-columns" role="row"/);
  assert.match(renderer, /function createChartTab\(initialState = \{\}, targetPaneId = null\)/);
  assert.match(renderer, /discoverChartFieldsInWorker\(chartSampleLine\.value/);
  assert.match(renderer, /new ChartParserIpcClient\(\{/);
  assert.doesNotMatch(renderer, /createChartParser/);
  assert.match(main, /new ChartParserWorkerClient\(\{/);
  assert.match(main, /ipcMain\.handle\('chart-parser-discover'/);
  assert.match(main, /const chartParserClients = new Map\(\)/);
  assert.match(main, /function closeChartParserClients\(webContentsId\)/);
  // P5：图表页按分组各一份，写入时取**本批字节所属分组**的列表，
  // 因此不再是模块级别名 chartTabs（那个只指向激活分组）。
  assert.match(renderer, /chartTabsStore\.getList\(groupId\)\.forEach\(tab => tab\.stream\?\.write\(buffer, receivedAt\)\)/);
  assert.match(renderer, /function persistChartTabs\(\)/);
  assert.match(renderer, /buildChartCsv\(samples, tab\.model\.fields\)/);
  // 同样按分组清图表离线数据，不再限定激活分组。
  assert.match(renderer, /chartTabsStore\.getList\(targetGroupId\)\.forEach\(clearChartDataSession\)/);
  assert.match(renderer, /terminalType: 'chart'/);
  assert.match(renderer, /case 'toggle-chart-paused'/);
  assert.match(renderer, /exportChartSamples\('window', chartTab\)/);
  assert.match(renderer, /case 'close-chart-tab'/);
  assert.match(renderer, /function updateChartFieldSelectionState\(\)/);
  assert.match(renderer, /Math\.min\(16, checkboxes\.length\)/);
  assert.match(renderer, /tr\('main\.chartTooManyFields', \{ max: 16 \}\)/);
  assert.match(renderer, /chartYIncludeZero\.disabled = fixedYAxis/);
  assert.match(renderer, /function openChartParsingGuide\(\)/);
  assert.match(renderer, /chartParsingGuideOpen\?\.addEventListener\('click', openChartParsingGuide\)/);
  assert.match(main, /chartTabs: \[\]/);
  // 白名单新增 'group'（分组标签右键菜单）后又新增 'tab'（单分组右键标签），
  // 原先写死列表的正则已经两次因此失效。这里改成**只校验白名单里确实包含本用例
  // 关心的 chart，且同时包含 group / tab 两支菜单类型**，不再把整个列表写死——
  // 否则以后再加类型还会重现同样的误报（断言过期的根源是断言写死了实现细节）。
  assert.match(main, /const terminalType = \[[^\]]*'chart'[^\]]*\]\.includes\(payload\.terminalType\)/);
  assert.match(main, /const terminalType = \[[^\]]*'group'[^\]]*\]\.includes\(payload\.terminalType\)/);
  assert.match(main, /const terminalType = \[[^\]]*'tab'[^\]]*\]\.includes\(payload\.terminalType\)/);
  assert.match(main, /terminalType === 'group' \? \[/);
  assert.match(main, /terminalType === 'chart' \? \[/);
  assert.match(main, /terminalType === 'chart' \? \[/);
  assert.match(main, /sendAction\('export-chart-window'\)/);
  assert.match(main, /sendAction\('move-to-other-pane'\)/);
  assert.match(main, /sendAction\('close-chart-tab'\)/);
  assert.match(main, /receivedAt: Date\.now\(\)/);
  assert.match(styles, /\.chart-navigator-window\s*\{/);
  assert.match(styles, /\.chart-navigator\s*\{[^}]*bottom:\s*28px;[^}]*overflow:\s*hidden;/s);
  assert.match(styles, /\.chart-navigator-window\s*\{[^}]*top:\s*0;[^}]*bottom:\s*0;/s);
  assert.match(renderer, /style\.setProperty\('--chart-log-background', config\.background \|\| '#000000'\)/);
  assert.match(styles, /\.chart-main-host\s*\{[^}]*background:\s*var\(--chart-log-background, #000\);/s);
  assert.match(styles, /\.chart-timeline-shell\s*\{[^}]*background:\s*var\(--chart-log-background, #000\);/s);
  assert.match(styles, /\.chart-fields-table\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.chart-field-columns,\s*\.chart-field-row\s*\{[^}]*min-width:\s*820px;/s);
  assert.match(renderer, /class="secondary chart-lock-btn" type="button" title="\$\{tr\('main\.chartLockLive'\)\}"><span class="material-icon-placeholder" data-material-icon="lock_open">/);
  assert.match(renderer, /tab\.lockButton\.onclick = \(\) => toggleChartLiveLock\(tab\)/);
  assert.match(renderer, /function updateChartLiveLock\(tab, locked\)/);
  assert.match(renderer, /createMaterialIcon\(tab\.liveLocked \? 'lock' : 'lock_open'\)/);
  assert.match(renderer, /tr\(tab\.liveLocked \? 'main\.chartUnlockLive' : 'main\.chartLockLive'\)/);
  assert.match(renderer, /onLockChange: locked => updateChartLiveLock\(tab, locked\)/);
  assert.match(styles, /\.chart-toolbar-actions \.chart-lock-btn\.active\s*\{/);
});

test('font weight preferences persist and apply to every terminal type', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preferencesHtml = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(preferencesHtml, /id="fontWeight"[\s\S]*?<option value="100">100<\/option>[\s\S]*?<option value="900">900<\/option>/);
  assert.match(preferencesHtml, /\.font-settings-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.match(preferencesHtml, /@media \(max-width: 680px\)[\s\S]*?\.font-settings-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(main, /normalized\.fontWeight = normalizeFontWeight\(source\.fontWeight\)/);
  assert.match(main, /fontWeight: 400/);
  assert.match(preferences, /fontWeight: normalizeFontWeight\(elements\.fontWeight\.value\)/);
  assert.equal((renderer.match(/fontWeight: (?:currentConfig|config)\.fontWeight/g) || []).length, 3);
});

test('terminal wallpaper applies to log and shell terminals with a solid fallback', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(main, /terminalWallpaper:\s*\{\s*path: '',\s*overlayOpacity: 55/s);
  assert.match(main, /normalized\.terminalWallpaper = \{[\s\S]*Math\.min\(100, Math\.max\(0, Math\.round\(wallpaperOpacity\)\)\)/);
  assert.match(main, /ipcMain\.handle\('select-terminal-wallpaper'[\s\S]*extensions: \['png', 'jpg', 'jpeg', 'webp'\]/);
  assert.match(html, /id="terminalWallpaperPath"[\s\S]*id="terminalWallpaperOverlay" min="0" max="100"/);
  assert.match(preferences, /invoke\('select-terminal-wallpaper'\)/);
  assert.match(preferences, /terminalWallpaper:\s*\{\s*path: elements\.terminalWallpaperPath\.value,\s*overlayOpacity: Number\(elements\.terminalWallpaperOverlay\.value\)/s);
  assert.equal((renderer.match(/allowTransparency: true/g) || []).length, 3);
  assert.match(renderer, /function getTerminalWallpaperPath\(config\)[\s\S]*fs\.existsSync\(wallpaperPath\)/);
  assert.match(renderer, /image\.onload = \(\) => \{[\s\S]*--terminal-wallpaper-image[\s\S]*--terminal-wallpaper-overlay/);
  // 设置变更必须下发到**每个分组**的串口终端，不能只写默认分组：
  // 旧实现是 `applyTerminalWallpaper(config); serialTerm.options = options`（只管默认分组），
  // 新建分组与已建好的其他分组都会停在旧字体上（实测 diag981：g-1 的 fontFamily 与设置不一致）。
  // 断言改成校验「按运行时注册表遍历」这个新事实，而不是某一行字面量。
  assert.match(renderer, /applyTerminalWallpaper\(config\);[\s\S]*?serialRuntimes\.listGroupIds\(\)\.forEach\(groupId => \{[\s\S]*?runtime\.term\.options = options;[\s\S]*?invalidateTerminalSearch\(runtime\.term, 'options'\);/);
  assert.match(styles, /\.terminal-wrapper\s*\{[^}]*background-image:\s*var\(--terminal-wallpaper-image, none\);/s);
  assert.match(styles, /\.terminal-wrapper::before\s*\{[^}]*background:\s*rgba\(0, 0, 0, var\(--terminal-wallpaper-overlay, 0\)\);/s);
  assert.match(styles, /\.terminal-wrapper \.xterm-viewport\s*\{[^}]*background-color:\s*transparent !important;/s);
  assert.match(styles, /\.chart-tab\s*\{[^}]*background:\s*var\(--chart-log-background, #000\);/s);
});

test('all xterm terminals use Unicode 11 width rules and emoji font fallbacks', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(packageJson.dependencies['@xterm/addon-unicode11'], '^0.9.0');
  assert.match(renderer, /const \{ TerminalUnicodeWidthAddon \} = require\('\.\/terminal-unicode-width'\)/);
  assert.match(renderer, /function enableTerminalUnicode11\(term\) \{\s*term\.loadAddon\(new TerminalUnicodeWidthAddon\(\)\);\s*\}/);
  // 主串口终端的构造已收进 `createSerialRuntime(groupId)`，所以这里不再有
  // `enableTerminalUnicode11(serialTerm)`。但「每个终端都必须应用 Unicode 11 宽度」
  // 这条要求没变，而且现在更强：三个建终端的地方（串口工厂、过滤页、Shell）都要调它。
  // 因此断言数量从 2 提到 3。这不是为了让测试过——工厂真的是第三个终端构造点，
  // 少调一次就会让那个终端的中日韩/emoji 列宽算错。
  assert.match(renderer, /function createSerialRuntime\(groupId\)[\s\S]*?enableTerminalUnicode11\(term\);/);
  assert.equal((renderer.match(/enableTerminalUnicode11\(term\);/g) || []).length, 3);
  assert.match(renderer, /"Segoe UI Emoji", "Noto Color Emoji", "Apple Color Emoji"/);
  assert.equal((renderer.match(/fontFamily: TERMINAL_FONT_FAMILY\(/g) || []).length, 3);
});

test('shell text mode is per-tab, blocks mouse reports, and is exposed in the context menu', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(renderer, /textMode: false/);
  assert.match(renderer, /stripShellMouseReports\(tabState, data\)/);
  assert.match(renderer, /mouseService\._activeProtocol = 'NONE'/);
  assert.match(renderer, /mouseService\._onProtocolChange\?\.fire\(0\)/);
  assert.match(renderer, /mouseService\._protocols\[protocol\]\?\.events \|\| 0/);
  assert.match(renderer, /protocolByMode/);
  assert.match(renderer, /function bindShellTextModeWheel\(tabState, element\)/);
  assert.match(renderer, /if \(!tabState\.textMode\) return;[\s\S]*tabState\.term\.scrollLines/);
  assert.match(renderer, /bindShellTextModeWheel\(tabState, terminalWrapper\)/);
  assert.match(renderer, /tab\.term\.write\(translatedData, \(\) => \{\s*if \(tab\.textMode\) setShellTextMode\(tab, true\);/);
  assert.match(renderer, /shellMouseTrackingMode/);
  assert.match(renderer, /case 'toggle-shell-text-mode'/);
  assert.match(renderer, /shellTextMode: Boolean\(tabState\?\.textMode\)/);
  assert.match(renderer, /mode-badge text/);
  assert.match(main, /type: 'checkbox',[\s\S]*checked: Boolean\(payload\.shellTextMode\)[\s\S]*sendAction\('toggle-shell-text-mode'\)/);
  assert.match(styles, /\.mode-badge\.text\s*\{/);
  assert.match(styles, /\.main-tab\.shell-text-mode\s*\{/);
});

test('sidebar transitions clip fixed-width content without reflowing controls', () => {
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(styles, /\.sidebar\s*\{[^}]*--sidebar-expanded-width:\s*200px;[^}]*width:\s*var\(--sidebar-expanded-width\);/s);
  assert.match(styles, /\.sidebar\s*>\s*:not\(\.sidebar-collapsed-toolbar\)\s*\{[^}]*min-width:\s*var\(--sidebar-expanded-width\);/s);
  assert.match(styles, /\.shell-sidebar\s*>\s*\*\s*\{[^}]*width:\s*200px;[^}]*min-width:\s*200px;/s);
});

test('logging preferences save the automatic cleanup period', () => {
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(html, /<select id="logRetentionDays"[\s\S]*value="0"[\s\S]*value="7"[\s\S]*value="30"[\s\S]*value="60"/);
  assert.match(preferences, /logRetentionDays: document\.getElementById\('logRetentionDays'\)/);
  assert.match(preferences, /elements\.logRetentionDays\.value = \['0', '7', '30', '60'\]/);
  assert.match(preferences, /logRetentionDays: Number\(elements\.logRetentionDays\.value\)/);
  assert.match(html, /id="logCreateDateFolder"/);
  assert.match(preferences, /logCreateDateFolder: document\.getElementById\('logCreateDateFolder'\)/);
  assert.match(preferences, /elements\.logCreateDateFolder\.checked = config\.logCreateDateFolder === true/);
  assert.match(preferences, /logCreateDateFolder: elements\.logCreateDateFolder\.checked/);
});

test('Ctrl+F opens search and restores the last sidebar tab', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(main, /SIDEBAR_TAB_IDS = new Set\(\['tab-settings', 'tab-search', 'tab-send'\]\)/);
  assert.match(main, /activeSidebarTab: 'tab-settings'/);
  assert.match(main, /normalized\.activeSidebarTab = oneOf\(source\.activeSidebarTab, SIDEBAR_TAB_IDS, defaults\.activeSidebarTab\)/);
  assert.match(renderer, /function showSidebarTab\(tabId, persist = true\)/);
  assert.match(renderer, /includes\(tabId\) \? tabId : 'tab-settings'/);
  assert.match(renderer, /ipcRenderer\.send\('save-config', \{ activeSidebarTab: normalizedTabId \}\)/);
  assert.match(renderer, /showSidebarTab\(config\.activeSidebarTab, false\)/);
  assert.match(renderer, /case 'focusSearch':[\s\S]*?focusSearchWithActiveSelection\(\)/);
  assert.match(renderer, /function focusSearchWithActiveSelection\(\)[\s\S]*?showSidebarTab\('tab-search'\)[\s\S]*?searchInput\?\.focus\(\)/);
  const shortcutHandler = renderer.match(/function handleAppShortcut\(event\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(shortcutHandler, /closest\?\.\('\.xterm'\)/);
  assert.doesNotMatch(renderer, /setSearchFromText\(selectedText\);\s*return;/);
});

test('repeated disconnected quick-send clicks show a localized nearby toast', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(renderer, /result\?\.code === 'SERIAL_NOT_OPEN'/);
  assert.match(renderer, /now - previous\.lastClick <= 2000/);
  assert.match(renderer, /if \(count >= 3\) showQuickSendDisconnectedToast\(button\)/);
  assert.match(renderer, /trFallback\('main\.quickSendDisconnectedToast'/);
  assert.match(renderer, /setTimeout\(hideQuickSendDisconnectedToast, 3000\)/);
  assert.match(renderer, /function setSidebarCollapsed\(collapsed, persist = true\)\s*\{\s*hideQuickSendDisconnectedToast\(\)/);
  assert.match(renderer, /async function toggleSerialConnection\(\)\s*\{[\s\S]*?hideQuickSendDisconnectedToast\(\)/);
  assert.match(renderer, /button\.getBoundingClientRect\(\)/);
  assert.match(styles, /\.quick-send-disconnected-toast\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1600;/s);
  assert.match(styles, /\.quick-send-disconnected-toast\.quick-send-toast-hiding\s*\{[^}]*quick-send-toast-out 160ms ease-in forwards;/s);
  assert.match(styles, /@keyframes quick-send-toast-in/);
  assert.match(styles, /@keyframes quick-send-toast-out/);
});

test('workspace tabs support pointer reordering across panes', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(renderer, /getHorizontalInsertionIndex/);
  assert.match(renderer, /function bindWorkspaceTabDragging\(\)/);
  // 跨分组拖动必须分派到**目标分组**的布局管理器。早些时候这里是直接调模块级别名
  // `moveTabToPane`，那会让跨列拖动的标签落到当前分组的第一个 pane 里，表现为
  // 「拖到别的列里没反应」。第 8 项把它改成经 moveTabToGroupPane 分派。
  assert.match(renderer, /function moveTabToGroupPane\(tabId, targetPaneId, targetGroupId, options = \{\}\)/);
  assert.match(renderer, /getGroupWorkspaceManager\(groupId\)\.moveTabToPane\(tabId, targetPaneId, options\)/);
  assert.match(renderer, /moveTabToPane\(tabId, targetPaneId, options\)/);
  assert.match(renderer, /target\.list\.scrollLeft [+-]=/);
  assert.match(renderer, /switchPaneTab\(getPaneIdForTabId\('tab-main'\), 'tab-main'\)/);
  assert.match(renderer, /tabId: tabState\?\.id \|\| \(terminalType === 'main' \? 'tab-main' : ''\)/);
  assert.doesNotMatch(renderer, /tabId === 'tab-main'\) break/);
  assert.doesNotMatch(main, /enabled: terminalType !== 'main' && Boolean\(payload\.tabId\)/);
  assert.match(styles, /\.workspace-tab-drag-preview\s*\{[^}]*position:\s*fixed;[^}]*z-index:\s*1700;/s);
  assert.match(styles, /\.workspace-tab-drop-indicator\s*\{[^}]*flex:\s*0 0 3px;/s);
  assert.match(styles, /\.main-tab\s*\{[^}]*touch-action:\s*none;/s);
});

test('each quick-send item persists its own mode and CRLF setting', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /name="quick-send-mode" value="text" checked/);
  assert.match(html, /name="quick-send-mode" value="hex"/);
  assert.match(html, /id="quick-send-append-crlf"/);
  assert.match(main, /mode: oneOf\(item\.mode, SERIAL_MODES, normalized\.mainInputSettings\.mode\)/);
  assert.match(main, /appendCrLf: normalizeBoolean\(item\.appendCrLf/);
  assert.match(renderer, /mode: item\.mode === 'hex' \? 'hex' : 'text'/);
  assert.match(renderer, /appendCrLf: item\.appendCrLf === true/);
  assert.match(renderer, /appendCrLf: quickSendAppendCrlfInput\.checked/);
  // 两个发送入口都必须显式带 groupId：不带的后果是 `resolveSerialGroupId(undefined)` 回落
  // 默认分组，于是切到串口 2 组后点快捷发送仍会写到串口 1（实测 diag981：groupId 为 'default'）。
  // 点击用 activeGroupId；自动触发用**收到字节所属分组**（groupId 参数），取不到才回落。
  assert.match(renderer, /sendSerialRequest\(\{ groupId: activeGroupId, mode: item\.mode, content: item\.content, appendCrLf: item\.appendCrLf, source: 'quick-send' \}/);
  assert.match(renderer, /validateSendContent\(item\.mode, item\.content, sendEncoding/);
  assert.match(renderer, /if \(!compact && item\.mode === 'hex'\) \{[\s\S]*modeBadge\.textContent = 'HEX'/);
  assert.match(renderer, /mode-badge hex quick-send-mode-badge/);
  assert.match(renderer, /btn\.classList\.add\('has-mode-badge'\)/);
  assert.doesNotMatch(renderer, /if \(compact && item\.mode === 'hex'\)/);
  assert.match(styles, /\.quick-send-mode-badge\s*\{[^}]*position:\s*absolute;[^}]*right:\s*5px;/s);
  assert.match(styles, /\.quick-send-main-btn\.has-mode-badge\s*\{[^}]*padding-right:\s*36px;[^}]*padding-left:\s*36px;/s);
  assert.match(styles, /\.quick-send-mode-control\s*\{[^}]*display:\s*flex;[^}]*gap:\s*8px 18px;/s);
  assert.match(styles, /\.quick-send-mode-control input\s*\{[^}]*accent-color:\s*var\(--accent-color\);/s);
  assert.doesNotMatch(styles, /\.quick-send-mode-control input\s*\{[^}]*opacity:\s*0;/s);
});

test('filter tabs support persistent whole-word matching', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /class="filter-toggle-btn filter-word-btn"/);
  assert.match(renderer, /wholeWord: false/);
  assert.match(renderer, /pattern = `\\\\b\(\?:\$\{pattern\}\)\\\\b`/);
  assert.match(renderer, /wholeWord: tab\.wholeWord/);
  assert.match(renderer, /case 'toggle-whole-word'/);
  assert.match(main, /checked: Boolean\(payload\.wholeWord\)/);
  assert.match(main, /sendAction\('toggle-whole-word'\)/);
});

test('passive search changes refresh results without selecting a match', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const tabChangedHandler = renderer.match(/window\.addEventListener\('main-tab-changed', \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';
  const searchInputHandler = renderer.match(/searchInput\.addEventListener\('input', \(\) => \{([\s\S]*?)\n\}\);/)?.[1] || '';

  assert.match(tabChangedHandler, /refreshSearchCount\(\)/);
  assert.match(searchInputHandler, /scheduleSearchRefresh\(\)/);
  assert.doesNotMatch(renderer, /scheduleSearchSelection|selectFirstSearchResult/);
  assert.doesNotMatch(tabChangedHandler, /selectSearchMatch/);
  assert.match(renderer, /function navigateSearch\(direction\)[\s\S]*?selectSearchMatch\(index\)/);
  assert.match(renderer, /findNextBtn\.addEventListener\('click', \(\) => navigateSearch\('next'\)\)/);
  assert.match(renderer, /findPrevBtn\.addEventListener\('click', \(\) => navigateSearch\('previous'\)\)/);
});

test('terminal search invalidates cached coordinates and re-anchors active results', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /observeTerminalSearchChanges\(serialTerm\)/);
  assert.equal((renderer.match(/^\s{4}observeTerminalSearchChanges\(term\);$/gm) || []).length, 2);
  assert.equal((renderer.match(/^\s{4,8}unobserveTerminalSearchChanges\(tab\.term\);$/gm) || []).length, 2);
  assert.match(renderer, /createTerminalRevisionTracker\(term,/);
  assert.match(renderer, /buildSearchCacheKey[\s\S]*?getTerminalSearchRevision\(target\.term\)/);
  assert.match(renderer, /getActiveSearchAnchor[\s\S]*?active\.marker\.line/);
  assert.match(renderer, /findAnchoredMatchIndex\(matches, anchor\)/);
  assert.match(renderer, /searchState\.current = anchoredIndex >= 0 \? anchoredIndex \+ 1 : 0/);
  assert.match(renderer, /invalidateTerminalSearch\(term, 'reset', \{ clearAnchor: true \}\)/);
  assert.match(renderer, /invalidateTerminalSearch\(shellTab\.term, 'clear', \{ clearAnchor: true \}\)/);
  // 字体/主题变更后必须作废每个终端的搜索缓存：原来只写 `serialTerm`（默认分组），
  // 现在改成遍历运行时注册表，所以断言从「写 serialTerm」改成「写每个 runtime.term」。
  assert.match(renderer, /invalidateTerminalSearch\(runtime\.term, 'options'\)/);
  assert.doesNotMatch(renderer, /function getSearchBufferVersion/);
});

test('active search results are scrolled near the terminal center', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const centerScroll = renderer.match(/function scrollSearchMatchIntoCenter\(term, line\) \{[\s\S]*?\n\}/)?.[0] || '';
  const selectMatch = renderer.match(/function selectSearchMatch\(index\) \{[\s\S]*?\n\}/)?.[0] || '';

  assert.match(centerScroll, /Number\(term\.rows\)/);
  assert.match(centerScroll, /line - Math\.floor\(visibleRows \/ 2\)/);
  assert.match(centerScroll, /term\.scrollToLine\(Math\.max\(0,/);
  assert.match(selectMatch, /scrollSearchMatchIntoCenter\(target\.term, match\.line\)/);
  assert.doesNotMatch(selectMatch, /scrollToLine\(match\.line\)/);
});

test('preferences configure search, filter, and selection highlight colors', () => {
  const html = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  ['search', 'filter', 'selection'].forEach(type => {
    const prefix = `${type}Highlight`;
    assert.match(html, new RegExp(`id="${prefix}Background"`));
    assert.match(html, new RegExp(`id="${prefix}Foreground"`));
  });
  assert.match(preferences, /highlightColors:\s*\{[\s\S]*search:[\s\S]*filter:[\s\S]*selection:/);
  assert.match(main, /for \(const type of \['search', 'filter', 'selection'\]\)/);
  assert.match(main, /HEX_COLOR_PATTERN\.test\(colors\.background/);
  assert.match(main, /filter: \{ background: '#535353', foreground: '#ffffff' \}/);
  assert.match(main, /selection: \{ background: '#073ca8', foreground: '#ffffff' \}/);
  assert.match(main, /timestampColor: '#808080'/);
  assert.match(main, /lineNoColor: '#67986f'/);
  assert.match(renderer, /selectionBackground: config\.highlightColors\.selection\.background/);
  assert.match(renderer, /selectionForeground: config\.highlightColors\.selection\.foreground/);
  assert.match(renderer, /backgroundColor: highlightColors\.search\.background/);
  assert.match(renderer, /foregroundColor: highlightColors\.search\.foreground/);
  assert.equal((renderer.match(/allowProposedApi: true/g) || []).length, 3);
  assert.match(renderer, /target\.term\.clearSelection\?\.\(\);\s*decorateActiveSearchMatch\(target\.term, match\)/);
  assert.doesNotMatch(renderer, /target\.term\.select\(match\.column, match\.line, match\.length\)/);
  assert.match(renderer, /hexToAnsiBackground\(highlightColors\.filter\.background\)/);
  assert.match(renderer, /hexToAnsi\(highlightColors\.filter\.foreground\)/);
});

test('welcome guide is shown once for each installed version', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const i18n = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');

  assert.match(main, /lastWelcomeVersion: ''/);
  assert.match(main, /normalized\.lastWelcomeVersion = typeof source\.lastWelcomeVersion === 'string'/);
  assert.match(renderer, /function showWelcomeGuideForCurrentVersion\(config\)/);
  assert.match(renderer, /config\.lastWelcomeVersion === version/);
  assert.match(renderer, /serialTerm\.write\(buildWelcomeGuideOutput\(version\)\)/);
  assert.match(renderer, /function buildWelcomeGuideOutput\(version\)/);
  assert.match(renderer, /'██╗ ████████╗███████╗████████╗'/);
  assert.match(renderer, /'╚═╝    ╚═╝   ╚══════╝   ╚═╝   '/);
  assert.match(renderer, /bannerColors = \['45;212;191', '34;211;238', '56;189;248', '96;165;250', '129;140;248', '192;132;252'\]/);
  assert.match(renderer, /tr\('main\.welcomeClearHint'\)/);
  assert.match(renderer, /ipcRenderer\.send\('save-config', \{ lastWelcomeVersion: version \}\)/);
  assert.match(renderer, /applyConfig\(config\);\s*showWelcomeGuideForCurrentVersion\(config\)/);
  assert.match(i18n, /感谢使用 Trigger's SerialTerminal v\{version\}/);
  assert.match(i18n, /1\. Log 过滤/);
  assert.match(i18n, /6\. 终端窗口/);
  assert.match(i18n, /可点击左侧“清空 Log”按钮清除此提示/);
});

test('sidebar can export the active terminal through an independent save dialog', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="open-log-folder-btn"[\s\S]*id="save-current-tab-btn"/);
  assert.match(styles, /\.sidebar-log-actions\s*\{[^}]*grid-template-columns:/s);
  assert.match(renderer, /function getActiveTerminalExport\(\)/);
  assert.match(renderer, /serializeTerminalBuffer\(targetTerm\?\.buffer\?\.active\)/);
  assert.match(renderer, /invoke\('save-current-tab-log', getActiveTerminalExport\(\)\)/);
  assert.match(main, /ipcMain\.handle\('save-current-tab-log'/);
  assert.match(main, /dialog\.showSaveDialog\(owner/);
  assert.match(main, /app\.getPath\('documents'\)/);
  assert.match(main, /fs\.promises\.writeFile\(result\.filePath,[\s\S]*'utf8'\)/);
});

test('filter and shell tabs support persistent double-click renaming', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="rename-tab-dialog"/);
  assert.match(renderer, /tabBtn\.ondblclick/);
  assert.match(renderer, /function openRenameTabDialog\(tabState\)/);
  assert.match(renderer, /rename-tab-dialog-save'\)\.addEventListener\('click', saveRenamedTab\)/);
  assert.match(renderer, /rename-tab-dialog-cancel'\)\.addEventListener\('click', closeRenameTabDialog\)/);
  assert.match(renderer, /rename-tab-dialog-close'\)\.addEventListener\('click', closeRenameTabDialog\)/);
  assert.doesNotMatch(renderer, /renameTabDialog\.addEventListener\('click'/);
  assert.doesNotMatch(renderer, /quickSendDialog\.addEventListener\('click'/);
  assert.match(renderer, /title: tab\.title \|\| ''/);
  assert.match(renderer, /title: initialState\.title \|\| ''/);
  assert.match(renderer, /if \(filterTabs\.includes\(renameTabState\)\) persistFilterTabs\(\)/);
  assert.match(renderer, /if \(shellTabs\.includes\(renameTabState\)\) persistShellTabs\(\)/);
  assert.match(renderer, /tab\.title\?\.trim\(\) \|\| defaultTitle/);
  assert.match(styles, /\.rename-tab-dialog \.form-group > label\s*\{[^}]*margin-bottom:\s*5px;/s);
});

test('send mode and CRLF controls belong to the bottom input', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const settings = html.match(/<div id="tab-settings"[\s\S]*?<\/div>\s*<!-- Search Tab -->/)?.[0] || '';
  const inputPanel = html.match(/<div class="main-input-panel"[\s\S]*?<\/div>\s*<\/div>\s*<!-- Right Shell Sidebar -->/)?.[0] || '';

  assert.match(settings, /id="send-encoding-select"/);
  assert.doesNotMatch(settings, /id="send-mode-select"|id="send-append-crlf"/);
  assert.match(inputPanel, /id="main-send-hex"/);
  assert.match(inputPanel, /id="main-send-append-crlf"/);
  assert.match(inputPanel, /id="main-send-on-enter"/);
  assert.match(renderer, /mode: request\.mode === 'hex' \? 'hex' : 'text'/);
  assert.match(renderer, /appendCrLf: request\.source === 'terminal' \? false : request\.appendCrLf === true/);
  assert.match(renderer, /mode: mainInputMode,[\s\S]*appendCrLf: mainSendAppendCrlfCb\?\.checked === true/);
  assert.doesNotMatch(renderer, /let sendMode|let sendAppendCrLf/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*#main-send-input \{ flex-basis: calc\(100% - 46px\); \}/);
});

test('shell terminals preserve xterm keyboard, paste, and mouse input handling', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(main, /name: 'xterm-256color'/);
  assert.match(main, /env: \{ \.\.\.process\.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' \}/);
  assert.match(main, /useConpty: process\.platform === 'win32'/);
  assert.match(main, /useConptyDll: process\.platform === 'win32'/);
  assert.match(main, /if \(shellSessions\.get\(tabId\) !== session\) return;\s*shellSessions\.delete\(tabId\)/);
  assert.match(main, /ipcMain\.on\('shell-tab-binary-input'[\s\S]*?session\.ptyProcess\.write\(Buffer\.from\(bytes\)\)/);
  assert.match(renderer, /if \(ctrlKey && key === 'v'\) \{\s*if \(terminalType === 'shell'\) return false;/);
  assert.match(renderer, /if \(isShell && shellTab\) \{\s*shellTab\.term\.paste\(text\)/);
  assert.match(renderer, /term\.onBinary\(\(data\) => \{[\s\S]*?ipcRenderer\.send\('shell-tab-binary-input'/);
  assert.match(renderer, /term\.onData\(\(data\) => \{[\s\S]*?ipcRenderer\.send\('shell-tab-input', \{ tabId, data \}\)/);
  assert.match(renderer, /require\('\.\/shell-mouse-compat'\)/);
  assert.match(renderer, /ipcRenderer\.on\('shell-tab-output'[\s\S]*?const translatedData = translateConptyMouseMode\(tab, payload\.data\);[\s\S]*?tab\.term\.write\(translatedData, \(\) => \{[\s\S]*?setShellTextMode\(tab, true\)/);
  assert.doesNotMatch(renderer, /translateShellMouseInput/);
  assert.match(renderer, /const action = getShortcutAction\(combo\);\s*if \(!action\) return;[\s\S]*?event\.preventDefault\(\)/);
  assert.doesNotMatch(renderer, /terminalType === 'shell'[\s\S]{0,180}shell-tab-input/);
  assert.equal((renderer.match(/bindTerminalWheel\(term, terminalWrapper\)/g) || []).length, 1);
  assert.match(renderer, /if \(shellTab\) \{\s*invalidateTerminalSearch\(shellTab\.term, 'clear',[\s\S]*?shellTab\.term\.clear\(\)/);
});

test('text filter tabs do not display a TXT mode badge', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /if \(tab\.dataMode === 'hex'\)/);
  assert.match(renderer, /badge\.className = 'mode-badge hex'/);
  assert.doesNotMatch(renderer, /tab\.dataMode === 'hex' \? 'HEX' : 'TXT'/);
});

test('search history records explicit searches and exposes pin, delete, replay, and limit controls', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const preferencesHtml = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="search-history-list"/);
  assert.match(html, /data-i18n="main\.searchHistory"/);
  assert.match(preferencesHtml, /id="searchHistoryLimit" min="0" max="200"/);
  assert.match(preferences, /normalizeIntegerSetting\(value, 'searchHistoryLimit'\)/);
  assert.match(preferences, /searchSettings:\s*\{[\s\S]*historyLimit: normalizeSearchHistoryLimit/);
  assert.match(main, /searchSettings:\s*\{\s*historyLimit: 20/);
  assert.match(main, /normalized\.searchHistory = normalizeSearchHistory/);
  assert.match(renderer, /function recordCurrentSearch\(\)/);
  assert.match(renderer, /function navigateSearch\(direction\)\s*\{\s*recordCurrentSearch\(\);\s*refreshSearchCount\(\)/);
  assert.match(renderer, /findNextBtn\.addEventListener\('click', \(\) => navigateSearch\('next'\)\)/);
  assert.match(renderer, /navigateSearch\(e\.shiftKey \? 'previous' : 'next'\)/);
  assert.match(renderer, /function applySearchHistoryItem\(item\)/);
  assert.match(renderer, /function applySearchHistoryItem\(item\)[\s\S]*?navigateSearch\('next'\)/);
  assert.match(renderer, /createMaterialIcon\('push_pin'\)/);
  assert.match(renderer, /createMaterialIcon\('delete'\)/);
  assert.match(styles, /\.search-history-item\.pinned/);
});

test('DOM command icons use shared local Material Symbols paths', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const preferencesHtml = fs.readFileSync(path.join(root, 'preferences.html'), 'utf8');
  const icons = fs.readFileSync(path.join(root, 'material-icons.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /<script src="material-icons\.js"><\/script>/);
  assert.match(preferencesHtml, /<script src="material-icons\.js"><\/script>/);
  assert.match(preferencesHtml, /onclick="showTab\('appearance', this\)"/);
  assert.match(preferencesHtml, /function showTab\(tabId, trigger\)/);
  assert.match(icons, /Official Material Symbols Outlined paths/);
  assert.match(icons, /function createIcon\(name/);
  assert.match(icons, /function upgrade\(root = document\)/);
  assert.match(icons, /document\.createElementNS\(SVG_NS, 'path'\)/);
  assert.match(icons, /path\.setAttribute\('d', paths\[name\]\)/);
  assert.doesNotMatch(icons, /document\.createElementNS\(SVG_NS, 'use'\)/);
  assert.match(styles, /svg\[data-material-icon\]\s*\{[^}]*fill:\s*currentColor;/s);
  assert.match(styles, /background-image:\s*url\("data:image\/svg\+xml,[^\n]*M480-360 280-559h400L480-360Z/);
  assert.match(styles, /input\[type="checkbox"\]:checked::after\s*\{[^}]*mask:[^;}]*M382-240 154-468/s);
  assert.doesNotMatch(styles, /content:\s*['"]✓['"]/);

  [
    'refresh', 'close', 'power', 'delete_sweep', 'folder_open', 'save', 'tune', 'search',
    'send', 'schedule', 'format_list_numbered', 'regular_expression', 'match_case',
    'match_word', 'add', 'chevron_left', 'settings', 'keyboard', 'terminal', 'filter_alt',
    'history', 'keyboard_return'
  ].forEach(name => assert.match(html, new RegExp(`data-material-icon="${name}"`)));

  [
    'palette', 'terminal', 'ink_highlighter', 'description', 'keyboard', 'info',
    'font_download', 'format_size', 'receipt_long', 'history', 'mouse', 'folder_open',
    'draft', 'translate', 'add'
  ].forEach(name => assert.match(preferencesHtml, new RegExp(`data-material-icon="${name}"`)));

  const iconGlyphs = /🔄|✕|⚡|🗑|📂|💾|🛠|🔍|📤|🕒|🔢|🔠|⚙|⌨|ℹ|🎨|💻|🖍|📝|📜|🖱|📄|🔡|➕|⏎/;
  assert.doesNotMatch(html, iconGlyphs);
  assert.doesNotMatch(preferencesHtml, iconGlyphs);
  assert.doesNotMatch(html, /<option[^>]*>\s*✎/);
  const registeredIcons = new Set([...icons.matchAll(/^\s{8}([a-z_]+):\s*'/gm)].map(match => match[1]));
  assert.ok(registeredIcons.has('push_pin'));
  const usedIcons = [html, preferencesHtml, fs.readFileSync(path.join(root, 'renderer.js'), 'utf8'), fs.readFileSync(path.join(root, 'preferences.js'), 'utf8')]
    .flatMap(source => [
      ...[...source.matchAll(/data-material-icon="([a-z_]+)"/g)].map(match => match[1]),
      ...[...source.matchAll(/createMaterialIcon\('([a-z_]+)'\)/g)].map(match => match[1])
    ]);
  usedIcons.forEach(name => assert.ok(registeredIcons.has(name), `Material icon is not registered: ${name}`));
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  assert.match(packageJson, /!assets\/NotoColorEmoji-Regular\.ttf/);
});

test('dynamic DOM controls create Material SVG icons without replacing icon-bearing button content', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  ['close', 'arrow_drop_down', 'match_case', 'match_word', 'regular_expression', 'check_circle', 'edit', 'delete']
    .forEach(name => assert.match(renderer, new RegExp(`(?:createMaterialIcon\\('${name}'\\)|data-material-icon="${name}")`)));
  ['match_case', 'regular_expression', 'delete', 'folder_open', 'add']
    .forEach(name => assert.match(preferences, new RegExp(`createMaterialIcon\\('${name}'\\)`)));

  assert.doesNotMatch(renderer, /textContent\s*=\s*['"](?:✕|✎|▼|⬤|Aa|\.\*)/);
  assert.doesNotMatch(preferences, /textContent\s*=\s*['"](?:✕|…|\+|Aa|\.\*)/);
  assert.match(renderer, /translated = translated\.replace\(\/\^\\s\*\\\+\\s\*\//);
  assert.match(preferences, /translatedActionLabel/);
  assert.doesNotMatch(preferences, /elements\.addRuleBtn\.textContent/);
});

test('auto send exposes the interval unit and uses a compact text input', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="auto-send-interval"[\s\S]*?<span class="auto-send-interval-unit"[^>]*>ms<\/span>/);
  assert.match(styles, /#auto-send-text\s*\{[^}]*height:\s*30px;[^}]*min-height:\s*30px;[^}]*max-height:\s*30px;/s);
});

test('update confirmation opens a controlled download window with progress and install flow', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const progressHtml = fs.readFileSync(path.join(root, 'update-progress.html'), 'utf8');
  const progressRenderer = fs.readFileSync(path.join(root, 'update-progress.js'), 'utf8');
  const preferences = fs.readFileSync(path.join(root, 'preferences.js'), 'utf8');

  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = false/);
  assert.match(main, /function startUpdateDownload\(info\)/);
  assert.equal((main.match(/autoUpdater\.downloadUpdate\(token\)/g) || []).length, 1);
  assert.match(main, /phase === 'downloading' \|\| updatePromptState\.phase === 'downloaded'/);
  assert.match(main, /if \(updatePromptState\.promptPromise\) return updatePromptState\.promptPromise/);
  assert.match(main, /function sendCurrentUpdateStatusToPrefs\(\)/);
  assert.match(main, /if \(updatePromptState\.phase === 'checking'\) \{\s*if \(manual\) updatePromptState\.checkSource = 'manual';/s);
  assert.match(main, /if \(updatePromptState\.phase === 'prompting'\) \{\s*sendCurrentUpdateStatusToPrefs\(\);/s);
  assert.doesNotMatch(main, /promptToInstallDownloadedUpdate/);
  assert.match(main, /const isTrustedSource = sourceWindow === updateDownloadWindow \|\| sourceWindow === prefsWindow/);
  assert.match(main, /if \(updatePromptState\.phase !== 'downloaded' \|\| !isTrustedSource\) return;\s*autoUpdater\.quitAndInstall\(\);/s);
  assert.match(main, /closable:\s*false/);
  assert.match(main, /if \(status === 'error' \|\| status === 'cancelled'\) updateDownloadWindow\.setClosable\(true\)/);
  assert.match(main, /sendUpdateDownloadStatus\('progress', progressObj\)/);
  assert.match(main, /sendUpdateDownloadStatus\('downloaded', info\)/);
  assert.match(main, /getManualUpdateDownloadUrl\(info\)/);
  assert.match(main, /GITEE_API_BASE = `https:\/\/gitee\.com\/api\/v5\/repos\/\$\{GITEE_OWNER\}\/\$\{GITEE_REPO\}`/);
  assert.match(main, /resolveGiteeUpdateMetadataUrl\(\{ logger: log \}\)/);
  assert.match(main, /const candidates = buildUpdateMetadataCandidates\(giteeMetadataUrl, process\.platform\)/);
  assert.match(main, /selectUpdateReleaseCandidates\(releases, process\.platform, UPDATE_PACKAGE_TYPE\)/);
  assert.match(main, /isUpdateSourceConsistent\(metadataUrl, info, process\.platform, UPDATE_PACKAGE_TYPE\)/);
  assert.match(main, /activeUpdateMetadataUrl = metadataUrl/);
  assert.match(main, /const updateChannel = getUpdateChannel/);
  assert.match(main, /Promise\.all\(candidates\.map\(metadataUrl => checkMetadataSource\(metadataUrl, 'fallback'\)\)\)/);
  assert.match(main, /'X-SerialTerminal-Version': app\.getVersion\(\)/);
  assert.match(main, /'X-SerialTerminal-Channel': UPDATE_CHANNEL/);
  assert.match(main, /net\.fetch\(currentUrl\.toString\(\), \{[\s\S]*redirect: 'manual'/);
  assert.match(main, /'User-Agent': `\$\{app\.getName\(\)\}\/\$\{app\.getVersion\(\)\}`,[\s\S]*\.\.\.\(selectionHeaders \|\| \{\}\)/);
  assert.doesNotMatch(main, /\.\.\.this\.requestHeaders/);
  assert.match(main, /setTimeout\(\(\) => controller\.abort\(\), UPDATE_METADATA_TIMEOUT_MS\)/);
  assert.match(main, /readLimitedResponse\(response, MAX_UPDATE_METADATA_BYTES\)/);
  assert.doesNotMatch(main, /this\.httpRequest\(this\.metadataUrl\)/);
  assert.match(main, /autoUpdater\.setFeedURL\(\{[\s\S]*updateProvider: UpdateMetadataProvider,[\s\S]*selectionHeaders: getUpdateMetadataSelectionHeaders\(metadataUrl\)/);
  assert.match(main, /const dynamicRelease = await dynamicPromise/);
  assert.match(main, /const result = await autoUpdater\.checkForUpdates\(\);\s*const info = validateUpdateInfo\(metadataUrl, result\?\.updateInfo \|\| result\?\.versionInfo, expectedInfo\);/);
  assert.match(main, /getUpdateChannel\(metadataUrl, expectedInfo, process\.platform, UPDATE_PACKAGE_TYPE\)[\s\S]*getUpdateChannel\(metadataUrl, info, process\.platform, UPDATE_PACKAGE_TYPE\)/);
  assert.match(main, /if \(result\?\.isUpdateAvailable\) handleVerifiedUpdateAvailable\(info\);\s*else handleVerifiedUpdateNotAvailable\(info\);/);
  assert.match(main, /function downloadUpdateWithFallback\(token\)/);
  assert.match(main, /runUpdateSourceFallback\(updateMetadataCandidates/);
  assert.match(main, /autoUpdater\.disableDifferentialDownload = getUpdateChannel\(metadataUrl, sourceInfo, process\.platform, UPDATE_PACKAGE_TYPE\) === 'Gitee'/);
  assert.match(main, /Update version or SHA-512 does not match the selected release/);
  assert.match(main, /if \(!result\?\.isUpdateAvailable\) throw new Error\('Selected update is not available from this source'\)/);
  assert.match(main, /checkUpdateSources\(\)/);
  assert.match(main, /if \(updateFeedFallbackActive \|\| updateDownloadFallbackActive\) return;/);
  assert.match(main, /if \(updatePromptState\.phase === 'checking'\) \{[\s\S]*sendUpdateStatusToPrefs\('error', error\.message\);[\s\S]*updatePromptState\.phase = 'idle';/);
  assert.doesNotMatch(main, /autoUpdater\.setFeedURL\(UPDATE_FEED\)/);
  assert.match(preferences, /shell\.openExternal\('https:\/\/gitee\.com\/trigger-cn\/SerialTerminal\/releases'\)/);
  assert.doesNotMatch(preferences, /github\.com\/Trigger-CN\/SerialTerminal\/releases\/latest/);
  assert.match(main, /autoUpdater\.constructor\?\.name === 'DebUpdater'/);
  assert.match(main, /new URL\(String\(artifactFile\.url\), activeUpdateMetadataUrl\)/);
  assert.match(main, /process\.platform === 'linux' \? GITHUB_RELEASE_PAGE : GITEE_RELEASE_PAGE/);
  assert.match(main, /open-update-download-url/);
  assert.match(progressHtml, /id="progress-fill"/);
  assert.match(progressHtml, /id="install-btn"/);
  assert.match(progressHtml, /id="cancel-btn"/);
  assert.match(progressHtml, /id="manual-download-link"/);
  assert.match(progressHtml, /id="channel"/);
  assert.match(progressRenderer, /bytesPerSecond/);
  assert.match(progressRenderer, /updateChannelLabel/);
  assert.match(preferences, /updateDialog\.updateChannel/);
  assert.match(progressRenderer, /open-update-download-url/);
  assert.match(progressRenderer, /ipcRenderer\.send\('quit-and-install'\)/);
  assert.match(progressRenderer, /ipcRenderer\.send\('cancel-update-download'\)/);
  assert.doesNotMatch(progressHtml, /id="pause-btn"/);
  assert.doesNotMatch(progressRenderer, /pause-update-download|resume-update-download/);
});

test('update downloads can be cancelled with a cancellation token', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  assert.match(main, /const \{ CancellationToken \} = require\('builder-util-runtime'\)/);
  assert.match(main, /const token = new CancellationToken\(\)/);
  assert.match(main, /if \(!token\.cancelled\) \{\s*log\.error\('Failed to download update:', error\)/);
  assert.match(main, /function cancelUpdateDownload\(\)[\s\S]*updateDownloadToken\.cancel\(\)/);
  assert.match(main, /if \(token\.cancelled\) \{[\s\S]*sendUpdateDownloadStatus\('cancelled'\);[\s\S]*closeUpdateDownloadWindow\(\)/);
  assert.match(main, /ipcMain\.on\('cancel-update-download'[\s\S]*cancelUpdateDownload\(\)/);
  assert.doesNotMatch(main, /pause-update-download|resume-update-download|phase = 'paused'/);
});

test('automatic update checks every two hours and reminds every eight hours', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(main, /UPDATE_CHECK_INTERVAL_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(main, /UPDATE_PROMPT_INTERVAL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(main, /setInterval\(\(\) => \{\s*checkForAppUpdates\(\{ scheduled: true \}\);\s*\}, UPDATE_CHECK_INTERVAL_MS\)/s);
  assert.match(main, /function shouldShowAutomaticUpdatePrompt\(info, now = Date\.now\(\)\)/);
  assert.match(main, /currentConfig\.skippedUpdateVersion === version/);
  assert.match(main, /currentConfig\.lastUpdatePromptVersion !== version/);
  assert.match(main, /now - currentConfig\.lastUpdatePromptAt >= UPDATE_PROMPT_INTERVAL_MS/);
  assert.match(main, /saveConfig\(\{ lastUpdatePromptVersion: version, lastUpdatePromptAt: now \}\)/);
  assert.match(main, /if \(updatePromptState\.checkSource === 'scheduled'\) \{\s*if \(shouldShowAutomaticUpdatePrompt\(info\)\) \{\s*showScheduledUpdateToast\(info\);/s);
  assert.match(main, /mainWindow\.webContents\.send\('scheduled-update-available'/);
  assert.match(main, /const isStartupPrompt = updatePromptState\.checkSource === 'startup'[\s\S]*offerAvailableUpdate\(info, isStartupPrompt\)/);
  assert.match(renderer, /ipcRenderer\.on\('scheduled-update-available'/);
  assert.match(renderer, /setTimeout\(hideScheduledUpdateToast, 5000\)/);
  assert.match(renderer, /createMaterialIcon\('close'\)/);
  assert.match(styles, /\.scheduled-update-toast\s*\{[^}]*position:\s*fixed;[^}]*right:\s*16px;[^}]*bottom:\s*16px;/s);
  assert.match(main, /lastUpdatePromptVersion: ''/);
  assert.match(main, /lastUpdatePromptAt: 0/);
  assert.match(main, /if \(updateCheckTimer\) clearInterval\(updateCheckTimer\)/);
});

test('log hot path reuses buffers, batch timestamps, and compiled regexes', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  // A：同一段字节只包装一次 Buffer 并复用给终端队列；入队时必须带上它所属的分组。
  assert.match(renderer, /const buffer = Buffer\.from\(bytes\.buffer, bytes\.byteOffset, bytes\.byteLength\)[\s\S]*?queueSerialOutput\(buffer, groupId\)/);

  // B：每个刷新批次只计算一次时间戳，逐行复用
  assert.match(renderer, /function formatTimestamp\(now = new Date\(\)\)/);
  assert.match(renderer, /currentBatchTimestamp = formatTimestamp\(\);/);
  assert.match(renderer, /currentBatchTimestamp = null;/);
  assert.match(renderer, /currentBatchTimestamp \|\| formatTimestamp\(\)/);

  // C：高亮规则与带 g 的过滤正则预编译并缓存
  assert.match(renderer, /function compileHighlightRules\(rules\)/);
  assert.match(renderer, /compiledHighlightRules = compileHighlightRules\(highlightRules\)/);
  assert.match(renderer, /const globalFilterRegexCache = new WeakMap\(\)/);
  assert.match(renderer, /let re = globalFilterRegexCache\.get\(filterRegex\);/);
  assert.doesNotMatch(renderer, /const re = new RegExp\(pattern, flags\);/);
  assert.doesNotMatch(renderer, /new RegExp\(filterRegex\.source, flags\)/);

  // D：解析器不再每个 flush 重新 split 整个缓冲
  // 解析器已抽到 serial-data-parser.js（无 DOM 依赖，可单测），因此改查该文件。
  const parserSource = fs.readFileSync(path.join(root, 'serial-data-parser.js'), 'utf8');
  assert.doesNotMatch(parserSource, /incomingBuffer\.split\(/);
  assert.match(parserSource, /const LINE_DELIMITER_RE = \//);
  assert.match(parserSource, /LINE_DELIMITER_RE\.lastIndex = scanFrom;/);
  assert.doesNotMatch(renderer, /class SerialDataParser/);

  // E：stripAnsi 对无 ESC 的输出直接短路
  assert.match(main, /if \(!str\.includes\('\\x1b'\)\) return str;/);
});

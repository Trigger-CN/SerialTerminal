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
  assert.match(preferences, /ipcRenderer\.on\('focus-preferences-tab'/);
  assert.match(preferences, /focusPreferencesTab\(tabId\)/);
});

test('shell profile buttons pass the configured name to new shell tabs', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /createShellTab\(\{ profileId: profile\.id, title: profile\.name \}/);
  assert.match(renderer, /profile\?\.name\?\.trim\(\) \|\| tr\('main\.shellTitle'/);
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
  assert.doesNotMatch(styles, /\.sidebar-fixed-tools\s*\{[^}]*overflow-y:/s);
  assert.match(styles, /\.sidebar-tool-btn#sidebar-expand-btn\s*\{[^}]*flex-shrink:\s*0;[^}]*margin-top:\s*8px;/s);
  assert.equal((toolbar.match(/data-material-icon=/g) || []).length, 6);
  assert.doesNotMatch(toolbar, /<svg\b/);
  assert.match(styles, /\.sidebar-tool-icon\s*\{[^}]*width:\s*20px;[^}]*height:\s*20px;[^}]*fill:\s*currentColor;/s);
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
  assert.match(renderer, /function renderQuickSendLists\(\)/);
  assert.match(renderer, /renderQuickSendContainer\(quickSendListEl\)/);
  assert.match(renderer, /renderQuickSendContainer\(sidebarQuickSendListEl, true\)/);
  assert.match(renderer, /function moveQuickSendItem\(itemId, targetId, compact = false\)/);
  assert.match(renderer, /const list = compact \? sidebarQuickSendOrder : quickSendList/);
  assert.match(renderer, /moveQuickSendItem\(draggedQuickSendId, item\.id, compact\)/);
  assert.match(renderer, /draggedQuickSendCompact !== compact/);
  assert.match(renderer, /quickSendList: quickSendList\.map\(normalizeQuickSendItem\),\s*sidebarQuickSendOrder/s);
  assert.match(renderer, /element\.animate\(\[\{ transform: `translateY\(\$\{offset\}px\)` \}/);
  assert.match(styles, /\.quick-send-item-compact\s*\{[^}]*width:\s*36px;[^}]*min-height:\s*36px;/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*display:\s*block;[^}]*max-height:\s*32px;/s);
  assert.doesNotMatch(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*-webkit-line-clamp:/s);
  assert.match(renderer, /compact \? 'quick-send-main-btn sidebar-tool-btn' : 'quick-send-main-btn'/);
  assert.match(styles, /\.quick-send-item-compact\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;[^}]*flex:\s*0 0 36px;/s);
  assert.match(styles, /\.quick-send-item:not\(\.quick-send-item-compact\):hover \.quick-send-main-btn/);
  assert.match(styles, /\.quick-send-item:not\(\.quick-send-item-compact\) \.quick-send-main-btn:hover/);
  assert.doesNotMatch(styles, /(?:^|\n)\.quick-send-main-btn:hover\s*\{/);
  assert.doesNotMatch(styles, /\.quick-send-item-compact \.quick-send-main-btn:hover/);
  assert.match(styles, /\.quick-send-label\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.quick-send-main-btn\s*\{[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s);
  assert.match(styles, /\.quick-send-item:not\(\.quick-send-item-compact\):hover \.quick-send-main-btn,[\s\S]*?padding-right:\s*30px;[\s\S]*?padding-left:\s*30px;/);
  assert.match(styles, /\.quick-send-label\s*\{[^}]*line-height:\s*16px;/s);
  assert.match(styles, /\.quick-send-item-compact \.quick-send-label\s*\{[^}]*line-height:\s*16px;/s);
  assert.match(styles, /\.quick-sidebar-controls\s*\{[^}]*grid-template-columns:/s);
  assert.match(renderer, /function updateQuickSidebarEditorState\(\)/);
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

test('sidebar can export the active terminal through an independent save dialog', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="open-log-folder-btn"[\s\S]*id="save-current-tab-btn"/);
  assert.match(styles, /\.sidebar-log-actions\s*\{[^}]*grid-template-columns:/s);
  assert.match(renderer, /function getActiveTerminalExport\(\)/);
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

test('shared send profile is located in the settings tab', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const settings = html.match(/<div id="tab-settings"[\s\S]*?<\/div>\s*<!-- Search Tab -->/)?.[0] || '';
  const send = html.match(/<div id="tab-send"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';

  assert.match(settings, /class="shared-send-profile"/);
  assert.doesNotMatch(send, /class="shared-send-profile"/);
  assert.match(settings, /id="send-mode-select"/);
  assert.match(settings, /id="send-encoding-select"/);
  assert.match(settings, /id="send-append-crlf"/);
  assert.ok(settings.indexOf('class="shared-send-profile"') < settings.indexOf('id="display-controls"'));
  assert.match(styles, /#display-controls\s*\{[^}]*border-top:\s*none;/s);
});

test('text filter tabs do not display a TXT mode badge', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');

  assert.match(renderer, /if \(tab\.dataMode === 'hex'\)/);
  assert.match(renderer, /badge\.className = 'mode-badge hex'/);
  assert.doesNotMatch(renderer, /tab\.dataMode === 'hex' \? 'HEX' : 'TXT'/);
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

test('update confirmation opens a non-closable download window with progress and install flow', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const progressHtml = fs.readFileSync(path.join(root, 'update-progress.html'), 'utf8');
  const progressRenderer = fs.readFileSync(path.join(root, 'update-progress.js'), 'utf8');

  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = false/);
  assert.match(main, /function startUpdateDownload\(info\)/);
  assert.equal((main.match(/autoUpdater\.downloadUpdate\(\)/g) || []).length, 1);
  assert.match(main, /phase === 'downloading' \|\| updatePromptState\.phase === 'downloaded'/);
  assert.match(main, /if \(updatePromptState\.promptPromise\) return updatePromptState\.promptPromise/);
  assert.match(main, /function sendCurrentUpdateStatusToPrefs\(\)/);
  assert.match(main, /if \(updatePromptState\.phase === 'checking'\) \{\s*if \(manual\) updatePromptState\.checkSource = 'manual';/s);
  assert.match(main, /if \(updatePromptState\.phase === 'prompting'\) \{\s*sendCurrentUpdateStatusToPrefs\(\);/s);
  assert.doesNotMatch(main, /promptToInstallDownloadedUpdate/);
  assert.match(main, /const isTrustedSource = sourceWindow === updateDownloadWindow \|\| sourceWindow === prefsWindow/);
  assert.match(main, /if \(updatePromptState\.phase !== 'downloaded' \|\| !isTrustedSource\) return;\s*autoUpdater\.quitAndInstall\(\);/s);
  assert.match(main, /closable:\s*false/);
  assert.match(main, /if \(status === 'error'\) updateDownloadWindow\.setClosable\(true\)/);
  assert.match(main, /sendUpdateDownloadStatus\('progress', progressObj\)/);
  assert.match(main, /sendUpdateDownloadStatus\('downloaded', info\)/);
  assert.match(main, /getManualUpdateDownloadUrl\(info\)/);
  assert.match(main, /UPDATE_FEED_URL = 'https:\/\/trigger-cn\.top\/serialterminal\/'/);
  assert.match(main, /autoUpdater\.setFeedURL\(\{ provider: 'generic', url: UPDATE_FEED_URL \}\)/);
  assert.match(main, /new URL\(String\(exeFile\.url\), UPDATE_FEED_URL\)/);
  assert.match(main, /open-update-download-url/);
  assert.match(progressHtml, /id="progress-fill"/);
  assert.match(progressHtml, /id="install-btn"/);
  assert.match(progressHtml, /id="manual-download-link"/);
  assert.match(progressRenderer, /bytesPerSecond/);
  assert.match(progressRenderer, /open-update-download-url/);
  assert.match(progressRenderer, /ipcRenderer\.send\('quit-and-install'\)/);
});

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

test('serial output is batched per animation frame before terminal rendering', () => {
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(renderer, /function queueSerialOutput\(bytes\)/);
  assert.match(renderer, /const SERIAL_OUTPUT_MAX_FPS = 30/);
  assert.match(renderer, /SERIAL_OUTPUT_FRAME_MS - \(performance\.now\(\) - lastSerialOutputFlushAt\)/);
  assert.match(renderer, /setTimeout\(\(\) => \{[\s\S]*requestAnimationFrame\(flushSerialOutputQueue\)/);
  assert.match(renderer, /const bytes = Buffer\.concat\(queued\)/);
  assert.match(renderer, /queueSerialOutput\(Buffer\.from\(bytes\.buffer, bytes\.byteOffset, bytes\.byteLength\)\)/);
  assert.match(main, /function queueSerialOutput\(data, sessionId\)/);
  assert.match(main, /setImmediate\(flushSerialOutputQueue\)/);
  assert.match(main, /Buffer\.concat\(queued\.map\(entry => entry\.data\), byteCount\)/);
  assert.match(main, /queueSerialOutput\(data, connectionSessionId\)/);
  assert.match(renderer, /function flushPendingSerialOutput\(\)/);
  assert.match(renderer, /flushPendingSerialOutput\(\);\s*if \(normalized !== receiveDisplayMode\)/);
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
  assert.match(main, /const CONFIG_VERSION = 7/);
  assert.match(main, /source\.scrollbackLimit === 100000[\s\S]*?\? 20000/);
  assert.doesNotMatch(renderer, /scrollback:\s*100000/);
  assert.match(renderer, /const serialTerm = new Terminal\(\{[\s\S]*scrollback:\s*20000/);
  assert.match(renderer, /function clearTerminalByTabId[\s\S]*clearTerminalOutput\(serialTerm\)/);
  assert.match(renderer, /clearTerminalOutput\(filterTab\.term\)/);
  assert.match(renderer, /const SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES = 1024 \* 1024/);
  assert.match(renderer, /serialOutputQueuedBytes >= SERIAL_OUTPUT_QUEUE_HIGH_WATER_BYTES[\s\S]*flushPendingSerialOutput\(\)/);
  assert.match(preferencesHtml, /id="scrollbackLimit" min="1000" max="100000"/);
  assert.match(renderer, /const TERMINAL_PENDING_OUTPUT_LIMIT = 2 \* 1024 \* 1024/);
  assert.match(renderer, /function writeTerminalOutput\(term, output\)/);
  assert.match(renderer, /term\.write\(output, \(\) => \{/);
  assert.match(renderer, /while \(state\.pendingLength > TERMINAL_PENDING_OUTPUT_LIMIT/);
  assert.match(renderer, /output\.slice\(-TERMINAL_PENDING_OUTPUT_LIMIT\)/);
  assert.match(renderer, /Display output skipped to limit memory usage/);
  assert.match(renderer, /state\.resetAfterWrite = state\.writing/);
  assert.match(renderer, /if \(state\.resetAfterWrite\) \{[\s\S]*term\.reset\(\)/);
  assert.match(renderer, /writeTerminalOutput\(serialTerm, mainOutput\)/);
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
  assert.match(renderer, /function renderQuickSendLists\(\)/);
  assert.match(renderer, /renderQuickSendContainer\(quickSendListEl\)/);
  assert.match(renderer, /renderQuickSendContainer\(sidebarQuickSendListEl, true\)/);
  assert.match(renderer, /function applyQuickSendElementOrder\(context, orderedIds\)/);
  assert.match(renderer, /sidebarQuickSendOrder = \[\.\.\.orderedIds\]/);
  assert.match(renderer, /quickSendList = reorderQuickSendItems\(quickSendList, orderedIds\)/);
  assert.match(renderer, /function beginQuickSendPointer\(context, event, element\)/);
  assert.match(renderer, /function handleQuickSendPointerMove\(event\)/);
  assert.match(renderer, /function handleQuickSendPointerUp\(event\)/);
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
  assert.match(renderer, /moveTabToPane\(state\.tabId, state\.targetPaneId, \{ insertionIndex: state\.insertionIndex \}\)/);
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
  assert.match(renderer, /sendSerialRequest\(\{ mode: item\.mode, content: item\.content, appendCrLf: item\.appendCrLf, source: 'quick-send' \}/);
  assert.match(renderer, /sendSerialRequest\(\{ mode: item\.mode, content: item\.content, appendCrLf: item\.appendCrLf, source: 'quick-send-trigger' \}/);
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

  assert.match(tabChangedHandler, /refreshSearchCount\(\{ force: true \}\)/);
  assert.match(searchInputHandler, /scheduleSearchRefresh\(\)/);
  assert.doesNotMatch(renderer, /scheduleSearchSelection|selectFirstSearchResult/);
  assert.doesNotMatch(tabChangedHandler, /selectSearchMatch/);
  assert.match(renderer, /findNextBtn\.addEventListener\('click',[\s\S]*?selectSearchMatch\(nextIndex\)/);
  assert.match(renderer, /findPrevBtn\.addEventListener\('click',[\s\S]*?selectSearchMatch\(previousIndex\)/);
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

test('update confirmation opens a controlled download window with progress and install flow', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const progressHtml = fs.readFileSync(path.join(root, 'update-progress.html'), 'utf8');
  const progressRenderer = fs.readFileSync(path.join(root, 'update-progress.js'), 'utf8');

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
  assert.match(main, /UPDATE_FEED_URL = 'https:\/\/trigger-cn\.top\/serialterminal\/'/);
  assert.match(main, /autoUpdater\.setFeedURL\(\{ provider: 'generic', url: UPDATE_FEED_URL \}\)/);
  assert.match(main, /new URL\(String\(exeFile\.url\), UPDATE_FEED_URL\)/);
  assert.match(main, /open-update-download-url/);
  assert.match(progressHtml, /id="progress-fill"/);
  assert.match(progressHtml, /id="install-btn"/);
  assert.match(progressHtml, /id="cancel-btn"/);
  assert.match(progressHtml, /id="manual-download-link"/);
  assert.match(progressRenderer, /bytesPerSecond/);
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
  assert.match(main, /if \(!token\.cancelled\) log\.error\('Failed to download update:', error\)/);
  assert.match(main, /function cancelUpdateDownload\(\)[\s\S]*updateDownloadToken\.cancel\(\)/);
  assert.match(main, /if \(token\.cancelled\) \{[\s\S]*sendUpdateDownloadStatus\('cancelled'\);[\s\S]*closeUpdateDownloadWindow\(\)/);
  assert.match(main, /ipcMain\.on\('cancel-update-download'[\s\S]*cancelUpdateDownload\(\)/);
  assert.doesNotMatch(main, /pause-update-download|resume-update-download|phase = 'paused'/);
});

test('automatic update checks every two hours and reminds every eight hours', () => {
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

  assert.match(main, /UPDATE_CHECK_INTERVAL_MS = 2 \* 60 \* 60 \* 1000/);
  assert.match(main, /UPDATE_PROMPT_INTERVAL_MS = 8 \* 60 \* 60 \* 1000/);
  assert.match(main, /setInterval\(\(\) => \{\s*checkForAppUpdates\(\{ scheduled: true \}\);\s*\}, UPDATE_CHECK_INTERVAL_MS\)/s);
  assert.match(main, /function shouldShowAutomaticUpdatePrompt\(info, now = Date\.now\(\)\)/);
  assert.match(main, /currentConfig\.skippedUpdateVersion === version/);
  assert.match(main, /currentConfig\.lastUpdatePromptVersion !== version/);
  assert.match(main, /now - currentConfig\.lastUpdatePromptAt >= UPDATE_PROMPT_INTERVAL_MS/);
  assert.match(main, /saveConfig\(\{ lastUpdatePromptVersion: version, lastUpdatePromptAt: now \}\)/);
  assert.match(main, /if \(updatePromptState\.checkSource === 'scheduled'\) \{\s*if \(shouldShowAutomaticUpdatePrompt\(info\)\) \{\s*offerAvailableUpdate\(info, false\);/s);
  assert.match(main, /lastUpdatePromptVersion: ''/);
  assert.match(main, /lastUpdatePromptAt: 0/);
  assert.match(main, /if \(updateCheckTimer\) clearInterval\(updateCheckTimer\)/);
});

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

test('collapsed sidebar keeps tools scrollable and expand control outside the scroll area', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const toolbar = html.match(/<div class="sidebar-collapsed-toolbar"[\s\S]*?<\/div>\s*<!-- Persistent Header -->/)?.[0] || '';
  const scrollStart = toolbar.indexOf('class="sidebar-tool-scroll"');
  const scrollEnd = toolbar.lastIndexOf('</div>');
  const expandIndex = toolbar.indexOf('id="sidebar-expand-btn"');

  assert.ok(scrollStart >= 0, 'scrollable sidebar tool group was not found');
  assert.ok(expandIndex >= 0 && expandIndex < scrollStart, 'expand button must remain outside the scrollable tool group');
  assert.ok(scrollEnd > scrollStart);
  assert.match(styles, /\.sidebar-tool-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /#sidebar-expand-btn\s*\{[^}]*flex-shrink:\s*0;/s);
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

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer.js'), 'utf8');
function load(context, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
}
function fixture(focus) {
    const calls = [];
    const shell = { id: 'tab-shell-1', title: 'Shell', term: { text: 'shell text', getSelection: () => 'shell selection' }, searchAddon: {} };
    const filter = { id: 'filter-b', title: 'B filter', term: { text: 'filter text' }, searchAddon: {} };
    const context = vm.createContext({ activeGroupId: 'default', focusedWorkspaceTabId: focus,
        workspaceModel: { focusedTabId: focus, tabs: { [focus]: { id: focus } } },
        serialGroups: [{ id: 'default' }, { id: 'b' }],
        getGroupActiveTabId: () => 'tab-main', getGroupActiveTabInfo: () => ({ tabId: 'tab-main' }),
        groupIdForWorkspaceTab: id => id === 'filter-b' ? 'b' : 'default',
        mainTabId: id => id === 'default' ? 'tab-main' : `tab-main-${id}`,
        filterTabsStore: { getList: id => id === 'b' ? [filter] : [] },
        chartTabsStore: { getList: () => [] }, getShellTabState: id => id === shell.id ? shell : null,
        getMainTabTitle: () => 'Main', getFilterTabLogTitle: tab => tab.title, getShellTabLogTitle: () => 'Shell',
        getSerialGroupById: () => ({ title: 'Main' }), tr: key => key,
        serialRuntimes: { get: () => ({ term: { text: 'main text' }, searchAddon: {} }) },
        getSerialRuntime: () => ({ term: { text: 'main text' }, searchAddon: {} }),
        getSerialTerm: () => ({ text: 'main text' }), getTerminalPlainText: term => term?.text || '',
        clearTerminalByTabId: id => calls.push(id) });
    if (source.includes('function getCurrentTerminalTarget(')) load(context, 'getCurrentTerminalTarget');
    for (const name of ['getActiveSearchTarget', 'getActiveTerminalExport', 'clearActiveTerminal']) load(context, name);
    return { context, calls, run: code => vm.runInContext(code, context), shell, filter };
}
test('root Shell focus drives search, selection, export and clear while control group stays unchanged', () => {
    const f = fixture('tab-shell-1');
    assert.equal(f.run('getActiveSearchTarget().id'), 'tab-shell-1');
    assert.equal(f.run('getActiveSearchTarget().term.getSelection()'), 'shell selection');
    assert.equal(f.run('getActiveTerminalExport().content'), 'shell text');
    f.run('clearActiveTerminal()'); assert.deepEqual(f.calls, ['tab-shell-1']);
    assert.equal(f.context.activeGroupId, 'default');
});
test('non-control filter focus resolves its own terminal', () => {
    const f = fixture('filter-b');
    assert.equal(f.run('getActiveSearchTarget().term'), f.filter.term);
    assert.equal(f.run('getActiveTerminalExport().content'), 'filter text');
});
test('chart focus has no terminal capability and never exports or clears another group', () => {
    const f = fixture('chart-b');
    assert.equal(f.run('getActiveSearchTarget().term'), null);
    assert.equal(f.run('getActiveTerminalExport()'), null);
    f.run('clearActiveTerminal()'); assert.deepEqual(f.calls, []);
});

test('render focus changes refresh search immediately and stale fit events cannot write pane activation', () => {
    const listeners = new Map(), timers = [], calls = [];
    const context = vm.createContext({ workspaceModel: { focusedTabId: 'tab-shell-1' }, focusedWorkspaceTabId: 'tab-shell-1', lastNotifiedWorkspaceFocus: null,
        workspaceTabState: () => ({}), renderWorkspace() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        window: { addEventListener: (name, fn) => listeners.set(name, fn), dispatchEvent: e => listeners.get(e.type)?.(e) },
        clearTimeout() {}, searchDebounceTimer: null, resetSearchState: () => calls.push('reset'), clearSearchSelection: () => calls.push('clear'),
        updateSearchTargetLabel: () => calls.push('label'), searchInput: { value: 'text' }, refreshSearchCount: () => calls.push('search'), updateSearchResultCount() {},
        setTimeout: fn => timers.push(fn), setActivePane: () => assert.fail('Delayed event wrote layout'),
        tabModel: { buildRenderPlan: () => ({ panelIds: ['tab-shell-1'] }) } });
    load(context, 'renderWorkspaceNow');
    const searchStart = source.indexOf("window.addEventListener('workspace-focus-changed',");
    assert.ok(searchStart >= 0);
    vm.runInContext(source.slice(searchStart, source.indexOf('\n});', searchStart) + 4), context);
    vm.runInContext('renderWorkspaceNow(); renderWorkspaceNow()', context);
    assert.deepEqual(calls, ['reset', 'clear', 'label', 'search']);
    const fitStart = source.indexOf("window.addEventListener('main-tab-changed',");
    vm.runInContext(source.slice(fitStart, source.indexOf('\n});', fitStart) + 4), context);
    listeners.get('main-tab-changed')({ detail: { tabId: 'tab-main', paneId: 'stale-pane' } });
    timers.forEach(fn => fn());
});

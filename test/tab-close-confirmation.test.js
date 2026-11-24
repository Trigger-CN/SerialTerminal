'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { t, translations } = require('../src/common/i18n');
const { fixture: workspace } = require('./workspace-tree-fixture');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
function fn(name) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, `Missing renderer function ${name}`);
    return source.slice(start, end);
}
function fixture(kind, response = 1) {
    const effects = [], dialogs = [];
    let resolveDialog;
    const tab = { id: kind === 'group' ? 'b' : `${kind}-b`, title: 'Target title', sessionCreateTimer: null,
        term: { dispose: () => effects.push('dispose') }, element: { remove: () => effects.push('panel') }, btn: { remove: () => effects.push('button') } };
    const list = [tab];
    const context = vm.createContext({ pendingTabCloseConfirmations: new Set(), shellTabs: kind === 'shell' ? list : [],
        workspaceModel: null, activeGroupId: 'default', focusedWorkspaceTabId: 'unrelated',
        filterTabsStore: { getList: () => list }, chartTabsStore: { getList: () => list },
        groupIdForWorkspaceTab: () => 'b', getGroupActiveTabId: () => 'tab-main', mainTabId: () => 'tab-main',
        resolveSerialGroupId: id => id, REGISTRY_DEFAULT_GROUP_ID: 'default', getSerialGroupById: id => id === tab.id ? list[0] : null,
        tr: (key, params) => t('en', key, params), setActionStatus: value => effects.push(['status', value]),
        showTabCloseDialog: options => { dialogs.push(options); return response === 'pending' ? new Promise(resolve => { resolveDialog = resolve; }) : response === 'error' ? Promise.reject(new Error('dialog failed')) : Promise.resolve(response === 0); },
        ipcRenderer: { send: (channel, payload) => effects.push([channel, payload]) },
        destroyFilterTab: () => effects.push('destroy-filter'), destroyChartTab: () => effects.push('destroy-chart'),
        getGroupWorkspaceManager: () => ({ removeTab: id => effects.push(['remove', id]) }),
        persistFilterTabs: () => effects.push('save-filter'), persistChartTabs: () => effects.push('save-chart'), persistGroupWorkspaceLayout: () => effects.push('save-layout'),
        unobserveTerminalSearchChanges: () => effects.push('unobserve'), persistShellTabs: () => effects.push('save-shell'),
        updateTabTitles: () => effects.push('titles'), renderWorkspaceNow: () => effects.push('render'), persistWorkspaceLayout: () => effects.push('save-workspace'),
        clearTimeout: () => effects.push('timer'), document: { getElementById: () => null, querySelectorAll: () => [] } });
    if (source.includes('function requestTabCloseConfirmation(')) vm.runInContext(fn('requestTabCloseConfirmation'), context);
    const name = { group: 'closeSerialGroup', shell: 'closeShellTab', filter: 'closeFilterTab', chart: 'closeChartTab' }[kind];
    vm.runInContext(fn(name), context);
    return { context, tab, list, effects, dialogs, close: options => context[name](tab.id, options), resolve: value => resolveDialog(value) };
}
for (const kind of ['shell', 'filter', 'chart', 'group']) {
    test(`${kind} close cancellation preserves the tab and all resources`, async () => {
        const f = fixture(kind), before = workspace(true); f.context.workspaceModel = before;
        assert.equal(await f.close(), false);
        assert.equal(f.dialogs.length, 1);
        if (kind !== 'group') assert.equal(f.dialogs[0].anchor, f.tab.btn);
        assert.match(f.dialogs[0].message, /Target title/);
        assert.deepEqual(f.effects, []); assert.equal(f.list[0], f.tab); assert.equal(f.tab.closed, undefined);
        assert.equal(f.context.workspaceModel, before); assert.equal(f.context.focusedWorkspaceTabId, 'unrelated');
    });
    test(`${kind} repeated close has one pending prompt and stale confirmation cannot close a replacement`, async () => {
        const f = fixture(kind, 'pending'), first = f.close(), second = f.close();
        await Promise.resolve();
        assert.equal(f.dialogs.length, 1); assert.equal(await second, false);
        f.list[0] = { ...f.tab }; f.resolve(true);
        assert.equal(await first, false); assert.deepEqual(f.effects, []);
        assert.equal(f.context.pendingTabCloseConfirmations.size, 0);
    });
}
for (const kind of ['shell', 'filter', 'chart']) {
    test(`${kind} confirmation closes exactly once after approval`, async () => {
        const f = fixture(kind, 0);
        assert.equal(await f.close(), true); assert.equal(f.dialogs.length, 1); assert.equal(f.list.length, 0);
        assert.equal(f.effects.filter(value => value === (kind === 'shell' ? 'dispose' : `destroy-${kind}`)).length, 1);
        if (kind === 'shell') assert.equal(f.effects.filter(value => Array.isArray(value) && value[0] === 'close-shell-tab-session').length, 1);
    });
    test(`${kind} internal cleanup bypasses confirmation explicitly`, () => {
        const f = fixture(kind); f.close({ confirm: false });
        assert.equal(f.dialogs.length, 0); assert.equal(f.list.length, 0);
    });
}
test('dialog failure keeps the tab open and clears pending state', async () => {
    const f = fixture('shell', 'error'); assert.equal(await f.close(), false);
    assert.equal(f.list[0], f.tab); assert.equal(f.tab.closed, undefined);
    assert.equal(f.context.pendingTabCloseConfirmations.size, 0);
    assert.equal(f.effects.length, 1); assert.match(f.effects[0][1], /dialog failed/);
});
test('Shell and group prompts describe the affected resources', async () => {
    for (const kind of ['shell', 'group']) { const f = fixture(kind); await f.close(); assert.match(f.dialogs[0].detail, kind === 'shell' ? /Shell session/ : /disconnect/); }
});
test('default group and missing tabs do not prompt', async () => {
    const f = fixture('group'); assert.equal(await f.context.closeSerialGroup('default'), false); assert.equal(f.dialogs.length, 0);
    for (const kind of ['shell', 'filter', 'chart']) { const empty = fixture(kind); empty.list.length = 0; await empty.close(); assert.equal(empty.dialogs.length, 0); }
});
for (const kind of ['shell', 'filter', 'chart']) {
    test(`${kind} context-menu close uses the same confirmation and awaits cancellation`, async () => {
        const f = fixture(kind);
        f.context.getShellTabState = id => f.context.shellTabs.find(tab => tab.id === id);
        vm.runInContext(`async ${fn('handleTerminalContextMenuAction')}`, f.context);
        await f.context.handleTerminalContextMenuAction({ action: `close-${kind}-tab`, terminalType: kind, tabId: f.tab.id, groupId: 'b' });
        assert.equal(f.dialogs.length, 1); assert.deepEqual(f.effects, []); assert.equal(f.list[0], f.tab);
    });
}
test('tab-close confirmation uses the shared application dialog rather than native IPC', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    assert.match(html, /id="tab-close-dialog" class="app-dialog-overlay tab-close-dialog-overlay hidden"/);
    assert.match(html, /class="app-dialog tab-close-dialog" role="alertdialog" aria-modal="true"/);
    assert.match(html, /aria-describedby="tab-close-dialog-message tab-close-dialog-detail"/);
    for (const className of ['app-dialog-header', 'app-dialog-body', 'app-dialog-actions']) assert.match(html.slice(html.indexOf('id="tab-close-dialog"'), html.indexOf('id="rename-tab-dialog"')), new RegExp(`class="${className}"`));
    assert.doesNotMatch(main, /confirm-tab-close/);
    assert.doesNotMatch(fn('requestTabCloseConfirmation'), /ipcRenderer\.invoke/);
});

test('serial group confirmation resolves the visible group anchor, not the active serial group', async () => {
    const f = fixture('group');
    const hidden = { dataset: { groupId: 'b' }, getClientRects: () => [] };
    const other = { dataset: { groupId: 'default' }, getClientRects: () => [{}] };
    const visible = { dataset: { groupId: 'b' }, getClientRects: () => [{}] };
    f.context.document.querySelectorAll = () => [hidden, other, visible];
    await f.close();
    assert.equal(f.dialogs[0].anchor, visible);
});

test('explicit group anchor keeps confirmation at the exact clicked region', async () => {
    const f = fixture('group'), anchor = {};
    await f.close({ anchor });
    assert.equal(f.dialogs[0].anchor, anchor);
});
test('close-confirmation translations exist in every supported language', () => {
    for (const language of Object.keys(translations)) for (const key of ['confirmCloseTab', 'closeTabWarning', 'closeShellTabWarning', 'closeGroupTabWarning', 'closeTabConfirmFailed']) {
        assert.equal(typeof translations[language].main[key], 'string', `${language}:${key}`);
        assert.notEqual(t(language, `main.${key}`, { title: 'Target', error: 'error' }), `main.${key}`);
    }
});

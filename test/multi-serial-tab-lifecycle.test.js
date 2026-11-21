'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer.js'), 'utf8');
function load(context, name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
}
function fixture() {
    const events = [], filters = new Map(), charts = new Map();
    function tab(id) { return { id, renderFrame: 7, outsideClickListener: {}, term: { dispose: () => events.push(`term:${id}`) },
        stream: { dispose: () => events.push(`stream:${id}`) }, parserWorker: { close: () => events.push(`worker:${id}`) },
        view: { destroy: () => events.push(`view:${id}`) }, element: { remove() {} }, btn: { remove() {} } }; }
    filters.set('b', [tab('filter-b')]); charts.set('b', [tab('chart-b')]);
    const groups = [{ id: 'default', title: 'A' }, { id: 'b', title: 'B' }];
    const workspace = importWorkspace({ groups: groups.map(g => ({ ...g, panes: [{ id: `pane-${g.id}`, tabIds: [g.id === 'default' ? 'tab-main' : 'tab-main-b', ...(g.id === 'b' ? ['filter-b', 'chart-b'] : [])], activeTabId: g.id === 'default' ? 'tab-main' : 'tab-main-b' }] })),
        filterTabs: { b: [{ id: 'filter-b' }] }, chartTabs: { b: [{ id: 'chart-b' }] }, shellTabs: [{ id: 'tab-shell-1' }], focusedTabId: 'tab-shell-1' });
    const store = map => ({ getList: id => map.get(id) || [], removeList: id => map.delete(id) });
    const context = vm.createContext({ workspaceModel: workspace, tabModel: model, serialGroups: groups, activeGroupId: 'b', focusedWorkspaceTabId: 'tab-shell-1',
        REGISTRY_DEFAULT_GROUP_ID: 'default', resolveSerialGroupId: id => id, getSerialGroupById: id => context.serialGroups.find(g => g.id === id),
        mainTabId: id => id === 'default' ? 'tab-main' : `tab-main-${id}`, mainTabButtonId: id => id, serialContainerId: id => id,
        groupWorkspaceContainerId: id => id, groupIdForWorkspaceTab: () => 'b',
        filterTabsStore: store(filters), chartTabsStore: store(charts), persistFilterTabsTimers: new Map(),
        shellTabs: [{ id: 'tab-shell-1' }], getShellTabOwner: () => null,
        groupWorkspaceLayouts: new Map(), groupWorkspaceManagers: new Map(), groupLayoutSnapshots: new Map(),
        serialRuntimes: { get: () => null, release: id => events.push(`runtime:${id}`) }, serialGroupIo: new Map(), serialOutputBuckets: { clear() {} }, serialGroupContext: { removeContext() {} }, serialGroupRegistry: { removeGroup() {} },
        serialConnectRequests: new Map(), serialConnectionSessions: new Map(), serialWriteChains: new Map(), serialConnectingGroups: new Set(), serialReconnectingGroups: new Set(), serialDisconnectWaiters: new Map(), serialInputBoundGroups: new Set(['b']),
        resetQuickTriggerReceive: () => {}, resetTextReceive: () => {},
        ipcRenderer: { send: (name, payload) => events.push([name, payload]), invoke: async () => ({ response: 0 }) },
        pendingTabCloseConfirmations: new Set(), tr: key => key,
        document: { getElementById: () => null, removeEventListener: () => events.push('listener') },
        clearTimeout: () => {}, cancelAnimationFrame: () => events.push('frame'),
        unobserveTerminalSearchChanges: () => events.push('search'), chartSettingsState: null, chartExportState: null,
        reclaimSharedGroupTabRow() {}, reclaimGroupAddButton() {}, reclaimShellAddButton() {},
        removeTabFromWorkspace() {}, setActiveGroupWorkspace() {}, persistSerialGroups() {}, pruneGroupWorkspaceSplit() {}, renderSerialGroupTabBar() {}, setActionStatus() {},
        updateTabTitles() {}, persistFilterTabs() {}, persistChartTabs() {}, persistGroupWorkspaceLayout() {},
        getTabPaneId: () => 'pane-b', switchPaneTab: () => { context.focusedWorkspaceTabId = 'tab-main-b'; },
        applyActiveSerialGroup: options => events.push(['sync', context.activeGroupId, options]),
        removeSerialGroup: (list, id) => ({ groups: list.filter(g => g.id !== id) }),
        dispatchWorkspaceAction: action => { const result = model.applyWorkspaceAction(context.workspaceModel, action); if (result.ok) { context.workspaceModel = result.workspace; context.focusedWorkspaceTabId = result.workspace.focusedTabId; } return result; },
        getGroupWorkspaceManager: () => ({ removeTab: id => { const result = context.dispatchWorkspaceAction({ type: 'close', tabId: id }); return { ...result, nextActiveTabId: 'tab-main-b' }; } }) });
    for (const name of ['destroyFilterTab', 'destroyChartTab', 'destroySerialGroupResources', 'clearSerialGroupAsyncState']) if (source.includes(`function ${name}(`)) load(context, name);
    for (const name of ['requestTabCloseConfirmation', 'resolveGroupAfterClose', 'closeSerialGroup', 'closeFilterTab', 'closeChartTab']) load(context, name);
    return { context, events, filters, charts, run: code => vm.runInContext(code, context) };
}
test('closing control group synchronizes sidebar without replacing model Shell focus', async () => {
    const f = fixture(); assert.equal(await f.run("closeSerialGroup('b')"), true);
    assert.equal(f.context.activeGroupId, 'default');
    assert.equal(f.events.filter(e => Array.isArray(e) && e[0] === 'sync').length, 1);
    assert.equal(f.context.workspaceModel.focusedTabId, 'tab-shell-1');
    assert.equal(f.context.focusedWorkspaceTabId, 'tab-shell-1');
});
test('group close destroys child resources once, flushes owned logs and permits clean ID reuse', async () => {
    const f = fixture(); await f.run("closeSerialGroup('b')"); await f.run("closeSerialGroup('b')");
    for (const event of ['term:filter-b', 'worker:chart-b', 'stream:chart-b', 'view:chart-b', 'listener', 'frame', 'runtime:b']) assert.equal(f.events.filter(e => e === event).length, 1, event);
    assert.ok(f.events.some(e => Array.isArray(e) && e[0] === 'flush-tab-log' && e[1].tabId === 'filter-b'));
    assert.equal(f.context.serialInputBoundGroups.has('b'), false);
    assert.equal(f.context.workspaceModel.tabs['tab-shell-1'].kind, 'shell');
});
test('closing background group preserves control selection', async () => {
    const f = fixture(); f.context.activeGroupId = 'default'; await f.run("closeSerialGroup('b')");
    assert.equal(f.context.activeGroupId, 'default');
    assert.equal(f.events.some(e => Array.isArray(e) && e[0] === 'sync'), false);
});

for (const kind of ['Filter', 'Chart']) test(`closing background ${kind} preserves Shell focus`, async () => {
    const f = fixture(); await f.run(`close${kind}Tab('${kind.toLowerCase()}-b')`);
    assert.equal(f.context.focusedWorkspaceTabId, 'tab-shell-1');
    assert.equal(f.context.workspaceModel.focusedTabId, 'tab-shell-1');
});

test('connected group closes only after one native confirmation without prompting for each child', async () => {
    const f = fixture(), dialogs = []; f.context.serialGroups[1].status = 'connected';
    f.context.ipcRenderer.invoke = async (channel, payload) => { dialogs.push({ channel, payload }); assert.deepEqual(f.events, []); return { response: 0 }; };
    assert.equal(await f.context.closeSerialGroup('b'), true); assert.equal(dialogs.length, 1);
    assert.equal(f.events.filter(event => Array.isArray(event) && event[0] === 'disconnect-serial').length, 1);
    assert.equal(f.events.filter(event => event === 'term:filter-b').length, 1);
    assert.equal(f.context.workspaceModel.tabs['tab-shell-1'].kind, 'shell');
});
test('cancelled group close preserves connected state, children, layout and control selection', async () => {
    const f = fixture(), before = f.context.workspaceModel, filters = f.filters.get('b'), charts = f.charts.get('b');
    f.context.serialGroups[1].status = 'connected'; f.context.ipcRenderer.invoke = async () => ({ response: 1 });
    assert.equal(await f.context.closeSerialGroup('b'), false);
    assert.equal(f.context.workspaceModel, before); assert.equal(f.context.activeGroupId, 'b');
    assert.equal(f.context.serialGroups[1].status, 'connected'); assert.equal(f.filters.get('b'), filters); assert.equal(f.charts.get('b'), charts);
    assert.deepEqual(f.events, []);
});

for (const scenario of ['late-success', 'late-failure', 'config-echo', 'early-disconnect']) test(`pending connection handles ${scenario}`, async () => {
    const failure = scenario === 'late-failure';
    const { SerialGroupRegistry } = require('../src/serial/serial-group-registry');
    const registry = new SerialGroupRegistry(); registry.ensureGroup('b');
    let group = { id: 'b' }, finish;
    const events = [];
    const context = vm.createContext({ activeGroupId: 'b', REGISTRY_DEFAULT_GROUP_ID: 'default',
        resolveSerialGroupId: id => id, getSerialGroupById: () => group,
        serialGroupRegistry: registry, serialConnectRequestSequence: 0, serialConnectRequests: new Map(), serialConnectionSessions: new Map(),
        serialConnectingGroups: new Set(), serialReconnectingGroups: new Set(), serialWriteChains: new Map(), serialDisconnectWaiters: new Map(),
        isGroupConnecting: id => context.serialConnectingGroups.has(id), getGroupSerialOptionsForConnect: () => ({ path: 'COM_B' }),
        document: { getElementById: () => null }, getGroupDisplay: () => ({}),
        setGroupConnectBusy: () => events.push('busy'), getHexFormatter: () => ({ reset() {} }), resetTextReceive() {}, resetQuickTriggerReceive() {},
        ipcRenderer: { invoke: () => new Promise((resolve, reject) => { finish = failure ? reject : resolve; }), send: () => events.push('send') },
        serialRuntimes: { getOrCreate: () => { events.push('revived'); return { term: { write() {} } }; } },
        chartTabsStore: { getList: () => [] }, setActionStatus: () => events.push('status'), alert: () => events.push('alert'),
        refreshConnectButtonState: () => events.push('refresh'),
        // 连接成功后 renderer 会刷新分组标签与主标签的连接指示；本用例只关心连接生命周期。
        renderSerialGroupTabBar: () => events.push('tabs'), syncAllGroupMainTabTitles: () => events.push('titles') });
    load(context, 'clearSerialGroupAsyncState');
    const start = source.indexOf('async function connectSerialFromUi(');
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context);
    const pending = vm.runInContext("connectSerialFromUi({groupId:'b'})", context);
    if (scenario === 'config-echo') {
        group = { ...group, title: 'Updated' };
        Object.assign(context, { clearChartDataSession() {}, serialGroupContext: { resetLineCounters() {} }, bindGroupTerminalInput() {} });
        finish({ sessionId: 17 }); await pending;
        assert.equal(registry.getGroup('b').connected, true);
        assert.equal(context.serialConnectingGroups.has('b'), false);
        assert.ok(events.includes('revived'));
        return;
    }
    if (scenario === 'early-disconnect') {
        let listener, awakened = false;
        Object.assign(context, { ipcRenderer: { on: (_, fn) => { listener = fn; }, send() {} },
            flushTextReceive() {}, filterTabs: [], isActiveSerialGroup: () => false,
            serialRuntimes: { get: () => null }, getGroupDisplay: () => ({}) });
        context.serialDisconnectWaiters.set('b', [() => { awakened = true; }]);
        const offset = source.indexOf("ipcRenderer.on('serial-disconnected',");
        vm.runInContext(source.slice(offset, source.indexOf('\n});', offset) + 4), context);
        listener({}, null, { groupId: 'b', sessionId: 17, requestId: context.serialConnectRequests.get('b') });
        assert.equal(awakened, true);
        events.length = 0; finish({ sessionId: 17 }); await pending;
        assert.equal(registry.getGroup('b').connected, false); assert.deepEqual(events, []);
        return;
    }
    vm.runInContext("clearSerialGroupAsyncState('b')", context); registry.removeGroup('b');
    group = { id: 'b' }; registry.ensureGroup('b'); context.serialConnectingGroups.add('b'); context.serialConnectRequests.set('b', {});
    events.length = 0; finish(failure ? new Error('late failure') : { sessionId: 17 }); await pending;
    assert.deepEqual(events, []); assert.equal(registry.getGroup('b').connected, false); assert.equal(context.serialConnectingGroups.has('b'), true);
});

test('failed old-group logs stay on their original paths across same-ID reconnect', async () => {
    const { createFixture } = require('./main-serial-fixture');
    for (const perTab of [false, true]) {
        const f = createFixture({ saveAllTabsLogToFiles: perTab }); await f.connect('b', 'COM_A');
        f.run("writeTabLog('tab-main-b','Main','OLD_MAIN','b');writeTabLog('tab-filter-b','Filter','OLD_FILTER','b');bufferRawSerialBytes(Buffer.from('OLD_RAW'),'b')");
        f.fail('COM_A'); f.listeners['disconnect-serial']({}, { groupId: 'b' });
        await assert.rejects(f.connect('b', 'COM_B'), /Failed to flush/);
        assert.equal(f.run("getSerialSession('b').portPath"), 'COM_A');
        f.fail(''); await f.connect('b', 'COM_B'); f.run('flushPendingLogs()');
        assert.match(f.text('COM_A'), /OLD_RAW/); assert.match(f.text('COM_A'), /OLD_MAIN/); if (perTab) assert.match(f.text('COM_A'), /OLD_FILTER/);
        assert.doesNotMatch(f.text('COM_B'), /OLD_/);
    }
});

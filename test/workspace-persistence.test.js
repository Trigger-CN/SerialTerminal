'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { serializeWorkspaceLayout, restoreWorkspaceLayout } = require('../src/workspace/workspace-layout-state');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
function section(start, end) {
    const offset = source.indexOf(start), limit = source.indexOf(end, offset);
    assert.ok(offset >= 0 && limit > offset, start);
    return source.slice(offset, limit);
}
function fixture() {
    const timers = new Map(), sent = [], listeners = {};
    let seq = 0;
    const context = vm.createContext({
        serialGroups: [{ id: 'default', title: 'Serial', portPath: 'COM8' }], activeGroupId: 'default',
        REGISTRY_DEFAULT_GROUP_ID: 'default', currentConfig: {}, isApplyingConfig: false, isRestoringWorkspaceSession: false,
        workspaceModel: importWorkspace({ groups: [{ id: 'default' }], filterTabs: { default: [{ id: 'f1' }] }, shellTabs: [{ id: 'tab-shell-1' }] }),
        filterTabsStore: { getList: () => [{ id: 'f1', filterText: 'needle', paneId: 'stale' }] },
        chartTabsStore: { getList: () => [] }, shellTabs: [{ id: 'tab-shell-1', title: 'Shell', profileId: 'p' }],
        getTabPaneId: id => model.paneOfTab(context.workspaceModel, context.workspaceModel.tabs[id])?.pane.id || null,
        serializeWorkspaceLayout, decodeWorkspaceLayout: restoreWorkspaceLayout, importWorkspace,
        setTimeout: fn => { const id = ++seq; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
        ipcRenderer: { send: (channel, payload) => sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }) },
        window: { addEventListener: (name, fn) => { listeners[name] = fn; } }
    });
    vm.runInContext(section('let workspaceLayoutSaveTimer = null;', 'function initializeWorkspaceModel()'), context);
    vm.runInContext(section('function serializeFilterTab(', 'function persistFilterTabs('), context);
    vm.runInContext(section('function serializeChartTab(', 'function updateChartStats('), context);
    return { context, sent, listeners, timers, flush() { for (const [id, fn] of timers) { timers.delete(id); fn(); } } };
}
test('workspace saves coalesce latest layout and all business identities in one payload', () => {
    const f = fixture(); const { context: c } = f;
    c.scheduleWorkspaceLayoutSave(); c.scheduleWorkspaceLayoutSave();
    c.shellTabs.push({ id: 'tab-shell-2', profileId: 'p2' });
    c.workspaceModel = model.applyWorkspaceAction(c.workspaceModel, { type: 'add-leaf', leaf: { id: 'tab-shell-2', kind: 'shell' } }).workspace;
    assert.equal(f.sent.length, 0); assert.equal(f.timers.size, 1); f.flush();
    assert.equal(f.sent.length, 1);
    const payload = f.sent[0].payload;
    assert.equal(payload.serialGroups[0].filterTabs[0].filterText, 'needle');
    assert.notEqual(payload.serialGroups[0].filterTabs[0].paneId, 'stale');
    assert.deepEqual(payload.shellTabs.map(tab => tab.id), ['tab-shell-1', 'tab-shell-2']);
    assert.equal(payload.workspaceLayoutState.version, 1);
    assert.deepEqual(payload.filterTabs, payload.serialGroups[0].filterTabs);
});
test('restoring blocks queued and new saves; beforeunload flushes latest pending snapshot', () => {
    const f = fixture(), c = f.context;
    c.scheduleWorkspaceLayoutSave(); c.isApplyingConfig = true; f.flush(); assert.equal(f.sent.length, 0);
    c.scheduleWorkspaceLayoutSave(); assert.equal(f.timers.size, 0);
    c.isApplyingConfig = false; c.scheduleWorkspaceLayoutSave(); f.listeners.beforeunload();
    assert.equal(f.sent.length, 1); assert.equal(f.timers.size, 0);
    f.flush(); assert.equal(f.sent.length, 1);
});


test('explicit reset cancels pending saves and replaces members under the restore guard', () => {
    const f = fixture(), c = f.context, calls = [];
    c.serialGroups.push({ id: 'g-1' });
    c.groupWorkspaceManagers = new Map(); c.groupWorkspaceLayouts = new Map(); c.groupLayoutSnapshots = new Map();
    c.closeShellTab = id => { assert.equal(c.isRestoringWorkspaceSession, true); calls.push(['shell', id]); };
    c.destroySerialGroupResources = id => { assert.equal(c.isRestoringWorkspaceSession, true); calls.push(['resources', id]); };
    c.serialGroupRegistry = { invalidateSession: id => calls.push(['invalidate', id]) };
    c.resetTextReceive = () => {}; c.serialOutputBuckets = { clear() {} }; c.serialTerm = { clear() {} }; c.bindGroupTerminalInput = () => {};
    c.closeSerialGroup = (id, options) => calls.push(['group', id, options.confirm]);
    c.applyConfig = config => { assert.equal(c.workspaceModel, null); calls.push(['config', config.marker]); };
    vm.runInContext("let lastAppliedWorkspaceLayoutKey = '';\n" + section('function restoreWorkspaceConfig(', 'function applyConfig('), c);
    c.scheduleWorkspaceLayoutSave(); c.restoreWorkspaceConfig({ marker: 'reset' }); f.flush();
    assert.equal(f.sent.some(item => item.channel === 'save-config'), false);
    assert.equal(c.isRestoringWorkspaceSession, false);
    assert.ok(calls.some(call => call[0] === 'group' && call[1] === 'g-1' && call[2] === false));
    assert.deepEqual(calls.at(-1), ['config', 'reset']);
});


test('initialization decodes once, clears import caches and preserves business terminals', () => {
    const f = fixture(), c = f.context;
    const saved = serializeWorkspaceLayout(c.workspaceModel), terminal = {};
    c.currentConfig.workspaceLayoutState = saved; c.workspaceModel = null;
    c.shellTabs[0].term = terminal; c.shellTabs[0].hostGroupId = 'default';
    c.buildLiveWorkspaceSections = () => ({ groups: [{ id: 'default' }], filterTabs: { default: [{ id: 'f1' }] }, shellTabs: c.shellTabs });
    c.groupWorkspaceManagers = new Map([['stale', {}]]); c.groupWorkspaceLayouts = new Map([['stale', {}]]); c.groupLayoutSnapshots = new Map([['stale', {}]]);
    c.setActiveGroupWorkspace = () => {}; c.renderWorkspaceNow = () => {};
    vm.runInContext('let focusedWorkspaceTabId = null;\n' + section('function initializeWorkspaceModel()', '// 投影出当前工作区的模型树。'), c);
    assert.equal(c.initializeWorkspaceModel(), true); const ws = c.workspaceModel;
    assert.deepEqual(serializeWorkspaceLayout(ws), saved);
    assert.equal(c.groupWorkspaceLayouts.size, 0); assert.equal(c.groupLayoutSnapshots.size, 0);
    assert.equal(c.shellTabs[0].hostGroupId, undefined); assert.equal(c.shellTabs[0].term, terminal);
    assert.equal(c.initializeWorkspaceModel(), false); assert.equal(c.workspaceModel, ws);
});


test('startup mounts business tabs into an existing pane before layout decoding; settings never revive closed tabs', () => {
    const created = [];
    const c = vm.createContext({ workspaceModel: null, filterTabs: [], shellTabs: [], chartTabs: [],
        config: { filterTabs: [{ id: 'f', paneId: 'pane-9' }], shellTabs: [{ id: 's', paneId: 'pane-9' }], chartTabs: [{ id: 'c', paneId: 'pane-9' }] },
        isRestoringWorkspaceSession: false, layoutTabToPaneMap: new Map(), primaryPaneId: 'pane-1', makePaneQueue: () => ({}),
        getPaneTabsList: id => id === 'pane-1' ? {} : null,
        createFilterTab: (tab, pane) => created.push(['f', pane]), createShellTab: (tab, pane) => created.push(['s', pane]),
        createChartTab: (tab, pane) => created.push(['c', pane]), restoreShellSessions() {} });
    const code = section('    if (!workspaceModel && filterTabs.length === 0', '    if (!workspaceModel && normalizedWorkspaceLayoutKey');
    vm.runInContext(code, c);
    assert.deepEqual(created, [['f', 'pane-1'], ['s', 'pane-1'], ['c', 'pane-1']]);
    created.length = 0; c.workspaceModel = {}; vm.runInContext(code, c); assert.deepEqual(created, []);
});


test('legacy layout import cannot persist the pre-group startup list', () => {
    const f = fixture(), c = f.context;
    c.workspaceModel = null; c.isApplyingConfig = true;
    vm.runInContext(section('function persistGroupWorkspaceLayout(', '// 当前分组的简写'), c);
    assert.doesNotThrow(() => c.persistGroupWorkspaceLayout('default'));
    assert.deepEqual(f.sent, []);
});

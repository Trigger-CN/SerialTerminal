'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'renderer.js'), 'utf8');
function act(ws, action) {
    const result = model.applyWorkspaceAction(ws, action);
    assert.equal(result.ok, true, result.reason);
    return result.workspace;
}
function fixture(mode = 'single', target = 'tab-main-c') {
    let ws = importWorkspace({ groups: [{ id: 'default' }, { id: 'b' }, { id: 'c' }],
        filterTabs: { c: [{ id: 'filter-c' }] }, chartTabs: { c: [{ id: 'chart-c' }] },
        shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }] });
    if (mode === 'shared') ws = act(ws, { type: 'split-group', groupId: 'b' });
    if (mode === 'split') ws = act(ws, { type: 'column-split', enabled: true });
    ws = act(ws, { type: 'activate', tabId: target });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-2' });
    const actions = [];
    const context = vm.createContext({ workspaceModel: ws, activeGroupId: 'c', focusedWorkspaceTabId: ws.focusedTabId,
        shellTabs: ['tab-shell-1', 'tab-shell-2'].map(id => ({ id, sessionCreateTimer: null, term: { dispose() {} }, element: { remove() {} }, btn: { remove() {} } })),
        mainTabId: id => id === 'default' ? 'tab-main' : `tab-main-${id}`,
        dispatchWorkspaceAction: action => { actions.push(action); const result = model.applyWorkspaceAction(context.workspaceModel, action); if (result.ok) { context.workspaceModel = result.workspace; context.focusedWorkspaceTabId = result.workspace.focusedTabId; } return result; },
        clearTimeout() {}, ipcRenderer: { send() {} }, unobserveTerminalSearchChanges() {}, persistShellTabs() {}, updateTabTitles() {}, renderWorkspaceNow() {},
        persistWorkspaceLayout() {}, setActionStatus() {}, tr: value => value,
        document: { getElementById: () => null }, setFocusedTab: () => assert.fail('second activation') });
    context.getGroupActiveTabId = (groupId, fallback) => createWorkspaceModelManager({ groupId, getWorkspace: () => context.workspaceModel }).getActiveTabId(fallback);
    const offset = source.indexOf('function closeShellTab(');
    vm.runInContext(source.slice(offset, source.indexOf('\n}', offset) + 2), context);
    return { context, actions, close: id => context.closeShellTab(id) };
}
for (const mode of ['single', 'shared', 'split']) for (const target of ['tab-main-c', 'filter-c', 'chart-c']) {
    test(`three groups/two Shells: ${mode} close returns to control group's ${target}`, () => {
        const f = fixture(mode, target), before = JSON.stringify(Object.values(f.context.workspaceModel.tabs).filter(model.isContainer).map(tab => tab.panes));
        f.close('tab-shell-2');
        assert.equal(f.context.workspaceModel.focusedTabId, target);
        assert.equal(f.context.focusedWorkspaceTabId, target);
        assert.equal(f.context.activeGroupId, 'c');
        assert.ok(model.buildRenderPlan(f.context.workspaceModel).panelIds.includes(target));
        assert.equal(JSON.stringify(Object.values(f.context.workspaceModel.tabs).filter(model.isContainer).map(tab => tab.panes)), before);
        assert.deepEqual(f.actions.map(action => action.type), ['close']);
        assert.equal(f.context.workspaceModel.tabs['tab-shell-1'].kind, 'shell');
    });
}
test('explicit close fallback returns to the control group second pane in one transaction', () => {
    const f = fixture('shared', 'filter-c');
    let ws = act(f.context.workspaceModel, { type: 'split-tab', tabId: 'filter-c', groupId: 'c', paneId: 'c-second' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-2' });
    f.context.workspaceModel = ws; f.context.focusedWorkspaceTabId = ws.focusedTabId;
    const before = JSON.stringify(ws.tabs.c.panes);
    f.close('tab-shell-2');
    assert.equal(f.context.workspaceModel.focusedTabId, 'filter-c');
    assert.equal(f.context.workspaceModel.tabs.c.activePaneId, 'c-second');
    assert.equal(JSON.stringify(f.context.workspaceModel.tabs.c.panes), before);
    assert.ok(model.buildRenderPlan(f.context.workspaceModel).panelIds.includes('filter-c'));
    assert.deepEqual(f.actions.map(action => action.type), ['close']);
});

test('background Shell close keeps focus and all local selections', () => {
    const f = fixture('shared', 'filter-c'), before = JSON.stringify(f.context.workspaceModel.tabs.c.panes);
    f.close('tab-shell-1');
    assert.equal(f.context.workspaceModel.focusedTabId, 'tab-shell-2');
    assert.equal(JSON.stringify(f.context.workspaceModel.tabs.c.panes), before);
});
for (const fallbackTabId of ['missing', 'tab-shell-2', 'c']) test(`invalid explicit fallback ${fallbackTabId} safely uses existing model fallback`, () => {
    const f = fixture();
    const ws = act(f.context.workspaceModel, { type: 'close', tabId: 'tab-shell-2', fallbackTabId });
    assert.ok(ws.tabs[ws.focusedTabId]);
    assert.ok(model.buildRenderPlan(ws).panelIds.includes(ws.focusedTabId));
});
test('single-group pane Shell close retains adjacent pane selection despite explicit fallback', () => {
    let ws = importWorkspace({ groups: [{ id: 'default', panes: [{ id: 'p1', tabIds: ['tab-main', 'filter-a', 'tab-shell-1'], activeTabId: 'tab-shell-1' }] }],
        filterTabs: { default: [{ id: 'filter-a' }] }, shellTabs: [{ id: 'tab-shell-1' }], focusedTabId: 'tab-shell-1' });
    ws = act(ws, { type: 'close', tabId: 'tab-shell-1', fallbackTabId: 'tab-main' });
    assert.equal(ws.focusedTabId, 'filter-a');
});

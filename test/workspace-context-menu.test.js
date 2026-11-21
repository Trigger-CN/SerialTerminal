'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
function fixture(multi = false) { return importWorkspace({ groups: [{ id: 'default' }, ...(multi ? [{ id: 'b' }] : [])],
    filterTabs: { default: [{ id: 'f1' }, { id: 'f2' }] }, shellTabs: [{ id: 's1' }] }); }
function act(ws, action) { const r = model.applyWorkspaceAction(ws, action); assert.equal(r.ok, true, r.reason); return r.workspace; }
function load(context, names) { vm.createContext(context); for (const name of names) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`)), end = source.indexOf('\nfunction ', start + 1);
    assert.ok(start >= 0 && end > start, name); vm.runInContext(source.slice(start, end), context);
} return context; }
function renderer(ws) {
    const sent = [], statuses = [], actions = [];
    const c = load({ workspaceModel: ws, tabModel: model, activeGroupId: 'default',
        groupIdForWorkspaceTab: id => c.workspaceModel.tabs[id]?.ownerGroupId, resolveSerialGroupId: id => id,
        getContextMenuLabels: () => ({}), ipcRenderer: { send: (_, payload) => sent.push(payload) },
        persistGroupWorkspaceLayout() {}, persistShellTabs() {}, setActionStatus: text => statuses.push(text),
        serialRuntimes: new Map(), filterTabsStore: { getList: () => [] }, chartTabsStore: { getList: () => [] }, getShellTabState: () => null },
    ['getWorkspaceTabMenuCapabilities', 'requestTerminalContextMenu', 'requestWorkspaceTabContextMenu',
        'splitWorkspaceTabIntoPane', 'moveWorkspaceTabToOtherPane', 'handleTerminalContextMenuAction']);
    c.dispatchWorkspaceAction = action => { actions.push(action); const r = model.applyWorkspaceAction(c.workspaceModel, action); if (r.ok) c.workspaceModel = r.workspace; return r; };
    return { c, sent, statuses, actions };
}
test('split admission permits no empty region and uses legal local neighbors, including root Shells', () => {
    let ws = importWorkspace({ groups: [{ id: 'default' }] }); assert.equal(model.canSplitTab(ws, 'tab-main'), false);
    ws = act(ws, { type: 'add-leaf', groupId: 'default', options: { id: 's1', kind: 'shell' } });
    assert.equal(model.canSplitTab(ws, 'tab-main'), true); assert.equal(model.canSplitTab(ws, 's1'), true);
    ws = act(ws, { type: 'split-tab', tabId: 's1' }); assert.equal(model.canSplitTab(ws, 's1'), true);
    assert.ok(model.tree.stacks(ws.layout.root).every(node => node.items.length));
    assert.equal(model.canSplitTab(ws, 'missing'), false);
});
test('move candidate is a real existing Stack and sole source leaf merges without allocating', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1' }); const before = JSON.stringify(ws);
    const target = model.getOtherPaneTarget(ws, 'f1', 'default'); assert.equal(JSON.stringify(ws), before);
    assert.equal(model.tree.find(ws.layout.root, target.nodeId).node.type, 'stack');
    ws = act(ws, { type: 'move', tabId: 'f1', target }); assert.equal(model.tree.stacks(ws.layout.root).length, 1);
    assert.equal(model.getOtherPaneTarget(ws, 'f1'), null);
});
test('terminal and tab requests override stale capability flags from their payload', () => {
    const f = renderer(importWorkspace({ groups: [{ id: 'default' }] }));
    f.c.requestTerminalContextMenu({ tabId: 'tab-main', terminalType: 'main', canSplit: true });
    f.c.requestWorkspaceTabContextMenu({ tabId: 'tab-main' });
    assert.ok(f.sent.every(payload => payload.canSplit === false && payload.canMoveToOtherPane === false));
    f.c.workspaceModel = fixture(); f.c.requestTerminalContextMenu({ tabId: 'f1', terminalType: 'filter' });
    assert.equal(f.sent.at(-1).canSplit, true);
});
test('renderer move action uses existing destination, never split, and refuses when none remains', () => {
    const f = renderer(act(fixture(), { type: 'split-tab', tabId: 'f1' }));
    assert.equal(f.c.moveWorkspaceTabToOtherPane({ tabId: 'f1' }), true);
    assert.deepEqual(f.actions.map(action => action.type), ['move']);
    assert.equal(model.tree.stacks(f.c.workspaceModel.layout.root).length, 1);
    assert.equal(f.c.moveWorkspaceTabToOtherPane({ tabId: 'f1' }), false); assert.equal(f.actions.length, 1);
});
test('native menus share four directions and local merge flags, including chart and group; IPC preserves item identity', () => {
    const main = fs.readFileSync(require.resolve('../main.js'), 'utf8'); let handler, items; const sent = [];
    const c = vm.createContext({ ipcMain: { on: (_, fn) => { handler = fn; } }, BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
        terminalContextMenuState: null, menuIcon: () => ({}), Menu: { buildFromTemplate: template => { items = template; return { popup() {} }; } } });
    vm.runInContext(main.slice(main.indexOf("ipcMain.on('show-terminal-context-menu'"), main.indexOf("ipcMain.handle('get-system-fonts'")), c);
    for (const terminalType of ['tab', 'group', 'main', 'filter', 'shell', 'chart']) for (const enabled of [false, true]) {
        handler({ sender: { send: (_, payload) => sent.push(payload) } }, { terminalType, tabId: 'present', itemId: 'anchor', canSplit: enabled, canMerge: enabled, canMoveToOtherPane: enabled });
        const directions = items.filter(item => /向[左右上下]分屏/.test(item.label)); assert.equal(directions.length, 4, terminalType);
        directions.forEach(item => { assert.equal(item.enabled, enabled); item.click(); });
        assert.deepEqual(sent.slice(-4).map(payload => payload.action), ['split-left', 'split-right', 'split-top', 'split-bottom']);
        assert.ok(sent.slice(-4).every(payload => payload.itemId === 'anchor'));
        const merge = items.find(item => /合并/.test(item.label)); assert.ok(merge); assert.equal(merge.enabled, enabled);
    }
});
test('stale menus reject with status feedback and no partial mutation, without needing terminal instances', async () => {
    const f = renderer(importWorkspace({ groups: [{ id: 'default' }] })), before = JSON.stringify(f.c.workspaceModel);
    for (const action of ['split-left', 'split-top', 'merge-layout', 'move-to-other-pane']) {
        await f.c.handleTerminalContextMenuAction({ action, tabId: 'tab-main', terminalType: 'main' });
        assert.equal(JSON.stringify(f.c.workspaceModel), before); assert.match(f.statuses.at(-1), /无法/);
    }
    await f.c.handleTerminalContextMenuAction({ action: 'split-right', tabId: 'closed', terminalType: 'chart' });
    assert.match(f.statuses.at(-1), /无法/);
});
test('menu to handler to model locally merges only requested group and preserves independent Shell region', async () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' }); ws = act(ws, { type: 'split-tab', tabId: 's1' });
    const shell = structuredClone(model.locateTab(ws, 's1').stack), f = renderer(ws), itemId = model.locateTab(ws, 'b').item.id;
    await f.c.handleTerminalContextMenuAction({ action: 'close-group-split', terminalType: 'group', tabId: 'b', itemId, groupId: 'b' });
    assert.deepEqual(model.locateTab(f.c.workspaceModel, 's1').stack, shell);
    assert.equal(model.locateTab(f.c.workspaceModel, 'b').stack.id, model.locateTab(f.c.workspaceModel, 'default').stack.id);
    assert.ok(f.c.workspaceModel.tabs.b); assert.deepEqual(f.actions.map(action => action.type), ['merge']);
});
test('multi-group move targets stay within owner; Shell targets remain root-level', () => {
    let ws = act(fixture(true), { type: 'split-tab', tabId: 'f1' }); ws = act(ws, { type: 'split-group', groupId: 'b' });
    const target = model.getOtherPaneTarget(ws, 'f1', 'default'); assert.equal(model.tree.find(ws.layout.root, target.nodeId).scope.tabId, 'default');
    assert.equal(model.getOtherPaneTarget(ws, 'tab-main-b', 'default'), null);
    const shellTarget = model.getOtherPaneTarget(ws, 's1'); assert.equal(model.tree.find(ws.layout.root, shellTarget.nodeId).scope, null);
    assert.equal(model.canSplitTab(ws, 'f1', 'b'), false);
});

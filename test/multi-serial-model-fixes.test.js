'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../tab-model');
const { importWorkspace } = require('../tabs-workspace-projection');
const { serializeWorkspaceLayout: save, restoreWorkspaceLayout: restore } = require('../workspace-layout-state');
const { createWorkspaceModelManager } = require('../workspace-model-manager');

function fixture(multi = false) {
    return importWorkspace({ groups: [{ id: 'default', panes: [{ id: 'p1', tabIds: ['tab-main', 'f1', 'f2'], activeTabId: 'tab-main' }] },
        ...(multi ? [{ id: 'b' }, { id: 'c' }] : [])], filterTabs: { default: [{ id: 'f1' }, { id: 'f2' }] },
        shellTabs: [{ id: 'tab-shell-1' }], focusedTabId: 'tab-main' });
}
function act(ws, action) {
    const result = model.applyWorkspaceAction(ws, action);
    assert.equal(result.ok, true, result.reason);
    return result.workspace;
}
function visible(ws) {
    assert.ok(model.buildRenderPlan(ws).panelIds.includes(ws.focusedTabId), `hidden focus: ${ws.focusedTabId}`);
}

test('split and move synchronize manager active pane while keeping other panes active', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'p2' });
    const manager = createWorkspaceModelManager({ groupId: 'default', getWorkspace: () => ws });
    assert.equal(manager.getActivePane().id, 'p2');
    assert.equal(ws.tabs.default.panes[0].activeTabId, 'tab-main');
    ws = act(ws, { type: 'move', tabId: 'f2', target: { kind: 'pane', groupId: 'default', paneId: 'p2', index: 1 } });
    assert.equal(manager.getActiveTabId(), 'f2');
    visible(ws);
    assert.deepEqual(save(restore(fixture(), save(ws))), save(ws));
});

test('shared-column add selects its group without an extra activation and activate:false preserves focus', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'add-leaf', groupId: 'c', options: { id: 'c-filter', kind: 'filter' } });
    assert.equal(ws.split.activeTabs.default, 'c-filter');
    visible(ws);
    const before = ws.focusedTabId;
    ws = act(ws, { type: 'add-leaf', groupId: 'default', options: { id: 'background', kind: 'filter' }, activate: false });
    assert.equal(ws.focusedTabId, before);
    assert.equal(ws.tabs.default.panes[0].activeTabId, 'tab-main');
    const saved = save(ws);
    assert.deepEqual(save(restore(ws, saved)), saved);
});

test('same-pane move is a reorder and does not change focus or local selection', () => {
    let ws = act(fixture(), { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'move', tabId: 'f1', target: { kind: 'pane', groupId: 'default', paneId: 'p1', index: 0 } });
    assert.equal(ws.focusedTabId, 'tab-shell-1');
    assert.equal(ws.tabs.default.panes[0].activeTabId, 'tab-main');
});

test('move and split with activate:false keep focus and active pane', () => {
    let ws = fixture();
    ws = act(ws, { type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'p2', activate: false });
    assert.equal(ws.focusedTabId, 'tab-main');
    assert.equal(ws.tabs.default.activePaneId, 'p1');
    ws = act(ws, { type: 'move', tabId: 'f2', target: { kind: 'pane', groupId: 'default', paneId: 'p2', index: 0 }, activate: false });
    assert.equal(ws.focusedTabId, 'tab-main');
    assert.equal(ws.tabs.default.activePaneId, 'p1');
    visible(ws);
});

test('moving the focused leaf with activate:false keeps it visible in its new pane', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'p2' });
    ws = act(ws, { type: 'move', tabId: 'f2', activate: false, target: { kind: 'pane', groupId: 'default', paneId: 'p2', index: 1 } });
    assert.equal(ws.tabs.default.panes[1].activeTabId, 'f1');
    ws = act(ws, { type: 'move', tabId: 'f1', activate: false, target: { kind: 'pane', groupId: 'default', paneId: 'p1', index: 1 } });
    assert.equal(ws.focusedTabId, 'f1');
    visible(ws);
    assert.equal(ws.tabs.default.activePaneId, 'p1');
    assert.equal(ws.tabs.default.panes[1].activeTabId, 'f2');
    assert.deepEqual(save(restore(fixture(), save(ws))), save(ws));
});

test('explicit missing owner rejects transactions and is excluded at recovery rather than reassigned', () => {
    const ws = fixture(true);
    ws.tabs.orphan = model.createLeaf('filter', { id: 'orphan', ownerGroupId: 'gone' });
    ws.tabs.f1.ownerGroupId = 'gone';
    const before = JSON.stringify(ws);
    const result = model.applyWorkspaceAction(ws, { type: 'activate', tabId: 'tab-main' });
    assert.equal(result.ok, false);
    assert.equal(result.workspace, ws);
    assert.equal(JSON.stringify(ws), before);
    const recovered = restore(ws, save(ws));
    assert.equal(recovered.tabs.orphan, undefined);
    assert.equal(recovered.tabs.f1, undefined);
    assert.equal(recovered.tabs.f2.ownerGroupId, 'default');
    assert.deepEqual(save(restore(recovered, save(recovered))), save(recovered));
    const legacy = fixture();
    delete legacy.tabs.f1.ownerGroupId;
    assert.equal(act(legacy, { type: 'activate', tabId: 'f1' }).tabs.f1.ownerGroupId, 'default');
});

test('damaged snapshot repairs focus selection and stale active pane idempotently', () => {
    let ws = act(fixture(true), { type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'p2' });
    ws = act(ws, { type: 'split-group', groupId: 'b' });
    const saved = save(ws);
    saved.focusedTabId = 'f1';
    saved.groups.find(group => group.id === 'default').activePaneId = 'p1';
    saved.split.activeTabs.default = 'tab-main-c';
    const repaired = restore(fixture(true), saved);
    visible(repaired);
    assert.equal(repaired.tabs.default.activePaneId, 'p2');
    assert.equal(repaired.tabs.default.panes[0].activeTabId, 'tab-main');
    const once = save(repaired);
    assert.deepEqual(save(restore(fixture(true), once)), once);
    const visibleButStale = structuredClone(once);
    visibleButStale.groups[0].activePaneId = 'p1';
    assert.equal(restore(fixture(true), visibleButStale).tabs.default.activePaneId, 'p2');
});

test('serial leaves cannot newly enter roots even with only one group', () => {
    for (const id of ['tab-main', 'f1']) {
        const ws = fixture();
        const result = model.applyWorkspaceAction(ws, { type: 'move', tabId: id, target: { kind: 'roots', index: 0 } });
        assert.equal(result.ok, false);
        assert.equal(result.workspace, ws);
    }
});

test('old root and cross-owner leaves normalize before transitions and roundtrip idempotently', () => {
    const old = fixture(true);
    old.tabs.default.panes[0].tabIds = ['tab-main'];
    old.tabs.b.panes[0].tabIds.push('f2');
    old.tabs.f1.parentId = null;
    old.tabs.f2.parentId = 'b';
    let ws = act(old, { type: 'add-group', options: { id: 'd', mainId: 'tab-main-d' } });
    assert.equal(ws.tabs.f1.parentId, 'default');
    assert.equal(ws.tabs.f2.parentId, 'default');
    assert.deepEqual(ws.tabs.default.panes[0].tabIds, ['tab-main', 'f1', 'f2']);
    const once = save(ws);
    const baseline = act(fixture(true), { type: 'add-group', options: { id: 'd', mainId: 'tab-main-d' } });
    assert.deepEqual(save(restore(baseline, once)), once);
    assert.deepEqual(save(restore(baseline, save(restore(baseline, once)))), once);
    ws = act(ws, { type: 'remove-group', groupId: 'd' });
    ws = act(ws, { type: 'remove-group', groupId: 'c' });
    ws = act(ws, { type: 'remove-group', groupId: 'b' });
    visible(ws);
    assert.equal(ws.tabs.f1.parentId, 'default');
});

test('closing the focus uses a visible shared-column fallback; closing background preserves focus', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'activate', tabId: 'tab-main-c' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'close', tabId: 'f2' });
    assert.equal(ws.focusedTabId, 'tab-shell-1');
    ws = act(ws, { type: 'close', tabId: 'tab-shell-1' });
    visible(ws);
    assert.equal(ws.tabs[ws.focusedTabId].parentId, 'default');
});

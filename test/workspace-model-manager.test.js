'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');

function fixture() {
    let ws = importWorkspace({
        groups: [{ id: 'default', panes: [{ id: 'pane-1', tabIds: ['tab-main', 'f1'], activeTabId: 'tab-main' }] }],
        filterTabs: { default: [{ id: 'f1' }] },
        shellTabs: [{ id: 'tab-shell-1' }],
        focusedTabId: 'tab-main'
    });
    const events = [];
    let saves = 0;
    const manager = createWorkspaceModelManager({
        groupId: 'default', getWorkspace: () => ws,
        dispatch: action => {
            const result = model.applyWorkspaceAction(ws, action);
            if (result.ok) ws = result.workspace;
            return result;
        },
        persistLayout: () => { saves++; },
        onTabActivated: event => events.push(event),
        onTabMoved: event => events.push(event),
        describeTab: id => ({ id, kind: id.startsWith('tab-shell-') ? 'shell' : 'filter' })
    });
    return { manager, read: () => ws, events, saves: () => saves };
}

test('manager reads snapshots and activates through model actions', () => {
    const f = fixture();
    const before = f.read();
    const snapshot = f.manager.getLayoutSnapshot();
    snapshot.panes[0].tabIds.length = 0;
    assert.equal(f.read().tabs.default.panes[0].tabIds.length, 2);
    assert.equal(f.manager.switchPaneTab('pane-1', 'f1'), true);
    assert.notEqual(f.read(), before);
    assert.equal(before.tabs.default.panes[0].activeTabId, 'tab-main');
    assert.equal(f.read().tabs.default.panes[0].activeTabId, 'f1');
    assert.equal(f.read().focusedTabId, 'f1');
    assert.equal(f.saves(), 1);
    assert.equal(f.events[0].tabId, 'f1');
});

test('manager creates business leaves, moves existing tabs, resizes and closes without synthetic main', () => {
    const f = fixture();
    assert.equal(f.manager.addTabToPane('f2', 'pane-1'), 'pane-1');
    assert.equal(f.read().tabs.f2.kind, 'filter');
    const split = model.applyWorkspaceAction(f.read(), {
        type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'pane-2'
    });
    assert.equal(split.ok, true);
    // Use the same adapter against another live model to check its snapshot contract.
    let ws = split.workspace;
    const manager = createWorkspaceModelManager({ groupId: 'default', getWorkspace: () => ws,
        dispatch: action => { const result = model.applyWorkspaceAction(ws, action); if (result.ok) ws = result.workspace; return result; }
    });
    manager.setPaneSizes(0.7, { persist: false });
    assert.ok(Math.abs(ws.tabs.default.paneSplit.sizes['pane-1'] - 0.7) < 1e-12);
    assert.ok(Math.abs(ws.tabs.default.paneSplit.sizes['pane-2'] - 0.3) < 1e-12);
    manager.moveTabToPane('tab-shell-1', 'pane-2');
    assert.equal(ws.tabs['tab-shell-1'].parentId, 'default');
    manager.removeTab('f1');
    assert.deepEqual(ws.tabs.default.panes[1].tabIds, ['tab-shell-1']);
    manager.removeTab('tab-shell-1');
    assert.equal(ws.tabs.default.panes.length, 1);
    assert.equal(Object.values(ws.tabs).filter(tab => tab.kind === 'main').length, 1);
    assert.equal(manager.isSplitEnabled(), false);
});

test('enableSplit partitions existing leaves and refuses a single remaining leaf', () => {
    const f = fixture();
    const ids = Object.keys(f.read().tabs).sort();
    assert.equal(f.manager.enableSplit('vertical'), true);
    assert.deepEqual(Object.keys(f.read().tabs).sort(), ids);
    assert.equal(f.read().tabs.default.panes.length, 2);
    assert.ok(f.read().tabs.default.panes.every(pane => pane.tabIds.length));
    assert.deepEqual(f.read().tabs.default.panes[1].tabIds, ['f1']);
    f.manager.collapseSplit();
    f.manager.removeTab('f1');
    const before = f.read();
    assert.equal(f.manager.enableSplit('horizontal'), false);
    assert.equal(f.read(), before);
});

test('explicit restore uses model transaction and rejects membership loss atomically', () => {
    const f = fixture();
    const layout = f.manager.getLayoutSnapshot();
    layout.panes = [
        { id: 'pane-1', tabIds: ['tab-main'], activeTabId: 'tab-main' },
        { id: 'restore-pane', tabIds: ['f1'], activeTabId: 'f1' }
    ];
    layout.splitEnabled = true; layout.orientation = 'vertical';
    layout.activePaneId = 'restore-pane';
    assert.equal(f.manager.restoreLayout(layout, { persist: false }), true);
    assert.equal(f.read().tabs.default.activePaneId, 'restore-pane');
    assert.equal(f.read().tabs.default.paneSplit.orientation, 'vertical');
    const before = f.read();
    layout.panes.pop();
    assert.equal(f.manager.replaceLayout(layout), false);
    assert.equal(f.read(), before);
});

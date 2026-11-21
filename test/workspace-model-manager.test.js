'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');
function fixture(withShell = false) {
    let ws = importWorkspace({ groups: [{ id: 'default' }], filterTabs: { default: [{ id: 'f1' }] }, shellTabs: withShell ? [{ id: 's1' }] : [] });
    let saves = 0; const events = [], actions = [];
    const manager = createWorkspaceModelManager({ groupId: 'default', getWorkspace: () => ws,
        dispatch: action => { actions.push(action); const r = model.applyWorkspaceAction(ws, action); if (r.ok) ws = r.workspace; return r; },
        persistLayout: () => saves++, onTabActivated: event => events.push(event), onTabMoved: event => events.push(event),
        describeTab: id => ({ id, kind: id === 's1' ? 'shell' : 'filter' }) });
    return { manager, read: () => ws, actions, events, saves: () => saves };
}
test('manager reads snapshots by value and activates through the only model action', () => {
    const f = fixture(), before = f.read(), pane = f.manager.getActivePane();
    const snapshot = f.manager.getLayoutSnapshot(); snapshot.panes[0].tabIds.length = 0;
    assert.equal(model.groupStacks(f.read(), 'default')[0].items.length, 2);
    assert.equal(f.manager.switchPaneTab(pane.id, 'f1'), true); assert.notEqual(f.read(), before);
    assert.equal(before.focusedTabId, 'tab-main'); assert.equal(f.read().focusedTabId, 'f1');
    assert.equal(f.saves(), 1); assert.equal(f.events[0].tabId, 'f1');
});
test('manager adds real business leaves, resizes the local Split, moves and closes without synthetic main', () => {
    const f = fixture(true), firstId = f.manager.getActivePane().id;
    assert.equal(f.manager.addTabToPane('f2', firstId), firstId); assert.equal(f.read().tabs.f2.kind, 'filter');
    f.manager.switchPaneTab(firstId, 'tab-main');
    assert.equal(f.manager.enableSplit('horizontal'), true);
    const root = f.read().layout.root, secondId = root.children[1].id;
    assert.equal(f.manager.setPaneSizes(.7), true); assert.deepEqual(f.read().layout.root.weights, [.7, 1 - .7]);
    f.manager.moveTabToPane('s1', secondId); assert.equal(f.read().tabs.s1.ownerGroupId, null);
    f.manager.removeTab('f1'); assert.deepEqual(model.tree.find(f.read().layout.root, secondId).node.items.map(item => item.tabId), ['s1']);
    f.manager.removeTab('s1'); assert.equal(f.manager.isSplitEnabled(), false);
    assert.equal(Object.values(f.read().tabs).filter(tab => tab.kind === 'main').length, 1);
});
test('enableSplit partitions existing leaves and rejects a sole remaining leaf atomically', () => {
    const f = fixture(), ids = Object.keys(f.read().tabs).sort();
    assert.equal(f.manager.enableSplit('vertical'), true); assert.deepEqual(Object.keys(f.read().tabs).sort(), ids);
    assert.equal(f.read().layout.root.orientation, 'vertical');
    assert.ok(model.groupStacks(f.read(), 'default').every(node => node.items.length));
    f.manager.collapseSplit(); f.manager.removeTab('f1'); const before = f.read();
    assert.equal(f.manager.enableSplit('horizontal'), false); assert.equal(f.read(), before);
});
test('explicit restore uses complete tree transaction and rejects lost membership', () => {
    const f = fixture(); f.manager.enableSplit('vertical'); const saved = f.manager.getLayoutSnapshot();
    f.manager.collapseSplit(); assert.equal(f.manager.restoreLayout(saved, { persist: false }), true);
    assert.deepEqual(f.manager.getLayoutSnapshot().trees, saved.trees);
    const before = f.read(), damaged = f.manager.getLayoutSnapshot(); damaged.trees[0].children.pop();
    assert.equal(f.manager.replaceLayout(damaged), false); assert.equal(f.read(), before);
});

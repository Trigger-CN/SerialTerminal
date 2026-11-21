'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const codec = require('../src/workspace/workspace-layout-state');
function baseline() {
    return importWorkspace({ groups: [{ id: 'default', panes: [{ id: 'pane-1', tabIds: ['tab-main', 'f1'], activeTabId: 'f1' }] },
        { id: 'second', panes: [{ id: 'p2', tabIds: ['tab-main-second'], activeTabId: 'tab-main-second' }] }],
        filterTabs: { default: [{ id: 'f1' }] }, shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }], focusedTabId: 'f1' });
}
test('v1 explicit Shell-only region and projected serial regions migrate to actual owned subtrees', () => {
    const saved = { version: 1, focusedTabId: 'tab-shell-2', groups: [
        { id: 'default', panes: [{ id: 'a', tabIds: ['tab-main'], activeTabId: 'tab-main' }, { id: 'b', tabIds: ['f1'], activeTabId: 'f1' }], paneSplit: { enabled: true, orientation: 'vertical', sizes: { a: .6, b: .4 } } },
        { id: 'second', panes: [{ id: 'c', tabIds: ['tab-main-second'], activeTabId: 'tab-main-second' }] }
    ], roots: [{ tabId: 'tab-shell-1', columnId: 'shell-region', columnMode: 'row' }, { tabId: 'tab-shell-2', columnId: 'shell-region', columnMode: 'row' }],
    split: { enabled: true, orientation: 'horizontal', columns: [
        { id: 'default', groupIds: ['default', 'second'], containerId: 'default', paneIds: ['a'] },
        { id: 'shell-region', groupIds: [] }, { id: 'serial-b', groupIds: [], containerId: 'default', paneIds: ['b'] }
    ], sizes: { default: .4, 'shell-region': .35, 'serial-b': .25 }, activeTabs: { 'shell-region': 'tab-shell-2' } } };
    const ws = codec.restoreWorkspaceLayout(baseline(), saved);
    assert.deepEqual(model.validateLayout(ws), []);
    assert.deepEqual(ws.layout.root.weights, [.4, .35, .25]);
    assert.equal(model.locateTab(ws, 'tab-shell-1').stack.id, model.locateTab(ws, 'tab-shell-2').stack.id);
    assert.notEqual(model.locateTab(ws, 'tab-main').stack.id, model.locateTab(ws, 'f1').stack.id);
    assert.equal((JSON.stringify(ws).match(/"tabId":"f1"/g) || []).length, 1);
    for (const key of ['paneIds', 'columnMode', '__shell__']) assert.equal(JSON.stringify(ws).includes(key), false);
    const snapshot = codec.serializeWorkspaceLayout(ws);
    assert.equal(snapshot.version, 2);
    assert.deepEqual(codec.serializeWorkspaceLayout(codec.restoreWorkspaceLayout(baseline(), snapshot)), snapshot);
});
test('unknown version is rejected instead of replaced by an empty layout', () => {
    assert.throws(() => codec.restoreWorkspaceLayout(baseline(), { version: 99 }), /不支持/);
});
test('legacy implicit ownColumn imports once and retains local Shell selection', () => {
    const saved = { version: 1, groups: [], roots: [{ tabId: 'tab-shell-1', columnMode: 'ownColumn' }, { tabId: 'tab-shell-2', columnMode: 'ownColumn' }],
        focusedTabId: 'tab-shell-2', split: { enabled: true, orientation: 'vertical', sizes: { default: .3, second: .2, __shell__: .5 }, activeTabs: { __shell__: 'tab-shell-2' } } };
    const ws = codec.restoreWorkspaceLayout(baseline(), saved);
    assert.deepEqual(model.validateLayout(ws), []);
    assert.equal(ws.layout.root.orientation, 'vertical');
    assert.equal(model.locateTab(ws, 'tab-shell-2').stack.activeItemId, 'tab-shell-2');
});

test('v2 recovery filters unknown, duplicate and cross-owner references and backfills every legitimate leaf', () => {
    const base = baseline(), snapshot = codec.serializeWorkspaceLayout(base);
    const root = snapshot.layout.root;
    const a = root.items.find(item => item.tabId === 'default');
    const b = root.items.find(item => item.tabId === 'second');
    a.content.items.push({ id: 'ghost', tabId: 'ghost' }, { id: 'duplicate', tabId: 'tab-main' });
    a.content.items = a.content.items.filter(item => item.tabId !== 'f1');
    b.content.items.push({ id: 'wrong-owner', tabId: 'f1' });
    root.items.push({ id: 'illegal-root', tabId: 'f1' }, null);
    root.activeItemId = 'missing'; snapshot.focusedTabId = 'f1';
    const before = JSON.stringify(snapshot), result = codec.restoreWorkspaceLayout(base, snapshot);
    assert.equal(JSON.stringify(snapshot), before);
    assert.deepEqual(model.validateLayout(result), []);
    assert.equal(model.locateTab(result, 'f1').scope.tabId, 'default');
    assert.ok(model.buildRenderPlan(result).panelIds.includes('f1'));
    const once = codec.serializeWorkspaceLayout(result);
    assert.deepEqual(codec.serializeWorkspaceLayout(codec.restoreWorkspaceLayout(base, once)), once);
});
test('v2 recovered node allocation never reuses persisted layout identities', () => {
    const saved = codec.serializeWorkspaceLayout(baseline()); saved.layout.nextId = 1;
    saved.layout.root.id = 'layout-900';
    let ws = codec.restoreWorkspaceLayout(baseline(), saved);
    assert.ok(ws.layout.nextId > 900);
    const r = model.applyWorkspaceAction(ws, { type: 'split-tab', tabId: 'tab-shell-1' });
    assert.equal(r.ok, true, r.reason); ws = r.workspace;
    assert.deepEqual(model.validateLayout(ws), []);
    assert.equal(model.tree.stacks(ws.layout.root).length, 2);
});

test('layout allocation skips business IDs during import, recovery and later splits', () => {
    const base = importWorkspace({ groups: [{ id: 'default' }], filterTabs: { default: [{ id: 'layout-1' }, { id: 'layout-2' }] }, focusedTabId: 'tab-main' });
    assert.deepEqual(model.validateLayout(base), []);
    const saved = codec.serializeWorkspaceLayout(base);
    saved.layout.nextId = 1; saved.layout.root = null;
    const restored = codec.restoreWorkspaceLayout(base, saved);
    assert.deepEqual(model.validateLayout(restored), []);
    const result = model.applyWorkspaceAction(restored, { type: 'add-leaf', groupId: 'default', options: { id: `layout-${restored.layout.nextId}`, kind: 'filter' } });
    assert.equal(result.ok, true, result.reason);
    const split = model.applyWorkspaceAction(result.workspace, { type: 'split-tab', tabId: 'tab-main' });
    assert.equal(split.ok, true, split.reason);
    assert.deepEqual(model.validateLayout(split.workspace), []);
});
test('v1 import clears collapsed metadata without multiple retained rows', () => {
    const base = importWorkspace({ groups: [{ id: 'default' }], focusedTabId: 'tab-main' });
    const saved = { version: 1, groups: [{ id: 'default', collapsed: true, panes: [{ id: 'old', tabIds: ['tab-main'], activeTabId: 'tab-main' }] }] };
    const restored = codec.restoreWorkspaceLayout(base, saved);
    assert.equal(restored.tabs.default.collapsed, false);
    assert.deepEqual(model.validateLayout(restored), []);
    const multi = baseline();
    const valid = codec.restoreWorkspaceLayout(multi, { version: 1, focusedTabId: 'f1', groups: [{ id: 'default', collapsed: true, order: 3,
        panes: [{ id: 'a', tabIds: ['tab-main'], activeTabId: 'tab-main' }, { id: 'b', tabIds: ['f1'], activeTabId: 'f1' }],
        paneSplit: { enabled: true, orientation: 'vertical', sizes: { a: .7, b: .3 } } }] });
    assert.equal(valid.tabs.default.collapsed, true);
    assert.equal(valid.tabs.default.order, 3);
    assert.equal(model.groupStacks(valid, 'default').length, 2);
    assert.deepEqual(model.validateLayout(valid), []);
});
test('v2 malformed deep geometry recovers legitimate inventory without creating business tabs', () => {
    const base = baseline(), saved = codec.serializeWorkspaceLayout(base);
    let root = { id: 'broken', type: 'stack', items: [null, { tabId: 'unknown' }] };
    for (let i = 0; i < 80; i++) root = { type: 'split', id: `bad-${i}`, children: [root, false], weights: 'broken' };
    saved.layout.root = root; saved.layout.nextId = -100;
    const restored = codec.restoreWorkspaceLayout(base, saved);
    assert.deepEqual(Object.keys(restored.tabs).sort(), Object.keys(base.tabs).sort());
    assert.deepEqual(model.validateLayout(restored), []);
});

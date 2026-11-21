'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { model, codec, fixture, act, roundtrip } = require('./workspace-tree-fixture');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');
const visible = ws => assert.ok(model.buildRenderPlan(ws).panelIds.includes(ws.focusedTabId));
test('split and move synchronize manager active Stack without changing other selections', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1' });
    const manager = createWorkspaceModelManager({ groupId: 'default', getWorkspace: () => ws });
    const target = model.locateTab(ws, 'f1').stack.id;
    assert.equal(manager.getActivePane().id, target);
    assert.equal(model.locateTab(ws, 'tab-main').stack.activeItemId, 'tab-main');
    ws = act(ws, { type: 'move', tabId: 'f2', target: { nodeId: target } });
    assert.equal(manager.getActiveTabId(), 'f2'); visible(ws); roundtrip(ws);
});
test('shared-region add activates the proper group while background creation retains focus', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'add-leaf', groupId: 'c', options: { id: 'cf', kind: 'filter' } });
    assert.equal(ws.focusedTabId, 'cf'); visible(ws);
    ws = act(ws, { type: 'add-leaf', groupId: 'default', options: { id: 'background', kind: 'filter' }, activate: false });
    assert.equal(ws.focusedTabId, 'cf');
    assert.equal(model.locateTab(ws, 'tab-main').stack.activeItemId, 'tab-main'); roundtrip(ws);
});
test('same Stack reorder preserves focus and its actual selected member', () => {
    let ws = act(fixture(), { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'move', tabId: 'f1', target: { nodeId: model.locateTab(ws, 'f1').stack.id, index: 0 } });
    assert.equal(ws.focusedTabId, 'tab-shell-1');
    assert.equal(model.locateTab(ws, 'f1').stack.activeItemId, 'tab-shell-1');
});
test('background split and move preserve focus and remembered active Stack', () => {
    let ws = fixture(), origin = model.groupLayout(ws, 'default').activePaneId;
    ws = act(ws, { type: 'split-tab', tabId: 'f1', activate: false });
    ws = act(ws, { type: 'move', tabId: 'f2', activate: false, target: { nodeId: model.locateTab(ws, 'f1').stack.id } });
    assert.equal(ws.focusedTabId, 'tab-main');
    assert.equal(model.groupLayout(ws, 'default').activePaneId, origin); visible(ws);
});
test('moving focused content with activate:false keeps it visible and selects source fallback', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1' });
    ws = act(ws, { type: 'move', tabId: 'f2', activate: false, target: { nodeId: model.locateTab(ws, 'f1').stack.id } });
    ws = act(ws, { type: 'move', tabId: 'f1', activate: false, target: { nodeId: model.locateTab(ws, 'tab-main').stack.id } });
    assert.equal(ws.focusedTabId, 'f1'); visible(ws);
    assert.equal(model.locateTab(ws, 'f2').stack.activeItemId, 'f2'); roundtrip(ws);
});
test('explicit invalid owner rejects live transaction and is excluded only at disk recovery', () => {
    const ws = fixture(true), saved = codec.serializeWorkspaceLayout(ws);
    ws.tabs.orphan = model.createLeaf('filter', { id: 'orphan', ownerGroupId: 'gone' });
    ws.tabs.f1.ownerGroupId = 'gone';
    const before = JSON.stringify(ws), result = model.applyWorkspaceAction(ws, { type: 'activate', tabId: 'tab-main' });
    assert.equal(result.ok, false); assert.equal(result.workspace, ws); assert.equal(JSON.stringify(ws), before);
    assert.throws(() => codec.serializeWorkspaceLayout(ws), /无效布局/);
    const recovered = codec.restoreWorkspaceLayout(ws, saved);
    assert.equal(recovered.tabs.orphan, undefined); assert.equal(recovered.tabs.f1, undefined);
    assert.equal(recovered.tabs.f2.ownerGroupId, 'default'); roundtrip(recovered);
});
test('damaged local selection and focus recover deterministically against actual leaves', () => {
    let ws = act(fixture(true), { type: 'split-tab', tabId: 'f1' });
    ws = act(ws, { type: 'split-group', groupId: 'b' });
    const saved = codec.serializeWorkspaceLayout(ws);
    model.tree.walk(saved.layout.root, node => { if (node.type === 'stack') node.activeItemId = 'gone'; });
    saved.focusedTabId = 'f1';
    const repaired = codec.restoreWorkspaceLayout(fixture(true), saved);
    assert.equal(repaired.focusedTabId, 'f1'); visible(repaired); roundtrip(repaired);
});
test('missing drop region never means create a new region', () => {
    for (const id of ['tab-main', 'f1']) {
        const ws = fixture(), result = model.applyWorkspaceAction(ws, { type: 'move', tabId: id, target: { nodeId: 'missing' } });
        assert.equal(result.ok, false); assert.equal(result.workspace, ws);
    }
});
test('recovery restores cross-owner positions without changing immutable business ownership', () => {
    const ws = fixture(true), saved = codec.serializeWorkspaceLayout(ws);
    const source = model.locateTab({ ...ws, layout: saved.layout }, 'f1');
    source.stack.items.splice(source.index, 1);
    const target = model.locateTab({ ...ws, layout: saved.layout }, 'b').item.content;
    model.tree.stacks(target)[0].items.push(source.item);
    let repaired = codec.restoreWorkspaceLayout(ws, saved);
    assert.equal(model.locateTab(repaired, 'f1').scope.tabId, 'default'); roundtrip(repaired);
    repaired = act(repaired, { type: 'remove-group', groupId: 'b' });
    repaired = act(repaired, { type: 'remove-group', groupId: 'c' }); visible(repaired);
});
test('closing background keeps focus and closing focused Shell picks a visible local fallback', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'close', tabId: 'f2' }); assert.equal(ws.focusedTabId, 'tab-shell-1');
    ws = act(ws, { type: 'close', tabId: 'tab-shell-1' }); visible(ws);
});

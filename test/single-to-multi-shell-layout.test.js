'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { model, codec, fixture, act, regions, resize, roundtrip } = require('./workspace-tree-fixture');
function splitShells(direction = 'right', count = 1) {
    let ws = fixture();
    for (let i = 1; i <= count; i++) ws = act(ws, { type: 'split-tab', tabId: `tab-shell-${i}`, direction });
    return resize(ws);
}
function add(ws, activate = false) { return act(ws, { type: 'add-group', options: { id: 'b', mainId: 'mb' }, activate }); }
for (const direction of ['right', 'bottom']) test(`adding a group preserves existing ${direction} Shell regions and ratios`, () => {
    const ws = splitShells(direction), before = JSON.stringify(ws), next = add(ws);
    assert.equal(JSON.stringify(ws), before);
    for (const [id, rect] of Object.entries(regions(ws))) assert.deepEqual(regions(next)[id], rect);
    assert.equal(next.tabs['tab-main'].ownerGroupId, 'default');
    assert.equal(next.tabs['tab-shell-1'].ownerGroupId, null);
    assert.deepEqual(regions(act(next, { type: 'activate', tabId: 'mb' }))['tab-shell-1'], regions(ws)['tab-shell-1']);
    roundtrip(next);
});
test('distinct Shell-only regions remain distinct during single-to-multi conversion', () => {
    const ws = splitShells('right', 2), next = add(ws);
    for (const id of ['tab-shell-1', 'tab-shell-2']) assert.deepEqual(regions(next)[id], regions(ws)[id]);
    assert.notEqual(model.locateTab(next, 'tab-shell-1').stack.id, model.locateTab(next, 'tab-shell-2').stack.id);
});
test('Shell before serial content retains selected sibling and position', () => {
    let ws = splitShells('left');
    ws = act(ws, { type: 'move', tabId: 'tab-shell-2', target: { nodeId: model.locateTab(ws, 'tab-shell-1').stack.id } });
    const next = add(ws);
    assert.deepEqual(model.locateTab(next, 'tab-shell-1').stack, model.locateTab(ws, 'tab-shell-1').stack);
    assert.equal(model.buildRenderPlan(next).panelIds.includes('tab-shell-1'), false);
    roundtrip(next);
});
test('mixed serial/Shell regions preserve ownership, directions and local selection', () => {
    let ws = act(splitShells('bottom'), { type: 'split-tab', tabId: 'f1', direction: 'left' });
    ws = act(ws, { type: 'move', tabId: 'tab-shell-2', target: { nodeId: model.locateTab(ws, 'f1').stack.id } });
    const next = add(ws);
    assert.deepEqual(regions(next).f1, regions(ws).f1);
    assert.deepEqual(regions(next)['tab-shell-2'], regions(ws)['tab-shell-2']);
    assert.equal(next.tabs.f1.ownerGroupId, 'default');
    assert.ok(model.buildRenderPlan(act(next, { type: 'activate', tabId: 'f1' })).panelIds.includes('f1'));
    roundtrip(next);
});
test('removing the added group retains all existing Shell branches', () => {
    const ws = splitShells('right', 2), next = act(add(ws), { type: 'remove-group', groupId: 'b' });
    assert.deepEqual(regions(next), regions(ws));
    roundtrip(next);
});
test('splitting the new group does not change the original Shell region', () => {
    const ws = splitShells(), next = act(add(ws), { type: 'split-group', groupId: 'b' });
    assert.deepEqual(regions(next)['tab-shell-1'], regions(ws)['tab-shell-1']);
    roundtrip(next);
});
test('existing nested Shell geometry survives group creation without another implicit root split', () => {
    const ws = splitShells('bottom', 2), next = add(ws);
    assert.equal(model.tree.stacks(next.layout.root).length, model.tree.stacks(ws.layout.root).length);
    assert.deepEqual(next.layout.root.weights, ws.layout.root.weights);
    roundtrip(next);
});
test('closing the only separate business group removes its empty branch', () => {
    let ws = act(model.createWorkspace(), { type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    ws = act(ws, { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'remove-group', groupId: 'b' });
    assert.equal(ws.layout.root.type, 'stack');
});
for (const type of ['close', 'move']) test(`${type} of the last Shell removes its real empty region`, () => {
    let ws = add(splitShells('right', 2));
    const source = model.locateTab(ws, 'tab-shell-1').stack.id;
    ws = act(ws, type === 'close' ? { type, tabId: 'tab-shell-1' }
        : { type, tabId: 'tab-shell-1', target: { nodeId: model.locateTab(ws, 'tab-shell-2').stack.id } });
    assert.equal(model.tree.find(ws.layout.root, source), null);
    assert.equal(model.tree.stacks(ws.layout.root).length, 2);
    roundtrip(ws);
});
test('returning to one group restores free movement and allows conversion again', () => {
    let ws = act(add(splitShells('right', 2)), { type: 'remove-group', groupId: 'b' });
    ws = act(ws, { type: 'move', tabId: 'tab-main', target: { nodeId: model.locateTab(ws, 'tab-shell-1').stack.id } });
    const rect = regions(ws)['tab-main']; ws = add(ws);
    assert.deepEqual(regions(ws)['tab-main'], rect);
    roundtrip(ws);
});
test('splitting and merging serial content after conversion keeps every business leaf once', () => {
    let ws = add(splitShells());
    ws = act(ws, { type: 'split-tab', tabId: 'f1', direction: 'bottom' });
    assert.ok(model.buildRenderPlan(ws).panelIds.includes('f1'));
    ws = act(ws, { type: 'pane-split', groupId: 'default', enabled: false });
    assert.equal(model.groupStacks(ws, 'default').flatMap(node => node.items).filter(item => item.tabId === 'f1').length, 1);
    roundtrip(ws);
});
test('damaged tree snapshot removes duplicate projections and retains all business leaves', () => {
    const ws = add(splitShells('right', 2)), saved = codec.serializeWorkspaceLayout(ws);
    saved.layout.root.children.push(null, structuredClone(saved.layout.root.children[0]));
    const repaired = codec.restoreWorkspaceLayout(ws, saved);
    assert.deepEqual(model.validateLayout(repaired), []);
    assert.deepEqual(new Set(model.buildRenderPlan(repaired).panelIdsAll), new Set(model.buildRenderPlan(ws).panelIdsAll));
    roundtrip(repaired);
});
test('explicit root collapse keeps every tab activatable and removes only root geometry', () => {
    let ws = act(add(splitShells('right', 2)), { type: 'collapse-all' });
    assert.equal(ws.layout.root.type, 'stack');
    for (const id of ['tab-main', 'f1', 'tab-shell-1', 'tab-shell-2', 'mb']) {
        ws = act(ws, { type: 'activate', tabId: id });
        assert.ok(model.buildRenderPlan(ws).panelIds.includes(id));
    }
    roundtrip(ws);
});
test('splitting a multi-anchor group never duplicates another anchor content', () => {
    let ws = add(act(splitShells(), { type: 'split-tab', tabId: 'f1', direction: 'left' }));
    ws = act(ws, { type: 'split-group', groupId: 'default', direction: 'bottom' });
    assert.equal(model.groupStacks(ws, 'default').flatMap(node => node.items).filter(item => item.tabId === 'f1').length, 1);
    roundtrip(ws);
});
test('unsplit flat Shell selection uses the same root Stack and leaves serial tabs reachable', () => {
    let ws = act(fixture(), { type: 'activate', tabId: 'tab-shell-1' });
    assert.equal(model.buildRenderPlan(ws).root.rowRole, 'root');
    ws = act(ws, { type: 'activate', tabId: 'tab-main' });
    assert.deepEqual(model.buildRenderPlan(ws).panelIds, ['tab-main']);
});
test('co-stacked same-owner anchors retain both nested directions and ratios when unwrapped', () => {
    let ws = act(fixture(), { type: 'split-tab', tabId: 'f1', direction: 'right' });
    ws = add(ws);
    ws = act(ws, { type: 'add-leaf', groupId: 'default', paneId: model.locateTab(ws, 'f1').stack.id, options: { id: 'extra', kind: 'filter' } });
    ws = act(ws, { type: 'split-tab', tabId: 'extra', direction: 'bottom' });
    const anchors = model.tree.stacks(ws.layout.root).flatMap(node => node.items).filter(item => item.tabId === 'default');
    const target = model.locateTab(ws, 'default', anchors[0].id).stack.id;
    ws = act(ws, { type: 'move', tabId: 'default', itemId: anchors[1].id, target: { nodeId: target } });
    const content = anchors.map(item => structuredClone(model.locateTab(ws, 'default', item.id).item.content));
    ws = act(ws, { type: 'remove-group', groupId: 'b' });
    for (const branch of content.filter(node => node.type === 'split')) {
        const restored = model.tree.find(ws.layout.root, branch.id).node;
        assert.equal(restored.orientation, branch.orientation); assert.deepEqual(restored.weights, branch.weights);
        assert.deepEqual(restored.children.map(node => node.id), branch.children.map(node => node.id));
        for (const oldStack of model.tree.stacks(branch)) {
            const node = model.tree.find(ws.layout.root, oldStack.id).node;
            assert.deepEqual(node.items.filter(item => ws.tabs[item.tabId].kind !== 'shell'), oldStack.items);
            assert.equal(node.activeItemId, oldStack.activeItemId);
        }
    }
    roundtrip(ws);
});

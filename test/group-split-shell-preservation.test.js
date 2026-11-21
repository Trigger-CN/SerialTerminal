'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { model, fixture, act, regions, resize, roundtrip } = require('./workspace-tree-fixture');
function setup() {
    let ws = act(fixture(true), { type: 'split-tab', tabId: 'tab-shell-1', direction: 'right' });
    ws = resize(ws);
    return ws;
}
test('repositioning a separate group leaves independent Shell geometry and selection intact', () => {
    let ws = act(setup(), { type: 'split-group', groupId: 'b' });
    const shell = structuredClone(model.locateTab(ws, 'tab-shell-1').stack), rect = regions(ws)['tab-shell-1'];
    ws = act(ws, { type: 'split-group', groupId: 'b', direction: 'left', activate: false });
    assert.deepEqual(model.locateTab(ws, 'tab-shell-1').stack, shell);
    assert.deepEqual(regions(ws)['tab-shell-1'], rect);
});
test('splitting a shared serial Stack takes space only from that branch', () => {
    const ws = setup(), before = JSON.stringify(ws), shell = regions(ws)['tab-shell-1'];
    const next = act(ws, { type: 'split-group', groupId: 'b' });
    assert.equal(JSON.stringify(ws), before);
    assert.deepEqual(regions(next)['tab-shell-1'], shell);
    assert.equal(model.locateTab(next, 'default').stack.id, model.locateTab(next, 'c').stack.id);
    assert.notEqual(model.locateTab(next, 'b').stack.id, model.locateTab(next, 'c').stack.id);
});
test('an intervening Shell region retains its stable identity and relative order', () => {
    let ws = act(setup(), { type: 'split-group', groupId: 'b' });
    const id = model.locateTab(ws, 'tab-shell-1').stack.id;
    ws = act(ws, { type: 'split-group', groupId: 'c', direction: 'left' });
    assert.equal(model.locateTab(ws, 'tab-shell-1').stack.id, id);
    assert.equal(model.tree.stacks(ws.layout.root).at(-1).id, id);
});
test('moving a selected group leaves a co-stacked Shell in its source region', () => {
    let ws = fixture(true);
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' });
    const id = model.locateTab(ws, 'tab-shell-1').stack.id;
    ws = act(ws, { type: 'split-group', groupId: 'default', activate: false });
    assert.equal(model.locateTab(ws, 'tab-shell-1').stack.id, id);
    assert.equal(model.locateTab(ws, 'tab-shell-1').stack.activeItemId, 'tab-shell-1');
    assert.equal(ws.focusedTabId, 'tab-shell-1');
});
test('saved layouts retain Shell branch weight, position and local selection', () => {
    const ws = act(setup(), { type: 'split-group', groupId: 'b' });
    assert.deepEqual(roundtrip(ws).layout, ws.layout);
});
test('two Shells retain local selection while another serial group gains focus and splits', () => {
    let ws = setup(), target = model.locateTab(ws, 'tab-shell-1').stack.id;
    ws = act(ws, { type: 'move', tabId: 'tab-shell-2', target: { nodeId: target } });
    ws = act(ws, { type: 'activate', tabId: 'tab-main' });
    ws = act(ws, { type: 'split-group', groupId: 'b' });
    assert.equal(model.locateTab(ws, 'tab-shell-1').stack.activeItemId, 'tab-shell-2');
    assert.ok(model.buildRenderPlan(ws).panelIds.includes('tab-shell-2'));
    roundtrip(ws);
});
test('four-direction group placement leaves unrelated nested group content unchanged', () => {
    let ws = act(setup(), { type: 'split-tab', tabId: 'fc', direction: 'bottom' });
    const content = structuredClone(model.locateTab(ws, 'c').item.content), rect = regions(ws)['tab-shell-1'];
    ws = act(ws, { type: 'split-group', groupId: 'b', direction: 'left' });
    assert.deepEqual(model.locateTab(ws, 'c').item.content, content);
    assert.deepEqual(regions(ws)['tab-shell-1'], rect);
});

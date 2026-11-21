'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');

function apply(ws, action) {
    const result = model.applyWorkspaceAction(ws, action);
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(model.validateLayout(result.workspace), []);
    return result.workspace;
}
function base() {
    let ws = model.createWorkspace();
    ws = apply(ws, { type: 'add-leaf', groupId: 'grp-default', options: { id: 'shell-a', kind: 'shell' } });
    ws = apply(ws, { type: 'add-group', options: { id: 'second', mainId: 'main-second' } });
    return ws;
}
function position(ws, tabId) { return model.locateTab(ws, tabId); }
function split(ws, tabId, direction, targetNodeId) {
    return apply(ws, { type: 'split', source: { tabId }, target: { nodeId: targetNodeId || position(ws, tabId).stack.id }, direction });
}

test('local group merge keeps the independent Shell branch and all business identities', () => {
    let ws = base();
    ws = split(ws, 'second', 'right');
    ws = split(ws, 'shell-a', 'left');
    const shell = position(ws, 'shell-a');
    const snapshot = JSON.stringify(shell.stack);
    ws = apply(ws, { type: 'merge', source: { tabId: 'second' } });
    assert.equal(position(ws, 'second').stack.id, position(ws, 'grp-default').stack.id);
    assert.equal(JSON.stringify(position(ws, 'shell-a').stack), snapshot);
    assert.notEqual(position(ws, 'shell-a').stack.id, position(ws, 'second').stack.id);
    assert.ok(ws.tabs.second && ws.tabs['main-second'] && ws.tabs['shell-a']);
});

test('Shell left/right are explicit, and separate Shells never share a special column identity', () => {
    for (const direction of ['left', 'right', 'top', 'bottom']) {
        let ws = base();
        ws = split(ws, 'shell-a', direction);
        const root = ws.layout.root;
        assert.equal(root.type, 'split');
        assert.equal(root.orientation, ['left', 'right'].includes(direction) ? 'horizontal' : 'vertical');
        assert.equal(root.children[['left', 'top'].includes(direction) ? 0 : 1].id, position(ws, 'shell-a').stack.id);
        ws = apply(ws, { type: 'add-leaf', groupId: 'grp-default', options: { id: 'shell-b', kind: 'shell' } });
        ws = split(ws, 'shell-b', 'bottom');
        assert.notEqual(position(ws, 'shell-a').stack.id, position(ws, 'shell-b').stack.id);
        assert.ok(!JSON.stringify(ws.layout).includes('__shell__'));
    }
});

test('nested splits and pair resize preserve an unrelated branch byte-for-byte', () => {
    let ws = base();
    ws = split(ws, 'second', 'right');
    const second = JSON.stringify(position(ws, 'second').stack);
    ws = split(ws, 'shell-a', 'bottom');
    const nested = ws.layout.root.children.find(node => node.type === 'split');
    assert.equal(ws.layout.root.orientation, 'horizontal');
    assert.equal(nested.orientation, 'vertical');
    ws = apply(ws, { type: 'resize', splitNodeId: nested.id, beforeId: nested.children[0].id,
        afterId: nested.children[1].id, ratio: 0.3 });
    assert.deepEqual(ws.layout.root.weights, [0.5, 0.5]);
    assert.deepEqual(ws.layout.root.children.find(node => node.id === nested.id).weights, [0.3, 0.7]);
    assert.equal(JSON.stringify(position(ws, 'second').stack), second);
});

test('invalid targets and cross-owner movement are atomic; existing-stack move does not split', () => {
    let ws = base();
    const original = JSON.stringify(ws);
    const rejected = model.applyWorkspaceAction(ws, { type: 'split', source: { tabId: 'shell-a' }, target: { nodeId: 'gone' }, direction: 'left' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.workspace, ws);
    assert.equal(JSON.stringify(ws), original);
    assert.equal(model.applyWorkspaceAction(ws, { type: 'move', tabId: 'main-second', target: { nodeId: position(ws, 'shell-a').stack.id } }).ok, false);
    ws = split(ws, 'shell-a', 'right');
    const target = position(ws, 'second').stack.id;
    ws = apply(ws, { type: 'move', tabId: 'shell-a', target: { nodeId: target, index: 1 } });
    assert.equal(position(ws, 'shell-a').stack.id, target);
    assert.equal(ws.layout.root.type, 'stack');
});

test('single/multiple roundtrip preserves distinct regions, owners, order and local selections', () => {
    let ws = model.createWorkspace();
    const main = Object.values(ws.tabs).find(tab => tab.kind === 'main').id;
    for (const [id, kind] of [['filter-a', 'filter'], ['shell-a', 'shell'], ['shell-b', 'shell']]) {
        ws = apply(ws, { type: 'add-leaf', groupId: 'grp-default', options: { id, kind } });
    }
    ws = split(ws, 'shell-a', 'left');
    ws = split(ws, 'shell-b', 'bottom');
    ws = split(ws, 'filter-a', 'right');
    const beforeShells = ['shell-a', 'shell-b'].map(id => JSON.stringify(position(ws, id).stack));
    ws = apply(ws, { type: 'add-group', options: { id: 'second', mainId: 'main-second' } });
    assert.equal(ws.tabs[main].ownerGroupId, 'grp-default');
    assert.equal(ws.tabs['filter-a'].ownerGroupId, 'grp-default');
    assert.deepEqual(['shell-a', 'shell-b'].map(id => JSON.stringify(position(ws, id).stack)), beforeShells);
    ws = apply(ws, { type: 'remove-group', groupId: 'second' });
    assert.deepEqual(['shell-a', 'shell-b'].map(id => JSON.stringify(position(ws, id).stack)), beforeShells);
    ws = apply(ws, { type: 'move', tabId: main, target: { nodeId: position(ws, 'shell-a').stack.id } });
    assert.equal(position(ws, main).stack.id, position(ws, 'shell-a').stack.id);
    assert.equal(ws.tabs[main].ownerGroupId, 'grp-default');
});

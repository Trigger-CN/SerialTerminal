'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { createWorkspaceModelManager } = require('../src/workspace/workspace-model-manager');
function fixture(multi = false) {
    return importWorkspace({ groups: [{ id: 'default' }, ...(multi ? [{ id: 'b' }, { id: 'c' }] : [])],
        filterTabs: { default: [{ id: 'f1' }, { id: 'f2' }], c: [{ id: 'fc' }] },
        shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }], focusedTabId: 'tab-main' });
}
function act(ws, action) { const r = m.applyWorkspaceAction(ws, action); assert.equal(r.ok, true, r.reason); return r.workspace; }
function split(ws, id, activate = true) { return act(ws, { type: 'split-tab', tabId: id, activate }); }
test('same Stack reorder preserves focused leaf and local selection, including the active member', () => {
    let ws = act(fixture(), { type: 'activate', tabId: 'tab-shell-1' });
    const nodeId = m.locateTab(ws, 'f1').stack.id;
    for (const tabId of ['f1', 'tab-shell-1']) {
        ws = act(ws, { type: 'move', tabId, target: { nodeId, index: 0 } });
        assert.equal(ws.focusedTabId, 'tab-shell-1');
        assert.equal(m.locateTab(ws, tabId).stack.activeItemId, 'tab-shell-1');
    }
});
test('background moves preserve target selection; moving focused leaf keeps it visible', () => {
    let ws = split(fixture(), 'f1');
    const target = m.locateTab(ws, 'f1').stack.id;
    const origin = m.locateTab(ws, 'tab-main').stack.id;
    ws = act(ws, { type: 'move', tabId: 'f2', activate: false, target: { nodeId: target } });
    assert.equal(m.locateTab(ws, 'f2').stack.activeItemId, 'f1');
    ws = act(ws, { type: 'move', tabId: 'f1', activate: false, target: { nodeId: origin } });
    assert.equal(ws.focusedTabId, 'f1');
    assert.ok(m.buildRenderPlan(ws).panelIds.includes('f1'));
    assert.equal(m.locateTab(ws, 'f2').stack.activeItemId, 'f2');
});
test('new group selects its main unless background creation is requested', () => {
    let ws = act(fixture(), { type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    assert.equal(ws.focusedTabId, 'mb');
    ws = act(ws, { type: 'add-group', activate: false, options: { id: 'c', mainId: 'mc' } });
    assert.equal(ws.focusedTabId, 'mb');
    assert.ok(m.buildRenderPlan(ws).panelIds.includes('mb'));
});
test('Shell close honors control-group fallback while preserving group-local pane selections', () => {
    let ws = split(fixture(true), 'fc');
    const activePane = m.locateTab(ws, 'fc').stack.id;
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-2' });
    assert.equal(m.groupLayout(ws, 'c').activePaneId, activePane);
    const before = m.groupLayout(ws, 'c').panes;
    ws = act(ws, { type: 'close', tabId: 'tab-shell-2', fallbackTabId: 'fc' });
    assert.equal(ws.focusedTabId, 'fc');
    assert.deepEqual(m.groupLayout(ws, 'c').panes, before);
    assert.ok(m.buildRenderPlan(ws).panelIds.includes('fc'));
});
test('flat Shell close prefers adjacent member and background close never changes focus', () => {
    let ws = act(fixture(), { type: 'activate', tabId: 'tab-shell-1' });
    const hit = m.locateTab(ws, 'tab-shell-1');
    const expected = hit.stack.items[hit.index + 1]?.tabId || hit.stack.items[hit.index - 1].tabId;
    ws = act(ws, { type: 'close', tabId: 'tab-shell-1', fallbackTabId: 'tab-main' });
    assert.equal(ws.focusedTabId, expected);
    ws = act(ws, { type: 'close', tabId: 'f1' });
    assert.equal(ws.focusedTabId, expected);
});
test('manager restores a complete tree snapshot atomically and rejects lost membership', () => {
    let ws = split(fixture(), 'f1');
    const manager = createWorkspaceModelManager({ groupId: 'default', getWorkspace: () => ws,
        dispatch: action => { const r = m.applyWorkspaceAction(ws, action); if (r.ok) ws = r.workspace; return r; } });
    const saved = manager.getLayoutSnapshot();
    manager.collapseSplit();
    assert.equal(manager.restoreLayout(saved), true);
    assert.deepEqual(manager.getLayoutSnapshot().trees, saved.trees);
    const invalid = manager.getLayoutSnapshot();
    invalid.trees[0].children.pop();
    const before = ws;
    assert.equal(manager.restoreLayout(invalid), false);
    assert.equal(ws, before);
});

test('collapse-group needs multiple rows, keeps a visible restore entry and clears after merge', () => {
    let ws = fixture();
    assert.equal(m.applyWorkspaceAction(ws, { type: 'collapse-group', groupId: 'default', collapsed: true }).ok, false);
    ws = split(ws, 'f1');
    ws = act(ws, { type: 'collapse-group', groupId: 'default', collapsed: true });
    const rows = []; const visit = node => node.type === 'split' ? node.children.forEach(visit) : rows.push(node);
    visit(m.buildRenderPlan(ws).root);
    assert.equal(rows.filter(row => !row.headerHidden).length, 1);
    assert.equal(rows.filter(row => row.canCollapse).length, 1);
    assert.equal(m.buildRenderPlan(ws).panelIds.length, 2);
    const oracle = require('./tab-model-acceptance');
    const broken = fixture(); broken.tabs.default.collapsed = true;
    assert.ok(oracle.checkInvariants(m.withDiagnostics(broken)).some(error => error.startsWith('I10')));
    ws = act(ws, { type: 'collapse-all' });
    assert.equal(ws.tabs.default.collapsed, false);
});
test('runtime validation rejects panel duplication, malformed anchors, colliding identities and hidden focus', () => {
    for (const corrupt of [
        ws => { ws.tabs.f1.panel.id = ws.tabs.f2.panel.id; },
        ws => { m.locateTab(ws, 'default').item.content = null; },
        ws => { const hit = m.locateTab(ws, 'f1'); hit.stack.id = hit.item.id; },
        ws => { ws.focusedTabId = 'f1'; }
    ]) {
        const ws = fixture(true); corrupt(ws);
        assert.ok(m.validateLayout(ws).length);
        const before = JSON.stringify(ws), result = m.applyWorkspaceAction(ws, { type: 'collapse-group', groupId: 'b', collapsed: false });
        assert.equal(result.ok, false); assert.equal(result.workspace, ws); assert.equal(JSON.stringify(ws), before);
    }
});

test('group-scoped collapse merges all owner anchors without moving Shell or other groups', () => {
    let ws = split(fixture(), 'f1');
    ws = act(ws, { type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    ws = act(ws, { type: 'split-tab', tabId: 'tab-shell-1' });
    const shellStack = JSON.parse(JSON.stringify(m.locateTab(ws, 'tab-shell-1').stack));
    const other = m.groupLayout(ws, 'b').trees;
    assert.equal(m.groupStacks(ws, 'default').length, 2);
    ws = act(ws, { type: 'collapse-all', scopeGroupId: 'default' });
    assert.equal(m.groupStacks(ws, 'default').length, 1);
    assert.deepEqual(m.locateTab(ws, 'tab-shell-1').stack, shellStack);
    assert.deepEqual(m.groupLayout(ws, 'b').trees, other);
    assert.deepEqual(m.validateLayout(ws), []);
});

test('explicit stale node or mismatched member identity rejects without fallback or partial publication', () => {
    const ws = fixture(true), item = m.locateTab(ws, 'tab-shell-1').item;
    for (const action of [
        { type: 'move', tabId: 'tab-shell-1', itemId: item.id, target: { nodeId: 'gone', type: 'pane', groupId: 'default' } },
        { type: 'split', source: { tabId: 'f1', itemId: item.id }, target: { nodeId: m.locateTab(ws, 'tab-shell-1').stack.id }, direction: 'right' }
    ]) {
        const before = JSON.stringify(ws), result = m.applyWorkspaceAction(ws, action);
        assert.equal(result.ok, false); assert.equal(result.workspace, ws); assert.equal(JSON.stringify(ws), before);
    }
});

test('collapsed multi-anchor owner keeps a restore control in its visible anchor', () => {
    let ws = split(fixture(), 'f1');
    ws = act(ws, { type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-2' });
    ws = act(ws, { type: 'activate', tabId: 'f1' });
    ws = act(ws, { type: 'collapse-group', groupId: 'default', collapsed: true });
    const rows = []; const visit = node => {
        if (node.type === 'split') node.children.forEach(visit);
        else { rows.push(node); node.members.forEach(item => { if (item.content) visit(item.content); }); }
    };
    visit(m.buildRenderPlan(ws).root);
    const visible = rows.filter(row => row.groupId === 'default' && row.visible);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].headerHidden, false);
    assert.equal(visible[0].canCollapse, true);
});

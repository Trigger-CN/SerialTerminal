'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const codec = require('../src/workspace/workspace-layout-state');

function act(ws, action) {
    const result = model.applyWorkspaceAction(ws, action);
    assert.equal(result.ok, true, result.reason);
    return result.workspace;
}

function fixture(explicit = false) {
    model.resetIdSeq();
    let ws = model.createWorkspace();
    const first = model.roots(ws).find(model.isContainer);
    const shell = model.addShell(ws);
    const second = model.addContainerTab(ws, { id: 'second', mainId: 'second-main' });
    const third = model.addContainerTab(ws, { id: 'third', mainId: 'third-main' });
    model.setLeafColumnMode(ws, shell.id, 'ownColumn');
    model.setColumnSplit(ws, true, 'horizontal');
    if (explicit) {
        ws.split.columns = [{ id: first.id, groupIds: [first.id, second.id, third.id] }];
        ws.split.activeTabs = { [first.id]: first.panes[0].tabIds[0] };
    }
    ws = act(ws, { type: 'activate', tabId: shell.id });
    const ids = model.layoutColumns(ws).map(column => column.id);
    ws = act(ws, { type: 'resize-columns', sizes: explicit
        ? { [first.id]: 0.6, [model.OWN_COLUMN_ID]: 0.4 }
        : Object.fromEntries(ids.map(id => [id, id === model.OWN_COLUMN_ID ? 0.4 : 0.2])) });
    return { ws, first, second, third, shell };
}

function shellColumn(ws) {
    return model.buildRenderPlan(ws).columns.find(column => column.columnId === model.OWN_COLUMN_ID);
}

test('splitting an already separate group preserves existing Shell and serial columns', () => {
    const { ws, second, shell } = fixture();
    const before = model.buildRenderPlan(ws);
    const original = JSON.stringify(ws);
    const next = act(ws, { type: 'split-group', groupId: second.id, orientation: 'horizontal' });
    const after = model.buildRenderPlan(next);
    assert.equal(JSON.stringify(ws), original);
    assert.deepEqual(after.columns.map(column => column.columnId), before.columns.map(column => column.columnId));
    assert.deepEqual(shellColumn(next), shellColumn(ws));
    assert.equal(next.focusedTabId, shell.id);
    assert.deepEqual(next.split.sizes, ws.split.sizes);
});

test('splitting a shared serial column takes space only from that column and preserves the Shell column', () => {
    const { ws, first, second, third } = fixture(true);
    const next = act(ws, { type: 'split-group', groupId: second.id, orientation: 'horizontal' });
    assert.deepEqual(next.split.columns.map(column => column.groupIds), [[first.id, third.id], [second.id]]);
    assert.equal(shellColumn(next).size, shellColumn(ws).size);
    assert.deepEqual(shellColumn(next).panelIds, shellColumn(ws).panelIds);
    assert.equal(next.split.sizes[model.OWN_COLUMN_ID], 0.4);
    assert.equal(next.split.sizes[first.id], 0.3);
    assert.equal(next.split.sizes[second.id], 0.3);
    assert.equal(next.split.activeTabs[first.id], ws.split.activeTabs[first.id]);
});

test('a Shell column between serial columns keeps its position when explicit columns are introduced', () => {
    const { ws, second } = fixture();
    const before = model.layoutColumns(ws).map(column => column.id);
    assert.equal(before[1], model.OWN_COLUMN_ID);
    const next = act(ws, { type: 'split-group', groupId: second.id, orientation: 'horizontal' });
    assert.deepEqual(model.layoutColumns(next).map(column => column.id), before);
});

test('splitting a source whose column ID is the moved group preserves row Shell activation in the source', () => {
    const { ws, first, second, third, shell } = fixture(true);
    model.setLeafColumnMode(ws, shell.id, 'row');
    model.setLeafColumn(ws, shell.id, first.id);
    ws.split.sizes = { [first.id]: 1 };
    ws.split.activeTabs[first.id] = shell.id;
    const next = act(ws, { type: 'split-group', groupId: first.id, orientation: 'horizontal' });
    assert.deepEqual(next.split.columns.map(column => column.groupIds), [[second.id, third.id], [first.id]]);
    assert.equal(next.tabs[shell.id].columnId, second.id);
    assert.equal(next.split.activeTabs[second.id], shell.id);
    assert.ok(model.buildRenderPlan(next).panelIds.includes(shell.id));
    assert.equal(next.split.activeTabs[first.id], first.panes[0].activeTabId);
});

test('saved layouts retain preserved Shell width, position and selection after a group split', () => {
    const { ws, second } = fixture(true);
    const next = act(ws, { type: 'split-group', groupId: second.id, orientation: 'horizontal' });
    const saved = codec.serializeWorkspaceLayout(next);
    const restored = codec.restoreWorkspaceLayout(next, saved);
    assert.deepEqual(codec.serializeWorkspaceLayout(restored), saved);
    const visible = ws_ => model.buildRenderPlan(ws_).columns.map(column => ({
        id: column.columnId, size: column.size, panelIds: column.panelIds, tabs: column.tabItems.map(tab => tab.id)
    }));
    assert.deepEqual(visible(restored), visible(next));
});

test('Shell column keeps its locally selected Shell when a serial group gains focus and splits', () => {
    const { ws, first, second, shell } = fixture();
    const another = model.addShell(ws);
    model.setLeafColumnMode(ws, another.id, 'ownColumn');
    let current = act(ws, { type: 'activate', tabId: another.id });
    current = act(current, { type: 'activate', tabId: first.panes[0].activeTabId });
    assert.deepEqual(shellColumn(current).panelIds, [another.id]);
    const next = act(current, { type: 'split-group', groupId: second.id, orientation: 'horizontal' });
    assert.deepEqual(shellColumn(next).panelIds, [another.id]);
    assert.equal(next.tabs[shell.id].columnMode, 'ownColumn');
    const restored = codec.restoreWorkspaceLayout(next, codec.serializeWorkspaceLayout(next));
    assert.deepEqual(shellColumn(restored).panelIds, [another.id]);
});

test('splitting before the source preserves other columns and group pane geometry', () => {
    const { ws, first, second, third } = fixture(true);
    const filter = model.addLeaf(ws, 'filter', third.id);
    let current = act(ws, { type: 'split-tab', tabId: filter.id, groupId: third.id, paneId: 'third-extra', orientation: 'vertical' });
    const before = JSON.stringify(current.tabs[third.id]);
    const next = act(current, { type: 'split-group', groupId: second.id, before: true, orientation: 'horizontal' });
    assert.deepEqual(next.split.columns.map(column => column.groupIds), [[second.id], [first.id, third.id]]);
    assert.equal(JSON.stringify(next.tabs[third.id]), before);
    assert.equal(shellColumn(next).size, shellColumn(current).size);
});

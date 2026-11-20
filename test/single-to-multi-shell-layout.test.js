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

function regions(ws) {
    const plan = model.buildRenderPlan(ws);
    const result = {};
    let columnOffset = 0;
    for (const column of plan.columns) {
        const outerVertical = plan.columnLayout.orientation === 'vertical';
        const size = plan.columns.length > 1 ? column.size : 1;
        const rect = outerVertical ? [0, columnOffset, 1, size] : [columnOffset, 0, size, 1];
        const rows = column.rows;
        let paneOffset = 0;
        for (const id of column.panelIds) {
            const row = rows.find(item => item.activeTabId === id || item.tabs.some(tab => tab.id === id));
            const index = rows.indexOf(row);
            if (column.splitEnabled && rows.length > 1 && index >= 0) {
                paneOffset = rows.slice(0, index).reduce((sum, item) => sum + column.paneSizes[item.paneId], 0);
                const paneSize = column.paneSizes[row.paneId];
                result[id] = column.orientation === 'vertical'
                    ? [rect[0], rect[1] + rect[3] * paneOffset, rect[2], rect[3] * paneSize]
                    : [rect[0] + rect[2] * paneOffset, rect[1], rect[2] * paneSize, rect[3]];
            } else result[id] = rect;
        }
        columnOffset += size;
    }
    return result;
}

function splitShells(orientation, count = 1) {
    model.resetIdSeq();
    let ws = model.createWorkspace();
    const group = model.roots(ws).find(model.isContainer);
    const mainId = group.panes[0].activeTabId;
    const shells = [];
    for (let i = 0; i < count; i++) {
        const shell = model.addShell(ws);
        shells.push(shell.id);
        ws = act(ws, { type: 'split-tab', tabId: shell.id, groupId: group.id, paneId: `shell-pane-${i}`, orientation });
    }
    const panes = ws.tabs[group.id].panes;
    const sizes = Object.fromEntries(panes.map((pane, i) => [pane.id, i === 0 ? 0.6 : 0.4 / count]));
    ws = act(ws, { type: 'resize-panes', groupId: group.id, sizes });
    return { ws, groupId: group.id, mainId, shells };
}

for (const orientation of ['horizontal', 'vertical']) {
    test(`adding a second group preserves existing ${orientation} Shell split regions`, () => {
        const { ws, shells, mainId } = splitShells(orientation);
        const original = JSON.stringify(ws);
        const before = regions(ws);
        const next = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
        assert.equal(JSON.stringify(ws), original);
        assert.deepEqual(regions(next), before);
        assert.equal(next.tabs[shells[0]].parentId, null);
        assert.equal(next.tabs[mainId].parentId, model.roots(ws).find(model.isContainer).id);
        const focused = act(next, { type: 'activate', tabId: 'second-main' });
        assert.deepEqual(regions(focused)[shells[0]], before[shells[0]]);
        const saved = codec.serializeWorkspaceLayout(focused);
        assert.deepEqual(codec.serializeWorkspaceLayout(codec.restoreWorkspaceLayout(focused, saved)), saved);
        assert.deepEqual(regions(codec.restoreWorkspaceLayout(focused, saved)), regions(focused));
    });
}

test('adding a group preserves distinct Shell-only splits instead of combining the Shells', () => {
    const { ws, shells } = splitShells('horizontal', 2);
    const next = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    assert.deepEqual(regions(next), regions(ws));
    assert.equal(model.buildRenderPlan(next).panelIds.filter(id => shells.includes(id)).length, 2);
});

function roundtrip(ws) {
    const saved = codec.serializeWorkspaceLayout(ws);
    const restored = codec.restoreWorkspaceLayout(ws, saved);
    const stable = value => JSON.parse(JSON.stringify(value, (_key, item) =>
        typeof item === 'number' ? Math.round(item * 1e12) / 1e12 : item));
    assert.deepEqual(stable(codec.serializeWorkspaceLayout(restored)), stable(saved));
    assert.deepEqual(stable(regions(restored)), stable(regions(ws)));
}

test('conversion preserves a Shell before the serial region and its selected sibling', () => {
    let { ws, groupId, shells } = splitShells('horizontal');
    const group = ws.tabs[groupId];
    group.panes.reverse();
    group.paneSplit.sizes = { [group.panes[0].id]: 0.4, [group.panes[1].id]: 0.6 };
    const sibling = model.addShell(ws);
    ws = act(ws, { type: 'move', tabId: sibling.id, target: { kind: 'pane', groupId, paneId: group.panes[0].id } });
    const next = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    assert.deepEqual(regions(next), regions(ws));
    assert.ok(!model.buildRenderPlan(next).panelIds.includes(shells[0]));
    roundtrip(next);
});

test('conversion keeps separate main/filter regions and a mixed Shell selection without changing serial owners', () => {
    let { ws, groupId } = splitShells('vertical');
    ws = act(ws, { type: 'activate', tabId: ws.tabs[groupId].panes[0].activeTabId });
    const filter = model.addLeaf(ws, 'filter', groupId);
    ws = act(ws, { type: 'split-tab', tabId: filter.id, groupId, paneId: 'filter-region', orientation: 'vertical' });
    const mixed = model.addShell(ws);
    ws = act(ws, { type: 'move', tabId: mixed.id, target: { kind: 'pane', groupId, paneId: 'filter-region' } });
    const next = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    assert.deepEqual(regions(next), regions(ws));
    assert.equal(next.tabs[filter.id].parentId, groupId);
    const focused = act(next, { type: 'activate', tabId: filter.id });
    assert.ok(model.buildRenderPlan(focused).panelIds.includes(filter.id));
    roundtrip(focused);
});

test('closing the added group restores single-group freedom without collapsing existing Shell regions', () => {
    const { ws } = splitShells('horizontal', 2);
    let current = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    current = act(current, { type: 'remove-group', groupId: 'second' });
    assert.deepEqual(regions(current), regions(ws));
    roundtrip(current);
});

test('splitting the new group after conversion keeps the original Shell region', () => {
    const { ws, shells } = splitShells('horizontal');
    const added = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    const next = act(added, { type: 'split-group', groupId: 'second', orientation: 'horizontal' });
    assert.deepEqual(regions(next)[shells[0]], regions(ws)[shells[0]]);
    roundtrip(next);
});


test('adding a group to an existing outer Shell split keeps its width and column count', () => {
    model.resetIdSeq();
    let ws = model.createWorkspace();
    const group = model.roots(ws).find(model.isContainer);
    const shell = model.addShell(ws);
    ws = act(ws, { type: 'shell-placement', tabId: shell.id, placement: { columnMode: 'ownColumn' } });
    ws = act(ws, { type: 'column-split', enabled: true, orientation: 'vertical' });
    ws = act(ws, { type: 'resize-columns', sizes: { [group.id]: 0.65, [model.OWN_COLUMN_ID]: 0.35 } });
    const next = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    assert.deepEqual(regions(next), regions(ws));
    assert.equal(model.buildRenderPlan(next).columns.length, 2);
    assert.deepEqual(regions(act(next, { type: 'activate', tabId: 'second-main' }))[shell.id], regions(ws)[shell.id]);
    roundtrip(next);
});

test('closing an ordinary split group still collapses the group split', () => {
    let ws = model.createWorkspace();
    ws = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    ws = act(ws, { type: 'split-group', groupId: 'second', orientation: 'horizontal' });
    ws = act(ws, { type: 'remove-group', groupId: 'second' });
    assert.equal(ws.split.enabled, false);
});

for (const type of ['close', 'move']) {
    test(`${type} of the last Shell in a converted region removes the empty region and stale sizes`, () => {
        const setup = splitShells('horizontal', 2);
        let ws = act(setup.ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
        const before = model.buildRenderPlan(ws);
        const sourceId = before.columns.find(column => column.panelIds.includes(setup.shells[0])).columnId;
        const destination = before.columns.find(column => column.panelIds.includes(setup.shells[1])).columnId;
        ws = act(ws, type === 'close' ? { type, tabId: setup.shells[0] }
            : { type, tabId: setup.shells[0], target: { kind: 'roots', columnId: destination, index: 1 } });
        assert.equal(model.buildRenderPlan(ws).columns.length, 2);
        assert.ok(!ws.split.columns.some(column => column.id === sourceId));
        assert.ok(!(sourceId in ws.split.sizes));
        roundtrip(ws);
    });
}

test('returning to one group restores free pane movement and can convert again', () => {
    const setup = splitShells('horizontal', 2);
    let ws = act(setup.ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    ws = act(ws, { type: 'remove-group', groupId: 'second' });
    const shellPane = model.paneOfTab(ws, ws.tabs[setup.shells[0]]);
    assert.ok(shellPane, 'single-group Shell region must be a regular movable pane again');
    ws = act(ws, { type: 'move', tabId: setup.mainId, target: { kind: 'pane', groupId: setup.groupId, paneId: shellPane.pane.id } });
    const before = regions(ws);
    ws = act(ws, { type: 'add-group', options: { id: 'third', mainId: 'third-main' } });
    assert.deepEqual(regions(ws), before);
    roundtrip(ws);
});

test('splitting and merging serial panes after conversion does not lose projected leaves', () => {
    const setup = splitShells('horizontal');
    let ws = act(setup.ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    ws = act(ws, { type: 'activate', tabId: setup.mainId });
    ws = act(ws, { type: 'add-leaf', groupId: setup.groupId, options: { id: 'filter-extra', kind: 'filter' } });
    ws = act(ws, { type: 'split-tab', groupId: setup.groupId, tabId: 'filter-extra', paneId: 'extra-pane', orientation: 'vertical' });
    assert.ok(model.buildRenderPlan(ws).panelIds.includes(setup.mainId));
    assert.ok(model.buildRenderPlan(ws).panelIds.includes('filter-extra'));
    assert.deepEqual(regions(ws)[setup.shells[0]], regions(setup.ws)[setup.shells[0]]);
    roundtrip(ws);
    ws = act(ws, { type: 'pane-split', groupId: setup.groupId, enabled: false });
    assert.equal(model.buildRenderPlan(ws).subRowTabIds.filter(id => id === 'filter-extra').length, 1);
    roundtrip(ws);
});


test('damaged region snapshots deduplicate columns and pane projections without hiding serial leaves', () => {
    let { ws, groupId } = splitShells('horizontal');
    ws = act(ws, { type: 'activate', tabId: ws.tabs[groupId].panes[0].activeTabId });
    const filter = model.addLeaf(ws, 'filter', groupId);
    ws = act(ws, { type: 'split-tab', groupId, tabId: filter.id, paneId: 'filter-region', orientation: 'horizontal' });
    ws = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    const saved = codec.serializeWorkspaceLayout(ws);
    saved.split.columns.push(null, { ...saved.split.columns[0] },
        { id: 'duplicate-projection', groupIds: [], containerId: groupId, paneIds: [ws.tabs[groupId].panes[0].id] },
        { id: 'missing-projection', groupIds: [], containerId: 'missing', paneIds: ['missing'] });
    const restored = codec.restoreWorkspaceLayout(ws, saved);
    const plan = model.buildRenderPlan(restored);
    assert.equal(new Set(plan.columns.map(column => column.columnId)).size, plan.columns.length);
    const paneIds = plan.columns.flatMap(column => column.rows.map(row => row.paneId));
    assert.equal(new Set(paneIds).size, paneIds.length);
    assert.deepEqual(regions(restored), regions(ws));
    roundtrip(restored);
});

test('closing outer split clears region projections while keeping all tabs reachable', () => {
    const setup = splitShells('horizontal', 2);
    let ws = act(setup.ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    ws = act(ws, { type: 'column-split', enabled: false });
    assert.equal(ws.split.columns, undefined);
    for (const id of [setup.mainId, ...setup.shells, 'second-main']) {
        ws = act(ws, { type: 'activate', tabId: id });
        assert.ok(model.buildRenderPlan(ws).panelIds.includes(id));
    }
    roundtrip(ws);
});


test('splitting the original group keeps each projected pane in only one region', () => {
    let { ws, groupId } = splitShells('horizontal');
    ws = act(ws, { type: 'activate', tabId: ws.tabs[groupId].panes[0].activeTabId });
    const filter = model.addLeaf(ws, 'filter', groupId);
    ws = act(ws, { type: 'split-tab', groupId, tabId: filter.id, paneId: 'filter-region', orientation: 'horizontal' });
    ws = act(ws, { type: 'add-group', options: { id: 'second', mainId: 'second-main' } });
    ws = act(ws, { type: 'split-group', groupId, orientation: 'horizontal' });
    const rows = model.buildRenderPlan(ws).columns.flatMap(column => column.rows);
    assert.equal(rows.filter(row => row.tabs.some(tab => tab.id === filter.id)).length, 1);
    roundtrip(ws);
});

test('an unsplit flat Shell selection uses the normal column DOM and keeps serial tabs reachable', () => {
    let ws = model.createWorkspace();
    const shell = model.addShell(ws);
    ws = act(ws, { type: 'activate', tabId: shell.id });
    const column = model.buildRenderPlan(ws).columns[0];
    assert.equal(column.rootOnly, false);
    assert.ok(column.tabItems.some(tab => tab.kind === 'main'));
});

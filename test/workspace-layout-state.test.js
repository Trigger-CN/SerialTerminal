'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/workspace/tab-model');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { serializeWorkspaceLayout, restoreWorkspaceLayout } = require('../src/workspace/workspace-layout-state');

function baseline(multi = false) {
    return importWorkspace({ groups: [{ id: 'default', panes: [{ id: 'pane-1', tabIds: ['tab-main', 'f1', 'tab-shell-1'], activeTabId: 'f1' }] },
        ...(multi ? [{ id: 'g-1', panes: [{ id: 'pane-1-g-1', tabIds: ['tab-main-g-1'], activeTabId: 'tab-main-g-1' }] }] : [])],
        filterTabs: { default: [{ id: 'f1', title: 'Filter' }] }, shellTabs: [{ id: 'tab-shell-1', columnId: 'default' }], focusedTabId: 'f1' });
}
function act(ws, action) { const result = model.applyWorkspaceAction(ws, action); assert.equal(result.ok, true, result.reason); return result.workspace; }
function visibleLayout(ws) {
    const plan = model.buildRenderPlan(ws);
    return { panelIds: plan.panelIds, columnLayout: plan.columnLayout, columns: plan.columns.map(column => ({
        id: column.id, containerId: column.containerId, tabItems: column.tabItems.map(tab => tab.id),
        rows: column.rows, splitEnabled: column.splitEnabled, orientation: column.orientation, paneSizes: column.paneSizes
    })) };
}

test('versioned layout roundtrip preserves Shell-only panes, local activation, focus and ratios without business state', () => {
    let ws = act(baseline(), { type: 'split-tab', tabId: 'tab-shell-1', groupId: 'default', paneId: 'pane-2', orientation: 'vertical' });
    ws = act(ws, { type: 'resize-panes', groupId: 'default', sizes: { 'pane-1': 0.7, 'pane-2': 0.3 } });
    ws = act(ws, { type: 'activate', tabId: 'f1' });
    const before = JSON.stringify(ws); const saved = serializeWorkspaceLayout(ws);
    assert.equal(saved.version, 1); assert.equal(saved.groups[0].title, undefined);
    const restored = restoreWorkspaceLayout(baseline(), JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(serializeWorkspaceLayout(restored), saved);
    assert.deepEqual(visibleLayout(restored), visibleLayout(ws));
    assert.equal(JSON.stringify(ws), before);
    assert.equal(restored.tabs.f1.title, 'Filter');
});

test('versioned layout preserves shared columns and independent Shell selection', () => {
    let ws = baseline(true);
    ws = act(ws, { type: 'add-group', options: { id: 'g-2', groupId: 'g-2', mainId: 'tab-main-g-2', paneIds: ['pane-1-g-2'] } });
    ws = act(ws, { type: 'split-group', groupId: 'g-1' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'activate', tabId: 'tab-main-g-1' });
    const saved = serializeWorkspaceLayout(ws);
    const restored = restoreWorkspaceLayout(ws, JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(serializeWorkspaceLayout(restored), saved);
    assert.deepEqual(visibleLayout(restored), visibleLayout(ws));
});

test('corrupt layout repairs membership deterministically against business identities and rejects cross-group ownership', () => {
    const base = baseline(true); const before = JSON.stringify(base);
    const saved = { version: 1, groups: [
        { id: 'default', panes: [{ id: 'p', tabIds: ['tab-main-g-1', 'unknown', 'tab-shell-1', 'f1', 'f1'], activeTabId: 'unknown' }, { id: 'p', tabIds: ['f1'] }], paneSplit: { enabled: true, sizes: { p: -1 } } },
        { id: 'g-1', panes: [{ id: 'p', tabIds: [] }] }
    ], roots: [{ tabId: 'tab-shell-1', columnId: 'missing' }], split: { enabled: true, columns: [{ id: 'bad', groupIds: ['g-1', 'g-1', 'missing'] }], sizes: { bad: 'NaN' } }, focusedTabId: 'unknown' };
    const result = restoreWorkspaceLayout(base, saved);
    assert.equal(JSON.stringify(base), before);
    assert.deepEqual(Object.keys(result.tabs).sort(), Object.keys(base.tabs).sort());
    const ids = Object.values(result.tabs).filter(model.isContainer).flatMap(g => g.panes.flatMap(p => p.tabIds));
    assert.equal(ids.length, new Set(ids).size);
    assert.equal(result.tabs['tab-shell-1'].parentId, null);
    assert.equal(result.tabs['tab-main-g-1'].parentId, 'g-1');
    assert.ok(result.tabs[result.focusedTabId]);
    const once = serializeWorkspaceLayout(result);
    assert.deepEqual(serializeWorkspaceLayout(restoreWorkspaceLayout(base, once)), once);
});

test('unknown snapshot version falls back without mutating or sharing baseline', () => {
    const base = baseline(); const result = restoreWorkspaceLayout(base, { version: 99 });
    assert.deepEqual(result, base); assert.notEqual(result, base);
});


test('legacy configuration migration is deterministic and versioned layout wins over stale mirrors', () => {
    const { migrateSerialGroupsConfig } = require('../src/serial/serial-groups-config');
    const { migrateWorkspaceLayoutConfig } = require('../src/workspace/workspace-layout-state');
    const old = migrateSerialGroupsConfig({ configVersion: 15, serialGroups: [{ id: 'default',
        panes: [{ id: 'pane-1', tabIds: ['tab-main', 'f1'], activeTabId: 'f1' }, { id: 'pane-2', tabIds: ['tab-shell-1'], activeTabId: 'tab-shell-1' }],
        paneSplit: { enabled: true, activePaneId: 'pane-2', orientation: 'vertical', sizes: { 'pane-1': 0.6, 'pane-2': 0.4 } },
        filterTabs: [{ id: 'f1' }] }], shellTabs: [{ id: 'tab-shell-1', hostGroupId: 'default', hostPaneId: 'pane-2' }] });
    const migrated = migrateWorkspaceLayoutConfig(old);
    assert.deepEqual(migrateWorkspaceLayoutConfig(migrated), migrated);
    assert.equal(migrated.workspaceLayoutState.groups[0].activePaneId, 'pane-2');
    assert.equal(migrated.workspaceLayoutState.focusedTabId, 'tab-shell-1');
    const stale = JSON.parse(JSON.stringify(migrated));
    stale.serialGroups[0].panes = [{ id: 'pane-1', tabIds: ['tab-main', 'f1'], activeTabId: 'tab-main' }];
    stale.serialGroups[0].paneSplit.enabled = false;
    assert.deepEqual(migrateWorkspaceLayoutConfig(stale).workspaceLayoutState, migrated.workspaceLayoutState);
});


test('single-to-multi removes promoted Shell pane ratios before saving', () => {
    let ws = act(baseline(), { type: 'split-tab', tabId: 'tab-shell-1', groupId: 'default', paneId: 'pane-2' });
    ws = act(ws, { type: 'split-tab', tabId: 'f1', groupId: 'default', paneId: 'pane-3' });
    ws = act(ws, { type: 'resize-panes', groupId: 'default', sizes: { 'pane-1': 0.4, 'pane-2': 0.3, 'pane-3': 0.3 } });
    ws = act(ws, { type: 'add-group', options: { id: 'g-1', groupId: 'g-1', mainId: 'tab-main-g-1', paneIds: ['pane-1-g-1'] } });
    assert.equal(ws.tabs.default.paneSplit.sizes['pane-2'], undefined);
    assert.ok(Math.abs(ws.tabs.default.paneSplit.sizes['pane-1'] - 4 / 7) < 1e-12);
    const saved = serializeWorkspaceLayout(ws);
    assert.deepEqual(serializeWorkspaceLayout(restoreWorkspaceLayout(ws, saved)), saved);
});


test('configuration migration ignores phantom layout identities and preserves group/root ordering', () => {
    const { migrateSerialGroupsConfig } = require('../src/serial/serial-groups-config');
    const { migrateWorkspaceLayoutConfig } = require('../src/workspace/workspace-layout-state');
    const config = migrateSerialGroupsConfig({ serialGroups: [{ id: 'default', panes: [{ id: 'p', tabIds: ['tab-main', 'ghost', 'f1'] }], filterTabs: [{ id: 'f1' }] }, { id: 'g-1' }], shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }] });
    const migrated = migrateWorkspaceLayoutConfig(config);
    assert.equal(migrated.workspaceLayoutState.groups.flatMap(g => g.panes.flatMap(p => p.tabIds)).includes('ghost'), false);
    const base = baseline(true);
    base.tabs['tab-shell-2'] = model.createLeaf('shell', { id: 'tab-shell-2', order: 3 });
    model.rebuildIndex(base);
    const saved = serializeWorkspaceLayout(base);
    saved.groups.reverse(); saved.roots.reverse();
    // 旧快照仅用数组次序；带 order 的新快照应由数值保留跨种类交错位置。
    saved.groups.forEach(group => delete group.order);
    saved.roots.forEach(tab => delete tab.order);
    const restored = restoreWorkspaceLayout(base, saved);
    assert.deepEqual(serializeWorkspaceLayout(restored).groups.map(g => g.id), ['g-1', 'default']);
    assert.deepEqual(serializeWorkspaceLayout(restored).roots.map(t => t.tabId), saved.roots.map(t => t.tabId));
});


test('own-column Shell and malformed nullable snapshot items restore without losing identities', () => {
    let ws = act(baseline(true), { type: 'shell-placement', tabId: 'tab-shell-1', placement: { columnMode: 'ownColumn', columnId: 'default' } });
    ws = act(ws, { type: 'column-split', enabled: true });
    const saved = serializeWorkspaceLayout(ws);
    assert.deepEqual(serializeWorkspaceLayout(restoreWorkspaceLayout(baseline(true), saved)), saved);
    const corrupt = structuredClone(saved);
    corrupt.groups.unshift(null); corrupt.roots.unshift(null); corrupt.split.columns = [null];
    assert.doesNotThrow(() => restoreWorkspaceLayout(baseline(true), corrupt));
});


test('root Shell without an explicit column keeps first-column local activation', () => {
    let ws = baseline(true); ws.tabs['tab-shell-1'].columnId = null;
    ws = act(ws, { type: 'split-group', groupId: 'g-1' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'activate', tabId: 'tab-main-g-1' });
    const saved = serializeWorkspaceLayout(ws);
    assert.deepEqual(serializeWorkspaceLayout(restoreWorkspaceLayout(baseline(true), saved)), saved);
});


test('configuration migration filters malformed and conflicting business IDs before importing layout', () => {
    const { migrateSerialGroupsConfig } = require('../src/serial/serial-groups-config');
    const { migrateWorkspaceLayoutConfig } = require('../src/workspace/workspace-layout-state');
    const source = migrateSerialGroupsConfig({ serialGroups: [
        { id: 'default', filterTabs: [null, {}, { id: 'tab-main' }, { id: 'f1', title: 'keep' }, { id: 'f1' }],
            chartTabs: [{ id: 'f1' }, { id: 'c1' }, { id: 'tab-shell-1' }] },
        { id: 'g-1', filterTabs: [{ id: 'f1' }, { id: 'f2' }], chartTabs: null }
    ], shellTabs: [null, { id: 'tab-shell-1' }, { id: 'tab-shell-1' }, { id: 'default' }, { id: ' ' }] });
    const before = JSON.stringify(source);
    const migrated = migrateWorkspaceLayoutConfig(source);
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(migrated.serialGroups[0].filterTabs, [{ id: 'f1', title: 'keep' }]);
    assert.deepEqual(migrated.serialGroups[0].chartTabs.map(tab => tab.id), ['c1']);
    assert.deepEqual(migrated.serialGroups[1].filterTabs.map(tab => tab.id), ['f2']);
    assert.deepEqual(migrated.serialGroups[1].chartTabs, []);
    assert.deepEqual(migrated.shellTabs.map(tab => tab.id), ['tab-shell-1']);
    assert.deepEqual(migrated.filterTabs, migrated.serialGroups[0].filterTabs);
    assert.deepEqual(migrateWorkspaceLayoutConfig(migrated), migrated);
    assert.deepEqual(migrated.workspaceLayoutState.groups.flatMap(group => group.panes.flatMap(pane => pane.tabIds)).sort(),
        ['tab-main', 'tab-main-g-1', 'f1', 'f2', 'c1'].sort());
});


test('root drag interleaving survives save/restore and snapshots without order remain readable', () => {
    let ws = baseline(true);
    ws = act(ws, { type: 'move', tabId: 'tab-shell-1', target: { kind: 'roots', columnId: 'default', index: 1 } });
    const saved = serializeWorkspaceLayout(ws);
    const restored = restoreWorkspaceLayout(baseline(true), saved);
    assert.deepEqual(model.roots(restored).map(tab => tab.id), ['default', 'tab-shell-1', 'g-1']);
    assert.deepEqual(serializeWorkspaceLayout(restored), saved);
    const old = JSON.parse(JSON.stringify(saved));
    old.groups.forEach(group => delete group.order); old.roots.forEach(tab => delete tab.order);
    const fallback = restoreWorkspaceLayout(baseline(true), old);
    assert.deepEqual(model.roots(fallback).map(tab => tab.id), ['default', 'g-1', 'tab-shell-1']);
    assert.deepEqual(serializeWorkspaceLayout(restoreWorkspaceLayout(baseline(true), serializeWorkspaceLayout(fallback))), serializeWorkspaceLayout(fallback));
});

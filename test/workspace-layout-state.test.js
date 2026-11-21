'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { model, codec, fixture, act, regions, resize, roundtrip } = require('./workspace-tree-fixture');
const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
const { migrateSerialGroupsConfig } = require('../src/serial/serial-groups-config');
const migrate = input => codec.migrateWorkspaceLayoutConfig(migrateSerialGroupsConfig(input));
test('v2 snapshot retains Shell-only regions, local selections and ratios without business data', () => {
    let ws = resize(act(fixture(), { type: 'split-tab', tabId: 'tab-shell-1', direction: 'bottom' }));
    ws = act(ws, { type: 'activate', tabId: 'f1' });
    const before = JSON.stringify(ws), saved = codec.serializeWorkspaceLayout(ws);
    assert.equal(saved.version, 2);
    assert.equal(saved.groups[0].title, undefined);
    assert.equal(JSON.stringify(saved).includes('ownerGroupId'), false);
    assert.deepEqual(roundtrip(ws).layout, ws.layout); assert.equal(JSON.stringify(ws), before);
});
test('shared serial Stacks and independent Shell selection roundtrip exactly', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'split-tab', tabId: 'tab-shell-1' });
    ws = act(ws, { type: 'activate', tabId: 'tab-main-b' }); roundtrip(ws);
});
test('corrupt legacy locations deduplicate, reject foreign owners and backfill actual business leaves', () => {
    const ws = fixture(true), before = JSON.stringify(ws);
    const saved = { version: 1, groups: [{ id: 'default', panes: [{ id: 'p', tabIds: ['tab-main-b', 'ghost', 'f1', 'f1'], activeTabId: 'ghost' }] }],
        roots: [{ tabId: 'tab-shell-1', columnId: 'missing' }], split: { enabled: true, columns: [null, { id: 'bad', groupIds: ['b', 'missing'] }] } };
    const restored = codec.restoreWorkspaceLayout(ws, saved);
    assert.equal(JSON.stringify(ws), before);
    assert.deepEqual(new Set(model.buildRenderPlan(restored).panelIdsAll), new Set(model.buildRenderPlan(ws).panelIdsAll));
    assert.equal(restored.tabs['tab-main-b'].ownerGroupId, 'b'); roundtrip(restored);
});
test('unknown snapshot version rejects without mutating baseline so the config loader can protect disk', () => {
    const ws = fixture(), before = JSON.stringify(ws);
    assert.throws(() => codec.restoreWorkspaceLayout(ws, { version: 99 }), /不支持/);
    assert.equal(JSON.stringify(ws), before);
});
test('legacy configuration migration is deterministic and tree snapshot wins over stale mirrors', () => {
    const old = { configVersion: 15, serialGroups: [{ id: 'default', filterTabs: [{ id: 'f1' }],
        panes: [{ id: 'p1', tabIds: ['tab-main', 'f1'] }, { id: 'p2', tabIds: ['tab-shell-1'], activeTabId: 'tab-shell-1' }],
        paneSplit: { enabled: true, activePaneId: 'p2', orientation: 'vertical', sizes: { p1: 0.6, p2: 0.4 } } }],
        shellTabs: [{ id: 'tab-shell-1', hostGroupId: 'default', hostPaneId: 'p2' }] };
    const migrated = migrate(old);
    assert.deepEqual(codec.migrateWorkspaceLayoutConfig(migrated), migrated);
    assert.equal(migrated.workspaceLayoutState.layout.root.orientation, 'vertical');
    const stale = structuredClone(migrated);
    stale.serialGroups[0].panes = [{ id: 'p1', tabIds: ['tab-main', 'f1'] }]; stale.serialGroups[0].paneSplit.enabled = false;
    assert.deepEqual(codec.migrateWorkspaceLayoutConfig(stale).workspaceLayoutState, migrated.workspaceLayoutState);
});
test('single-to-multi retains existing Shell region ratios through serialization', () => {
    const original = resize(act(fixture(), { type: 'split-tab', tabId: 'tab-shell-1' }));
    const next = act(original, { type: 'add-group', options: { id: 'b', mainId: 'mb' } });
    assert.deepEqual(regions(next)['tab-shell-1'], regions(original)['tab-shell-1']); roundtrip(next);
});
test('phantom layout identities cannot create terminals and group ordering follows metadata', () => {
    const migrated = migrate({ serialGroups: [{ id: 'default', filterTabs: [{ id: 'f1' }], panes: [{ id: 'p', tabIds: ['tab-main', 'ghost', 'f1'] }] }, { id: 'b' }], shellTabs: [{ id: 'tab-shell-1' }] });
    assert.equal(JSON.stringify(migrated.workspaceLayoutState).includes('ghost'), false);
    const ws = fixture(true), saved = codec.serializeWorkspaceLayout(ws);
    saved.groups.forEach((group, index) => { group.order = -index; });
    const restored = codec.restoreWorkspaceLayout(ws, saved);
    assert.deepEqual(model.containerIds(restored), ['c', 'b', 'default']); roundtrip(restored);
});
test('independent Shell region tolerates nullable persisted nodes without losing real identities', () => {
    const ws = act(fixture(true), { type: 'split-tab', tabId: 'tab-shell-1' }), saved = codec.serializeWorkspaceLayout(ws);
    saved.groups.unshift(null); saved.layout.root.children.push(null);
    const restored = codec.restoreWorkspaceLayout(ws, saved);
    assert.deepEqual(new Set(model.buildRenderPlan(restored).panelIdsAll), new Set(model.buildRenderPlan(ws).panelIdsAll)); roundtrip(restored);
});
test('root Shell retains its local selection when another branch has global focus', () => {
    let ws = act(fixture(true), { type: 'split-group', groupId: 'b' });
    ws = act(ws, { type: 'activate', tabId: 'tab-shell-1' }); ws = act(ws, { type: 'activate', tabId: 'tab-main-b' });
    assert.ok(model.buildRenderPlan(roundtrip(ws)).panelIds.includes('tab-shell-1'));
});
test('configuration migration filters malformed or conflicting business IDs before layout import', () => {
    const source = migrateSerialGroupsConfig({ serialGroups: [
        { id: 'default', filterTabs: [null, {}, { id: 'tab-main' }, { id: 'f1', title: 'keep' }, { id: 'f1' }], chartTabs: [{ id: 'f1' }, { id: 'c1' }, { id: 'tab-shell-1' }] },
        { id: 'b', filterTabs: [{ id: 'f1' }, { id: 'f2' }], chartTabs: null }
    ], shellTabs: [null, { id: 'tab-shell-1' }, { id: 'tab-shell-1' }, { id: 'default' }, { id: ' ' }] });
    const before = JSON.stringify(source), migrated = codec.migrateWorkspaceLayoutConfig(source);
    assert.equal(JSON.stringify(source), before);
    assert.deepEqual(migrated.serialGroups[0].filterTabs, [{ id: 'f1', title: 'keep' }]);
    assert.deepEqual(migrated.serialGroups[0].chartTabs.map(tab => tab.id), ['c1']);
    assert.deepEqual(migrated.serialGroups[1].filterTabs.map(tab => tab.id), ['f2']);
    assert.deepEqual(migrated.serialGroups[1].chartTabs, []);
    assert.deepEqual(migrated.shellTabs.map(tab => tab.id), ['tab-shell-1']);
    assert.deepEqual(migrated.filterTabs, migrated.serialGroups[0].filterTabs);
    assert.deepEqual(codec.migrateWorkspaceLayoutConfig(migrated), migrated);
    const ws = importWorkspace({ groups: migrated.serialGroups, filterTabs: Object.fromEntries(migrated.serialGroups.map(group => [group.id, group.filterTabs])), chartTabs: Object.fromEntries(migrated.serialGroups.map(group => [group.id, group.chartTabs])), shellTabs: migrated.shellTabs });
    const restored = codec.restoreWorkspaceLayout(ws, migrated.workspaceLayoutState);
    assert.deepEqual(model.buildRenderPlan(restored).panelIdsAll.sort(), ['tab-main', 'tab-main-b', 'f1', 'f2', 'c1', 'tab-shell-1'].sort());
});
test('root drag interleaving survives save/restore while old v1 orderless snapshots remain readable', () => {
    let ws = fixture(true), rootId = model.locateTab(ws, 'tab-shell-1').stack.id;
    ws = act(ws, { type: 'move', tabId: 'tab-shell-1', target: { nodeId: rootId, index: 1 } });
    assert.deepEqual(roundtrip(ws).layout.root.items.map(item => item.tabId), ['default', 'tab-shell-1', 'b', 'c', 'tab-shell-2']);
    const old = { version: 1, groups: [{ id: 'default' }, { id: 'b' }, { id: 'c' }], roots: [{ tabId: 'tab-shell-2' }, { tabId: 'tab-shell-1' }], split: { enabled: false } };
    const restored = codec.restoreWorkspaceLayout(ws, old);
    assert.deepEqual(model.validateLayout(restored), []); roundtrip(restored);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectWorkspace } = require('../src/workspace/tabs-workspace-projection');
const model = require('../src/workspace/tab-model');
const acceptance = require('./tab-model-acceptance');

function baseSections() {
    return {
        groups: [
            {
                id: 'default',
                title: '串口 1',
                order: 0,
                panes: [{ id: 'default-pane-1', tabIds: [], activeTabId: null }],
                paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
                collapsed: false
            }
        ],
        filterTabs: {},
        chartTabs: {},
        shellTabs: [],
        focusedTabId: null,
        split: { enabled: false, orientation: 'horizontal', sizes: {} }
    };
}

test('projection turns one group into a container with a main leaf', () => {
    const ws = projectWorkspace(baseSections());
    const container = ws.tabs['default'];
    assert.ok(container);
    assert.ok(Array.isArray(container.panes));
    assert.equal(container.panes.length, 1);
    assert.equal(container.panes[0].tabIds.length, 1);
    const main = ws.tabs[container.panes[0].tabIds[0]];
    assert.equal(main.kind, 'main');
    assert.equal(main.parentId, 'default');
});

test('projection appends filter and chart leaves after main, in that order', () => {
    const sections = baseSections();
    sections.filterTabs.default = [{ id: 'f1', title: 'f' }];
    sections.chartTabs.default = [{ id: 'c1', title: 'c' }];

    const ws = projectWorkspace(sections);
    const pane = ws.tabs.default.panes[0];
    const kinds = pane.tabIds.map(id => ws.tabs[id].kind);
    assert.deepEqual(kinds, ['main', 'filter', 'chart']);
});

test('projection never lets a shell land inside a pane', () => {
    const sections = baseSections();
    sections.filterTabs.default = [{ id: 'f1', title: 'f' }];
    sections.shellTabs = [{ id: 's1', title: 's' }, { id: 's2', title: 's' }];

    const ws = projectWorkspace(sections);
    for (const shellId of ['s1', 's2']) {
        assert.equal(ws.tabs[shellId].parentId, null);
        assert.equal(ws.tabs[shellId].order >= 1, true);
    }
    const pane = ws.tabs.default.panes[0];
    assert.equal(pane.tabIds.some(id => ws.tabs[id].kind === 'shell'), false);
});

test('projection keeps a dangling activeTabId from breaking the tree', () => {
    const sections = baseSections();
    sections.groups[0].panes[0].activeTabId = 'does-not-exist';
    const ws = projectWorkspace(sections);
    const pane = ws.tabs.default.panes[0];
    assert.ok(pane.tabIds.includes(pane.activeTabId));
});

test('projection falls back to a valid focus when the given one is unknown', () => {
    const sections = baseSections();
    sections.focusedTabId = 'ghost';
    const ws = projectWorkspace(sections);
    assert.ok(ws.tabs[ws.focusedTabId]);
});

// 扁平 + pane 分屏：store 里的 filter 只能进一个 pane。
// 反向对照：旧实现在每个 pane 都 push 一遍 store 条目，并在空 pane 里补一个
// main，结果是同一个标签同时属于两个 pane、两个 panel 撞成同一个 id。
test('projection never assigns one filter tab to two panes', () => {
    const sections = baseSections();
    sections.groups[0].panes = [
        { id: 'default-pane-1', tabIds: ['tab-main'], activeTabId: 'tab-main' },
        { id: 'default-pane-2', tabIds: [], activeTabId: null }
    ];
    sections.groups[0].paneSplit = { enabled: true, orientation: 'horizontal', sizes: {} };
    sections.filterTabs.default = [{ id: 'f1', title: 'f' }];

    const ws = projectWorkspace(sections);
    const panes = ws.tabs.default.panes;
    const occurrences = panes.reduce(
        (sum, pane) => sum + pane.tabIds.filter(id => id === 'f1').length, 0);
    assert.equal(occurrences, 1, 'f1 必须恰好属于一个 pane');
    assert.equal(panes.some(pane => pane.tabIds.every(id => id === 'tab-main')), true,
        '空 pane 不得被补一个 main');
});


test('projected workspace satisfies every invariant', () => {
    const sections = baseSections();
    sections.groups.push({
        id: 'g2',
        title: '串口 2',
        order: 1,
        panes: [{ id: 'g2-pane-1', tabIds: [], activeTabId: null }],
        paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
        collapsed: false
    });
    sections.filterTabs.g2 = [{ id: 'g2-f1', title: 'f' }];
    sections.shellTabs = [{ id: 's1', title: 's' }];

    const ws = projectWorkspace(sections);
    const diag = model.withDiagnostics(ws);
    assert.deepEqual(acceptance.assertAll(diag), []);
});

test('projection is read-only: inputs are not mutated', () => {
    const sections = baseSections();
    sections.filterTabs.default = [{ id: 'f1', title: 'f' }];
    sections.shellTabs = [{ id: 's1', title: 's' }];

    const before = JSON.stringify(sections);
    projectWorkspace(sections);
    assert.equal(JSON.stringify(sections), before);
});

test('flat single-group projection puts main/filter/shell on one row', () => {
    const sections = baseSections();
    sections.filterTabs.default = [{ id: 'f1', title: 'f' }];
    sections.shellTabs = [{ id: 's1', title: 's' }];

    const ws = projectWorkspace(sections);
    const plan = model.buildRenderPlan(ws);
    assert.equal(plan.columns.length, 1);
    const ids = plan.columns[0].tabItems.map(item => item.id);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes('f1'));
    assert.ok(ids.includes('s1'));
});

test('two groups with column split give one column each', () => {
    const sections = baseSections();
    sections.groups.push({
        id: 'g2',
        title: '串口 2',
        order: 1,
        panes: [{ id: 'g2-pane-1', tabIds: [], activeTabId: null }],
        paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
        collapsed: false
    });
    sections.split.enabled = true;

    const ws = projectWorkspace(sections);
    const plan = model.buildRenderPlan(ws);
    assert.equal(plan.columns.length, 2);
    assert.ok(plan.columns.every(col => col.isFamily === false));
});

// 新键直接透传：hostGroupId / columnMode / columnId 是模型与渲染层共用的三个名字，
// 投影是白名单重建，任何一项漏掉都会在下游静默变成 null。
test('projection forwards the three shell facts by their new names', () => {
    const sections = baseSections();
    sections.split.enabled = true;
    sections.shellTabs = [{
        id: 's1',
        title: 's',
        hostGroupId: 'default',
        columnMode: 'row',
        columnId: 'default'
    }];

    const ws = projectWorkspace(sections);
    const leaf = ws.tabs.s1;
    assert.equal(leaf.hostGroupId, 'default');
    assert.equal(leaf.columnMode, 'row');
    assert.equal(leaf.columnId, 'default');
});

// 老配置只有旧键（ownerGroupId / detachedColumn / topRowColumnId）。
// 升级用户盘上就是这种形状，必须能读成新键，否则它们的 Shell 归属与独立列形态会静默丢失。
// 反向对照：删掉旧键后，同一输入只能得到 null / row，证明回退真的在起作用。
test('projection falls back to legacy shell keys when the new ones are absent', () => {
    const sections = baseSections();
    sections.split.enabled = true;
    sections.shellTabs = [{
        id: 's1',
        title: 's',
        ownerGroupId: 'default',
        detachedColumn: true,
        topRowColumnId: 'default'
    }];

    const ws = projectWorkspace(sections);
    const leaf = ws.tabs.s1;
    assert.equal(leaf.hostGroupId, 'default', '旧 ownerGroupId 必须读成 hostGroupId');
    assert.equal(leaf.columnMode, 'ownColumn', '旧 detachedColumn 必须读成 ownColumn');
    assert.equal(leaf.columnId, 'default', '旧 topRowColumnId 必须读成 columnId');

    // 反向对照：把旧键全部去掉，上面三个值就必须回落。
    const bare = baseSections();
    bare.split.enabled = true;
    bare.shellTabs = [{ id: 's1', title: 's' }];
    const bareLeaf = projectWorkspace(bare).tabs.s1;
    assert.equal(bareLeaf.hostGroupId, null);
    assert.equal(bareLeaf.columnMode, 'row');
    assert.equal(bareLeaf.columnId, null);
});

// 新键优先于旧键：两边同时存在时以新键为准，否则一旦残留旧值就会覆盖用户最新的拖拽结果。
test('new shell keys win over legacy ones when both are present', () => {
    const sections = baseSections();
    sections.split.enabled = true;
    sections.shellTabs = [{
        id: 's1',
        title: 's',
        hostGroupId: null,
        columnMode: 'row',
        columnId: 'col-new',
        ownerGroupId: 'default',
        detachedColumn: true,
        topRowColumnId: 'col-old'
    }];

    const ws = projectWorkspace(sections);
    const leaf = ws.tabs.s1;
    assert.equal(leaf.hostGroupId, null, '新键 null 不能被旧键覆盖');
    assert.equal(leaf.columnMode, 'row');
    assert.equal(leaf.columnId, 'col-new');
});

test('runtime import restores a shell-only pane as ordinary membership without changing input', () => {
    const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
    const sections = baseSections();
    sections.groups[0].panes = [
        { id: 'pane-1', tabIds: ['tab-main'], activeTabId: 'tab-main' },
        { id: 'pane-2', tabIds: [], activeTabId: null }
    ];
    sections.groups[0].paneSplit.enabled = true;
    sections.shellTabs = [{ id: 'tab-shell-1', hostGroupId: 'default', hostPaneId: 'pane-2' }];
    sections.focusedTabId = 'tab-shell-1';
    const before = JSON.stringify(sections);
    const ws = importWorkspace(sections);
    assert.equal(JSON.stringify(sections), before);
    assert.deepEqual(ws.tabs.default.panes[1].tabIds, ['tab-shell-1']);
    assert.equal(ws.tabs.default.panes[1].activeTabId, 'tab-shell-1');
    assert.equal(ws.tabs['tab-shell-1'].parentId, 'default');
    assert.equal(ws.tabs['tab-shell-1'].hostGroupId, null);
    assert.deepEqual(model.buildRenderPlan(ws).panelIds, ['tab-main', 'tab-shell-1']);
    assert.deepEqual(acceptance.assertAll(model.withDiagnostics(ws)), []);
});

test('runtime import keeps multi-group shells at root and restores declared leaf kinds', () => {
    const { importWorkspace } = require('../src/workspace/tabs-workspace-projection');
    const sections = baseSections();
    sections.groups[0].panes[0].tabIds = ['tab-main', 'f1', 'c1'];
    sections.groups.push({ id: 'g2', panes: [{ id: 'g2-pane-1', tabIds: [], activeTabId: null }] });
    sections.filterTabs.default = [{ id: 'f1', title: 'Filter' }];
    sections.chartTabs.default = [{ id: 'c1', title: 'Chart' }];
    sections.shellTabs = [{ id: 'tab-shell-1', hostGroupId: 'default', hostPaneId: 'default-pane-1', columnId: 'g2' }];
    const ws = importWorkspace(sections);
    assert.equal(ws.tabs.f1.kind, 'filter');
    assert.equal(ws.tabs.c1.kind, 'chart');
    assert.equal(ws.tabs['tab-shell-1'].parentId, null);
    assert.equal(ws.tabs['tab-shell-1'].hostGroupId, null);
    assert.equal(ws.tabs['tab-shell-1'].columnId, 'g2');
    assert.deepEqual(acceptance.assertAll(model.withDiagnostics(ws)), []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectWorkspace } = require('../tabs-workspace-projection');
const model = require('../tab-model');
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

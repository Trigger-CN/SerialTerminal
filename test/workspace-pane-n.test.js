'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceManager } = require('../workspace-manager');

// 构造一个可被 workspace-manager 驱动的最小 DOM：
// 每个 pane 元素都要有 dataset.paneId、classList、hidden、style 与 querySelector(All)。
function createPaneElement(paneId) {
    const removed = [];
    const set = {};
    return {
        id: paneId,
        dataset: { paneId },
        hidden: false,
        removed,
        set,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
        style: {
            removeProperty(name) { removed.push(name); },
            setProperty(name, value) { set[name] = value; },
            flexBasis: ''
        },
        querySelector: () => ({ classList: { add() {}, remove() {} }, setAttribute() {} }),
        querySelectorAll: () => []
    };
}

function makeTabStub() {
    return {
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}
    };
}

function installDocument(paneElements) {
    const root = {
        classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
        style: { removeProperty() {}, setProperty() {} }
    };
    const previous = global.document;
    global.document = {
        getElementById: id => {
            if (id === 'workspace-root') return root;
            if (id === 'workspace-splitter') return { hidden: false };
            if (paneElements[id]) return null;
            return makeTabStub();
        },
        querySelector: () => makeTabStub(),
        querySelectorAll: selector => selector === '.workspace-pane' ? Object.values(paneElements) : []
    };
    return () => { global.document = previous; };
}

function createThreePaneFixture() {
    const layout = {
        splitEnabled: true,
        orientation: 'horizontal',
        activePaneId: 'pane-1',
        paneSizes: { 'pane-1': 0.5, 'pane-2': 0.25, 'pane-3': 0.25 },
        panes: [
            { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
            { id: 'pane-2', activeTabId: 'tab-a', tabIds: ['tab-a'] },
            { id: 'pane-3', activeTabId: 'tab-b', tabIds: ['tab-b'] }
        ]
    };
    const paneElements = {
        'pane-1': createPaneElement('pane-1'),
        'pane-2': createPaneElement('pane-2'),
        'pane-3': createPaneElement('pane-3')
    };
    const moved = [];
    const manager = createWorkspaceManager({
        getLayout: () => layout,
        setLayout() {},
        cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
        persistLayout() {},
        getPaneDom: paneId => paneElements[paneId],
        getPaneTabsList: () => ({ appendChild() {} }),
        getPaneTabsContent: () => ({ appendChild() {} }),
        onTabMoved: event => moved.push(event)
    });
    return { layout, paneElements, moved, manager };
}

test('applying a three-pane layout writes inline flex-basis instead of fixed CSS variables', () => {
    const { paneElements, manager } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    try {
        manager.applyLayoutToDom();
    } finally {
        restore();
    }

    assert.equal(paneElements['pane-1'].style.flexBasis, '50%');
    assert.equal(paneElements['pane-2'].style.flexBasis, '25%');
    assert.equal(paneElements['pane-3'].style.flexBasis, '25%');
});

test('every pane after the first follows the split visibility flag', () => {
    const { layout, paneElements, manager } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    try {
        manager.applyLayoutToDom();
        assert.equal(paneElements['pane-1'].hidden, false);
        assert.equal(paneElements['pane-2'].hidden, false);
        assert.equal(paneElements['pane-3'].hidden, false);

        layout.splitEnabled = false;
        manager.applyLayoutToDom();
        assert.equal(paneElements['pane-1'].hidden, false);
        assert.equal(paneElements['pane-2'].hidden, true);
        assert.equal(paneElements['pane-3'].hidden, true);
    } finally {
        restore();
    }
});

test('a third pane id is accepted instead of falling back to the primary pane', () => {
    const { manager } = createThreePaneFixture();
    assert.equal(manager.resolvePaneId('pane-3'), 'pane-3');
    assert.equal(manager.resolvePaneId('pane-unknown', 'tab-b'), 'pane-3');
});

test('other-pane lookup cycles through the pane list', () => {
    const { manager } = createThreePaneFixture();
    assert.equal(manager.getOtherPaneId('pane-1'), 'pane-2');
    assert.equal(manager.getOtherPaneId('pane-2'), 'pane-3');
    assert.equal(manager.getOtherPaneId('pane-3'), 'pane-1');
});

test('collapsing a three-pane split merges every pane into the first one', () => {
    const { layout, paneElements, moved, manager } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    try {
        manager.collapseSplit();
    } finally {
        restore();
    }

    assert.deepEqual(layout.panes[0].tabIds, ['tab-main', 'tab-a', 'tab-b']);
    assert.deepEqual(layout.panes[1].tabIds, []);
    assert.deepEqual(layout.panes[2].tabIds, []);
    assert.equal(layout.panes[1].activeTabId, null);
    assert.equal(layout.panes[2].activeTabId, null);
    assert.equal(layout.splitEnabled, false);
    assert.equal(layout.activePaneId, 'pane-1');
    assert.deepEqual(moved.map(event => event.tabId).sort(), ['tab-a', 'tab-b']);
});

test('dragging the splitter distributes the remainder across the extra panes', () => {
    const { layout, paneElements, manager } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    try {
        manager.setPaneSizes(0.5, { persist: false });
    } finally {
        restore();
    }

    const sizes = layout.paneSizes;
    assert.equal(sizes['pane-1'], 0.5);
    assert.ok(Math.abs(sizes['pane-2'] - 0.25) < 1e-9);
    assert.ok(Math.abs(sizes['pane-3'] - 0.25) < 1e-9);
    assert.ok(Math.abs(sizes['pane-1'] + sizes['pane-2'] + sizes['pane-3'] - 1) < 1e-9);
});

test('ensurePaneElements only asks for panes that have no DOM element yet', () => {
    const { paneElements, manager } = createThreePaneFixture();
    const requested = [];
    const restore = installDocument(paneElements);
    try {
        const second = createWorkspaceManager({
            getLayout: () => ({
                splitEnabled: true,
                activePaneId: 'pane-1',
                paneSizes: { 'pane-1': 0.5, 'pane-2': 0.25, 'pane-3': 0.25 },
                panes: [
                    { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
                    { id: 'pane-2', activeTabId: 'tab-a', tabIds: ['tab-a'] },
                    { id: 'pane-3', activeTabId: 'tab-b', tabIds: ['tab-b'] }
                ]
            }),
            setLayout() {},
            cloneLayout: value => JSON.parse(JSON.stringify(value)),
            persistLayout() {},
            getPaneDom: paneId => (paneId === 'pane-3' ? null : paneElements[paneId]),
            getPaneTabsList: () => ({ appendChild() {} }),
            getPaneTabsContent: () => ({ appendChild() {} }),
            ensurePaneElement: paneId => { requested.push(paneId); return {}; }
        });
        assert.deepEqual(second.ensurePaneElements(), ['pane-3']);
    } finally {
        restore();
    }
    assert.deepEqual(requested, ['pane-3']);
});

test('ensurePaneElements is a no-op when no creator is wired', () => {
    const { manager } = createThreePaneFixture();
    assert.deepEqual(manager.ensurePaneElements(), []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceManager } = require('../src/workspace/workspace-manager');

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

// ── 旧断言失效说明（S5-④ 渲染翻转） ──────────────────────
//
// 下面两条原先断言「applyLayoutToDom() 把 pane 的 flex-basis / hidden 写到 DOM 上」。
// 这两件事在 S5-④ 之后**不再由布局层做**：它们改由 renderWorkspace() 依据
// buildRenderPlan() 的 column.paneSizes / column.splitEnabled 统一收敛（单一真源）。
// 旧的期望值因此不再描述正确行为，把它们保留下来只会迫使实现维持第二套 DOM 写点。
// 新断言改在正确层级：布局层只负责把「缺的 pane 节点建出来」与「报告布局变了」，
// 而 pane 的几何派生由 tab-model 的 buildRenderPlan 覆盖（test/tab-model.test.js）。
test('applying a layout no longer writes pane geometry itself', () => {
    const { paneElements } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    let changed = 0;
    try {
        const observed = createWorkspaceManager({
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
            getPaneDom: paneId => paneElements[paneId],
            onLayoutChanged: () => { changed += 1; }
        });
        observed.applyLayoutToDom();
    } finally {
        restore();
    }

    assert.equal(changed, 1, '布局落地必须只发一次渲染请求');
    assert.equal(paneElements['pane-1'].style.flexBasis, '', '布局层不得再写 flex-basis');
    assert.equal(paneElements['pane-2'].style.flexBasis, '', '布局层不得再写 flex-basis');
});

test('applying a layout no longer toggles pane visibility itself', () => {
    const { paneElements, manager } = createThreePaneFixture();
    const restore = installDocument(paneElements);
    try {
        // 先手动改成错误值，确认 applyLayoutToDom 不会把它「纠正」——纠正归渲染层。
        paneElements['pane-2'].hidden = true;
        paneElements['pane-3'].hidden = true;
        manager.applyLayoutToDom();
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createWorkspaceManager,
  normalizeWorkspaceLayoutShape,
  reconcileEmptyPaneLayout,
  moveWorkspaceTab
} = require('../workspace-manager');

test('deduplicates tab ownership while preserving the main tab position', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-filter-1', tabIds: ['tab-filter-1', 'tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1', 'tab-shell-1', 'tab-shell-1'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-filter-1', 'tab-main']);
  assert.deepEqual(layout.panes[1].tabIds, ['tab-shell-1']);
  assert.equal(layout.panes[0].activeTabId, 'tab-filter-1');
  assert.equal(layout.panes[1].activeTabId, 'tab-shell-1');
});

test('normalizes a lone second pane back into the primary pane', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: 'missing', tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main']);
  assert.deepEqual(layout.panes[1].tabIds, []);
  assert.equal(layout.panes[0].activeTabId, 'tab-main');
  assert.equal(layout.panes[1].activeTabId, null);
  assert.equal(layout.activePaneId, 'pane-1');
  assert.equal(layout.splitEnabled, false);
});

test('empty pane reconciliation preserves tab order and the active tab', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: null, tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-1', 'tab-filter-2', 'tab-main'] }
    ]
  };

  assert.deepEqual(reconcileEmptyPaneLayout(layout), {
    collapsed: true,
    movedTabIds: ['tab-filter-1', 'tab-filter-2', 'tab-main']
  });
  assert.deepEqual(layout.panes[0], {
    id: 'pane-1',
    activeTabId: 'tab-filter-2',
    tabIds: ['tab-filter-1', 'tab-filter-2', 'tab-main']
  });
  assert.deepEqual(layout.panes[1], { id: 'pane-2', activeTabId: null, tabIds: [] });
  assert.equal(layout.activePaneId, 'pane-1');
  assert.equal(layout.splitEnabled, false);
});

test('moving the last primary-pane tab collapses the split without changing its target index', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-1', 'tab-filter-2'] }
    ]
  };

  moveWorkspaceTab(layout, 'tab-main', 'pane-2', 1);
  reconcileEmptyPaneLayout(layout);

  assert.deepEqual(layout.panes[0].tabIds, ['tab-filter-1', 'tab-main', 'tab-filter-2']);
  assert.equal(layout.panes[0].activeTabId, 'tab-filter-2');
  assert.equal(layout.splitEnabled, false);
});

test('prunes tabs that are rendered in a different pane', () => {
  const layout = {
    splitEnabled: true,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
      { id: 'pane-2', activeTabId: 'tab-filter-1', tabIds: ['tab-filter-1'] }
    ]
  };
  const renderedByPane = {
    'pane-1': new Set(['tab-main', 'tab-filter-1']),
    'pane-2': new Set()
  };
  const paneElements = Object.fromEntries(Object.entries(renderedByPane).map(([paneId, tabIds]) => [paneId, {
    hidden: false,
    classList: { toggle() {} },
    querySelector: selector => {
      const tabId = selector.match(/(?:data-target="|#)([^"\]]+)/)?.[1];
      return tabIds.has(tabId) ? { classList: { add() {}, remove() {} } } : null;
    },
    querySelectorAll: () => []
  }]));
  const root = {
    classList: { toggle() {} },
    style: { removeProperty() {}, setProperty() {} }
  };
  const previousDocument = global.document;
  global.document = {
    getElementById: id => id === 'workspace-root' ? root : null,
    querySelector: () => null,
    querySelectorAll: () => []
  };

  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: paneId => paneElements[paneId],
      getPaneTabsList() {},
      getPaneTabsContent() {}
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main']);
  assert.deepEqual(layout.panes[1].tabIds, []);
  assert.equal(layout.panes[1].activeTabId, null);
  assert.equal(layout.splitEnabled, false);
  assert.equal(layout.activePaneId, 'pane-1');
});

test('applying a normalized layout synchronizes persisted pane ownership', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: null, tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main'] }
    ]
  });
  const tabButton = { dataset: { paneId: 'pane-2' }, classList: { add() {}, remove() {} }, setAttribute() {} };
  const tabPane = { dataset: { paneId: 'pane-2' }, classList: { add() {}, remove() {} } };
  const paneElements = {
    'pane-1': {
      hidden: false,
      dataset: { paneId: 'pane-1' },
      classList: { toggle() {} },
      querySelector: selector => selector.includes('.main-tab-pane') ? tabPane : tabButton,
      querySelectorAll: () => []
    },
    'pane-2': {
      hidden: false,
      dataset: { paneId: 'pane-2' },
      classList: { toggle() {} },
      querySelector: () => null,
      querySelectorAll: () => []
    }
  };
  const root = { classList: { toggle() {} }, style: { removeProperty() {}, setProperty() {} } };
  const moved = [];
  const previousDocument = global.document;
  global.document = {
    getElementById: id => ({
      'workspace-root': root,
      'workspace-splitter': { hidden: false },
      'tab-main': tabPane
    })[id] || null,
    querySelector: selector => selector.includes('tab-main') ? tabButton : null,
    querySelectorAll: selector => selector === '.workspace-pane'
      ? Object.values(paneElements)
      : (selector === '.main-tab' ? [tabButton] : [tabPane])
  };

  try {
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
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.deepEqual(moved, [{ tabId: 'tab-main', sourcePaneId: 'pane-2', targetPaneId: 'pane-1' }]);
  assert.equal(tabButton.dataset.paneId, 'pane-1');
  assert.equal(tabPane.dataset.paneId, 'pane-1');
});

test('closing the last second-pane tab preserves the primary active tab', () => {
  const layout = {
    splitEnabled: true,
    orientation: 'horizontal',
    activePaneId: 'pane-2',
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
      { id: 'pane-1', activeTabId: 'tab-filter-1', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-shell-1', tabIds: ['tab-shell-1'] }
    ]
  };
  const tabIds = new Set(['tab-main', 'tab-filter-1']);
  const paneElements = Object.fromEntries(['pane-1', 'pane-2'].map(paneId => [paneId, {
    hidden: false,
    dataset: { paneId },
    classList: { toggle() {} },
    querySelector: selector => {
      const tabId = selector.match(/(?:data-target="|#)([^"\]]+)/)?.[1];
      return tabIds.has(tabId) ? { classList: { add() {}, remove() {} }, setAttribute() {} } : null;
    },
    querySelectorAll: () => []
  }]));
  const root = { classList: { toggle() {} }, style: { removeProperty() {}, setProperty() {} } };
  const previousDocument = global.document;
  global.document = {
    getElementById: id => id === 'workspace-root' ? root : null,
    querySelector: () => null,
    querySelectorAll: () => []
  };

  let result;
  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: paneId => paneElements[paneId],
      getPaneTabsList() {},
      getPaneTabsContent() {}
    });
    result = manager.removeTab('tab-shell-1', { persist: false });
  } finally {
    global.document = previousDocument;
  }

  assert.equal(result.nextActiveTabId, 'tab-filter-1');
  assert.equal(layout.activePaneId, 'pane-1');
  assert.equal(layout.splitEnabled, false);
});

test('normalizes a missing main tab back into pane 1', () => {
  const layout = normalizeWorkspaceLayoutShape({
    panes: [
      { id: 'pane-1', activeTabId: 'tab-filter-1', tabIds: ['tab-filter-1'] },
      { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
  });
  assert.deepEqual(layout.panes[0].tabIds, ['tab-main', 'tab-filter-1']);
});

test('moves tabs to indexed positions within and across panes', () => {
  const layout = {
    panes: [
      { id: 'pane-1', tabIds: ['tab-main', 'tab-filter-1', 'tab-filter-2'] },
      { id: 'pane-2', tabIds: ['tab-shell-1'] }
    ]
  };
  moveWorkspaceTab(layout, 'tab-filter-2', 'pane-1', 0);
  assert.deepEqual(layout.panes[0].tabIds, ['tab-filter-2', 'tab-main', 'tab-filter-1']);

  moveWorkspaceTab(layout, 'tab-main', 'pane-2', 0);
  assert.deepEqual(layout.panes[0].tabIds, ['tab-filter-2', 'tab-filter-1']);
  assert.deepEqual(layout.panes[1].tabIds, ['tab-main', 'tab-shell-1']);
});

test('switching the active tab is a no-op and does not reapply pane classes', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-2'] }
    ]
  };
  let domQueries = 0;
  let persisted = 0;
  let activated = 0;
  const previousDocument = global.document;
  global.document = {
    querySelectorAll() { domQueries++; return []; }
  };

  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout: () => persisted++,
      getPaneDom: () => { domQueries++; return null; },
      onTabActivated: () => activated++
    });
    assert.equal(manager.switchPaneTab('pane-1', 'tab-main'), false);
  } finally {
    global.document = previousDocument;
  }

  assert.equal(domQueries, 0);
  assert.equal(persisted, 0);
  assert.equal(activated, 0);
  assert.equal(layout.panes[1].activeTabId, 'tab-filter-2');
});

test('switching tabs updates only the target pane', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-2'] }
    ]
  };
  const queries = { 'pane-1': [], 'pane-2': [] };
  const node = () => ({ classList: { add() {}, remove() {} }, setAttribute() {} });
  const paneElements = Object.fromEntries(['pane-1', 'pane-2'].map(paneId => [paneId, {
    querySelector(selector) { queries[paneId].push(selector); return node(); },
    querySelectorAll(selector) { queries[paneId].push(selector); return []; }
  }]));
  const previousDocument = global.document;
  global.document = {
    querySelectorAll: selector => selector === '.workspace-pane'
      ? [{ dataset: { paneId: 'pane-1' }, classList: { toggle() {} } }, { dataset: { paneId: 'pane-2' }, classList: { toggle() {} } }]
      : []
  };

  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: paneId => paneElements[paneId]
    });
    assert.equal(manager.switchPaneTab('pane-1', 'tab-filter-1'), true);
  } finally {
    global.document = previousDocument;
  }

  assert.equal(layout.panes[0].activeTabId, 'tab-filter-1');
  assert.ok(queries['pane-1'].length > 0);
  assert.deepEqual(queries['pane-2'], []);
});

// 行内顺序只能有一个真源：布局的 tabIds。DOM 顺序必须跟随它。
//
// 这是实机探测（probe-tab-order, diag530）发现的真实缺陷的回归：同栏拖动把
// tabIds 改成 [chart,main,filter]，而按钮顺序仍是 [main,filter,chart]，
// 于是用户拖完看到标签弹回原位。
test('applying a layout orders pane tab buttons by tabIds', () => {
  const layout = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 1 },
    panes: [{ id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-filter-1', 'tab-main'] }]
  };

  // 最小 DOM 面：只实现 syncTabOrderInPane 真正用到的那几项。
  const makeNode = id => ({
    id,
    dataset: { target: id },
    parentElement: null,
    nextElementSibling: null,
    classList: { add() {}, remove() {} },
    setAttribute() {}
  });

  const list = {
    children: [],
    appendChild(child) {
      child.parentElement = list;
      list.children = list.children.filter(item => item !== child);
      list.children.push(child);
      list.relink();
      return child;
    },
    insertBefore(child, reference) {
      child.parentElement = list;
      list.children = list.children.filter(item => item !== child);
      const at = list.children.indexOf(reference);
      list.children.splice(at < 0 ? list.children.length : at, 0, child);
      list.relink();
      return child;
    },
    relink() {
      list.children.forEach((item, index) => {
        item.nextElementSibling = list.children[index + 1] || null;
      });
    }
  };

  const buttons = { 'tab-main': makeNode('tab-main'), 'tab-filter-1': makeNode('tab-filter-1') };
  // 初始 DOM 顺序与拖动前一致：main 在前。
  list.appendChild(buttons['tab-main']);
  list.appendChild(buttons['tab-filter-1']);
  assert.deepEqual(list.children.map(node => node.id), ['tab-main', 'tab-filter-1']);

  const paneElement = {
    hidden: false,
    dataset: { paneId: 'pane-1' },
    classList: { toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const root = { classList: { toggle() {} }, style: { removeProperty() {}, setProperty() {} } };
  const previousDocument = global.document;
  global.document = {
    getElementById: id => ({
      'workspace-root': root,
      'workspace-splitter': { hidden: false }
    })[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };

  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: paneId => (paneId === 'pane-1' ? paneElement : null),
      getPaneTabsList: paneId => (paneId === 'pane-1' ? list : null),
      getPaneTabsContent: () => null,
      findTabButton: tabId => buttons[tabId] || null
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.deepEqual(
    list.children.map(node => node.id),
    ['tab-filter-1', 'tab-main'],
    'DOM 顺序必须按 tabIds 重排，而不是保留拖动前的顺序'
  );
});

// 反向对照：同一套断言在「布局顺序与 DOM 一致时」必须仍然成立。
// 没有这一条，上面那条无法证明自己区分了「真的排序」与「恰好反向」。
test('pane tab order is a no-op when the DOM already matches tabIds', () => {
  const layout = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 1 },
    panes: [{ id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] }]
  };

  const makeNode = id => ({
    id,
    dataset: { target: id },
    parentElement: null,
    nextElementSibling: null,
    classList: { add() {}, remove() {} },
    setAttribute() {}
  });

  // 先建立计数器，appendChild/insertBefore 会同步调用它（声明在前，避开 TDZ）。
  let mutations = 0;
  const mutation = () => { mutations += 1; };
  const list = {
    children: [],
    appendChild(child) {
      mutation();
      child.parentElement = list;
      list.children = list.children.filter(item => item !== child);
      list.children.push(child);
      list.relink();
      return child;
    },
    insertBefore(child, reference) {
      mutation();
      child.parentElement = list;
      list.children = list.children.filter(item => item !== child);
      const at = list.children.indexOf(reference);
      list.children.splice(at < 0 ? list.children.length : at, 0, child);
      list.relink();
      return child;
    },
    relink() {
      list.children.forEach((item, index) => {
        item.nextElementSibling = list.children[index + 1] || null;
      });
    }
  };

  const buttons = { 'tab-main': makeNode('tab-main'), 'tab-filter-1': makeNode('tab-filter-1') };
  // DOM 初始顺序已经与 tabIds 一致。建节点阶段不计入 mutations。
  list.appendChild(buttons['tab-main']);
  list.appendChild(buttons['tab-filter-1']);
  // 建好之后开始计数：只统计排序路径的额外变动（C2：无谓搬移要为零）。
  mutations = 0;

  const paneElement = {
    hidden: false,
    dataset: { paneId: 'pane-1' },
    classList: { toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  const root = { classList: { toggle() {} }, style: { removeProperty() {}, setProperty() {} } };
  const previousDocument = global.document;
  global.document = {
    getElementById: id => ({
      'workspace-root': root,
      'workspace-splitter': { hidden: false }
    })[id] || null,
    querySelector: () => null,
    querySelectorAll: () => []
  };

  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: paneId => (paneId === 'pane-1' ? paneElement : null),
      getPaneTabsList: paneId => (paneId === 'pane-1' ? list : null),
      getPaneTabsContent: () => null,
      findTabButton: tabId => buttons[tabId] || null
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.deepEqual(list.children.map(node => node.id), ['tab-main', 'tab-filter-1']);
  assert.equal(mutations, 0, '顺序已经一致时不得再搬动节点');
});

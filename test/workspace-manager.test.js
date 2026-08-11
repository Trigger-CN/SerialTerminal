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
      return tabIds.has(tabId) ? { classList: { add() {} } } : null;
    }
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
      querySelector: selector => selector.includes('.main-tab-pane') ? tabPane : tabButton
    },
    'pane-2': {
      hidden: false,
      dataset: { paneId: 'pane-2' },
      classList: { toggle() {} },
      querySelector: () => null
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
      return tabIds.has(tabId) ? { classList: { add() {} }, setAttribute() {} } : null;
    }
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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceManager, normalizeWorkspaceLayoutShape } = require('../workspace-manager');

test('deduplicates tab ownership and keeps the main tab in pane 1', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-filter-1', tabIds: ['tab-filter-1', 'tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1', 'tab-shell-1', 'tab-shell-1'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main', 'tab-filter-1']);
  assert.deepEqual(layout.panes[1].tabIds, ['tab-shell-1']);
  assert.equal(layout.panes[0].activeTabId, 'tab-filter-1');
  assert.equal(layout.panes[1].activeTabId, 'tab-shell-1');
});

test('collapses an empty second pane and restores a valid active pane', () => {
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
  assert.equal(layout.activePaneId, 'pane-1');
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
});

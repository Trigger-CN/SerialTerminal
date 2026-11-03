'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAIN_TAB_ID,
  paneTabsListId,
  paneTabsContentId,
  paneTabButtonId,
  describePane,
  describeWorkspace,
  findMissingPaneIds
} = require('../pane-layout-dom');

test('pane element ids follow the naming the existing selectors depend on', () => {
  const pane = describePane('pane-1');
  assert.equal(pane.elementId, 'pane-1');
  assert.equal(pane.tabsListId, 'pane-1-tabs-list');
  assert.equal(pane.tabsContentId, 'pane-1-tabs-content');
  assert.equal(paneTabsListId('pane-7'), 'pane-7-tabs-list');
  assert.equal(paneTabsContentId('pane-7'), 'pane-7-tabs-content');
});

test('the three per-pane tab buttons keep their original ids and order', () => {
  const pane = describePane('pane-2');
  assert.deepEqual(pane.buttons.map(button => button.id), [
    'pane-2-new-shell-tab-btn',
    'pane-2-new-filter-tab-btn',
    'pane-2-new-chart-tab-btn'
  ]);
  assert.deepEqual(pane.buttons.map(button => button.kind), ['shell', 'filter', 'chart']);
  assert.equal(paneTabButtonId('pane-3', 'filter'), 'pane-3-new-filter-tab-btn');
});

test('only the pane that hosts the main tab carries the serial container', () => {
  const host = describePane('pane-1', { hostsMainTab: true });
  assert.equal(host.tabs.length, 1);
  assert.equal(host.tabs[0].id, MAIN_TAB_ID);
  assert.equal(host.tabs[0].terminalContainerId, 'serial-container');
  assert.equal(host.tabs[0].buttonId, 'tab-main-button');

  const empty = describePane('pane-2');
  assert.deepEqual(empty.tabs, []);
});

test('describeWorkspace gives the main tab to the first pane only', () => {
  const panes = describeWorkspace(['pane-1', 'pane-2', 'pane-3']);
  assert.equal(panes.length, 3);
  assert.equal(panes[0].tabs.length, 1);
  assert.equal(panes[1].tabs.length, 0);
  assert.equal(panes[2].tabs.length, 0);
  assert.deepEqual(panes.map(pane => pane.paneId), ['pane-1', 'pane-2', 'pane-3']);
});

test('the first pane is visible and the rest start hidden', () => {
  const panes = describeWorkspace(['pane-1', 'pane-2']);
  assert.equal(panes[0].hidden, false);
  assert.equal(panes[1].hidden, true);
});

test('describeWorkspace tolerates empty and malformed input', () => {
  assert.deepEqual(describeWorkspace(null), []);
  assert.deepEqual(describeWorkspace([]), []);
  assert.deepEqual(describeWorkspace(['', null, 'pane-1']).map(pane => pane.paneId), ['pane-1']);
});

test('every described pane uses the same class name the CSS and JS expect', () => {
  describeWorkspace(['pane-1', 'pane-2', 'pane-3']).forEach(pane => {
    assert.equal(pane.className, 'workspace-pane');
  });
});

test('findMissingPaneIds reports only panes with no DOM element yet', () => {
  const existing = new Set(['pane-1', 'pane-2']);
  assert.deepEqual(
    findMissingPaneIds(['pane-1', 'pane-2', 'pane-3'], paneId => existing.has(paneId)),
    ['pane-3']
  );
  assert.deepEqual(
    findMissingPaneIds(['pane-1', 'pane-2'], paneId => existing.has(paneId)),
    []
  );
});

test('findMissingPaneIds treats every pane as missing without a probe', () => {
  assert.deepEqual(findMissingPaneIds(['pane-1', 'pane-2']), ['pane-1', 'pane-2']);
  assert.deepEqual(findMissingPaneIds(null), []);
});

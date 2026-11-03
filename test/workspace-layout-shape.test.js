'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultLayout,
  normalizePaneSizes,
  normalizeLayoutShape,
  reconcileEmptyPanes
} = require('../workspace-layout-shape');

// 旧实现（改造前 workspace-manager.js 的 normalizeWorkspaceLayoutShape）。
// 保留一份只处理两 pane 的参考实现，用来证明新实现没有改变既有行为。
function legacyNormalize(layout) {
  const normalized = JSON.parse(JSON.stringify(createDefaultLayout()));
  const source = layout && typeof layout === 'object' ? layout : {};
  normalized.splitEnabled = source.splitEnabled === true;
  normalized.orientation = source.orientation === 'vertical' ? 'vertical' : 'horizontal';
  normalized.activePaneId = source.activePaneId === 'pane-2' ? 'pane-2' : 'pane-1';
  const sourceSizes = source.paneSizes && typeof source.paneSizes === 'object' ? source.paneSizes : {};
  const pane1Size = Number(sourceSizes['pane-1']);
  const pane2Size = Number(sourceSizes['pane-2']);
  if (Number.isFinite(pane1Size) && pane1Size > 0 && pane1Size < 1) normalized.paneSizes['pane-1'] = pane1Size;
  if (Number.isFinite(pane2Size) && pane2Size > 0 && pane2Size < 1) normalized.paneSizes['pane-2'] = pane2Size;
  const totalSize = normalized.paneSizes['pane-1'] + normalized.paneSizes['pane-2'];
  normalized.paneSizes['pane-1'] /= totalSize;
  normalized.paneSizes['pane-2'] /= totalSize;

  const sourcePanes = Array.isArray(source.panes) ? source.panes : [];
  const usedTabIds = new Set();
  normalized.panes.forEach(target => {
    const pane = sourcePanes.find(item => item?.id === target.id);
    const sourceTabIds = Array.isArray(pane?.tabIds) ? pane.tabIds : target.tabIds;
    target.tabIds = sourceTabIds.filter(tabId => {
      if (typeof tabId !== 'string' || !tabId || usedTabIds.has(tabId)) return false;
      usedTabIds.add(tabId);
      return true;
    });
    const activeTabId = typeof pane?.activeTabId === 'string' ? pane.activeTabId : target.activeTabId;
    target.activeTabId = target.tabIds.includes(activeTabId) ? activeTabId : (target.tabIds[0] || null);
  });
  if (!usedTabIds.has('tab-main')) {
    normalized.panes[0].tabIds.unshift('tab-main');
    normalized.panes[0].activeTabId ||= 'tab-main';
  }
  if (!normalized.panes.find(pane => pane.id === normalized.activePaneId)?.tabIds.length) {
    normalized.activePaneId = normalized.panes.find(pane => pane.tabIds.length)?.id || 'pane-1';
  }
  // 与原实现同义的收敛逻辑
  const pane1 = normalized.panes.find(p => p.id === 'pane-1');
  const pane2 = normalized.panes.find(p => p.id === 'pane-2');
  if (pane1 && pane2 && !(pane1.tabIds.length && pane2.tabIds.length)) {
    const movedTabIds = pane1.tabIds.length === 0 ? [...pane2.tabIds] : [];
    if (movedTabIds.length) {
      pane1.tabIds = movedTabIds;
      pane1.activeTabId = pane2.activeTabId && movedTabIds.includes(pane2.activeTabId)
        ? pane2.activeTabId
        : movedTabIds[0];
      pane2.tabIds = [];
    }
    pane2.activeTabId = null;
    normalized.splitEnabled = false;
    normalized.activePaneId = 'pane-1';
  }
  return normalized;
}

const CASES = [
  ['undefined', undefined],
  ['empty object', {}],
  ['default layout', createDefaultLayout()],
  ['split with two filled panes', {
    splitEnabled: true,
    orientation: 'vertical',
    activePaneId: 'pane-2',
    paneSizes: { 'pane-1': 0.3, 'pane-2': 0.7 },
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-2'] }
    ]
  }],
  ['split but pane-2 empty', {
    splitEnabled: true,
    activePaneId: 'pane-2',
    paneSizes: { 'pane-1': 0.4, 'pane-2': 0.6 },
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
      { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
  }],
  ['pane-1 empty, pane-2 filled', {
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: null, tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-x', tabIds: ['tab-x'] }
    ]
  }],
  ['invalid pane sizes', {
    paneSizes: { 'pane-1': 'abc', 'pane-2': -1 },
    panes: [{ id: 'pane-1', tabIds: ['tab-main'] }, { id: 'pane-2', tabIds: ['tab-a'] }]
  }],
  ['unknown activePaneId', {
    activePaneId: 'pane-9',
    panes: [{ id: 'pane-1', tabIds: ['tab-main'] }, { id: 'pane-2', tabIds: ['tab-a'] }]
  }],
  ['duplicate tab ids across panes', {
    splitEnabled: true,
    panes: [
      { id: 'pane-1', tabIds: ['tab-main', 'tab-dup'] },
      { id: 'pane-2', tabIds: ['tab-dup', 'tab-b'] }
    ]
  }],
  ['missing tab-main', {
    splitEnabled: true,
    panes: [
      { id: 'pane-1', tabIds: ['tab-a'] },
      { id: 'pane-2', tabIds: ['tab-b'] }
    ]
  }]
];

for (const [name, input] of CASES) {
  test(`N=2 output matches the legacy implementation: ${name}`, () => {
    assert.deepEqual(normalizeLayoutShape(input), legacyNormalize(input));
  });
}

test('pane sizes always sum to one', () => {
  const layout = normalizeLayoutShape({
    paneSizes: { 'pane-1': 3, 'pane-2': 7 },
    panes: [{ id: 'pane-1', tabIds: ['tab-main'] }, { id: 'pane-2', tabIds: ['tab-b'] }]
  });

  const total = Object.values(layout.paneSizes).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(layout.paneSizes['pane-1'] - 0.3) < 1e-9);
});

test('supports more than two panes', () => {
  const layout = normalizeLayoutShape({
    splitEnabled: true,
    paneIds: ['pane-1', 'pane-2', 'pane-3'],
    panes: [
      { id: 'pane-1', tabIds: ['tab-main'] },
      { id: 'pane-2', tabIds: ['tab-a'] },
      { id: 'pane-3', tabIds: ['tab-b'] }
    ]
  });

  assert.equal(layout.panes.length, 3);
  assert.deepEqual(layout.panes.map(p => p.id), ['pane-1', 'pane-2', 'pane-3']);
  const total = Object.values(layout.paneSizes).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  // 三个 pane 都有内容，不应触发收敛。
  assert.equal(layout.splitEnabled, true);
});

test('adding a third empty pane does not collapse the layout', () => {
  const layout = normalizeLayoutShape({
    splitEnabled: true,
    paneIds: ['pane-1', 'pane-2', 'pane-3'],
    panes: [
      { id: 'pane-1', tabIds: ['tab-main'] },
      { id: 'pane-2', tabIds: ['tab-a'] },
      { id: 'pane-3', tabIds: [] }
    ]
  });

  // 有内容的分组仍在，不应因为多了一个空 pane 就把已有分屏拆掉。
  assert.equal(layout.splitEnabled, true);
  assert.deepEqual(layout.panes[2].tabIds, []);
});

test('collapses when only one pane holds content', () => {
  const layout = normalizeLayoutShape({
    splitEnabled: true,
    paneIds: ['pane-1', 'pane-2', 'pane-3'],
    panes: [
      { id: 'pane-1', tabIds: [] },
      { id: 'pane-2', tabIds: ['tab-main'] },
      { id: 'pane-3', tabIds: [] }
    ]
  });

  assert.equal(layout.splitEnabled, false);
  assert.equal(layout.activePaneId, 'pane-2');
  assert.equal(layout.panes.length, 3);
});

test('normalizePaneSizes fills missing panes and normalizes', () => {
  // pane-1 已占满 1，剩余量为 0，因此另外两个 pane 分不到尺寸；归一化后仍是 1/0/0。
  const full = normalizePaneSizes({ 'pane-1': 1 }, ['pane-1', 'pane-2', 'pane-3']);
  assert.ok(Math.abs(full['pane-1'] - 1) < 1e-9);
  assert.ok(Math.abs(full['pane-2']) < 1e-9);
  assert.ok(Math.abs(full['pane-3']) < 1e-9);

  // 只有部分尺寸时，剩余量在缺失的 pane 之间均分。
  const partial = normalizePaneSizes({ 'pane-1': 0.5 }, ['pane-1', 'pane-2', 'pane-3']);
  assert.ok(Math.abs(partial['pane-1'] - 0.5) < 1e-9);
  assert.ok(Math.abs(partial['pane-2'] - 0.25) < 1e-9);
  assert.ok(Math.abs(partial['pane-3'] - 0.25) < 1e-9);
});

test('reconcileEmptyPanes reports moved tabs', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-2',
    paneSizes: {},
    panes: [
      { id: 'pane-1', activeTabId: null, tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-a', tabIds: ['tab-a', 'tab-b'] }
    ]
  };

  const result = reconcileEmptyPanes(layout);

  assert.equal(result.collapsed, true);
  assert.deepEqual(result.movedTabIds, ['tab-a', 'tab-b']);
  assert.equal(layout.activePaneId, 'pane-1');
});

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
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1', 'tab-filter-1'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-filter-1', 'tab-main']);
  // pane-2 的两条候选都已被 pane-1 占用 ⇒ 去重后为空，但仍有两个 pane，
  // `splitEnabled` 原样保留（reconcileEmptyPanes 只在「恰一个非空」时折叠）。
  assert.deepEqual(layout.panes[1].tabIds, []);
  assert.equal(layout.panes[0].activeTabId, 'tab-filter-1');
  assert.equal(layout.panes[1].activeTabId, null);
});

// I2：`panes[].tabIds` 永远不得包含 shell id。
//
// 这里断言的是「剔除 + 随之收敛」两件事一起生效：历史配置里 `pane-2` 只有一条
// `tab-shell-1`（违反 I2）时，剔除后它是空的，`reconcileEmptyPanes` 于是走
// 「只剩一个非空 pane」分支把分屏折叠掉。
//
// 未剔除时的后果是实测过的（`rcd-1500.txt`）：脏 id 让这个 pane 看起来「有内容」，
// 折叠不发生，屏幕上就留下一个 941px 宽、0 个标签的空分屏；同时右键菜单的
// `canSplit` 被灌水成 true，而 `splitWorkspaceTabIntoPane` 对 shell 硬拒 ⇒
// 「菜单可点、点了没反应」。
//
// 旧断言曾把 `['tab-shell-1']` 当作 pane-2 的合法内容（`assert.deepEqual(layout.panes[1].tabIds, ['tab-shell-1'])`），
// 那正是把 I2 违规当成预期行为，已按新事实改写。
test('drops shell ids from panes and collapses the pane left empty', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-2',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-shell-1', tabIds: ['tab-shell-1'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main', 'tab-filter-1']);
  assert.deepEqual(layout.panes[1].tabIds, []);
  assert.equal(layout.panes[1].activeTabId, null);
  assert.equal(layout.splitEnabled, false);
  assert.equal(layout.activePaneId, 'pane-1');
});

// 只剔 shell，不动其他叶：两个 pane 都有真实内容时分屏不变。
test('keeps a legitimate split while still dropping shell ids', () => {
  const layout = normalizeWorkspaceLayoutShape({
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-shell-1'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-2', 'tab-shell-9'] }
    ]
  });

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main']);
  assert.deepEqual(layout.panes[1].tabIds, ['tab-filter-2']);
  assert.equal(layout.splitEnabled, true);
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

// 旧断言 `prunes tabs that are rendered in a different pane` 已失效。
//
// 它断言的是「布局层按 DOM 里按钮 / 面板在不在某个 pane 里，把标签从 tabIds 里 prune 掉」。
// S5-④ 之后这条合约**必须不存在**：布局层不再查 DOM 判断可渲染性（那正是两套真源的根源），
// 成员资格只由模型与 reconcileEmptyPanes 决定。旧的期望值（pane-2 被掏空）描述的正是
// 「布局被渲染结果反向修改」这个缺陷本身，因此不能保留。
test('an empty second pane collapses without consulting the DOM', () => {
  const layout = {
    splitEnabled: true,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
      { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
  };
  let domLookups = 0;
  const previousDocument = global.document;
  global.document = {
    getElementById: () => { domLookups += 1; return null; },
    querySelector: () => null,
    querySelectorAll: () => []
  };
  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: () => null,
      getPaneTabsList() {},
      getPaneTabsContent() {}
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.deepEqual(layout.panes[0].tabIds, ['tab-main']);
  assert.ok(layout.panes[1].tabIds.length === 0);
  assert.equal(layout.splitEnabled, false);
  assert.equal(layout.activePaneId, 'pane-1');
  assert.equal(domLookups, 0, '布局层不得再查 DOM 来判断可渲染性');
});

// 旧断言 `applying a normalized layout synchronizes persisted pane ownership` 已失效。
//
// 它断言「applyLayoutToDom 会把按钮 / 面板 appendChild 到新 pane 并回写 dataset.paneId」。
// S5-④ 之后 DOM 搬移与 dataset 回写全部归 renderWorkspace()（reconcileButtons / applyVisibility），
// 布局层只报「哪些标签换了 pane」这个事实（onTabMoved 用于持久化）。保留旧断言会迫使布局层
// 重新获得写 DOM 的能力，与单一真源目标直接冲突。
//
// 断言形态也换了：不能把 normalizeWorkspaceLayoutShape 的结果喂进来——该函数末尾自带一次
// reconcileEmptyPanes，收敛在进入 applyLayoutToDom 之前就发生了，moved 会恒为空，断言就失去区分力。
// 这里喂未归一化的裸布局，验证的正是「布局落地自己会收敛并把逃逸到第二 pane 的标签搬回来」。
test('a layout landing collapses an empty pane and reports the moved tabs', () => {
  const layout = {
    splitEnabled: true,
    orientation: 'horizontal',
    activePaneId: 'pane-2',
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
      { id: 'pane-1', activeTabId: null, tabIds: [] },
      { id: 'pane-2', activeTabId: 'tab-main', tabIds: ['tab-main'] }
    ]
  };
  const moved = [];
  const previousDocument = global.document;
  global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: () => null,
      getPaneTabsList() {},
      getPaneTabsContent() {},
      onTabMoved: event => moved.push(event)
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  // 空 pane-1 收敛后，tab-main 属于 pane-1（模型事实），并已上报给持久化层。
  assert.equal(layout.splitEnabled, false);
  assert.equal(layout.activePaneId, 'pane-1');
  assert.deepEqual(moved, [{ tabId: 'tab-main', sourcePaneId: 'pane-2', targetPaneId: 'pane-1' }]);
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

// 旧断言 `switching tabs updates only the target pane` 已失效。
//
// 它断言「切标签时只清目标 pane 的 .active / aria-selected」。S5-④ 之后激活态的唯一写点是
// renderWorkspace() 的 applyVisibility（按 plan.panelIds 全量写），布局层不再写类名。
// 旧的 `queries['pane-2'] 为空` 只在测「布局层没碰 DOM」这个已经不存在的合约。
// 新合约：切标签只改模型两个字段，并恰好发一次渲染请求。
test('switching tabs only mutates model state and requests one render', () => {
  const layout = {
    splitEnabled: true,
    activePaneId: 'pane-1',
    panes: [
      { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main', 'tab-filter-1'] },
      { id: 'pane-2', activeTabId: 'tab-filter-2', tabIds: ['tab-filter-2'] }
    ]
  };
  let renders = 0;
  let domQueries = 0;
  const previousDocument = global.document;
  global.document = {
    querySelector: () => { domQueries += 1; return null; },
    querySelectorAll: () => { domQueries += 1; return []; }
  };
  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: () => null,
      onLayoutChanged: () => { renders += 1; }
    });
    assert.equal(manager.switchPaneTab('pane-1', 'tab-filter-1'), true);
  } finally {
    global.document = previousDocument;
  }

  assert.equal(layout.panes[0].activeTabId, 'tab-filter-1');
  assert.equal(layout.panes[1].activeTabId, 'tab-filter-2', '不得动到其它 pane');
  assert.ok(renders > 0, '切标签必须请求渲染');
  assert.equal(domQueries, 0, '布局层不得直接查写 DOM');
});

// 旧断言 `applying a layout orders pane tab buttons by tabIds` 已失效。
//
// 它断言「applyLayoutToDom 调 insertBefore 把按钮按 tabIds 排序」。DOM 排序现在是
// renderWorkspace 的 reconcileButtons → orderButtons 的职责，布局层不再持有这个能力。
// 旧断言的反向对照（`... is a no-op when the DOM already matches`）也因此变成
// 恒真断言（布局层什么都不做 ⇒ mutations 恒为 0），没有区分力，一并移除。
//
// 行内顺序的正确性改由两处保证：
//   1. 模型层：tabs[] / panes[].tabIds 的顺序是真源（test/tab-model.test.js 覆盖）；
//   2. 渲染层：reconcileButtons 每次渲染都按 plan 顺序重排（CDP 的 verify-tab-order 覆盖）。
test('layout application never reorders DOM nodes itself', () => {
  const layout = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 1 },
    panes: [{ id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-filter-1', 'tab-main'] }]
  };
  let mutations = 0;
  const list = {
    children: [],
    appendChild(child) { mutations += 1; this.children.push(child); return child; },
    insertBefore(child) { mutations += 1; this.children.push(child); return child; }
  };
  const previousDocument = global.document;
  global.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  try {
    const manager = createWorkspaceManager({
      getLayout: () => layout,
      setLayout() {},
      cloneLayout: value => JSON.parse(JSON.stringify(value || layout)),
      persistLayout() {},
      getPaneDom: () => null,
      getPaneTabsList: () => list,
      getPaneTabsContent: () => null
    });
    manager.applyLayoutToDom();
  } finally {
    global.document = previousDocument;
  }

  assert.equal(mutations, 0, '布局层不得再搬动按钮，排序归渲染层');
});

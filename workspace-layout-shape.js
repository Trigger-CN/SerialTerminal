'use strict';

// 工作区布局的 pane 规整逻辑（P5 基础）。
//
// 原先 workspace-manager.js 把「恰好两个 pane」写死在规整与合并逻辑里：paneSizes 只认
// pane-1 / pane-2，activePaneId 的白名单也只有这两个值。要实现分组级与组内级两层
// 分屏，pane 数量必须可变，因此这里把纯数据层的规整抽出来，按任意 pane 列表工作。
//
// 本模块不碰 DOM，只处理布局对象，因此可以直接在 Node 里断言。
// 关键约束：pane 数量为 2 时的输出必须与改造前**逐字段一致**，现有 11 项
// workspace-manager 测试继续充当回归保护。

const DEFAULT_PANE_ID = 'pane-1';
const MAIN_TAB_ID = 'tab-main';

function createDefaultLayout() {
  return {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: DEFAULT_PANE_ID,
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
      { id: 'pane-1', activeTabId: MAIN_TAB_ID, tabIds: [MAIN_TAB_ID] },
      { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
  };
}

// 把任意 pane 尺寸映射归一化到和为 1。缺失或非法的项按均分补齐。
function normalizePaneSizes(sourceSizes, paneIds) {
  const sizes = {};
  paneIds.forEach(id => {
    const value = Number(sourceSizes?.[id]);
    if (Number.isFinite(value) && value > 0) sizes[id] = value;
  });

  const missing = paneIds.filter(id => sizes[id] === undefined);
  if (missing.length) {
    const used = paneIds.reduce((total, id) => total + (sizes[id] || 0), 0);
    const remainder = Math.max(0, 1 - used);
    // 剩余量要在缺失的 pane 之间均分；若已有尺寸已占满（even 为 0），
    // 缺失的 pane 就是 0，不能反过来均分整个 1——否则会把已占满的 pane 生生缩小。
    const share = remainder / missing.length;
    missing.forEach(id => { sizes[id] = share; });
  }

  const total = paneIds.reduce((sum, id) => sum + sizes[id], 0);
  if (!(total > 0)) {
    const even = 1 / paneIds.length;
    paneIds.forEach(id => { sizes[id] = even; });
    return sizes;
  }
  paneIds.forEach(id => { sizes[id] /= total; });
  return sizes;
}

// 收敛规则（分两种情况，必须同时满足旧有两 pane 行为与多 pane 语义）：
//   1. 恰有一个 pane 有内容 → 收敛成单 pane。两 pane 时等价于旧返回：空的那个被合入有内容的一个。
//      注意旧实现固定把内容挪进 pane-1，实现上因此优先选用 pane-1。
//   2. 所有 pane 都为空 → 收敛到第一个 pane。
// 其余情况（仍有 ≥2 个 pane 有内容）不改动，哪怕其中某些 pane 是空的。
function reconcileEmptyPanes(layout) {
  const panes = layout.panes;
  if (panes.length < 2) return { collapsed: false, movedTabIds: [] };

  const filled = panes.filter(pane => pane.tabIds.length > 0);
  if (filled.length === 0) {
    panes.forEach(pane => { pane.activeTabId = null; });
    layout.splitEnabled = false;
    layout.activePaneId = panes[0].id;
    return { collapsed: true, movedTabIds: [] };
  }
  if (filled.length > 1) return { collapsed: false, movedTabIds: [] };

  // 只剩一个非空 pane：把它之外的 tab 全部合入它。宿主选择必须区分两种情况：
  //   - 恰两 pane：旧实现固定把内容挪进 pane-1，因此必须选 pane-1 才能逐字段一致。
  //   - 多于两 pane：选那个有内容的 pane，否则会出现「活跃 pane 是空 pane」的怪状态。
  const primary = panes.length === 2
    ? (panes.find(pane => pane.id === DEFAULT_PANE_ID) || filled[0])
    : filled[0];
  const movedTabIds = [];
  // 被搬 pane 的活跃 tab 要跟着过来：旧实现就是这么做的，直接取 tab[0] 会改变活跃 tab。
  let carriedActiveTabId = null;
  // 必须在合并之前记下宿主的原始 tab 列表，见下方判定处。
  const primaryTabIdsBefore = primary.tabIds.slice();
  panes.forEach(pane => {
    if (pane === primary) return;
    if (pane.tabIds.length) {
      movedTabIds.push(...pane.tabIds);
      if (!carriedActiveTabId && pane.activeTabId && pane.tabIds.includes(pane.activeTabId)) {
        carriedActiveTabId = pane.activeTabId;
      }
    }
    pane.tabIds = [];
    pane.activeTabId = null;
  });

  if (movedTabIds.length) {
    primary.tabIds.push(...movedTabIds);
    // 宿主自己的活跃 tab 只对「合并前就属于自己的 tab」有意义：
    // moveWorkspaceTab 把 tab 搬走后会留下一个指向已离开 tab 的陈旧 activeTabId，
    // 若拿合并后的列表去判定，被搬进来的同名 tab 会让这个陈旧值错误地通过检查。
    if (primaryTabIdsBefore.includes(primary.activeTabId)) {
      // 宿主原本的活跃 tab 仍然有效，保持不动。
    } else {
      primary.activeTabId = carriedActiveTabId && primary.tabIds.includes(carriedActiveTabId)
        ? carriedActiveTabId
        : (primary.tabIds[0] || null);
    }
  }

  layout.splitEnabled = false;
  layout.activePaneId = primary.id;
  return { collapsed: true, movedTabIds };
}

// 归一化任意布局对象。pane 列表以调用方给出的 paneIds 为准：
// 传入 paneIds 时按它构造（用于新增/删除 pane），否则沿用 source 的 pane 顺序。
function normalizeLayoutShape(layout, { paneIds = null, defaultLayout = null } = {}) {
  const base = defaultLayout ? JSON.parse(JSON.stringify(defaultLayout)) : createDefaultLayout();
  const source = layout && typeof layout === 'object' ? layout : {};

  const sourcePanes = Array.isArray(source.panes) ? source.panes : [];
  const ids = (paneIds && paneIds.length)
    ? [...paneIds]
    : (sourcePanes.length ? sourcePanes.map((p, i) => (typeof p?.id === 'string' && p.id) || `pane-${i + 1}`) : base.panes.map(p => p.id));

  const normalized = {
    splitEnabled: source.splitEnabled === true,
    orientation: source.orientation === 'vertical' ? 'vertical' : 'horizontal',
    activePaneId: ids.includes(source.activePaneId) ? source.activePaneId : ids[0],
    paneSizes: normalizePaneSizes(source.paneSizes, ids),
    panes: ids.map(id => ({ id, activeTabId: null, tabIds: [] }))
  };

  const usedTabIds = new Set();
  normalized.panes.forEach(target => {
    const pane = sourcePanes.find(item => item?.id === target.id);
    const sourceTabIds = Array.isArray(pane?.tabIds) ? pane.tabIds : [];
    target.tabIds = sourceTabIds.filter(tabId => {
      if (typeof tabId !== 'string' || !tabId || usedTabIds.has(tabId)) return false;
      usedTabIds.add(tabId);
      return true;
    });
    const activeTabId = typeof pane?.activeTabId === 'string' ? pane.activeTabId : null;
    target.activeTabId = target.tabIds.includes(activeTabId) ? activeTabId : (target.tabIds[0] || null);
  });

  if (!usedTabIds.has(MAIN_TAB_ID) && normalized.panes.length) {
    normalized.panes[0].tabIds.unshift(MAIN_TAB_ID);
    normalized.panes[0].activeTabId ||= MAIN_TAB_ID;
  }

  if (!normalized.panes.find(pane => pane.id === normalized.activePaneId)?.tabIds.length) {
    normalized.activePaneId = normalized.panes.find(pane => pane.tabIds.length)?.id || ids[0];
  }

  reconcileEmptyPanes(normalized);
  return normalized;
}

module.exports = {
  DEFAULT_PANE_ID,
  MAIN_TAB_ID,
  createDefaultLayout,
  normalizePaneSizes,
  normalizeLayoutShape,
  reconcileEmptyPanes
};

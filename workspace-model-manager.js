'use strict';

const model = require('./tab-model');

// 保留旧调用签名，但布局读取返回副本，写入只发布统一模型动作。
function createWorkspaceModelManager({ groupId, getWorkspace, dispatch, persistLayout,
    onTabActivated, onTabMoved, describeTab, ensurePaneElement, onLayoutChanged, fitWorkspace }) {
    const container = () => model.tabOf(getWorkspace(), groupId);
    const panes = () => model.panesOf(container());
    const primary = () => panes()[0]?.id || 'pane-1';
    const paneById = id => panes().find(pane => pane.id === id) || panes()[0];
    const paneForTab = id => panes().find(pane => pane.tabIds.includes(id));
    const activePane = () => paneById(container()?.activePaneId);
    const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const snapshot = () => ({
        panes: copy(panes()),
        splitEnabled: container()?.paneSplit.enabled === true,
        orientation: container()?.paneSplit.orientation || 'horizontal',
        paneSizes: copy(container()?.paneSplit.sizes || {}),
        activePaneId: activePane()?.id || primary()
    });
    const apply = (action, persist = true) => {
        const result = dispatch(action);
        if (!result.ok) return false;
        if (persist) persistLayout?.();
        return true;
    };
    function activate(paneId, tabId, { persist = true } = {}) {
        const pane = paneForTab(tabId);
        if (!pane || (paneId && pane.id !== paneId)) return false;
        const changed = pane.activeTabId !== tabId || getWorkspace().focusedTabId !== tabId;
        if (!apply({ type: 'activate', tabId }, persist)) return false;
        onTabActivated?.({ tabId, paneId: pane.id });
        return changed;
    }
    function add(tabId, paneId, { activate = true, persist = true } = {}) {
        const target = paneById(paneId);
        if (!target) return null;
        if (model.tabOf(getWorkspace(), tabId)) return target.id;
        const options = describeTab?.(tabId);
        if (!options || !apply({ type: 'add-leaf', groupId, paneId: target.id, options, activate }, persist)) return null;
        return target.id;
    }
    function move(tabId, targetPaneId, { insertionIndex = null } = {}) {
        const sourcePaneId = paneForTab(tabId)?.id || null;
        const target = panes().find(pane => pane.id === targetPaneId);
        if (!target) return false;
        if (!apply({ type: 'move', tabId, target: { kind: 'pane', groupId, paneId: targetPaneId,
            index: insertionIndex === null ? target.tabIds.length : insertionIndex } })) return false;
        onTabMoved?.({ tabId, sourcePaneId, targetPaneId });
        return true;
    }
    function remove(tabId, { fallbackTabId = null, persist = true } = {}) {
        const paneId = paneForTab(tabId)?.id || primary();
        if (!apply({ type: 'close', tabId }, persist)) return { paneId, nextActiveTabId: activePane()?.activeTabId || fallbackTabId };
        return { paneId, nextActiveTabId: activePane()?.activeTabId || fallbackTabId };
    }
    function sizes(ratio, { persist = true } = {}) {
        const ids = panes().map(pane => pane.id);
        const first = Math.min(0.85, Math.max(0.15, Number(ratio) || 0.5));
        const others = model.normalizeSizes(container()?.paneSplit.sizes || {}, ids.slice(1));
        const next = { [ids[0]]: first };
        for (const id of ids.slice(1)) next[id] = others[id] * (1 - first);
        return apply({ type: 'resize-panes', groupId, sizes: next }, persist);
    }
    function collapse() {
        return apply({ type: 'pane-split', groupId, enabled: false });
    }
    function ensureElements() {
        const created = [];
        for (const pane of panes()) if (ensurePaneElement?.(pane.id)) created.push(pane.id);
        return created;
    }
    return {
        getPaneById: id => copy(paneById(id)),
        getPaneIdForTabId: id => paneForTab(id)?.id || primary(),
        getDefaultLayout: snapshot, getLayoutSnapshot: snapshot,
        isSplitEnabled: () => container()?.paneSplit.enabled === true,
        getOrientation: () => container()?.paneSplit.orientation || 'horizontal',
        normalizeWorkspaceLayout: copy,
        getActivePane: () => copy(activePane()),
        getActiveTabId: fallback => activePane()?.activeTabId || fallback,
        getActiveTabInfo: fallback => ({ paneId: activePane()?.id || primary(), tabId: activePane()?.activeTabId || fallback }),
        resolvePaneId: (paneId, tabId) => panes().some(pane => pane.id === paneId) ? paneId : paneForTab(tabId)?.id || activePane()?.id || primary(),
        getOtherPaneId: paneId => { const ids = panes().map(pane => pane.id); return ids[(ids.indexOf(paneId) + 1) % ids.length] || primary(); },
        getTabPaneId: id => paneForTab(id)?.id || primary(),
        isTabActive: id => panes().some(pane => pane.activeTabId === id),
        ensurePaneActiveTab: () => {},
        reconcileEmptyPanes: () => ({ collapsed: false, movedTabIds: [] }),
        ensurePaneTabMembership: (paneId, tabId) => add(tabId, paneId, { activate: false, persist: false }),
        setActivePane: (paneId, { persist = true } = {}) => apply({ type: 'active-pane', groupId, paneId }, persist),
        applyLayoutToDom: () => { ensureElements(); onLayoutChanged?.(); },
        switchPaneTab: activate,
        enableSplit: orientation => apply({ type: 'pane-split', groupId, enabled: true, orientation }),
        moveTabToPane: move, addTabToPane: add, removeTab: remove,
        collapseSplit: collapse,
        replaceLayout: (layout, { persist = true } = {}) => apply({ type: 'restore-group-layout', groupId, layout }, persist),
        restoreLayout: (layout, { persist = true } = {}) => apply({ type: 'restore-group-layout', groupId, layout }, persist),
        setPaneSizes: sizes, ensurePaneElements: ensureElements
    };
}

module.exports = { createWorkspaceModelManager };

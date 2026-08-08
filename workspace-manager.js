const DEFAULT_WORKSPACE_LAYOUT = {
    splitEnabled: false,
    orientation: 'horizontal',
    activePaneId: 'pane-1',
    paneSizes: { 'pane-1': 0.5, 'pane-2': 0.5 },
    panes: [
        { id: 'pane-1', activeTabId: 'tab-main', tabIds: ['tab-main'] },
        { id: 'pane-2', activeTabId: null, tabIds: [] }
    ]
};

function normalizeWorkspaceLayoutShape(layout) {
    const normalized = JSON.parse(JSON.stringify(DEFAULT_WORKSPACE_LAYOUT));
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
    reconcileEmptyPaneLayout(normalized);
    return normalized;
}

function reconcileEmptyPaneLayout(layout) {
    const pane1 = layout.panes.find(pane => pane.id === 'pane-1');
    const pane2 = layout.panes.find(pane => pane.id === 'pane-2');
    if (!pane1 || !pane2 || (pane1.tabIds.length && pane2.tabIds.length)) {
        return { collapsed: false, movedTabIds: [] };
    }

    const movedTabIds = pane1.tabIds.length === 0 ? [...pane2.tabIds] : [];
    if (movedTabIds.length) {
        pane1.tabIds = movedTabIds;
        pane1.activeTabId = pane2.activeTabId && movedTabIds.includes(pane2.activeTabId)
            ? pane2.activeTabId
            : movedTabIds[0];
        pane2.tabIds = [];
    }
    pane2.activeTabId = null;
    layout.splitEnabled = false;
    layout.activePaneId = 'pane-1';
    return { collapsed: true, movedTabIds };
}

function moveWorkspaceTab(layout, tabId, targetPaneId, insertionIndex = null) {
    const sourcePane = layout.panes.find(pane => pane.tabIds.includes(tabId));
    const targetPane = layout.panes.find(pane => pane.id === targetPaneId);
    if (!sourcePane || !targetPane) return null;
    const sourcePaneId = sourcePane.id;
    sourcePane.tabIds = sourcePane.tabIds.filter(id => id !== tabId);
    const targetIds = targetPane.tabIds.filter(id => id !== tabId);
    const targetIndex = insertionIndex === null
        ? targetIds.length
        : Math.max(0, Math.min(Number(insertionIndex) || 0, targetIds.length));
    targetIds.splice(targetIndex, 0, tabId);
    targetPane.tabIds = targetIds;
    return { sourcePaneId, targetPaneId, insertionIndex: targetIndex };
}

function createWorkspaceManager(options = {}) {
    const {
        getLayout,
        setLayout,
        cloneLayout,
        normalizeLayout,
        persistLayout,
        getPaneDom,
        getPaneTabsList,
        getPaneTabsContent,
        onLayoutApplied,
        onTabActivated,
        onTabMoved,
        fitWorkspace
    } = options;

    function getLayoutState() {
        return getLayout();
    }

    function getDefaultLayout() {
        return cloneLayout();
    }

    function getLayoutSnapshot() {
        return cloneLayout(getLayoutState());
    }

    function isSplitEnabled() {
        return getLayoutState().splitEnabled === true;
    }

    function getOrientation() {
        return getLayoutState().orientation === 'vertical' ? 'vertical' : 'horizontal';
    }

    function normalizeWorkspaceLayout(layout) {
        if (typeof normalizeLayout === 'function') {
            return normalizeLayout(layout);
        }
        return cloneLayout(layout);
    }

    function getPaneById(paneId) {
        return getLayoutState().panes.find(pane => pane.id === paneId) || getLayoutState().panes[0];
    }

    function getPaneIdForTabId(tabId) {
        const pane = getLayoutState().panes.find(item => item.tabIds.includes(tabId));
        return pane ? pane.id : 'pane-1';
    }

    function getActivePane() {
        return getPaneById(getLayoutState().activePaneId);
    }

    function getActiveTabId(fallbackTabId = 'tab-main') {
        return getActivePane()?.activeTabId || fallbackTabId;
    }

    function getActiveTabInfo(fallbackTabId = 'tab-main') {
        const pane = getActivePane();
        return {
            paneId: pane?.id || 'pane-1',
            tabId: pane?.activeTabId || fallbackTabId
        };
    }

    function resolvePaneId(paneId, tabId, fallbackTabId = 'tab-main') {
        if (paneId === 'pane-1' || paneId === 'pane-2') {
            return paneId;
        }
        if (tabId) {
            return getPaneIdForTabId(tabId);
        }
        return getActiveTabInfo(fallbackTabId).paneId;
    }

    function getOtherPaneId(paneId) {
        return resolvePaneId(paneId) === 'pane-2' ? 'pane-1' : 'pane-2';
    }

    function getTabPaneId(tabId, fallbackPaneId = 'pane-1') {
        return getPaneIdForTabId(tabId) || fallbackPaneId;
    }

    function isTabActive(tabId) {
        if (!tabId) return false;
        return getLayoutState().panes.some(pane => pane.activeTabId === tabId);
    }

    function hasRenderableTab(paneId, tabId) {
        if (!tabId) return false;
        const paneEl = getPaneDom(paneId);
        if (!paneEl) return false;
        const tabButton = paneEl.querySelector(`.main-tab[data-target="${tabId}"]`);
        const tabPane = paneEl.querySelector(`.main-tab-pane#${tabId}`);
        return Boolean(tabButton && tabPane);
    }

    function findFirstRenderableTabId(paneId) {
        const pane = getPaneById(paneId);
        return pane.tabIds.find(tabId => hasRenderableTab(paneId, tabId)) || null;
    }

    function prunePaneTabIds(paneId) {
        const pane = getPaneById(paneId);
        pane.tabIds = pane.tabIds.filter(tabId => hasRenderableTab(paneId, tabId));
    }

    function ensurePaneActiveTab(paneId) {
        const pane = getPaneById(paneId);
        prunePaneTabIds(paneId);
        if (!pane.tabIds.length) {
            pane.activeTabId = null;
            return;
        }
        if (!pane.activeTabId || !pane.tabIds.includes(pane.activeTabId) || !hasRenderableTab(paneId, pane.activeTabId)) {
            pane.activeTabId = findFirstRenderableTabId(paneId) || pane.tabIds[0] || null;
        }
    }

    function reconcileEmptyPanes() {
        const layout = getLayoutState();
        const result = reconcileEmptyPaneLayout(layout);
        if (!result.collapsed || result.movedTabIds.length === 0) return result;

        result.movedTabIds.forEach(tabId => {
            const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
            const tabPane = document.getElementById(tabId);
            getPaneTabsList('pane-1')?.appendChild(tabBtn);
            getPaneTabsContent('pane-1')?.appendChild(tabPane);
            if (tabBtn) tabBtn.dataset.paneId = 'pane-1';
            if (tabPane) tabPane.dataset.paneId = 'pane-1';
            onTabMoved?.({ tabId, sourcePaneId: 'pane-2', targetPaneId: 'pane-1' });
        });
        return result;
    }

    function setActivePane(paneId, { persist = true } = {}) {
        const layout = getLayoutState();
        layout.activePaneId = paneId === 'pane-2' ? 'pane-2' : 'pane-1';
        document.querySelectorAll('.workspace-pane').forEach(paneEl => {
            paneEl.classList.toggle('active', paneEl.dataset.paneId === layout.activePaneId);
        });
        if (persist) {
            persistLayout();
        }
    }

    function ensurePaneTabMembership(paneId, tabId) {
        const layout = getLayoutState();
        layout.panes.forEach(pane => {
            pane.tabIds = pane.tabIds.filter(id => id !== tabId || pane.id === paneId);
        });
        const pane = getPaneById(paneId);
        if (!pane.tabIds.includes(tabId)) {
            pane.tabIds.push(tabId);
        }
    }

    function updatePaneVisibility() {
        const root = document.getElementById('workspace-root');
        const pane2 = getPaneDom('pane-2');
        const splitter = document.getElementById('workspace-splitter');
        root.classList.toggle('split-vertical', getOrientation() === 'vertical');
        root.classList.toggle('split-horizontal', getOrientation() !== 'vertical');
        if (pane2) pane2.hidden = !isSplitEnabled();
        if (splitter) splitter.hidden = !isSplitEnabled();
    }

    function applyPaneSizes() {
        const root = document.getElementById('workspace-root');
        if (!root) return;
        const layout = getLayoutState();
        if (!isSplitEnabled()) {
            root.style.removeProperty('--pane-1-size');
            root.style.removeProperty('--pane-2-size');
            return;
        }
        const paneSizes = layout.paneSizes || {};
        const pane1 = Number(paneSizes['pane-1']) || 0.5;
        const pane2 = Number(paneSizes['pane-2']) || (1 - pane1);
        root.style.setProperty('--pane-1-size', `${pane1 * 100}%`);
        root.style.setProperty('--pane-2-size', `${pane2 * 100}%`);
    }

    function applyLayoutToDom() {
        const layout = getLayoutState();
        updatePaneVisibility();
        applyPaneSizes();
        document.querySelectorAll('.main-tab').forEach(el => {
            el.classList.remove('active');
            el.setAttribute?.('aria-selected', 'false');
        });
        document.querySelectorAll('.main-tab-pane').forEach(el => el.classList.remove('active'));
        layout.panes.forEach(pane => {
            const tabsList = getPaneTabsList(pane.id);
            const tabsContent = getPaneTabsContent(pane.id);
            pane.tabIds.forEach(tabId => {
                const tabButton = document.querySelector(`.main-tab[data-target="${tabId}"]`);
                const tabPane = document.getElementById(tabId);
                const previousPaneId = tabButton?.dataset?.paneId || tabPane?.dataset?.paneId || null;
                if (tabButton && tabsList) {
                    tabsList.appendChild(tabButton);
                    tabButton.dataset.paneId = pane.id;
                }
                if (tabPane && tabsContent) {
                    tabsContent.appendChild(tabPane);
                    tabPane.dataset.paneId = pane.id;
                }
                if (previousPaneId && previousPaneId !== pane.id) {
                    onTabMoved?.({ tabId, sourcePaneId: previousPaneId, targetPaneId: pane.id });
                }
            });
            prunePaneTabIds(pane.id);
            ensurePaneActiveTab(pane.id);
            const paneEl = getPaneDom(pane.id);
            if (!paneEl) return;
            if (pane.activeTabId) {
                const tabButton = paneEl.querySelector(`.main-tab[data-target="${pane.activeTabId}"]`);
                const tabPane = paneEl.querySelector(`.main-tab-pane#${pane.activeTabId}`);
                if (!tabButton || !tabPane) {
                    pane.activeTabId = findFirstRenderableTabId(pane.id) || null;
                }
                if (pane.activeTabId) {
                    const activeTab = paneEl.querySelector(`.main-tab[data-target="${pane.activeTabId}"]`);
                    activeTab?.classList.add('active');
                    activeTab?.setAttribute?.('aria-selected', 'true');
                    paneEl.querySelector(`.main-tab-pane#${pane.activeTabId}`)?.classList.add('active');
                }
            }
        });
        reconcileEmptyPanes();
        updatePaneVisibility();
        applyPaneSizes();
        setActivePane(layout.activePaneId, { persist: false });
        if (typeof onLayoutApplied === 'function') {
            onLayoutApplied(layout);
        }
    }

    function switchPaneTab(paneId, tabId, { persist = true } = {}) {
        const resolvedPaneId = paneId || getPaneIdForTabId(tabId);
        const layout = getLayoutState();
        const pane = getPaneById(resolvedPaneId);
        if (!pane.tabIds.includes(tabId)) return;

        layout.panes.forEach(item => {
            if (item.id !== resolvedPaneId && item.activeTabId === tabId) {
                item.activeTabId = item.tabIds.find(id => id !== tabId) || item.tabIds[0] || null;
            }
        });

        pane.activeTabId = tabId;
        setActivePane(resolvedPaneId, { persist: false });
        applyLayoutToDom();
        if (persist) {
            persistLayout();
        }
        if (typeof onTabActivated === 'function') {
            onTabActivated({ tabId, paneId: resolvedPaneId });
        }
    }

    function enableSplit(orientation) {
        const layout = getLayoutState();
        layout.splitEnabled = true;
        layout.orientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
        layout.paneSizes = layout.paneSizes || { 'pane-1': 0.5, 'pane-2': 0.5 };
        applyLayoutToDom();
        persistLayout();
        fitWorkspace?.();
    }

    function moveTabToPane(tabId, targetPaneId, { preserveSplit = false, insertionIndex = null } = {}) {
        const layout = getLayoutState();
        const sourcePaneId = getPaneIdForTabId(tabId);
        const sourcePane = getPaneById(sourcePaneId);
        const targetPane = getPaneById(targetPaneId);
        const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
        const tabPane = document.getElementById(tabId);
        if (!tabBtn || !tabPane) return;

        if (targetPaneId === 'pane-2') {
            layout.splitEnabled = true;
        }

        moveWorkspaceTab(layout, tabId, targetPaneId, insertionIndex);
        ensurePaneActiveTab(sourcePaneId);
        targetPane.activeTabId = tabId;

        getPaneTabsList(targetPaneId)?.appendChild(tabBtn);
        getPaneTabsContent(targetPaneId)?.appendChild(tabPane);
        tabBtn.dataset.paneId = targetPaneId;
        tabPane.dataset.paneId = targetPaneId;

        const reconciliation = reconcileEmptyPanes();
        if (!reconciliation.collapsed && !preserveSplit) {
            layout.splitEnabled = targetPaneId === 'pane-2' || layout.panes[1].tabIds.length > 0;
        }

        if (typeof onTabMoved === 'function' && !reconciliation.movedTabIds.includes(tabId)) {
            onTabMoved({ tabId, sourcePaneId, targetPaneId });
        }

        const finalPaneId = reconciliation.movedTabIds.includes(tabId) ? 'pane-1' : targetPaneId;
        applyLayoutToDom();
        switchPaneTab(finalPaneId, tabId, { persist: false });
        persistLayout();
        fitWorkspace?.();
    }

    function addTabToPane(tabId, paneId, { activate = true, allowSplit = true, persist = true } = {}) {
        const layout = getLayoutState();
        const resolvedPaneId = paneId || layout.activePaneId || 'pane-1';
        ensurePaneTabMembership(resolvedPaneId, tabId);
        if (resolvedPaneId === 'pane-2' && allowSplit) {
            layout.splitEnabled = true;
        }
        if (activate) {
            getPaneById(resolvedPaneId).activeTabId = tabId;
        } else {
            ensurePaneActiveTab(resolvedPaneId);
        }
        applyLayoutToDom();
        if (persist) {
            persistLayout();
        }
        return resolvedPaneId;
    }

    function removeTab(tabId, { fallbackTabId = 'tab-main', persist = true } = {}) {
        const paneId = getPaneIdForTabId(tabId);
        const pane = getPaneById(paneId);
        pane.tabIds = pane.tabIds.filter(id => id !== tabId);
        ensurePaneActiveTab(paneId);
        const reconciliation = reconcileEmptyPanes();
        applyLayoutToDom();
        let nextActiveTabId = reconciliation.collapsed
            ? getPaneById('pane-1').activeTabId
            : pane.activeTabId;
        nextActiveTabId ||= null;
        if (!nextActiveTabId && fallbackTabId) {
            nextActiveTabId = fallbackTabId;
        }
        if (persist) {
            persistLayout();
        }
        return {
            paneId,
            nextActiveTabId
        };
    }

    function collapseSplit() {
        const layout = getLayoutState();
        const pane1 = getPaneById('pane-1');
        const pane2 = getPaneById('pane-2');
        const movedTabIds = [...pane2.tabIds];
        movedTabIds.forEach(tabId => {
            const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
            const tabPane = document.getElementById(tabId);
            getPaneTabsList('pane-1')?.appendChild(tabBtn);
            getPaneTabsContent('pane-1')?.appendChild(tabPane);
            if (tabBtn) tabBtn.dataset.paneId = 'pane-1';
            if (tabPane) tabPane.dataset.paneId = 'pane-1';
            onTabMoved?.({ tabId, sourcePaneId: 'pane-2', targetPaneId: 'pane-1' });
        });
        pane1.tabIds = [...pane1.tabIds, ...movedTabIds];
        if (layout.activePaneId === 'pane-2' && pane2.activeTabId) pane1.activeTabId = pane2.activeTabId;
        pane2.tabIds = [];
        pane2.activeTabId = null;
        pane1.activeTabId = pane1.activeTabId || pane1.tabIds[0] || null;
        layout.splitEnabled = false;
        layout.activePaneId = 'pane-1';
        ensurePaneActiveTab('pane-1');
        applyLayoutToDom();
        persistLayout();
        fitWorkspace?.();
    }

    function replaceLayout(nextLayout, { apply = true, persist = false } = {}) {
        setLayout(normalizeWorkspaceLayout(nextLayout));
        if (apply) {
            applyLayoutToDom();
        }
        if (persist) {
            persistLayout();
        }
    }

    function restoreLayout(nextLayout, { persist = false } = {}) {
        const beforeLayout = JSON.stringify(normalizeWorkspaceLayout(nextLayout));
        replaceLayout(nextLayout, { apply: true, persist });
        const layout = getLayoutState();
        const activePane = getPaneById(layout.activePaneId);
        if (activePane?.activeTabId) {
            switchPaneTab(activePane.id, activePane.activeTabId, { persist: false });
        } else {
            applyLayoutToDom();
        }
        if (persist && JSON.stringify(layout) !== beforeLayout) {
            persistLayout();
        }
    }

    function setPaneSizes(pane1Ratio, { persist = true } = {}) {
        const layout = getLayoutState();
        const clampedPane1Ratio = Math.min(0.85, Math.max(0.15, Number(pane1Ratio) || 0.5));
        layout.paneSizes = {
            'pane-1': clampedPane1Ratio,
            'pane-2': 1 - clampedPane1Ratio
        };
        applyPaneSizes();
        if (persist) {
            persistLayout();
        }
    }

    return {
        getPaneById,
        getPaneIdForTabId,
        getDefaultLayout,
        getLayoutSnapshot,
        isSplitEnabled,
        getOrientation,
        normalizeWorkspaceLayout,
        getActivePane,
        getActiveTabId,
        getActiveTabInfo,
        resolvePaneId,
        getOtherPaneId,
        getTabPaneId,
        isTabActive,
        ensurePaneActiveTab,
        reconcileEmptyPanes,
        ensurePaneTabMembership,
        setActivePane,
        applyLayoutToDom,
        switchPaneTab,
        enableSplit,
        moveTabToPane,
        addTabToPane,
        removeTab,
        collapseSplit,
        replaceLayout,
        restoreLayout,
        setPaneSizes
    };
}

module.exports = {
    createWorkspaceManager,
    normalizeWorkspaceLayoutShape,
    reconcileEmptyPaneLayout,
    moveWorkspaceTab
};

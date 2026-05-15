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

    function hasRenderableTab(tabId) {
        if (!tabId) return false;
        const tabButton = document.querySelector(`.main-tab[data-target="${tabId}"]`);
        const tabPane = document.getElementById(tabId);
        return Boolean(tabButton && tabPane);
    }

    function findFirstRenderableTabId(paneId) {
        const pane = getPaneById(paneId);
        return pane.tabIds.find(tabId => hasRenderableTab(tabId)) || null;
    }

    function prunePaneTabIds(paneId) {
        const pane = getPaneById(paneId);
        pane.tabIds = pane.tabIds.filter(tabId => {
            if (tabId === 'tab-main') {
                return hasRenderableTab(tabId);
            }
            return hasRenderableTab(tabId);
        });
    }

    function ensurePaneActiveTab(paneId) {
        const pane = getPaneById(paneId);
        prunePaneTabIds(paneId);
        if (!pane.tabIds.length) {
            pane.activeTabId = null;
            return;
        }
        if (!pane.activeTabId || !pane.tabIds.includes(pane.activeTabId) || !hasRenderableTab(pane.activeTabId)) {
            pane.activeTabId = findFirstRenderableTabId(paneId) || pane.tabIds[0] || null;
        }
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
        document.querySelectorAll('.main-tab').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.main-tab-pane').forEach(el => el.classList.remove('active'));
        layout.panes.forEach(pane => {
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
                    paneEl.querySelector(`.main-tab[data-target="${pane.activeTabId}"]`)?.classList.add('active');
                    paneEl.querySelector(`.main-tab-pane#${pane.activeTabId}`)?.classList.add('active');
                }
            }
        });
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

    function moveTabToPane(tabId, targetPaneId, { preserveSplit = false } = {}) {
        if (tabId === 'tab-main' && targetPaneId !== 'pane-1') {
            return;
        }

        const layout = getLayoutState();
        const sourcePaneId = getPaneIdForTabId(tabId);
        if (sourcePaneId === targetPaneId) {
            switchPaneTab(targetPaneId, tabId);
            return;
        }

        const sourcePane = getPaneById(sourcePaneId);
        const targetPane = getPaneById(targetPaneId);
        const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
        const tabPane = document.getElementById(tabId);
        if (!tabBtn || !tabPane) return;

        sourcePane.tabIds = sourcePane.tabIds.filter(id => id !== tabId);
        ensurePaneTabMembership(targetPaneId, tabId);
        ensurePaneActiveTab(sourcePaneId);
        targetPane.activeTabId = tabId;

        getPaneTabsList(targetPaneId)?.appendChild(tabBtn);
        getPaneTabsContent(targetPaneId)?.appendChild(tabPane);
        tabBtn.dataset.paneId = targetPaneId;
        tabPane.dataset.paneId = targetPaneId;

        if (!preserveSplit) {
            layout.splitEnabled = true;
        }

        if (typeof onTabMoved === 'function') {
            onTabMoved({ tabId, sourcePaneId, targetPaneId });
        }

        applyLayoutToDom();
        switchPaneTab(targetPaneId, tabId, { persist: false });
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
        applyLayoutToDom();
        let nextActiveTabId = pane.activeTabId || null;
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
        const pane2 = getPaneById('pane-2');
        if (getPaneIdForTabId('tab-main') !== 'pane-1') {
            moveTabToPane('tab-main', 'pane-1', { preserveSplit: true });
        }
        pane2.tabIds.filter(tabId => tabId !== 'tab-main').forEach(tabId => {
            moveTabToPane(tabId, 'pane-1', { preserveSplit: true });
        });
        getPaneTabsContent('pane-1')?.appendChild(document.getElementById('tab-main'));
        getPaneTabsList('pane-1')?.appendChild(document.querySelector('.main-tab[data-target="tab-main"]'));
        ensurePaneTabMembership('pane-1', 'tab-main');
        pane2.tabIds = [];
        pane2.activeTabId = null;
        getPaneById('pane-1').activeTabId = getPaneById('pane-1').activeTabId || 'tab-main';
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
    createWorkspaceManager
};
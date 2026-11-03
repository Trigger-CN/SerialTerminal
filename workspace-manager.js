const {
    createDefaultLayout: createShapeDefaultLayout,
    normalizeLayoutShape,
    normalizePaneSizes,
    reconcileEmptyPanes
} = require('./workspace-layout-shape');

const DEFAULT_WORKSPACE_LAYOUT = createShapeDefaultLayout();

// 布局规整已抽到 workspace-layout-shape.js：那里按任意 pane 列表工作，
// 两 pane 时的输出与改造前逐字段一致（由 test/workspace-layout-shape.test.js 的等价性用例背书）。
function normalizeWorkspaceLayoutShape(layout) {
    return normalizeLayoutShape(layout, { defaultLayout: DEFAULT_WORKSPACE_LAYOUT });
}

function reconcileEmptyPaneLayout(layout) {
    return reconcileEmptyPanes(layout);
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
        onTabMoved,
        ensurePaneElement,
        fitWorkspace,
        // 可选：让调用方接管「某个标签的按钮应挂在哪个容器里」。返回 null 表示按默认规则
        // （留在所属 pane 的 tabsList）。Shell 标签在多分组时会搬到分组栏，而它仍属于
        // pane-1 的 tabIds，因此布局层仍要能找到它的按钮并给它上激活态。
        resolveTabButtonHost,
        // 可选：按 data-target 查找标签按钮。默认只在 pane 内找，但被搬到外层的按钮
        // 不在那个 pane 里，必须允许调用方提供更宽的查找。
        findTabButton
    } = options;

    function getLayoutState() {
        return getLayout();
    }

    // 布局可能包含 DOM 里还不存在的 pane（静态页只有两个，而布局层已支持 N 个）。
    // 必须在任何 appendChild 之前把节点补齐，否则 appendChild(null) 会静默丢掉标签页。
    function ensurePaneElements() {
        if (typeof ensurePaneElement !== 'function') return [];
        const created = [];
        getLayoutState().panes.forEach(pane => {
            if (getPaneDom(pane.id)) return;
            if (ensurePaneElement(pane.id) !== false) created.push(pane.id);
        });
        return created;
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
    // pane 数量由布局驱动，不再假设只有 pane-1 / pane-2。
    function getPaneIds() {
        return getLayoutState().panes.map(pane => pane.id);
    }

    function getPrimaryPaneId() {
        return getLayoutState().panes[0]?.id || 'pane-1';
    }

    // 首个 pane 之外还有内容，才需要显示分屏。
    function hasPopulatedSplitPane() {
        return getLayoutState().panes.slice(1).some(pane => pane.tabIds.length > 0);
    }

    function ensurePaneSizesCoverLayout() {
        const layout = getLayoutState();
        layout.paneSizes = normalizePaneSizes(layout.paneSizes, getPaneIds());
    }

    function getPaneIdForTabId(tabId) {
        const pane = getLayoutState().panes.find(item => item.tabIds.includes(tabId));
        return pane ? pane.id : getPrimaryPaneId();
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
            paneId: pane?.id || getPrimaryPaneId(),
            tabId: pane?.activeTabId || fallbackTabId
        };
    }

    function resolvePaneId(paneId, tabId, fallbackTabId = 'tab-main') {
        // 白名单改为「必须存在于当前布局」，否则多 pane 时新 pane 会被当成 pane-1。
        if (paneId && getLayoutState().panes.some(pane => pane.id === paneId)) {
            return paneId;
        }
        if (tabId) {
            return getPaneIdForTabId(tabId);
        }
        return getActiveTabInfo(fallbackTabId).paneId;
    }

    // 两 pane 时就是「另一个 pane」；多 pane 时按布局顺序取下一个（循环）。
    function getOtherPaneId(paneId) {
        const paneIds = getPaneIds();
        if (!paneIds.length) return 'pane-1';
        const index = paneIds.indexOf(resolvePaneId(paneId));
        return paneIds[(index + 1) % paneIds.length] || paneIds[0];
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
        // 面板一定在这个 pane 里；按钮则可能被调用方搬到外层容器（多分组时的 Shell 标签）。
        // 若仍用 paneEl.querySelector 找按钮，被搬走的标签会被判为不可渲染，随后被
        // prunePaneTabIds() 从布局里删掉，表现为「切到多分组后 Shell 标签彻底消失」。
        const tabButton = findTabButton
            ? findTabButton(tabId, paneId)
            : paneEl.querySelector(`.main-tab[data-target="${tabId}"]`);
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
        // 规整逻辑会把被搬 pane 的 tabIds 清空，因此源 pane 必须在调用前记下来。
        const tabsBefore = new Map(layout.panes.map(pane => [pane.id, [...pane.tabIds]]));
        const result = reconcileEmptyPaneLayout(layout);
        if (!result.collapsed || result.movedTabIds.length === 0) return result;

        // 宿主 pane 由规整逻辑决定（两 pane 时是 pane-1，多 pane 时是有内容的那个），
        // 它会写进 layout.activePaneId，这里必须跟着走，不能再写死 'pane-1'。
        const hostPaneId = layout.activePaneId || getPrimaryPaneId();
        result.movedTabIds.forEach(tabId => {
            const sourcePaneId = [...tabsBefore.entries()]
                .find(([paneId, tabIds]) => paneId !== hostPaneId && tabIds.includes(tabId))?.[0] || hostPaneId;
            const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
            const tabPane = document.getElementById(tabId);
            getPaneTabsList(hostPaneId)?.appendChild(tabBtn);
            getPaneTabsContent(hostPaneId)?.appendChild(tabPane);
            if (tabBtn) tabBtn.dataset.paneId = hostPaneId;
            if (tabPane) tabPane.dataset.paneId = hostPaneId;
            onTabMoved?.({ tabId, sourcePaneId, targetPaneId: hostPaneId });
        });
        return result;
    }

    function setActivePane(paneId, { persist = true } = {}) {
        const layout = getLayoutState();
        const paneIds = getPaneIds();
        layout.activePaneId = paneIds.includes(paneId) ? paneId : (paneIds[0] || 'pane-1');
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
        const splitter = document.getElementById('workspace-splitter');
        if (!root) return;
        root.classList.toggle('split-vertical', getOrientation() === 'vertical');
        root.classList.toggle('split-horizontal', getOrientation() !== 'vertical');
        // 除首个 pane 外，其余 pane 只在分屏开启时可见；pane 数量不再假设为 2。
        getPaneIds().forEach((paneId, index) => {
            const paneEl = getPaneDom(paneId);
            if (!paneEl) return;
            paneEl.hidden = index === 0 ? false : !isSplitEnabled();
        });
        if (splitter) splitter.hidden = !isSplitEnabled();
    }

    function applyPaneSizes() {
        const root = document.getElementById('workspace-root');
        if (!root) return;
        // 旧实现用两个 CSS 变量（--pane-1-size / --pane-2-size）表达尺寸，pane 一多就无法表达。
        // 改为把尺寸直接写到每个 pane 的 flex-basis 上，任意 pane 数都成立。
        root.style.removeProperty('--pane-1-size');
        root.style.removeProperty('--pane-2-size');
        const layout = getLayoutState();
        const paneIds = getPaneIds();
        const sizes = isSplitEnabled() ? normalizePaneSizes(layout.paneSizes, paneIds) : null;
        paneIds.forEach(paneId => {
            const paneEl = getPaneDom(paneId);
            if (!paneEl?.style) return;
            // 未分屏时不固定 flex-basis，交给 CSS 的 flex: 1 1 0 撑满。
            if (!sizes) {
                paneEl.style.removeProperty('flex-basis');
                return;
            }
            paneEl.style.flexBasis = `${(sizes[paneId] || 0) * 100}%`;
        });
    }

    function applyLayoutToDom() {
        // 先把布局里有、DOM 里没有的 pane 建出来，后续 appendChild 才不会拿到 null。
        ensurePaneElements();
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
                // 按钮目标容器可由调用方接管（Shell 标签被搬到分组栏时就是这种情况）。
                // 未接管时仍然是所属 pane 的 tabsList，单分组行为零变化。
                const buttonHost = resolveTabButtonHost ? resolveTabButtonHost(tabId, pane.id) : null;
                const effectiveTabsList = buttonHost || tabsList;
                if (tabButton && effectiveTabsList) {
                    effectiveTabsList.appendChild(tabButton);
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
                const findButton = id => (findTabButton
                    ? findTabButton(id, pane.id)
                    : paneEl.querySelector(`.main-tab[data-target="${id}"]`));
                const tabButton = findButton(pane.activeTabId);
                const tabPane = paneEl.querySelector(`.main-tab-pane#${pane.activeTabId}`);
                if (!tabButton || !tabPane) {
                    pane.activeTabId = findFirstRenderableTabId(pane.id) || null;
                }
                if (pane.activeTabId) {
                    const activeTab = findButton(pane.activeTabId);
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

    function applyActiveTabToPane(paneId) {
        const pane = getPaneById(paneId);
        const paneEl = getPaneDom(paneId);
        if (!paneEl) return;
        // 激活类必须先按全文档清一遍：被搬到外层容器的按钮（多分组时的 Shell）不在 paneEl 里，
        // 只清 paneEl 会把它上一个激活态留在分组栏上，表现为「两个标签同时亮着」。
        document.querySelectorAll('.main-tab.active').forEach(tab => {
            if (tab.dataset?.paneId === paneId) tab.classList.remove('active');
        });
        document.querySelectorAll('.main-tab[aria-selected="true"]').forEach(tab => {
            if (tab.dataset?.paneId === paneId) tab.setAttribute('aria-selected', 'false');
        });
        paneEl.querySelector('.main-tab-pane.active')?.classList.remove('active');
        if (!pane.activeTabId) return;
        const activeTab = findTabButton
            ? findTabButton(pane.activeTabId, paneId)
            : paneEl.querySelector(`.main-tab[data-target="${pane.activeTabId}"]`);
        const activePane = paneEl.querySelector(`.main-tab-pane#${pane.activeTabId}`);
        activeTab?.classList.add('active');
        activeTab?.setAttribute?.('aria-selected', 'true');
        activePane?.classList.add('active');
    }

    function switchPaneTab(paneId, tabId, { persist = true } = {}) {
        const resolvedPaneId = paneId || getPaneIdForTabId(tabId);
        const layout = getLayoutState();
        const pane = getPaneById(resolvedPaneId);
        if (!pane.tabIds.includes(tabId)) return;

        if (pane.activeTabId === tabId) {
            if (layout.activePaneId !== resolvedPaneId) {
                setActivePane(resolvedPaneId, { persist });
            }
            return false;
        }

        const changedPaneIds = new Set([resolvedPaneId]);
        layout.panes.forEach(item => {
            if (item.id !== resolvedPaneId && item.activeTabId === tabId) {
                item.activeTabId = item.tabIds.find(id => id !== tabId) || item.tabIds[0] || null;
                changedPaneIds.add(item.id);
            }
        });

        pane.activeTabId = tabId;
        setActivePane(resolvedPaneId, { persist: false });
        changedPaneIds.forEach(applyActiveTabToPane);
        if (persist) {
            persistLayout();
        }
        if (typeof onTabActivated === 'function') {
            onTabActivated({ tabId, paneId: resolvedPaneId });
        }
        return true;
    }

    function enableSplit(orientation) {
        const layout = getLayoutState();
        layout.splitEnabled = true;
        layout.orientation = orientation === 'vertical' ? 'vertical' : 'horizontal';
        layout.paneSizes = normalizePaneSizes(layout.paneSizes, getPaneIds());
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

        // 目标 pane 不是首个 pane 就一定需要分屏；多 pane 时不能只比 'pane-2'。
        if (targetPaneId !== getPrimaryPaneId()) {
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
            layout.splitEnabled = targetPaneId !== getPrimaryPaneId() || hasPopulatedSplitPane();
        }

        if (typeof onTabMoved === 'function' && !reconciliation.movedTabIds.includes(tabId)) {
            onTabMoved({ tabId, sourcePaneId, targetPaneId });
        }

        const finalPaneId = reconciliation.movedTabIds.includes(tabId) ? layout.activePaneId : targetPaneId;
        applyLayoutToDom();
        switchPaneTab(finalPaneId, tabId, { persist: false });
        persistLayout();
        fitWorkspace?.();
    }

    function addTabToPane(tabId, paneId, { activate = true, allowSplit = true, persist = true } = {}) {
        const layout = getLayoutState();
        const resolvedPaneId = paneId || layout.activePaneId || getPrimaryPaneId();
        ensurePaneTabMembership(resolvedPaneId, tabId);
        if (resolvedPaneId !== getPrimaryPaneId() && allowSplit) {
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
        // 收敛后宿主 pane 由规整逻辑决定（写入 layout.activePaneId），不能再写死 'pane-1'。
        let nextActiveTabId = reconciliation.collapsed
            ? getPaneById(getLayoutState().activePaneId).activeTabId
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

    // 把除首个 pane 之外的所有 pane 合入首个 pane，然后关闭分屏。
    // 旧实现只处理 pane-1/pane-2，pane 一多就会漏掉内容。
    function collapseSplit() {
        const layout = getLayoutState();
        const hostPane = getPaneById(getPrimaryPaneId());
        const hostPaneId = hostPane.id;
        let carriedActiveTabId = null;
        const movedTabIds = [];

        layout.panes.forEach(pane => {
            if (pane.id === hostPaneId) return;
            if (pane.activeTabId && pane.tabIds.includes(pane.activeTabId) && !carriedActiveTabId) {
                carriedActiveTabId = pane.activeTabId;
            }
            movedTabIds.push(...pane.tabIds);
            pane.tabIds = [];
            pane.activeTabId = null;
        });

        movedTabIds.forEach(tabId => {
            const tabBtn = document.querySelector(`.main-tab[data-target="${tabId}"]`);
            const tabPane = document.getElementById(tabId);
            getPaneTabsList(hostPaneId)?.appendChild(tabBtn);
            getPaneTabsContent(hostPaneId)?.appendChild(tabPane);
            if (tabBtn) tabBtn.dataset.paneId = hostPaneId;
            if (tabPane) tabPane.dataset.paneId = hostPaneId;
            onTabMoved?.({ tabId, sourcePaneId: layout.activePaneId, targetPaneId: hostPaneId });
        });

        hostPane.tabIds = [...hostPane.tabIds, ...movedTabIds];
        if (!hostPane.tabIds.includes(hostPane.activeTabId) && carriedActiveTabId) {
            hostPane.activeTabId = carriedActiveTabId;
        }
        hostPane.activeTabId = hostPane.activeTabId || hostPane.tabIds[0] || null;
        layout.splitEnabled = false;
        layout.activePaneId = hostPaneId;
        ensurePaneActiveTab(hostPaneId);
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

    // 拖动分界条只调「首个 pane」占比，其余 pane 按现有比例分配剩余空间。
    function setPaneSizes(pane1Ratio, { persist = true } = {}) {
        const layout = getLayoutState();
        const paneIds = getPaneIds();
        const clampedPane1Ratio = Math.min(0.85, Math.max(0.15, Number(pane1Ratio) || 0.5));
        if (paneIds.length <= 2) {
            layout.paneSizes = {
                [paneIds[0]]: clampedPane1Ratio,
                [paneIds[1] || 'pane-2']: 1 - clampedPane1Ratio
            };
        } else {
            const others = paneIds.slice(1);
            const remaining = 1 - clampedPane1Ratio;
            const othersTotal = others.reduce((sum, id) => sum + (Number(layout.paneSizes?.[id]) || 0), 0) || others.length;
            const nextSizes = { [paneIds[0]]: clampedPane1Ratio };
            others.forEach(id => {
                const current = Number(layout.paneSizes?.[id]) || 0;
                nextSizes[id] = current > 0 ? remaining * (current / othersTotal) : remaining / others.length;
            });
            layout.paneSizes = nextSizes;
        }
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
        setPaneSizes,
        ensurePaneElements
    };
}

module.exports = {
    createWorkspaceManager,
    normalizeWorkspaceLayoutShape,
    reconcileEmptyPaneLayout,
    moveWorkspaceTab
};

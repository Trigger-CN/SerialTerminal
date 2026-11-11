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
        // 布局变了就请求渲染。**这是布局层唯一能影响 DOM 的方式**：
        // 它不再直接搬按钮 / 搬面板 / 改 .active —— 那些全部归 renderWorkspace()。
        // 早期这里传的是 resolveTabButtonHost / findTabButton，让布局层反过来问渲染层
        // 「这个按钮该挂哪一行」，于是两边都能写 DOM，出现两套真源。
        onLayoutChanged,
        getWorkspaceRoot,
        getSplitter,
        getPaneElements
    } = options;

    function getLayoutState() {
        return getLayout();
    }

    // 布局层不再需要 workspace root / splitter / pane 元素集合：它们全部是
    // renderWorkspace() 的职责范围（按 plan 建列建行）。保留这三个注入点会让
    // 布局层又具备写 DOM 的能力，因此不再消费。

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

    // 「这个标签能不能渲染」只看**模型**：它是不是一个在 workspace 里存在的节点。
    //
    // 早期这里查 DOM（按钮在不在 pane 里、面板在不在 pane 里），于是布局层反过来
    // 依赖渲染结果：渲染层一旦把 Shell 的按钮搬到分组行，布局层就判它不可渲染并把
    // 它从 tabIds 里 prune 掉，标签彻底消失。现在渲染层怎么摆都不会改变模型的成员资格。
    function hasRenderableTab(paneId, tabId) {
        return Boolean(tabId);
    }

    function findFirstRenderableTabId(paneId) {
        const pane = getPaneById(paneId);
        return pane.tabIds[0] || null;
    }

    function prunePaneTabIds(paneId) {
        // 成员资格不在这里修剪：空 pane 由 reconcileEmptyPanes 统一收敛。
    }

    function ensurePaneActiveTab(paneId) {
        const pane = getPaneById(paneId);
        if (!pane.tabIds.length) {
            pane.activeTabId = null;
            return;
        }
        if (!pane.activeTabId || !pane.tabIds.includes(pane.activeTabId)) {
            pane.activeTabId = pane.tabIds[0] || null;
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
        //
        // DOM 成动静交给渲染层：这里只把「哪个标签从哪个 pane 搬到了哪个 pane」
        // 这个事实报给上层（onTabMoved 负责写回 tabState.paneId / 持久化）。
        const hostPaneId = layout.activePaneId || getPrimaryPaneId();
        result.movedTabIds.forEach(tabId => {
            const sourcePaneId = [...tabsBefore.entries()]
                .find(([paneId, tabIds]) => paneId !== hostPaneId && tabIds.includes(tabId))?.[0] || hostPaneId;
            onTabMoved?.({ tabId, sourcePaneId, targetPaneId: hostPaneId });
        });
        return result;
    }

    function setActivePane(paneId, { persist = true } = {}) {
        const layout = getLayoutState();
        const paneIds = getPaneIds();
        const nextPaneId = paneIds.includes(paneId) ? paneId : (paneIds[0] || 'pane-1');
        // **值没变就不要请求渲染**：本函数由 pane 的 mousedown 调用，而一次
        // renderWorkspace 会重排标签按钮、搬动面板节点。按下时把被点的那个按钮
        // 或它的祖先换掉，浏览器会判定「按下与抬起不在同一节点」，整次点击**不合成
        // click**，表现为「标签点了没反应」。实测 diag1157/1158/1163：三角色事件
        // 里只有 pointerdown / mousedown / mouseup，没有 click；在 capture 阶段
        // 拦掉这一次 mousedown 后 click 立刻恢复。激活 pane 没变时渲染结果也不会变，
        // 跳过是等价的。
        if (layout.activePaneId === nextPaneId) return;
        layout.activePaneId = nextPaneId;
        // 当前 pane 的视觉高亮（只影响边框）交给渲染层统一下发，这里不再自己 toggle。
        if (persist) {
            persistLayout();
        }
        onLayoutChanged?.();
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

    // 布局层不再直接写 DOM：pane 的显隐 / 尺寸 / 按钮顺序 / 面板归属全部由
    // renderWorkspace() 按 buildRenderPlan() 收敛。这里不再保留「自己再算一遍」的实现，
    // 否则就回到两套真源的老路。

    // 布局落地：只把"缺的 pane 节点建出来"，然后请求渲染。
    //
    // **这里不再搬按钮、搬面板、改 .active。** 那些职责全部归 renderWorkspace()。
    // 早期本函数同时做三件事（pane 内按钮排序 / 面板搬移 / active 互斥），并通过
    // findTabButton / resolveTabButtonHost 反向询问渲染层，于是"布局"与"渲染"
    // 两边都能写 DOM，形成第二套真源——这正是本次重构要消除的东西。
    function applyLayoutToDom() {
        ensurePaneElements();
        const layout = getLayoutState();
        // 先收敛空 pane：这是布局落地的一部分（只改模型，不碰 DOM）。
        // 少了它，「两个 pane 但第二个是空的」这种布局会一直停在 splitEnabled=true，
        // 渲染层就会画出一个没有标签的空列。
        reconcileEmptyPanes();
        ensurePaneActiveTab(getLayoutState().activePaneId || getPrimaryPaneId());
        onLayoutChanged?.();
    }

    // 只改布局状态，不碰 DOM：切完通知一次，由渲染层决定谁亮。
    function applyActiveTabToPane() {
        onLayoutChanged?.();
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

    // 只改布局：把标签从源 pane 移到目标 pane，并让两边 activeTabId 一致。
    // DOM 搬移由渲染层按新的 rows 完成。
    function moveTabToPane(tabId, targetPaneId, { preserveSplit = false, insertionIndex = null } = {}) {
        const layout = getLayoutState();
        const sourcePaneId = getPaneIdForTabId(tabId);
        const targetPane = getPaneById(targetPaneId);
        if (!targetPane) return;
        const sourcePane = getPaneById(sourcePaneId);

        // 目标 pane 不是首个 pane 就一定需要分屏；多 pane 时不能只比 'pane-2'。
        if (targetPaneId !== getPrimaryPaneId()) {
            layout.splitEnabled = true;
        }

        // moveWorkspaceTab 只改「源 pane 里确实有它」的归属。布局里找不到归属时补登一次，
        // 否则 activeTabId 会被写成不在 tabIds 里的值（违反 I6），且后续 prune/reconcile
        // 都只读 tabIds，修不回来。
        const moved = moveWorkspaceTab(layout, tabId, targetPaneId, insertionIndex);
        if (!moved) ensurePaneTabMembership(targetPaneId, tabId);
        ensurePaneActiveTab(sourcePaneId);
        targetPane.activeTabId = tabId;

        const reconciliation = reconcileEmptyPanes();
        if (!reconciliation.collapsed && !preserveSplit) {
            layout.splitEnabled = targetPaneId !== getPrimaryPaneId() || hasPopulatedSplitPane();
        }

        if (typeof onTabMoved === 'function' && !reconciliation.movedTabIds.includes(tabId)) {
            onTabMoved({ tabId, sourcePaneId, targetPaneId });
        }

        applyLayoutToDom();
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
    // 只改布局；DOM 由渲染层按新的布局重排（它会把按钮与面板一起搬到新宿主）。
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
        // 尺寸变化后需重新渲染（写 flex-basis）并重新 fit。
        onLayoutChanged?.();
        fitWorkspace?.();
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

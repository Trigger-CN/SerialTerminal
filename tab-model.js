'use strict';

// 标签树模型：TAB_ARCHITECTURE.md 的 S1 实现。
//
// 这一层只做「数据 + 派生」，不碰 DOM、不碰 Electron、不碰串口。它唯一的职责是：
//   1. 维护唯一真源 { tabs, focusedTabId, split }；
//   2. 由真源派生出渲染所需的全部信息（列、行、TabRow 项、可见面板）；
//   3. 为所有交互提供唯一写入口，并在写入后维持 I1–I10。
//
// 设计要点（对应文档章节）：
//   §1.2 容器判据是结构性的：有 panes 就是容器，不看 kind；
//   §2.6 焦点是模型状态，只有 focusedTabId 一个字段；
//   §3.2 扁平 + 存在容器时，容器与其余根级 Tab 构成「根族」；
//   §3.3 列一次性算清（列 id / 容器 id / 是否族列 / TabRow 项）；
//   §8.2 拖拽只支持同一行内重排。

const DEFAULT_PANE_ID = 'pane-1';
const MAX_DEPTH = 32;

// ---------------------------------------------------------------------------
// 基础查找
// ---------------------------------------------------------------------------

function isContainer(tab) {
    return Boolean(tab) && typeof tab === 'object' && Array.isArray(tab.panes);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
}

function tabOf(ws, id) {
    return hasOwn(ws.tabs, id) ? ws.tabs[id] : null;
}

function roots(ws) {
    return Object.values(ws.tabs)
        .filter(tab => tab.parentId === null)
        .sort((a, b) => a.order - b.order);
}

function rootOf(ws, tab) {
    let cur = tab;
    let guard = 0;
    while (cur && cur.parentId !== null && guard++ < MAX_DEPTH) {
        cur = tabOf(ws, cur.parentId);
    }
    return cur || tab || null;
}

// 返回真实 pane 数组；绝不返回伪造对象（伪造对象写进去会随下次渲染静默丢失）。
function panesOf(container) {
    return isContainer(container) ? container.panes : [];
}

function childrenOf(ws, container) {
    const out = [];
    for (const pane of panesOf(container)) {
        for (const id of pane.tabIds) {
            const tab = tabOf(ws, id);
            if (tab) out.push(tab);
        }
    }
    return out;
}

function paneOfTab(ws, tab) {
    if (!tab || !tab.parentId) return null;
    const container = tabOf(ws, tab.parentId);
    if (!isContainer(container)) return null;
    for (const pane of panesOf(container)) {
        if (pane.tabIds.includes(tab.id)) return { container, pane };
    }
    return null;
}

function containerIds(ws) {
    return Object.keys(ws.tabs).filter(id => isContainer(ws.tabs[id]));
}

// ---------------------------------------------------------------------------
// 扁平模式与根族
// ---------------------------------------------------------------------------

function isFlat(ws) {
    return containerIds(ws).length <= 1;
}

// 扁平且存在容器时，容器与其余全部根级 Tab 共用一个内容区。
// 这是修掉「焦点落在 shell 上时 TabRow 只剩 shell」的那个死角。
function rootFamilyOf(ws) {
    if (!isFlat(ws)) return null;
    const members = roots(ws);
    const container = members.find(isContainer);
    if (!container) return null;
    return { container, members };
}

function inFamily(ws, tab) {
    const fam = rootFamilyOf(ws);
    if (!fam || !tab) return false;
    if (tab.parentId === null) return fam.members.some(t => t.id === tab.id);
    return tab.parentId === fam.container.id;
}

// ---------------------------------------------------------------------------
// 布局派生
// ---------------------------------------------------------------------------

// 第一维：列。每列自带 TabRow 项，渲染层不需要再组合。
//
// 两种形态（对应文档 §5.2）：
//   分屏        每个根级 Tab 一列，TabRow 只有它自己
//   未分屏      只有一列：**所有根级 Tab 共用一条 TabRow**
//
// 未分屏时不能「每个分组各一列」：那会让每个分组列各自渲染一条 TabRow，
// 又回到 #serial-group-tab-bar 的借位老路。也不能只列「焦点所在的那一个根」：
// TabRow 就是一级标签栏，其余分组标签会从界面上整体消失。
//
// isFamily 仅表示「扁平：容器不渲染为标签，展开成它的子项」（§5.2）。
// 多容器时 TabRow 装的是**分组标签本身**，子项落到各自的 subRow。
// 扁平时还分两种：未开 pane 分屏 → 子项全部上一级行（没有 subRow）；
// 开了 pane 分屏 → 子项各自落到自己那条 subRow，一级行只留根级叶。
function layoutColumns(ws) {
    if (ws.split.enabled) {
        return roots(ws).map(tab => ({
            id: tab.id,
            containerId: isContainer(tab) ? tab.id : null,
            isFamily: false,
            tabItems: [tab]
        }));
    }

    const members = roots(ws);
    if (!members.length) return [];

    const flat = isFlat(ws);
    // 扁平 + 组内 pane 分屏（方案 A）不能把容器子项再列进一级行：
    // 它们已经各自躺在 pane 的 subRow 里，再列一次就是同一个标签在两处可见，
    // 用户点哪一处都只是「一半正确」（另一处仍亮着/仍占位）。
    const flatContainer = flat ? members.find(isContainer) : null;
    const flatPanesSplit = Boolean(flatContainer
        && flatContainer.paneSplit
        && flatContainer.paneSplit.enabled);
    const tabItems = flat
        ? (flatPanesSplit
            ? members.filter(tab => !isContainer(tab))
            : members.flatMap(tab => (isContainer(tab) ? childrenOf(ws, tab) : [tab])))
        : members.slice();

    const focusedRoot = ws.focusedTabId ? rootOf(ws, tabOf(ws, ws.focusedTabId)) : null;
    return [{
        id: members[0].id,
        containerId: isContainer(focusedRoot) ? focusedRoot.id : null,
        isFamily: flat,
        tabItems
    }];
}

// 第二维：行（subRow）。
//
// 扁平模式（isFamily）下容器不拥有独立行（方案 A）：未开 pane 分屏时为零条，
// 开了 pane 分屏时按 pane 数展开——否则 pane-2 的标签无处可点（I9）。
function layoutRowsOf(ws, column) {
    if (!column.containerId) return [];
    const container = tabOf(ws, column.containerId);
    if (!isContainer(container)) return [];
    const panes = panesOf(container);
    const splitEnabled = Boolean(container.paneSplit && container.paneSplit.enabled);
    if (column.isFamily) return splitEnabled ? panes.slice() : [];
    return splitEnabled ? panes.slice() : panes.slice(0, 1);
}

// 某列实际显示哪些面板。四个分支，分别对应四种布局形态：
//   有 subRow 且多于一条（分屏 + 列内 paneSplit）→ 每个 pane 显示自己的 activeTabId；
//   未分屏 → 整列一个内容区，跟焦点（可以是容器里的叶，也可以是未归属的 Shell）；
//   分屏后的根级叶列 → 显示这一列自己（Shell 独立列）；
//   分屏后的普通列 → 显示该容器自己的激活叶，不看焦点。
//
// 最后一支不能套用焦点：分屏时其它列也要各自显示内容，而焦点只有一个。
function visiblePanelIdsOfColumn(ws, column) {
    const rows = layoutRowsOf(ws, column);
    if (rows.length > 1) return rows.map(pane => pane.activeTabId).filter(Boolean);

    // 未分屏时整列只有一个内容区，而内容区跟的是**焦点**：焦点可能落在容器里的
    // 某个叶，也可能落在一个未归属的 Shell 上（它不属于任何 pane，但住同一个
    // 内容区）。两个形态都必须有分支，否则焦点落在 Shell 上时这里返回空集，
    // 而页面仍显示 Shell 面板——模型就会与实际显示不一致。
    if (ws.split.enabled === false) {
        const focused = tabOf(ws, ws.focusedTabId);
        if (focused && !isContainer(focused)) return [focused.id];
        if (focused && isContainer(focused)) {
            // 焦点是容器本身（用户点的是分组标签）时取该容器自己的激活叶。
            const pane = panesOf(focused)[0];
            if (pane && pane.activeTabId) return [pane.activeTabId];
        }
    }

    // 分屏时每一列对应一个根级 Tab。containerId 为 null 表示这一列本身就是一个
    // 根级叶（典型是未归属的 Shell 独立列）：它没有 pane、没有 subRow，内容区
    // 显示的就是它自己。
    //
    // 不分屏时不能走这一支：那时 column.id 恒为 members[0].id，与焦点所在的叶
    // 无关，用它顶替会让整列显示错的标签。
    if (ws.split.enabled && !column.containerId) return tabOf(ws, column.id) ? [column.id] : [];

    if (column.containerId) {
        const pane = panesOf(tabOf(ws, column.containerId))[0];
        if (pane && pane.activeTabId) return [pane.activeTabId];
    }

    return rows.length ? [rows[0].activeTabId].filter(Boolean) : [];
}

function visiblePanels(ws) {
    const out = new Set();
    for (const column of layoutColumns(ws)) {
        for (const id of visiblePanelIdsOfColumn(ws, column)) {
            if (tabOf(ws, id)) out.add(id);
        }
    }
    return out;
}

// 渲染层的唯一输入。
function buildRenderPlan(ws) {
    const cols = layoutColumns(ws);
    return {
        columns: cols.map(column => {
            const container = column.containerId ? tabOf(ws, column.containerId) : null;
            const rows = layoutRowsOf(ws, column);
            return {
                columnId: column.id,
                containerId: column.containerId,
                isFamily: column.isFamily,
                tabItems: column.tabItems,
                collapsed: container ? container.collapsed === true : false,
                rows: rows.map(pane => ({
                    paneId: pane.id,
                    tabs: pane.tabIds.map(id => tabOf(ws, id)).filter(Boolean),
                    activeTabId: pane.activeTabId
                })),
                panelIds: visiblePanelIdsOfColumn(ws, column)
            };
        }),
        panelIds: [...visiblePanels(ws)],
        subRowTabIds: cols.flatMap(column =>
            layoutRowsOf(ws, column).flatMap(pane => pane.tabIds.slice())
        )
    };
}

// 把 workspace 加工一份供验收器检查：带上只读判据，不污染真源。
function withDiagnostics(ws) {
    return Object.assign(Object.create(null), ws, {
        visiblePanels: () => visiblePanels(ws)
    });
}

// ---------------------------------------------------------------------------
// 写入：索引重建
// ---------------------------------------------------------------------------

// parentId 是派生缓存：先清空非容器，再按 panes 重建。
// 容器永远在根级——容器套容器会让「列」失去意义，本模型不支持。
function rebuildIndex(ws) {
    for (const tab of Object.values(ws.tabs)) {
        if (!isContainer(tab)) tab.parentId = null;
    }
    for (const tab of Object.values(ws.tabs)) {
        if (!isContainer(tab)) continue;
        tab.parentId = null;
        for (const pane of tab.panes) {
            for (const id of pane.tabIds) {
                const child = ws.tabs[id];
                if (child && !isContainer(child)) child.parentId = tab.id;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

let idSeq = 0;
function nextId(prefix) {
    idSeq += 1;
    return `${prefix}-${idSeq}`;
}

function resetIdSeq() {
    idSeq = 0;
}

function createLeaf(kind, extra) {
    const options = extra || {};
    const id = options.id || nextId(kind);
    return Object.assign({ id, kind, parentId: null, order: 0, panel: { id } }, options);
}

// 造容器及其首个子叶。返回成对结果，避免把临时字段写进数据模型。
function buildContainer(options) {
    const opts = options || {};
    const id = opts.id || nextId('grp');
    const main = createLeaf('main', opts.mainId ? { id: opts.mainId } : undefined);
    const container = {
        id,
        kind: opts.kind || 'group',
        groupId: opts.groupId || id,
        parentId: null,
        order: typeof opts.order === 'number' ? opts.order : 0,
        title: opts.title || id,
        collapsed: false,
        paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
        panes: [{
            id: opts.paneId || `${id}-${DEFAULT_PANE_ID}`,
            tabIds: [main.id],
            activeTabId: main.id
        }]
    };
    return { container, main };
}

function rootOrder(ws) {
    return roots(ws).length;
}

// 默认工作区：一个串口组（含 main），没有 shell。
function createWorkspace(options) {
    const opts = options || {};
    const built = buildContainer({ id: opts.containerId || 'grp-default', groupId: 'default' });
    const ws = {
        tabs: { [built.container.id]: built.container, [built.main.id]: built.main },
        focusedTabId: built.main.id,
        split: { enabled: false, orientation: 'horizontal', sizes: {} }
    };
    rebuildIndex(ws);
    return ws;
}

function addShell(ws) {
    const shell = createLeaf('shell');
    shell.order = rootOrder(ws);
    ws.tabs[shell.id] = shell;
    return shell;
}

function addContainerTab(ws, options) {
    const opts = Object.assign({ order: rootOrder(ws) }, options || {});
    const built = buildContainer(opts);
    ws.tabs[built.container.id] = built.container;
    ws.tabs[built.main.id] = built.main;
    rebuildIndex(ws);
    return built.container;
}

// 新建叶落到焦点所在的 pane；焦点不在 pane 内时取焦点所在容器的第一个 pane。
function targetPaneOf(ws, containerId) {
    const focused = tabOf(ws, ws.focusedTabId);
    if (focused) {
        const hit = paneOfTab(ws, focused);
        if (hit && (!containerId || hit.container.id === containerId)) return hit;
        const rootTab = rootOf(ws, focused);
        if (isContainer(rootTab) && (!containerId || rootTab.id === containerId)) {
            return { container: rootTab, pane: panesOf(rootTab)[0] };
        }
    }
    const target = containerId ? tabOf(ws, containerId) : roots(ws).find(isContainer);
    if (!isContainer(target)) return null;
    const pane = panesOf(target)[0];
    return pane ? { container: target, pane } : null;
}

function addLeaf(ws, kind, containerId) {
    const hit = targetPaneOf(ws, containerId);
    if (!hit || !hit.pane) return null;
    const leaf = createLeaf(kind);
    ws.tabs[leaf.id] = leaf;
    hit.pane.tabIds.push(leaf.id);
    hit.pane.activeTabId = leaf.id;
    ws.focusedTabId = leaf.id;
    rebuildIndex(ws);
    return leaf;
}

function addPane(ws, containerId) {
    const container = tabOf(ws, containerId);
    if (!isContainer(container)) return null;
    const leaf = createLeaf('main');
    ws.tabs[leaf.id] = leaf;
    const pane = {
        id: `${container.id}-pane-${container.panes.length + 1}`,
        tabIds: [leaf.id],
        activeTabId: leaf.id
    };
    container.panes.push(pane);
    rebuildIndex(ws);
    return pane;
}

// ---------------------------------------------------------------------------
// 交互
// ---------------------------------------------------------------------------

function activateTab(ws, tabId) {
    const tab = tabOf(ws, tabId);
    if (!tab) return false;
    ws.focusedTabId = tab.id;
    const hit = paneOfTab(ws, tab);
    if (hit) {
        hit.pane.activeTabId = tab.id;
    } else if (isContainer(tab)) {
        for (const pane of panesOf(tab)) {
            if (!pane.activeTabId && pane.tabIds.length) pane.activeTabId = pane.tabIds[0];
        }
    }
    return true;
}

// scope: { kind: 'roots' } | { kind: 'pane', containerId, paneId }
function reorderInRow(ws, scope, tabId, targetIndex) {
    const moving = tabOf(ws, tabId);
    if (!scope || !moving) return false;

    if (scope.kind === 'roots') {
        if (moving.parentId !== null) return false;      // 只允许根级之间重排
        const list = roots(ws).filter(tab => tab.id !== tabId);
        const at = Math.max(0, Math.min(targetIndex | 0, list.length));
        list.splice(at, 0, moving);
        list.forEach((tab, index) => { tab.order = index; });
        return true;
    }

    const container = tabOf(ws, scope.containerId);
    if (!isContainer(container)) return false;
    const pane = panesOf(container).find(item => item.id === scope.paneId);
    if (!pane) return false;
    const from = pane.tabIds.indexOf(tabId);
    if (from < 0) return false;                          // 不允许跨 pane 拖动
    pane.tabIds.splice(from, 1);
    const at = Math.max(0, Math.min(targetIndex | 0, pane.tabIds.length));
    pane.tabIds.splice(at, 0, tabId);
    return true;
}

function setColumnSplit(ws, enabled, orientation) {
    ws.split.enabled = Boolean(enabled);
    if (orientation) ws.split.orientation = orientation;
    if (!ws.split.enabled) ws.split.sizes = {};
    return true;
}

function setPaneSplit(ws, containerId, enabled, orientation) {
    const container = tabOf(ws, containerId);
    if (!isContainer(container)) return false;
    const on = Boolean(enabled);
    if (on && container.panes.length < 2) addPane(ws, containerId);
    container.paneSplit.enabled = on;
    if (orientation) container.paneSplit.orientation = orientation;
    if (!on) {
        container.collapsed = false;
        container.paneSplit.sizes = {};
    }
    return true;
}

function setCollapsed(ws, containerId, collapsed) {
    const container = tabOf(ws, containerId);
    if (!isContainer(container)) return false;
    if (collapsed) {
        const rows = container.paneSplit.enabled ? container.panes.length : 1;
        if (rows < 2) return false;                      // I10
    }
    container.collapsed = Boolean(collapsed);
    return true;
}

// ---------------------------------------------------------------------------
// 关闭
// ---------------------------------------------------------------------------

function fallbackFocus(ws) {
    const firstContainer = roots(ws).find(isContainer);
    if (firstContainer && firstContainer.panes[0] && firstContainer.panes[0].activeTabId) {
        return firstContainer.panes[0].activeTabId;
    }
    const firstRoot = roots(ws)[0];
    if (firstRoot) return firstRoot.id;
    const any = Object.values(ws.tabs)[0];
    return any ? any.id : null;
}

function ensurePaneHasLeaf(ws, pane) {
    if (pane.tabIds.length) return;
    const leaf = createLeaf('main');
    ws.tabs[leaf.id] = leaf;
    pane.tabIds.push(leaf.id);
    pane.activeTabId = leaf.id;
}

function closeTab(ws, tabId) {
    const tab = tabOf(ws, tabId);
    if (!tab) return false;

    if (isContainer(tab)) {
        const doomed = [tab.id, ...childrenOf(ws, tab).map(child => child.id)];
        const focusLost = doomed.includes(ws.focusedTabId);
        for (const id of doomed) delete ws.tabs[id];
        if (focusLost) ws.focusedTabId = fallbackFocus(ws);
        rebuildIndex(ws);
        return true;
    }

    const hit = paneOfTab(ws, tab);
    if (!hit) {
        // 根级叶（例如 shell）
        delete ws.tabs[tab.id];
        if (ws.focusedTabId === tab.id) ws.focusedTabId = fallbackFocus(ws);
        rebuildIndex(ws);
        return true;
    }

    const index = hit.pane.tabIds.indexOf(tab.id);
    hit.pane.tabIds.splice(index, 1);
    delete ws.tabs[tab.id];
    if (hit.pane.activeTabId === tab.id) {
        hit.pane.activeTabId = hit.pane.tabIds[Math.min(index, hit.pane.tabIds.length - 1)] || null;
    }
    ensurePaneHasLeaf(ws, hit.pane);
    if (ws.focusedTabId === tab.id) ws.focusedTabId = hit.pane.activeTabId || hit.container.id;
    rebuildIndex(ws);
    return true;
}

// ---------------------------------------------------------------------------
// 比例归一化（§4.5）
// ---------------------------------------------------------------------------

function normalizeSizes(sizes, ids) {
    const keys = ids.slice();
    const out = {};
    let total = 0;
    for (const id of keys) {
        const value = sizes && Number.isFinite(sizes[id]) && sizes[id] > 0 ? sizes[id] : 1;
        out[id] = value;
        total += value;
    }
    if (!keys.length) return out;
    if (total <= 0) {
        for (const id of keys) out[id] = 1 / keys.length;
        return out;
    }
    for (const id of keys) out[id] = out[id] / total;
    return out;
}

// ---------------------------------------------------------------------------
// 自愈（§6.2）
// ---------------------------------------------------------------------------

function validateAndRepair(ws) {
    const repairs = [];
    if (!ws || !ws.tabs || typeof ws.tabs !== 'object') {
        return { ok: false, fatal: true, repairs: ['tabs 缺失'] };
    }

    for (const tab of Object.values(ws.tabs)) {
        if (!isContainer(tab)) continue;
        if (tab.parentId !== null) {
            tab.parentId = null;
            repairs.push(`容器 ${tab.id} 提到根级`);
        }
        if (!tab.paneSplit || typeof tab.paneSplit !== 'object') {
            tab.paneSplit = { enabled: false, orientation: 'horizontal', sizes: {} };
            repairs.push(`容器 ${tab.id} 补齐 paneSplit`);
        }
    }

    // I1 / I2：shell 混进 pane 就提到根级。
    for (const container of Object.values(ws.tabs)) {
        if (!isContainer(container)) continue;
        for (const pane of container.panes) {
            for (const id of pane.tabIds.slice()) {
                const child = ws.tabs[id];
                if (child && child.kind === 'shell') {
                    pane.tabIds.splice(pane.tabIds.indexOf(id), 1);
                    child.parentId = null;
                    child.order = roots(ws).length;
                    repairs.push(`shell ${id} 从 pane ${pane.id} 提到根级`);
                }
            }
        }
    }

    // I5：空容器补 pane，空 pane 补 main。
    for (const container of Object.values(ws.tabs)) {
        if (!isContainer(container)) continue;
        if (!container.panes.length) {
            const leaf = createLeaf('main');
            ws.tabs[leaf.id] = leaf;
            container.panes.push({
                id: `${container.id}-${DEFAULT_PANE_ID}`,
                tabIds: [leaf.id],
                activeTabId: leaf.id
            });
            repairs.push(`容器 ${container.id} 补齐 pane`);
        }
        for (const pane of container.panes) {
            if (!pane.tabIds || !pane.tabIds.length) {
                if (!pane.tabIds) pane.tabIds = [];
                const leaf = createLeaf('main');
                ws.tabs[leaf.id] = leaf;
                pane.tabIds.push(leaf.id);
                pane.activeTabId = leaf.id;
                repairs.push(`pane ${pane.id} 补齐 main`);
            }
        }
    }

    rebuildIndex(ws);

    // I6：失效的 activeTabId 回落到 pane 内第一个叶。
    for (const container of Object.values(ws.tabs)) {
        if (!isContainer(container)) continue;
        for (const pane of container.panes) {
            if (pane.activeTabId && pane.tabIds.includes(pane.activeTabId)) continue;
            pane.activeTabId = pane.tabIds[0] || null;
            repairs.push(`pane ${pane.id} 的 activeTabId 被重置`);
        }
    }

    // I7：失效的焦点回落。
    if (!hasOwn(ws.tabs, ws.focusedTabId)) {
        ws.focusedTabId = fallbackFocus(ws);
        repairs.push('focusedTabId 被重置');
    }

    // I10：行数不足却已收起，强制展开。
    for (const container of Object.values(ws.tabs)) {
        if (!isContainer(container) || !container.collapsed) continue;
        const rows = container.paneSplit.enabled ? container.panes.length : 1;
        if (rows < 2) {
            container.collapsed = false;
            repairs.push(`容器 ${container.id} 被强制展开`);
        }
    }

    return { ok: true, fatal: false, repairs };
}

module.exports = {
    isContainer,
    hasOwn,
    tabOf,
    roots,
    rootOf,
    panesOf,
    childrenOf,
    paneOfTab,
    containerIds,
    isFlat,
    rootFamilyOf,
    inFamily,
    layoutColumns,
    layoutRowsOf,
    visiblePanelIdsOfColumn,
    visiblePanels,
    buildRenderPlan,
    withDiagnostics,
    rebuildIndex,
    nextId,
    resetIdSeq,
    createLeaf,
    buildContainer,
    createWorkspace,
    addShell,
    addContainerTab,
    addLeaf,
    addPane,
    targetPaneOf,
    activateTab,
    reorderInRow,
    setColumnSplit,
    setPaneSplit,
    setCollapsed,
    closeTab,
    normalizeSizes,
    validateAndRepair
};

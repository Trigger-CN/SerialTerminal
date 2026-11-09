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

// 所有 `columnMode === 'ownColumn'` 的根级叶**共享同一列**的列 id。
//
// 为什么不是「每个叶各一列」：独立列的语义是用户原话「shell 标签页如果独立一组，
// 则该组只显示一行标签栏」——它描述的是一**组**，不是一个标签。渲染层的 DOM
// 契约也只有一个这样的列容器（`serial-group-workspace-__shell__`，其 key 就是
// 这个字符串）。若模型按叶派生多列，翻转后必然出现「模型里有列、DOM 里没有容器」
// 的空列，标签要么消失要么重复。
const OWN_COLUMN_ID = '__shell__';

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
//   分屏        每个容器一列；另外，显式 `ownColumn` 的根级叶各自成一列；
//               其余根级叶不占列，归入它自己指定的那一列
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
//
// **根级叶不自占列（用户裁决）**：分屏只作用于被移动的那个串口组，Shell 维持原位不动。
// Shell 的位置就是它 `columnId` 指向的那一列的列首行（与分组标签同级）。
// **唯一例外是显式拖到分组标签行的叶**（`leafColumnMode === 'ownColumn'`）——
// 不是“分屏就多一列”，而是用户自己要它独立。
function layoutColumns(ws) {
    if (ws.split.enabled) {
        const rank = new Map(roots(ws).map((tab, index) => [tab.id, index]));
        const columns = roots(ws).filter(isContainer).map(container => ({
            id: container.id,
            containerId: container.id,
            isFamily: false,
            tabItems: [container, ...leafItemsOfColumn(ws, container.id)],
            rank: rank.get(container.id) ?? 0
        }));
        // 全部独立叶合成**一列**，而不是每叶一列：独立列是「一组只显示一行标签栏」，
        // 多个 Shell 被拖到分组标签行时它们同住那一行（与渲染层唯一的 Shell 列一致）。
        const own = ownColumnLeaves(ws);
        if (own.length) {
            columns.push({
                id: OWN_COLUMN_ID,
                containerId: null,
                isFamily: false,
                tabItems: own.slice(),
                // 排在它第一个叶的根级位置上，用户拖到中间就不会被挤回最右。
                rank: Math.min(...own.map(leaf => rank.get(leaf.id) ?? 0))
            });
        }
        // 顺序：按根级 order 合并两类列，保证独立列出现在它本该在的位置。
        // 先容器后独立列会让独立列总被挤到最右，用户把它拖到中间后会弹回去。
        return columns
            .sort((a, b) => a.rank - b.rank)
            .map(column => ({
                id: column.id,
                containerId: column.containerId,
                isFamily: column.isFamily,
                tabItems: column.tabItems
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
        // 多分组不扁平：一级行装的是**分组标签**与停在列首行的根级叶。
        // 受托管（hostGroupId）的叶必须排除——它住在那组的下层标签行（layoutRowsOf
        // 会把它并进该列 pane-1 那一条 row），再列进一级行就是同一个标签在两处可点。
        // 扁平单组不在此列：那时一级行**就是** pane-1 的标签行，两者是同一条。
        : members.filter(tab => !leafHostGroup(ws, tab));

    const focusedRoot = ws.focusedTabId ? rootOf(ws, tabOf(ws, ws.focusedTabId)) : null;
    return [{
        id: members[0].id,
        containerId: isContainer(focusedRoot) ? focusedRoot.id : null,
        isFamily: flat,
        tabItems
    }];
}

// 根级叶的**显示形态**：`row`（默认，停在本列列首行）还是 `ownColumn`（自成独立列）。
//
// 这一条是历史上 `tabState.detachedColumn` 的职责。它在渲染层时只是标签对象上的一个
// 布尔值，导致「列集合」这项布局事实被渲染层私有；现在它进模型，列派生只看这里。
//
// 只有根级叶有形态；容器子项返回 `row`（它们由 subRow 管）。
function leafColumnMode(leaf) {
    return leaf && !isContainer(leaf) && leaf.columnMode === 'ownColumn' ? 'ownColumn' : 'row';
}

// 根级叶**挂在哪个容器的下层标签行**上（用户把 Shell 拖进了某个分组）。
//
// 这是历史上 `tabState.ownerGroupId` 的职责。它必须进模型，否则删掉那个字段就等于
// 删掉「Shell 落在该组 subRow」这项能力；而它又不能写成 `panes[].tabIds`——I1/I2
// 明确禁止 Shell 进入 pane。所以它是一条**独立的叶级事实**：指向一个容器的 id，
// 由派生函数把它并进那一列的下层标签行。
//
// 指向已不存在的容器时返回 null（不猜、不回落，让 validateAndRepair 负责修数据）。
function leafHostGroup(ws, leaf) {
    if (!leaf || isContainer(leaf) || leaf.parentId !== null) return null;
    const wanted = typeof leaf.hostGroupId === 'string' ? leaf.hostGroupId : '';
    if (!wanted) return null;
    const container = tabOf(ws, wanted);
    return isContainer(container) ? wanted : null;
}

// 受某个容器托管、因而坐在该列下层标签行里的根级叶。
function hostLeavesOfColumn(ws, columnId) {
    return roots(ws).filter(leaf => !isContainer(leaf)
        && leafHostGroup(ws, leaf) === columnId);
}

// 根级叶**该挂到哪一列**。这是「Shell 停在哪一列」的唯一判据，也是模型里唯一
// 表示该事实的地方——不再靠渲染层记一个 topRowColumnId 反向量子询问。
//
// 五条规则，按优先级：
//   0. 不是根级叶（属于某个 pane 的子项）→ null。它们由 subRow 管，不参与列首行；
//   1. 自成独立列的叶（leafColumnMode === 'ownColumn'）→ 它自己就是一个列 id，不进容器列；
//   2. 被某个容器托管（hostGroupId）→ 就是那一列；
//   3. 显式指定了 columnId 且那一列确实存在 → 用它（用户把 Shell 拖进了某列）；
//   4. 没指定 / 指定的列已被删除 → 落到第一个容器列（位置稳定，不跟着焦点跑）；
//   5. 根本没有容器列 → null（未分屏形态不用它）。
//
// 第 0 条是必需的前置条件：少了它会将 `tab-main-g-1` 这种容器子项也当成「停在 default
// 列的根级叶」，于是 default 列的面板被判成别的分组的标签（实测 verify-tab-plan-strict
// 的 split-panels 就是因此失败的）。
//
// 只看 `columnId` 不看焦点：跟着焦点跑会让「点一下别的分组，Shell 整列搬过去」
// 历史缺陷复活（用户实测报过）。
function resolveLeafColumnId(ws, leaf) {
    if (!leaf || isContainer(leaf) || leaf.parentId !== null) return null;
    if (leafColumnMode(leaf) === 'ownColumn') return OWN_COLUMN_ID;
    const hosted = leafHostGroup(ws, leaf);
    if (hosted) return hosted;
    const containers = roots(ws).filter(isContainer);
    if (!containers.length) return null;
    const wanted = typeof leaf.columnId === 'string' ? leaf.columnId : '';
    if (wanted && containers.some(container => container.id === wanted)) return wanted;
    return containers[0].id;
}

// 某列的列首行上还坐着哪些根级叶（未归属的 Shell）。
//
// 分屏时它们与分组标签同级、不新开列；未分屏时整列共用一条 TabRow，
// 由 layoutColumns() 的另一支自己把叶混排进去，不走这里。
//
// **托管叶要排除**：它住在该列的下层标签行（见 hostLeavesOfColumn），不是列首行。
// 两边都列一次就是同一个标签在两处可点。
function leafItemsOfColumn(ws, columnId) {
    return roots(ws).filter(leaf => !isContainer(leaf)
        && leafColumnMode(leaf) !== 'ownColumn'
        && !leafHostGroup(ws, leaf)
        && resolveLeafColumnId(ws, leaf) === columnId);
}

// 分屏时**自成独立列**的根级叶（用户把它拖到了分组标签行）。
//
// 为什么不并进 `layoutColumns()` 的容器那段：独立列的 id 就是叶自己的 id，没有容器，
// 它的 subRow 为 0 条（layoutRowsOf 对 containerId === null 直接返回空）。
// 这也从根上保证了「未归属 Shell 不因分屏额外占列」：只有显式 ownColumn 的才建。
function ownColumnLeaves(ws) {
    return roots(ws).filter(leaf => !isContainer(leaf)
        && leafColumnMode(leaf) === 'ownColumn');
}

// 第二维：行（subRow）。
//
// 扁平模式（isFamily）下容器不拥有独立行（方案 A）：未开 pane 分屏时为零条，
// 开了 pane 分屏时按 pane 数展开——否则 pane-2 的标签无处可点（I9）。
//
// **受托管根级叶归入本列 pane-1 那条行**：它们不属 `panes[].tabIds`（I2），
// 但按钮与面板确实坐在 pane-1 里，所以渲染层必须能从 rows 里拿到它们——否则
// 翻转后它们将没有任何行可去。不就地修改 pane 对象，返回一份新的行描述。
function layoutRowsOf(ws, column) {
    if (!column.containerId) return [];
    const container = tabOf(ws, column.containerId);
    if (!isContainer(container)) return [];
    const panes = panesOf(container);
    const splitEnabled = Boolean(container.paneSplit && container.paneSplit.enabled);
    const base = column.isFamily
        ? (splitEnabled ? panes.slice() : [])
        : (splitEnabled ? panes.slice() : panes.slice(0, 1));
    const hosted = hostLeavesOfColumn(ws, column.containerId).map(leaf => leaf.id);
    if (!hosted.length || !base.length) return base;
    return base.map((pane, index) => (index === 0
        ? {
            id: pane.id,
            tabIds: [...pane.tabIds, ...hosted],
            activeTabId: pane.activeTabId
        }
        : pane));
}

// 某列实际显示哪些面板。四个分支，分别对应四种布局形态：
//   列内有 submRow 且多于一条（paneSplit）→ 每个 pane 显示自己的 activeTabId；
//   未分屏 → 整列一个内容区，跟焦点（可以是容器里的叶，也可以是未归属的 Shell）；
//   独立列（containerId === null）→ 那一列只有它自己，恒显它；
//   分屏后的容器列 → 根级叶在这列上就显示它（列首行被点中），否则显示该容器激活叶。
//
// 最后一个分支不能套用焦点：分屏时其它列也要各自显示内容，而焦点只有一个。
function visiblePanelIdsOfColumn(ws, column) {
    const rows = layoutRowsOf(ws, column);
    if (rows.length > 1) return rows.map(pane => pane.activeTabId).filter(Boolean);

    // 独立列：这一列只有一行标签栏，住着全部 `ownColumn` 叶。
    // 焦点落在其中某个叶上就显示它；焦点在别处时显示第一个（与渲染层「独立列必须
    // 有一个激活 Shell，否则整列内容区空白」的处理一致）。
    //
    // **`ws.split.enabled` 是必需的前提**：未分屏时 `layoutColumns()` 只能返回一列，
    // 而那一列的 `containerId` 在「焦点落在未归属 Shell」时也是 `null`——不加这个
    // 前提就会把那条唯一列当成独立列，于是点容器里的叶时什么面板也不显（实测失败：
    // `in flat mode the content area follows the focus, including a shell`）。
    if (ws.split.enabled && !column.containerId) {
        const own = column.tabItems.filter(tab => tab && !isContainer(tab));
        const focused = tabOf(ws, ws.focusedTabId);
        if (focused && own.some(tab => tab.id === focused.id)) return [focused.id];
        return own.length ? [own[0].id] : [];
    }

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

    // 分屏后焦点落在某列的根级叶上（用户点了那一列列首行的 Shell）：
    // 那一列的内容区就显示它，而不是容器的 activeTabId。
    // 判据限定「焦点确实是该列的叶」：只看「不属于任何 pane」会对每个容器列都成立，
    // 于是 Shell 的面板会同时出现在所有列上。
    if (ws.split.enabled) {
        const focused = tabOf(ws, ws.focusedTabId);
        if (focused && !isContainer(focused)
            && resolveLeafColumnId(ws, focused) === column.containerId) {
            return [focused.id];
        }
    }

    if (column.containerId) {
        const pane = panesOf(tabOf(ws, column.containerId))[0];
        if (pane && pane.activeTabId) return [pane.activeTabId];
    }

    return rows.length ? [rows[0].activeTabId].filter(Boolean) : [];
}

// 某列**全部可显示的面板**：行里出现的每个标签，一个不多一个不少。
//
// 与 `visiblePanelIdsOfColumn` 的分工：那个回答「此刻该亮哪个」（一列一个），
// 这个回答「哪些面板必须待在这一列的内容区里」。渲染层需要后者——它要先把面板搬进
// 正确的列，再按前者决定加不加 `.active`。两个问题混在一个函数里，就会重蹈
// 「先查 DOM 再回落布局」那种双向询问。
function panelIdsOfColumn(ws, column) {
    const out = [];
    const push = id => {
        if (typeof id === 'string' && tabOf(ws, id) && !out.includes(id)) out.push(id);
    };
    for (const row of layoutRowsOf(ws, column)) {
        for (const id of row.tabIds) push(id);
        push(row.activeTabId);
    }
    // 独立列由叶自己当列，没有行；它的面板就是这一行里的全部叶。
    if (!column.containerId && ws.split.enabled) {
        for (const tab of column.tabItems) if (tab && !isContainer(tab)) push(tab.id);
    }
    return out;
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
                panelIds: visiblePanelIdsOfColumn(ws, column),
                // 这一列的内容区里必须住着哪些面板（含全部行里的标签）。
                // 与 panelIds 的区别：panelIds 是「此刻亮哪个」，这个是「面板住在哪」。
                panelIdsAll: panelIdsOfColumn(ws, column)
            };
        }),
        panelIds: [...visiblePanels(ws)],
        subRowTabIds: cols.flatMap(column =>
            layoutRowsOf(ws, column).flatMap(pane => pane.tabIds.slice())
        )
    };
}

// 某列面板实际所在的**内容区 id**。渲染层搬面板要用它，不能自己拼 id——
// 扁平形态下内容区是静态 `pane-1-tabs-content`，与容器 id 无关。
//
//   有行        第一条行的 paneId（扁平 + paneSplit 时也是它，方案 A 复用一级宿主）
//   独立列      `containerId` 为 null，没有 pane，返回 null，由渲染层落到列自己的内容区
//   无行容器列  pane-1 的内容区（未分屏多容器时内容区仍在 pane-1）
function contentPaneIdOfColumn(ws, column) {
    const rows = layoutRowsOf(ws, column);
    if (rows.length) return rows[0].id;
    if (!column.containerId) return null;
    const container = tabOf(ws, column.containerId);
    const panes = panesOf(container);
    return panes.length ? panes[0].id : null;
}

// 把 workspace 加工一份供验收器检查：带上只读判据，不污染真源。
function withDiagnostics(ws) {
    return Object.assign(Object.create(null), ws, {
        visiblePanels: () => visiblePanels(ws)
    });
}

// ---------------------------------------------------------------------------
// 写入：索引重建
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
    // 新建的 Shell 停在当前焦点所在的那一列（没有容器列时为 null，由 resolveLeafColumnId
    // 回落）。不跟着焦点实时跑：这里只写下创建那一刻的位置，之后用户拖到哪列就改到哪列。
    const focusedRoot = ws.focusedTabId ? rootOf(ws, tabOf(ws, ws.focusedTabId)) : null;
    shell.columnId = isContainer(focusedRoot) ? focusedRoot.id : null;
    shell.columnMode = 'row';
    ws.tabs[shell.id] = shell;
    return shell;
}

// 把根级叶移到指定列（用户在列首行上拖动它，或它那一列被删后的自愈）。
// 这是「Shell 停在哪一列」的**唯一写入口**：其余代码只读 columnId。
// 移回答器列同时消掉独立列形态——归位到某一列的叶不可能同时自成列。
function setLeafColumn(ws, leafId, columnId) {
    const leaf = tabOf(ws, leafId);
    if (!leaf || isContainer(leaf)) return false;
    const containers = roots(ws).filter(isContainer);
    if (!containers.some(container => container.id === columnId)) return false;
    leaf.columnId = columnId;
    leaf.columnMode = 'row';
    return true;
}

// 把根级叶切成「自成独立列」或「停在本列列首行」。
// 这是「是否独立成列」的**唯一写入口**。用户把它拖到分组标签行时置成 `ownColumn`，
// 拖回某列列首行时调 setLeafColumn（自动回 `row`）。
// 非根级叶返回 false：容器子项永远不独立成列。
function setLeafColumnMode(ws, leafId, mode) {
    const leaf = tabOf(ws, leafId);
    if (!leaf || isContainer(leaf) || leaf.parentId !== null) return false;
    leaf.columnMode = mode === 'ownColumn' ? 'ownColumn' : 'row';
    return true;
}

// 把根级叶挂到某个容器的**下层标签行**（用户把它拖进了那个分组），或解除挂靠（传 null）。
//
// 这是「Shell 归属某组」的唯一写入口，也是历史上 `tabState.ownerGroupId` 的替代物。
// 它与 `columnId` 的区别是「住在哪一行」而不是「停在哪一列」：这条叶不进
// `panes[].tabIds`（I2），只靠这个字段被 layoutRowsOf 并进本列 pane-1 那条行。
//
// 传入已不存在的容器 id 时返回 false，不静默写垃圾值（否则要靠自愈才能清掉）。
function setLeafHostGroup(ws, leafId, groupId) {
    const leaf = tabOf(ws, leafId);
    if (!leaf || isContainer(leaf) || leaf.parentId !== null) return false;
    if (groupId === null || groupId === undefined) {
        leaf.hostGroupId = null;
        return true;
    }
    if (typeof groupId !== 'string' || !isContainer(tabOf(ws, groupId))) return false;
    leaf.hostGroupId = groupId;
    // 挂进某个分组的下层行，就不再是独立列——两处同时成立会让同一个标签在两处可点。
    leaf.columnMode = 'row';
    return true;
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

    // 根级叶的 columnId 悬空：它指向的列已被删除（关组），或者干脆不是容器。
    // 不修的话 resolveLeafColumnId 会回落，看似能用；但那意味着真源里存了一个不存在的
    // 列，下次增加一个同名分组时它会酶然命中——写回去才是真的修好。
    // 注意：自成独立列的叶（ownColumn）不用 columnId，它自己就是列 id，跳过。
    const columnIds = roots(ws).filter(isContainer).map(container => container.id);
    for (const leaf of Object.values(ws.tabs)) {
        if (isContainer(leaf) || leaf.parentId !== null) continue;
        if (leafColumnMode(leaf) === 'ownColumn') {
            // 独立列占不到任何容器列：只把悬空的「拖回落点」修正，形态不变。
            if (leaf.columnId && !columnIds.includes(leaf.columnId)) {
                leaf.columnId = columnIds[0] || null;
            }
            continue;
        }
        if (leaf.columnId && columnIds.includes(leaf.columnId)) continue;
        if (leaf.columnId === null || leaf.columnId === undefined) continue;
        leaf.columnId = columnIds[0] || null;
        repairs.push(`叶 ${leaf.id} 的 columnId 被重置`);
    }

    // columnMode 只允许两个值；其他垃圾值当 `row` 处理。不静默保留垃圾值，
    // 否则渲染层会拿一个它不认识的形态去查分支，结果整列不画。
    for (const leaf of Object.values(ws.tabs)) {
        if (isContainer(leaf) || leaf.parentId !== null) continue;
        if (leaf.columnMode === 'row' || leaf.columnMode === 'ownColumn') continue;
        if (leaf.columnMode === undefined || leaf.columnMode === null) {
            leaf.columnMode = 'row';
            continue;
        }
        leaf.columnMode = 'row';
        repairs.push(`叶 ${leaf.id} 的 columnMode 被重置`);
    }

    // hostGroupId 悬空：它指向的容器已被关掉。写回 null 而不是回落到第一个容器列——
    // 「挂靠在某个不存在的组下面」与「停在哪一列」是两件不同的事，后者有 columnId 兜底。
    for (const leaf of Object.values(ws.tabs)) {
        if (isContainer(leaf) || leaf.parentId !== null) continue;
        const wanted = leaf.hostGroupId;
        if (wanted === null || wanted === undefined) continue;
        if (typeof wanted === 'string' && isContainer(tabOf(ws, wanted))) continue;
        leaf.hostGroupId = null;
        repairs.push(`叶 ${leaf.id} 的 hostGroupId 被重置`);
    }

    return { ok: true, fatal: false, repairs };
}

module.exports = {
    OWN_COLUMN_ID,
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
    resolveLeafColumnId,
    leafHostGroup,
    hostLeavesOfColumn,
    setLeafHostGroup,
    panelIdsOfColumn,
    contentPaneIdOfColumn,
    leafItemsOfColumn,
    ownColumnLeaves,
    leafColumnMode,
    setLeafColumn,
    setLeafColumnMode,
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

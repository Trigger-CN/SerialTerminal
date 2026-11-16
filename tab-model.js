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
        if (Array.isArray(ws.split.columns)) {
            const columns = ws.split.columns.map(position => {
                const groups = position.groupIds.map(id => tabOf(ws, id)).filter(isContainer);
                const selected = tabOf(ws, ws.split.activeTabs?.[position.id]);
                const selectedGroup = isContainer(selected) ? selected.id : selected?.parentId;
                const container = groups.find(group => group.id === selectedGroup) || groups[0];
                const leaves = roots(ws).filter(leaf => !isContainer(leaf) && !leafHostGroup(ws, leaf)
                    && leafColumnMode(leaf) !== 'ownColumn'
                    && position.groupIds.includes(resolveLeafColumnId(ws, leaf)));
                return { id: position.id, containerId: container?.id || null, isFamily: false,
                    tabItems: [...groups, ...leaves].sort((a, b) => a.order - b.order) };
            }).filter(column => column.tabItems.length);
            const own = ownColumnLeaves(ws);
            if (own.length) columns.push({ id: OWN_COLUMN_ID, containerId: null, isFamily: false, tabItems: own });
            return columns;
        }
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
            // 开了 pane 分屏时一级行只留根级叶，容器子项由各 pane 的行负责。
            // **受托管叶也要排除**：layoutRowsOf 已把它并进 pane-1 那条行，
            // 两边都列一次就是同一个标签在两处占位（探针实测 shell 重复定位）。
            ? members.filter(tab => !isContainer(tab) && !leafHostGroup(ws, tab))
            : members.flatMap(tab => (isContainer(tab) ? childrenOf(ws, tab) : [tab])))
        // 多分组不扁平：一级行装的是**分组标签**与停在列首行的根级叶。
        // 受托管（hostGroupId）的叶必须排除——它住在那组的下层标签行（layoutRowsOf
        // 会把它并进该列 pane-1 那一条 row），再列进一级行就是同一个标签在两处可点。
        // 扁平单组不在此列：那时一级行**就是** pane-1 的标签行，两者是同一条。
        : members.filter(tab => !leafHostGroup(ws, tab));

    // 这一列内部属于哪个容器，是「行」与「pane 分屏」能否派生的前提。
    //
    // **不能用 `rootOf(focused)` 判**：焦点落在未归属的 Shell 上时，它的根就是它自己，
    // `rootOf` 返回的不是容器，containerId 被写成 null → `layoutRowsOf` 看到空容器返回 0 条
    // → 已开启的 pane 分屏整条不渲染。实测 diag919：containerPaneSplit.enabled=true 而
    // plan.columns[0].splitEnabled=false / rows=[]，用户看到的就是「右键分屏没反应」。
    const focused = ws.focusedTabId ? tabOf(ws, ws.focusedTabId) : null;
    let columnContainerId = null;
    if (focused) {
        if (isContainer(focused)) {
            columnContainerId = focused.id;
        } else if (focused.parentId !== null) {
            // 容器子项：父级就是它所在的容器。
            const owner = tabOf(ws, focused.parentId);
            columnContainerId = isContainer(owner) ? owner.id : null;
        } else {
            // 根级叶：它停在哪一列，那一列的容器就是本列的容器。
            const leafColumn = resolveLeafColumnId(ws, focused);
            const columnOwner = leafColumn ? tabOf(ws, leafColumn) : null;
            columnContainerId = isContainer(columnOwner) ? columnOwner.id : null;
        }
    }
    // 焦点缺失、或焦点所在位置没有容器时，落到第一个容器列：列不能因为没有焦点就
    // 退化成「无容器的叶列」——那会让这一列既没有行、也没有 pane。
    if (!columnContainerId) {
        const firstContainer = members.find(isContainer);
        columnContainerId = isContainer(firstContainer) ? firstContainer.id : null;
    }
    return [{
        id: members[0].id,
        containerId: columnContainerId,
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
// **受托管根级叶按 `hostPaneId` 分派到对应 pane 行**：它们不属 `panes[].tabIds`（I2），
// 但按钮与面板确实坐在某个 pane 里。
//
// 早期实现把它们**无条件全并进 pane-1**，于是 Shell 永远只能待在第一个 pane，
// 无法参与组内 pane 分屏——用户实测报的就是「shell 标签拖不动」。
// 现在按叶自己的 `hostPaneId` 分派；没指定（或指向不存在的 pane）才回落 pane-1，
// 保证旧配置与「刚拖进来还没选 pane」的情形仍然可见。
//
// 不就地修改 pane 对象，返回一份新的行描述。
function layoutRowsOf(ws, column) {
    if (!column.containerId) return [];
    const container = tabOf(ws, column.containerId);
    if (!isContainer(container)) return [];
    const panes = panesOf(container);
    const splitEnabled = Boolean(container.paneSplit && container.paneSplit.enabled);
    const base = column.isFamily
        ? (splitEnabled ? panes.slice() : [])
        : (splitEnabled ? panes.slice() : panes.slice(0, 1));
    const hostedLeaves = hostLeavesOfColumn(ws, column.containerId);
    if (!hostedLeaves.length || !base.length) return base;
    const paneIds = new Set(base.map(pane => pane.id));
    // 按 pane 分组。`hostPaneId` 指向的 pane 不在这批 base 里（关分屏后只剩一条行）时
    // 回落到第一条行，而不是丢掉它——丢掉就是「标签消失」。
    const hostedByPane = new Map(base.map(pane => [pane.id, []]));
    hostedLeaves.forEach(leaf => {
        const wanted = typeof leaf.hostPaneId === 'string' ? leaf.hostPaneId : '';
        const target = wanted && paneIds.has(wanted) ? wanted : base[0].id;
        hostedByPane.get(target).push(leaf.id);
    });
    return base.map(pane => {
        const extra = hostedByPane.get(pane.id) || [];
        if (!extra.length) return pane;
        return {
            id: pane.id,
            tabIds: [...pane.tabIds, ...extra],
            activeTabId: pane.activeTabId
        };
    });
}

// 某个叶是不是本列真正会画出来的标签。
//
// 判据是「行 + 列首行」两侧的并集，不能只看 pane 对象：`panes[].tabIds` 里可能
// 还留着第二个 pane 的标签，而 `paneSplit.enabled` 已经是 false——那些标签不会画在
// 任何一行上，也不会有面板被搬进内容区；反过来扁平未分屏时 `rows` 为空，
// 但整列的标签都在 `tabItems` 里（一级行就是 pane-1 的标签行）。
function isShownInColumn(column, rows, tabId) {
    if (rows.some(row => row.tabIds.includes(tabId))) return true;
    return column.tabItems.some(tab => tab && !isContainer(tab) && tab.id === tabId);
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
    const selected = ws.split.enabled && ws.split.activeTabs
        ? tabOf(ws, ws.split.activeTabs[column.id]) : null;
    if (selected?.parentId === null && !isContainer(selected)
        && column.tabItems.some(tab => tab.id === selected.id)) {
        return rows.length > 1
            ? rows.map((row, index) => index === 0 ? selected.id : row.activeTabId).filter(Boolean)
            : [selected.id];
    }
    if (rows.length > 1) {
        // 每个 pane 都保留自己的激活内容。根级叶（例如多组模式的 Shell）
        // 只能替换它实际占据的这一格；焦点不能把同列其余格的 activeTabId 清掉。
        const focused = tabOf(ws, ws.focusedTabId);
        const focusedRootLeaf = focused && !isContainer(focused) && focused.parentId === null
            ? focused
            : null;
        if (focusedRootLeaf) {
            const rowIndex = rows.findIndex(row => row.tabIds.includes(focusedRootLeaf.id));
            const targetIndex = rowIndex >= 0 ? rowIndex
                : (column.tabItems.some(tab => tab && tab.id === focusedRootLeaf.id) ? 0 : -1);
            if (targetIndex >= 0) {
                return rows
                    .map((row, index) => index === targetIndex ? focusedRootLeaf.id : row.activeTabId)
                    .filter(Boolean);
            }
        }
        return rows.map(pane => pane.activeTabId).filter(Boolean);
    }

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
    //
    // **焦点必须是本列看得见的标签**：`paneSplit.enabled === false` 而布局里还残留着
    // 第二个非空 pane 时（旧配置 / 写入中断），那些叶没有对应的行，直接返回它们会让
    // `panelIds` 包含一个不在 `panelIdsAll` 里的面板——面板被点亮却搬不进任何内容区。
    if (ws.split.enabled === false) {
        const focused = tabOf(ws, ws.focusedTabId);
        if (focused && !isContainer(focused) && isShownInColumn(column, rows, focused.id)) return [focused.id];
        if (focused && isContainer(focused)) {
            // 焦点是容器本身（用户点的是分组标签）时取该容器自己的激活叶。
            const pane = panesOf(focused)[0];
            if (pane && pane.activeTabId) return [pane.activeTabId];
        }
        return rows.length ? [rows[0].activeTabId].filter(Boolean) : [];
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
    // 列首行的叶也住在这**一列**的内容区里：渲染层的 applyVisibility 会先把它们搬进
    // 本列首个 pane 的内容区。它们不在任何 row 里，所以必须单独补上——少了这一段，
    // `panelIdsAll` 就不含本列真正要显示的面板，而 `visiblePanelIdsOfColumn` 又可能
    // 返回它，两个派生量自相矛盾。
    //
    // **不能加 `ws.split.enabled` 前提**：未分屏且焦点落在未归属叶时，唯一那一列的
    // `containerId` 也是 null，加了前提会让它的 panelIdsAll 变成空集。
    for (const tab of column.tabItems) if (tab && !isContainer(tab)) push(tab.id);
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
//
// 这份计划必须**自足**：渲染层不允许再出现 split / paneSplit / isFlat / roots /
// childrenOf / rootFamilyOf。凡是「画在哪、画几行、显哪个」的判断都在这里算完，
// 渲染层只负责比对 DOM 与计划的差异。
function buildRenderPlan(ws) {
    const cols = layoutColumns(ws);
    const containers = roots(ws).filter(isContainer);
    const focused = tabOf(ws, ws.focusedTabId);
    const focusedLeafColumn = focused && !isContainer(focused)
        ? resolveLeafColumnId(ws, focused)
        : null;
    const firstContainerId = containers.length ? containers[0].id : null;
    // 列容器的 DOM key。不能直接用 column.id：
    //   未分屏的非扁平形态只返回一列，它的 id 取 `members[0].id`（可能是个容器 id，
    //   也可能是别的），而真正承载 pane 的是 `containerId` 指向的那个列。
    //   独立列的 id 就是 OWN_COLUMN_ID。
    // 这个映射属于「布局事实」，因此在这里算完，渲染层不再自己推导。
    const domKeyOf = column => {
        if (column.id === OWN_COLUMN_ID) return OWN_COLUMN_ID;
        if (ws.split.enabled && Array.isArray(ws.split.columns)) return column.id;
        if (column.containerId) return column.containerId;
        // 非分屏形态根本没有独立列：焦点落在 `ownColumn` 的叶上时，
        // resolveLeafColumnId 会返回 OWN_COLUMN_ID，直接拿它当 domKey 会凭空造出一列
        // （实测：关分屏后 Shell 列仍在，两个列容器一隐一显）。
        // 那一列真正该是「该叶自己的 columnId」，退一步至少是第一容器列。
        if (focusedLeafColumn === OWN_COLUMN_ID) return firstContainerId || column.id;
        return focusedLeafColumn || firstContainerId || column.id;
    };
    // 列 key 的完整列表（与渲染层同构），用来做比例归一化。
    //
    // `normalizeSizes` 在这里是**唯一**的归一化点：它丢弃表里不存在的键、给缺失列补 1、
    // 再把总和缩到 1。早先这里是裸转发 `ws.split.sizes`，使用端对缺失列回落 `1/N`，
    // 两者叠加就超过 1 —— 四列时第 4 列被挤到容器右侧之外（实测 overflowRight > 0）。
    const domKeys = cols.map(column => domKeyOf(column));
    const layoutSizes = (ws.split && ws.split.enabled && domKeys.length > 1)
        ? normalizeSizes((ws.split && ws.split.sizes) || {}, domKeys)
        : {};
    return {
        columns: cols.map(column => {
            const container = column.containerId ? tabOf(ws, column.containerId) : null;
            const rows = layoutRowsOf(ws, column);
            const paneSplit = container && container.paneSplit ? container.paneSplit : null;
            const domKey = domKeyOf(column);
            return {
                columnId: column.id,
                // 渲染层据此找/建列容器；容器列 = 容器 id，独立列 = OWN_COLUMN_ID。
                domKey,
                containerId: column.containerId,
                isFamily: column.isFamily,
                tabItems: column.tabItems,
                collapsed: container ? container.collapsed === true : false,
                // 「这一列内部要不要分屏」也是渲染层需要的事实：它决定 subRow 数量与
                // 各 pane 的显示，但**判断本身**在模型里已经做完，渲染层只读结果。
                splitEnabled: Boolean(paneSplit && paneSplit.enabled === true),
                orientation: paneSplit && paneSplit.orientation === 'vertical' ? 'vertical' : 'horizontal',
                paneSizes: paneSplit ? { ...(paneSplit.sizes || {}) } : {},
                // 这一列在分组级分屏里的占比（外层容器按它写 flex-basis）。
                //
                // **必须取归一化后的值**：`ws.split.sizes` 可能只覆盖部分列（旧配置、
                // 刚开分屏、或 groupIds 少于屏幕列数）。直接把原始值抛给渲染层，渲染层
                // 对缺失列回落 `1/N`，两侧相加就超过 1，最右列被挤到容器外（实测溢出）。
                // `normalizeSizes` 只补「缺失」与归一，是一门纯函数，不写回 ws。
                size: layoutSizes[domKey] === undefined ? null : layoutSizes[domKey],
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
        // 外层（列级）分屏：方向与占比。渲染层只按它写类名与 flex-basis。
        columnLayout: {
            enabled: Boolean(ws.split && ws.split.enabled === true),
            orientation: ws.split && ws.split.orientation === 'vertical' ? 'vertical' : 'horizontal',
            sizes: layoutSizes
        },
        // 一级 TabRow 是否显示（分组标签行）。只有一个容器时那是纯噪声。
        containerCount: containers.length,
        tabBarVisible: containers.length > 1,
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
//
// 这是「是否独立成列」的**唯一写入口**。用户把它拖到分组标签行时置成 `ownColumn`，
// 拖回某列列首行时调 setLeafColumn（自动回 `row`）。
//
// 与 `setLeafHostGroup` 的互斥必须**两向**都成立：那个函数在挂靠时把 `columnMode`
// 清回 `row`；这里在切成独立列时也必须把 `hostGroupId` 清掉。只清一个方向就会出现
// 「先挂进某组、再拖到分组标签行」把同一叶留在两个位置——独立列被建出来却一个按钮
// 都没有，标签实际仍停在那一组的下层行（实测：`__shell__` 空列）。
//
// 非根级叶返回 false：容器子项永远不独立成列。
function setLeafColumnMode(ws, leafId, mode) {
    const leaf = tabOf(ws, leafId);
    if (!leaf || isContainer(leaf) || leaf.parentId !== null) return false;
    const next = mode === 'ownColumn' ? 'ownColumn' : 'row';
    leaf.columnMode = next;
    if (next === 'ownColumn') leaf.hostGroupId = null;
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
        hit.container.activePaneId = hit.pane.id;
    } else if (isContainer(tab)) {
        for (const pane of panesOf(tab)) {
            if (!pane.activeTabId && pane.tabIds.length) pane.activeTabId = pane.tabIds[0];
        }
    }
    if (ws.split.enabled && Array.isArray(ws.split.columns)) {
        const groupId = isContainer(tab) ? tab.id : tab.parentId || resolveLeafColumnId(ws, tab);
        const position = ws.split.columns.find(column => column.groupIds.includes(groupId));
        if (position) {
            ws.split.activeTabs ||= {};
            ws.split.activeTabs[position.id] = tab.id;
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

function removeEmptyPane(container, pane) {
    if (pane.tabIds.length || container.panes.length <= 1) return false;
    container.panes = container.panes.filter(item => item !== pane);
    if (container.activePaneId === pane.id) container.activePaneId = container.panes[0].id;
    container.paneSplit.sizes = normalizeSizes(container.paneSplit.sizes || {}, container.panes.map(item => item.id));
    if (container.panes.length < 2) {
        container.paneSplit.enabled = false;
        container.collapsed = false;
        container.paneSplit.sizes = {};
    }
    return true;
}

function moveTabToPane(ws, tabId, groupId, paneId, index) {
    const tab = tabOf(ws, tabId);
    const container = tabOf(ws, groupId);
    if (!tab || isContainer(tab) || !isContainer(container)) return false;
    const pane = container.panes.find(item => item.id === paneId);
    if (!pane) return false;
    const groupCount = roots(ws).filter(isContainer).length;
    const source = paneOfTab(ws, tab);
    if (tab.kind === 'shell' && groupCount > 1) return false;
    if (groupCount > 1 && (!source || source.container.id !== container.id)) return false;
    if (!source && groupCount > 1) return false;
    if (source && source.pane === pane) {
        const from = pane.tabIds.indexOf(tabId);
        pane.tabIds.splice(from, 1);
        const at = Math.max(0, Math.min(index | 0, pane.tabIds.length));
        pane.tabIds.splice(at, 0, tabId);
        pane.activeTabId = tabId;
    } else {
        if (source) {
            source.pane.tabIds.splice(source.pane.tabIds.indexOf(tabId), 1);
            if (!source.pane.tabIds.length) {
                if (source.container.panes.length === 1) return false;
                removeEmptyPane(source.container, source.pane);
            } else if (source.pane.activeTabId === tabId) {
                source.pane.activeTabId = source.pane.tabIds[0];
            }
        }
        const at = Math.max(0, Math.min(index | 0, pane.tabIds.length));
        pane.tabIds.splice(at, 0, tabId);
        pane.activeTabId = tabId;
    }
    if (tab.kind === 'shell') {
        tab.hostGroupId = null;
        tab.hostPaneId = null;
        tab.columnMode = 'row';
    }
    ws.focusedTabId = tabId;
    return true;
}

function moveTabToRoots(ws, tabId, columnId, index) {
    const tab = tabOf(ws, tabId);
    if (!tab || isContainer(tab)) return false;
    const containers = roots(ws).filter(isContainer);
    const source = paneOfTab(ws, tab);
    if (containers.length > 1 && tab.kind !== 'shell') return false;
    if (source) {
        if (source.pane.tabIds.length === 1 && source.container.panes.length === 1) return false;
        source.pane.tabIds.splice(source.pane.tabIds.indexOf(tabId), 1);
        if (!source.pane.tabIds.length) removeEmptyPane(source.container, source.pane);
        else if (source.pane.activeTabId === tabId) source.pane.activeTabId = source.pane.tabIds[0];
    }
    tab.hostGroupId = null;
    tab.hostPaneId = null;
    if (tab.kind === 'shell') tab.columnMode = 'row';
    if (columnId === OWN_COLUMN_ID && tab.kind === 'shell') {
        tab.columnMode = 'ownColumn';
    }
    if (typeof columnId === 'string' && containers.some(container => container.id === columnId)) {
        tab.columnId = columnId;
    } else if (containers.length) {
        tab.columnId = containers[0].id;
    }
    const ordered = roots(ws).filter(item => item.id !== tabId);
    const row = ws.split.enabled
        ? layoutColumns(ws).find(column => column.id === columnId
            || column.tabItems.some(item => isContainer(item) && item.id === columnId))?.tabItems.filter(item => item.id !== tabId) || []
        : ordered;
    const localIndex = Math.max(0, Math.min(index | 0, row.length));
    // 拖拽下标来自目标行，不能直接用作包含其他列成员的全局 roots 下标。
    const at = row[localIndex] ? ordered.findIndex(item => item.id === row[localIndex].id)
        : row.length ? ordered.findIndex(item => item.id === row.at(-1).id) + 1 : ordered.length;
    ordered.splice(at, 0, tab);
    ordered.forEach((item, order) => { item.order = order; });
    return true;
}

function moveTab(ws, tabId, target) {
    if (!target || typeof target !== 'object') return false;
    if (target.kind === 'pane') return moveTabToPane(ws, tabId, target.groupId, target.paneId, target.index);
    if (target.kind === 'roots') return moveTabToRoots(ws, tabId, target.columnId, target.index);
    return false;
}

function promoteShellsToRoots(ws, fallbackColumnId) {
    for (const shell of Object.values(ws.tabs)) {
        if (isContainer(shell) || shell.kind !== 'shell' || !shell.hostGroupId) continue;
        shell.hostGroupId = null;
        shell.hostPaneId = null;
        shell.columnMode = 'row';
        if (fallbackColumnId) shell.columnId = fallbackColumnId;
    }
    for (const container of roots(ws).filter(isContainer)) {
        for (const pane of container.panes.slice()) {
            const shells = pane.tabIds.filter(id => tabOf(ws, id)?.kind === 'shell');
            if (!shells.length) continue;
            pane.tabIds = pane.tabIds.filter(id => !shells.includes(id));
            if (!pane.tabIds.length) {
                if (container.panes.length > 1) removeEmptyPane(container, pane);
                else ensurePaneHasLeaf(ws, pane);
            } else if (shells.includes(pane.activeTabId)) {
                pane.activeTabId = pane.tabIds[0];
            }
            for (const id of shells) {
                const shell = tabOf(ws, id);
                shell.hostGroupId = null;
                shell.hostPaneId = null;
                shell.columnMode = 'row';
                if (fallbackColumnId) shell.columnId = fallbackColumnId;
            }
        }
    }
}


function cloneWorkspace(ws) {
    return JSON.parse(JSON.stringify(ws));
}

function assertWorkspaceShape(ws) {
    if (!ws || !ws.tabs || typeof ws.tabs !== 'object' || Array.isArray(ws.tabs)) return '工作区结构无效';
    const ids = new Set();
    const memberships = new Map();
    for (const [id, tab] of Object.entries(ws.tabs)) {
        if (!tab || tab.id !== id || ids.has(id)) return `标签身份无效: ${id}`;
        ids.add(id);
        if (!isContainer(tab)) continue;
        if (!Array.isArray(tab.panes) || !tab.panes.length) return `分组没有 pane: ${id}`;
        for (const pane of tab.panes) {
            if (!pane || !Array.isArray(pane.tabIds) || !pane.tabIds.length) return `pane 为空: ${pane && pane.id}`;
            const local = new Set();
            for (const childId of pane.tabIds) {
                if (local.has(childId) || memberships.has(childId) || !hasOwn(ws.tabs, childId)) {
                    return `标签成员关系无效: ${childId}`;
                }
                local.add(childId);
                memberships.set(childId, id);
            }
            if (!pane.tabIds.includes(pane.activeTabId)) return `pane 激活标签无效: ${pane.id}`;
        }
    }
    for (const tab of Object.values(ws.tabs)) {
        if (isContainer(tab)) continue;
        const parent = memberships.get(tab.id) || null;
        if (tab.parentId !== parent) return `标签父级索引无效: ${tab.id}`;
        if (!tab.panel || tab.panel.id !== tab.id) return `标签面板无效: ${tab.id}`;
    }
    if (!hasOwn(ws.tabs, ws.focusedTabId)) return '焦点标签无效';
    return null;
}

function removeEmptyPaneAfterClose(ws, hit, tabId) {
    hit.pane.tabIds = [];
    delete ws.tabs[tabId];
    removeEmptyPane(hit.container, hit.pane);
    if (ws.focusedTabId === tabId) ws.focusedTabId = fallbackFocus(ws);
}

function applyWorkspaceAction(ws, action) {
    if (!ws || !action || typeof action.type !== 'string') {
        return { ok: false, workspace: ws, reason: '动作无效' };
    }
    const original = ws;
    let next;
    try {
        next = cloneWorkspace(ws);
        const target = action.tabId ? tabOf(next, action.tabId) : null;
        let changed = false;
        switch (action.type) {
            case 'activate':
                changed = activateTab(next, action.tabId);
                break;
            case 'shell-placement': {
                if (!target || target.kind !== 'shell') break;
                const placement = action.placement || {};
                if (placement.paneId) {
                    changed = moveTabToPane(next, target.id, placement.groupId, placement.paneId, placement.index);
                } else {
                    changed = moveTabToRoots(next, target.id, placement.columnId || target.columnId, placement.index);
                    if (changed && placement.columnMode) target.columnMode = placement.columnMode === 'ownColumn' ? 'ownColumn' : 'row';
                }
                break;
            }
            case 'active-pane': {
                const container = tabOf(next, action.groupId);
                if (!isContainer(container) || !container.panes.some(pane => pane.id === action.paneId)) break;
                container.activePaneId = action.paneId;
                changed = true;
                break;
            }
            case 'add-leaf': {
                const options = action.options || {};
                const container = tabOf(next, action.groupId);
                if (!options.id || hasOwn(next.tabs, options.id) || !isContainer(container)) break;
                const pane = container.panes.find(item => item.id === action.paneId) || container.panes[0];
                const leaf = createLeaf(options.kind, { id: options.id, title: options.title || '',
                    ownerGroupId: options.kind === 'shell' ? null : container.id, order: rootOrder(next) });
                next.tabs[leaf.id] = leaf;
                if (leaf.kind !== 'shell' || roots(next).filter(isContainer).length === 1) {
                    pane.tabIds.push(leaf.id);
                    if (action.activate !== false) pane.activeTabId = leaf.id;
                } else {
                    leaf.columnId = container.id;
                    leaf.columnMode = 'row';
                }
                if (action.activate !== false) next.focusedTabId = leaf.id;
                changed = true;
                break;
            }
            case 'close':
                if (!target || isContainer(target) || target.kind === 'main') break;
                {
                    const hit = paneOfTab(next, target);
                    if (hit && hit.pane.tabIds.length === 1 && hit.container.panes.length > 1) {
                        removeEmptyPaneAfterClose(next, hit, target.id);
                        changed = true;
                    } else {
                        changed = closeTab(next, target.id);
                    }
                }
                break;
            case 'move':
                changed = moveTab(next, action.tabId, action.target);
                break;
            case 'split-tab': {
                const container = tabOf(next, action.groupId);
                if (!target || isContainer(target) || !isContainer(container) || !action.paneId) break;
                if (container.panes.some(pane => pane.id === action.paneId)) break;
                const source = paneOfTab(next, target);
                if (roots(next).filter(isContainer).length > 1
                    && (target.kind === 'shell' || source?.container.id !== container.id)) break;
                if (source && source.pane.tabIds.length < 2) break;
                const pane = { id: action.paneId, tabIds: [], activeTabId: null };
                const sourceIndex = source ? container.panes.indexOf(source.pane) : container.panes.length - 1;
                const insertionIndex = action.before === true ? Math.max(0, sourceIndex) : sourceIndex + 1;
                container.panes.splice(insertionIndex, 0, pane);
                changed = moveTabToPane(next, target.id, container.id, pane.id, 0);
                if (!changed) break;
                container.paneSplit.enabled = true;
                container.paneSplit.orientation = action.orientation === 'vertical' ? 'vertical' : 'horizontal';
                container.paneSplit.sizes = normalizeSizes({}, container.panes.map(item => item.id));
                break;
            }
            case 'add-group': {
                const options = action.options || {};
                if (options.id && hasOwn(next.tabs, options.id)) break;
                if (options.mainId && hasOwn(next.tabs, options.mainId)) break;
                const container = addContainerTab(next, options);
                const firstGroupId = roots(next).find(tab => isContainer(tab) && tab.id !== container.id)?.id || null;
                promoteShellsToRoots(next, firstGroupId);
                if (Array.isArray(next.split.columns)) next.split.columns[0]?.groupIds.push(container.id);
                changed = Boolean(container);
                break;
            }
            case 'remove-group': {
                const container = tabOf(next, action.groupId);
                if (!isContainer(container) || container.groupId === 'default' || container.id === 'grp-default') break;
                const remaining = roots(next).filter(tab => isContainer(tab) && tab.id !== container.id);
                if (!remaining.length) break;
                const fallbackColumnId = remaining[0].id;
                for (const leaf of Object.values(next.tabs)) {
                    if (isContainer(leaf) || leaf.kind !== 'shell' || leaf.hostGroupId !== container.id) continue;
                    leaf.hostGroupId = null;
                    leaf.hostPaneId = null;
                    leaf.columnMode = 'row';
                    leaf.columnId = fallbackColumnId;
                }
                changed = closeTab(next, container.id);
                if (Array.isArray(next.split.columns)) {
                    next.split.columns.forEach(column => { column.groupIds = column.groupIds.filter(id => id !== container.id); });
                    next.split.columns = next.split.columns.filter(column => column.groupIds.length);
                    if (remaining.length === 1) setColumnSplit(next, false);
                }
                break;
            }
            case 'split-group': {
                const container = tabOf(next, action.groupId);
                const groups = roots(next).filter(isContainer);
                if (!isContainer(container) || groups.length < 2) break;
                if (!next.split.enabled || !Array.isArray(next.split.columns)) {
                    const base = groups.find(group => group.id !== container.id);
                    next.split.columns = [{ id: base.id, groupIds: groups.map(group => group.id) }];
                    next.split.activeTabs = {};
                }
                const sourceIndex = next.split.columns.findIndex(column => column.groupIds.includes(container.id));
                const source = next.split.columns[sourceIndex];
                if (!source) break;
                if (source.groupIds.length < 2) {
                    if (!action.orientation) break;
                    next.split.orientation = action.orientation === 'vertical' ? 'vertical' : 'horizontal';
                    changed = true;
                    break;
                }
                source.groupIds = source.groupIds.filter(id => id !== container.id);
                if (source.id === container.id) source.id = source.groupIds[0];
                // 未归属叶留在原列，列身份不因被移动组改变。
                for (const leaf of roots(next).filter(tab => !isContainer(tab))) {
                    if (leaf.columnId === container.id) leaf.columnId = source.groupIds[0];
                }
                next.split.columns.splice(sourceIndex + (action.before === true ? 0 : 1), 0,
                    { id: container.id, groupIds: [container.id] });
                next.split.enabled = true;
                next.split.orientation = action.orientation === 'vertical' ? 'vertical' : 'horizontal';
                next.split.sizes = normalizeSizes({}, next.split.columns.map(column => column.id));
                changed = true;
                break;
            }
            case 'column-split':
                changed = setColumnSplit(next, action.enabled, action.orientation);
                if (action.enabled === false) { delete next.split.columns; delete next.split.activeTabs; }
                break;
            case 'pane-split': {
                const container = tabOf(next, action.groupId);
                if (!isContainer(container)) break;
                if (action.enabled === false) {
                    const host = container.panes[0];
                    host.tabIds = container.panes.flatMap(pane => pane.tabIds);
                    if (host.tabIds.includes(next.focusedTabId)) host.activeTabId = next.focusedTabId;
                    container.panes = [host];
                    changed = setPaneSplit(next, action.groupId, false, action.orientation);
                } else {
                    if (container.panes.length < 2) {
                        const source = container.panes[0];
                        if (!source || source.tabIds.length < 2) break;
                        const tabId = source.tabIds.find(id => id !== source.activeTabId) || source.tabIds.at(-1);
                        let ordinal = 2;
                        while (container.panes.some(pane => pane.id === `${container.id}-pane-${ordinal}`)) ordinal++;
                        const pane = { id: `${container.id}-pane-${ordinal}`, tabIds: [], activeTabId: null };
                        container.panes.push(pane);
                        changed = moveTabToPane(next, tabId, container.id, pane.id, 0);
                        if (!changed) break;
                        container.paneSplit.sizes = normalizeSizes({}, container.panes.map(item => item.id));
                    }
                    changed = setPaneSplit(next, action.groupId, true, action.orientation);
                }
                break;
            }
            case 'restore-group-layout': {
                const container = tabOf(next, action.groupId);
                const layout = action.layout;
                if (!isContainer(container) || !Array.isArray(layout?.panes) || !layout.panes.length) break;
                const expected = new Set(container.panes.flatMap(pane => pane.tabIds));
                const actual = layout.panes.flatMap(pane => pane.tabIds || []);
                if (actual.length !== expected.size || new Set(actual).size !== actual.length
                    || actual.some(id => !expected.has(id)) || layout.panes.some(pane => !pane.id || !pane.tabIds?.length)
                    || new Set(layout.panes.map(pane => pane.id)).size !== layout.panes.length) break;
                container.panes = layout.panes.map(pane => ({ id: pane.id, tabIds: pane.tabIds.slice(),
                    activeTabId: pane.tabIds.includes(pane.activeTabId) ? pane.activeTabId : pane.tabIds[0] }));
                container.paneSplit = { enabled: layout.splitEnabled === true && container.panes.length > 1,
                    orientation: layout.orientation === 'vertical' ? 'vertical' : 'horizontal',
                    sizes: normalizeSizes(layout.paneSizes || {}, container.panes.map(pane => pane.id)) };
                if (!container.paneSplit.enabled && container.panes.length > 1) {
                    const first = container.panes[0];
                    first.tabIds = container.panes.flatMap(pane => pane.tabIds);
                    container.panes = [first];
                }
                container.activePaneId = container.panes.some(pane => pane.id === layout.activePaneId)
                    ? layout.activePaneId : container.panes[0].id;
                changed = true;
                break;
            }
            case 'resize-columns': {
                if (!next.split || !next.split.enabled || !action.sizes || typeof action.sizes !== 'object') break;
                const columnIds = layoutColumns(next).map(column => column.id);
                if (columnIds.length < 2) break;
                next.split.sizes = normalizeSizes(action.sizes, columnIds);
                changed = true;
                break;
            }
            case 'resize-panes': {
                const container = tabOf(next, action.groupId);
                if (!isContainer(container) || !container.paneSplit.enabled || !action.sizes || typeof action.sizes !== 'object') break;
                const paneIds = container.panes.map(pane => pane.id);
                if (paneIds.length < 2) break;
                container.paneSplit.sizes = normalizeSizes(action.sizes, paneIds);
                changed = true;
                break;
            }
            case 'collapse-group':
                changed = setCollapsed(next, action.groupId, action.collapsed);
                break;
            default:
                break;
        }
        if (!changed) return { ok: false, workspace: original, reason: `动作被拒绝: ${action.type}` };
        rebuildIndex(next);
        const repaired = validateAndRepair(next);
        if (!repaired.ok || repaired.fatal) {
            return { ok: false, workspace: original, reason: '工作区验证失败' };
        }
        const invalid = assertWorkspaceShape(next);
        if (invalid) return { ok: false, workspace: original, reason: invalid };
        return { ok: true, workspace: next, repairs: repaired.repairs };
    } catch (error) {
        return { ok: false, workspace: original, reason: error && error.message ? error.message : '动作执行失败' };
    }
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

    // 多组模式中 Shell 固定在一级行；单组模式允许 Shell 与其他叶一样进入 pane。
    if (roots(ws).filter(isContainer).length > 1) {
        for (const container of Object.values(ws.tabs)) {
            if (!isContainer(container)) continue;
            for (const pane of container.panes) {
                for (const id of pane.tabIds.slice()) {
                    const child = ws.tabs[id];
                    if (!child || child.kind !== 'shell') continue;
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
    moveTab,
    applyWorkspaceAction,
    normalizeSizes,
    validateAndRepair
};

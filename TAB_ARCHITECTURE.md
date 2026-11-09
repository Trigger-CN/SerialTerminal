# 标签体系架构设计：Tab / TabRow / subRow / tabPanel

> **文档定位**：本文描述标签体系的**目标架构**，不是当前实现的说明。
>
> `MULTI_SERIAL_DESIGN.md` §6A（第 606 行起）描述**当前实现**：两种层数形态、Shell 的三态宿主、`ownerGroupId` / `detachedColumn` / `topRowColumnId` 三个位置字段、`#serial-group-tab-bar` 的单例借位机制。本文描述要替换它的模型。两者是「现状 / 目标」的关系，不是并列规范；按 §11 的 S1–S5 推进期间，以代码实际所处阶段为准。
>
> **三处最容易读错的地方，先说清**：
>
> 1. **`subRow` 不是每列一条，而是每个 pane 一条**。数量 = `paneSplit.enabled ? panes.length : 1`。组内上下分屏时，同一列里同时存在两条 subRow。
> 2. **`tabPanel` 才是显示面板**。「TabRow 是显示面板」是笔误；TabRow 与 subRow 都只是标签栏，只有 tabPanel 承载内容。
> 3. **标签的「位置」不是数据**。Tab 上没有任何「我在第几列／第几行」的字段，全部由 `layoutColumns()` 从 `{ tabs, focusedTabId, split }` 推出。这是本文全部设计的支点。

## 0. 为什么需要重构

现状有三条实测事实（不是推测）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | 同一事实存在 **4 套真源** | ① `groupWorkspaceLayouts`（每组一套 `splitEnabled` / `orientation` / `paneSizes` / `panes[tabIds, activeTabId]`）② `filterTabs` / `chartTabs` / `shellTabs` 三个标签数组 ③ `tabState` 的 `ownerGroupId` + `detachedColumn` + `topRowColumnId` ④ **DOM 本身**：`placeShellTabs()` 用 `getShellTabOwner(tab) === null && tab.detachedColumn === true` 判断「谁进 shell 列」 |
| 2 | 「一层还是两层」的判断 **复制了 8 份** | `renderer.js` 中 `serialGroups.length > 1` 出现在 6 处（1341 / 2386 / 4226 / 4291 / 4419 / 4519），`<= 1` 出现在 2 处（4730 / 4775）。其中 4 处各自独立决定层数，无统一入口 |
| 3 | 描述架构的模块 **没有接线** | `serial-group-tabs.js` 的 `buildTabBarModel()` 已描述三层结构、有 202 行单测，但 `renderer.js` 从未 `require` 它；`pane-layout-dom.js` 在生产代码中同样零引用。两者只在 `test/` 下被引用 |

真源冲突的直接后果：`applyLayoutToDom()` 必须通过注入的 `resolveTabButtonHost(tabId, paneId)`（`renderer.js:4774` 的 `resolveWorkspaceTabButtonHost`）**反向量子询问渲染层**「按钮该挂哪一行」。布局层本该只管 pane 与 `tabIds`，却被迫知道 Shell 的三态宿主。这类反向依赖是标签改动频繁出错的直接来源。

14 条历史标签缺陷按根因归类：

| 类型 | 条数 | 代表 |
|---|---|---|
| A. 真源不唯一 | 7 | `revealSerialGroupActiveTab` 把布局层 `activeTabId` 当真源；`isUnownedShellActiveIn` 只看 DOM；`applyLayoutToDom` 反向量子询问 |
| B. 缺「标签组」实体 | 4 | Shell 三态宿主、`detachedColumn` 模拟层级、`topRowColumnId` 记忆列、`isShellColumnActive` 建列 |
| C. 层数切换当两种实现 | 3 | 单分组保留 pane 行按钮、`singleLayer` 混排、`syncGroupSubRowVisibility` 的清 hidden 分支 |
| D. DOM 搬移当布局手段 | 3 | 切标签闪烁（无条件 `appendChild`）、静态分界条被 remove 后又塞回数组、`syncShellLayoutOwnership` 手工摘登记 |
| E. 纯实现细节 | 4 | `gutterTotal` 用错方向、分界条过宽、三列只有一条、CSS 动画误用 |

A + B + C + D 共 17 处根因在结构层。但这不等于「所有缺陷都是架构造成的」——E 类已在现有结构下稳定修好，并连同 26 项断言固化（`verify-split-geometry` 26/26）。本文的模型同时消除 A、B、C、D 四类。

### 0.1 三条设计判据

本文所有取舍都按这三条衡量，也可用来否决任何后续提案：

| 判据 | 含义 | 反例（现状） |
|---|---|---|
| **系统性** | 每个事实只有一处可写；任何观察值都能从这一处推出 | 4 套真源并存，`applyLayoutToDom` 反向询问渲染层 |
| **可持续** | 新需求只改模型、不动渲染；状态可被断言、可被自愈 | 每加一个特性就往 8 处层数判断里再补一处 |
| **通用** | 新增一种 Tab（叶或容器）不需要改渲染与派生逻辑 | `shell` 因为「不属于任何组」被写成 10 余个特例函数 |

## 1. 四个原语

### 1.1 Tab

一棵树上的节点。**容器与叶共用同一套身份字段，区别只在「有没有 panes」。**

| 字段 | 含义 | 谁写 |
|---|---|---|
| `id` | 全局唯一。`tabPanel` 的 DOM id 由它派生，保证 1:1 | 创建时一次性确定 |
| `kind` | `group` / `main` / `filter` / `chart` / `shell` …（可扩展） | 同上 |
| `parentId` | 父容器 id；`null` 表示根级 | **只由 `rebuildIndex()` 写**，见 §2.3 |
| `order` | **仅根级 Tab**：在 TabRow 中的顺序 | 同栏重排 |
| `panes` | **仅容器**：`[{ id, tabIds[], activeTabId }]` | pane 增删、标签搬迁 |
| `groupId` | 仅与串口组绑定的容器：指向 `serialGroups` | 创建时一次性确定 |

**Tab 内不存「我在第几列」「我的按钮在哪个 DOM 里」。** 位置全部由结构与 `layoutColumns()` 推导。

### 1.2 容器与叶

**判据是结构的，不是枚举的**：

```js
function isContainer(tab) {
  return Array.isArray(tab.panes);
}
```

`kind` 只用于「这个 Tab 指向什么内容」（决定 panel 渲染什么），**不用于决定布局行为**。新增一种容器（例如「工作集合」）时，只要它带 `panes`，渲染与派生逻辑零改动；新增一种叶（例如「波形」）时，只要它不带 `panes`，同样零改动。这是「通用」判据的落地方式。

现状把 `kind === 'group'` 当容器判据写了 8 处以上分支，本文全部替换为 `isContainer()`。

### 1.3 TabRow

一级标签栏。**每列一条**。内容由 `layoutColumns()` 的 `tabItems` 给出（扁平模式下会把族展开，见 §3.3）。

它不是显示面板，不承载任何终端或图表。

### 1.4 subRow

二级标签栏。**属于某个 pane，不属于某列**。可被收起（`collapsed`），收起后该 pane 的标签栏不渲染，但面板继续显示。

### 1.5 tabPanel

与叶 Tab 严格 1:1 的显示区，`panel.id === tab.id`。容器没有 panel。

**Shell 的 panel 就是它的终端容器**，位置是它所在列的内容区（它作为根级 Tab 独占一列）。这与「Shell 绝不进入某个 pane 的 content」不矛盾——后者说的是 pane 内，前者说的是根级列内。§6.1 把这条写成不变式。

### 1.6 组合关系

```
列（column）
├── TabRow            ← tabItems（扁平模式下展开整族）
├── pane[0]
│   ├── subRow        ← 该 pane 的标签（可收起）
│   └── tabPanel      ← 该 pane 的 activeTabId 对应的面板
├── pane[1]（组内分屏时）
│   ├── subRow
│   └── tabPanel
└── ...
```

四个原语之外没有第五个概念。**列不是原语**——它是 `layoutColumns()` 由 `split` 与根族推出的结果。

## 2. 单一真源

### 2.1 三个字段

```js
workspace = {
  tabs: {
    'grp-default': {
      id: 'grp-default', kind: 'group', parentId: null, order: 0,
      groupId: 'default', collapsed: false,
      // 容器专属：组内 pane 分屏（第二级）
      paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
      panes: [
        { id: 'def-p1', tabIds: ['main-default', 'filter-1'], activeTabId: 'main-default' }
      ]
    },
    'main-default': { id: 'main-default', kind: 'main', parentId: 'grp-default' },
    'filter-1':     { id: 'filter-1', kind: 'filter', parentId: 'grp-default' },
    'shell-1':      { id: 'shell-1', kind: 'shell', parentId: null, order: 1 }
  },

  // 唯一焦点：最近一次被用户显式激活的 Tab（叶或根级）
  focusedTabId: 'main-default',

  // 第一级分屏：列
  split: { enabled: false, orientation: 'horizontal', sizes: { 'grp-default': 1 } }
};
```

**整个模型只有三个顶层字段。** 没有 `activeTopTabId`、没有 `activePaneId`、没有「shell 在哪一层」。

> **为什么没有 `activeTopTabId`**：非分屏时「哪一列可见」≡「焦点所在列」，是派生值。它与 `focusedTabId` 同时存在就会出现「焦点在 A 组、可见列是 B 组」这种不可能状态，而历史缺陷 `revealSerialGroupActiveTab` 正是为修复这种不同步而写的。删掉它，这类 bug 在结构上不成立。

### 2.2 字段权威表

| 字段 | 唯一负责的事实 | 写入点 |
|---|---|---|
| `tabs[id].id` / `kind` / `groupId` | 身份与内容类型 | 创建时一次性确定 |
| `tabs[id].parentId` | 属于哪个容器（`null` = 根） | **只由 `rebuildIndex()` 写** |
| `tabs[id].order` | 根级 Tab 之间的顺序 | 同栏重排 |
| `tabs[group].panes[].tabIds` | 组内子 Tab 的**归属与顺序** | 新建 / 关闭 / 同 pane 重排 |
| `tabs[group].panes[].activeTabId` | 该 pane 显示哪个叶 | `activateTab()` |
| `tabs[group].paneSplit` | 组内是否分屏、方向、比例 | 组内分屏按钮、pane 分界条 |
| `tabs[group].collapsed` | 该容器 subRow 是否收起 | 收起按钮 |
| `workspace.focusedTabId` | 当前焦点在哪个 Tab | `activateTab()` |
| `workspace.split` | 列分屏开关、方向、各列比例 | 分屏按钮、列分界条 |

**没有任何字段表示**「这个 Tab 在第几列」「按钮挂在哪个 DOM」「当前是单层还是双层」。三者都是派生量。

### 2.3 `parentId` 是派生缓存

叶 Tab 的父级完全由 `panes[].tabIds` 决定。若两处都能写就会不同步，因此：

- 任何改变归属的操作**只写 `panes`**；
- 写完后调用 `rebuildIndex()` 重算所有非根 Tab 的 `parentId`；
- 其余代码只读 `parentId`，从不直接写。

```js
function rebuildIndex(ws) {
  for (const t of Object.values(ws.tabs)) {
    if (!isContainer(t)) t.parentId = null;    // 先清空，再按 panes 重建
  }
  for (const t of Object.values(ws.tabs)) {
    if (!isContainer(t)) continue;
    for (const pane of t.panes) {
      for (const id of pane.tabIds) {
        const child = ws.tabs[id];
        if (child) child.parentId = t.id;
      }
    }
  }
}
```

### 2.4 为什么是「平铺字典 + parentId」

1. **查找 O(1)**。`tabs[id]` 直接命中；标签查找在主路径上（点击、串口数据回调、快捷键）。嵌套要递归遍历。
2. **持久化就是 `Object.values(tabs)`**，不需要递归序列化。
3. **移动节点的代价是改一个字段**，不存在「摘了一半」的中间态。
4. **根级顺序有 `order` 显式承载**，不依赖遍历顺序。

**有意的不对称**：`order` 只给根级，pane 内顺序用 `tabIds` 下标。理由是两者的稳定性来源不同——根级顺序需要跨 pane、跨分屏保持稳定，而 pane 内顺序总是随 pane 整体移动，下标不会在无关操作中被扰动。这是设计选择，不是遗漏。

代价：求子序列需要遍历全表（O(n)），n 是几十量级，可接受。

### 2.5 旧结构如何落进来

| 旧结构 | 新位置 |
|---|---|
| `groupWorkspaceLayouts` 的 `splitEnabled` / `orientation` / `paneSizes` | 容器的 `paneSplit` |
| 同上的 `panes[{id, tabIds[], activeTabId}]` | 容器的 `panes`（结构一致，直接搬） |
| 同上的 `activePaneId` | **升级为 `workspace.focusedTabId`**（见 §2.6） |
| `filterTabsStore` / `chartTabsStore`（每组一份） | `tabs` 中的节点，`parentId` 指向所属容器 |
| `shellTabs`（全局一份） | `tabs` 中 `parentId === null` 的节点 |
| `tabState.ownerGroupId` / `detachedColumn` / `topRowColumnId` | **已改名**为 `hostGroupId` / `columnMode` / `columnId`（仍保留为浅层 `tabState` 镜像，用于持久化与投影） |
| `SHELL_COLUMN_GROUP_ID` / `shellColumnId()` | **保留**：DOM id 契约要求 Shell 独立列容器 id 逐字不变；模型侧对应 `OWN_COLUMN_ID = '__shell__'` |
| `activeTopTabId`（若存在） | **删除**，由 `focusedTabId` 派生 |

### 2.6 焦点是模型状态，不是渲染状态

第一版设计曾把「焦点 pane」当作渲染层状态排除在模型之外。这是错的，因为焦点有**行为后果**：

- 新建 main / filter / chart 落到哪个 pane；
- 哪个终端接收键盘输入；
- `fit()` 对哪些面板重算尺寸；
- 多 pane 的 TabRow 里，哪一个是「焦点标签」。

若渲染层自存一份焦点，「新建标签」就必须由渲染层决定落点 → 又一套真源。因此焦点进模型，且**只有一个字段** `focusedTabId`，其余全部派生：

| 派生量 | 定义 |
|---|---|
| `focusedTab()` | `tabOf(ws, ws.focusedTabId)` |
| `focusedRootId` | `rootOf(focusedTab()).id` |
| `focusedPane()` | `paneOfTab(focusedTab())`，焦点不在 pane 内时为 `null` |

`focusedTabId` 指向**叶**时焦点 pane 自动是其所在 pane；指向**根级 Tab**（例如点了某个 Shell）时，焦点 pane 为 `null`。两种情形都不需要额外字段。


## 3. 派生量

### 3.1 基础查找

```js
function tabOf(ws, id) {
  return Object.prototype.hasOwnProperty.call(ws.tabs, id) ? ws.tabs[id] : null;
}

function roots(ws) {
  return Object.values(ws.tabs)
    .filter(t => t.parentId === null)
    .sort((a, b) => a.order - b.order);
}

function rootOf(ws, tab) {
  let cur = tab, guard = 0;
  while (cur && cur.parentId !== null && guard++ < 32) {
    cur = tabOf(ws, cur.parentId);
  }
  return cur || tab;
}

// 返回真实 pane 数组，绝不返回伪造对象
function panesOf(container) {
  return Array.isArray(container.panes) ? container.panes : [];
}

function childrenOf(ws, container) {
  const out = [];
  for (const pane of panesOf(container)) {
    for (const id of pane.tabIds) {
      const t = tabOf(ws, id);
      if (t) out.push(t);
    }
  }
  return out;
}

// 该叶所在的 pane 及其容器
function paneOfTab(ws, tab) {
  if (!tab || !tab.parentId) return null;
  const container = tabOf(ws, tab.parentId);
  if (!isContainer(container)) return null;
  for (const pane of panesOf(container)) {
    if (pane.tabIds.includes(tab.id)) return { container, pane };
  }
  return null;
}
```

`panesOf()` 返回空数组而不是 `{ id: 'p-invalid', … }` 这样的占位对象。占位对象会被调用方误当作真实 pane 写进去，写进模型后随下一次渲染丢失，且不报错。

### 3.2 扁平模式与根族

```js
function isFlat(ws) {
  return roots(ws).filter(isContainer).length <= 1;
}

// 扁平且存在容器时，容器与其余全部根级 Tab 属于同一「根族」；否则返回 null
function rootFamilyOf(ws) {
  if (!isFlat(ws)) return null;
  const only = roots(ws).find(isContainer);
  if (!only) return null;
  return { container: only, members: roots(ws) };
}
```

**这个判断只在这一处**，全项目不得再出现 `serialGroups.length > 1` 形式的分支。

根族解决的是一个隐蔽死角。若不引入族，扁平模式下「当前列 = `rootOf(焦点)`」会得到：

| 焦点 | `rootOf` | 若不引入族的结果 |
|---|---|---|
| MAIN（容器的子 Tab） | 容器 | 正确：TabRow 显示全部子项 + Shell |
| **Shell（根级叶）** | **Shell 自己** | **错误：TabRow 只剩 Shell，主／过滤／图表全部消失** |

根因是「扁平模式下容器与其余根级 Tab 实际上共用一个内容区」，单节点上溯表达不了这条关系。

### 3.3 布局列：一次算清「画几列、每列有什么」

```js
function layoutColumns(ws) {
  // 分屏：列集合 = 容器集合 +（若有）一个共享独立列。
  // 根级叶**不占列**，停在其中一列的列首行（§2.3.1）。
  if (ws.split.enabled) {
    const rank = new Map(roots(ws).map((tab, index) => [tab.id, index]));
    const columns = roots(ws).filter(isContainer).map(container => ({
      id: container.id,
      containerId: container.id,
      isFamily: false,
      tabItems: [container, ...leafItemsOfColumn(ws, container.id)],
      rank: rank.get(container.id) ?? 0
    }));
    // 全部 ownColumn 叶合成**一个**列：独立列是「一组只显示一行标签栏」，
    // 不是「每叶一列」。它与渲染层唯一的 Shell 列容器一一对应。
    const own = ownColumnLeaves(ws);
    if (own.length) {
      columns.push({
        id: OWN_COLUMN_ID,          // '__shell__'
        containerId: null,
        isFamily: false,
        tabItems: own.slice(),
        rank: Math.min(...own.map(leaf => rank.get(leaf.id) ?? 0))
      });
    }
    return columns
      .sort((a, b) => a.rank - b.rank)
      .map(column => ({
        id: column.id,
        containerId: column.containerId,
        isFamily: column.isFamily,
        tabItems: column.tabItems
      }));
  }

  // 未分屏：只有一列
  const members = roots(ws);
  if (!members.length) return [];
  const flat = isFlat(ws);
  const flatContainer = flat ? members.find(isContainer) : null;
  const flatPanesSplit = Boolean(flatContainer
    && flatContainer.paneSplit && flatContainer.paneSplit.enabled);

  const tabItems = flat
    ? (flatPanesSplit
        ? members.filter(tab => !isContainer(tab))
        : members.flatMap(tab => (isContainer(tab) ? childrenOf(ws, tab) : [tab])))
    // 多分组不扁平：受托管叶（hostGroupId）住在那组的下层行，不能再列进列首行
    : members.filter(tab => !leafHostGroup(ws, tab));

  const focusedRoot = ws.focusedTabId ? rootOf(ws, tabOf(ws, ws.focusedTabId)) : null;
  return [{
    id: members[0].id,
    containerId: isContainer(focusedRoot) ? focusedRoot.id : null,
    isFamily: flat,
    tabItems
  }];
}
```

分屏分支的 `tabItems` 有两段：**容器自身**（分组标签），加上 `leafItemsOfColumn()` 挑出的根级叶。后者按 `resolveLeafColumnId()` 归列，也就是 §2.3.1 里那个唯一真源——渲染层不再自己记「这个 Shell 停在哪一列」。

```js
// 根级叶该挂到哪一列。它是这类事实在模型里的唯一表示。
//
// 优先级（§2.3.1）：
//   0. 不是根级叶 → null（由 subRow 管，不参与列首行）
//   1. columnMode === 'ownColumn' → OWN_COLUMN_ID（共享独立列）
//   2. hostGroupId 指向现存容器 → 该容器列
//   3. 显式 columnId 且该列存在 → 用它
//   4. 悬空或未指定 → 第一个容器列（位置稳定，不跟焦点跑）
//   5. 根本没有容器列 → null
function resolveLeafColumnId(ws, leaf) {
  if (!leaf || isContainer(leaf) || leaf.parentId !== null) return null;  // 第 0 条是前置条件
  if (leafColumnMode(leaf) === 'ownColumn') return OWN_COLUMN_ID;
  const hosted = leafHostGroup(ws, leaf);
  if (hosted) return hosted;
  const containers = roots(ws).filter(isContainer);
  if (!containers.length) return null;
  const wanted = typeof leaf.columnId === 'string' ? leaf.columnId : '';
  if (wanted && containers.some(c => c.id === wanted)) return wanted;
  return containers[0].id;   // 悬空或未指定：落到第一个容器列，不跟焦点跑
}

// 停在该列**列首行**的根级叶。受托管叶（hostGroupId）必须排除：
// 它们住在那组下层行（layoutRowsOf 会并进 pane-1 那一条 row），
// 再列进列首行就是同一个标签在两处可点。
function leafItemsOfColumn(ws, columnId) {
  return roots(ws).filter(leaf => !isContainer(leaf)
    && leafHostGroup(ws, leaf) === null
    && resolveLeafColumnId(ws, leaf) === columnId);
}

// 根级叶的显示形态：'row'（停在本列列首行）或 'ownColumn'（进共享独立列）。
function leafColumnMode(leaf) {
  return leaf && !isContainer(leaf) && leaf.columnMode === 'ownColumn' ? 'ownColumn' : 'row';
}

// 自成独立列的根级叶（全部共享 OWN_COLUMN_ID 那一列）。
function ownColumnLeaves(ws) {
  return roots(ws).filter(leaf => !isContainer(leaf) && leafColumnMode(leaf) === 'ownColumn');
}

// 挂在某个容器下层标签行上的根级叶（历史上 ownerGroupId 的职责）。
// 指向已不存在的容器时返回 null（不猜、不回落，让 validateAndRepair 负责修数据）。
function leafHostGroup(ws, leaf) {
  if (!leaf || isContainer(leaf) || leaf.parentId !== null) return null;
  const wanted = typeof leaf.hostGroupId === 'string' ? leaf.hostGroupId : '';
  if (!wanted) return null;
  const container = tabOf(ws, wanted);
  return isContainer(container) ? wanted : null;
}
```

一个函数返回了列的**全部信息**（列 id、对应容器、是否族列、TabRow 项），渲染层不再需要任何组合判断。这就是第一版拆成 `columns()` + `rowItems()` + `flatRowItems()` 三个函数时丢失的东西：拆得太碎，组合逻辑就漏回渲染层了。

未分屏分支**不能**退化成「焦点所在的那一个根」。TabRow 就是一级标签栏，多分组时用户要靠这一行看到并点击全部分组标签；只列焦点所在的根，其余分组会从界面上整体消失。同理也不能「每个分组各一列」——那会让每列各自渲染一条 TabRow，又回到 `#serial-group-tab-bar` 的借位老路。

| 情形 | 分屏 | 列数 | `isFamily` | TabRow 内容 |
|---|---|---|---|---|
| 单组（扁平） | 否 | 1 | 是 | 容器全部子项 + 未受托管根级叶（按根级 order 混排） |
| 单组（扁平） | 否 + pane 分屏 | 1 | 是 | **仅未受托管根级叶**；容器子项在各自的 subRow |
| 多组 | 否 | 1 | 否 | **全部分组标签 + 停在本列的根级叶**（受托管叶在那组下层行） |
| 任意 | 是 | 容器数（`roots().filter(isContainer).length`）+（若有）1 个共享独立列 | 否 | 每个容器各自一条；根级叶**不占列**，停在其中一列的列首行 |

**渲染契约（方案 A 的另一半，必须在渲染层逐字遵守）**：扁平 + pane 分屏时，若 `tabItems` 为空，
**第一条 subRow 复用一级 TabRow 的宿主**（即 pane-1 的 `.pane-tabs-header`），不另造一条空行；
若 `tabItems` 非空（有根级 Shell），一级行放这些叶，各 pane 的 subRow 各自独立，此时可见行数 = pane 数 + 1。
这两句写在这里而不是渲染层，是因为“一级行到底画几条”属于布局语义，一旦漏回渲染层就会再长出一套层数判断。

### 3.4 布局行：每列几条 subRow

```js
function layoutRowsOf(ws, column) {
  if (!column.containerId) return [];            // 叶列（例如 Shell）没有 subRow
  const container = tabOf(ws, column.containerId);
  const panes = panesOf(container);
  const split = Boolean(container.paneSplit && container.paneSplit.enabled);
  // 扁平（isFamily）下容器不拥有独立行（方案 A）：未开 pane 分屏时为 0 条，
  // 开了 pane 分屏时按 pane 数展开——否则 pane-2 的标签无处可点（I9）。
  if (column.isFamily) return split ? panes.slice() : [];
  return split ? panes.slice() : panes.slice(0, 1);
}
```

`rows.length` 就是 subRow 条数。**容器只在 `paneSplit.enabled` 且 pane 数 ≥ 2 时才有多条**，其余情况一律 1 条（或 0 条）。

### 3.5 可见面板：显隐的唯一判据

```js
function visiblePanelIdsOfColumn(ws, column) {
  const rows = layoutRowsOf(ws, column);

  // 按 pane 拆分：每个 pane 显示自己的 activeTabId
  if (rows.length > 1) return rows.map(p => p.activeTabId).filter(Boolean);

  // 独立列（共享 __shell__）：没有容器、没有 pane。焦点落在其中某个叶就显示它，
  // 否则显示第一个（独立列必须恒定有一个激活 Shell）。
  // **必须先判 ws.split.enabled**：未分屏时非扁平分支的唯一列 containerId 也是 null，
  // 不加前提会被误判成独立列而返回空集（实测 not ok 435：actual [] vs expected ['shell-3']）。
  if (ws.split.enabled && !column.containerId) {
    const focused = tabOf(ws, ws.focusedTabId);
    const hit = focused && column.tabItems.some(item => item.id === focused.id);
    if (hit) return [focused.id];
    return column.tabItems.length ? [column.tabItems[0].id] : [];
  }

  // 未分屏：整列只有一个内容区，而内容区跟的是**焦点**。
  // 焦点可能是容器里的叶，也可能是一个未归属的 Shell（它不属于任何 pane，
  // 但住同一个内容区）——两个形态都必须有分支，否则焦点落在 Shell 上时
  // 这里返回空集，而页面仍显示 Shell 面板。
  if (ws.split.enabled === false) {
    const f = tabOf(ws, ws.focusedTabId);
    if (f && !isContainer(f)) return [f.id];
    if (f && isContainer(f)) {
      const pane = panesOf(f)[0];
      if (pane && pane.activeTabId) return [pane.activeTabId];
    }
  }

  // 分屏后容器列里的根级叶（未归属 Shell 停在列首行）：它不在任何 pane 里，
  // 焦点落在它身上时该列显示它，而不是那个 pane 的 activeTabId。
  // 判据必须限定「焦点确实是**这一列**的根级叶」，不能只看它不属于任何 pane：
  // 后者对任何一列的 Shell 都成立，分屏时会串台到别的列。
  if (ws.split.enabled) {
    const focused = tabOf(ws, ws.focusedTabId);
    if (focused && !isContainer(focused)
        && resolveLeafColumnId(ws, focused) === column.containerId) {
      return [focused.id];
    }
  }

  // 分屏后的普通列：显示该容器自己的激活叶，**不看焦点**——
  // 分屏时所有列都要各自显示内容，而焦点只有一个。
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
```

**不要**用 `[column.id]` 做兵底：列 id 可能是容器 id，而容器没有面板（I3），把它当面板返回会让下游拿到一个永远匹配不到 tabPanel 的 id。

与「此刻该亮哪个」分开的另一个问题：**这一列的内容区里必须住着哪些面板**（先搬面板，再按 `visiblePanelIdsOfColumn` 点亮）：

```js
function panelIdsOfColumn(ws, column) {
  const out = [];
  const push = (id) => {
    if (typeof id === 'string' && tabOf(ws, id) && !out.includes(id)) out.push(id);
  };
  for (const row of layoutRowsOf(ws, column)) {
    for (const id of row.tabIds) push(id);
    push(row.activeTabId);
  }
  // 独立列没有行；它的面板就是这一行里的全部叶。
  if (!column.containerId && ws.split.enabled) {
    for (const tab of column.tabItems) if (tab && !isContainer(tab)) push(tab.id);
  }
  return out;
}
```


**显隐的唯一判据**：

```js
panel.hidden = !visiblePanels(ws).has(tabId);
```

没有「谁盖住谁」「哪个更高一层」「是不是叠在宿主分组上」。历史上 `stackShellTabOverHostGroup()` + `hideStackedShellTabsIn()` 存在的唯一理由，是 Shell 被塞进了某个 pane；当 Shell 是根级 Tab，它自己就是（或属于）一列，不需要遮盖任何人。

### 3.6 派生量总览

| 派生量 | 用途 | 阶层 | 对应历史上的什么 |
|---|---|---|---|
| `roots(ws)` | 根级顺序 | 结构 | `serialGroups` + `shellTabs` 的混合顺序 |
| `childrenOf(ws, c)` | 容器子项（pane 展开后） | 结构 | `filterTabs` + `chartTabs` + main 的拼接 |
| `panesOf(c)` | 组内 pane 列表 | 结构 | `groupWorkspaceLayouts.panes` |
| `paneOfTab(ws, t)` | 叶属于哪个 pane | 结构 | 各函数里现场遍历 pane 找 tab |
| `isFlat(ws)` | 是否扁平（只用于族判定） | 结构 | 8 处 `serialGroups.length > 1` |
| `rootFamilyOf(ws)` | 扁平时的根族 | 结构 | 「单分组借位」的目标 |
| `layoutColumns(ws)` | **列数 + 每列全部信息** | 布局 | `getVisibleGroupIds()` + `shellColumnId()` + 借位搬移 |
| `layoutRowsOf(ws, c)` | 每列几条 subRow | 布局 | `paneSplit.enabled ? panes : 1` |
| `visiblePanelIdsOfColumn(ws, c)` | 该列显示哪些面板 | 布局 | 整套叠层显隐 |
| `visiblePanels(ws)` | 全集显隐、`fit()` 时机 | 渲染 | 整套叠层判断 |
| `buildRenderPlan(ws)` | 渲染层唯一输入（§3.7） | 渲染 | 散落在 renderer 里的多套组合逻辑 |

所有需要跨表查找的函数都显式接收 `ws`，不存在依赖外层作用域的隐式参数——上表的签名就是实现的签名。

「结构」层只回答「谁属于谁」，「布局」层只回答「画在哪」，两层都可以由「结构 + split / paneSplit / focusedTabId」重新算出。**没有任何一格是存储的。**

### 3.7 `buildRenderPlan()`：渲染层的唯一输入

若把上面多个派生量直接交给渲染层，渲染层就得自己组装「列 + TabRow 项 + subRow + 显隐」——组合逻辑又回到了最脆弱的那一层。因此定义**一个**函数产出完整计划：

```js
function buildRenderPlan(ws) {
  const cols = layoutColumns(ws);
  const containers = roots(ws).filter(isContainer);
  const focused = tabOf(ws, ws.focusedTabId);
  const focusedLeafColumn = focused && !isContainer(focused)
    ? resolveLeafColumnId(ws, focused) : null;
  const firstContainerId = containers.length ? containers[0].id : null;

  // 列容器的 DOM key：容器列 = 容器 id；独立列 = OWN_COLUMN_ID；
  // 其余情况取「焦点叶所在列」，缺失时回落第一个容器列。
  // 独立列不得在**非分屏**形态下被当成 key，否则会凭空建出一列空壳。
  const domKeyOf = (column) => {
    if (column.id === OWN_COLUMN_ID) return OWN_COLUMN_ID;
    if (column.containerId) return column.containerId;
    if (focusedLeafColumn === OWN_COLUMN_ID) return firstContainerId || column.id;
    return focusedLeafColumn || firstContainerId || column.id;
  };

  return {
    columns: cols.map(column => {
      const container = column.containerId ? tabOf(ws, column.containerId) : null;
      const rows = layoutRowsOf(ws, column);
      const paneSplit = container && container.paneSplit ? container.paneSplit : null;
      const domKey = domKeyOf(column);
      return {
        columnId: column.id,
        domKey,
        containerId: column.containerId,
        isFamily: column.isFamily,
        tabItems: column.tabItems,
        collapsed: container ? container.collapsed === true : false,
        splitEnabled: Boolean(paneSplit && paneSplit.enabled === true),
        orientation: paneSplit && paneSplit.orientation === 'vertical' ? 'vertical' : 'horizontal',
        paneSizes: paneSplit ? { ...(paneSplit.sizes || {}) } : {},
        size: ws.split && ws.split.enabled ? (ws.split.sizes || {})[domKey] : null,
        rows: rows.map(pane => ({
          paneId: pane.id,
          tabs: pane.tabIds.map(id => tabOf(ws, id)).filter(Boolean),
          activeTabId: pane.activeTabId
        })),
        panelIds: visiblePanelIdsOfColumn(ws, column),       // 此刻该亮哪个
        panelIdsAll: panelIdsOfColumn(ws, column)            // 面板必须住在哪
      };
    }),
    columnLayout: {
      enabled: Boolean(ws.split && ws.split.enabled === true),
      orientation: ws.split && ws.split.orientation === 'vertical' ? 'vertical' : 'horizontal',
      sizes: { ...((ws.split && ws.split.sizes) || {}) }
    },
    containerCount: containers.length,
    tabBarVisible: containers.length > 1,
    panelIds: [...visiblePanels(ws)],
    subRowTabIds: cols.flatMap(column =>
      layoutRowsOf(ws, column).flatMap(pane => pane.tabIds.slice())
    )
  };
}
```

渲染层只做四件事：按 `columns` 比对列容器 → 按 `rows` 比对行 → 按 `tabItems` / `rows[].tabs` 复用并重排按钮 → 按 `panelIds` 写 `.active`。**它是纯数据消费者，不含任何布局判断。**

| 字段 | 语义 |
|---|---|
| `columns[].columnId` | 模型里的列 id（容器列 = 容器 id，独立列 = `OWN_COLUMN_ID`） |
| `columns[].domKey` | 渲染层据以找/建列容器的 key |
| `columns[].panelIds` | 此刻该亮的面板（一列一个） |
| `columns[].panelIdsAll` | 必须住进该列内容区的全部面板（先搬面板，再按 `panelIds` 点亮） |
| `columns[].size` | 列级分屏占比（未分屏为 `null`） |
| `columnLayout` | 列级分屏方向与占比，渲染层只据它写类名与 `flex-basis` |
| `containerCount` / `tabBarVisible` | 容器数；一级分组标签行是否显示（> 1） |
| `panelIds` / `subRowTabIds` | 全局面板可见集 / 全部 subRow 的标签 id |

**字段名陷阱**：`layoutColumns()` 的列对象用 `id`，`buildRenderPlan()` 的用 `columnId`，渲染层另用 `domKey`。

这也是本文的定量验收标准：**渲染层不允许出现 `split`、`paneSplit`、`isFlat`、`roots`、`childrenOf`、`rootFamilyOf`。** 出现即说明组合逻辑漏回了渲染层。

## 4. 两级分屏

两级**正交**，各自独立开关：

| 级别 | 载体 | 状态 | 控件 |
|---|---|---|---|
| 第一级：列 | 整个工作区 | `workspace.split` | 分屏按钮、列分界条 |
| 第二级：pane | 单个容器 | `tab.paneSplit` + `tab.panes[]` | 组内分屏按钮、pane 分界条 |

### 4.1 第一级：列

`split.enabled === true` 时，**列集合 = 容器集合 +（若有）一个共享独立列**。根级叶（未归属的 Shell）
默认**不额外占列**，它停在某一列的列首行，与分组标签同级；只有 `columnMode === 'ownColumn'` 的叶
才进那个唯一的共享独立列（`OWN_COLUMN_ID = '__shell__'`，全部独立叶共用一列，不是每叶一列）。
分界条数量 = 列数 - 1。

> **这条语义由用户裁决，不是实现细节**：
> 「两个串口分组左右分屏时，是用户右键点击了某个串口组将他移到左边或者右边，这就是被移动的组，
> 和其他分组或者 shell 没关系，Shell 肯定是维持原来的位置不动」
>
> 因此「未归属 Shell 在分屏时自占一列」是**错误**方案，不得复活。Shell 的位置是标签行里的那个按钮，
> 不是分组的内容区；关闭分屏后该列必须回到它自己的串口标签。

宽度按 `split.sizes[columnId]` 归一化分配，并扣除分界条占位：`flex-basis: calc(<比例>% - <比例 × 分界条总占位>px)`。这个公式是历史缺陷「最右列越界」的修法（`8f55a0f`），必须保留。

`split.enabled === false` 时只有一列，分界条全部隐藏，内容区由焦点决定。

**关键点**：列顺序由 `roots()` 的 `order` 决定，关掉再打开不变。而「根级叶停在哪一列」是 `tabs[id].columnId`——它是**存储的**，因为用户可以把 Shell 拖到任意一列，这个选择无法从 `order` 重新算出。两者不是同一类事实，不要混为一谈。

### 4.2 第二级：组内 pane

容器的 `panes[]` 是该列内部的分割。`paneSplit.enabled === false` 时只用第一个 pane，但**不删除其余 pane**——关掉分屏再打开时布局要能恢复。

`paneSplit.enabled === true` 时该列竖向排列：

```
┌──────────────────────────────────┐
│ TabRow  [COM1] [SHELL1]          │
├──────────────────────────────────┤
│ subRow  [MAIN][FILTER][CHART]    │  ← pane-1
├──────────────────────────────────┤
│ tabPanel（pane-1 的 activeTab）   │
├══════════════════════════════════┤  ← pane 分界条
│ subRow  [MAIN]                   │  ← pane-2
├──────────────────────────────────┤
│ tabPanel（pane-2 的 activeTab）   │
└──────────────────────────────────┘
```

### 4.3 四种组合

| 组合 | 列数 | 每列 subRow |
|---|---|---|
| 列关、pane 关 | 1 | 扁平且无 pane 分屏：0；否则 1 |
| 列开、pane 关 | 容器数 | 1 |
| 列关、pane 开 | 1 | `panes.length` |
| 列开、pane 开 | 容器数 | 每列各自 `panes.length` |

两级互不影响：`layoutColumns()` 只看 `workspace.split` 与根族，`layoutRowsOf()` 只看 `tab.paneSplit`。

### 4.4 分界条

| 分界条 | 相邻项来自 | 拖动的状态 |
|---|---|---|
| 列分界条 | `layoutColumns()` | `workspace.split.sizes` |
| pane 分界条 | `layoutRowsOf()` | `tab.paneSplit.sizes` |

两者共用同一套几何计算，但**状态容器必须分开**——列比例与 pane 比例是两个独立维度，共用一个 `sizes` 对象会导致调一边影响另一边。

### 4.5 比例归一化

`split.sizes` 与 `paneSplit.sizes` 都可能与当前列数／pane 数不匹配（增删列、关组、从旧配置迁移）。规则：

1. **只存已出现过的比例，不预填**；
2. 每次计算前先跑 `normalizeSizes(sizes, ids)`：丢弃 `ids` 中不存在的键 → 缺失键补 `1` → 若总和 ≤ 0 则全部重置为 `1` → 否则等比缩放使总和为 `1`；
3. 归一化是**纯函数**，返回新对象，不回写 `ws`——回写会让「读」产生副作用，而派生量必须只读。需要持久化时由调用方显式赋值。

## 5. 扁平模式

### 5.1 判据

见 §3.2：`roots().filter(isContainer).length <= 1`。

### 5.2 扁平模式的布局

```
TabRow:  [MAIN] [FILTER] [CHART] [SHELL1] [SHELL2]
──────────────────────────────────────────────────
内容区：  焦点所在 Tab 的 tabPanel
```

容器不渲染为标签，其子 Tab 与其余根级 Tab **按根级 `order` 混排**在唯一一条 TabRow 上；没有 subRow 行。见 §3.3 的 `layoutColumns()` 分支。

多分组模式：

```
TabRow:  [COM1] [COM2] [SHELL1]
──────────────────────────────────────────────────
subRow:  [MAIN] [FILTER] [CHART]        ← COM1 的 pane-1
──────────────────────────────────────────────────
内容区：  COM1 的 pane-1 的 activeTab
```

### 5.3 与现状「单分组隐藏分组行」的区别

界面相似，机制不同。不写清会让接手者以为是同一件事：

| | 现状（单分组） | 新模型（`isFamily`） |
|---|---|---|
| 层数 | 两层中的一层 `hidden` | **只有一层**，第二层不存在 |
| 分组标签 | `#serial-group-tab-bar` 整行 `hidden`，标签靠借位搬移 | 容器**不渲染**，子 Tab 由 `layoutColumns()` 直接与根级 Tab 混排 |
| Shell 位置 | 与 MAIN/FILTER 混排在 pane 行 | 与 MAIN/FILTER 同住 TabRow |
| 切回多分组 | 逐处 `removeAttribute('hidden')`，容易漏 | 无状态切换，只是 `layoutColumns()` 走了另一分支 |

### 5.4 `parentId` 保持不变（关键取舍）

**结论：扁平模式不改写 `parentId`，仍指向容器。**

1. **切换成本**。「一个分组」与「两个分组」是用户随时切换的状态。按 `parentId` 改写意味着每次增删分组都要批量改写 N 个 Tab，中途失败会留下半扁平状态；保留则切换零成本。
2. **语义正确**。`parentId` 表达「属于哪个容器」，是数据事实，与「当前显示几层」无关。把显示状态写进数据模型，正是本文要消除的真源混用。
3. **可变性最小**。删除容器时只需删除其子树；若 `parentId` 已被改成 `null`，这些节点会变成孤儿根标签，无法与「原本独立的 Shell」区分。

### 5.5 扁平模式 + 组内 pane 分屏（已裁决：方案 A）

两条要求同时成立时会冲突：

- 「subRow 在只有一个串口组时不可见」→ 扁平模式没有 subRow；
- 「组内 pane 分屏保留」→ pane 分屏的表现形式是「每个 pane 一条 subRow + 独立内容区」。

于是当**只有一个串口组、又开启了组内分屏**时，pane-2 的标签没有地方显示，用户无法切换它。

| 方案 | 做法 | 代价 | 结论 |
|---|---|---|---|
| **A. 例外** | 扁平模式默认无 subRow；一旦开启 pane 分屏，临时恢复 N 条 subRow | 回到「两种层数形态」，但仅由用户显式开启分屏触发，可控 | **已采用** |
| B. 常显 | pane 分屏开启期间始终显示 subRow | 规则最统一；但单组 + 分屏时会出现要求「不可见」的那一行 | 已否决 |
| C. 禁止 | 扁平模式下不允许组内 pane 分屏（分屏按钮置灰） | 最简单、无歧义；但功能受限 | 已否决 |

**依据**：A 是唯一同时满足两条原始要求、且不删除任何能力的解——B 违反「单组时那一行不可见」，C 删除能力。

**方案 A 的准确语义**（实现必须逐字对齐，防止把「例外」扩大成「默认」）：

1. 扁平（`isFlat(ws)`，容器数 ≤ 1）且该容器 `paneSplit.enabled === false` → **subRow 行数为 0**，MAIN / FILTER / CHART 与未归属 Shell 全部住在一级 TabRow。
2. 扁平且 `paneSplit.enabled === true` → **subRow 行数 = pane 数**，每个 pane 一条，内容为该 pane 的 `tabIds`；Shell 仍不进入任何 subRow（I1 / I2）。
3. 非扁平（容器数 ≥ 2）→ subRow 恒存在（当前内容区所属容器的那一条），与本决策无关。
4. 关闭 pane 分屏后 subRow 立即回到 0 条，不留残余行。

语义 1 / 2 就是 §3.4 `layoutRowsOf()` 的 `isFamily` 分支与 §6 的 I9，**本次裁决未改动它们的实现**，只把「暂按」升级为「已定」。方案若再变，只需改这两处——这是行/列分离的直接收益。

## 6. 不变式

以下十条必须始终成立，可（且应该）写成断言。

| # | 不变式 | 违反后的症状 |
|---|---|---|
| **I1** | 任何 `kind === 'shell'` 的 Tab，其 `parentId === null` | Shell 出现在 subRow 里，这是历史缺陷的起点 |
| **I2** | 任何 `panes[].tabIds` 中不含 `kind === 'shell'` 的 id | 同上 |
| **I3** | 每个**叶** Tab 有且只有一个 panel，`panel.id === tab.id` 且全局唯一；**容器没有 panel** | 面板串台、`fit()` 量错高度 |
| **I4** | 每个**非根级** Tab 恰好出现在一个 `panes[].tabIds` 中；每个根级 Tab 不出现在任何 `panes` 中 | 同一标签出现在两条 subRow |
| **I5** | 每个容器至少有一个 pane；每个 pane 的 `tabIds` 非空 | 空白列、无法新建标签 |
| **I6** | `panes[].activeTabId` 必须是该 pane 的 `tabIds` 成员 | 面板显示已被移走的标签 |
| **I7** | `workspace.focusedTabId` 必须存在且指向 `tabs` 中的真实节点 | 无列可见、新建标签无落点 |
| **I8** | 面板可见性只由 `visiblePanels()` 决定 | 出现「两处同时判断显隐」→ 又一套真源 |
| **I9** | 若 `isFlat(ws)` 且某容器 `paneSplit.enabled`，则该容器必须渲染 subRow（方案 A） | 扁平 + 分屏时 pane-2 的标签无处可点 |
| **I10** | 任何容器只有在其 subRow 数量 ≥ 2 时才允许 `collapsed === true` | 收起后无行可点、无法恢复 |

其中 I1 / I2 是结构性硬约束：**Shell 永远不可能进入 pane**。历史上「Shell 跑进 pane 容器」造成的全部缺陷（标签消失、点不动、`fit` 算错、叠层遮盖）由此不可能再发生。

> I3 / I4 与第一版不同：第一版写「每个 Tab 的 panel.id === tab.id」，与「容器没有 panel」冲突；写「每个 Tab 恰好属于一个 pane」，漏掉了根级 Shell。

### 6.1 三条与 Shell 相关的推论

由 I1 + I2 推出：

1. Shell 的按钮 `parentElement` 只能是某条 TabRow 的列表，**绝不能是 subRow 的列表**。
2. Shell 的**终端容器**只能挂在它自己那列的 panel 位置，**绝不在任何 pane 的 content 里**。
3. 分屏时 Shell 自然独立成一列（它是根级 Tab），不需要 `detachedColumn` 之类的字段来「模拟独立成列」。

这三条替代了 `resolveShellTabHost()` 三分支、`setShellDetachedColumn()`、`isShellColumnActive()` 等约 10 个函数。

### 6.2 状态自愈

不变式不能只在迁移时检查一次。运行期有四类污染来源：手改配置、写入过程中崩溃、旧版本回退后重新保存、程序缺陷。

规则：**`loadWorkspace()` 与 `saveWorkspace()` 两端都跑 `validateAndRepair(ws)`**，修复策略按「信息损失从小到大」，**每次修复都记日志**：

| 违规 | 修复 |
|---|---|
| I5 pane 为空 | 给该 pane 补一个 main 叶；若容器无 pane，补 pane 后再补 main |
| I6 activeTabId 失效 | 取该 pane 的第一个叶 |
| I7 focusedTabId 失效 | 取第一个容器的 `panes[0].activeTabId`；仍无则取第一个叶 |
| I1 / I2 Shell 混入 pane | 把该 Shell 提到根级（`order` 取最大值 +1） |
| I3 面板重复 | 保留第一次出现的，其余重新生成 id |
| I10 行数不足却 `collapsed` | 强制 `collapsed = false` |
| 无法修复 | **回落默认工作区**，原始配置另存为 `<config>.corrupt.json`，绝不静默丢弃 |

## 7. 渲染规则

### 7.1 唯一入口与唯一输入

```
renderWorkspace(ws)          // 唯一入口
  → buildRenderPlan(ws)      // 唯一输入（§3.7）
```

所有交互都只做两件事：改 `workspace`，然后调 `renderWorkspace()`。

**不允许任何其它地方直接改标签的类名、`hidden` 或 DOM 位置。** 历史上 `placeShellTabs()` /
`stackShellTabOverHostGroup()` / `applyLayoutToDom()` 三套各自搬一段 DOM，正是混乱来源（已随 S5-④ 全部删除）。

### 7.2 渲染五步

```
renderWorkspace(ws)                     // 唯一入口，自带重入闸（isRenderingWorkspace）
  ├── 0. plan = buildRenderPlan(ws)     ← 只读这一个，不自己算
  ├── 1. reconcileColumns(plan)         按 plan 的列数与顺序（建列 / 显隐 / 方向类名 / 分界条 / flex-basis）
  ├── 2. reconcileRows(plan)            每列：分组标签行显隐 + 每 pane 一条行 + pane 建/隐/尺寸
  ├── 3. reconcileButtons(plan)         按 tabItems / rows[].tabs 复用或创建按钮，并按 plan 顺序重排
  ├── 4. applyVisibility(plan)          面板搬进内容区 + 唯一一次写 .active
  └── 5. sweepStaleColumns(plan)        四步之后才拆残留列（只拆空壳列）
```

每步都「比对现状、只改差异」，不是「先清空再重建」。

**第 5 步的顺序不可调换**：拆列必须在搬完按钮与面板之后。`querySelector` 找不到节点时不报错，只表现为
标签静默消失——历史上 `reconcileColumns` 提前 `remove()` 空壳列就踩过两次（关分屏、关分组）。
真正的拆列只拆「既无 `.main-tab` 也无 `.main-tab-pane`」的空壳，否则只 `hidden = true`。

**焦点是模型状态**：`renderWorkspace` 消费的 `ws.focusedTabId` 来自一个真实的模块级字段（`focusedWorkspaceTabId`），
不是每次渲染新建的投影快照——往投影树上写状态下一刻就丢。

渲染结束时对可见终端调一次 `fitWorkspaceTerminals()`；它内部的可见性判据只看 DOM（`.active` + `offsetParent` + 宽高）。

### 7.3 三条渲染约束

**C1：节点复用，不重建。** 按钮与面板按 id 建一次，之后只更新属性与位置。切标签、切分组、分屏都不得产生新节点。

原因（实测）：`renderSerialGroupTabBar()` 原先每次 `replaceChildren()` 重建按钮，导致整条标签栏重排、hover / 焦点态与入场动画一起重播。已修为按 id 复用 + 就地更新（`0bf62ea`），本模型必须沿用。

**C2：父节点没变就不 `appendChild`。** `appendChild` 对已在该父节点下的子节点也是先摘再插，`<canvas>`、`<iframe>`、CSS 动画都会重放，并触发整行重排。

```js
if (tabButton.parentElement !== effectiveTabsList) {
    effectiveTabsList.appendChild(tabButton);
}
```

**C3：没有入场动画。** `.main-tab`、`.main-tab-pane.active`、`.sidebar-tab-pane` 上的 `animation` 与 `@keyframes fadeIn` / `tabFadeIn` 已全部删除（`0bf62ea`），不得再加回。这些元素反复显隐，任何入场动画都会变成「每切一次闪一次」。

### 7.4 事件绑定

按钮不再重建后，事件**不能**在构造时用闭包绑定 `tabId`——闭包会永久持有旧值，重新归属或重命名后点击会落到旧语义上。

规则：**在列表容器上委托**，从 `dataset.tabId` 现读。`bindTabListEvents(listEl)` 同时服务 TabRow 与 subRow，用 `dataset.tabListEvents` 去重。

### 7.5 渲染触发边界

**「任何状态变化都调 `renderWorkspace()`」不等于「任何事件都调」。** 以下高频路径**不得**触发渲染：

| 路径 | 频率 | 允许的更新方式 |
|---|---|---|
| 串口收到数据 | 每报文 | 只写 xterm / 缓冲区 |
| 快捷指令列表刷新 | 用户操作 | 只更新对应列表 DOM |
| 状态栏、计数、时间戳 | 秒级 | 只改文本节点 |
| `fit()` | 尺寸变化 | 只调 `fit()`，不改标签结构 |

`renderWorkspace()` 只服务于**标签结构变化**：新建、关闭、切换焦点、分屏、收起、重排。把它做成「任何数据变化都重跑」，会把 46 个同步函数的开销搬到串口热路径上。

### 7.6 `fit()` 时机

| 时机 | 动作 |
|---|---|
| `applyVisibility()` 之后 | 对本帧新变为可见的面板调用 `fit()` |
| 分屏比例变化后 | 对受影响列的全部可见面板调用 `fit()` |
| 面板处于 `display:none` | **不调用**——容器尺寸为 0，会算出极小尺寸 |

I8 成立后每个 pane 只有一个可见面板，`fit()` 不可能对隐藏面板执行。

## 8. 交互语义

### 8.1 激活：一个入口

现有的四条切换路径（`switchPaneTab` / `switchShellTab` / `activateShellTabInHost` / `revealSerialGroupActiveTab`）合并为一个。
模型层是 `activateTab`；渲染层对应 `setFocusedTab`——后者在写模型前先把焦点写进真实字段
`focusedWorkspaceTabId`，因为投影器是只读的，投影快照上写的状态下一刻就丢。

```js
// 当前工作区的模型快照（每次新建）。**只供读**：投影器是纯函数，往它上面写状态下一刻就丢。
function workspaceTabState() {
  return buildLiveWorkspace();
}

function workspaceTabOf(tabId) {
  return tabOf(workspaceTabState(), tabId);
}

function setFocusedTab(tabId) {
  const tab = workspaceTabOf(tabId);
  if (!tab) return false;
  if (isContainer(tab)) {
    // 容器：抬回它自己的激活叶（用户点分组标签 = 看这个分组的串口终端）
    const pane = panesOf(tab)[0];
    return pane && pane.activeTabId ? setFocusedTab(pane.activeTabId) : false;
  }
  focusedWorkspaceTabId = tab.id;              // 先写焦点：接下来的渲染必须看到它
  const hit = paneOfTab(workspaceTabState(), tab);
  if (hit && hit.pane) {
    // 叶属于某个 pane：走布局管理器的真实写入口（不能用投影快照）
    const ownerGroupId = resolveGroupIdFromPaneId(hit.pane.id);
    getGroupWorkspaceManager(ownerGroupId).switchPaneTab(hit.pane.id, tab.id, { persist: true });
  }
  renderWorkspaceNow();
  return true;
}
```

这四个入口的实现在 `renderer.js`；本文只固定它们的契约（空函数体表示「实现见渲染层」）：

```js
// 把当前 section 投影成模型树（唯一投影入口，渲染与影子判据共用）。只读。
function buildLiveWorkspace() {}

// 渲染入口的薄封装。
function renderWorkspaceNow() {}

// pane id 的形状是 pane-<n>-<groupId>（默认分组无后缀）；这是它唯一的解析入口。
function resolveGroupIdFromPaneId(paneId) {}

// 每个串口分组一个布局管理器；按分组 id 取（缺失时现建）。
function getGroupWorkspaceManager(groupId) {}
```

三条必须同时写焦点的时机（否则屏幕不动）：`switchPaneTab`（布局层只写 activeTabId）、
`applyActiveSerialGroup`（切组后上一组焦点仍「有效」）、`setGroupWorkspaceSplit(false)`（关分屏后焦点必须抬回主标签）。

**关键点：不再有「哪一列可见」这个写入。** 它由 `focusedTabId` 在 `layoutColumns()` 里派生。历史上 `revealSerialGroupActiveTab()` 要单独「揭露」被遮住的串口，正是因为「可见列」和「激活项」是两套状态；合并成一个焦点后，这个函数没有存在理由。

### 8.2 拖拽：只做同栏重排

**唯一允许的拖拽动作**：在同一行内改变顺序。

```js
// scope: { kind: 'roots' } | { kind: 'pane', containerId, paneId }
function reorderInRow(ws, scope, tabId, targetIndex) {
  if (scope.kind === 'roots') {
    const list = roots(ws).filter(t => t.id !== tabId);
    const at = Math.max(0, Math.min(targetIndex, list.length));
    list.splice(at, 0, tabOf(ws, tabId));
    list.forEach((t, i) => { t.order = i; });
  } else {
    const container = tabOf(ws, scope.containerId);
    const pane = panesOf(container).find(p => p.id === scope.paneId);
    if (!pane) return;
    const from = pane.tabIds.indexOf(tabId);
    if (from < 0) return;                      // 不允许跨 pane 拖动
    pane.tabIds.splice(from, 1);
    const at = Math.max(0, Math.min(targetIndex, pane.tabIds.length));
    pane.tabIds.splice(at, 0, tabId);
  }
}
```

**同栏拖动**只改变顺序（行内 `reorderInRow`）；**Shell 的跨层拖动是另一类事实**：它不是「换个行显示」，而是改三个叶级字段之一：

| 落点 | 写入 | 结果 |
|---|---|---|
| 某列的分组标签行 | `setLeafHostGroup(ws, leafId, null)` + `setLeafColumnMode(ws, leafId, 'ownColumn')` | 进共享独立列（`OWN_COLUMN_ID`） |
| 某组的下层标签行 | `setLeafHostGroup(ws, leafId, groupId)`（自动把 `columnMode` 清回 `row`） | 住进那组的 pane-1 下层行 |
| 某一列的列首行 | `setLeafColumn(ws, leafId, columnId)` | 停在那列列首行 |

为什么 Shell 能跨层而其它叶不能：I1 / I2 保证 Shell 永远不进 `panes[].tabIds`，它的位置由 `hostGroupId` / `columnMode` / `columnId`
三条**互斥**的叶级事实描述（同一时刻至多一条生效），所以不存在「半只脚进了 pane」的中间态。
组内叶仍然不能拖出 pane（`parentId` 无处安放），根级叶也不能进 subRow 当普通成员。

### 8.3 收起

`collapsed` 只对容器有效，且只在「有第二行可收」时有意义（I10）：

| 情形 | subRow 行数 | 收起按钮 | 允许 `collapsed` |
|---|---|---|---|
| 扁平且未开 pane 分屏 | 0 | 不渲染 | 否 |
| 扁平且开了 pane 分屏（方案 A） | `panes.length` ≥ 2 | 渲染 | 是 |
| 非扁平、单 pane | 1 | 不渲染 | 否 |
| 非扁平、多 pane | `panes.length` ≥ 2 | 渲染 | 是 |

**收起按钮必须挂在 TabRow 的列首，不能挂在 subRow 里。** 挂在 subRow 里会导致：收起后 subRow 不渲染 → 按钮随之消失 → 用户永远无法展开。这是可恢复性要求，不是审美选择。

### 8.4 新建 / 关闭标签

| 动作 | 唯一写入 | 落点规则 |
|---|---|---|
| 新建 main / filter / chart | 目标 pane 的 `tabIds` 追加，置 `activeTabId` | 优先焦点所在 pane；焦点不在任何 pane 时取焦点所在容器的第一个 pane |
| 新建 shell | `tabs` 新增 `parentId: null` 节点，`order = roots().length` | 总是根级，与焦点无关 |
| 新建容器 | 新增容器，自带 `panes: [{ id, tabIds: [mainId], activeTabId: mainId }]` | 总是根级 |
| 关闭叶 | 从 `panes[].tabIds` 删除 | 若删的是 `activeTabId`，取同 pane 相邻项；pane 空了按 I5 补 main |
| 关闭容器 | 删除容器与其全部子树，清 `split.sizes` / `paneSplit.sizes` 对应键 | 若焦点在其子树内，转给相邻根级 Tab |

焦点 pane 由 `paneOfTab(focusedTab)` 直接得到，不需要 `panes[?]` 这种占位符。

### 8.5 全局动作的宿主（重要修正）

「新建分组」「新建 Shell」的产物都是**根级 Tab**，属于整个工作区，不属于任何一列。分屏后每列各有一条 TabRow，因此不能放进某一列（范畴错误），也不能每列各放一个（会产生多个按钮，正是已修过的「两个添加串口按钮」缺陷）。

规则：

| 位置 | 内容 | 数量 |
|---|---|---|
| **工作区级动作条**（独立一行，位于列容器上方） | 新建分组、新建 Shell | 各 **1 个**，全局唯一 |
| 每列的 TabRow | 该列标签 + 该列局部动作（关闭分屏等） | 每列 1 条 |

这条修正同时解释了现状为什么出问题：现在把「新建 Shell」塞在分组标签行里，分屏后每列都有自己的分组标签行，于是要么重复出现，要么被 `syncShellAddButtonVisibility()` 按层数硬压。提到列之外的固定位置后，可见性规则退化为「永远可见，且只有一份」。

### 8.6 右键菜单

容器的右键菜单项（重命名、关闭、新建 Shell、分屏）挂在 `isContainer(tab)` 为真的按钮上。判据是结构而非 `kind`，新增容器类型自动获得同一套菜单。

## 9. 持久化与迁移

### 9.1 持久化形状

```jsonc
{
  "tabs": [
    { "id": "grp-default", "kind": "group", "parentId": null, "order": 0,
      "groupId": "default", "collapsed": false,
      "paneSplit": { "enabled": false, "orientation": "horizontal", "sizes": {} },
      "panes": [ { "id": "def-p1", "tabIds": ["main-default", "filter-1"], "activeTabId": "main-default" } ] },
    { "id": "shell-1", "kind": "shell", "parentId": null, "order": 1 }
  ],
  "focusedTabId": "main-default",
  "split": { "enabled": false, "orientation": "horizontal", "sizes": {} }
}
```

`tabs` 存平铺数组（`Object.values`），读取时建索引。持久化格式与内存同形，不另设 DTO。

### 9.2 不持久化的东西

- 按钮 DOM 引用、`buttonId`
- 列表滚动位置、hover / 焦点环
- 分界条元素本身
- 任何 `hidden` / 类名 / `flex-basis`

注意：`focusedTabId` **要持久化**（决定启动后显示哪一列），而第一版曾把「焦点 pane」列为不持久化——两者是不同概念，见 §2.6。

### 9.3 迁移

`SERIAL_GROUPS_CONFIG_VERSION` 递增一版，`migrateSerialGroupsConfig()` 增加分支：

| 旧字段 | 处理 |
|---|---|
| `group.workspaceLayout.panes[]` | 搬到容器的 `panes[]` |
| `group.workspaceLayout.splitEnabled` / `orientation` / `paneSizes` | 搬到容器的 `paneSplit`（与 `panes` 同源：优先 `source.panes`，否则回退 `workspaceLayout`） |
| `group.workspaceLayout.activePaneId` | 若其 pane 有 `activeTabId`，用它初始化 `focusedTabId`；否则丢弃。**只看 `activeTabId` 不看 `tabIds[0]`**——后者可能是空数组 |
| `shellTab.ownerGroupId` | **已改名** `hostGroupId`（Shell 归属哪个分组） |
| `shellTab.detachedColumn` | **已改名** `columnMode`（`'row'` / `'ownColumn'`） |
| `shellTab.topRowColumnId` | **已改名** `columnId`（停在那一列的列首行） |
| `shellTabs[]` / `filterTabs[]` / `chartTabs[]` | 转为 `tabs` 节点，`parentId` 分别为 `null` / 所属容器 |
| `workspaceLayout.split`（组级） | 搬到 `workspace.split` |

**三个 Shell 键的老配置回落规则**（投影器 `normalizeTabIds` 负责）：
判据是「新键**原本是否存在**」（`hasOwnProperty` 在重建后恒为 true，不能用；「是否为字符串」也不行——
会让合法的新键 `null` 被旧键覆写）：

| 情形 | 结果 |
|---|---|
| 新键存在（含显式 `null`） | 用新键 |
| 新键不存在、旧键存在 | 用旧键 |
| 两者都不存在 | 默认值（`null` / `'row'` / `null`） |

迁移流程：

1. 构造 `ws`；
2. `rebuildIndex(ws)`；
3. `validateAndRepair(ws)`（§6.2，**修复优先于报错**）；
4. 若产生过修复，把原始配置另存为 `<config>.pre-migrate.json`；
5. 只有判定「无法修复」时才回落默认工作区。

第一版写「任何一条不变式不成立就拒绝保存」，过于严格：迁移阶段的畸形配置多来自旧版本本身，一律拒绝会让老用户直接丢布局。

`normalizeSerialGroup()` 是 `{...defaults, ...source}` 形态，新键会自动保留；但主进程每次存盘都会 `normalizeConfig → migrateSerialGroupsConfig` **重建整个分组对象**，因此 `panes` / `paneSplit` 必须在 `normalizeSerialGroup()` 里显式保留，否则会在一次保存后静默丢失。

### 9.4 兼容性

- 旧配置（无 `tabs` 键）→ 走迁移分支，用户无感。
- 新配置被旧版本读取 → 旧版本不认识 `tabs`，按「没有任何标签」处理。**不做向下兼容**：旧版本本身就是待替换形态，回退意味着放弃新布局。

## 10. 与现有 `renderer.js` 的映射

行号基于 HEAD `9845c82`。后续提交改变行号时以函数名为准。

### 10.1 删除清单

| 位置（HEAD） | 现有实现 | 处理（S5-④ 已执行） |
|---|---|---|
| 2332 | `getShellTabOwner(tabState)` | **保留**：读取 `tabState.hostGroupId`，作为投影器的唯一读数入口 |
| 2338 | `setShellTabOwner(tabId, owner)` | **保留**：写 `tabState.hostGroupId`（写入口只此一处） |
| 2352 | `setShellDetachedColumn(tabId, detached)` | 删除（S4 已删） |
| 2608–2657 | `finishWorkspaceTabDrag(state)` 的 Shelf 跨层分支 | 保留落点三分支，但改走 `setShellTabOwner` + `setShellColumnModeInModel` + `setShellColumnInModel`，每次落点后 `renderWorkspaceNow()` |
| 4203 | `renderSerialGroupTabBar()` | **退化为薄封装**：只调 `renderWorkspaceNow()` |
| 4290 | `syncShellAddButtonVisibility()` | 保留（按钮分层仍有意义，见 §11.5.3） |
| 4418 | `syncSerialGroupAddButtonLayer()` | 保留（同上） |
| 4442 | `syncShellTabLayer()`（含 `isSyncingShellLayer` 重入闸） | **删除** |
| 4518–4600 | `resolveShellTabHost(tabState)` | **删除** |
| 4664 | `syncShellLayoutOwnership()` | **删除** |
| 4706 | `isUnownedShellActiveIn(groupId)` | 删除（S4 已删） |
| 4727 | `syncGroupSubRowVisibility()` | **删除**（由 `reconcileRows` 取代） |
| 4774 | `resolveWorkspaceTabButtonHost(tabId, paneId)` | **删除** |
| 4825 | `stackShellTabOverHostGroup()` / `hideStackedShellTabsIn()` | **删除** |
| 4881 | `revealSerialGroupActiveTab(groupId)` | **删除** |
| 4872 | `lastSerialTabByPane`（Map） | **删除** |
| 5123 | `persistShellTabs()` 写 `ownerGroupId` / `detachedColumn` | 改为写 `hostGroupId` / `columnMode` / `columnId`（`main.js` 用 `{...tab}` 展开，新键能落盘） |
| 5136 | `createShellTab()` 的初值 | 改为 `hostGroupId: null` / `columnMode: 'row'` / `columnId: null` |

同批删除的还有：`syncShellTabLayer` / `activateShellTabInHost` / `placeShellTabs` / `resolveDisplayedTabIdInPane` /
`findWorkspaceTabButton` / `setShellOwnerGroup` / `detachedShellActiveTabId` / `isSyncingShellLayer` / `isShellColumnActive`，
以及 `applyGroupWorkspaceSplitLayout` / `syncGroupWorkspaceVisibility` 的旧实现（各退化为 `renderWorkspaceNow()`）。
`ensureShellColumnDom` **保留**——它建的正是模型 `OWN_COLUMN_ID` 那一列的真实容器。

### 10.2 保留并改造

| 位置（HEAD） | 现有实现 | 改造 |
|---|---|---|
| 1964–1967 | `filterTabsStore` / `chartTabsStore` + 别名 | 迁入 `workspace.tabs`，store 删除 |
| 1981 | `let shellTabs = [];` | 迁入 `workspace.tabs` |
| 4385 | `bindGroupTabListEvents(listEl)` | 泛化为 `bindTabListEvents(listEl)`，同时服务 TabRow 与 subRow |
| 4318–4410 | `buildGroupTabButton` / `updateGroupTabButtonState` | 泛化为 `buildTabButton` / `updateTabButtonState`，按 `isContainer()` 而非 `kind` 分支 |
| 3395 | `createGroupTabRowElement()` 内的 `bindGroupTabListEvents(list)` | 保留形态，改调 `bindTabListEvents` |
| `workspace-manager.js:357–375` | `applyLayoutToDom()` 的 `parentElement !==` 判定 | 保留（C2 的实现，不是临时补丁），但删除注入点 `resolveTabButtonHost` |

### 10.3 不可误改

`renderer.js:8503-8504` 的 `ownerGroupId` 是**串口端口占用**字段（对应 `main.js:3058` 的 `SERIAL_PORT_IN_USE` 协议），与 Shell 归属**完全无关**。全局删除 `ownerGroupId` 时必须排除此处，否则端口占用保护失效。

同名不同义本身就是重命名的理由：建议把端口占用的那个改名为 `portOwnerGroupId`。

### 10.4 删除量

| 维度 | 引用数（实测） |
|---|---|
| `ownerGroupId`（Shell 语义） | 15 |
| `detachedColumn` | 15 |
| `topRowColumnId` | 3 |
| `SHELL_COLUMN_GROUP_ID` | 12 |
| `shellColumnId` | 10 |
| `ensureShellColumnDom` | 3 |
| `hasDetachedShellColumn` | 2 |
| `isShellColumnActive` | 8 |
| `detachedShellActiveTabId` | 12 |
| `getShellTabOwner` | 13 |
| `setShellTabOwner` | 2 |
| `syncShellLayoutOwnership` | 3 |
| `stackShellTabOverHostGroup` | 4 |
| `hideStackedShellTabsIn` | 6 |
| `revealSerialGroupActiveTab` | 5 |
| `lastSerialTabByPane` | 3 |
| `isUnownedShellActiveIn` | 1（零引用） |

整体估计净减 **600–800 行**，Shell 相关顶层函数从 46 个降到约 25 个。这是「复用性强」的量化依据。

## 11. 分阶段实施

正向替换，不做大爆炸。每阶段独立可验证、独立可提交。

| 阶段 | 内容 | 状态 | 验证 |
|---|---|---|---|
| **S1** | `tab-model.js`：`{ tabs, focusedTabId, split }` 的读写、`rebuildIndex()`、§3 全部派生量、§6 全部不变式、`validateAndRepair()`。未接渲染。配套 `test/tab-model.test.js`（39 条）与独立验收器 `test/tab-model-acceptance.js` | ✅ `1e2b1b2` | 全量单测 |
| **S2** | 影子校验：`tabs-workspace-projection.js` 把现状只读投影成模型树；`renderer.js` 暴露只读诊断钩子 `window.__readTabModelPlan()`；`buildRenderPlan()` 与真实 DOM 逐项比对 | ✅ `cf8ec4d` / `0e8940e` / `be59884` | `verify-tab-plan-shadow` |
| **S3** | subRow 按 pane 一条；组内 pane 分屏；方案 A（扁平 + pane 分屏）落模型并实机测绘，修掉三处真缺陷 | ✅ `82a32eb` / `859933b` | `verify-flat-pane-split` |
| **S4** | 死代码清理、同栏顺序真源修复、全局动作入口不变量固化。**三态字段与叠层机制实测证明不能独立删**（§11.5.1），推迟到 S5 | ✅ `3ba9733` / `fb4a84a` / `89067dd` | `verify-tab-order` / `verify-add-entry` |
| **S5-①** | 配置迁移（§9.3）：`serial-groups-config.js` 显式产出 `panes` / `paneSplit` / `focusedTabId`，`renderer.js` 改读写这三个新键 | ✅ `7ce7c3c` / `00b5187` | `verify-layout-persist` 14/14 |
| **S5-②** | 分屏语义按用户裁决纠正；右键菜单入口补齐；关分屏后显示权归位 | ✅ `6088a70` / `9e8e681` / `78e653c` / `c8deeba` / `62e99dc` / `dacdcdd` | 15 脚本全量回归 |
| **S5-③** | `tabs[id].columnId` 成为「根级叶停在哪一列」的唯一真源；`layoutColumns()` 分屏分支只由容器决定列集合；严格判据扩到 36 项 | ✅ `80ea701` / `e18aa24` | `verify-tab-plan-strict` **36/36** |
| **S5-③'** | `columnMode`（是否自成独立列，全部共享 `OWN_COLUMN_ID`）与 `hostGroupId`（归属哪组下层行）进模型；老配置回落新键 | ✅ `bc0bb41` / `418dadc` / `80f4e98` / `73adab2` / `1929217` | 单测 558/558 + 严格判据 48/48 |
| **S5-④** | 渲染翻转：从零实现 `renderWorkspace()` 并接管 DOM（第 1–4 步 + 第五步 `sweepStaleColumns`），与三态字段 / 叠层机制**同批删除**；布局层交出全部 DOM 职责；焦点成为真实模块级字段 | ✅ `f2f02f4` | 全量 15 脚本全绿 + `verify-tab-plan-strict` **48/48**（含两个独立 Shell、上下分屏） |

**核心纪律**：所有交互只改 `workspace`，然后调 `renderWorkspace()`；不允许任何地方直接改 DOM。S2 之后若仍发现「某处直接 `appendChild` 标签按钮」，说明该处漏改。

**S1 必须先做，且必须带性质测试。** 模型是纯逻辑，可在 Node 里直接断言，零 GUI 依赖。模型层的 bug 若留到 S2 之后靠 CDP 排查，成本会高一个量级。

### 11.1 S1 的测试策略

手工用例追不上状态空间。S1 必须包含**性质测试**：用固定种子的伪随机操作序列跑几千步，每步断言 I1–I10。

```js
test('random operation sequences preserve all invariants', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const ws = createDefaultWorkspace();
    const rand = makeRandom(seed);
    for (let step = 0; step < 200; step++) {
      applyRandomOperation(ws, rand);        // 只调模型 API，不碰 DOM
      assertInvariants(ws, `seed=${seed} step=${step}`);
    }
  }
});
```

理由：本项目的标签缺陷多来自「某种操作序列下的状态不一致」，而不是单个函数的输入输出错误。性质测试是能在 S1 阶段覆盖这种不一致的唯一手段。

必须同时有一条**反向对照**：故意构造违反 I1 的 `ws`，确认 `assertInvariants()` 会报错——否则无法排除「断言恒真」。

**另有两条必须覆盖的回归用例**（它们正是第一版设计的致命缺陷）：

1. 扁平 + 有 Shell + 焦点在 Shell → TabRow 必须仍包含容器全部子 Tab；
2. 扁平 + 有 Shell + 焦点在 MAIN → 内容区必须显示 MAIN，而不是被 Shell 抢走。

### 11.2 S1 的实现情况（已完成）

交付两个文件，不涉及任何现有代码：

| 文件 | 内容 |
|---|---|
| `tab-model.js` | 纯逻辑模型。导出查找、派生、布局、写入、自愈与 `validateAndRepair()`，不 require 任何 Electron 或 DOM 模块 |
| `test/tab-model-acceptance.js` | **独立验收器**：不 require 模型的任何内部函数，按数据结构自己重算 I1–I10；并校验每条不变式在 `TAB_ARCHITECTURE.md` 里都有对应条目 |
| `test/tab-model.test.js` | 34 条用例：结构、扁平与族、两级分屏、激活、同栏重排、收起、关闭、归一化、自愈，以及固定种子的随机性质测试 |

两条**反向对照**已落地：I1–I10 每条都造了一个违规样本，确认验收器会点名报错（11 条用例）。没有这组用例的话，「全绿」无法排除「断言没在检查」。

实现阶段验证出的一条文档修正（已回写 §3.5）：族列在**未开 pane 分屏**时，内容区跟着焦点走，可能是容器内的叶，也可能是一个 shell；而**开了 pane 分屏**后，每个 pane 各显示自己的 activeTabId——此时不得再套用焦点，否则会返回一个不在任何 pane 里的面板 id。同时 `layoutRowsOf()` 在族列上的行数为 0（未开分屏）/ pane 数（开了分屏），不复用非族列的 1 条。

### 11.3 S2 的实现情况（已完成影子校验，后来由 S5-④ 翻转）

**本阶段与 §11 原计划不同的一点必须写清**：原计划是让 `renderWorkspace()` 直接接管 DOM，实现时改为先做**影子校验**。原因如下。

运行态仍分散在 `serialGroups` / `filterTabsStore` / `chartTabsStore` / `shellTabs` / `groupWorkspaceLayouts` 五处真源上（S5 才合并）。直接翻转意味着同时重写四条互相调用的路径、并删除单例借位机制，一步出错就不可回滚。因此先做一件事：用投影器把现状读成模型树，算出 `buildRenderPlan()`，再与**真实 DOM**（`offsetParent` + `getBoundingClientRect`，不看 `hidden` 属性）逐项比对。此阶段用户可见行为不变；零差异之后才允许翻转。

**S1 模型层被实测抓出的三处缺陷**（都是「模型与已被验证的真实行为不符」，不是实现小错）：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 未分屏 + 2 个分组时，TabRow 只列出 1 个分组标签，其余分组从界面整体消失 | 未分屏分支退化成「焦点所在的那一个根」 | 未分屏恒返回一列；扁平列各容器子项 + 根级叶，多容器列根级标签本身 |
| 2 | 分屏时所有列都显示同一个面板 | 普通列也套用了焦点 | 只有「未分屏」才跟随焦点；分屏后的列取自己容器的激活叶 |
| 3 | 未分屏 + 焦点是未归属 Shell 时，模型返回空集（但页面显示着 Shell） | 只处理了「焦点是叶」与「焦点是容器」两种，且焦点是 Shell 时它不在 family 内 | 去掉 `inFamily` 限定，未分屏时只要焦点是叶就显示它 |

另修了一处 `[column.id]` 兜底：列 id 可能是**容器 id**，而容器没有面板（I3），把它当面板返回会让下游拿到永远匹配不到的 id。

**投影器的对齐点**（容易写错、且写错会让校验变成自证）：

| 点 | 真实契约 |
|---|---|
| main 叶 id | `serial-group-dom.js` 的 `mainTabId(groupId)` → `tab-main` / `tab-main-<g>`，**每分组一个**，且落在 `panes[0]` |
| pane 内容 | 给了真实 `pane.tabIds` 时按它定归属与顺序，但 store 里已存在的 filter/chart 不能丢；shell 一律提出到根级（I1/I2） |
| 焦点 | 用当前激活分组的激活标签 |

**已知差异（不属于模型错，属 S3/S4 改造范围）**：分屏时现状把未归属 Shell 的**面板叠在**某分组面板上；未归属 Shell 的**按钮**在现状里留在 subRow。S4 删除这两套机制后，差异会自然消失。

**已验证**：`verify-tab-plan-shadow` 26/26 PASS、`renderer-diag=clean`（两种 profile 独立复跑）；全量单测 535/535；全量 CDP 15 个脚本全绿。

### 11.4 S3 的实现情况（进行中）

**S3 开头做的一件事：「扁平 + 组内 pane 分屏」（§5.5 方案 A）的实机测绘。**
此形态此前从未被任何脚本覆盖过，测绘结果决定 S3 要改什么：

| 观测 | 结果 | 结论 |
|---|---|---|
| 扁平、未分屏时的可见标签行 | 仅 `pane-1` 的 `.pane-tabs-header`，`#serial-group-tab-bar` 是 `hidden` | **方案 A 已天然成立**，无需改渲染 |
| 扁平 + pane 分屏时的可见标签行 | 恰好 2 条（pane-1 含 main、pane-2 含 filter） | 与方案 A 一致，但**模型当时算不出来** |
| 模型算出的该形态 | 一级行给容器全部子项 + 2 条 subRow | 同一标签会在两处可见，错误 |

**据此修掉的三处真缺陷：**

| # | 位置 | 症状 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | `tab-model.js` `layoutColumns()` | 扁平 + pane 分屏时一级行与 subRow 重复列出容器子项 | 扁平分支无条件 `flatMap(childrenOf)` | 新增 `flatPanesSplit` 判定；开启 pane 分屏时一级行只留根级叶（Shell） |
| 2 | `workspace-manager.js` `moveTabToPane()` | 布局里找不到源 pane 时，DOM 仍然被搬 → 布局与 DOM 永久不一致，`activeTabId` 违反 I6 | 忽略了 `moveWorkspaceTab()` 的 `null` 返回 | `const moved = ...; if (!moved) ensurePaneTabMembership(targetPaneId, tabId);` |
| 3 | `tabs-workspace-projection.js` | 同一 filter 标签会被归到两个 pane（违反 I3/I4）；空 pane 被补一个 main，使一个 main 叶同时属两 pane | 每个 pane 都无条件 push 全组 store 条目；且未排除「已被别的 pane 认领」的 id | 先算 `unassigned`（排除已存在与已认领），只补给「空 pane 或 pane-1」 |

第 2 条尤其值得记住：`prunePaneTabIds()` 与 `reconcileEmptyPanes()` 都只读 `tabIds`，所以
「DOM 搬了、布局没搬」这种损伤**永远不会被后续规整自愈**，而用户看到的只是「拖过去没反应」。

**新增验证与门禁：**

- `test/tab-model.test.js`：`flat mode with pane split keeps the top row free of duplicated pane children`、`flat mode with pane split still puts unowned shells on the top row`。
- `test/tabs-workspace-projection.test.js`：`projection never assigns one filter tab to two panes`。
- 只读诊断钩子 `window.__readTabModelPlan()` 增加 `sections`（深拷贝快照），用于区分「数据错」还是「模型错」。
- 新脚本 `verify-flat-pane-split`（11 项）：行数 = pane 数、标签不跨行重复、每行只装自己 pane 的标签、两内容区都激活、布局中 pane-2 确实拥有被移动的 tab、plan 一级行为空、plan 行数与真实 pane 数一致、plan 行互斥。

**已验证**：`node scripts/run-tests.js` 538/538；`verify-flat-pane-split` 11/11；`verify-tab-plan-shadow` 26/26；全量 CDP 15 个脚本全绿且 PASS 计数与基线逐条一致。

### 11.5 S4 的实现情况（已完成）

S4 原计划包含四件事：删三态字段、删叠层机制、拖拽改同栏重排、全局动作移入工作区级动作条。
实测后实际完成的是后两件加一项不变量固化，**前两件被证明不能独立做**。

#### 11.5.1 为什么三态字段与叠层机制推迟到 S5

先做静态引用统计（排除注释行）再读实际代码，结论是三个字段不是「冗余记录」，而是**现行渲染路径的输入**：

| 符号 | 引用数 |
|---|---|
| `getShellTabOwner` | 11 |
| `detachedShellActiveTabId` | 10 |
| `resolveShellTabHost` | 8 |
| `isSyncingShellLayer` | 7 |
| `isShellColumnActive` | 6 |
| `placeShellTabs` | 6 |
| `hideStackedShellTabsIn` | 5 |
| `syncShellWorkspaceLayout` | 5 |

`resolveShellTabHost(tabState)` 用 `getShellTabOwner()` 与 `tabState.detachedColumn` 做三分支，`placeShellTabs()` 按宿主搬 DOM，
`syncShellLayoutOwnership()` 按宿主把 Shell 登记进 / 摘出各分组布局。删掉这三个字段，等于把 Shell 的渲染决策从
「三态宿主」换成「读 `buildRenderPlan`」——**这就是渲染翻转本身**，而翻转排在 S5。

因此 S4 只删真正零引用的四个函数（`setShellDetachedColumn` / `hasUnownedShellTabs` /
`isUnownedShellActiveIn` / `detachShellTabFromGroupLayout`，提交 `3ba9733`），其余与 S5 同批。

#### 11.5.2 拖拽改同栏重排：发现并修掉一个真实缺陷

改拖拽前先实测「同一栏内拖动」是否已经正常，结果抓到一个两套真源的问题：

```
BEFORE      layout=[main,filter,chart]  dom=[main,filter,chart]
AFTER-DRAG  layout=[chart,main,filter]  dom=[main,filter,chart]   ← 分叉
```

根因：`applyLayoutToDom()` 只在「按钮宿主变了」时 `appendChild`，**从不按 `pane.tabIds` 排序**。
于是布局顺序与 DOM 顺序长期不一致，用户拖完看到标签弹回原位。

修法：新增 `syncTabOrderInPane(pane, tabsList)`，在 `applyLayoutToDom()` 的每个 pane 循环末尾按 `tabIds` 做相对插入排序。
三条限制保证不破坏 C2：

- 只在本列表内部比较相邻节点，被搬到外层行的 Shell（宿主不是本列表）不参与；
- 父节点未变的节点不搬动；
- 列表对象缺少 `insertBefore` 时安全跳过（早期单测替身只提供 `appendChild`）。

**修复前后对照**（同一探针，只差这一次代码改动）：

| profile | layout | dom | 判定 |
|---|---|---|---|
| diag530（修复前） | `[chart,main,filter]` | `[main,filter,chart]` | 分叉 |
| diag534（修复后） | `[chart,main,filter]` | `[chart,main,filter]` | 一致 |

提交 `fb4a84a`，附带两条单测（顺序相反时必须重排；顺序一致时必须零搬动）。

#### 11.5.3 全局动作：实测后决定不搬结构，改为固化不变量

§8.5 原本要把「新建分组」「新建 Shell」搬进工作区级动作条。实测三种形态的**真实可见入口数**：

| 形态 | 可见「添加串口」 | 可见「新建 Shell」 |
|---|---|---|
| 单分组 | 1（`#add-serial-group-inline-btn`） | 1（`#pane-1-new-shell-tab-btn`） |
| 多分组 | 1（`#add-serial-group-btn`） | 1（`#add-shell-tab-btn`） |
| 多分组 + Shell | 1 | 1 |

判据遍历自身与全部祖先的 `display` / `visibility` 并测量实际宽高，**不看 `hidden` 属性**
（本项目有 `button { display:inline-flex }` 覆盖 `[hidden]` 的历史）。

结论：`syncSerialGroupAddButtonLayer()` 与 `syncShellAddButtonVisibility()` 的互斥逻辑在工作，
§8.5 描述的「两个添加串口按钮」是**历史缺陷**且已修复。搬结构要改 `index.html`（`#workspace-root` 祖先链敏感）、
六处放置/回收函数，并同步约 15 个 CDP 脚本的点击入口，收益只是去掉一层判断——
**用户可见行为不变且现有实现没有缺陷时，不做高风险重构**。

因此改为把「各处恰好一个可见入口」固化为 `verify-add-entry`（8 条断言，含反向对照）。
结构统一留待 S5 渲染翻转同批处理。

#### 11.5.4 S4 的验证证据

| 维度 | 结果 |
|---|---|
| 全量单测 | 540/540（基线 538 + 新增 2） |
| 全量 CDP（15 个既有脚本） | 全部 `exit=0`、全部 `renderer-diag=clean`，PASS 计数与基线逐条一致 |
| `verify-flat-pane-split` | 11/11（方案 A 未回归） |
| `verify-tab-order`（新增） | 8/8，且 `drag-changed-order=true`、`dom == layout` |
| `verify-add-entry`（新增） | 8/8，含反向对照 |
| 静态门禁 | `node --check` ×2 通过、`check-renderer-module-load` 输出 `module body initialized without throwing`、`scan-undefined` 输出 `checked=92 missing=none` |

#### 11.5.5 反向对照的两次假失败（脚本缺陷，不是产品缺陷）

`verify-add-entry` 的反向对照最初连续两次失败，都不是产品问题：

1. 首次实现「把隐藏按钮强制显示」——它所在的祖先行整体是 `display:none`，去掉自身 `hidden` 依然不可见，构不出重复入口。
2. 改成克隆后，把克隆的 `id` 设为 `reverse-control-clone`，而匹配器是 `/add-serial-group/`，克隆直接隐身。

第二个由 `probe-visible-clone3` 的逐节点 `chain` 证据定位：`add-serial-group-btn` 是 `display:none`，
`add-serial-group-inline-btn` 的祖先链全部可见。修正后判据立刻数到 2，证明**断言确实有区分力**。

### 11.6 S5 的实现情况（已全部完成）

#### 11.6.1 五个部分（S5-①②③④）

| 阶段 | 做了什么 | 关键提交 | 证据 |
|---|---|---|---|
| ① 配置迁移 | `serial-groups-config.js` 显式产出 `panes` / `paneSplit` / `focusedTabId`；`renderer.js` 读写这三个键 | `7ce7c3c` / `00b5187` | `verify-layout-persist` 14/14；反向对照 12/14 |
| ② 分屏语义纠偏 | 回退「未归属 Shell 自占一列」；补齐普通标签的右键菜单；关分屏后显示权交还分组；单分组例外 | `78e653c` / `c8deeba` / `62e99dc` / `dacdcdd` | 15 脚本全量回归全绿 |
| ③ 落列真源进模型 | 新增 `tabs[id].columnId` + `resolveLeafColumnId()` / `setLeafColumn()`；`layoutColumns()` 分屏分支只由容器决定列集合；严格判据 24 → 36 项 | `80ea701` / `e18aa24` | `verify-tab-plan-strict` **36/36** |
| ③' 另两个叶级事实 | `columnMode`（是否自成独立列，全部共享 `OWN_COLUMN_ID`）与 `hostGroupId`（归属哪组下层行）；老配置回落新键 | `bc0bb41` / `418dadc` / `80f4e98` / `73adab2` / `1929217` | 单测 + 严格判据 48/48 |
| ④ 渲染翻转 | `renderWorkspace()` 接管列/行/按钮/面板（五步含 `sweepStaleColumns`）；布局层交出全部 DOM 职责；三态字段与叠层机制同批删除；焦点成为真实模块级字段 | `f2f02f4` | 15 脚本全量回归 + 严格判据 **48/48** |

#### 11.6.2 翻转前必须先对齐模型的原因（③ 必须先于 ④）

**因为模型需要先与真实 DOM 逐项相等，翻转才有比较基准。**

`renderWorkspace()` 的输入是 `buildRenderPlan(ws)`，而 `buildRenderPlan()` 之前对「根级叶停在哪一列」毫无概念——
它按 `roots()` 派生列，于是分屏时给 Shell 也派生一列。如果先写渲染层再去补模型，就会出现「新渲染层按模型画了 3 列，
而用户裁决要求 2 列」这种两边都错、且无法局部修复的状态。

所以顺序是：**先把模型与现状 DOM 对齐（③），再换渲染层去消费它（④）**。严格判据在 ④ 之前已证明
模型在八类形态（单组 / 双组未分屏 / 分组分屏 / 带 Shell 分屏 / 关分屏 / pane 分屏 / 三列 / Shell 归属某组）
下与真实 DOM 逐项相等——这就是 ④ 的安全网。

#### 11.6.3 ③ 的两次无效修复与真正的根因（可直接复用的教训）

| 次 | 改动 | 结果 |
|---|---|---|
| 1 | 投影器裸读 `tabState.topRowColumnId` | 仍 22/24（该字段首次为 `null`，回落第一列） |
| 2 | 改用 `resolveShellTopRowColumn(tab)` | 仍 23/24，且两份诊断输出**字节完全相同** |
| 3 | 发现 `normalizeTabIds()` 只保留 `id/kind/title`，**把 `columnId` 丢了**，补上 | **24/24** |

**教训**：连续两次改动后输出字节完全相同 = 改动不在生效路径上。此时应逐跳读数据传递链，而不是在下一层继续猜。
`normalizeTabIds()` 是一个把对象**重建成只含白名单字段**的函数——任何新增字段默认都会在这里被静默丢弃。

#### 11.6.4 ④ 落地时修掉的七类真实缺陷（都有实测取证）

| # | 缺陷 | 根因 / 修法 |
|---|---|---|
| 1 | 关分组直接招 `ReferenceError: shellMovedOut is not defined` | 删叠层时漏掉的变量；改为无条件遍历摘 `hostGroupId` |
| 2 | 建分组标签按钮招 `describeGroupTab is not defined` | 只解构了 `describeGroupTabBar`，补进 require 解构 |
| 3 | 点 Shell 无反应（`workspaceTabOf is not defined`） | 重写 `setFocusedTab` 时误删两个只读辅助函数，补回 |
| 4 | 非分屏且激活组≠default 时「添加串口 / 新建 Shell」按钮落进隐藏行 | `getVisibleGroupRow` 恒返回静态行；改为「取该列自己的行，未隐藏就用它」 |
| 5 | 新建 Shell / 新建过滤页后屏幕不切 | `switchPaneTab` 只写 `panes[].activeTabId`，而模型未分屏时跟 `focusedTabId`；补写焦点 |
| 6 | 把主终端拖到第三位后下次投影又弹回第一位 | `projectWorkspace` 无条件 `unshift(mainId)`；改为声明里保位、只在缺失时补队首 |
| 7 | 关分屏后 Shell 标签静默消失 / 幽灵 Shell 列 | 拆列太早（按钮与面板还在里面）+ 非分屏下 `domKey` 取了 `OWN_COLUMN_ID`；拆列移到四步后的 `sweepStaleColumns`，`domKeyOf` 加非分屏守卫 |

#### 11.6.5 ④ 的验证证据

| 维度 | 结果 |
|---|---|
| 全量单测 | 557/557 |
| `verify-tab-plan-strict` | **48/48 PASS**，renderer-diag=clean（含两个独立 Shell、上下分屏） |
| `verify-tab-order` | 8/8；`verify-shell` 16/16；`verify-shell-drag` 24/24；`verify-shell-switchback` 14/14 |
| 其余既有脚本 | `verify-user-paths` 15/15、`verify-group-columns` 37/37、`verify-group-split` 19/19、`verify-context-menu-and-highlight` 17/17、`verify-split-geometry` 26/26、`verify-shell-buttons-split` 16/16、`verify-no-tab-flash` 18/18、`verify-titles` clean、`verify-sidebar-groups` 14/14、`verify-display-pref-scope` 24/24、`verify-connect-group` 23/23、`verify-same-port-guard` 15/15、`verify-layout-persist` 14/14 |
| 静态门禁 | `node --check` ×4 通过；`check-renderer-module-load` 通过；`scan-undefined` missing=none |

**两处验证脚本的步骤修正（不是产品缺陷，断言未改）**：`verify-split-geometry` 与 `verify-shell-buttons-split` 的 setup 段建了三个分组，
却按旧的「只有参与分屏的分组才可见」语义断言 2 列——该语义已随 ④ 删除（列集合只由容器决定）。
处理方式是**只改步骤不改断言**：两列段真的只留两个分组，第三个分组挪到三列段再建。

#### 11.6.6 ④ 剩下的已知边界

- 渲染层仍保留少量兼容旧调用方的薄封装（`renderSerialGroupTabBar` / `applyGroupWorkspaceSplitLayout` / `syncGroupWorkspaceVisibility`），它们只调 `renderWorkspaceNow()`。
- `ensureShellColumnDom` 必须保留：它建的正是模型 `OWN_COLUMN_ID` 那一列的真实容器。
- `syncSerialGroupAddButtonLayer` / `syncShellAddButtonVisibility` 保留：按钮分层仍然有意义（§11.5.3）。



## 12. 扩展点

「通用」不能自证，只能用「新增东西要改几处」量化。目标：**零改动**。

| 新增内容 | 需要改的地方 |
|---|---|
| 一种新叶（如「波形」） | ① `kind` 字符串；② panel 内容渲染函数。布局、父级、显隐、菜单全部复用 |
| 一种新容器（如「工作集合」） | ① `kind` 字符串；② 它的 panel 若需内容则补。布局、子 Tab 管理、收起、分屏全部复用 |
| 一种新的行内动作 | 只在 `reconcileButtons()` 里加一个按钮 |
| 一种新的全局动作 | 只加进工作区级动作条（§8.5），不涉及任何层数判断 |

反面清单（**不允许**出现）：

- `if (kind === 'shell')` —— Shell 的差异由 I1 / I2 在模型层保证，不靠渲染层特判；
- `if (serialGroups.length > 1)` —— 唯一判据是 `isFlat(ws)`；
- `if (paneSplit.enabled)` 出现在渲染层 —— 行数由 `layoutRowsOf()` 一次算出；
- 渲染层出现 `roots` / `childrenOf` / `rootFamilyOf` —— 说明 `buildRenderPlan()` 的产出不够。

## 13. 已知边界

**模型层与渲染层均已实现，渲染层已翻转（S5-④ 已完成）。** 下文里标「未验证」的项，
指的是尚未做过用户手测的体验类问题，而不是实现缺失。

当前已具备的证据：`tab-model.js` 全部派生量与 I1–I10 有性质测试（120 种子 × 120 步）；
`buildRenderPlan()` 在**渲染层已消费它**的前提下与真实 DOM 在 10 类形态下逐项相等（`verify-tab-plan-strict` 48/48）。
以下事项仍需在实际操作中重新取证：

| # | 未验证项 | 说明 |
|---|---|---|
| 1 | 两级分屏同时开启的实际观感 | §4.3 的四种组合中，「列开 + pane 开」只有设计推演 |
| 2 | 扁平 + 多 pane 的标签焦点视觉 | 已裁决方案 A（N 条 subRow）；实机观感与焦点切换待验证 |
| 3 | 真实鼠标拖动分界条的手感与最小宽度 | 现有证据仅为合成 `PointerEvent`；硬限 `MIN_SHARE = 0.1` |
| 4 | 四条以上分屏时每一条分界条的独立拖动 | 只有三条的实测 |
| 5 | 窗口尺寸变化后旧比例是否仍然合理 | 未验证 |
| 6 | 两级分屏下 xterm `fit()` 从 `display:none` 切回的尺寸 | 未肉眼确认 |
| 7 | 迁移后旧配置的实际恢复效果 | 需要真实旧版配置样本 |
| 8 | 工作区级动作条在窄窗口下的换行表现 | 新增 UI 元素，未设计 |

既有验证缺口（与本模型无关，但同样未解决）：

- 任何多串口特性都没有做过真实的**双端口字节流端到端**验证。
- per-group 作用域下两组同时收数据时各自的日志前缀 / 回显，只有 `getPrefix()` 直接调用的证据。
- 标签切换闪烁的修复（`0bf62ea`）只有 CDP 合成点击 + `getComputedStyle` 证据，未做真实用户手测。

## 14. 需求覆盖核对

| 需求 | 落点 | 是否完整 |
|---|---|---|
| 四个原语：Tab / TabRow / subRow / tabPanel | §1 | ✅ |
| Tab 可放在 TabRow 或 subRow 中 | §3.3 `layoutColumns()` 的 `tabItems` / `rows` | ✅ 且明确「同一 Tab 永不两处同时出现」（I4） |
| subRow 可以被收起 | §8.3（含「按钮必须挂在 TabRow」的可恢复性约束） | ✅ |
| tabPanel 对应一个 Tab | §1.5 + I3 | ✅ |
| 串口组、main、filter、chart、shell 都是 Tab | §1.1 / §1.2 | ✅ 用 `isContainer()` 而非 `kind` 区分容器与叶 |
| 组内 pane 分屏保留 | §4.2 + §5.5 | ⚠️ 与「单组时 subRow 不可见」组合时需裁决，见 §5.5 |
| 分屏分为 TabRow 级与 subRow 级 | §3.3–§3.4 + §4 | ✅ 二维分离，互不引用 |
| 只有一个串口组时 subRow 不可见，main/filter/chart/shell 都在 TabRow | §3.3 族列 + §5.2 | ✅（附两条针对性回归用例，§11.1） |
| 新建架构设计文档 | 本文件 | ✅ |

## 附：一句话总结

**三个字段 + 一组派生量 + 一个渲染计划。** 标签的「位置」不再是数据，而是结构的投影；「扁平」不是另一种实现，而是同一条 TabRow 上的一次族展开。

---

**相关文档**

- `MULTI_SERIAL_DESIGN.md` §6A —— 多串口实现的背景描述（标签体系部分以本文为准）
- `agent_notes.md` §13A.9–§13A.15 —— 标签相关的历次缺陷与教训
- `ToDo.md` —— CDP 验证清单（15 个脚本 / 281 条断言）

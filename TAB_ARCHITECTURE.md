# 标签体系架构设计：Tab / TabRow / subRow / tabPanel

> **重构修订入口：[MULTI_SERIAL_REFACTOR.md](MULTI_SERIAL_REFACTOR.md)**。本文保留旧阶段设计。后续以新方案的显式布局状态、统一动作和模式迁移为实施目标；位置是需要保存的布局数据，不放在业务 Tab 上。单组所有叶标签可自由分屏，多组串口子标签不脱组、Shell 仅在一级栏；旧的“Shell 永远不进 pane”以及“多组 Shell 可进本组 pane”等冲突描述均不再适用。

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

### 5.5.1 Shell 的分屏形态：自成第二列（方案 1，已实现）

上面语义 1 / 2 回答的是「subRow」维度的形态，Shell 在那一维里**永远不存在**（I1 / I2）。
但「Shell 能不能分屏」是另一个问题：Shell 的按钮住在一级 TabRow，它不能进 pane，
所以它无法与串口标签上下分行。在不放宽 I1 / I2 的前提下，Shell 唯一可用的分屏形态是
**同列旁边自成第二列**（`columnMode === 'ownColumn'`）。

单串口组下这条路径原先不可用，原因不在 `ownColumn` 本身，而在列级分屏的总闸：
`buildLiveWorkspaceSections` 写的是 `groupIds.length > 1`，而 `setGroupWorkspaceSplit`
开头就 `if (candidates.length < 2) return;`。单分组下 `groupIds` 永远只有一项，
`layoutColumns` 走非分屏分支只返回一列，`ownColumn` 写了也看不出变化
（实测 `doc-1263.txt`：`columnMode` 已是 `ownColumn`，`columnCount` 仍是 1）。

现行规则：

1. `detach-to-own-column` 在写 `columnMode` 之外，还会调 `ensureColumnSplitForShellColumn`
   把「该分组」**并入** `groupWorkspaceSplit.groupIds` 并打开开关。**并入而不是覆写**：
   多分组已分屏时覆写会把其它分组踢出参与者表（实测 `verify-four-defects` 的
   `b6-column-count-restored`：`beforeJoin:4 → afterJoin:1`）。
2. 列级分屏是否生效的唯一判据是 `isColumnSplitActive()`：开关已开、且
   `columnSplitKeys()`（存活的 `groupIds` + 是否存在独立列）去重后 ≥ 2。
   `buildLiveWorkspaceSections` 的 `split.enabled` 与 `pruneGroupWorkspaceSplit` 的退出条件
   都改用它，否则「只有 1 个分组 + 1 个独立列」会被旧判据当成「没分屏」或「该复位」。
3. `close-group-split` 先把所有 Shell 的 `columnMode` 收回 `row` 再复位分屏；
   `join-group-column` 收回后调 `collapseColumnSplitIfSingleColumn()`。
   不写这两处就会出现「菜单说已关分屏、屏幕仍两列」。

**这一条不影响 §5.5 语义 1 的「默认不渲染 subRow」**：`ownColumn` 是**列**，不是 subRow。
单分组下不开 pane 分屏时仍然一条 subRow 都没有。

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

**一条实际事故（已在 2026 修复）**：推论 1 / 2 是推论，不是自动护栏。
`createShellTab` 曾经在创建时调 `addTabToOwningGroupPane(tabId, resolvedPaneId, ...)`，
把新 Shell 写进了 `panes[].tabIds`（实测 `sgsint-1262.txt`：
`pane-1.tabIds = ["tab-main","tab-shell-1"]`），违反 I2。它可以一直不被发现，因为
模型层的 `projectWorkspace` 会把 shell 重新提到根级（`tabs-workspace-projection.js` 里
写着「shell 不进 pane（I1/I2），无论真实 tabIds 里有没有它」）——于是**投影后的
计划是干净的，而渲染层那份布局对象是脏的**。两个可观测后果：

- 右键菜单的 `canSplit` 数的是渲染层布局的 `panes[].tabIds.length`，被这条脏数据
  喂成 `true`，菜单项看起来可点；
- 真正执行时 `splitWorkspaceTabIntoPane` 遇到 Shell 直接返回 `false`，于是
  「菜单能点、点了没反应」。

教训：`projectWorkspace` 的容错不能当成「脏数据无害」的依据。凡是在渲染层自己
维护的布局对象上写东西，必须同时满足 I1 / I2，而不是指望投影把它洗干净。

### 6.1.1 I2 必须在**归一化**处强制，不能只在投影层容错

上一条的根因是「写入端违反 I2」，但同类缺陷还有第二个入口：**旧配置把 shell id 写进了
`panes[].tabIds`**。如果归一化只校验「非空字符串 + 未重复」，脏数据就会被原样接受，
于是 I2 在数据层长期不成立，只是被投影层掩盖。**实测事故**（`rcd-1500.txt` /
`rca-1501.txt` / `rcdrag-1502.txt`）就发生在用户真实配置里：顶层
`workspaceLayout.pane-2.tabIds = ["tab-shell-3"]`。

它一次造成四个症状，且都不在渲染层：

| 症状 | 机制 |
|---|---|
| 空右分屏 | `reconcileEmptyPanes` 见 `filled.length > 1` 就不折叠；投影层把 shell 提到根级后该 pane 实际为空，屏幕留下一个零标签 pane |
| Shell 点不开 | `visiblePanelIdsOfColumn` 在 `rows.length > 1` 分支只看各行的 `activeTabId`，从不看**列首行的根级叶**；焦点写对了，`panelIds` 却不变 |
| 拖不进去 | 空 pane 的标签行 `height === 0`，落点命中不到行，只写成了 `hostGroupId` |
| 右键无反应 | `canSplit` 数到了 pane 里的脏 shell id，菜单项可点；`splitWorkspaceTabIntoPane` 对 shell 硬拒 |

因此现行规则是：

1. **`normalizeLayoutShape` 必须剔除 `panes[].tabIds` 里的 shell id**（`isShellTabId`）。
   剔除后该 pane 若变空，交给 `reconcileEmptyPanes` 按既有规则收敛 —— 于是「旧配置
   带脏数据」启动后自然回到单 pane，而不是渲染出一个空分屏。
2. **任何合并 pane 的地方都不得搬 shell id**（`collapseSplit()`）。合并是无条件的，
   不拦就是在每次「关闭分屏」时批量制造新的 I2 违规。
3. **`canSplit` 必须按「单组 / 多组」分叉**（**用户裁决后改写，完整依据见 §6.1.3**）。
   旧版这里是全局判据「有 ≥ 2 个非 shell 标签 且 被右键的标签自己可移动」，隐含前提是
   「Shell 只能靠独立成列分屏，永远不进 pane」。**该前提已被用户裁决推翻**：单串口组下
   所有标签（含 Shell）地位平等、可随意分屏，Shell 可以住进任意 pane。
   若继续用旧判据，单组下 Shell 的「左右/上下分屏」会**恒置灰**，与「所有标签等价」直接矛盾。
   现行判据：
   - **多串口组**：仍是 `totalTabs >= 2 && !isShellTabId(tabId)`，Shell 的菜单如实置灰；
   - **单串口组**：把「受托管但不在 `panes[].tabIds` 里的 Shell」另算一份，
     即 `totalTabs + shellCount >= 2`，Shell 自己也可被右键分屏。
   旧断言**没有作废**，只是**适用范围被收窄到多组**；多组下的反向对照用例仍必须全绿。
   I2（`panes[].tabIds` 不含 shell id）**一个字未改**：Shell 只是通过叶级 `hostPaneId`
   被 `layoutRowsOf` 并进**派生的** `rows[].tabIds`，见 §6.1.3。
4. **`visiblePanelIdsOfColumn` 的 `rows.length > 1` 分支要能给列首行的根级叶点亮面板**，
   判据限定「焦点确实是本列根级叶」，否则 Shell 会同时出现在每一列。
   该分支还必须覆盖**某条 pane 行里的**受托管叶（带 `hostPaneId` 的 Shell）：
   否则会出现「按钮在那一行里、点也点得中，但内容区永远不亮」。
5. **`detach-to-own-column` 入口在单串口组下必须关闭**（UI + 逻辑两道门）：
   单组只有一个容器，分屏只能靠 pane；「独立列」是多组才需要的概念。见 §6.1.3。

这几条把 I1 / I2 从「投影层的容错假设」变成「数据层的硬前置」，与 §6.2 的状态自愈
配合：归一化是每一条读入路径（`restoreWorkspaceLayout` / `createLayoutFromGroupConfig` /
`getGroupWorkspaceLayout`）的共用入口，脏数据在那里就被清掉。



### 6.1.2 pane 标签行的 contextmenu 委托必须「按容器绑」，不要逐个 id 补

右键菜单的机制本身是**事件委托**，不是给每个标签按钮挂监听。`bindPaneTabListEvents(listEl)`
对一个 `.pane-tabs-list` 容器挂一次 `contextmenu`，靠 `event.target.closest('.main-tab')`
反查被点的按钮，所以标签按钮后来被 `appendChild` 进来也能正常响应；它自带幂等保护
（`listEl.dataset.paneTabEvents === '1'` 就直接 return），重复调用不会挂两遍。

**出过的事故**：`index.html` 里静态写死了两个 pane（`#pane-1` 与初始 `hidden` 的 `#pane-2`），
而绑定入口散在四处：

| 入口 | 覆盖范围 |
|---|---|
| `createPaneElement` 内 | **只覆盖新建的 pane** —— 首行 `if (!paneId || getPaneDom(paneId)) return null;` 使静态 `pane-2` 直接早退，走不到那里的绑定 |
| `createGroupPaneElement` 内 | 非默认分组的动态 pane |
| `ensureShellColumnDom` 内 | Shell 独立列 |
| 模块加载期手写 | 只硬写了 `pane-1`（还重复了一行） |

于是主终端与过滤页上下分屏后，下方 pane 的标签行上**一个 `contextmenu` 监听都没有**，
右键完全无反应（实测 `pcm-1600.txt`：`pane-1` 发出 1 次 `show-terminal-context-menu`，
`pane-2` 发出 **0** 次）。这是一处「覆盖漏了」的缺陷，不是委托机制本身的问题。

因此现行规则是：

1. **静态 pane 由模块加载期一次性扇描覆盖**：
   `document.querySelectorAll('#group-workspace .pane-tabs-list').forEach(...)`。
   `#group-workspace` 是所有分组列的公共父容器（含非默认分组的静态列），所以这一扇扫
   同时覆盖默认分组的 `pane-1` / `pane-2` 与其它分组列里已存在的静态列表。
2. **不要逐个写 id**。以后再往 `index.html` 里加静态 pane，或者哪个构造路径忘了自己绑，
   扇扫都能补上；逐个写 id 必然再漏。
3. **动态新建的 pane 与 Shell 独立列仍由各自构造器在建节点时绑**。那不是「重复」，
   而是新节点产生时必须有个绑定点；幂等保护保证扇扫与构造器叠加调用也不会挂两遍。
4. **不要维护「哪些已经绑过」的名单**。幂等判据已经在 DOM 的 `data-pane-tab-events` 上，
   再维护一份名单只会多出一处会与实际状态分叉的数据。

> 判读提醒：**冗余代码 ≠ 行为缺陷**。事故初期读到这里是「两次相同调用」就判为「右键会弹两次
> 菜单」，实测 `pane-1` 恰好 1 次才纠正过来 —— 幂等保护让重复调用完全无害。定性必须靠实测行为，
> 不能靠「看起来重复」。

### 6.1.3 单串口组自由分屏 / 多串口组按组归属（`hostPaneId`）

#### 用户裁决

> 「串口标签拖到 Shell 列之后，应该变成什么？当只有一个串口组时，串口标签页应该要可以随意分屏拖动，
> 有多个串口组，每个组的标签不能脱离组」
>
> 「单串口组时所有标签都在一级栏，所以「把 shell 标签可拖到二级标签栏的需求删除，
> shell 标签只能在一级栏」也是没问题的；**A. 旧裁决只管多组更贴切**」

第一条裁决是「要什么」，第二条是它在与旧裁决冲突时的解释：**旧裁决「Shell 只能在一级栏」
只在多组下有效**。两句合起来的决定性推论是：

> **单串口组时不产生 Shell 独立列。** 单组只有一个容器，它的「分屏」只能是 **pane 分屏**；
> 「独立列」是多组才需要的概念（每个组一列 + Shell 自成一组）。

#### 规则表（单组 vs 多组的唯一分叉点）

| 场景 | 单串口组 | 多串口组 |
|---|---|---|
| 串口标签拖到另一条 pane 行 | ✅ 允许（`moveTabToPane`） | ❌ 跨组禁止；组内允许 |
| Shell 拖到某条 pane 行 | ✅ 写 `hostPaneId` | ❌ 跨组禁止；本组 pane 行允许 |
| Shell 拖到分组标签行 | ⛔ 该行不存在 | ✅ 维持现状（`hostGroupId`） |
| `canSplit`（左右/上下分屏） | ✅ **对 Shell 也开放** | ❌ 对 Shell 置灰 |
| `canDetach`（独立成列） | ⛔ **恒为 false** | ✅ 维持现状 |
| `detach-to-own-column` 动作 | ⛔ handler 直接拒绝 | ✅ 维持现状 |

#### 唯一的模型新增事实：`hostPaneId`

`hostGroupId` 只到**容器**级，派生时被无条件并入 pane-1 那条行。于是 Shell 永远只能待在第一个 pane，
无法和串口标签一起参与组内 pane 分屏 —— 用户看到的就是「shell 标签拖不动」。
`hostPaneId` 是同一模式的**下一层精度**：

| 字段 | 粒度 | 含义 |
|---|---|---|
| `hostGroupId` | 容器级 | 这个叶挂靠在哪个分组的下层行 |
| **`hostPaneId`** | **pane 级** | 这个叶住进该容器的**哪一条** pane 行 |
| `columnId` | 列级 | 停在哪一列的列首行（未归属时才有意义） |
| `columnMode` | 列级 | 是否自成独立列 |

实现要点：

1. **写入点唯一**：`setShellHostPane(tabId, paneId)`；它对非字符串 / 空串一律写 `null`，
   写值时把 `columnMode` 清回 `row`（与「独立列」两向互斥，同 `hostGroupId` ⇄ `ownColumn`）。
2. **派生点唯一**：`layoutRowsOf` 按 `leaf.hostPaneId` 分派到对应 pane 行。
   没有指定、或指向一条已不存在的 pane（关分屏 / 删 pane / 切分组之后），**回落 `base[0]`**：
   宁可让标签回到第一格（还看得见），也不能静默丢掉。
   这个校验在投影层还有一道 `hostPaneIdBelongsToGroup`，防止坏 id 被写出去。
3. **`panes[].tabIds` 一个字不动（I2 不变）**。合并发生在**派生出来的** `rows[].tabIds` 上：
   `base` 是 `panes.slice()` 的浅引用，合并时新建对象，原 pane 不受影响。
4. **旧配置零迁移**：旧配置根本没有这个字段，`null` 就是「未指定」，行为与升级前完全一致。
   投影层（`tabs-workspace-projection.js`）是**白名单重建**，必须显式列入 `hostPaneId`，
   否则会被静默丢弃 —— 这里踩过一次：字段在 `sections.shellTabs` 里是对的，
   穿过投影后变成 `undefined`，表现就是「写进去了但 Shell 又回到第一格」。

#### 两处需要与 UI 同步关闭的入口

只改 `canDetach` 不够——它只让菜单项置灰，**动作仍可被其它路径调用**（快捷键、脚本、旧测试）。
所以单组下：

- `requestWorkspaceTabContextMenu` 返回 `canDetach: Boolean(shellTab) && multiGroup`；
- `detach-to-own-column` 的 handler 首部再判一次 `isMultiGroupLayer()`，不成立就 `break` 并给出提示。

同理，`splitWorkspaceTabIntoPane` 必须在入口校验「这个 tabId 真的存在」：
少了这一道，任何幽灵 id 都会新建 pane、打开分屏，布局被改过一次而用户看不到任何变化。
注意**不能用 `getTabPaneId()` 当存在性判据**——它对找不到的 id 会回落到 `'pane-1'`，恒为真；
要用 `isLiveWorkspaceTabId()`。

#### 多组跨组拦截只有一处

`finishWorkspaceTabDrag` 入口：判「目标 pane 属于哪个分组」与「这个标签自己的分组」是否一致，
不一致就静默 `return`（标签弹回原位）。**单组时「目标组 = 源组」，这道门恒开**，所以不需要额外分支。

#### 环境边界

以上全部通过 CDP 合成输入验证（`verify-single-group-free-split` 9 项、`verify-single-group-shell-split` 19 项、
`verify-restore-from-config` 12 项）。**CDP 合成拖拽 ≠ 真人手测**；本机无互连串口对、无 `com0com`，
未做双端口收发回环。


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
| 普通分组列的**分组标签行**（列首行） | `setLeafHostGroup(ws, leafId, null)` + `setLeafColumnMode(ws, leafId, 'row')` + `setLeafColumn(ws, leafId, 该列 id)` | 停在那列的列首行；**不新建列** |
| 共享 Shell 独立列自身（`OWN_COLUMN_ID`） | `setLeafHostGroup(ws, leafId, null)` + `setLeafColumnMode(ws, leafId, 'ownColumn')` | 进共享独立列 |
| 某组的下层标签行 | `setLeafHostGroup(ws, leafId, groupId)`（自动把 `columnMode` 清回 `row`） | 住进那组的 pane-1 下层行 |
| 某一列的列首行（程序化写入） | `setLeafColumn(ws, leafId, columnId)` | 停在那列列首行 |

> **旧语义已作废（重要）**：本文早期版本的第一行写的是「拖到分组标签行 → `columnMode='ownColumn'` → 进共享独立列」。
> 那个语义已被用户实测裁决修正：多组左右分屏后把 Shell 拖回原来那一屏，旧语义会凭空建出第三列，用户报告为
> 「shell 无法拖回到原来屏，拖动后会跑到新建第三分屏」。现行规则是**只有拖到共享 Shell 独立列自身或明确的独立成列动作才置 `ownColumn`**；
> 拖到普通分组列的列首行只是「停到那一列的列首行」。`ownColumn` 与 `hostGroupId` 两个写入口仍然两向互斥。
> 对应实现：`updateWorkspaceTabDrag` 里落点存的是**列的 groupId**（`rowTarget.groupId`），不是行元素 id——行元素上没有 `data-group-id`，
> 旧代码拿 `row.id` 反查恒为 `undefined`，写不进 `columnId` 就会落到兜底分支、变成新建第三列。

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

| 形态 | 可见「添加串口」 | 可见「新建 Shell」（S4 当时的规则，已被 §11.6.11 推翻） |
|---|---|---|
| 单分组 | 1（`#add-serial-group-inline-btn`） | 1（`#pane-1-new-shell-tab-btn`） |
| 多分组 | 1（`#add-serial-group-btn`） | 1（`#add-shell-tab-btn`） |
| 多分组 + Shell | 1 | 1 |

判据遍历自身与全部祖先的 `display` / `visibility` 并测量实际宽高，**不看 `hidden` 属性**
（本项目有 `button { display:inline-flex }` 覆盖 `[hidden]` 的历史）。

结论：`syncSerialGroupAddButtonLayer()` 的「添加串口只在单分组时留 inline 入口」在工作，
§8.5 描述的「两个添加串口按钮」是**历史缺陷**且已修复。

**这一节的「新建 Shell 恰好一个可见」结论已于后续被用户裁决推翻**：用户明确要求一级与二级
标签栏的新建 Shell 图标**永久同时显示**，并由此暴露了 `getVisibleGroupRow` 只看行、不看列的落位缺陷。
完整取证与修法见 §11.6.11。搬结构（把两个入口并进工作区级动作条）这个方向仍然没有做，
理由不变：`index.html` 的 `#workspace-root` 祖先链敏感、要改六处放置/回收函数、要同步约 15 个
CDP 脚本的点击入口，而这并不能减少「按钮落在看不见的列里」这类缺陷——那类缺陷的根因是**判据散落**，
不是结构位置。

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
| 全量单测 | **567/567**（557 → 564 补齐三形态与反向对照；564 → 567 补「列级比例归一化」三条） |
| `verify-tab-plan-strict` | **48/48 PASS**，renderer-diag=clean（含两个独立 Shell、上下分屏） |
| **`verify-tab-plan-shapes`（后续新增）** | **29/29 PASS**，renderer-diag=clean（未分屏多受托管叶 / 五列 / 多 Shell 混合） |
| `verify-tab-order` | 8/8；`verify-shell` 16/16；`verify-shell-drag` 24/24；`verify-shell-switchback` 14/14 |
| 其余既有脚本 | `verify-user-paths` 15/15、`verify-group-columns` 37/37、`verify-group-split` 19/19、`verify-context-menu-and-highlight` 17/17、`verify-split-geometry` 26/26、`verify-shell-buttons-split` 16/16、`verify-no-tab-flash` 18/18、`verify-titles` clean、`verify-sidebar-groups` 14/14、`verify-display-pref-scope` 24/24、`verify-connect-group` 23/23、`verify-same-port-guard` 15/15、`verify-layout-persist` 14/14 |
| **`verify-four-column-drag-fit`（后续新增）** | **39/39 PASS**，renderer-diag=clean（diag889）：4 列 3 条分界条、真实 OS 级鼠标拖第 2/第 1 条、反向对照、两档窗口 1280×800 / 900×640、隐藏列不 refit、切回后 refit |
| **`verify-native-context-menu`（后续新增）** | **12/12 PASS**，renderer-diag=clean（diag881）：可见 `Chrome_WidgetWin_2` 从 0 → 1 → Escape 后回 0，并用 `PrintWindow` 抓到菜单四项 |
| **`verify-two-port-isolation`（后续新增）** | **21/21 PASS**，renderer-diag=clean（diag913）：单端口真实字节流 + 双端口同时打开下的隔离；**未做双端口回环**，见 §13 |
| 静态门禁 | `node --check` ×4 通过；`check-renderer-module-load` 通过；`scan-undefined` missing=none |

**两处验证脚本的步骤修正（不是产品缺陷，断言未改）**：`verify-split-geometry` 与 `verify-shell-buttons-split` 的 setup 段建了三个分组，
却按旧的「只有参与分屏的分组才可见」语义断言 2 列——该语义已随 ④ 删除（列集合只由容器决定）。
处理方式是**只改步骤不改断言**：两列段真的只留两个分组，第三个分组挪到三列段再建。

#### 11.6.6 补测：三类此前零覆盖的形态（新增）

`verify-tab-plan-strict` 的 48 项只覆盖单形态组合。剩下的三类形态此前**一支脚本都没有**，
而标签体系历史上恰恰是组合形态出错（11.6.4 的七类缺陷里有三类是组合错）：

| 形态 | 模型侧新增用例 | 真实 DOM 侧判据 |
|---|---|---|
| 未分屏 + 多分组 + **多个受托管叶** | `split off with several hosted leaves keeps every leaf in exactly one place` | `shape-a-*`（13 项） |
| **五列**（4 容器 + 一个共享独立列） | `four containers plus one shared own column keep five columns in root order` | `shape-b-*`（8 项，含 4 条分界条） |
| **多 Shell 混合**（列首行 / 独立列 / 受托管） | `mixed shell placements never put one shell in two columns` | `shape-c-*`（8 项，逐个 Shell 验真实宿主列表） |

**补测直接抽出三处模型缺陷**（不是测试写错）：

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 先挂进某组、再拖到分组标签行 → 同一叶同时进独立列与那组的下层行（独立列**一个按钮都没有**） | `setLeafColumnMode('ownColumn')` 只改 `columnMode`，不清 `hostGroupId`；反向的 `setLeafHostGroup` 会清 `columnMode`，只清了一个方向 | 两个写入口**两向互斥**：切成独立列时同时 `hostGroupId = null`；`validateAndRepair` 不再需要猜 |
| 2 | 扁平 + pane 分屏 + 受托管叶 → 该叶同时出现在一级行与 pane-1 行 | 扁平分屏分支只排除了容器，没排除受托管叶 | 一级行 `filter(tab => !isContainer(tab) && !leafHostGroup(ws, tab))` |
| 3 | 未分屏但布局里残留第二个非空 pane 时，一个**没有行**的叶被点亮 | `visiblePanelIdsOfColumn` 的未分屏分支直接返回焦点叶，不检查它是否在本列真正会画的行上 | 新增 `isShownInColumn(column, rows, tabId)`（行 ∪ 列首行），未命中则回落 `rows[0]` |

**验证证据**：单测 **564/564**（此后补列级比例归一化三条，现为 **567/567**）；`verify-tab-plan-shapes` **29/29**（diag862）；
回归 `verify-tab-plan-strict` **48/48**（diag863）、`verify-shell-drag` **24/24**（diag864）、
全量 `run-all-865` **15 个脚本全部 exit=0 + renderer-diag=clean**。

**一处预置判据的修订（旧断言失效，不是产品缺陷）**：`verify-tab-plan-shapes` 的 B 段最初点两次
「添加分组」，实际建出 6 个容器却按 5 列断言——与 11.6.5 的两处同类。只改步骤（A 段只建 1 个额外分组），
`shape-b-five-columns` / `shape-b-five-visible-columns` / `shape-b-four-splitters` 三条断言一字未改。

#### 11.6.7 ④ 剩下的已知边界

- 渲染层仍保留少量兼容旧调用方的薄封装（`renderSerialGroupTabBar` / `applyGroupWorkspaceSplitLayout` / `syncGroupWorkspaceVisibility`），它们只调 `renderWorkspaceNow()`。
- `ensureShellColumnDom` 必须保留：它建的正是模型 `OWN_COLUMN_ID` 那一列的真实容器。
- `syncSerialGroupAddButtonLayer` / `syncShellAddButtonVisibility` 保留：按钮分层仍然有意义（§11.5.3）。


#### 11.6.8 四项真实用户路径缺口的闭环（新增）

§11.6.7 列出的四个缺口（四级以上真实拖动、窗口缩放与 fit、原生右键菜单、双端口字节流）
已逐项取证。**其中两项直接抽出真实产品缺陷**，不是测试写错。

**缺陷 A：四级以上分屏时分界条完全拖不动。**

- 观测（`probe-fourcol-defects.js`，4 容器 → 屏幕 4 列 3 条分界条）：
  三条分界条逐条拖动，列宽全程 `[171.75, 171.75, 171.75, 171.75]` 不变，`groupWorkspaceSplit.sizes` 仍为 `{}`。
- 根因：拖动逻辑把 `groupWorkspaceSplit.groupIds` 当参与者表，而它只记录「分屏是围绕哪两组打开的」
  （默认分支 = 激活组 + 邻组，实测只有两项），**列集合却由容器数决定**（`layoutColumns` 每个容器一列）。
  于是第 1/2/3 条分界条都在 `participants.indexOf(dragLeftId) < 0` 处直接 return。
- 对照取证：仅在内存里把 `groupIds` 扩到 4 项、不动产品代码，拖第 2 条立刻生效
  （`[171.75, 294.25, 49.23, 171.75]`、`widthSum 698.98 ≈ 699`、`overflowRight -0.02`）——锁定根因。
- 修法（`bindGroupWorkspaceSplitter` 的 `flush`）：
  参与者改用 `getGroupWorkspaceVisibleColumnKeys()`（DOM 里真实可见的列，按顺序）；
  旧比例改按**当前实际列宽**归一（不再用可能只覆盖部分列的 `sizes` 表）；
  写回时把每一列都写进 `sizes`，保证它是一份完整、和为 1 的快照。

**缺陷 B：列比例表只覆盖部分列 → 最右列被挤到容器外。**

- 根因：列级比例这份事实在**两个地方各自补齐**——模型原样转发 `ws.split.sizes`，
  渲染层 `applyColumnSizes` 对缺失列回落 `1 / plan.columns.length`；两者相加超过 1。
- 修法（`buildRenderPlan`）：新增 `domKeys` 与 `layoutSizes = normalizeSizes(ws.split.sizes, domKeys)`，
  `columns[].size` 与 `columnLayout.sizes` 同源于它；未分屏时不产生比例（`{}` / `size: null`）。
  `normalizeSizes` 是纯函数，不写回 `ws`。
- 单测 +3 条（部分比例表归一化 / 空比例表等分 / 关分屏不带比例），单测 **564 → 567**。

**四项的验证判据与结果（全部为真实观测）**

| 缺口 | 判据 | 结果 |
|---|---|---|
| ① 四级以上真实拖动 | `Input.dispatchMouseEvent` 发 OS 级鼠标事件（合成 `MouseEvent` 缺 `isPrimary` 会被拖动入口静默丢弃）；拖第 2 条时第 1/4 列变化 ≤1.5 px、第 2/3 列 >20 px；反向对照拖第 1 条时第 3/4 列不动 | **39/39 PASS**（`verify-four-column-drag-fit`，diag889） |
| ② 窗口缩放与 fit | Win32 `SetWindowPos` 改真实窗口（本 Electron 的 CDP **没有** `Browser.getWindowForTarget` / `Browser.setWindowBounds`，返回 -32601），轮询 `innerWidth` 到稳定；1280×800 / 900×640 两档下列数不变、列宽和 ≤ 容器、占比形状漂移 ≤0.02；默认终端 cols 32 vs 20；单列形态切走默认分组（`display:none`）后缩放 cols 不变、切回后重新 fit | 同上 **39/39** |
| ③ 原生右键菜单真的弹出 | 可见 `Chrome_WidgetWin_2` 顶层窗口计数 0 → 1 → Escape 后回 0；`PrintWindow(hwnd, hdc, 2)` 抓到菜单四项（Split Groups Left/Right、Top/Bottom、Close Group Split、Add Serial Port） | **12/12 PASS**（`verify-native-context-menu`，diag881）+ `popup-menu.png` |
| ④ 单端口真实字节流 + 双端口同时打开隔离 | COM11（设备侧 115200）收真实 `Motor value reached` 行进终端与 `<logPath>/COM11/`；第二分组同时开 COM17 后两组都 connected、默认组继续收（7 → 10 条）、第二组终端与日志均无串入；波特率按分组各一份（115200 / 9600） | **21/21 PASS**（`verify-two-port-isolation`，diag913） |

**④ 的三处「测不下去」全部是测试步骤前提不成立，不是产品缺陷**（先定性、未改产品代码）：

1. **波特率不匹配**：脚本用 UI 默认 9600，而 COM11 设备侧是 115200。直开串口实测：
   `115200 → 126 字节 / 5 秒、3 条 Motor 行`；`9600 → 7 字节乱码、0 条`。改为脚本先把侧栏波特率切到 115200。
2. **日志读取时机**：tab 日志先写 `tabLogBuffers`，由 `flushTabLogEntrySync` 在 `flush-tab-logs` / 断开 / 定时才落盘，
   连接中直接读目录必然是空的。改为读盘前先发产品自己的 IPC `flush-tab-logs`，断言一字未改。
3. **rAF 在不可见窗口里被完全节流**：CDP 起的实例窗口不可见时 `document.visibilityState === 'hidden'`，
   实测 500 ms 内 **0 帧**，串口字节压在 `serialOutputBuckets` 里不上屏（`pendingBytes` 持续增长）；
   手动 `flushPendingSerialOutput()` 后立刻出现 Motor 行。`Page.bringToFront` 与 Win32 `SetForegroundWindow` 都无效，
   只有 `Emulation.setFocusEmulationEnabled({enabled: true})` 能把它翻成 `visible`（rAF 恢复约 52 帧 / 500 ms）。
   ⇒ 这是**测试环境**问题：产品本来就设计成隐藏时缓冲、恢复可见时再分批上屏（与 `[Display output skipped ...]` 的修复同源）。

**探针假设被证伪（不是产品缺陷）**：曾用 Win32 经典菜单窗口类 `#32768` 作原生菜单判据，40 ms 采样恒为 0。
这个 Electron（28.3.3 / Windows）的菜单走 Chromium Aura，不是 HMENU；真正的判据是 `Chrome_WidgetWin_2` + `SysShadow`。

**环境限制（必须如实标注）**：本机 `SerialPort.list()` 只有 COM17 / COM1 / COM18 / COM11（另有幽灵 COM6，打开报 Access denied），
12 个有序端口对全部试过均无回环，也没有 `com0com`。⇒ **没有做双端口收发回环验证**，只做了「单端口真实字节流 + 双端口同时打开下的隔离」；
任何人不得把这件事说成「双端口端到端回环已验证」。



#### 11.6.9 三项真实用户分屏回归的闭环（新增）

用户实测报告（逐字）：

> `只有一个分组的时候，右键点击标签分屏无反应，右键点击日志窗口分屏会出现分屏异常，出现空的分屏，并且不能调整分屏宽度；
> 多个串口分组时，右键点击串口2组分屏，会将串口2组和所有shell一起移到新分屏，并且shell无法拖回到原来屏，拖动后会跑到新建第三分屏；
> 分屏变化、窗口大小变化等情况，终端窗口内容显示大小没有实时跟随`

三项都先复现取证再改，最终抽出 **7 条代码缺陷**（没有一条是测试写错）：

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| 1 | 单分组右键标签「分屏无反应」（菜单全灰） | 普通标签右键恒发 `terminalType:'group'`；主进程分组菜单里两项分屏 `enabled: isMultiGroup`，单分组时全灰不可点，组内 pane 分屏入口完全不可达 | 新增 `requestWorkspaceTabContextMenu`：单分组发 `terminalType:'tab'`，主进程新增 `'tab'` 模板；多分组仍走 `'group'` |
| 2 | 组内 pane 分界条从不显示 / 不能调宽 | `reconcileRows` 只写 pane 显隐与 `flex-basis`，从不按 `column.splitEnabled` 设置本组 `workspace-splitter` 的 `hidden`（静态与动态条初始都是 `hidden`），且 `flex-basis` 没扣除 10px 占位 | `reconcileRows` 写 `splitterEl.hidden = !(column.splitEnabled && specs.length > 1)`，**先显示再读 rect 算 gutter**；`flex-basis = calc(<ratio>% - <ratio × gutter>px)`；隐藏 pane 时清掉残留 inline `flex-basis` |
| 3 | 非激活分组的 pane 条拖不动 / 拖了改错组 | `bindWorkspaceSplitter` 整条拖动路径用模块级别名（`isSplitEnabled` / `getOrientation` / `setPaneSizes` / `persistWorkspaceLayout`），它们只指向**激活分组** | 按 `splitter.dataset.groupId` 取该组 manager（`getGroupWorkspaceManager`），新增 `persistGroupWorkspaceLayout(groupId)`；`persistWorkspaceLayout` 降为薄封装 |
| 4 | 「空的分屏」：主标签被移进 pane-2 后投影又拽回 pane-1 | 投影器在 `index !== 0` 时对 `mainId` 直接 `continue`，末尾无条件 `unshift(mainId)` 到 pane-1 | 新增 `declaredMain`：哪个 pane 声明了主标签就放哪；仅当**没有任何 pane 声明**时才补到 pane-1 队首 |
| 5 | 已开启的 pane 分屏完全不出行（焦点在未归属 Shell 上） | `layoutColumns()` 非分屏分支用 `rootOf(focused)` 定 `containerId`；焦点在 Shell 上时它的根是自己，`containerId` 变 `null` → `layoutRowsOf` 返回 0 条 → `splitEnabled` 恒 `false` | `containerId` 改为「焦点是容器→它自己；焦点是容器子项→`parentId`；焦点是根级叶→`resolveLeafColumnId` 指向的容器；仍无→第一个容器」 |
| 6 | Shell 跟着激活分组跑；分组级分屏把全部 Shell 搬进那一列 | `resolveShellTopRowColumn()` **写** `tabState.columnId`（被只读投影器调用），且用「当前是否可见」否定已有列记忆，回落值就是激活组；新建 Shell 时 `columnId` 留 `null` | 改纯读：`isColumnKeyAlive(remembered)` 命中就用（不看 `hidden`）；新增 `isColumnKeyAlive`；`createShellTab` 创建时就把 `columnId` 写成创建所在分组 |
| 7 | Shell 拖回原屏却新建第三列 | 拖动落点存的是**行元素 id**（行上没有 `data-group-id`，反查恒 `undefined`），且 `finishWorkspaceTabDrag` 无条件 `setShellColumnModeInModel(tabId, 'ownColumn')` | 落点存 `rowTarget.groupId`；分组行分支改为 `hostGroupId=null` + `columnMode='row'` + `columnId=该列`（旧 §8.2 语义作废，见该节） |

另有 1 条**产品裁决**（不是缺陷）：**组内 pane 分屏需要 ≥2 个可移动标签**。移走唯一标签后 `reconcileEmptyPanes` 必然把布局折叠回一个 pane，
用户看到的就是「点了没反应」；而「空的分屏」又被用户明确视为缺陷。⇒ 菜单项按「可移动标签数 ≥ 2」置灰（具体判据见 §6.1.1 规则 3 / §6.1.3），
动作入口 `splitWorkspaceTabIntoPane` 再兜底直接返回。**不引入空 pane 方案，不得复活。**

> 注：本节写于「Shell 不进 pane」时期。§6.1.3 的用户裁决之后，**单串口组下 Shell 也算可移动标签**
> （它通过 `hostPaneId` 住进 pane，不进 `panes[].tabIds`），多组下仍不算。只改「算不算一个可移动标签」，
> 「≥ 2 个」与非空 pane 两条产品规则未变。

**验证证据（全部为真实 rect / 真实 OS 鼠标输入 / 真实 term.cols）**

| 脚本 | 结果 | 关键数字 |
|---|---|---|
| `verify-split-regressions`（37 项） | **37/37 PASS**，renderer-diag=clean（diag923） | 单组 pane 分屏后两 pane 各 `394.5×585`、`flexBasis: calc(50% - 5px)`；分界条 `10×585 hidden:false`；真实拖动 +120px → `394.5 → 512.89 / 276.11`，不拖则完全不变；关分屏 pane-2 `hidden / 0×0 / flexBasis:''`；三个 Shell 切组后仍 `columnId:'default'`；分组级分屏后 `default` 列含 `shell-1..3`、`g-1` 列无 Shell、仍 2 列；拖到分组行后仍 2 列且 `columnMode:'row'`；同宽两列 `49×29` vs `47×33`（cols 差 2） |
| `verify-split-resize-fit`（15 项，新增） | **15/15 PASS**，renderer-diag=clean（diag925） | 1280×800：两列各 538px、面板各 536×609，`default` 67×35 / `g-1` 65×40；900×640：面板各 346×449，`default` 42×26 / `g-1` 41×29；回到 1280×800 完全复原（67×35 / 65×40）；同宽重复 fit、同尺寸重复 resize 均不变（反向对照）。全程**未手动调用 fit**，只靠 `window.resize` 处理器 |
| 全量回归 `run-all -Start 954`（17 脚本） | 17/17 `exit=0` + `renderer-diag=clean` | 含 `verify-split-regressions` 与 `verify-split-resize-fit`（已纳入 `run-all`） |
| 全量单测 | **570/570 / 0 fail** | 567 → 570：新增「焦点在未归属 Shell 上时列仍属于容器」+ 两条互为反向对照的投影用例 |

**窗口 resize 这一要素过去一直没测过**：§11.6.8 的 39/39 里「窗口缩放」量的是**默认分组**的 cols（32 vs 20），
没有验「两个分组的 cols 都必须跟随」。本轮用 Win32 `SetWindowPos` 改真实窗口（走用户拖边框同一条 `WM_SIZE` 路径；
本 Electron 的 CDP 没有 `Browser.getWindowForTarget` / `Browser.setWindowBounds`），轮询 `innerWidth` 到连续三次稳定再量，
结论是**两个分组都跟随、往返可复原**。

**两处验证脚本的过期断言（不是产品缺陷，断言按新语义改写）**：

1. `verify-shell-drag` 的 `group-tab-row-drag-creates-shell-column` / `shell-column-is-visible` / `shell-column-has-exactly-one-visible-tab-row` /
   `shell-column-has-no-pane-tab-row` / `shell-tab-sits-in-shell-column-row` / `shell-pane-rendered-in-shell-column` —— 全部是
   「拖到分组标签行 = `ownColumn` 独立列」旧语义的直接推论。改为 5 条新判据：`group-row-drop-creates-no-shell-column` / `-keeps-column-count` /
   `-keeps-row-mode` / `-lands-on-target-column` / `-shell-stays-in-a-group-tab-row`（23/23 PASS，diag952）。
2. `verify-shell-switchback` 的 `P6-shell-in-top-row-keeps-sub-row-visible` —— 判据（该列下层行必须可见）没变，
   变的是**步骤取哪一列**：旧步骤按 `sidebar-active-group` 找列，而 Shell 现在停在自己的 `columnId` 列，点开 Shell 后激活组列是 `hidden`，
   于是量到一根隐藏列的行（`offsetParent=null`）——是**量错列**，不是产品把行藏了。改为取 Shell 按钮所在的列（14/14 PASS，diag953）。

**探针自身踩到的 5 处坑（不得记成产品缺陷）**：`window.ipcRenderer` 恒 `undefined`（必须 `require('electron').ipcRenderer`）；
`setPaneSplit(ws, id, true)` 自带 `addPane`（测试里再手动加就变 3 个 pane）；非默认分组 runtime 惰性创建（测 fit 前先 `serialRuntimes.getOrCreate`）；
`paneGutter` 必须在写 `hidden = false` **之后**读 rect（否则读到 0，`flex-basis` 少扣 10px）；箭头 IIFE 把长表达式链写成简写返回会抛
`Unexpected end of input`（改块体即可）。

**探针自身踩到的 5 处坑（不得记成产品缺陷）**：`window.ipcRenderer` 恒 `undefined`（必须 `require('electron').ipcRenderer`）；
`setPaneSplit(ws, id, true)` 自带 `addPane`（测试里再手动加就变 3 个 pane）；非默认分组 runtime 惰性创建（测 fit 前先 `serialRuntimes.getOrCreate`）；
`paneGutter` 必须在写 `hidden = false` **之后**读 rect（否则读到 0，`flex-basis` 少扣 10px）；箭头 IIFE 把长表达式链写成简写返回会抛
`Unexpected end of input`（改块体即可）。

#### 11.6.10 四项多串口回归（Shell 按钮 / 第三个分屏 / 分组字体 / 发送路由）

用户实测报告（逐字）：

> `有些情况，两层标签栏都不会显示shell新建按钮，用户无法新建shell；开启两个串口分组并分屏，无法右键第三个串口组或者shell标签建立第三个分屏；新建的串口组的日志终端的字体没有使用设置的字体；发送链路都没有适配多串口组`

四项都先复现取证再改，最终抽出 **5 条代码缺陷**（② 拆成 ②-a / ②-b）与 **1 条加载期崩溃**（③ 的修法第一版引入），没有一条是测试写错。

| # | 缺陷 | 根因 | 修法 |
|---|---|---|---|
| ① | 从多分组关回单分组后，两层标签栏都不显示「新建 Shell」 | `syncShellAddButtonVisibility` 在 `isMultiGroup` 为真时把 pane 行按钮置 `hidden = true`，然后 `if (!isMultiGroup) return;` **提前返回**；回单组时分组标签行整体 `hidden`（本就该隐），而 pane 行按钮**没有任何一行改回 `false`** | **已再次推翻**：当时改为 `button.hidden = isMultiGroup;`（双向写，即「多分组隐二级、单分组隐一级」），但用户实测点 Shell 后仍丢失，且明确裁决「一级二级都永久显示」⇒ 现行实现是 **恒 `hidden = false`**，完整取证与修法见 §11.6.11 |
| ②-a | 右键某分组做「分屏」时，被右键那一组没进参与者表；已分屏时再右键第三个分组，会把前两组踢出去 | 三跳各丢一次：主进程 `sendAction` 不回传 `groupId`；渲染侧 `split-group-*` 调 `setGroupWorkspaceSplit` 不带 `groupIds`；后者在不足两项时回落为「激活组 + 邻居」并**直接覆盖** | `terminalContextMenuState` 存 `groupId` 且 `sendAction` 回传；`handleTerminalContextMenuAction` 先取 `contextGroupId` 并传入 `groupIds`；参与者表改为**并集累积**（`[...requested, ...previous]` 去重），不足两项才补邻居 |
| ②-b | 多分组时右键 Shell 标签拿不到「让它独立成列」的入口 | 两层原因：`requestWorkspaceTabContextMenu` 在多分组时直接转给分组菜单（`tabId` 丢失）；即使不转，`bindGroupTabListEvents` 的 contextmenu 委托也会把「行里的非分组标签」全部交给分组菜单 —— 而分屏时 Shell 的按钮正住在该列列首行 | 两处都按**标签自己的类型**分流：`isShellTabId` → 发 `terminalType:'tab'` 并带 `tabId` / `canDetach` / `shellOwnColumn`；主进程 `'tab'` 模板新增**双向**项（`detach-to-own-column` / `join-group-column`），渲染侧新增两个 case 走 `setShellColumnModeInModel` + `persistShellTabs` |
| ③ | 新建串口分组的日志终端不用设置里的字体 | 终端构造模板 `buildSerialTerminalOptions` 只返回 `cursorBlink` 四项，**没有任何字体/主题**；默认分组之所以「看起来对」是因为 `applyConfig` 事后单独写了 `serialTerm.options`，而它只遍历默认分组与模块级 `filterTabs` 别名，**不遍历 `serialRuntimes`** | 模板补齐 `fontSize` / `fontWeight` / `fontFamily` / `theme`；`applyConfig` 改为遍历运行时注册表逐组下发（filter tabs 改按 `filterTabsStore.getList(group.id)` 取） |
| ③附带 | 模板补齐字体后 renderer **整个加载不起来** | 默认分组的终端在模块加载期就建，那时 `currentConfig` 还是 `null`，而 `getTerminalTheme` 要读 `highlightColors.selection` ⇒ `TypeError` | 模板先建四项基础 options，`if (!config) return options;` 才补字体与主题；设置到位后由 `applyConfig` 用同一个模板重写 |
| ④ | 发送链路没有适配多串口组 | 唯一归组入口 `resolveSerialGroupId` 在未登记时**一律回落默认分组**，而四个调用点都没传 `groupId`：主输入框、快捷发送点击、自动发送、快捷指令触发 | 前三处补 `groupId`（主输入框/自动发送/快捷发送点击用激活分组）；**快捷指令触发不能只用激活分组**——触发源是收到的字节，改为取**该批字节所属分组**（`dispatchSerialBatch` 的 `id` 一路下传）；另把 `quickTriggerBuffer` / `quickTriggerDecoder` 两个**全局单例**改成按分组分桶，否则两组同时收数据会互相污染 |

**已锁定的产品语义（未变，本轮只是让实现符合它）**：分屏只作用于被右键的那一个串口组；未归属的 Shell 维持原位置；单标签时 pane 分屏置灰；`ownColumn` 的显式入口是右键菜单（拖拽只停列首行，不新建列）。

**验证证据（全部为真实 rect / 真实 term.options / 真实 IPC payload）**

| 脚本 | 结果 | 关键数字 |
|---|---|---|
| `verify-four-defects`（45 项，新增） | **45/45 PASS**，renderer-diag=clean（diag987） | ①六形态均 `visibleCount === 1`，反向对照「多分组时 pane 行按钮全 `hidden`」成立；②-a `groupIds` 由 `['g-1','default']` → 加入 g-2 后 `['g-2','g-1','default']`（前两项未丢）+ 3 列各 264px；②-b 右键 Shell 得 `terminalType:'tab'` / `tabId:'tab-shell-1'` / `canDetach:true`，独立成列后 3 → 4 列（`__shell__` 197px），反向归入后 4 → 3 列；③ `g-1`/`g-2` 与 `default` 的 `fontFamily` 逐字相同，改设置为 `Courier New` 后三组全部跟随；④`targetGroup='g-1'` 而 `triggerGroup='g-2'`（两者不同）时，主输入框/自动发送/快捷发送点击写 `g-1`，**快捷指令触发写 `g-2`**，反向对照写 `default` |
| 全量回归 `run-all -Start 1030`（**18** 脚本） | **18/18 `exit=0` + 每支 `renderer-diag=clean`** | 新增 `verify-four-defects` 已纳入 `run-all`；另含 `verify-split-regressions` 37/37、`verify-group-split` 19/19、`verify-group-columns` 37/37、`verify-split-resize-fit` 15/15 |
| 全量单测 | **570/570 / 0 fail** | 断言数未增减；改写 4 处**过期断言**（见下） |

**四处过期断言按新事实改写（不是改期望值凑绿）**：

1. `buildSerialTerminalOptions` 的签名从空括号改为 `(config = currentConfig)`，并把「模板必须带字体」变成三条可回归断句（`fontFamily` / `theme` / `scrollback` 各自一条）；
2. `applyTerminalWallpaper(config); serialTerm.options = options` 改为校验「遍历 `serialRuntimes.listGroupIds()` 逐组写 `runtime.term.options`」；
3. 两条 quick-send 发送正则补上 `groupId`（`activeGroupId` 与 `groupId || activeGroupId` 各一条）；
4. `invalidateTerminalSearch(serialTerm, 'options')` 改为 `invalidateTerminalSearch(runtime.term, 'options')`。

**本轮最值得记住的一条教训**：重写 `handleTerminalContextMenuAction` 的 split-group 邻接代码时，把 `case 'close-group-split'` 整段覆盖掉了——
后果是「关闭分组分屏」完全失效，被 `run-all` 的 4 个脚本同时抓到（`verify-group-split` / `verify-group-columns` / `verify-user-paths` / `verify-shell-drag`）。
大文件里插新 case 时，**要么只做插入、要么改完立即用相邻 case 数量自检**；`node --check` 看不出这种语义丢失。

**一次假失败（探针环境问题，不是产品缺陷）**：补回后 `verify-group-split @ diag1012` 仍报 4 条 FAIL（屏幕 3 列），
但同一次运行里「只有两个分组」却 PASS。新建 profile 实测只有 2 列 / 2 分组，根因是**旧会话残留的后台循环**让 5 个 electron 进程争用 9222，探针连到了另一个实例。
干净环境下同一支脚本 19/19。⇒ 出现「多列 / 多分组」这类不合常理的观测时，先查进程与端口。

**环境限制（必须如实标注）**：④ 段是「伪造注册表 `connected` + 包住 `serial-write`」取证，量到的是**发给主进程的真实 payload**；
本机无互连串口对、无 `com0com`，**没有做双端口端到端回环**，不得说成真实串口收发已验证。




#### 11.6.11 两级添加图标永久显示、控件单一构造、右键新建入口

用户实测报告（逐字）：

> `开启第二个串口组，点击第二串口组，再点击shell标签，一级标签栏的两个添加按钮都消失了，改了无数次还是有问题，你能力有限，还是做成一级二级都永久显示这些图标吧，并且在右键菜单页也加入新建各种标签；第一个串口组和第二个串口组的二级标签栏的两个添加标签页的按钮间距竟然不一样，说明两个明明可以复用的控件，还是单独实现，之前的工作都白做了；反思一下如何能做的更好`

### 11.6.11.1 产品裁决变更（旧裁决作废）

§11.5.3 与上一版 §11.6.10 ① 的「全屏恰好一个可见的新建 Shell 入口」**已作废**。新裁决：

| 项 | 新规则 |
|---|---|
| 新建 Shell | 一级标签栏的 `#add-shell-tab-btn` 与二级栏每个 pane 的 `*-new-shell-tab-btn` **永久同时显示**；可见性不再由分组数 / 分屏形态 / 焦点位置决定 |
| 添加串口 | `#add-serial-group-btn` 常显；`#add-serial-group-inline-btn` 仍只在单分组时显示（理由见下） |
| 右键菜单 | 除原有入口外，`'tab'` 与 `'group'` 两支都必须能新建 Shell / 过滤 / 图表 |
| 控件实现 | 二级栏的动作按钮组必须由**同一条构造路径**生成，组间位置 / 尺寸 / 间距 / 顺序不得有差异 |

两个入口的差别必须能解释清楚，否则会被误判成回归：

- 新建 **Shell**：一级与二级是**同一功能在两级不同行**，用户要的就是两行都能直接新建；
- 添加**串口** inline：它是「添加串口」的**等价重复入口**。单分组时一级栏整条 `#serial-group-tab-bar` 是 `hidden`，
  没有它用户首次启动就开不了多串口；多分组时一级栏已常显，再留一个一模一样的 inline 就是用户此前报过的
  「两个添加串口按钮」。**它不归「两级永久显示」管**，因为那一条约束的是「新建 Shell」。

### 11.6.11.2 缺陷 A：点 Shell 后一级栏两个添加按钮同时消失

先取证再定性（`probe-add-buttons2.js @ diag1051`，exit=0、renderer-diag=clean）。按用户顺序逐步量
`hidden` / `offsetParent` / rect / **宿主行与宿主列**：

| 步骤 | activeGroupId | 按钮 `hidden` | 宿主行 | 宿主列 | shown | blockedBy |
|---|---|---|---|---|---|---|
| 加第二组 | `g-1` | false | `serial-group-tab-bar-g-1` | `serial-group-workspace-g-1` | true | — |
| 点第二组 | `g-1` | false | 同上 | 同上 | true | — |
| **点 Shell** | `g-1` | **false** | 同上（仍可见） | **`serial-group-workspace-g-1`（`hidden=true`）** | **false** | **`serial-group-workspace-g-1[hidden]`** |
| 点回 g-1 | `g-1` | false | 同上 | g-1（可见） | true | — |

**结论（观测，非推断）**：两个按钮自身的 `hidden` 从未为真；消失的唯一原因是**它们所在的列被隐藏**。
点 Shell 后可见列切到 `default`（同批数据里 `pane-1-new-filter-tab-btn` / `-chart-tab-btn` 的 `colHidden=false`、
`shown=true` 可证），而 `activeGroupId` 仍是 `g-1`。

根因链：`placeShellAddButton()` / `placeGroupAddButton()` 都锚定 `getVisibleGroupRow(activeGroupId)`，
而旧实现只判 `row.hidden`、**不判该行所在列**。

⇒ **教训：`[hidden]` 是属性，可见性是祖先链上的合成结果。** 只看属性不看宿主容器的断言，永远掍不到这种缺陷。

修法（`getVisibleGroupRow()` 改为无参扇描）：

```js
function getVisibleGroupRow() {
    const rows = Array.from(document.querySelectorAll('.group-tab-row'));
    const visible = rows.find(row => {
        if (!row || row.hidden === true) return false;
        const column = row.closest('.group-column');
        if (!column || column.hidden === true) return false;
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    });
    if (visible) return visible;
    return document.getElementById(GROUP_TAB_BAR_ID);
}
```

三个判据缺一不可：行未 hidden、**所在列未 hidden**、**真的有尺寸**（列也可能是 CSS 而非属性驱动）。
不再按「某个 groupId 对应的行」取，而是扇「用户能看见的那一行」——调用方要的是后者。

### 11.6.11.3 缺陷 B：两组二级栏按钮间距不一致

`probe-add-buttons3.js @ diag1052`（exit=0）——两组不能同时可见，分两次在各自可见时测同一判据：

| 来源 | 容器 `display` | `gap` | 空白文本节点 | 每按钮 `margin-right` | 实测相邻间距 |
|---|---|---|---|---|---|
| 单分组 `#pane-1-tab-actions`（**index.html 静态标记**） | block | normal | **6 个** | 4px | **8.39 / 8.39 / 8.39 px** |
| 多分组 `pane-1-g-1`（**createGroupPaneElement() 动态建**） | block | normal | **0 个** | 4px | **4 / 4 px** |

**双重根因（观测）**：

1. 两处**确实是两份独立实现**（`index.html` 手写的 pane-1/pane-2 vs 两个 pane 构造器里的 `buttonSpecs`）；
2. `.pane-tab-actions` **完全没有 CSS 规则**，容器退化为 `display:block` / `gap:normal`，按钮是 `inline-flex`，
   于是间距 = `margin-right 4px` + **HTML 换行缩进渲染出的一个空格宽 ≈ 4.39px**。

⇒ 布局依赖**源码里的空白**，是最脆弱的一种。这也直接解释了用户说的「两个明明可以复用的控件，还是单独实现」。

### 11.6.11.4 修法：唯一构造路径

```js
const PANE_ACTION_BUTTON_SPECS = Object.freeze([
    { kind: 'shell', icon: 'terminal', titleKey: 'main.newShellTab' },
    { kind: 'filter', icon: 'filter_alt', titleKey: 'main.newFilterTab' },
    { kind: 'chart', icon: 'show_chart', titleKey: 'main.newChartTab' }
]);

function createPaneActionButtons(paneId) { /* 返回 button 数组，并在此绑定 click */ }

function fillPaneActionButtons(actionsEl, paneId) {
    if (!actionsEl) return;
    while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
    createPaneActionButtons(paneId).forEach(button => actionsEl.appendChild(button));
}
```

四条不变量（改这带代码时必须遵守）：

1. 按钮一律用 DOM API 创建，**不插入任何文本节点**；间距只由 CSS `gap` 决定。
2. `createPaneActionButtons` 是**唯一**绑定 click 的地方；其他地方不得再对同名 id 调 `addEventListener`。
3. 静态 `pane-1`/`pane-2` 在加载期用同一函数重建，随后把 `#add-serial-group-inline-btn` **按节点引用**重新 append
   （节点不重建，其文件末尾绑定的监听器才不会丢）。
4. 不得用 `replaceChildren`：模块加载门禁的 DOM stub 只实现 `removeChild` / `appendChild`。

`style.css` 配套：

```css
.pane-tab-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    padding: 0 8px;
}
```

同时删掉 `.pane-new-tab-btn` 原来的 `margin-right: 4px`（间距统一交给 `gap`）。
`.serial-group-tab-actions` 本来就是这个形状，两处现在同构。

### 11.6.11.5 右键新建入口

调查结论（读源码确认）：默认支（`terminalType` 为 `main`/`filter`/`shell`）**原本就有** `new-shell-tab` + `new-filter-tab`；
缺的是 ① 没有 `new-chart-tab` case；② `'tab'` 支与 `'group'` 支里完全没有新建类入口。

修法：

- `main.js` 新增 `paneNewTabItems(labels_, send)` 返回三项；`'tab'` 支置首、`'group'` 支插在 `addSerialPort` 之前；
- `renderer.js` 新增 `case 'new-chart-tab'`，与按钮走同一个 `createChartTab({}, resolvePaneId(paneId, tabId))`；
- `getContextMenuLabels()` 增 `newChartTab`；`i18n.js` 六语言 `main` 各补 `newChartTab`。

**动作链路不另开一条**：菜单项 → 主进程 `send('new-*')` → 渲染侧 `handleTerminalContextMenuAction`
→ `createShellTab` / `createFilterTab` / `createChartTab`，与按钮点击完全同一条创建入口。

**验证限制**：原生菜单是 Chromium Aura，**菜单项无法通过 CDP 读出**。因此分两步验：
断言 `getContextMenuLabels()` 三个键都存在；再真实发一次菜单动作，数标签数量变化。

**图标真实性**：`menuIcon(name)` 只认 `assets/menu-icons/<name>.png`，不存在则返回 `{}`（静默无图标）。
`show_chart` / `add` / `pause` 等 png **不存在** ⇒ 对应菜单项无图标。这是既有行为，不得声称它们带了图标。

### 11.6.11.6 验证证据（全部为真实 rect / 真实 IPC payload）

| 脚本 | 结果 | 关键数字 |
|---|---|---|
| `verify-add-buttons`（21 项，新增） | **21/21 PASS**，renderer-diag=clean（diag1054） | 用户路径点 Shell 后 `add-shell-tab-btn` `shown:true` / `columnHidden:false`；两组容器均 `flex / gap:4px / pl:8px`、`textNodeCount` 均为 0、`gaps:[4,4]`；菜单动作后 `filters 0→1` / `charts 0→1` / `shells 2→3` |
| `verify-four-defects`（**47 项**，A 段改写） | **47/47 PASS**，renderer-diag=clean（diag1105） | 单分组 `topCount:0/paneCount:1`；多分组 `topCount:1/paneCount:1/visibleCount:2`；分屏 `visibleCount:3`；6 条反向对照 `columnHidden:false`。B/C/D 段沿用旧判据全绿 |
| `verify-shell-buttons-split`（16 项，两条改写） | **16/16 PASS**，renderer-diag=clean（diag1104 / diag1132） | `multi-group-both-levels-offer-shell-entry` / `split-both-levels-offer-shell-entry` 均 PASS |
| 全量回归 `run-all -Start 1120`（**19** 脚本） | **19/19 `exit=0`**，19 个 `renderer-diag=clean` | 新增 `verify-add-buttons` 已纳入 |
| 全量单测 | **570/570 / 0 fail** | 断言数未增减 |

`verify-four-defects` 的项数由 **45 → 47**：A 段 6 条旧的「恰好一个可见」改写为 12 条（6 正向 + 6 反向对照）。
**旧 45/45 记录永久失效**，不得再引用。同理，`verify-shell-buttons-split` 旧的两条
`*-pane-row-shell-buttons-hidden` 是旧裁决的直接推论，已改写为「两级都提供入口」。

### 11.6.11.7 本轮我自己造成的三个回归（必须记住）

| # | 现象 | 根因 | 教训 |
|---|---|---|---|
| 1 | 一次点击创建**两个**标签（`verify-user-paths` 报 4 个 shell） | `createPaneActionButtons` 已绑 click，`renderer.js` 文件末尾还保留着旧的 `pane-1-new-*-tab-btn` 手动绑定，静态按钮被重建后旧绑定落在新节点上再绑一次 ⇒ 监听器叠加 | **把控件收敛成唯一构造路径时，必须同步删掉旧的手工事件绑定**，否则「复用」反而放大成双份副作用。`node --check` 与门禁都抓不到这类语义重复 |
| 2 | `renderer.js` 语法错：`SyntaxError: Unexpected end of input` @11053 | 删那段重复绑定时，`end_line` 覆盖到了`document.querySelectorAll('.workspace-pane').forEach(…` 的收尾 `)});`，并残留了一行重复的 `querySelectorAll` | 大文件删整段时 `end_line` 必须取到**整段最后一行**；改完立即 `node --check` |
| 3 | `check-renderer-module-load` 报 `actionsEl.replaceChildren is not a function` | 门禁 DOM stub 只实现 `removeChild` / `appendChild` | **工具适配问题，不是产品缺陷**；改成 `removeChild` 循环即可 |

### 11.6.11.8 结构性反思（为什么这个位置「改了无数次还是有问题」）

这不是一次偶然失误，而是三个结构性问题的叠加：

1. **同一个控件被写了三份。** 默认分组的 `pane-1` / `pane-2` 动作按钮在 `index.html` 里手写一遍，
   `createPaneElement` 与 `createGroupPaneElement` 各再写一遍，共三份。改一份另两份不跟着变，
   而且这种不一致只能通过「仔细看间距」发现——正是用户指出的现象。
2. **可见性判据散在三处。** `placeShellAddButton()` / `placeGroupAddButton()` 决定按钮**放哪行**，
   `syncShellAddButtonVisibility()` 决定按钮**自己是否 hidden**，`renderShellTabBar` 的调用顺序决定
   **什么时候算**。三者各自看起来都对，但只有在特定形态组合下才出错——所以每次只修一处都会「看起来好了」。
3. **断言只盯属性，不盯合成结果。** 历史上多条断言只查 `button.hidden`，于是本轮缺陷 A（按钮 `hidden=false`
   但宿主列 `hidden=true`）能穿过整套测试。

可执行的收敛做法（已落地）：

- **删掉重复实现**，只留 `createPaneActionButtons` 一条构造路径，并**同步删掉旧的事件绑定**；
- **把可见性判据收到一处**（`getVisibleGroupRow` 只看「用户真正能看见的行」），不再用模态推导；
- **用反向对照锁死**：不只断言「看得到」，而是断言「它**没有**被隐藏的祖先」、「两组几何逐项相等」。
  反向对照才是能抓到回退的那一半。



### 11.6.12 分组分屏后原组标签点不动（mousedown 重渲染吞掉 click）

用户实测报告（逐字）：

> 「新建串口组分屏之后，原来的串口的主页面标签和过滤标签都点击不了了」

同一个诉求里还有第二条：

> 「run-all.ps1 测试每次开启应用窗口后要等很久才开始测试操作，效率很低，能否在应用开启准备好后
> 立即触发开始测试」——见 §11.6.12.6。

#### 11.6.12.1 先排除的三个假设

| 假设 | 取证 | 结论 |
|---|---|---|
| 被别的元素遮住 / `pointer-events: none` | `elementFromPoint` 命中的就是 `tab-main-button` 本身；祖先链 `pointer-events` 全 `auto`、`z-index` 全 `auto` | **否** |
| click 监听没绑上 | 绕过命中测试直接 `element.click()` 立刻切换 | **否** |
| 分屏后写错了分组（历史结论） | 见下一段：`switchPaneTab` 的分组修复**是真缺陷但不足以解释症状** | **部分** |

第二轮取证把话说清了：真实鼠标点击**根本没有产生 `click` 事件**。

证据链（全部为真实 Electron + CDP）：

| 文件 | 观测 |
|---|---|
| `geo-1157.txt` | 补齐 `buttons` 位后点二级标签，只有 `pointerdown` / `mousedown` / `mouseup`，**无 `click`**；同一次运行里 `dispatchEvent(new MouseEvent('click'))` 立刻生效 |
| `node-1158.txt` | 点静态「新建过滤页」按钮**同样无 `click`**，而点一级标签行（y≈40）有 `click` ⇒ 与标签类型无关，与**区域**有关 |
| `drag-1159.txt` | y=40 / 50（一级标签行）有 `click`；y=70~120（`#group-workspace` 内）没有 |
| `sweep-1160.txt` | 一级标签行 y=34~62 全部有 `click`；进入 `#group-workspace` 后全部没有 |

#### 11.6.12.2 根因：mousedown 阶段重渲染导致浏览器不合成 click

`#group-workspace` 内的每一个 `.workspace-pane` 都挂着 `mousedown` 处理器，两个 pane 构造器
（`createPaneElement` 与 `createGroupPaneElement`）各一份。它在**按下瞬间**做两件事：

1. `setActivePane(paneId)` → `onLayoutChanged?.()` → `renderWorkspace()` 整棵标签树重新收敛；
2. 若该 pane 所属分组不是激活分组，还会走 `applyActiveSerialGroup()`（侧栏 + 分组标签行 + 列可见性全量重渲染）。

`renderWorkspace` 会重排标签按钮（`reconcileButtons` → `orderButtons`）并搬动面板（`applyVisibility`）。
**被点的那个按钮或其祖先在按下与抬起之间被换掉**，浏览器于是判定「不是同一次点击」，
**不合成 `click`**。产品里所有标签切换都绑在 `click` 上，所以表现就是「点了没反应」。

决定性实验（`blk-1163.txt`）：

```js
// 只在 capture 阶段拦住 .workspace-pane 的 mousedown，不改产品代码
document.addEventListener('mousedown', evt => {
    if (evt.target.closest && evt.target.closest('.workspace-pane')) evt.stopPropagation();
}, true);
```

结果：**同一个坐标、同一个标签，`click` 立刻出现**。⇒ 因果链闭合。

这也解释了为什么该缺陷「只在分屏后出现」：未分屏时只有激活分组那一列可见，`activeGroupId` 与
被点列一致，`setActivePane` 与 `switchPaneTab` 往往是幂等的，重渲染不发生（或发生也不会换掉按钮）；
分屏后用户点的列**经常不是激活分组**，于是每次 mousedown 都触发一次整组重渲染。

#### 11.6.12.3 修法（两处，均为最小改动）

**① `workspace-manager.js` 的 `setActivePane()`：值没变就不请求渲染。**

```js
function setActivePane(paneId, { persist = true } = {}) {
    const layout = getLayoutState();
    const paneIds = getPaneIds();
    const nextPaneId = paneIds.includes(paneId) ? paneId : (paneIds[0] || 'pane-1');
    // 值没变就不要请求渲染：本函数由 pane 的 mousedown 调用，
    // 一次 renderWorkspace 会重排按钮、搬动面板，按下时换掉被点的节点，
    // 浏览器就不合成 click。激活 pane 没变时渲染结果也不会变，跳过是等价的。
    if (layout.activePaneId === nextPaneId) return;
    layout.activePaneId = nextPaneId;
    if (persist) persistLayout();
    onLayoutChanged?.();
}
```

**② `renderer.js` 的两个 pane 构造器：选 pane / 切分组的时机从 `mousedown` 改到 `click`。**

```js
// createPaneElement（组内 pane）
paneEl.addEventListener('click', () => setActivePane(paneId, { persist: true }));

// createGroupPaneElement（分组列）
paneEl.addEventListener('click', () => {
    if (activeGroupId !== id) {
        activeGroupId = id;
        applyActiveSerialGroup({ fit: false });
    }
});
paneEl.addEventListener('click', () => setActivePane(paneId, { persist: true }));
```

为什么必须两个构造器都改：`createPaneElement` 与 `createGroupPaneElement` 是两套并行的 pane 构造器，
**只改一处就会有一半区域继续吞 click**——与 §11.6.11.8 第 1 条（同一控件写三份）完全同源。

为什么改到 `click` 阶段是安全的：`click` 已经派发完毕，此后的重渲染不会撤销这次事件；
而「选 pane / 切分组」本来就是**点击的结果**，不是点击的前置条件。

#### 11.6.12.4 四层判据（缺一层就会漏掉这类缺陷）

| 层 | 读什么 | 修前（diag1141） | 修后（diag1166 / diag1167） |
|---|---|---|---|
| L1 布局 | `plan.plan.columns[].rows[0].activeTabId` | `tab-main`（点过滤页后仍是） | 点过滤页 → `tab-filter-1`；点主标签 → `tab-main` |
| L2 焦点 | `plan.sections.focusedTabId` | `tab-filter-1` | 与 L1 同步 |
| L3 模型 | `columns[].panelIds` | `["tab-main"]` | `["tab-filter-1"]` ↔ `["tab-main"]` |
| L4 DOM | 内容区里带 `.active` 的面板 | `["tab-main"]` | 与 L3 一致 |

反向对照三项（防「假绿」）：

- **R1**：点之前该列确实显示**另一个**标签（`l1 === tab-filter-2` 且 `l4 === [tab-filter-2]`）；
- **R2**：另一列（g-1）的 active 面板**不受影响**（`["tab-main-g-1"]` 前后一致）；
- **R3**：激活分组不被「点别列标签」悄悄改掉（`activeGroupId` 前后都是 `g-1`）。

#### 11.6.12.5 验证

| 脚本 | profile | 结果 |
|---|---|---|
| `verify-split-tab-click.js`（新增，19 项） | diag1166 | **19/19 PASS，exit=0** |
| 同上（纳入 `run-all` 后的复跑） | diag1167 | **19/19 PASS，exit=0** |
| `verify-add-buttons.js`（21 项，上一轮基线） | diag1168 | **21/21 PASS，exit=0** |
| `node scripts/run-tests.js` | — | **570/570，fail=0** |

19 项构成：夹具 5 + 四层正向 8 + 可逆 1 + 反向对照 3 + 关分屏 2。

> **一条旧判据失效的说明**：关分屏那一项最初断言「默认列的 `l4` 非空」。实际上此时激活分组是
> `g-1`，默认列按设计就是 `hidden` 的（§2.6：未分屏时只显示激活分组那一列），`l4` 为空是**正确行为**。
> 已改写为「可见列恰好 1 个且等于激活分组」+「该可见列 `l4` 非空」。这是**判据错**，不是产品回归，
> 也不是为了让测试变绿而放宽期望。

#### 11.6.12.6 顺带：测试启动等待的实测与收敛

用户第二条诉求是「应用准备好后立即触发」。先量后改：

```text
MEASURE: port=893ms ready=2018ms total=2753ms stableSamplesChanged=0/10
```

- `port` ≈ 0.9 s：调试端口出现 page target（进程起来）；
- `ready` ≈ 2.0 s：五条就绪判据全部通过；
- **`ready` 之后再观察 600 ms，列/按钮/pane/计划列数 10 次采样 0 次变化** ⇒ 原来那 350 ms
  「稳定余量」没有依据。

三处收敛（都属于测试基础设施，不是产品代码）：

| 改动 | 位置 | 依据 |
|---|---|---|
| `STABLE_MS` 默认 350 → **0** | `wait-ready.js` | 上面 0/10 次变化的实测 |
| 去掉 `Start-Process` 的额外进程 | `run-cdp.ps1` 的 `Invoke-NodePiped` | `& node ... \| Out-File` 即可拿到真实 `$LASTEXITCODE` |
| `run-all` 19 → **20 支** | `run-all.ps1` | 纳入 `verify-split-tab-click` |

**就绪判据的五条一条都没有动**——那是防「骨架没建好就开始操作」的护栏，不是可优化项。

| profile | 脚本 | `wait-ready` | 结果 |
|---|---|---|---|
| diag1165（改前对照） | verify-split-tab-click | `total=2551ms` | exit=1（旧判据错） |
| diag1167 | verify-split-tab-click | `total=2149ms` | exit=0 |
| diag1168 | verify-add-buttons | `total=2051ms` | exit=0 |

⇒ 每支省 **400–500 ms**，20 支合计约 **8–10 秒**。**必须同时说清的边界**：启动等待本身只占每支
约 **2.0–2.2 秒**（20 支约 45 秒），`run-all` 整体 14–16 分钟的**主因是每支脚本内部的固定 `sleep`**
（单支 25–136 s）。本轮**没有**把那些 `sleep` 改写成 `waitFor(条件)`，那是 14 支脚本的批量重构，
风险与工作量都超出本轮范围。

#### 11.6.12.7 结构性反思（与 §11.6.11.8 同源，但这次在事件时序上）

1. **「点不动」有四种完全不同的成因，必须先分清再动手。** 被遮挡 / 命中错 / 状态没写 / **事件没产生**。
   前三种都能靠「直接 `element.click()` 好不好使」快速二分；本轮就是靠这条对照在 3 分钟内把方向
   从「布局写错」纠正到「click 根本没来」。
2. **同一逻辑两个入口，只修一个等于没修。** 上一轮的 `switchPaneTab` 只修了「按分组取 manager」，
   这一轮如果只改 `createPaneElement` 不动 `createGroupPaneElement`，就会剩下一半区域继续坏。
   凡是「两个构造器 / 两个入口」的地方，改动都要成对。
3. **副作用要放在事件语义允许的阶段。** `mousedown` 是「准备」，`click` 才是「完成」。在 `mousedown` 里做
   会重建 DOM 的事，等于主动破坏浏览器对 click 的合成前提——这类缺陷不会报错，只会「没反应」。
4. **不要为了让它「看起来更稳」而叠加无依据的等待。** 350 ms 稳定余量当初没有任何测量背书；
   本轮量出 0/10 次变化后直接归零。反过来，就绪判据那五条**有**明确依据（防止骨架没建好），
   所以一条都不动——**有依据的等待保留，无依据的等待删除**。

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
`buildRenderPlan()` 在**渲染层已消费它**的前提下与真实 DOM 逐项相等：`verify-tab-plan-strict` 48/48
覆盖 10 类单形态，`verify-tab-plan-shapes` 29/29 覆盖三类组合形态（未分屏多受托管叶 / 五列 / 多 Shell 混合）。
另外有一支定位不入库的随机探针（300 种子 × 80 步）在纯模型上验证三条不变量：
同一标签只定位一次、某列亮着的面板必住进该列、全局可见面板必属于某一列。零违规。
以下事项仍需在实际操作中重新取证：

| # | 未验证项 | 说明 |
|---|---|---|
| 1 | 两级分屏同时开启的实际观感 | §4.3 的四种组合中，「列开 + pane 开」只有设计推演 |
| 2 | 扁平 + 多 pane 的标签焦点视觉 | 已裁决方案 A（N 条 subRow）；实机观感与焦点切换待验证 |
| 3 | 真实鼠标拖动分界条的手感与最小宽度 | 已用 `Input.dispatchMouseEvent` 发 OS 级事件实测四条以上分屏（§11.6.8），硬限 `MIN_SHARE = 0.1`；手感仍需用户手测 |
| 4 | 四条以上分屏时每一条分界条的独立拖动 | **已验证**：4 列 3 条逐条拖动 + 反向对照（39/39，diag889） |
| 5 | 窗口尺寸变化后旧比例是否仍然合理 | **已验证**：1280×800 / 900×640 两档下占比形状漂移 ≤0.02、列宽和 ≤ 容器（同 39/39） |
| 6 | 两级分屏下 xterm `fit()` 从 `display:none` 切回的尺寸 | **已验证**：隐藏列不 refit、切回后 cols 落回该宽度单列区间（同 39/39）；本轮另证分屏变化（47 → 97 cols）与真实窗口 resize（1280×800 / 900×640 两档、两个分组 cols 都跟随、往返可复原，15/15 diag925） |
| 7 | 迁移后旧配置的实际恢复效果 | 需要真实旧版配置样本 |
| 8 | 工作区级动作条在窄窗口下的换行表现 | 新增 UI 元素，未设计 |

既有验证缺口（与本模型无关，但同样未解决）：

- 多串口的**双端口收发回环**：本机无互连串口对、无 `com0com`，**未做**；只验证了「单端口真实字节流 + 双端口同时打开下的隔离」
  （21/21，diag913；环境限制与三处步骤前提见 §11.6.8）。原生右键菜单已实测弹出（Aura `Chrome_WidgetWin_2`，非 `#32768`；12/12，diag881）。
- per-group 作用域下两组同时收数据时各自的日志前缀 / 回显，只有 `getPrefix()` 直接调用的证据。
- 标签切换闪烁的修复（`0bf62ea`）只有 CDP 合成点击 + `getComputedStyle` 证据，未做真实用户手测。
- **单标签时的组内 pane 分屏**：已裁决不做（菜单项置灰、动作入口拒绝），理由是移走唯一标签必被 `reconcileEmptyPanes` 折叠回一个 pane，而空 pane 又被用户明确视为缺陷。这不是未实现，是**有意的产品边界**。
- **Shell 拖到分组标签行的语义已由用户裁决修正**（§8.2 的落点表）：旧「拖到分组标签栏 = `ownColumn` 独立列」已作废；现在拖到普通分组列的列首行只是停在那列，不新建列。
  `ownColumn` 的**显式入口**是「多分组下右键 Shell 标签 → 独立成列 / 归入分组列」（§11.6.10 ②-b），与拖拽互不冲突。
- **快捷指令自动触发的解码与滚动匹配缓冲已改成按分组各一份**（§11.6.10 ④）。此前它们是全局单例，两组同时收数据会把多字节字符拆到两组字节里各解一半、也会把两组的尾巴拼在一起误匹配。
  该项只有「按分组分桶后四个发送入口分别路由正确」的证据（45/45，diag987），**没有**双端口同时收数据时的端到端触发证据（硬件限制同上）。

## 14. 需求覆盖核对

| 需求 | 落点 | 是否完整 |
|---|---|---|
| 四个原语：Tab / TabRow / subRow / tabPanel | §1 | ✅ |
| Tab 可放在 TabRow 或 subRow 中 | §3.3 `layoutColumns()` 的 `tabItems` / `rows` | ✅ 且明确「同一 Tab 永不两处同时出现」（I4） |
| subRow 可以被收起 | §8.3（含「按钮必须挂在 TabRow」的可恢复性约束） | ✅ |
| tabPanel 对应一个 Tab | §1.5 + I3 | ✅ |
| 串口组、main、filter、chart、shell 都是 Tab | §1.1 / §1.2 | ✅ 用 `isContainer()` 而非 `kind` 区分容器与叶 |
| 组内 pane 分屏保留 | §4.2 + §5.5 | ✅（单标签时置灰，见 §11.6.9 的产品裁决） |
| 分屏分为 TabRow 级与 subRow 级 | §3.3–§3.4 + §4 | ✅ 二维分离，互不引用 |
| 只有一个串口组时 subRow 不可见，main/filter/chart/shell 都在 TabRow | §3.3 族列 + §5.2 | ✅（附两条针对性回归用例，§11.1） |
| 新建架构设计文档 | 本文件 | ✅ |

## 附：一句话总结

**三个字段 + 一组派生量 + 一个渲染计划。** 标签的「位置」不再是数据，而是结构的投影；「扁平」不是另一种实现，而是同一条 TabRow 上的一次族展开。

---

**相关文档**

- `MULTI_SERIAL_DESIGN.md` §6A —— 多串口实现的背景描述（标签体系部分以本文为准）
- `agent_notes.md` §13A.9–§13A.20 —— 标签与多串口相关的历次缺陷与教训
- `ToDo.md` —— CDP 验证清单（**23 个脚本**；其中 `run-all` **19** 个脚本新近一次全量回归 19/19 `exit=0` + 每支 `renderer-diag=clean`，`verify-native-context-menu` / `verify-four-column-drag-fit` / `verify-two-port-isolation` 为定点跑过）

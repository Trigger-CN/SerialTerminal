# 标签体系架构设计：Tab / TabRow / subRow / tabPanel

> **文档定位**：本文描述标签体系的**目标架构**，不是当前实现的说明。
>
> `MULTI_SERIAL_DESIGN.md` §6A（第 606 行起）描述**当前实现**：两种层数形态、Shell 的三态宿主、`ownerGroupId` / `detachedColumn` / `topRowColumnId` 三个位置字段、`#serial-group-tab-bar` 的单例借位机制。本文描述要替换它的模型。两者是「现状 / 目标」的关系，不是并列规范；按 §11 的 S1–S5 推进期间，以代码实际所处阶段为准。
>
> **两处最容易读错的地方，先说清**：
>
> 1. **`subRow` 不是每列一条，而是每个 pane 一条**。数量 = `paneSplit.enabled ? panes.length : 1`。组内上下分屏时，同一列里同时存在两条 subRow。
> 2. **`tabPanel` 才是显示面板**。「TabRow 是显示面板」是笔误；TabRow 与 subRow 都只是标签栏，只有 tabPanel 承载内容。

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

## 1. 四个原语

### 1.1 Tab

一棵树上的节点。容器与叶共用同一套身份字段：

| 字段 | 含义 | 谁写 |
|---|---|---|
| `id` | 全局唯一。`tabPanel` 的 DOM id 由它派生，保证 1:1 | 创建时一次性确定 |
| `kind` | `group` / `main` / `filter` / `chart` / `shell` | 同上 |
| `groupId` | 仅 `kind === 'group'`：指向 `serialGroups` 里的分组 | 同上 |
| `order` | **仅根级 Tab**：TabRow 的列顺序 | 同栏重排 |

**Tab 内不存「我在第几列」「我的按钮在哪个 DOM 里」。** 位置全部由结构与派生量决定。这是「聚合」的判据：归属只在一个地方存在。

### 1.2 TabRow

一级标签栏。**每列一条**。内容是这一列的顶层 Tab。

它不是显示面板，不承载任何终端或图表。

### 1.3 subRow

二级标签栏。**属于某个 pane，不属于某列**。可被收起（`collapsed`），收起后该 pane 的标签栏不渲染，但面板继续显示。

### 1.4 tabPanel

与 Tab 严格 1:1 的显示区，`panel.id === tab.id`。

容器 Tab（`kind: 'group'`）**没有自己的 panel**——它只组织布局。叶 Tab 才有 panel。

### 1.5 组合关系

```
列（column）
├── TabRow            ← 该列的顶层 Tab（扁平模式下会展开，见 §5）
├── pane[0]
│   ├── subRow        ← 该 pane 的标签（可收起）
│   └── tabPanel      ← 该 pane 的 activeTabId 对应的面板
├── pane[1]（组内分屏时）
│   ├── subRow
│   └── tabPanel
└── ...
```

四个原语之外没有第五个概念。列不是原语——它是 `split` 的派生结果。

## 2. 单一真源：一棵 Tab 树

### 2.1 结构

```js
workspace = {
  tabs: {
    'grp-default': {
      id: 'grp-default', kind: 'group', parentId: null, order: 0,
      groupId: 'default',
      collapsed: false,
      // 第二级分屏：组内 pane
      paneSplit: { enabled: false, orientation: 'horizontal', sizes: {} },
      panes: [
        { id: 'def-p1', tabIds: ['main-default', 'filter-1'], activeTabId: 'main-default' }
      ]
    },
    'main-default': { id: 'main-default', kind: 'main', parentId: 'grp-default' },
    'filter-1':     { id: 'filter-1', kind: 'filter' },
    'chart-1':      { id: 'chart-1', kind: 'chart' },
    'shell-1':      { id: 'shell-1', kind: 'shell', parentId: null, order: 1 }
  },

  // 非分屏时，哪一列可见
  activeTopTabId: 'grp-default',

  // 第一级分屏：列
  split: { enabled: false, orientation: 'horizontal', sizes: { 'grp-default': 1 } }
};
```

### 2.2 字段权威表

| 字段 | 唯一负责的事实 | 写入点 |
|---|---|---|
| `tabs[id].parentId` | 这个 Tab 属于哪个容器（`null` = 根） | 新建 / 重新归属；**由索引重建统一写入**，见 §2.3 |
| `tabs[id].order` | 根级 Tab 之间的顺序 | 同栏重排 |
| `tabs[group].panes[].tabIds` | 组内子 Tab 的**归属与顺序** | 新建标签、关标签、跨 pane 移动 |
| `tabs[group].panes[].activeTabId` | 该 pane 当前显示哪个叶 | `activateTab()`（规则 1） |
| `tabs[group].paneSplit` | 组内是否分屏、方向、比例 | 组内分屏按钮、组内分界条拖动 |
| `tabs[group].collapsed` | 该容器所有 subRow 是否收起 | 收起按钮 |
| `workspace.activeTopTabId` | 非分屏时显示哪一列 | `activateTab()`（两条规则都写） |
| `workspace.split` | 列分屏开关、方向、各列比例 | 分屏按钮、列分界条拖动 |

**没有**任何字段表示「这个 Tab 在第几列」「按钮挂在哪个 DOM」。这两件事都是派生量（§3）。

### 2.3 `parentId` 是派生缓存，不是独立真源

叶 Tab 的父级完全由 `panes[].tabIds` 决定。若两处都能写，就会不同步。因此：

- 任何改变归属的操作**只写 `panes`**；
- 写完后调用 `rebuildIndex()`，由它重算每个 Tab 的 `parentId`；
- 其余代码只读 `parentId`，从不直接写。

`rebuildIndex()` 的语义是纯函数式的：遍历所有容器的 `panes`，建立 `tabId → groupId` 映射，再写回 `tabs[id].parentId`。O(n)。

### 2.4 为什么是「平铺字典 + parentId」而不是嵌套 children

三种写法都能表达同一棵树，选平铺的理由：

1. **查找 O(1)**。`tabs[id]` 直接命中。嵌套要递归遍历，而标签查找在主路径上（每次点击、每次串口数据回调都要找 tab）。
2. **持久化就是 `Object.values(tabs)`**，不需要递归序列化。
3. **移动节点的代价是改一个字段**。嵌套写法要把节点从父的 `children[]` 摘出再插入，两步操作，存在「摘了一半」的中间态。
4. **`order` 显式存在**，排序不依赖数组下标——数组下标在删除元素时会整体前移，是另一类 bug 源。

代价：求子序列需要过滤全表（O(n)），n 是几十量级，可接受。

### 2.5 旧结构如何落进来

| 旧结构 | 新位置 |
|---|---|
| `groupWorkspaceLayouts` 的 `splitEnabled` / `orientation` / `paneSizes` | 容器 Tab 的 `paneSplit` |
| 同上的 `panes[{id, tabIds[], activeTabId}]` | 容器 Tab 的 `panes`（结构一致，直接搬） |
| 同上的 `activePaneId` | **删除**：焦点 pane 是渲染层状态，不进模型 |
| `filterTabsStore` / `chartTabsStore`（每组一份） | `tabs` 中 `kind === 'filter' / 'chart'` 且 `parentId === <组 id>` 的节点 |
| `shellTabs`（全局一份） | `tabs` 中 `kind === 'shell'`、`parentId === null` 的节点 |
| `tabState.ownerGroupId` | **删除**：Shell 不再有归属维度 |
| `tabState.detachedColumn` | **删除**：Shell 本就是根 Tab |
| `tabState.topRowColumnId` | **删除**：列由 `split` 决定，不再记忆 |
| `SHELL_COLUMN_GROUP_ID` / `shellColumnId()` | **删除**：不再有虚拟的 shell 列 |
| `children[]` 根模型 | 未采用：被 `tabs` 平铺表取代 |

## 3. 派生量

全部只读 `workspace`，不写回任何状态。`tabOf` 是查找辅助，其余七个是派生量。

```js
function tabOf(ws, id) {
  return Object.prototype.hasOwnProperty.call(ws.tabs, id) ? ws.tabs[id] : null;
}

// 根级 Tab，按 order 升序 —— TabRow 的列顺序来源
function roots(ws) {
  return Object.values(ws.tabs)
    .filter(t => t.parentId === null)
    .sort((a, b) => a.order - b.order);
}

// 组内子 Tab：先按 pane 顺序，再按 pane 内 tabIds 顺序
function childrenOfGroup(ws, group) {
  const out = [];
  for (const pane of group.panes || []) {
    for (const id of pane.tabIds) {
      const t = tabOf(ws, id);
      if (t) out.push(t);
    }
  }
  return out;
}

// 标准化 pane 列表：不分屏也至少有一个 pane
function panesOf(ws, group) {
  const panes = group.panes || [];
  return panes.length ? panes : [{ id: 'p-invalid', tabIds: [], activeTabId: null }];
}

// 扁平模式：顶层只有一个串口组（或已经一个都没有）
function isFlat(ws) {
  return roots(ws).filter(t => t.kind === 'group').length <= 1;
}

// 可见列
function columns(ws) {
  if (!ws.split.enabled) {
    const active = tabOf(ws, ws.activeTopTabId);
    return active ? [active] : [];
  }
  return roots(ws);
}

// TabRow 的实际渲染项（扁平模式下容器被展开，见 §5）
function rowItems(ws, column) {
  if (isFlat(ws) && column.kind === 'group') return childrenOfGroup(ws, column);
  return [column];
}

// 可见面板 id 集合 —— 唯一的显隐判据
function visiblePanelIds(ws) {
  const out = new Set();
  for (const col of columns(ws)) {
    if (col.kind === 'group') {
      for (const pane of panesOf(ws, col)) {
        if (pane.activeTabId) out.add(pane.activeTabId);
      }
    } else {
      out.add(col.id);
    }
  }
  return out;
}
```

### 3.1 显隐的唯一判据

```js
panel.hidden = !visiblePanelIds(ws).has(tabId);
```

这就是全部。没有「谁盖住谁」「哪个更高一层」「是不是叠在宿主分组上」的判断。历史上 `stackShellTabOverHostGroup()` + `hideStackedShellTabsIn()` 那套叠层逻辑存在的唯一理由，是 Shell 被塞进了某个 pane；当 Shell 是根 Tab，它自己就是某一列，不需要遮盖任何人。

### 3.2 派生量的用途对照

| 派生量 | 用途 | 对应历史上的什么 |
|---|---|---|
| `roots()` | TabRow 列顺序、分屏比例键 | `serialGroups` + `shellTabs` 的混合顺序 |
| `childrenOfGroup()` | subRow 内容、扁平模式 TabRow 内容 | `filterTabs` + `chartTabs` + main 的拼接 |
| `panesOf()` | 组内 pane 列表 | `groupWorkspaceLayouts.panes` |
| `isFlat()` | 是否渲染 subRow、TabRow 是否展开 | 8 处 `serialGroups.length > 1` |
| `columns()` | 渲染几列、分界条数量 | `getVisibleGroupIds()` + `shellColumnId()` |
| `rowItems()` | TabRow 里实际排哪些按钮 | 「单分组借位」的搬移逻辑 |
| `visiblePanelIds()` | 面板显隐、`fit()` 时机 | `stackShellTabOverHostGroup` 等整套叠层判断 |
| `visiblePanelIds()` | 面板显隐、`fit()` 时机 | `stackShellTabOverHostGroup` 等整套叠层判断 |

## 4. 两级分屏

两级**正交**，各自独立开关：

| 级别 | 载体 | 状态 | 控件 |
|---|---|---|---|
| 第一级：列 | 整个工作区 | `workspace.split` | 分组标签右键菜单、列分界条 |
| 第二级：pane | 单个容器 Tab | `tab.paneSplit` + `tab.panes[]` | 组内分屏按钮、组内分界条 |

### 4.1 第一级：列

`split.enabled === true` 时，`columns()` 返回**全部根级 Tab**，每个一列，按 `order` 横向（或纵向）排列。分界条数量 = `columns().length - 1`。

宽度按 `split.sizes[tabId]` 归一化分配，并扣除分界条占位：`flex-basis: calc(<比例>% - <比例 × 分界条总占位>px)`。这个公式是历史缺陷「最右列越界」的修法（`8f55a0f`），必须保留。

`split.enabled === false` 时，`columns()` 只返回 `activeTopTabId` 对应的那一列，分界条全部隐藏。

**关键点**：列归属**不写进 Tab**。分屏时「每个根 Tab 一列」，所以「谁在哪列」是 `roots().indexOf(tab)` 的派生结果。关掉分屏再打开，列顺序不变——因为 `order` 没变。

### 4.2 第二级：组内 pane

容器的 `panes[]` 是该列内部的分割。`paneSplit.enabled === false` 时只有一个 pane，`panes` 长度仍可为 1（不删除 pane，避免标签失去容器）。

每个 pane 有自己的：

- `subRow`（该 pane 的标签栏）
- `tabPanel` 宿主（该 pane 的内容区）
- `activeTabId`（该 pane 显示哪个叶）

`paneSplit.enabled === true` 时，该列竖向排列：

```
┌──────────────────────────────────┐
│ TabRow  [COM1] [SHELL1]          │
├──────────────────────────────────┤
│ subRow  [MAIN][FILTER][CHART]    │  ← pane-1
├──────────────────────────────────┤
│ tabPanel（pane-1 的 activeTab）   │
├══════════════════════════════════┤  ← 组内分界条
│ subRow  [MAIN]                   │  ← pane-2
├──────────────────────────────────┤
│ tabPanel（pane-2 的 activeTab）   │
└──────────────────────────────────┘
```

### 4.3 两级可以同时开启

| 组合 | 结果 |
|---|---|
| 列关、pane 关 | 一列、一个 pane（最常见的单组单屏） |
| 列开、pane 关 | N 列，每列一个 pane |
| 列关、pane 开 | 一列，该列内部上下 N 个 pane |
| 列开、pane 开 | N 列 × 每列内部 M 个 pane |

两级互不影响：`columns()` 只看 `workspace.split`，`panesOf()` 只看 `tab.paneSplit`。没有任何一处代码需要同时判断两者。

### 4.4 分界条的两种来源

| 分界条 | 由谁生成 | 拖动的状态 |
|---|---|---|
| 列分界条 | `columns()` 的相邻两项 | `workspace.split.sizes` |
| 组内分界条 | `panesOf()` 的相邻两项 | `tab.paneSplit.sizes` |

两者共用同一套几何计算（`placeSplitter` / `applySizes`），但状态容器不同。**不允许**共用一个 `sizes` 对象——列比例和 pane 比例是两个独立维度。

## 5. 扁平模式

### 5.1 判据

```js
function isFlat(ws) {
  return roots(ws).filter(t => t.kind === 'group').length <= 1;
}
```

只有一个串口组（或一个都没有）时成立。这个判断**只在这一处**，全项目不允许再出现 `serialGroups.length > 1` 形式的分支。

### 5.2 扁平模式的布局

```
TabRow:  [MAIN] [FILTER] [CHART] [SHELL1] [SHELL2]
──────────────────────────────────────────────────
内容区：  当前激活 Tab 的 tabPanel
```

容器 Tab（`grp-default`）**不渲染为标签**，它的子 Tab 直接进 TabRow。没有 subRow 行。

多分组模式下：

```
TabRow:  [COM1] [COM2] [SHELL1]
──────────────────────────────────────────────────
subRow:  [MAIN] [FILTER] [CHART]        ← COM1 的 pane-1
──────────────────────────────────────────────────
内容区：  COM1 的 pane-1 的 activeTab
```

### 5.3 扁平模式与现状「单分组隐藏分组行」的区别

界面相似，机制不同。这一点必须写清，否则接手者会以为是同一件事：

| | 现状（单分组） | 新模型（`isFlat`） |
|---|---|---|
| 层数 | 两层中的一层 `hidden` | **只有一层**，第二层不存在 |
| 分组标签 | `#serial-group-tab-bar` 整行 `hidden`，标签靠 `#serial-group-tab-bar` 与 pane 行「借位」搬移 | 分组 Tab **不渲染**，其子 Tab 由 `rowItems()` 直接返回 |
| Shell 位置 | 与 MAIN/FILTER 混排在 pane 行 | 与 MAIN/FILTER 同住 TabRow（都是根级/展开后的项） |
| 切换回多分组 | 逐处 `removeAttribute('hidden')`，容易漏 | 无状态切换，只是 `rowItems()` 的返回变了 |

### 5.4 `parentId` 在扁平模式下保持不变（关键取舍）

**问题**：扁平模式把组内子 Tab 放进了 TabRow。那么这些 Tab 的 `parentId` 应该改成 `null` 吗？

**结论：不改。保留 `parentId` 指向容器，由渲染层投影。**

三条理由：

1. **切换成本**。「只有一个分组」和「有两个分组」是用户随时切换的状态。若按 `parentId` 改写，每次增删分组都要批量改写 N 个 Tab 的归属，任何中途失败都会留下半扁平状态。保留 `parentId` 则切换是零成本的——`rowItems()` 的返回值自动变化。
2. **语义正确**。`parentId` 表达的是「这个 Tab 属于哪个串口组」，这是**数据归属事实**，与「当前是否显示二级栏」无关。把显示状态写进数据模型，正是本文要消除的那类问题（真源混用）。
3. **可变性最小**。删除一个分组时，只需删除它的子 Tab；若 `parentId` 已被改成 `null`，这些子 Tab 会变成孤儿根标签，无法区分「原本独立的 Shell」和「某组的遗留 main」。

因此：

```js
// 渲染层：扁平模式下把容器的子项投影到 TabRow
function rowItems(ws, column) {
  if (isFlat(ws) && column.kind === 'group') return childrenOfGroup(ws, column);
  return [column];
}
```

`rowItems()` 是**唯一的投影点**。模型层完全不知道扁平模式的存在。

### 5.5 扁平模式下的组内 pane 分屏

组内 pane 分屏是保留的能力，它不因扁平模式而失效：

- 只有一个 pane 时（默认）：TabRow 顺序 = `panes[0].tabIds` 顺序，内容区就是该 pane 的 activeTab。完全符合「main、filter、shell 都在 TabRow」。
- 多个 pane 时：TabRow 顺序 = 各 pane 依次拼接，内容区按 pane 竖向分屏，每个 pane 显示自己的 `activeTabId`。

第二种情况下 TabRow 里会同时出现两个处于「激活」状态的标签（分属不同 pane）。这是正确语义，不是缺陷；视觉上需要区分「焦点标签」与「其它 pane 的激活标签」（例如前者实底、后者下划线）。**具体视觉规则留待 S3 实现时确定**——本项标记为开放项，不在本文冻结。

## 6. 不变式

以下八条必须始终成立。它们可以（且应该）写成断言。

| # | 不变式 | 违反后的症状 |
|---|---|---|
| **I1** | 任何 `kind === 'shell'` 的 Tab，其 `parentId === null` | Shell 会出现在 subRow 里，这正是历史缺陷的起点 |
| **I2** | 任何 `panes[].tabIds` 中不含 `kind === 'shell'` 的 id | 同上 |
| **I3** | 每个 Tab 的 `panel.id === tab.id`，且全局唯一 | 面板串台、`fit()` 量错高度 |
| **I4** | 每个 Tab 恰好属于一个 pane（根级 Tab 除外） | 同一标签出现在两条 subRow |
| **I5** | 每个 `kind === 'group'` 的 Tab 至少有一个 pane，且至少有一个叶 | 空白列、无法新建标签 |
| **I6** | `panes[].activeTabId` 必须是该 pane 的 `tabIds` 成员 | 面板显示已被移走的标签 |
| **I7** | `workspace.activeTopTabId` 必须是根级 Tab 的 id | 非分屏时无列可见 |
| **I8** | 面板可见性只由 `visiblePanelIds()` 决定 | 出现「两处同时判断显隐」→ 又一套真源 |

其中 I1 / I2 是结构性硬约束：**Shell 永远不可能进入 pane**。这两条一旦成立，历史上「Shell 跑进 pane 容器」造成的全部缺陷（标签消失、点不动、fit 算错、叠层遮盖）都不能再出现。

### 6.1 三条与 Shell 相关的推论

由 I1 + I2 可以直接推出：

1. Shell 的按钮 `parentElement` 只能是 TabRow 的列表，**绝不能是 subRow 的列表**。
2. Shell 的终端容器挂在工作区级，**绝不在某个 pane 的 `tabs-content` 里**。
3. 分屏时 Shell 自然成为独立一列（因为它是根 Tab，`columns()` 会包含它），不需要 `detachedColumn` 这类字段来「模拟独立成列」。

这三条替代了现有的 `resolveShellTabHost()` 三分支判定、`setShellDetachedColumn()`、`isShellColumnActive()` 等约 10 个函数。

## 7. 渲染规则

### 7.1 唯一入口

```js
renderWorkspace(ws)
```

所有交互（点击、拖拽、新建、关闭、分屏、收起）都只做两件事：

1. 修改 `workspace` 树；
2. 调用 `renderWorkspace()`。

**不允许任何其它地方直接改标签的类名、`hidden` 或 DOM 位置。** 这是本文最重要的一条纪律——现有的 `placeShellTabs()` / `stackShellTabOverHostGroup()` / `applyLayoutToDom()` 三套「各自搬一段 DOM」的实现正是混乱的来源。

### 7.2 渲染的四步

```
renderWorkspace(ws)
  ├── 1. reconcileColumns()   按 columns() 保证列容器数量与顺序
  ├── 2. reconcileRows()      每列：一条 TabRow；多分组时 N 条 subRow（N = panesOf 长度），扁平模式 0 条
  ├── 3. reconcileButtons()   按 rowItems() / childrenOfGroup() 复用或创建按钮
  └── 4. applyVisibility()    panel.hidden = !visiblePanelIds().has(id)
  └── 4. applyVisibility()    panel.hidden = !visiblePanelIds().has(id)
```

每步都以「**比对现状、只改差异**」为原则，而不是「先清空再重建」。

### 7.3 三条渲染约束

**C1：节点复用，不重建。**

按钮与面板按 id 建一次，之后只更新属性与位置。切标签、切分组、分屏都不得产生新节点。

理由（实测）：`renderSerialGroupTabBar()` 原先每次 `replaceChildren()` 重建按钮，导致整条标签栏重排、hover / 焦点态与入场动画一起重播。已修为按 `tab.buttonId` 复用 + `updateGroupTabButtonState()` 就地更新（`0bf62ea`），本模型必须沿用。

**C2：父节点没变就不 `appendChild`。**

`appendChild` 对「已经在该父节点下的子节点」也是先摘再插，`<canvas>`、`<iframe>`、CSS 动画都会在那一刻重放，并且触发整行重排。`applyLayoutToDom()` 已加的判定：

```js
if (tabButton.parentElement !== effectiveTabsList) {
    effectiveTabsList.appendChild(tabButton);
}
```

**C3：没有入场动画。**

`.main-tab`、`.main-tab-pane.active`、`.sidebar-tab-pane` 上的 `animation` 与 `@keyframes fadeIn` / `tabFadeIn` 已全部删除（`0bf62ea`），不得再加回。这些元素在切换时反复显隐，任何入场动画都会变成「每切一次闪一次」。

### 7.4 事件绑定

按钮不再重建后，事件**不能**在构造时用闭包绑定 `tabId` —— 闭包会永久持有旧值，重新归属或重命名后点击会落到旧语义上。

规则：**在列表容器上委托**，从 `dataset.tabId` 现读。

现有 `bindGroupTabListEvents(listEl)` 已是这个形态，S2 将其泛化为 `bindTabListEvents(listEl)`（一套处理 TabRow 与 subRow）。用 `dataset.tabListEvents` 去重，保证同一个列表只挂一次。

### 7.5 `fit()` 的时机

xterm 的 `fit()` 依赖容器有真实尺寸。规则：

| 时机 | 动作 |
|---|---|
| `applyVisibility()` 之后 | 对本帧新变为可见的面板调用 `fit()` |
| 分屏比例变化后 | 对受影响列的全部可见面板调用 `fit()` |
| **面板处于 `display:none` 时** | **不调用** —— 容器尺寸为 0，`fit()` 会把终端算成极小尺寸 |

历史上「面板同时 `.active` 导致 `fit()` 算错高度」的缺陷，根因是显隐没有单一判据。I8 成立后，任何时刻只有一个面板处于可见集合中（每 pane 一个），`fit()` 不再可能对隐藏面板执行。

## 8. 交互语义

### 8.1 激活：一个入口，两条规则

现有的四条切换路径（`switchPaneTab` / `switchShellTab` / `activateShellTabInHost` / `revealSerialGroupActiveTab`）合并为一个入口 `activateTab(tabId)`，内含两条规则：

```js
function activateTab(tabId) {
  const tab = tabOf(ws, tabId);
  if (!tab) return;

  if (tab.kind === 'group') {
    // 规则 2：容器被点击 → 它成为可见列；并保证每个 pane 都有激活项
    ws.activeTopTabId = tab.id;
    for (const pane of panesOf(ws, tab)) {
      if (!pane.activeTabId) {
        const first = pane.tabIds.map(id => tabOf(ws, id)).find(Boolean);
        if (first) pane.activeTabId = first.id;
      }
    }
  } else {
    // 规则 1：叶被点击 → 自己显示，并沿父链把所在容器也指向它
    const parent = tab.parentId ? tabOf(ws, tab.parentId) : null;
    if (parent && parent.kind === 'group') {
      for (const pane of panesOf(ws, parent)) {
        if (pane.tabIds.includes(tabId)) { pane.activeTabId = tabId; break; }
      }
    }
    ws.activeTopTabId = parent ? parent.id : tab.id;
  }

  renderWorkspace(ws);
}
```

两条规则的分工：容器被点击只改「哪一列可见」，叶被点击只改「pane 显示谁」。没有第三种情况。

**为什么 `revealSerialGroupActiveTab` 可以删**：它的存在理由是「Shell 盖住了串口，点串口标签时要先把它挖出来」。当 Shell 是独立列、与串口组互不遮挡时（I1 + I2），不存在需要「揭露」的场景。

### 8.2 拖拽：只做同栏重排

**唯一允许的拖拽动作**：在同一行内改变顺序。

```js
// scope：{ kind: 'row' } 表示 TabRow，{ kind: 'pane', groupId, paneId } 表示某条 subRow
function reorderInRow(scope, tabId, targetIndex)
```

| 行 | 改什么 |
|---|---|
| TabRow | 根级 Tab 的 `order`（重新赋 0..n-1） |
| subRow | 所属 pane 的 `tabIds` 数组顺序 |

**跨行拖动一律不做**。这是删除「Shell 可拖到二级栏」需求的直接结果：

- Shell 不可能进入 subRow（I1 / I2）；
- 组内叶标签不可能升到根级（否则它的 `parentId` 无处安放）；
- 因此「拖到别的行」这个动作**没有任何合法落点**。

于是拖拽代码只剩一个入口，不再需要 `targetColumnId` / `targetGroupId` / `isShell` 三分支。现有的 `finishWorkspaceTabDrag()` 里约 50 行分支（含 2640–2648 的 `setShellOwnerGroup` 调用）可整体删除。

### 8.3 收起

`collapsed` 只对容器 Tab 有效。收起按钮只在「有第二行可收」时出现：

| 情形 | subRow 行数 | 收起按钮 |
|---|---|---|
| 扁平模式（`isFlat`） | 0（容器被展开进 TabRow） | 不渲染 |
| 单 pane（`paneSplit.enabled === false`） | 1 | 不渲染 |
| 多 pane（`paneSplit.enabled === true`） | `panes.length` ≥ 2 | 渲染 |

收起后：该容器的所有 subRow 不渲染，但 `activeTabId` 照常工作，面板继续显示。

按钮的判定只看这一列渲染出的 subRow 数量，与「第几层」「是不是单分组」都无关——历史上 `syncGroupSubRowVisibility()` 里「单分组时清 hidden」的分支因此消失。

### 8.4 新建 / 关闭标签

| 动作 | 唯一写入 |
|---|---|
| 新建 main / filter / chart | 往目标容器的 `panes[?].tabIds` 追加，置 `activeTabId` |
| 新建 shell | 往 `tabs` 加一个 `parentId: null` 的节点，`order = roots().length` |
| 新建分组 | 加一个 `parentId: null` 的容器 Tab，自带 `panes: [{ id, tabIds: [main], activeTabId: main }]` |
| 关闭叶标签 | 从 `panes[].tabIds` 删除；若删的是 `activeTabId`，激活同 pane 的相邻项 |
| 关闭分组 | 删除容器与其全部子 Tab；若它独占一列，`split.sizes` 里对应键一并删除 |

关闭后必须调用 `rebuildIndex()`（§2.3），保证 `parentId` 与 `panes` 一致。

### 8.5 新建 Shell 按钮的层级

规则简化为一条：

```js
addShellButton.hidden = !isFlat(ws);
```

扁平模式下容器被展开，TabRow 就是唯一一层，按钮在那里；多分组模式下 Shell 是根级 Tab，也在 TabRow。**两种情况下按钮都在同一处**，因此规则就是「非扁平时才显示」。

扁平模式下容器被展开，TabRow 就是唯一一层，按钮在那里；多分组模式下也在 TabRow，因为 Shell 永远是根级 Tab。**两种情况下按钮都在同一处**，不再需要「恰好一个可见」的扫描。

现有的五个产生点（`#pane-1-new-shell-tab-btn`、`#pane-2-new-shell-tab-btn`、`createPaneElement()` 的 `buttonSpecs`、`createGroupPaneElement()` 的 `buttonSpecs`、`#add-shell-tab-btn`）中，前四个随 pane 行一起消失（pane 行不再承载 Shell 入口），只保留 TabRow 里的那一个。

### 8.6 右键菜单

分组标签的右键菜单项（重命名、关闭、新建 Shell、分屏）挂在 `kind === 'group'` 的按钮上。判据 `tabOf(ws, id).kind === 'group'`，不需要判断它当前在哪一层。

## 9. 持久化与迁移

### 9.1 持久化的形状

就是这一棵树，不含任何渲染状态：

```jsonc
{
  "tabs": [
    { "id": "grp-default", "kind": "group", "parentId": null, "order": 0,
      "groupId": "default", "collapsed": false,
      "paneSplit": { "enabled": false, "orientation": "horizontal", "sizes": {} },
      "panes": [ { "id": "def-p1", "tabIds": ["main-default", "filter-1"], "activeTabId": "main-default" } ] },
    { "id": "shell-1", "kind": "shell", "parentId": null, "order": 1 }
  ],
  "activeTopTabId": "grp-default",
  "split": { "enabled": false, "orientation": "horizontal", "sizes": {} }
}
```

`tabs` 存为**平铺数组**（`Object.values`），读取时建索引。持久化格式与内存结构同形，不另设 DTO。

### 9.2 不持久化的东西

以下全部是渲染期状态，写进配置只会制造第二真源：

- 焦点 pane（原 `activePaneId`）
- 按钮 DOM 引用、`buttonId`
- 列表滚动位置、hover / 焦点
- 分界条元素本身（每次渲染按需创建/复用，不进配置）

### 9.3 迁移

`SERIAL_GROUPS_CONFIG_VERSION` 递增一版。`migrateSerialGroupsConfig()` 增加一个分支：

| 旧字段 | 处理 |
|---|---|
| `group.workspaceLayout.panes[]` | 搬到容器 Tab 的 `panes[]`（结构一致，直接引用） |
| `group.workspaceLayout.splitEnabled` / `orientation` / `paneSizes` | 搬到容器 Tab 的 `paneSplit` |
| `group.workspaceLayout.activePaneId` | **丢弃** |
| `shellTab.ownerGroupId` | **丢弃**（归属维度消失） |
| `shellTab.detachedColumn` | **丢弃**（Shell 天生是根 Tab） |
| `shellTab.topRowColumnId` | **丢弃**（列由 `split` 决定） |
| `shellTabs[]` / `filterTabs[]` / `chartTabs[]` | 转为 `tabs` 中的节点，`parentId` 分别为 `null` / 所属组 |
| `workspaceLayout.split`（组级） | 搬到 `workspace.split` |

迁移后必须做一次 `rebuildIndex()` + 断言 I1–I8。**任何一条不变式不成立就拒绝保存并回落默认布局**，不允许把半合法状态写进配置文件。

`normalizeSerialGroup()` 是 `{...defaults, ...source}` 形态，新键会自动保留；但主进程每次存盘都会 `normalizeConfig → migrateSerialGroupsConfig` **重建整个分组对象**，因此新的 `panes` / `paneSplit` 字段必须在 `normalizeSerialGroup()` 里显式保留，否则会在一次保存后静默丢失。

### 9.4 兼容性

- 旧配置文件（无 `tabs` 键）→ 走迁移分支，用户无感。
- 新配置被旧版本读取 → 旧版本不认识 `tabs`，会按「没有任何标签」处理。**不做向下兼容**：旧版本已经是待替换的形态，回退旧版本本身就意味着放弃新布局。

## 10. 与现有 `renderer.js` 的映射

行号基于 HEAD `9845c82`。若后续提交改变了行号，以函数名为准。

### 10.1 删除清单

| 位置（HEAD） | 现有实现 | 新模型 |
|---|---|---|
| 2332 | `getShellTabOwner(tabState)` | 删除 |
| 2338 | `setShellTabOwner(tabId, owner)` | 删除 |
| 2352 | `setShellDetachedColumn(tabId, detached)` | 删除 |
| 2608–2657 | `finishWorkspaceTabDrag(state)` 的 `targetColumnId` / `isShell` 分支 | 改为 `reorderInRow()`，只保留同栏重排 |
| 4203 | `renderSerialGroupTabBar()`（已改为复用节点） | 由 `renderWorkspace()` 取代 |
| 4290 | `syncShellAddButtonVisibility()` | 改为一行 `addShellButton.hidden = !isFlat(ws)` |
| 4418 | `syncSerialGroupAddButtonLayer()` | 随层数统一后删除（按钮只有一个位置） |
| 4442 | `syncShellTabLayer()`（含 `isSyncingShellLayer` 重入闸） | 删除：递归环 `placeShellTabs → addTabToPane → applyLayoutToDom` 不再存在 |
| 4518–4600 | `resolveShellTabHost(tabState)` 三分支 | 删除：Shell 宿主恒为 TabRow |
| 4664 | `syncShellLayoutOwnership()`（整函数） | 删除：不再需要「从 A 组摘、登记进 B 组」 |
| 4706 | `isUnownedShellActiveIn(groupId)` | 删除（现为零引用死代码） |
| 4727 | `syncGroupSubRowVisibility()` | 由 `renderWorkspace()` 的第 2 步取代 |
| 4774 | `resolveWorkspaceTabButtonHost(tabId, paneId)` | 删除：布局层不再反向量子询问渲染层 |
| 4825 | `stackShellTabOverHostGroup()` / `hideStackedShellTabsIn()` | 删除：Shell 不再叠在任何 pane 上 |
| 4881 | `revealSerialGroupActiveTab(groupId)` | 删除：没有「被盖住的串口」需要揭露 |
| 4872 | `lastSerialTabByPane`（Map） | 删除 |
| 5123 | `persistShellTabs()` 写 `ownerGroupId` / `detachedColumn` | 改为写 `workspace.tabs` |
| 5136 | `createShellTab()` 里的 `ownerGroupId`（5233）/ `detachedColumn`（5237）初始化 | 删除这两个字段 |

### 10.2 保留并改造

| 位置（HEAD） | 现有实现 | 改造 |
|---|---|---|
| 1964–1967 | `filterTabsStore` / `chartTabsStore` + `filterTabs` / `chartTabs` 别名 | 迁入 `workspace.tabs`，store 删除 |
| 1981 | `let shellTabs = [];`（全局一份） | 迁入 `workspace.tabs` |
| 4385 | `bindGroupTabListEvents(listEl)` | 泛化为 `bindTabListEvents(listEl)`，同时服务 TabRow 与 subRow |
| 4318–4410 | `buildGroupTabButton` / `updateGroupTabButtonState` | 泛化为 `buildTabButton` / `updateTabButtonState`，按 `kind` 决定图标与菜单 |
| 3395 | `createGroupTabRowElement()` 内的 `bindGroupTabListEvents(list)` | 保留形态，改调 `bindTabListEvents` |
| `workspace-manager.js:357–375` | `applyLayoutToDom()` 的 `parentElement !==` 判定 | 保留该判定（这是 C2 的实现，非临时补丁），但注入点 `resolveTabButtonHost` 删除 |

### 10.3 不可误改

`renderer.js:8503-8504` 的 `ownerGroupId` 是**串口端口占用**字段（对应 `main.js:3058` 的 `SERIAL_PORT_IN_USE` 协议），与 Shell 归属**完全无关**。全局删除 `ownerGroupId` 时必须排除此处，否则端口占用保护会失效。

同名的字段分属两个语义，这本身就是重命名该做的理由：迁移时建议把端口占用的那个改名为 `portOwnerGroupId` 以示区分。

### 10.4 具体要删多少

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

整体估计净减 **600–800 行**，Shell 相关顶层函数从 46 个降到约 25 个。这是「复用性强」的量化依据：删掉一个维度后，所有为跨越该维度而写的胶水代码全部失去存在理由。

## 11. 分阶段实施

正向替换，不做大爆炸。每个阶段独立可验证、独立可提交。

| 阶段 | 内容 | 验证 |
|---|---|---|
| **S1** | 新建 `tab-model.js`：`tabs` 树的读写、`rebuildIndex()`、§3 的派生量、不变式断言。**不接渲染。** 配套 `test/tab-model.test.js` | `npm test` |
| **S2** | `renderWorkspace()` 上线：列容器 + TabRow + subRow 的 reconcile，按钮复用。删除 `#serial-group-tab-bar` 单例借位机制 | `verify-group-columns` / `verify-group-split` |
| **S3** | subRow 按 pane 一条；组内 pane 分屏；删除 Shell 叠层机制（`stackShellTabOverHostGroup` / `hideStackedShellTabsIn`） | `verify-shell` / `verify-shell-buttons-split` |
| **S4** | 删除 `ownerGroupId` / `detachedColumn` / `topRowColumnId` 及其全部依赖函数；`finishWorkspaceTabDrag` 改为只允许同栏重排 | `verify-shell-drag`（断言改写为「只能同栏重排」）/ `verify-shell-switchback` |
| **S5** | 配置迁移（§9.3）+ 删除旧 `workspaceLayout` 结构 | 启动迁移测试 + 全量 CDP |

**每阶段的核心纪律**：所有交互只改 `workspace` 树，然后调 `renderWorkspace()`；不允许任何地方直接改 DOM 的类名或位置。S2 之后若仍发现「某处直接 `appendChild` 标签按钮」，说明该处漏改。

**S1 必须先做**：`tab-model.js` 是纯逻辑，可在 Node 里直接断言，零 GUI 依赖。模型层的 bug 在 S1 就应全部暴露，不要留到 S2 之后靠 CDP 排查。

## 12. 已知边界

**本文的模型尚未实现，零代码、零 GUI 验证。** 以下事项在实施时必须重新取证：

| # | 未验证项 | 说明 |
|---|---|---|
| 1 | 两级分屏同时开启的实际观感 | §4.3 的四种组合中，「列开 + pane 开」只有设计推演，没有实现 |
| 2 | 扁平模式 + 多 pane 的标签焦点视觉 | §5.5 末尾的开放项：TabRow 里同时有两个「激活」标签时需要区分焦点标签，具体视觉规则未定 |
| 3 | 真实鼠标拖动分界条的手感与最小宽度 | 现有证据仅为合成 `PointerEvent`；硬限 `MIN_SHARE = 0.1` |
| 4 | 四条以上分屏时每一条分界条的独立拖动 | 只有三条的实测 |
| 5 | 窗口尺寸变化后旧比例是否仍然合理 | 未验证 |
| 6 | 两级分屏下 xterm `fit()` 从 `display:none` 切回后的尺寸 | 未肉眼确认 |
| 7 | `flatMode` 下 `parentId` 的保留策略 | §5.4 是**推荐方案**，尚未经用户确认 |
| 8 | 迁移后旧配置的实际恢复效果 | 需要真实旧版配置样本 |

同时如实说明既有的验证缺口（与本模型无关，但同样未解决）：

- 任何多串口特性都没有做过真实的**双端口字节流端到端**验证。
- per-group 作用域下两组同时收数据时各自的日志前缀 / 回显，只有 `getPrefix()` 直接调用的证据。
- 标签切换闪烁的修复（`0bf62ea`）只有 CDP 合成点击 + `getComputedStyle` 证据，未做真实用户手测。

## 附：一句话总结

**一棵 Tab 树 + 一组派生量 + 一个渲染入口。** 标签的「位置」不再是数据，而是结构的投影；`flatMode` 不再是两种实现，而是同一个投影函数的不同返回。

---

**相关文档**

- `MULTI_SERIAL_DESIGN.md` §6A —— **当前实现**的权威描述（本文的目标状态尚未落地）
- `agent_notes.md` §13A.9–§13A.15 —— 标签相关的历次缺陷与教训
- `ToDo.md` —— CDP 验证清单（15 个脚本 / 281 条断言）

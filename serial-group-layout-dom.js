'use strict';

// 分组级工作区的 DOM 标识契约（P5 两级分屏的基础设施）。
//
// 背景：改造前整个应用只有**一套** pane 结构（`#workspace-root` 下的静态
// `pane-1` / `pane-2`），所有串口分组的主标签都被塞进同一个 `pane-1`，
// 靠 `.main-tab-pane.active` 互斥显示。于是「分组级分屏」根本没有表达位置。
//
// 两级分屏要求每个分组各自拥有一套 pane 结构，因此 pane id 必须带上分组维度。
// 这里把命名规则收成一个可断言的纯函数集合，理由与 serial-group-dom.js 相同：
// id 一旦漂移，失败方式是「终端区一片空白」或「布局莫名其妙不生效」，没有报错。
//
// **最关键的一条约束：默认分组的 id 必须与改造前的静态标记逐字一致。**
//
// 这不是为了省事。`#serial-container` 位于静态 `pane-1` 内，而默认分组的 xterm
// 在 renderer.js **模块加载期**就 `open()` 了它（`createSerialRuntime` 在顶层被
// `serialRuntimes.getOrCreate()` 调用）。只要默认分组的 root / pane-1 / splitter
// 沿用 `workspace-root` / `pane-1` / `workspace-splitter`，这条启动路径就完全不
// 受影响——重构不可能在这里引入「xterm 重复 open 丢内容」这类静默故障。
// 非默认分组才需要新 id，而它们的终端是**惰性**创建的，没有这个时序约束。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

// 非默认分组在 id 里使用的后缀；默认分组为空串（沿用静态 id）。
function groupWorkspaceSuffix(groupId) {
  const id = normalizeGroupId(groupId);
  if (id === DEFAULT_SERIAL_GROUP_ID) return '';
  // 与 serial-group-dom.js 同一套净化规则：配置是用户可编辑的文本文件，
  // 含空格或冒号的 id 直接进 querySelector 会抛 SyntaxError。
  return `-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// 分组的 pane 容器根节点。默认分组 → 'workspace-root'（沿用静态标记）。
function groupWorkspaceRootId(groupId) {
  return `workspace-root${groupWorkspaceSuffix(groupId)}`;
}

// 分组内第 index 个 pane 的 id（index 从 1 开始，与用户看到的 pane-1/pane-2 对齐）。
// 默认分组 → 'pane-1' / 'pane-2'；其它分组 → 'pane-1-g-1' / 'pane-2-g-1'。
//
// 后缀放在**尾部**而不是 `pane-g-1-1`：保持 `pane-<n>` 这个前缀，
// `[id^="pane-"]` 这类批量查找才可能生效，与 serial-container 的选择一致。
function groupPaneId(groupId, index) {
  const position = Math.max(1, Math.trunc(Number(index) || 1));
  return `pane-${position}${groupWorkspaceSuffix(groupId)}`;
}

// 分组内 pane 之间的拖动分界条。
function groupSplitterId(groupId) {
  return `workspace-splitter${groupWorkspaceSuffix(groupId)}`;
}

// 外层容器：把某个分组的整套 pane 结构包在一起。
//
// 默认分组也带后缀，与上面三个不同——它是**新增**的元素，没有静态标记依赖，
// 统一带后缀可以避免「默认分组的容器到底叫什么」这类特例记忆负担。
function groupWorkspaceContainerId(groupId) {
  const id = normalizeGroupId(groupId);
  return `serial-group-workspace-${id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

// 一个分组默认拥有几个 pane。首版保持 1 个（不分屏），
// 分屏后由布局层按需追加，与 pane-layout-dom 的「按需创建」一致。
const DEFAULT_GROUP_PANE_COUNT = 1;

// 描述一个分组的 pane id 列表。paneCount 只是起点数量：布局层随后可以追加，
// 因此这里不承诺「就是这么多」，只承诺「这前 N 个一定按这个规则命名」。
function describeGroupPanes(groupId, { paneCount = DEFAULT_GROUP_PANE_COUNT } = {}) {
  const count = Math.max(1, Math.trunc(Number(paneCount) || DEFAULT_GROUP_PANE_COUNT));
  const panes = [];
  for (let index = 1; index <= count; index += 1) {
    panes.push({
      paneId: groupPaneId(groupId, index),
      index,
      isPrimary: index === 1
    });
  }
  return panes;
}

// 描述一个分组的整套工作区结构。仍是纯数据，不碰 DOM。
function describeGroupWorkspace(groupId, options = {}) {
  const panes = describeGroupPanes(groupId, options);
  return {
    groupId: normalizeGroupId(groupId),
    containerId: groupWorkspaceContainerId(groupId),
    rootId: groupWorkspaceRootId(groupId),
    splitterId: groupSplitterId(groupId),
    panes,
    paneIds: panes.map(pane => pane.paneId)
  };
}

// 找出「布局里有、DOM 里还没有」的 pane。调用方必须先补齐节点再让布局层操作，
// 否则 appendChild(null) 既不报错也不警告，标签页会静默消失。
function findMissingGroupPaneIds(workspace, hasPaneElement) {
  const paneIds = Array.isArray(workspace?.paneIds) ? workspace.paneIds : [];
  if (typeof hasPaneElement !== 'function') return paneIds.slice();
  return paneIds.filter(paneId => !hasPaneElement(paneId));
}

// ---- 外层（分组级）分屏的 id 契约 ----
//
// 两级分屏的外层容器把「每个分组的工作区」当作一个外层面板。它与内层 pane 是两套独立概念：
// 内层 pane id 是 `pane-<n><后缀>`，外层容器 id 是 `serial-group-workspace-<g>`，
// 两者不能混用，否则「哪个分组在哪个外层面板」就无从表达。
const GROUP_WORKSPACE_CONTAINER_ID = 'group-workspace';
const GROUP_WORKSPACE_SPLITTER_ID = 'group-workspace-splitter';

// 外层条目 = 「一个分组在分组级容器里占的那一列」。列内自上而下是「本组的分组标签行 →
// 本组的工作区（.workspace-root）」。
//
// 改名背后的结构变化：改造前默认分组直接拿静态 #workspace-root 当外层条目，
// 于是分组标签只能挤在容器顶部的一条共享行里，与它自己那一列脱开。现在每个分组
// （含默认分组）都有一层列容器：默认分组是 index.html 里的静态
// #serial-group-workspace-default，内部 #workspace-root 及其全部后代 id 逐字不变。
//
// 「默认分组不能改 root 的 id」这条约束依然成立：xterm 在模块加载期就 open() 了
// #serial-container，祖先链**多一层** div 不会重新 open，改 id 才会。
function groupWorkspaceEntryId(groupId) {
  return groupWorkspaceContainerId(groupId);
}

// 每列顶部的分组标签行。
//
// 结构与 groupWorkspaceContainerId 同一套规则：默认分组沿用静态标记
// （`serial-group-tab-bar` / `serial-group-tab-list`，index.html 里已有），
// 其它分组带后缀。分组标签行必须住在**列内部**，否则它会变成一条跨列的共享顶栏，
// 用户看到的仍是「所有分组标签挤在一条行里」，而不是「位于自己分组页上方」。
function groupTabRowId(groupId) {
  const id = normalizeGroupId(groupId);
  if (id === DEFAULT_SERIAL_GROUP_ID) return 'serial-group-tab-bar';
  return `serial-group-tab-bar${groupWorkspaceSuffix(id)}`;
}

function groupTabListId(groupId) {
  const id = normalizeGroupId(groupId);
  if (id === DEFAULT_SERIAL_GROUP_ID) return 'serial-group-tab-list';
  return `serial-group-tab-list${groupWorkspaceSuffix(id)}`;
}

// 找出「应该显示的外层条目」。分组数 >= 2 时才用分组级分屏；
// 只有一个分组时外层只留默认分组那一列，且不分屏。
// 列内部的工作区根用 rootId 表示，两套 id 不能混用。
function resolveGroupWorkspaceEntries(groupIds) {
  const ids = Array.isArray(groupIds) ? groupIds.filter(id => typeof id === 'string' && id) : [];
  return ids.map(groupId => ({
    groupId: normalizeGroupId(groupId),
    entryId: groupWorkspaceEntryId(groupId),
    paneIds: describeGroupWorkspace(groupId).paneIds
  }));
}

// ---- Shell 独立列（不归属任何串口分组时的落点）----
//
// Shell 标签默认不归属任何串口分组（锁定决策）。单分组时它混在 pane 标签行里；
// 多分组且用户没有把它拖进某个分组时，它是一个**独立的分组列**：该列只有一条标签行
// （放的正是 Shell 标签），下面直接是 Shell 的内容区 —— 正是用户要求「shell 标签页
// 如果独立一组，则该组只显示一行标签栏」。
//
// 这一列**不属于 `serialGroups`**，因此在结构上用一个不可能与真实分组 id 撞车的伪 id
// （`__shell__`）参与现有的 id 运算。
//
// 关键取舍：这些 id **不另起一套命名**，而是逐字复用 groupWorkspaceContainerId /
// groupTabRowId / groupTabListId / groupPaneId 对 `__shell__` 的计算结果。
// 独立列在结构上就是「一个只有单行标签栏的分组列」，复用同一套运算后它才能自动进入
// 现有的可见性遍历、分屏比例写回与 pane 布局层，不必在二十多处写「这是不是 shell」。
const SHELL_COLUMN_GROUP_ID = '__shell__';

function shellColumnId() {
  return groupWorkspaceContainerId(SHELL_COLUMN_GROUP_ID);
}

function shellTabRowId() {
  return groupTabRowId(SHELL_COLUMN_GROUP_ID);
}

function shellTabListId() {
  return groupTabListId(SHELL_COLUMN_GROUP_ID);
}

function shellWorkspaceRootId() {
  return groupWorkspaceRootId(SHELL_COLUMN_GROUP_ID);
}

// Shell 独立列里的 pane。它没有第二层标签行，所以只有一个 pane 与一个内容区。
function shellPaneId() {
  return groupPaneId(SHELL_COLUMN_GROUP_ID, 1);
}

function shellPaneTabsContentId() {
  return `${shellPaneId()}-tabs-content`;
}

module.exports = {
  DEFAULT_GROUP_PANE_COUNT,
  GROUP_WORKSPACE_CONTAINER_ID,
  GROUP_WORKSPACE_SPLITTER_ID,
  groupWorkspaceSuffix,
  groupWorkspaceRootId,
  groupPaneId,
  groupSplitterId,
  groupWorkspaceContainerId,
  groupWorkspaceEntryId,
  groupTabRowId,
  groupTabListId,
  SHELL_COLUMN_GROUP_ID,
  shellColumnId,
  shellTabRowId,
  shellTabListId,
  shellWorkspaceRootId,
  shellPaneId,
  shellPaneTabsContentId,
  resolveGroupWorkspaceEntries,
  describeGroupPanes,
  describeGroupWorkspace,
  findMissingGroupPaneIds
};

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

// 这是第一个分支的 id：默认分组不额外包一层，它自己就是静态 #workspace-root。
// 其它分组则套一个 .serial-group-workspace 容器。
//
// 为什么默认分组不包：把 #workspace-root 再包一层会改变 #serial-container 的祖先链，
// 而 xterm 在模块加载期就 open() 了它。现在的做法是「默认分组直接占外层容器的一个位置」，
// 启动路径的 DOM 结构除了多一个父层（#group-workspace）之外完全不变。
function groupWorkspaceEntryId(groupId) {
  const id = normalizeGroupId(groupId);
  if (id === DEFAULT_SERIAL_GROUP_ID) return groupWorkspaceRootId(id);
  return groupWorkspaceContainerId(id);
}

// 找出「应该显示的外层条目」。分组数 >= 2 时才用分组级分屏；
// 只有一个分组时外层只留默认分组那一条，且不分屏。
function resolveGroupWorkspaceEntries(groupIds) {
  const ids = Array.isArray(groupIds) ? groupIds.filter(id => typeof id === 'string' && id) : [];
  return ids.map(groupId => ({
    groupId: normalizeGroupId(groupId),
    entryId: groupWorkspaceEntryId(groupId),
    paneIds: describeGroupWorkspace(groupId).paneIds
  }));
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
  resolveGroupWorkspaceEntries,
  describeGroupPanes,
  describeGroupWorkspace,
  findMissingGroupPaneIds
};

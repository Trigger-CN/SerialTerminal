'use strict';

// P3 双层标签栏的**纯逻辑层**：只决定「哪个标签属于哪一层」，不碰 DOM。
//
// 之所以先抽出这一层：双层标签栏真正的难点不在样式，而在归属判定。
// 一旦归属算错，标签会出现在错误的一层或整套消失，而且这类错误在浏览器里
// 只能靠肉眼发现。把它做成纯函数就能在 Node 里断言。
//
// 三条硬性规则（来自 MULTI_SERIAL_DESIGN.md 第 6 节，改动前必须先读）：
//   1. Shell 标签**永不归属任何分组**，始终在分组层。
//   2. 分组数 >= 2 时双层；= 1 时塌回一层，Shell 与串口标签混排在同一层。
//   3. 切换分组只切换下层的可见标签集合，不销毁任何 DOM。

const TAB_BAR_MODE_SINGLE = 'single';
const TAB_BAR_MODE_DOUBLE = 'double';

const LAYER_GROUP = 'group';
const LAYER_TAB = 'tab';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 归一化分组列表：丢掉非法项与重复 id。
//
// 重复 id 必须在这里去掉，否则同一个分组会在标签栏出现两次，而两次点击都会
// 指向同一个 activeGroupId——视觉上像「点了没反应」，实际是渲染了两个相同项。
function normalizeGroups(groups) {
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  const normalized = [];
  groups.forEach((group, index) => {
    if (!isPlainObject(group)) return;
    const id = typeof group.id === 'string' && group.id.trim() ? group.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    const title = typeof group.title === 'string' && group.title.trim()
      ? group.title.trim()
      : `Serial ${index + 1}`;
    normalized.push({
      id,
      title,
      connected: group.connected === true,
      status: typeof group.status === 'string' ? group.status : 'disconnected'
    });
  });
  return normalized;
}

// 解析当前分组：传进来的 activeGroupId 不存在时退回第一个分组。
//
// 必须退还而不是返回 null：调用方拿 null 去取子标签会整层空掉，
// 表现为「切到一个不存在的分组后，下层标签全都不见了且无法恢复」。
function resolveActiveGroupId(groups, activeGroupId) {
  if (!Array.isArray(groups) || groups.length === 0) return null;
  if (typeof activeGroupId === 'string' && groups.some(group => group.id === activeGroupId)) {
    return activeGroupId;
  }
  return groups[0].id;
}

function normalizeTabList(tabs) {
  if (!Array.isArray(tabs)) return [];
  const seen = new Set();
  const normalized = [];
  tabs.forEach(tab => {
    if (!isPlainObject(tab)) return;
    const id = typeof tab.id === 'string' && tab.id.trim() ? tab.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalized.push({
      id,
      title: typeof tab.title === 'string' ? tab.title : '',
      kind: typeof tab.kind === 'string' ? tab.kind : 'filter',
      closable: tab.closable !== false
    });
  });
  return normalized;
}

function normalizeIdList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  list.forEach(id => {
    if (typeof id !== 'string' || !id.trim()) return;
    const trimmed = id.trim();
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    result.push(trimmed);
  });
  return result;
}

// 主入口：算出标签栏的两层内容。
//
// groupTabs 的形状是 { [groupId]: { tabs: [...], activeTabId } }。
// 之所以按分组传进来而不是各自去查全局状态：这个函数必须能在 Node 里
// 用普通对象断言，不能依赖任何模块级可变状态。
function buildTabBarModel(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const groups = normalizeGroups(source.groups);
  const shellTabs = normalizeTabList(source.shellTabs);
  const groupTabs = isPlainObject(source.groupTabs) ? source.groupTabs : {};

  const activeGroupId = resolveActiveGroupId(groups, source.activeGroupId);
  const isMultiGroup = groups.length > 1;
  const mode = isMultiGroup ? TAB_BAR_MODE_DOUBLE : TAB_BAR_MODE_SINGLE;

  // 分组层：多分组时是「分组 + Shell」；单分组时分组本身不显示为标签
  //（只有一个分组，再显示一个分组标签就是纯噪声），只留 Shell。
  const groupLayer = isMultiGroup
    ? [
        ...groups.map(group => ({
          id: group.id,
          title: group.title,
          kind: 'group',
          active: group.id === activeGroupId,
          connected: group.connected,
          closable: true
        })),
        ...shellTabs.map(tab => ({ ...tab, active: tab.active === true, closable: tab.closable }))
      ]
    : shellTabs.map(tab => ({ ...tab, active: tab.active === true, closable: tab.closable }));

  const activeGroupTabState = activeGroupId && isPlainObject(groupTabs[activeGroupId])
    ? groupTabs[activeGroupId]
    : {};
  const tabs = normalizeTabList(activeGroupTabState.tabs);

  // 下层只包含当前分组自己的标签。activeTabId 若不在这个列表里就退回第一个，
  // 否则下层会处于「一个都没选中」的状态，终端区看起来是空的。
  let activeTabId = typeof activeGroupTabState.activeTabId === 'string'
    ? activeGroupTabState.activeTabId
    : '';
  if (!tabs.some(tab => tab.id === activeTabId)) {
    activeTabId = tabs.length > 0 ? tabs[0].id : '';
  }

  const tabLayer = tabs.map(tab => ({
    ...tab,
    active: tab.id === activeTabId
  }));

  // 单分组时把串口标签与 Shell 混排在一层，顺序保持「串口标签在前、Shell 在后」，
  // 与改造前的主标签栏顺序一致。
  const singleLayer = mode === TAB_BAR_MODE_SINGLE
    ? [...tabLayer, ...groupLayer]
    : null;

  return {
    mode,
    isMultiGroup,
    activeGroupId,
    groupLayer,
    tabLayer,
    singleLayer,
    // 当前可见的全部标签，供键盘导航与测试断言使用。
    visibleTabs: singleLayer || [...groupLayer, ...tabLayer],
    activeTabId: mode === TAB_BAR_MODE_SINGLE ? activeTabId : activeTabId
  };
}

// 添加串口后应当选中的分组：就是新加的那个。
//
// 单独抽出来是因为「添加后是否自动激活」是产品行为，不是渲染细节；
// 设计文档第 6.2 节明确要求新分组成为 active 并让侧栏跟着切。
function resolveGroupAfterAdd(previousGroups, nextGroupId) {
  const groups = normalizeGroups(previousGroups);
  if (typeof nextGroupId !== 'string' || !nextGroupId.trim()) {
    return resolveActiveGroupId(groups, null);
  }
  return nextGroupId.trim();
}

// 关闭分组后应当选中的分组。
//
// 关键点：**优先选被关闭分组的右邻，没有右邻再选左邻**。
// 若简单地「总是退回第一个分组」，连续关闭右侧分组时焦点会不断跳回最左，
// 用户刚看的那个分组下一次就被换走了。
function resolveGroupAfterClose(groups, closedGroupId, currentActiveGroupId) {
  const list = normalizeGroups(groups);
  const closedIndex = list.findIndex(group => group.id === closedGroupId);
  if (closedIndex === -1) {
    return resolveActiveGroupId(list, currentActiveGroupId);
  }
  const remaining = list.filter(group => group.id !== closedGroupId);
  if (remaining.length === 0) return null;
  // 只有关掉的正是当前活跃分组时才需要改选；否则保持原有选择。
  if (closedGroupId !== currentActiveGroupId) {
    return resolveActiveGroupId(remaining, currentActiveGroupId);
  }
  const nextIndex = Math.min(closedIndex, remaining.length - 1);
  return remaining[nextIndex].id;
}

// 判断从 fromGroups 到 toGroups 是否发生了「层数变化」，用于决定是否要做过渡。
function didLayerCountChange(fromGroups, toGroups) {
  const from = normalizeGroups(fromGroups);
  const to = normalizeGroups(toGroups);
  const wasMulti = from.length > 1;
  const isMulti = to.length > 1;
  return wasMulti !== isMulti;
}

module.exports = {
  TAB_BAR_MODE_SINGLE,
  TAB_BAR_MODE_DOUBLE,
  LAYER_GROUP,
  LAYER_TAB,
  normalizeGroups,
  resolveActiveGroupId,
  buildTabBarModel,
  resolveGroupAfterAdd,
  resolveGroupAfterClose,
  didLayerCountChange
};

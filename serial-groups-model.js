'use strict';

// P3「添加串口 / 关闭串口」的数据层：对 serialGroups 数组做增删改。
//
// 只处理数据，不碰文件系统、不碰 Electron、不碰 DOM，因此可以直接在 Node 断言。
// 真正的写盘由调用方拿返回值去 saveConfig —— 这样这一层可以单独测透，
// 而「写盘失败怎么办」仍由既有的配置写盘路径统一负责。

const MAX_GROUP_TITLE_LENGTH = 60;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneGroup(group) {
  return {
    ...group,
    serialOptions: isPlainObject(group.serialOptions) ? { ...group.serialOptions } : {},
    filterTabs: Array.isArray(group.filterTabs) ? group.filterTabs.slice() : [],
    chartTabs: Array.isArray(group.chartTabs) ? group.chartTabs.slice() : [],
    workspaceLayout: isPlainObject(group.workspaceLayout) ? { ...group.workspaceLayout } : null
  };
}

function normalizeGroupList(groups) {
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  const result = [];
  groups.forEach(group => {
    if (!isPlainObject(group)) return;
    const id = typeof group.id === 'string' ? group.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    result.push(cloneGroup(group));
  });
  return result;
}

// 生成下一个可用分组 id。
//
// 规则：`g-<n>`，n 从 1 开始取**当前未被占用的最小值**。
//
// 为什么不用「当前长度 + 1」：删掉中间某个分组后，长度会小于最大编号，
// 于是新 id 会和已存在的分组撞车。而为什么不加时间戳或随机数：这类 id 会被
// 写进配置文件、并参与日志目录归属，一旦带随机性，同一份配置两次加载就会
// 得到不同的 id，幂等性立刻失效（这与迁移层固定 'default' 是同一个理由）。
function nextGroupId(groups) {
  const list = normalizeGroupList(groups);
  const used = new Set(list.map(group => group.id));
  let index = 1;
  while (used.has(`g-${index}`)) index += 1;
  return `g-${index}`;
}

function clampTitle(title, fallback) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (!text) return fallback;
  return text.slice(0, MAX_GROUP_TITLE_LENGTH);
}

// 添加一个分组。
//
// 新分组的串口参数**继承自当前分组**（设计文档 6.2）。这不是随手决定的默认值：
// 用户点了「添加串口」通常是要再连一个同型号设备，继承波特率/数据位能省掉
// 每次重填；而 portPath 必须清空，否则新分组会显示上一个分组已占用的端口，
// 用户点连接会去抢一个已经在用的口。
//
// title 也清空并给占位名：继承来的标题会与新分组实际端口不符。
function addSerialGroup(groups, options = {}) {
  const source = isPlainObject(options) ? options : {};
  const list = normalizeGroupList(groups);
  const id = nextGroupId(list);

  const inherited = isPlainObject(source.inheritFrom)
    ? source.inheritFrom
    : (list.length > 0 ? list[list.length - 1] : {});
  const inheritedOptions = isPlainObject(inherited.serialOptions) ? inherited.serialOptions : {};
  const placeholderTitle = clampTitle(source.title, `Serial ${list.length + 1}`);

  const group = {
    id,
    title: placeholderTitle,
    // portPath 必须为空：继承来的端口已被原分组占用。
    portPath: '',
    status: 'disconnected',
    sessionId: null,
    serialOptions: {
      baudRate: inheritedOptions.baudRate,
      dataBits: inheritedOptions.dataBits,
      stopBits: inheritedOptions.stopBits,
      parity: inheritedOptions.parity,
      receiveDisplayMode: inheritedOptions.receiveDisplayMode,
      receiveEncoding: inheritedOptions.receiveEncoding,
      sendEncoding: inheritedOptions.sendEncoding,
      newlineMode: inheritedOptions.newlineMode
    },
    // 新分组从空白开始：过滤/图表/布局都属于具体端口的数据视图，
    // 继承过来会把上一个端口的数据视图复制给一个还没连接的端口。
    filterTabs: [],
    chartTabs: [],
    workspaceLayout: null
  };

  return {
    groups: [...list, group],
    group,
    groupId: id
  };
}

// 删除一个分组。
//
// 返回被删除的分组本身，调用方需要用它去断开串口、销毁子标签、关闭日志会话。
// 若 id 不存在，groups 原样返回（不是抛错）：标签栏的关闭按钮可能被连点，
// 第二次点击时分组已经不在了，此时抛错会让整个 UI 抛未捕获异常。
function removeSerialGroup(groups, groupId) {
  const list = normalizeGroupList(groups);
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  const index = list.findIndex(group => group.id === id);
  if (index === -1) {
    return { groups: list, removed: null, index: -1 };
  }
  const removed = list[index];
  const nextGroups = list.slice(0, index).concat(list.slice(index + 1));
  return { groups: nextGroups, removed, index };
}

// 重命名分组。
//
// 空标题回落到原标题而不是变成空串：空标题的分组标签是一块无法识别的空白，
// 用户既找不到它也不知道该删哪个。
function renameSerialGroup(groups, groupId, title) {
  const list = normalizeGroupList(groups);
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  const index = list.findIndex(group => group.id === id);
  if (index === -1) {
    return { groups: list, group: null, changed: false };
  }
  const previousTitle = list[index].title;
  const nextTitle = clampTitle(title, previousTitle);
  if (nextTitle === previousTitle) {
    return { groups: list, group: list[index], changed: false };
  }
  const nextGroups = list.slice();
  nextGroups[index] = { ...list[index], title: nextTitle };
  return { groups: nextGroups, group: nextGroups[index], changed: true };
}

function findSerialGroup(groups, groupId) {
  const list = normalizeGroupList(groups);
  const id = typeof groupId === 'string' ? groupId.trim() : '';
  return list.find(group => group.id === id) || null;
}

module.exports = {
  MAX_GROUP_TITLE_LENGTH,
  nextGroupId,
  addSerialGroup,
  removeSerialGroup,
  renameSerialGroup,
  findSerialGroup
};

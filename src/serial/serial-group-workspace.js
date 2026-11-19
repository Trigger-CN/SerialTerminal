'use strict';

// 串口分组的「工作区形状」：一个分组在 DOM 里需要哪些节点。
//
// 为什么要有这一层：`serial-group-dom.js` 回答「某个分组的 id 叫什么」，
// 但真正要建节点时还需要知道「这个分组的标签挂在哪个 pane 里」。这两件事分开，
// 是因为 pane 归属由布局决定（P5），而 id 由命名契约决定（P2）——把两者混在
// 一起会让改名和改布局互相牵连。
//
// 本模块只产出描述，不碰 DOM，因此可以在 Node 里直接断言。

const {
  mainTabId,
  mainTabButtonId,
  serialContainerId
} = require('./serial-group-dom');

// 让 groupId 可以安全地放进 CSS 选择器。
//
// serial-group-dom 已经把非法字符替换成 `_`，但选择器还有额外约束：
// id 以数字开头在 HTML 里合法，在 `querySelector('#1a')` 里却是语法错误。
// 所以这里统一走属性选择器 `[id="..."]`，不依赖 `#` 写法。
function attributeSelector(attribute, value) {
  return `[${attribute}="${String(value).replace(/"/g, '\\"')}"]`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// 一个分组在工作区里的完整节点描述。
//
// paneId 默认落在主 pane：多分组的分屏（每个分组一个 pane）属于 P5 的后续工作，
// 在那之前所有分组的主标签都挂在同一个 pane 里，靠标签栏切换。
function describeGroupWorkspaceEntry(groupId, options = {}) {
  const source = isPlainObject(options) ? options : {};
  const tabId = mainTabId(groupId);
  const containerId = serialContainerId(groupId);

  return {
    groupId,
    title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : 'Serial',
    connected: source.connected === true,
    isActive: source.isActive === true,
    paneId: typeof source.paneId === 'string' && source.paneId ? source.paneId : 'pane-1',
    // 主标签页（承载 xterm 的那个 main-tab-pane）
    mainTabId: tabId,
    mainTabButtonId: mainTabButtonId(groupId),
    mainTabPaneSelector: attributeSelector('id', tabId),
    // xterm 容器
    containerId,
    containerSelector: attributeSelector('id', containerId),
    buttonSelector: attributeSelector('id', mainTabButtonId(groupId))
  };
}

// 按分组列表算出整个工作区。
//
// activeGroupId 不存在时退回第一个分组——与 serial-group-tabs.js 的规则保持一致。
// 两处若采用不同策略，标签栏会认为 A 组是激活的，而工作区却把 B 组当激活的，
// 表现为「点了分组标签，终端内容没换」。
function describeGroupWorkspace(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const groups = Array.isArray(source.groups) ? source.groups.filter(isPlainObject) : [];
  const defaultPaneId = typeof source.defaultPaneId === 'string' && source.defaultPaneId
    ? source.defaultPaneId
    : 'pane-1';

  const seen = new Set();
  const normalized = [];
  groups.forEach(group => {
    const id = typeof group.id === 'string' ? group.id.trim() : '';
    if (!id || seen.has(id)) return;
    seen.add(id);
    normalized.push(group);
  });

  if (normalized.length === 0) {
    return {
      mode: 'empty',
      isMultiGroup: false,
      activeGroupId: null,
      entries: [],
      active: null
    };
  }

  let activeGroupId = typeof source.activeGroupId === 'string' ? source.activeGroupId : '';
  if (!normalized.some(group => group.id === activeGroupId)) {
    activeGroupId = normalized[0].id;
  }

  // pane 归属允许按分组覆写（P5 的分组级分屏会用到），缺省落主 pane。
  const paneIds = isPlainObject(source.paneIds) ? source.paneIds : {};

  const entries = normalized.map(group => describeGroupWorkspaceEntry(group.id, {
    title: group.title,
    connected: group.connected === true || group.status === 'connected',
    isActive: group.id === activeGroupId,
    paneId: typeof paneIds[group.id] === 'string' && paneIds[group.id] ? paneIds[group.id] : defaultPaneId
  }));

  return {
    mode: normalized.length > 1 ? 'multi' : 'single',
    isMultiGroup: normalized.length > 1,
    activeGroupId,
    entries,
    active: entries.find(entry => entry.groupId === activeGroupId) || entries[0]
  };
}

// 找出「工作区里已有、但 DOM 里还没有节点」的分组。
//
// 与 pane-layout-dom.js 的 findMissingPaneIds 同一个作用：调用方拿到结果后
// 必须先补节点再操作，否则 appendChild(null) 会静默把终端挂丢——不报错、不警告，
// 只表现为一块空白面板。
function findMissingGroupContainers(entries, hasElement) {
  const list = Array.isArray(entries) ? entries.filter(isPlainObject) : [];
  if (typeof hasElement !== 'function') return list.slice();
  return list.filter(entry => !hasElement(entry.containerId));
}

module.exports = {
  attributeSelector,
  describeGroupWorkspaceEntry,
  describeGroupWorkspace,
  findMissingGroupContainers
};

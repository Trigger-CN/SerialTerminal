'use strict';

// pane 容器的结构描述（P3 基础）。
//
// 原来 index.html 里 pane-1 / pane-2 是两段手写的静态标签，pane 数量由分组数量
// 驱动之后必须能按需创建。这里只产出**纯数据描述**，不碰 DOM，因此可以直接在
// Node 里断言；真正的元素创建由 renderer.js 按这份描述完成。
//
// 关键约束：用这份描述创建出来的 pane-1，其内部结构与改造前的静态标签逐项一致
// （相同的 id 命名规则、相同的类名、相同的按钮顺序），否则依赖
// `#pane-1-tabs-list` / `#pane-1-new-chart-tab-btn` 之类选择器的既有代码会全部失效。

// 分组的 DOM 标识（tab-main / serial-container）由 serial-group-dom.js 统一生成。
// 这里不再重复字面量：两处各写一份 'serial-container' 正是「一个分组一个容器」
// 迟迟无法成立的原因——两份定义可以独立漂移，而漂移后的失败方式是终端区空白。
const { mainTabId, serialContainerId } = require('../serial/serial-group-dom');

const PANE_TAB_BUTTONS = Object.freeze([
  { kind: 'shell', icon: 'terminal', titleKey: 'main.newShellTab' },
  { kind: 'filter', icon: 'filter_alt', titleKey: 'main.newFilterTab' },
  { kind: 'chart', icon: 'show_chart', titleKey: 'main.newChartTab' }
]);

// 默认分组的主标签 id；其它分组由 serial-group-dom.js 派生出带后缀的 id。
const MAIN_TAB_ID = mainTabId();

function paneTabsListId(paneId) {
  return `${paneId}-tabs-list`;
}

function paneTabsContentId(paneId) {
  return `${paneId}-tabs-content`;
}

function paneTabButtonId(paneId, kind) {
  return `${paneId}-new-${kind}-tab-btn`;
}

// 描述一个 pane 的完整结构。hostsMainTab 为真时该 pane 额外携带主终端标签页与
// 它的 xterm 容器；其余 pane 的标签页内容容器初始为空。
function describePane(paneId, { hostsMainTab = false, hidden = false } = {}) {
  const buttons = PANE_TAB_BUTTONS.map(button => ({
    kind: button.kind,
    id: paneTabButtonId(paneId, button.kind),
    icon: button.icon,
    titleKey: button.titleKey
  }));

  return {
    paneId,
    elementId: paneId,
    hidden,
    className: 'workspace-pane',
    tabsListId: paneTabsListId(paneId),
    tabsContentId: paneTabsContentId(paneId),
    buttons,
    tabs: hostsMainTab
      ? [{
        id: MAIN_TAB_ID,
        buttonId: `${MAIN_TAB_ID}-button`,
        buttonLabelKey: 'main.mainTerminal',
        buttonLabelFallback: 'Main Terminal',
        terminalContainerId: serialContainerId(),
        isMain: true
      }]
      : []
  };
}

// 按 pane 列表描述整个工作区。首个 pane 承载主终端，其余 pane 默认隐藏
// （分屏开启时再由布局层统一控制可见性）。
function describeWorkspace(paneIds) {
  const ids = Array.isArray(paneIds) ? paneIds.filter(id => typeof id === 'string' && id) : [];
  return ids.map((paneId, index) => describePane(paneId, {
    hostsMainTab: index === 0,
    hidden: index > 0
  }));
}

// 找出布局里存在、但 DOM 里还没有对应节点的 pane。
// 这是「布局层已支持 N pane、DOM 层只有静态两个」的缺口：调用方拿到结果后需要
// 先补齐节点，再让布局去操作它们，否则 appendChild(null) 会静默丢内容。
function findMissingPaneIds(paneIds, hasPaneElement) {
  const ids = Array.isArray(paneIds) ? paneIds.filter(id => typeof id === 'string' && id) : [];
  if (typeof hasPaneElement !== 'function') return ids.slice();
  return ids.filter(paneId => !hasPaneElement(paneId));
}

module.exports = {
  MAIN_TAB_ID,
  PANE_TAB_BUTTONS,
  paneTabsListId,
  paneTabsContentId,
  paneTabButtonId,
  describePane,
  describeWorkspace,
  findMissingPaneIds
};

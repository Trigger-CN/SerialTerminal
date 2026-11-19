'use strict';

// 串口分组的 DOM 标识契约（P2 剩余部分的基础设施）。
//
// 为什么需要单独一层：多串口改造卡住的不是「终端能不能建」，而是「终端该建在哪个
// 容器里」。改造前 `renderer.js` 直接写 `document.getElementById('serial-container')`，
// 而 `index.html` 里那个 id 只有一份，所以第二个分组无论如何都无处可显示。
//
// 把 id 的生成规则收在这里，是为了让「一个分组一个容器」这句话变成可断言的事实：
// 给定 groupId 就能算出唯一容器 id，且默认分组的三个 id 必须与改造前**逐字一致**。
// 一旦有人改了命名规则，依赖旧 id 的静态标记与既有选择器会立刻失效——那种错误
// 在浏览器里只表现为「终端区一片空白」，没有报错，极难定位。
//
// 关键约束：默认分组不携带后缀。
// 改造前的主标签叫 `tab-main`、容器叫 `serial-container`。如果给默认分组加上
// `-default` 后缀，`index.html` 里的静态标记、`pane-layout-dom.js` 的描述、
// 以及 `test/markup.test.js` 里那些依赖 `#serial-container` 的断言会同时失效。
// 所以后缀只对「非默认分组」生效，默认分组保持原样。

const { normalizeGroupId, DEFAULT_SERIAL_GROUP_ID } = require('./serial-group-registry');

// 非默认分组在 id 里使用的后缀。
//
// groupId 只允许 [A-Za-z0-9_-]，因为它会直接拼进 HTML id。分组 id 由
// serial-groups-model.js 的 nextGroupId() 生成为 `g-<n>`，天然满足；
// 但配置是用户可编辑的文本文件，所以这里必须把非法字符换掉而不是拼一个
// 含空格或冒号的 id —— 那种 id 在 querySelector 里会抛 SyntaxError。
function groupDomSuffix(groupId) {
  const id = normalizeGroupId(groupId);
  if (id === DEFAULT_SERIAL_GROUP_ID) return '';
  const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
  return `-${safe}`;
}

// 分组的主终端标签页 id。默认分组 → 'tab-main'（与改造前一致）。
function mainTabId(groupId) {
  return `tab-main${groupDomSuffix(groupId)}`;
}

// 分组主标签的按钮 id。默认分组 → 'tab-main-button'（与改造前一致）。
function mainTabButtonId(groupId) {
  return `${mainTabId(groupId)}-button`;
}

// 分组主终端的 xterm 容器 id。默认分组 → 'serial-container'（与改造前一致）。
//
// 注意后缀位置：是 `serial-container-<group>`，不是 `serial-<group>-container`。
// 这样默认分组的结果正好是原有的 `serial-container`，而其它分组的结果以同一个
// 前缀开头，`document.querySelectorAll('[id^="serial-container"]')` 这类按前缀
// 的批量查找（例如统一 fit 全部终端）才可能生效。
function serialContainerId(groupId) {
  return `serial-container${groupDomSuffix(groupId)}`;
}

module.exports = {
  groupDomSuffix,
  mainTabId,
  mainTabButtonId,
  serialContainerId
};

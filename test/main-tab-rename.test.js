'use strict';

// 单串口模式下，分组标签栏不渲染，用户唯一能双击的是 pane 里的主终端标签。
// 主终端标签有两份来源（index.html 静态 + ensureSerialGroupMainTabDom 动态），
// 逐处绑定必然漏掉一份，因此双击重命名必须走 document 级事件委托。
//
// 回归背景：单串口模式下双击主终端标签毫无反应——只有分组标签
// （.serial-group-tab，多串口模式才渲染）绑过 dblclick。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const dom = require('../src/serial/serial-group-dom');

test('主终端标签的双击重命名走 document 级委托', () => {
  // 委托监听必须存在：一处绑定覆盖静态与动态两种主标签。
  assert.match(renderer, /document\.addEventListener\('dblclick',\s*event\s*=>\s*\{/);

  // 委托内必须限定串口主标签前缀，否则会给已有双击绑定的 Shell / 过滤 / 图表
  // 标签再叠一次，弹出两个重命名弹窗。
  assert.match(renderer, /tabId\.startsWith\('tab-main'\)/);

  // 委托内必须真正打开重命名弹窗，并带上分组 id。
  const dblclickBlock = renderer.slice(
    renderer.indexOf("document.addEventListener('dblclick'"),
    renderer.indexOf('bindWorkspaceTabDragging();')
  );
  assert.match(dblclickBlock, /openRenameTabDialog\(\{/);
  assert.match(dblclickBlock, /groupId,/);
});

test('静态主终端标签带 data-target，守护委托的匹配条件', () => {
  // 委托靠 .main-tab + data-target 定位标签；静态标签缺 data-target 会静默失效。
  const mainTabButton = html.match(/<button[^>]*class="main-tab[^"]*"[^>]*data-target="([^"]+)"/);
  assert.ok(mainTabButton, 'index.html 的主终端标签必须有 data-target');
  assert.equal(mainTabButton[1], dom.mainTabId('default'));
  assert.ok(mainTabButton[1].startsWith('tab-main'));
});

test('主标签 id 前缀与其它标签类型不重叠', () => {
  // 委托用 startsWith('tab-main') 判定，前缀一旦撞车会误伤其它标签。
  const mainIds = [dom.mainTabId('default'), dom.mainTabId('g-1'), dom.mainTabId('g-2')];
  mainIds.forEach(id => assert.ok(id.startsWith('tab-main'), `${id} 应以 tab-main 开头`));

  ['tab-shell-1', 'tab-filter-1', 'tab-chart-1', 'tab-shell-12'].forEach(id => {
    assert.ok(!id.startsWith('tab-main'), `${id} 不应命中主标签前缀`);
  });
});

test('关闭按钮的双击不触发重命名', () => {
  // 双击关闭按钮应当忽略，否则会同时关标签又弹重命名。
  const dblclickBlock = renderer.slice(
    renderer.indexOf("document.addEventListener('dblclick'"),
    renderer.indexOf('bindWorkspaceTabDragging();')
  );
  assert.match(dblclickBlock, /closest\('\.main-tab-close'\)/);
});

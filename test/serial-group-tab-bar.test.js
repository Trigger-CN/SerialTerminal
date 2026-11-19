'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GROUP_TAB_BAR_ID,
  GROUP_TAB_LIST_ID,
  ADD_GROUP_BUTTON_ID,
  groupTabId,
  groupTabButtonId,
  groupCloseButtonId,
  describeGroupTab,
  describeGroupTabBar,
  describeAddGroupButton,
  describeGroupVisibility
} = require('../src/serial/serial-group-tab-bar');
const { mainTabId, mainTabButtonId, serialContainerId } = require('../src/serial/serial-group-dom');

test('group tab ids never collide with the main terminal tab ids', () => {
  // 这是本模块最容易被写错的地方：分组标签与「该分组内的主终端标签」
  // 是两件不同的东西，若算出同一个 id，点击分组标签会同时命中主终端标签，
  // 行为无法预期（可能只切了 pane 而没有切分组）。
  ['default', 'g-1', 'g-2'].forEach(groupId => {
    assert.notEqual(groupTabId(groupId), mainTabId(groupId));
    assert.notEqual(groupTabButtonId(groupId), mainTabButtonId(groupId));
  });
});

test('every group produces a distinct group tab id', () => {
  const groups = ['default', 'g-1', 'g-2', 'g-10'];
  assert.equal(new Set(groups.map(groupTabId)).size, groups.length);
  assert.equal(new Set(groups.map(groupTabButtonId)).size, groups.length);
  assert.equal(new Set(groups.map(groupCloseButtonId)).size, groups.length);
});

test('the default group tab id is stable and human readable', () => {
  // 默认分组也带 id 后缀（它是「分组」标签，不是主终端标签），
  // 但必须与 groupId 一一对应且可预测。
  assert.equal(groupTabId('default'), 'tab-group-default');
  assert.equal(groupTabButtonId('default'), 'tab-group-default-button');
  assert.equal(groupCloseButtonId('default'), 'tab-group-default-close');
});

test('dirty group ids are sanitized into selector-safe ids', () => {
  // groupId 来自用户可编辑的配置；含空格或冒号直接拼进 querySelector 会抛
  // SyntaxError，而不是找不到元素。
  const dirty = 'a b:c"d#e';
  [groupTabId(dirty), groupTabButtonId(dirty), groupCloseButtonId(dirty)].forEach(id => {
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.doesNotThrow(() => new RegExp(`id="${id}"`));
  });
});

test('empty or missing group ids fall back to the default suffix', () => {
  // 空串若被拼成 'tab-group-'，它既不是默认分组、也不对应任何分组，
  // 结果是标签挂在一个永远匹配不到的选择器上。
  ['', '   ', null, undefined].forEach(value => {
    assert.equal(groupTabId(value), 'tab-group-default');
  });
});

test('the default group cannot be closed but still renders a close button', () => {
  // 默认分组关掉之后没有任何路径能恢复，用户会看到空白终端区。
  // 但按钮仍要渲染（只是 disabled）：若用「有的没有按钮」表达，
  // 标签宽度会跳变，点击位置也会漂移。
  const tab = describeGroupTab({ id: 'default', title: 'COM6' }, { isDefault: true });
  assert.equal(tab.closable, false);
  assert.ok(tab.closeButtonId);
  assert.equal(tab.title, 'COM6');
});

test('a non-default group is closable and carries its groupId in dataset', () => {
  // dataset 而不是闭包：标签会被重建，闭包会跟着丢，事件委托读不到。
  const tab = describeGroupTab({ id: 'g-1', title: 'COM7' }, { isDefault: false });
  assert.equal(tab.closable, true);
  assert.deepEqual(tab.dataset, { groupId: 'g-1' });
  assert.equal(tab.buttonId, 'tab-group-g-1-button');
});

test('active and connected states become stable class names', () => {
  const active = describeGroupTab({ id: 'g-1', title: 'A', active: true, connected: true });
  assert.match(active.className, /(^|\s)active(\s|$)/);
  assert.match(active.className, /(^|\s)connected(\s|$)/);

  const idle = describeGroupTab({ id: 'g-2', title: 'B' });
  assert.doesNotMatch(idle.className, /(^|\s)active(\s|$)/);
  assert.doesNotMatch(idle.className, /(^|\s)connected(\s|$)/);
});

test('an empty title still produces a readable label', () => {
  // 空标题的分组标签是一块无法识别的空白，用户既找不到它也不知道该删哪个。
  assert.equal(describeGroupTab({ id: 'g-1', title: '   ' }).title, 'Serial');
  assert.equal(describeGroupTab({ id: 'g-1' }).title, 'Serial');
});

test('a single group hides the whole group bar', () => {
  // 只有一个分组时再显示分组标签是纯噪声，而且会让用户以为可以点它切到别处。
  const bar = describeGroupTabBar({
    groups: [{ id: 'default', title: 'COM6' }],
    isMultiGroup: false
  });
  assert.equal(bar.hidden, true);
  assert.deepEqual(bar.tabs, []);
  // 但「添加串口」按钮必须还在，否则用户永远开启不了多分组。
  assert.equal(bar.canAdd, true);
});

test('two or more groups show the group bar with one tab each', () => {
  const bar = describeGroupTabBar({
    groups: [
      { id: 'default', title: 'COM6', active: true, connected: true },
      { id: 'g-1', title: 'COM7' }
    ],
    isMultiGroup: true,
    defaultGroupId: 'default'
  });
  assert.equal(bar.hidden, false);
  assert.equal(bar.tabs.length, 2);
  assert.equal(bar.tabs[0].closable, false);
  assert.equal(bar.tabs[1].closable, true);
  assert.equal(bar.barId, GROUP_TAB_BAR_ID);
  assert.equal(bar.listId, GROUP_TAB_LIST_ID);
});

test('isMultiGroup alone is not enough to show the bar', () => {
  // 防御性：调用方若把 isMultiGroup 传成 true 但只给了一个分组，
  // 显示一条只有一个标签的分组栏同样是噪声。
  const bar = describeGroupTabBar({
    groups: [{ id: 'default', title: 'COM6' }],
    isMultiGroup: true
  });
  assert.equal(bar.hidden, true);
  assert.deepEqual(bar.tabs, []);
});

test('the add button is always present and disables instead of hiding', () => {
  const enabled = describeAddGroupButton();
  assert.equal(enabled.id, ADD_GROUP_BUTTON_ID);
  assert.equal(enabled.disabled, false);

  const disabled = describeAddGroupButton({ disabled: true });
  assert.equal(disabled.disabled, true);
  // 隐藏会让布局跳动，也让用户不知道为什么加不了。
  assert.equal(disabled.id, ADD_GROUP_BUTTON_ID);
});

test('group visibility hides every non-active group and resolves its real container', () => {
  const groups = [{ id: 'default' }, { id: 'g-1' }, { id: 'g-2' }];
  const visibility = describeGroupVisibility(groups, 'g-1');

  assert.deepEqual(visibility.map(item => item.visible), [false, true, false]);
  assert.deepEqual(visibility.map(item => item.hidden), [true, false, true]);
  // 容器 id 必须与 serialContainerId 完全一致：两份规则漂移后，
  // 切分组时 show 的就是一个不存在的容器。
  visibility.forEach(item => {
    assert.equal(item.containerId, serialContainerId(item.groupId));
  });
  assert.equal(visibility[0].containerId, 'serial-container');
  assert.equal(visibility[1].containerId, 'serial-container-g-1');
});

test('an unknown active group id hides everything instead of guessing', () => {
  // 与 serial-group-tabs.js 的「退回第一个分组」不同：这里是可见性计算，
  // 猜一个分组显示出来会让用户看到不属于自己的终端内容。
  const visibility = describeGroupVisibility([{ id: 'default' }, { id: 'g-1' }], 'g-9');
  assert.deepEqual(visibility.map(item => item.visible), [false, false]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  TAB_BAR_MODE_SINGLE,
  TAB_BAR_MODE_DOUBLE,
  normalizeGroups,
  resolveActiveGroupId,
  buildTabBarModel,
  resolveGroupAfterAdd,
  resolveGroupAfterClose,
  didLayerCountChange
} = require('../src/serial/serial-group-tabs');

// 常用夹具：两个分组，每组一个主标签 + 一个过滤标签。
function twoGroups() {
  return [
    { id: 'default', title: 'COM6', connected: true },
    { id: 'g-2', title: 'COM7', connected: false }
  ];
}

function groupTabsFixture() {
  return {
    default: {
      activeTabId: 'tab-filter-1',
      tabs: [
        { id: 'tab-main', title: 'Main Terminal', kind: 'main', closable: false },
        { id: 'tab-filter-1', title: 'Filter 1', kind: 'filter' }
      ]
    },
    'g-2': {
      activeTabId: 'tab-main',
      tabs: [
        { id: 'tab-main', title: 'Main Terminal', kind: 'main', closable: false }
      ]
    }
  };
}

test('单分组时塌回一层，不渲染分组标签本身', () => {
  const model = buildTabBarModel({
    groups: [{ id: 'default', title: 'COM6' }],
    shellTabs: [{ id: 'tab-shell-1', title: 'Shell' }],
    groupTabs: { default: { activeTabId: 'tab-main', tabs: [{ id: 'tab-main', title: 'Main Terminal' }] } }
  });
  assert.equal(model.mode, TAB_BAR_MODE_SINGLE);
  assert.equal(model.isMultiGroup, false);
  // 单层里不出现 kind=group 的条目。
  assert.equal(model.singleLayer.some(tab => tab.kind === 'group'), false);
  assert.deepEqual(model.singleLayer.map(tab => tab.id), ['tab-main', 'tab-shell-1']);
});

test('两个分组时升为两层，Shell 只出现在分组层', () => {
  const model = buildTabBarModel({
    groups: twoGroups(),
    shellTabs: [{ id: 'tab-shell-1', title: 'Shell' }],
    groupTabs: groupTabsFixture(),
    activeGroupId: 'default'
  });
  assert.equal(model.mode, TAB_BAR_MODE_DOUBLE);
  assert.equal(model.isMultiGroup, true);
  assert.equal(model.singleLayer, null);
  // 分组层 = 2 个分组 + 1 个 Shell。
  assert.deepEqual(model.groupLayer.map(item => item.id), ['default', 'g-2', 'tab-shell-1']);
  // 下层只有当前分组自己的两个标签。
  assert.deepEqual(model.tabLayer.map(tab => tab.id), ['tab-main', 'tab-filter-1']);
  // Shell 绝不能出现在下层。
  assert.equal(model.tabLayer.some(tab => tab.id === 'tab-shell-1'), false);
});

test('切换分组只改变下层标签集合，不改分组层', () => {
  const base = {
    groups: twoGroups(),
    shellTabs: [{ id: 'tab-shell-1', title: 'Shell' }],
    groupTabs: groupTabsFixture()
  };
  const first = buildTabBarModel({ ...base, activeGroupId: 'default' });
  const second = buildTabBarModel({ ...base, activeGroupId: 'g-2' });
  assert.deepEqual(
    first.groupLayer.map(item => item.id),
    second.groupLayer.map(item => item.id)
  );
  assert.deepEqual(first.tabLayer.map(tab => tab.id), ['tab-main', 'tab-filter-1']);
  assert.deepEqual(second.tabLayer.map(tab => tab.id), ['tab-main']);
});

test('activeGroupId 不存在时退回第一个分组，而不是让下层空掉', () => {
  const model = buildTabBarModel({
    groups: twoGroups(),
    groupTabs: groupTabsFixture(),
    activeGroupId: 'does-not-exist'
  });
  assert.equal(model.activeGroupId, 'default');
  assert.deepEqual(model.tabLayer.map(tab => tab.id), ['tab-main', 'tab-filter-1']);
});

test('activeTabId 不在当前分组标签里时退回第一个标签', () => {
  const model = buildTabBarModel({
    groups: twoGroups(),
    groupTabs: {
      default: { activeTabId: 'tab-vanished', tabs: [{ id: 'tab-main' }, { id: 'tab-filter-1' }] },
      'g-2': { activeTabId: 'tab-main', tabs: [{ id: 'tab-main' }] }
    },
    activeGroupId: 'default'
  });
  assert.equal(model.activeTabId, 'tab-main');
  assert.equal(model.tabLayer[0].active, true);
});

test('分组列表中的重复 id 被去掉，非法项被丢弃', () => {
  const groups = normalizeGroups([
    { id: 'default', title: 'A' },
    { id: 'default', title: 'A duplicate' },
    { id: 'g-2', title: 'B' },
    null,
    { title: 'no id' }
  ]);
  assert.deepEqual(groups.map(group => group.id), ['default', 'g-2']);
});

test('分组无标题时给可读占位名，而不是空字符串', () => {
  const groups = normalizeGroups([{ id: 'g-1' }]);
  assert.equal(groups[0].title, 'Serial 1');
});

test('添加分组后新分组成为 active', () => {
  assert.equal(resolveGroupAfterAdd(twoGroups(), 'g-3'), 'g-3');
  // 没有合法新 id 时退回原第一个分组，不返回 undefined。
  assert.equal(resolveGroupAfterAdd(twoGroups(), ''), 'default');
});

test('关闭当前分组后优先选中右邻', () => {
  const groups = [
    { id: 'g-1', title: 'A' },
    { id: 'g-2', title: 'B' },
    { id: 'g-3', title: 'C' }
  ];
  assert.equal(resolveGroupAfterClose(groups, 'g-2', 'g-2'), 'g-3');
});

test('关闭最右分组后选中左邻', () => {
  const groups = [
    { id: 'g-1', title: 'A' },
    { id: 'g-2', title: 'B' },
    { id: 'g-3', title: 'C' }
  ];
  assert.equal(resolveGroupAfterClose(groups, 'g-3', 'g-3'), 'g-2');
});

test('关闭非当前分组时保持当前选择不变', () => {
  const groups = [
    { id: 'g-1', title: 'A' },
    { id: 'g-2', title: 'B' },
    { id: 'g-3', title: 'C' }
  ];
  assert.equal(resolveGroupAfterClose(groups, 'g-1', 'g-3'), 'g-3');
});

test('关闭最后一个分组返回 null，由调用方决定是否兜底', () => {
  assert.equal(resolveGroupAfterClose([{ id: 'g-1', title: 'A' }], 'g-1', 'g-1'), null);
});

test('层数变化判定只在 1 与 2+ 之间跨过时成立', () => {
  const one = [{ id: 'g-1' }];
  const two = [{ id: 'g-1' }, { id: 'g-2' }];
  const three = [{ id: 'g-1' }, { id: 'g-2' }, { id: 'g-3' }];
  assert.equal(didLayerCountChange(one, two), true);
  assert.equal(didLayerCountChange(two, one), true);
  assert.equal(didLayerCountChange(two, three), false);
  assert.equal(didLayerCountChange(one, one), false);
});

test('单分组模式下 Shell 与串口标签在同一层且串口标签在前', () => {
  const model = buildTabBarModel({
    groups: [{ id: 'default', title: 'COM6' }],
    shellTabs: [{ id: 'tab-shell-1' }, { id: 'tab-shell-2' }],
    groupTabs: { default: { activeTabId: 'tab-main', tabs: [{ id: 'tab-main' }, { id: 'tab-filter-1' }] } }
  });
  assert.deepEqual(
    model.singleLayer.map(tab => tab.id),
    ['tab-main', 'tab-filter-1', 'tab-shell-1', 'tab-shell-2']
  );
});

test('空分组列表不崩溃且模式下不产生幽灵标签', () => {
  const model = buildTabBarModel({ groups: [], shellTabs: [], groupTabs: {} });
  assert.equal(model.activeGroupId, null);
  assert.deepEqual(model.groupLayer, []);
  assert.deepEqual(model.tabLayer, []);
});

test('输入不被修改', () => {
  const groups = twoGroups();
  const groupTabs = groupTabsFixture();
  const snapshotGroups = JSON.stringify(groups);
  const snapshotTabs = JSON.stringify(groupTabs);
  buildTabBarModel({ groups, shellTabs: [], groupTabs, activeGroupId: 'default' });
  assert.equal(JSON.stringify(groups), snapshotGroups);
  assert.equal(JSON.stringify(groupTabs), snapshotTabs);
});

test('resolveActiveGroupId 在空列表上返回 null', () => {
  assert.equal(resolveActiveGroupId([], 'default'), null);
  assert.equal(resolveActiveGroupId(null, 'default'), null);
});

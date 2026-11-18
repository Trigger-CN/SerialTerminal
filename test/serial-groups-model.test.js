'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  MAX_GROUP_TITLE_LENGTH,
  nextGroupId,
  addSerialGroup,
  removeSerialGroup,
  renameSerialGroup,
  resolveGroupDisplayTitle,
  findSerialGroup
} = require('../serial-groups-model');

function baseGroups() {
  return [
    {
      id: 'default',
      title: 'COM6',
      portPath: 'COM6',
      status: 'connected',
      serialOptions: {
        baudRate: '921600',
        dataBits: '8',
        stopBits: '1',
        parity: 'none',
        receiveDisplayMode: 'text',
        receiveEncoding: 'utf8',
        sendEncoding: 'utf8',
        newlineMode: 'crlf'
      },
      filterTabs: [{ id: 'tab-filter-1' }],
      chartTabs: [{ id: 'tab-chart-1' }],
      workspaceLayout: { splitEnabled: true }
    }
  ];
}

test('nextGroupId 从 g-1 开始，跳过已占用的编号', () => {
  assert.equal(nextGroupId([]), 'g-1');
  assert.equal(nextGroupId([{ id: 'g-1' }]), 'g-2');
  assert.equal(nextGroupId([{ id: 'g-1' }, { id: 'g-2' }]), 'g-3');
});

test('nextGroupId 在删除中间分组后不会与已有 id 撞车', () => {
  // 只有 g-1 与 g-3 时，长度是 2，若用「长度 + 1」会得到 g-3 —— 撞车。
  const groups = [{ id: 'g-1' }, { id: 'g-3' }];
  assert.equal(nextGroupId(groups), 'g-2');
});

test('addSerialGroup 继承当前分组的串口参数，但清空端口', () => {
  const result = addSerialGroup(baseGroups(), { inheritFrom: baseGroups()[0] });
  const group = result.group;
  assert.equal(group.serialOptions.baudRate, '921600');
  assert.equal(group.serialOptions.dataBits, '8');
  assert.equal(group.serialOptions.parity, 'none');
  // 关键：端口必须清空，否则新分组会显示已被占用的端口。
  assert.equal(group.portPath, '');
  assert.equal(group.status, 'disconnected');
  assert.equal(group.sessionId, null);
});

test('addSerialGroup 不继承过滤/图表/布局', () => {
  const result = addSerialGroup(baseGroups(), { inheritFrom: baseGroups()[0] });
  assert.deepEqual(result.group.filterTabs, []);
  assert.deepEqual(result.group.chartTabs, []);
  assert.equal(result.group.workspaceLayout, null);
});

test('addSerialGroup 标题不继承，给 Serial N 占位', () => {
  const result = addSerialGroup(baseGroups(), { inheritFrom: baseGroups()[0] });
  assert.equal(result.group.title, 'Serial 2');
});

test('addSerialGroup 在空列表上也能工作', () => {
  const result = addSerialGroup([], {});
  assert.equal(result.groupId, 'g-1');
  assert.equal(result.groups.length, 1);
});

test('addSerialGroup 不修改输入数组', () => {
  const groups = baseGroups();
  const snapshot = JSON.stringify(groups);
  addSerialGroup(groups, {});
  assert.equal(JSON.stringify(groups), snapshot);
});

test('removeSerialGroup 返回被删除的分组与索引，供调用方断连与销毁', () => {
  const groups = [
    { id: 'default', title: 'A' },
    { id: 'g-1', title: 'B' },
    { id: 'g-2', title: 'C' }
  ];
  const result = removeSerialGroup(groups, 'g-1');
  assert.equal(result.removed.id, 'g-1');
  assert.equal(result.index, 1);
  assert.deepEqual(result.groups.map(group => group.id), ['default', 'g-2']);
});

test('removeSerialGroup 对不存在的 id 返回原列表且不抛错', () => {
  const groups = baseGroups();
  const result = removeSerialGroup(groups, 'missing');
  assert.equal(result.removed, null);
  assert.equal(result.index, -1);
  assert.deepEqual(result.groups.map(group => group.id), ['default']);
});

test('removeSerialGroup 允许删到空列表', () => {
  const result = removeSerialGroup([{ id: 'default' }], 'default');
  assert.deepEqual(result.groups, []);
  assert.equal(result.removed.id, 'default');
});

test('renameSerialGroup 正常改名', () => {
  const result = renameSerialGroup(baseGroups(), 'default', 'Motor');
  assert.equal(result.changed, true);
  assert.equal(result.groups[0].title, 'Motor');
});

test('renameSerialGroup 空标题回落到原标题而不是变空串', () => {
  const result = renameSerialGroup(baseGroups(), 'default', '   ');
  assert.equal(result.changed, false);
  assert.equal(result.groups[0].title, 'COM6');
});

test('renameSerialGroup 超长标题被截断到上限', () => {
  const longTitle = 'x'.repeat(MAX_GROUP_TITLE_LENGTH + 40);
  const result = renameSerialGroup(baseGroups(), 'default', longTitle);
  assert.equal(result.groups[0].title.length, MAX_GROUP_TITLE_LENGTH);
});

test('renameSerialGroup 可开启跟随端口并保留用户填写的标题', () => {
  const result = renameSerialGroup(baseGroups(), 'default', 'Motor', { followPort: true });
  assert.equal(result.changed, true);
  assert.equal(result.group.followPort, true);
  // 手填的标题必须留着：关掉跟随开关后要能立刻回到它，不能丢字。
  assert.equal(result.group.title, 'Motor');
});

test('renameSerialGroup 关闭跟随端口时移除该键而不是写 false', () => {
  const on = renameSerialGroup(baseGroups(), 'default', 'Motor', { followPort: true }).groups;
  const off = renameSerialGroup(on, 'default', 'Motor', { followPort: false });
  assert.equal(off.changed, true);
  assert.equal(Object.prototype.hasOwnProperty.call(off.group, 'followPort'), false);
  assert.equal(off.group.title, 'Motor');
});

test('renameSerialGroup 只切开关不改标题也算变更', () => {
  const result = renameSerialGroup(baseGroups(), 'default', 'COM6', { followPort: true });
  assert.equal(result.changed, true);
  assert.equal(result.group.followPort, true);
});

test('resolveGroupDisplayTitle 跟随端口时用端口名，否则用标题', () => {
  assert.equal(resolveGroupDisplayTitle({ title: 'Motor', portPath: 'COM7', followPort: true }), 'COM7');
  assert.equal(resolveGroupDisplayTitle({ title: 'Motor', portPath: 'COM7', followPort: false }), 'Motor');
  // 跟随开着但还没选端口：回落标题，不能显示空标签。
  assert.equal(resolveGroupDisplayTitle({ title: 'Motor', portPath: '', followPort: true }), 'Motor');
  assert.equal(resolveGroupDisplayTitle(null, 'Serial 1'), 'Serial 1');
});

test('renameSerialGroup 对不存在的分组返回 changed=false', () => {
  const result = renameSerialGroup(baseGroups(), 'missing', 'X');
  assert.equal(result.changed, false);
  assert.equal(result.group, null);
});

test('findSerialGroup 找到与找不到', () => {
  assert.equal(findSerialGroup(baseGroups(), 'default').title, 'COM6');
  assert.equal(findSerialGroup(baseGroups(), 'missing'), null);
});

test('非法输入不崩溃', () => {
  assert.deepEqual(nextGroupId(null), 'g-1');
  assert.equal(addSerialGroup(null, null).groups.length, 1);
  assert.deepEqual(removeSerialGroup(null, 'x').groups, []);
  assert.equal(renameSerialGroup(null, 'x', 'y').changed, false);
  assert.equal(findSerialGroup(null, 'x'), null);
});

test('重复 id 在归一化时被去掉，不会出现两个同 id 分组', () => {
  const groups = [{ id: 'default', title: 'A' }, { id: 'default', title: 'B' }];
  const result = removeSerialGroup(groups, 'default');
  // 归一化已把重复项去掉，因此只删掉一个。
  assert.deepEqual(result.groups, []);
});

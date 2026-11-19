'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  attributeSelector,
  describeGroupWorkspaceEntry,
  describeGroupWorkspace,
  findMissingGroupContainers
} = require('../src/serial/serial-group-workspace');

function makeGroups(ids, overrides = {}) {
  return ids.map(id => ({ id, title: `T-${id}`, status: 'disconnected', ...overrides }));
}

test('a single group collapses to single mode with the default pane', () => {
  const model = describeGroupWorkspace({ groups: makeGroups(['default']) });
  assert.equal(model.mode, 'single');
  assert.equal(model.isMultiGroup, false);
  assert.equal(model.activeGroupId, 'default');
  assert.equal(model.entries.length, 1);
  assert.equal(model.entries[0].paneId, 'pane-1');
  assert.equal(model.active.groupId, 'default');
});

test('two or more groups switch to multi mode', () => {
  const model = describeGroupWorkspace({ groups: makeGroups(['default', 'g-1', 'g-2']) });
  assert.equal(model.mode, 'multi');
  assert.equal(model.isMultiGroup, true);
  assert.equal(model.entries.length, 3);
});

test('the default group keeps the legacy container and tab ids', () => {
  const entry = describeGroupWorkspaceEntry('default');
  // 这三项与 serial-group-dom 的契约一致；这里再断言一次是为了让
  // 「工作区模型」本身也能独立证明默认分组没有漂移。
  assert.equal(entry.mainTabId, 'tab-main');
  assert.equal(entry.mainTabButtonId, 'tab-main-button');
  assert.equal(entry.containerId, 'serial-container');
});

test('non-default groups get their own container, never sharing with default', () => {
  const a = describeGroupWorkspaceEntry('g-1');
  const b = describeGroupWorkspaceEntry('g-2');
  const base = describeGroupWorkspaceEntry('default');
  const ids = [a.containerId, b.containerId, base.containerId];
  assert.equal(new Set(ids).size, 3);
  assert.equal(a.containerId, 'serial-container-g-1');
});

test('an unknown activeGroupId falls back to the first group', () => {
  // 与 serial-group-tabs.js 同一条规则：若这里返回 null，工作区会没有激活项，
  // 而标签栏却仍显示某个分组被选中，两者不一致会表现为「点标签内容不换」。
  const model = describeGroupWorkspace({
    groups: makeGroups(['default', 'g-1']),
    activeGroupId: 'does-not-exist'
  });
  assert.equal(model.activeGroupId, 'default');
  assert.equal(model.active.groupId, 'default');
  assert.equal(model.entries.filter(entry => entry.isActive).length, 1);
});

test('an explicitly valid activeGroupId is preserved', () => {
  const model = describeGroupWorkspace({
    groups: makeGroups(['default', 'g-1']),
    activeGroupId: 'g-1'
  });
  assert.equal(model.activeGroupId, 'g-1');
  assert.deepEqual(model.entries.map(entry => entry.isActive), [false, true]);
});

test('duplicate and malformed group ids are dropped', () => {
  const model = describeGroupWorkspace({
    groups: [{ id: 'default' }, { id: 'default' }, { id: '  ' }, null, { id: 'g-1' }]
  });
  assert.deepEqual(model.entries.map(entry => entry.groupId), ['default', 'g-1']);
});

test('an empty group list yields an explicit empty model instead of throwing', () => {
  // 用户可以关掉全部分组只剩 Shell，这是合法状态。
  const model = describeGroupWorkspace({ groups: [] });
  assert.equal(model.mode, 'empty');
  assert.equal(model.activeGroupId, null);
  assert.equal(model.active, null);
  assert.deepEqual(model.entries, []);
});

test('describeGroupWorkspace tolerates missing input entirely', () => {
  assert.equal(describeGroupWorkspace().mode, 'empty');
  assert.equal(describeGroupWorkspace(null).mode, 'empty');
});

test('a connected group is reported as connected either via flag or status', () => {
  const byFlag = describeGroupWorkspaceEntry('g-1', { connected: true });
  const byStatus = describeGroupWorkspace({ groups: [{ id: 'g-1', status: 'connected' }] });
  assert.equal(byFlag.connected, true);
  assert.equal(byStatus.entries[0].connected, true);
});

test('an empty title falls back to a readable placeholder', () => {
  // 空标题的分组标签是一块用户无法识别的空白。
  const entry = describeGroupWorkspaceEntry('g-1', { title: '   ' });
  assert.equal(entry.title, 'Serial');
  assert.equal(describeGroupWorkspaceEntry('g-1', { title: 'COM3' }).title, 'COM3');
});

test('pane assignment can be overridden per group', () => {
  const model = describeGroupWorkspace({
    groups: makeGroups(['default', 'g-1']),
    paneIds: { 'g-1': 'pane-2' }
  });
  const byId = Object.fromEntries(model.entries.map(entry => [entry.groupId, entry.paneId]));
  assert.equal(byId['default'], 'pane-1');
  assert.equal(byId['g-1'], 'pane-2');
});

test('selectors are attribute based so any groupId is queryable', () => {
  // `#1a` 在 HTML 里是合法 id，但在 querySelector 里是语法错误；
  // 属性选择器对所有这些 id 都成立。
  const entry = describeGroupWorkspaceEntry('1a');
  assert.equal(entry.containerSelector, '[id="serial-container-1a"]');
  assert.doesNotThrow(() => new RegExp(entry.containerSelector.replace(/[[\]"]/g, '')));
  assert.equal(attributeSelector('id', 'a"b'), '[id="a\\"b"]');
});

test('findMissingGroupContainers reports only groups without a DOM node', () => {
  const model = describeGroupWorkspace({ groups: makeGroups(['default', 'g-1', 'g-2']) });
  const existing = new Set(['serial-container', 'serial-container-g-2']);
  assert.deepEqual(
    findMissingGroupContainers(model.entries, id => existing.has(id)).map(entry => entry.groupId),
    ['g-1']
  );
});

test('findMissingGroupContainers treats everything as missing without a probe', () => {
  const model = describeGroupWorkspace({ groups: makeGroups(['default', 'g-1']) });
  assert.deepEqual(
    findMissingGroupContainers(model.entries).map(entry => entry.groupId),
    ['default', 'g-1']
  );
  assert.deepEqual(findMissingGroupContainers(null), []);
});

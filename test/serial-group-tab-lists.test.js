'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGroupTabListStore } = require('../serial-group-tab-lists');

test('the default group starts with an empty list', () => {
  const store = createGroupTabListStore();
  assert.deepEqual(store.getList('default'), []);
  assert.equal(store.isEmpty('default'), true);
  assert.equal(store.size(), 1);
});

test('getList is idempotent and returns the same array reference', () => {
  // 这是整个模块的核心不变量。renderer 的模块级 `let filterTabs` 会指向某个
  // 分组的数组；若 getList 每次返回新数组，push 进去的标签就再也读不到了。
  const store = createGroupTabListStore();
  const first = store.getList('g-1');
  const second = store.getList('g-1');
  assert.equal(first, second);
  first.push({ id: 'tab-filter-1' });
  assert.equal(store.getList('g-1').length, 1);
  assert.equal(store.count('g-1'), 1);
});

test('different groups never share a list', () => {
  const store = createGroupTabListStore();
  store.getList('g-1').push({ id: 'tab-filter-1' });
  assert.equal(store.count('g-1'), 1);
  assert.equal(store.count('g-2'), 0);
  assert.equal(store.count('default'), 0);
  assert.notEqual(store.getList('g-1'), store.getList('g-2'));
});

test('replaceList mutates in place so existing references stay valid', () => {
  // 若 replaceList 换成新数组，调用方持有的旧引用会变成孤儿，
  // 表现为「恢复配置后过滤页数量是 0」。
  const store = createGroupTabListStore();
  const held = store.getList('g-1');
  store.replaceList('g-1', [{ id: 'a' }, { id: 'b' }]);
  assert.equal(store.getList('g-1'), held);
  assert.equal(held.length, 2);
  assert.deepEqual(held.map(tab => tab.id), ['a', 'b']);
});

test('replaceList drops everything that was there before', () => {
  const store = createGroupTabListStore();
  store.getList('g-1').push({ id: 'old' });
  store.replaceList('g-1', [{ id: 'new' }]);
  assert.deepEqual(store.getList('g-1').map(tab => tab.id), ['new']);
});

test('replaceList tolerates a non-array argument by clearing', () => {
  const store = createGroupTabListStore();
  store.getList('g-1').push({ id: 'x' });
  store.replaceList('g-1', null);
  assert.equal(store.count('g-1'), 0);
  store.getList('g-1').push({ id: 'y' });
  store.replaceList('g-1', undefined);
  assert.equal(store.count('g-1'), 0);
});

test('clearList empties in place', () => {
  const store = createGroupTabListStore();
  const held = store.getList('g-1');
  held.push({ id: 'a' });
  store.clearList('g-1');
  assert.equal(held.length, 0);
  assert.equal(store.getList('g-1'), held);
});

test('removeList drops a non-default group entirely', () => {
  const store = createGroupTabListStore();
  store.getList('g-1').push({ id: 'a' });
  assert.equal(store.removeList('g-1'), true);
  assert.equal(store.count('g-1'), 0);
  assert.equal(store.listGroupIds().includes('g-1'), false);
});

test('removeList refuses the default group', () => {
  // 与 SerialGroupContextStore 同一规则：默认分组的列表删掉后没有任何路径恢复，
  // 用户会看到「标签栏永远空着」的分组。
  const store = createGroupTabListStore();
  store.getList('default').push({ id: 'a' });
  assert.equal(store.removeList('default'), false);
  assert.equal(store.count('default'), 1);
});

test('removeList on an unknown group is a no-op rather than an error', () => {
  // 关闭分组的按钮可能被连点；第二次点击时列表已经不在了。
  const store = createGroupTabListStore();
  assert.equal(store.removeList('g-9'), false);
});

test('empty and missing group ids fall back to the default group', () => {
  const store = createGroupTabListStore();
  const held = store.getList('default');
  assert.equal(store.getList(''), held);
  assert.equal(store.getList(null), held);
  assert.equal(store.getList(undefined), held);
});

test('a custom default group id is respected', () => {
  // 不是为了兼容旧配置，而是为了让 store 不把 'default' 写死成魔法值。
  const store = createGroupTabListStore({ defaultGroupId: 'g-1' });
  store.getList('g-1').push({ id: 'a' });
  assert.equal(store.removeList('g-1'), false);
  assert.equal(store.count('g-1'), 1);
});

test('snapshot reports per-group counts without exposing the arrays', () => {
  const store = createGroupTabListStore();
  store.getList('g-1').push({ id: 'a' });
  store.getList('g-2').push({ id: 'b' }, { id: 'c' });
  assert.deepEqual(store.snapshot(), { default: 0, 'g-1': 1, 'g-2': 2 });
  // 改快照不得影响真实列表
  const snap = store.snapshot();
  snap['g-1'] = 99;
  assert.equal(store.count('g-1'), 1);
});

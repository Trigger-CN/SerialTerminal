'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { SerialTerminalRuntimeRegistry, describeRuntime } = require('../src/serial/serial-group-runtime');

function makeRegistry(overrides = {}) {
  const created = [];
  const disposed = [];
  const registry = new SerialTerminalRuntimeRegistry({
    createRuntime: (groupId) => {
      created.push(groupId);
      return {
        groupId,
        term: {},
        dataParser: {},
        hexFormatter: {},
        dispose() { disposed.push(groupId); },
        ...overrides
      };
    }
  });
  return { registry, created, disposed };
}

test('构造时不创建任何实例（惰性创建）', () => {
  const { registry, created } = makeRegistry();
  assert.equal(registry.size, 0);
  assert.deepEqual(created, []);
});

test('缺少 createRuntime 时构造即报错', () => {
  assert.throws(() => new SerialTerminalRuntimeRegistry({}), /requires a createRuntime/);
  assert.throws(() => new SerialTerminalRuntimeRegistry(), /requires a createRuntime/);
});

test('get 只读：未创建时返回 null，且不会隐式创建', () => {
  const { registry, created } = makeRegistry();
  assert.equal(registry.get('g-1'), null);
  assert.deepEqual(created, []);
  assert.equal(registry.has('g-1'), false);
});

test('getOrCreate 首次创建并缓存，第二次返回同一实例', () => {
  const { registry, created } = makeRegistry();
  const first = registry.getOrCreate('g-1');
  const second = registry.getOrCreate('g-1');
  assert.equal(first, second);
  assert.deepEqual(created, ['g-1']);
  assert.equal(registry.has('g-1'), true);
  assert.equal(registry.size, 1);
});

test('groupId 会被归一化，空值落到默认分组', () => {
  const { registry, created } = makeRegistry();
  const runtime = registry.getOrCreate('');
  assert.equal(runtime.groupId, 'default');
  assert.deepEqual(created, ['default']);
  // 用 undefined 和空白串取到的是同一个实例。
  assert.equal(registry.get('   '), runtime);
  assert.equal(registry.get(undefined), runtime);
});

test('createRuntime 返回非法值时不缓存半成品', () => {
  let calls = 0;
  const registry = new SerialTerminalRuntimeRegistry({
    createRuntime: () => {
      calls += 1;
      return null;
    }
  });
  assert.throws(() => registry.getOrCreate('g-1'), /returned invalid/);
  assert.equal(registry.size, 0, 'constructor 失败不应留下缓存');
  // 再次尝试仍会重新构造，而不是返回缓存的 null。
  assert.throws(() => registry.getOrCreate('g-1'));
  assert.equal(calls, 2);
});

test('release 会调用 dispose 并从表中移除', () => {
  const { registry, disposed } = makeRegistry();
  registry.getOrCreate('g-1');
  assert.equal(registry.release('g-1'), true);
  assert.deepEqual(disposed, ['g-1']);
  assert.equal(registry.has('g-1'), false);
  assert.equal(registry.size, 0);
});

test('默认分组不可释放', () => {
  const { registry, disposed } = makeRegistry();
  registry.getOrCreate('default');
  assert.equal(registry.release('default'), false);
  assert.equal(registry.has('default'), true);
  assert.deepEqual(disposed, []);
});

test('释放不存在的分组返回 false 且不抛错', () => {
  const { registry, disposed } = makeRegistry();
  assert.equal(registry.release('g-9'), false);
  assert.deepEqual(disposed, []);
});

test('dispose 抛错时仍从表中移除，且异常不外泄', () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args[0]); };
  try {
    const registry = new SerialTerminalRuntimeRegistry({
      createRuntime: (groupId) => ({
        groupId,
        dispose() { throw new Error('boom'); }
      })
    });
    registry.getOrCreate('g-1');
    assert.equal(registry.release('g-1'), true);
    assert.equal(registry.has('g-1'), false, '即使 dispose 失败也要移除引用');
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});

test('releaseAllExceptDefault 只释放额外分组并按顺序报告', () => {
  const { registry, disposed } = makeRegistry();
  registry.getOrCreate('default');
  registry.getOrCreate('g-1');
  registry.getOrCreate('g-2');
  const released = registry.releaseAllExceptDefault();
  assert.deepEqual(released, ['g-1', 'g-2']);
  assert.deepEqual(disposed, ['g-1', 'g-2']);
  assert.deepEqual(registry.listGroupIds(), ['default']);
});

test('listGroupIds 反映实际持有的分组', () => {
  const { registry } = makeRegistry();
  registry.getOrCreate('default');
  registry.getOrCreate('g-1');
  assert.deepEqual(registry.listGroupIds(), ['default', 'g-1']);
});

test('describeRuntime 用于诊断信息', () => {
  assert.equal(describeRuntime(null), 'invalid');
  assert.equal(describeRuntime({}), 'empty');
  assert.equal(describeRuntime({ term: {} }), 'term');
  assert.equal(describeRuntime({ term: {}, dataParser: {}, hexFormatter: {} }), 'term+dataParser+hexFormatter');
});

test('默认分组 id 可自定义', () => {
  const registry = new SerialTerminalRuntimeRegistry({
    defaultGroupId: 'primary',
    createRuntime: (groupId) => ({ groupId })
  });
  registry.getOrCreate('primary');
  assert.equal(registry.release('primary'), false, '自定义默认分组同样不可释放');
  registry.getOrCreate('other');
  assert.equal(registry.release('other'), true);
});

test('attach 可登记已存在的实例且不调用 createRuntime', () => {
  const { registry, created } = makeRegistry();
  const existing = { groupId: 'default', term: {} };
  assert.equal(registry.attach('default', existing), true);
  assert.deepEqual(created, [], 'attach 不应触发构造');
  assert.equal(registry.get('default'), existing);
  assert.equal(registry.size, 1);
});

test('attach 对已登记的分组返回 false 且不覆盖原实例', () => {
  const { registry } = makeRegistry();
  const first = { groupId: 'g-1', term: { id: 1 } };
  const second = { groupId: 'g-1', term: { id: 2 } };
  registry.attach('g-1', first);
  assert.equal(registry.attach('g-1', second), false);
  assert.equal(registry.get('g-1'), first, '旧引用必须继续有效');
});

test('attach 拒绝非法实例', () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.attach('g-1', null), /got invalid/);
  assert.equal(registry.size, 0);
});

test('attach 之后 getOrCreate 直接返回已登记实例', () => {
  const { registry, created } = makeRegistry();
  const existing = { groupId: 'default', term: {} };
  registry.attach('default', existing);
  assert.equal(registry.getOrCreate('default'), existing);
  assert.deepEqual(created, []);
});

test('assertDefaultAttached 在未登记默认分组时报错', () => {
  const { registry } = makeRegistry();
  assert.throws(() => registry.assertDefaultAttached(), /missing the default group/);
  registry.attach('default', { groupId: 'default', term: {} });
  assert.equal(registry.assertDefaultAttached(), true);
});

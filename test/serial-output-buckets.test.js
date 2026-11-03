'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SerialOutputBuckets,
  DEFAULT_HIGH_WATER_BYTES,
  normalizeHighWater
} = require('../serial-output-buckets');
const { DEFAULT_SERIAL_GROUP_ID } = require('../serial-group-registry');

function asText(batch) {
  return batch.buffer.toString('utf8');
}

test('bytes from two groups never land in the same drained batch', () => {
  // 这是整份改造唯一的硬指标：两个串口的字节一旦被拼进同一批，
  // 就会写进同一个终端与同一个日志文件，且不会抛任何错。
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', Buffer.from('AAA'));
  buckets.push('g-2', Buffer.from('BBB'));
  buckets.push('g-1', Buffer.from('111'));

  const batches = buckets.drain();
  assert.equal(batches.length, 2);

  const byGroup = new Map(batches.map(batch => [batch.groupId, asText(batch)]));
  assert.equal(byGroup.get('g-1'), 'AAA111');
  assert.equal(byGroup.get('g-2'), 'BBB');
  assert.equal(byGroup.size, 2);
});

test('draining returns groups in first-enqueue order and clears the store', () => {
  const buckets = new SerialOutputBuckets();
  buckets.push('g-2', Buffer.from('two'));
  buckets.push('g-1', Buffer.from('one'));

  assert.deepEqual(buckets.drain().map(batch => batch.groupId), ['g-2', 'g-1']);
  // 取走之后必须真的空了，否则同一段字节会被上屏两次。
  assert.deepEqual(buckets.drain(), []);
  assert.equal(buckets.hasPending(), false);
  assert.equal(buckets.totalPendingBytes(), 0);
});

test('draining a single group leaves the other group untouched', () => {
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', Buffer.from('keep'));
  buckets.push('g-2', Buffer.from('drop'));

  const taken = buckets.drainGroup('g-2');
  assert.equal(asText(taken), 'drop');
  assert.equal(buckets.drainGroup('g-2'), null);
  assert.deepEqual(buckets.pendingGroupIds(), ['g-1']);
  assert.equal(buckets.pendingBytes('g-1'), 4);
});

test('the high-water mark is evaluated per group, not globally', () => {
  // 一个分组把自己淹了，不应该连带立刻 flush 另一个分组的半截数据。
  const buckets = new SerialOutputBuckets({ highWaterBytes: 10 });
  assert.equal(buckets.push('g-1', Buffer.from('12345')).shouldFlush, false);
  assert.equal(buckets.push('g-2', Buffer.from('1234567890')).shouldFlush, true);
  // g-1 仍是 5 字节：g-2 的 10 字节不参与它的水位判断。
  assert.equal(buckets.pendingBytes('g-1'), 5);
  assert.equal(buckets.pendingBytes('g-2'), 10);
});

test('the high-water mark is inclusive and resets after a drain', () => {
  const buckets = new SerialOutputBuckets({ highWaterBytes: 6 });
  assert.equal(buckets.push('g-1', Buffer.from('abc')).shouldFlush, false);
  assert.equal(buckets.push('g-1', Buffer.from('def')).shouldFlush, true);
  buckets.drain();
  assert.equal(buckets.push('g-1', Buffer.from('abc')).shouldFlush, false);
});

test('missing, empty, and malformed group ids fall back to the default group', () => {
  // 未登记的 groupId 绝不能静默丢弃：回落默认分组至少还能看见数据。
  const buckets = new SerialOutputBuckets();
  [undefined, null, '', '   '].forEach(groupId => {
    buckets.push(groupId, Buffer.from('x'));
  });
  const batches = buckets.drain();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].groupId, DEFAULT_SERIAL_GROUP_ID);
  assert.equal(asText(batches[0]), 'xxxx');
});

test('empty and unsupported payloads are ignored instead of throwing', () => {
  const buckets = new SerialOutputBuckets();
  assert.equal(buckets.push('g-1', Buffer.alloc(0)).shouldFlush, false);
  assert.equal(buckets.push('g-1', null).shouldFlush, false);
  assert.equal(buckets.push('g-1', undefined).shouldFlush, false);
  assert.equal(buckets.hasPending(), false);
  assert.deepEqual(buckets.drain(), []);
});

test('Uint8Array and plain arrays are accepted and preserve byte order', () => {
  // IPC 传过来的是 Uint8Array；某些路径（测试、回放）会传普通数组。
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', Uint8Array.from([0x41, 0x42]));
  buckets.push('g-1', [0x43]);
  const batches = buckets.drain();
  assert.deepEqual(Array.from(batches[0].buffer), [0x41, 0x42, 0x43]);
});

test('a Uint8Array view is read through its own byteOffset, not the whole backing store', () => {
  // Buffer.from(view) 若丢掉了 byteOffset，会把相邻内存一起读出来——
  // 表现为终端里冒出不属于这段数据的字节。这条用例专门守护这一点。
  const backing = new Uint8Array([0x00, 0x41, 0x42, 0x00]);
  const view = backing.subarray(1, 3);
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', view);
  assert.deepEqual(Array.from(buckets.drain()[0].buffer), [0x41, 0x42]);
});

test('clear removes pending bytes and reports whether the group existed', () => {
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', Buffer.from('abc'));
  assert.equal(buckets.clear('g-1'), true);
  assert.equal(buckets.clear('g-1'), false);
  assert.equal(buckets.hasPending(), false);
});

test('clearAll drops every group and returns how many were pending', () => {
  const buckets = new SerialOutputBuckets();
  buckets.push('g-1', Buffer.from('a'));
  buckets.push('g-2', Buffer.from('b'));
  assert.equal(buckets.clearAll(), 2);
  assert.equal(buckets.totalPendingBytes(), 0);
  assert.deepEqual(buckets.pendingGroupIds(), []);
});

test('the default high-water mark is one megabyte, matching the old single-queue threshold', () => {
  // 单分组时的行为必须与改造前逐字节一致：旧阈值是 1 MiB。
  assert.equal(DEFAULT_HIGH_WATER_BYTES, 1024 * 1024);
  assert.equal(new SerialOutputBuckets().highWaterBytes, 1024 * 1024);
  assert.equal(normalizeHighWater('nope'), DEFAULT_HIGH_WATER_BYTES);
  assert.equal(normalizeHighWater(0), DEFAULT_HIGH_WATER_BYTES);
  assert.equal(normalizeHighWater(-5), DEFAULT_HIGH_WATER_BYTES);
  assert.equal(normalizeHighWater(64), 64);
});

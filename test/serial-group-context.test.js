'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SerialGroupContextStore, createDefaultState } = require('../serial-group-context');
const { DEFAULT_SERIAL_GROUP_ID } = require('../serial-group-registry');

test('default state carries independent screen and log counters', () => {
  const state = createDefaultState();

  assert.equal(state.serialLineCounter, 1);
  assert.equal(state.logLineCounter, 1);
  assert.equal(state.serialNewLine, true);
  assert.equal(state.receiveDisplayMode, 'text');
});

test('store starts with the default group only', () => {
  const store = new SerialGroupContextStore();

  assert.deepEqual(store.listGroupIds(), [DEFAULT_SERIAL_GROUP_ID]);
});

test('nextLineNumbers advances screen and log independently', () => {
  const store = new SerialGroupContextStore();

  assert.deepEqual(store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID), { screen: 1, log: 1 });
  assert.deepEqual(store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID), { screen: 2, log: 2 });
  // 只推进屏幕行号：用于只上屏、不写日志的场景。
  assert.deepEqual(
    store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID, { advanceLog: false }),
    { screen: 3, log: 3 }
  );
  assert.deepEqual(
    store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID, { advanceScreen: false }),
    { screen: 4, log: 3 }
  );
});

test('line counters never leak across groups', () => {
  const store = new SerialGroupContextStore();
  store.ensureContext('group-b');

  // 把 A 组推进到 5，B 组必须仍从 1 开始。
  for (let i = 0; i < 4; i += 1) store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID);
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).serialLineCounter, 5);
  assert.equal(store.get('group-b').serialLineCounter, 1);
});

test('resetLineCounters only affects the targeted group', () => {
  const store = new SerialGroupContextStore();
  store.ensureContext('group-b');
  store.nextLineNumbers(DEFAULT_SERIAL_GROUP_ID);
  store.nextLineNumbers('group-b');

  store.resetLineCounters('group-b');

  assert.equal(store.get('group-b').serialLineCounter, 1);
  assert.equal(store.get('group-b').logLineCounter, 1);
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).serialLineCounter, 2);
});

test('setDisplay ignores unknown types and keeps prior values', () => {
  const store = new SerialGroupContextStore();

  store.setDisplay(DEFAULT_SERIAL_GROUP_ID, { receiveDisplayMode: 'hex', newlineMode: 'lf' });
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).receiveDisplayMode, 'hex');
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).newlineMode, 'lf');

  // 非字符串不得写入，避免 undefined 把配置冲掉。
  store.setDisplay(DEFAULT_SERIAL_GROUP_ID, { receiveEncoding: null, sendEncoding: 42 });
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).receiveEncoding, 'utf8');
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).sendEncoding, 'utf8');
});

test('display state is per group', () => {
  const store = new SerialGroupContextStore();
  store.ensureContext('group-b');

  store.setDisplay('group-b', { receiveDisplayMode: 'hex', sendEncoding: 'gbk' });

  assert.equal(store.get('group-b').receiveDisplayMode, 'hex');
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).receiveDisplayMode, 'text');
  assert.equal(store.get(DEFAULT_SERIAL_GROUP_ID).sendEncoding, 'utf8');
});

test('the default group context cannot be removed', () => {
  const store = new SerialGroupContextStore();
  store.ensureContext('group-b');

  assert.equal(store.removeContext('group-b'), true);
  assert.equal(store.removeContext(DEFAULT_SERIAL_GROUP_ID), false);
  assert.deepEqual(store.listGroupIds(), [DEFAULT_SERIAL_GROUP_ID]);
});

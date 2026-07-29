'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeIntegerSetting } = require('../config-values');

test('accepts integer settings and clamps values outside their ranges', () => {
  assert.equal(normalizeIntegerSetting('24', 'fontSize'), 24);
  assert.equal(normalizeIntegerSetting(2, 'fontSize'), 8);
  assert.equal(normalizeIntegerSetting(100, 'fontSize'), 72);
  assert.equal(normalizeIntegerSetting(-1, 'mainInputHistoryLimit'), 0);
  assert.equal(normalizeIntegerSetting(999, 'mouseWheelScrollLines'), 50);
});

test('falls back for null, empty, non-finite, and fractional values', () => {
  assert.equal(normalizeIntegerSetting(null, 'scrollbackLimit'), 100000);
  assert.equal(normalizeIntegerSetting('', 'historyBufferSize'), 5000000);
  assert.equal(normalizeIntegerSetting(Number.POSITIVE_INFINITY, 'rawBufferAutoFlushMB'), 10);
  assert.equal(normalizeIntegerSetting('12.5', 'hexIdleFlushMs'), 50);
  assert.equal(normalizeIntegerSetting('invalid', 'fontSize'), 14);
});

test('rejects unknown setting names', () => {
  assert.throws(() => normalizeIntegerSetting(1, 'missing'), /Unknown integer setting/);
});

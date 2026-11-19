'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STANDARD_BAUD_RATES,
  MIN_BAUD_RATE,
  isSupportedBaudRate,
  isStandardBaudRate,
  normalizeBaudRate,
  normalizeCustomBaudRates
} = require('../baud-rates');

test('baud rates accept only positive safe whole numbers', () => {
  assert.equal(normalizeBaudRate(' 250000 '), '250000');
  assert.equal(normalizeBaudRate(250000), '250000');
  assert.equal(normalizeBaudRate('000250000'), '250000');

  for (const value of [null, undefined, '', ' ', '1.5', 1.5, '1e3', 0, '0', -1, '-1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeBaudRate(value), null, `expected ${String(value)} to be rejected`);
  }
});

test('custom baud rates remove invalid, duplicate, and standard entries', () => {
  assert.deepEqual(normalizeCustomBaudRates(null), []);
  assert.deepEqual(
    normalizeCustomBaudRates(['250000', 250000, ' 750000 ', '9600', 0, '1.5', '000750000', '333333']),
    ['250000', '750000', '333333']
  );
});

test('standard baud-rate detection uses the shared standard list', () => {
  // 只保留 9600 及以上的速率：低于 9600 的在现代设备上已无用武之地，
  // 留在列表里只是把常用值挤到下拉框下半部分。
  assert.equal(STANDARD_BAUD_RATES.length, 14);
  assert.equal(STANDARD_BAUD_RATES[0], '9600');
  for (const removed of ['110', '300', '600', '1200', '2400', '4800']) {
    assert.equal(STANDARD_BAUD_RATES.includes(removed), false, `${removed} 不应再是标准速率`);
  }
  assert.equal(isStandardBaudRate('115200'), true);
  assert.equal(isStandardBaudRate(2000000), true);
  assert.equal(isStandardBaudRate('250000'), false);
  assert.equal(isStandardBaudRate('invalid'), false);
  // 被移除的低速率现在连「标准」都算不上，因此也不会被当作自定义项收进列表。
  assert.equal(isStandardBaudRate('4800'), false);
  assert.deepEqual(normalizeCustomBaudRates(['4800', '9600', '250000']), ['250000']);
  assert.equal(isSupportedBaudRate('9600'), true);
  assert.equal(isSupportedBaudRate('4800'), false);
});

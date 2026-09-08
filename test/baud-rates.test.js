'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STANDARD_BAUD_RATES,
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
  assert.equal(STANDARD_BAUD_RATES.length, 20);
  assert.equal(isStandardBaudRate('115200'), true);
  assert.equal(isStandardBaudRate(2000000), true);
  assert.equal(isStandardBaudRate('250000'), false);
  assert.equal(isStandardBaudRate('invalid'), false);
});

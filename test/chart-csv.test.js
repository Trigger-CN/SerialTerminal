'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChartCsv } = require('../chart-csv');

test('exports UTF-8 BOM, original timestamps, labels, and empty missing values', () => {
  const csv = buildChartCsv([
    { timestamp: 1000.001, originalTimestamp: 1000, sequence: 7, values: { a: 2 } },
    { timestamp: 2000, originalTimestamp: 2000, sequence: 8, values: { a: null } }
  ], [{ key: 'a', label: 'Value "A"' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.match(csv, /"timestamp","sequence","Value ""A"""/);
  assert.match(csv, /1970-01-01T00:00:01\.000Z/);
  assert.match(csv, /"8",""$/);
});

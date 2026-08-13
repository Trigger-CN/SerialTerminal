'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ChartDataModel } = require('../chart-data-model');

test('stores aligned series with null gaps and calculates statistics', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }, { key: 'b' }], maxPoints: 100 });
  model.append({ timestamp: 1000, values: { a: 1, b: 5 } });
  model.append({ timestamp: 2000, values: { a: 3 } });
  assert.deepEqual(model.toAlignedData(), [[1, 2], [1, 3], [5, null]]);
  assert.deepEqual(model.stats('a'), { current: 3, min: 1, max: 3, average: 2, count: 2 });
});

test('enforces point and duration retention and monotonic timestamps', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }], maxPoints: 100, maxDurationMs: 1000 });
  for (let index = 0; index < 120; index++) model.append({ timestamp: index * 20, values: { a: index } });
  assert.ok(model.samples.length <= 51);
  assert.ok(model.samples[0].timestamp >= 1380);
  const latest = model.samples[model.samples.length - 1].timestamp;
  model.append({ timestamp: latest, values: { a: 999 } });
  assert.ok(model.samples[model.samples.length - 1].timestamp > latest);
});

test('queries ranges and clears the session', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }] });
  model.append({ timestamp: 1000, values: { a: 1 } });
  model.append({ timestamp: 2000, values: { a: 2 } });
  assert.equal(model.query(1500, 2500).length, 1);
  assert.deepEqual(model.getRange(), [1000, 2000]);
  model.clear();
  assert.equal(model.getRange(), null);
});

test('keeps a bounded full-session overview after raw samples expire', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }], maxPoints: 100, maxDurationMs: 1000, maxOverviewBuckets: 100 });
  for (let index = 0; index < 500; index++) {
    model.append({ timestamp: index * 20, values: { a: index === 5 ? 9999 : index } });
  }
  assert.ok(model.samples[0].timestamp > 0);
  assert.deepEqual(model.getRange(), [0, 9980]);
  assert.ok(model.overviewBuckets.length <= 100);
  assert.ok(model.toOverviewAlignedData()[1].includes(9999));
});

test('returns overview data for a historical range without claiming raw precision', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }], maxPoints: 100, maxDurationMs: 1000, maxOverviewBuckets: 100 });
  for (let index = 0; index < 200; index++) model.append({ timestamp: index * 20, values: { a: index } });
  const overview = model.toOverviewAlignedData(0, 1000);
  assert.ok(overview[0].length > 0);
  assert.ok(overview[0].every(timestamp => timestamp >= 0 && timestamp <= 1));
  const stats = model.overviewStats('a', 0, 1000);
  assert.equal(stats.estimated, true);
  assert.equal(stats.min, 0);
  assert.ok(stats.max >= 49);
});

test('preserves original timestamps while keeping plot timestamps monotonic', () => {
  const model = new ChartDataModel({ fields: [{ key: 'a' }] });
  model.append({ timestamp: 1000, values: { a: 1 } });
  model.append({ timestamp: 1000, values: { a: 2 } });
  assert.equal(model.samples[1].originalTimestamp, 1000);
  assert.ok(model.samples[1].timestamp > 1000);
});

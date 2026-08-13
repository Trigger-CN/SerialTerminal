'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverChartFields, createChartParser, convertUnit } = require('../chart-parser');

const frameLine = 'frame_perf_disp_event_cb: [FRAME_PERF] count=321 frame_total=93600us layout_prep=5300us render_envelope=39300us flush=28300us draw=11000us post_render=49000us mo_dual_disp.c:187';

test('discovers FRAME_PERF fields, units and default selections', () => {
  const fields = discoverChartFields(frameLine, { mode: 'key-value', marker: '[FRAME_PERF]', keyValueSeparator: '=' });
  assert.deepEqual(fields.map(field => field.key), ['count', 'frame_total', 'layout_prep', 'render_envelope', 'flush', 'draw', 'post_render']);
  assert.equal(fields[0].visible, false);
  assert.equal(fields[0].role, 'sequence');
  assert.equal(fields[1].sourceUnit, 'us');
  assert.equal(fields[1].displayUnit, 'ms');
  assert.equal(fields[1].visible, true);
});

test('runtime parser only emits selected fields and converts units', () => {
  const parser = createChartParser({
    mode: 'key-value', marker: '[FRAME_PERF]', keyValueSeparator: '=',
    fields: [
      { key: 'count', role: 'sequence' },
      { key: 'frame_total', sourceUnit: 'us', displayUnit: 'ms' },
      { key: 'draw', sourceUnit: 'us', displayUnit: 'ms' }
    ]
  });
  const sample = parser.parse(`${frameLine} surprise=99`, { receivedAt: 123, sequence: 7 });
  assert.deepEqual(sample.values, { frame_total: 93.6, draw: 11 });
  assert.equal(sample.sourceSequence, 321);
  assert.equal(sample.values.surprise, undefined);
});

test('supports templates and advanced named-group regex', () => {
  const fields = [{ key: 'count', role: 'sequence' }, { key: 'frame_total', sourceUnit: 'us', displayUnit: 'ms' }];
  const template = createChartParser({ mode: 'template', template: '[FRAME_PERF] count={count:int} frame_total={frame_total:us}', fields });
  assert.equal(template.parse(frameLine).values.frame_total, 93.6);
  const regex = createChartParser({ mode: 'regex', pattern: 'count=(?<count>\\d+).*draw=(?<draw>\\d+us)', fields: [{ key: 'draw', sourceUnit: 'us', displayUnit: 'ms' }] });
  assert.equal(regex.parse(frameLine).values.draw, 11);
});

test('template spaces match variable log whitespace', () => {
  const parser = createChartParser({
    mode: 'template',
    template: 'a: {a} b: {b}',
    fields: [{ key: 'a' }, { key: 'b' }]
  });
  assert.deepEqual(parser.parse('prefix a:   1\t\tb:  2 suffix').values, { a: 1, b: 2 });
});

test('requires the configured marker and converts compatible time units', () => {
  const parser = createChartParser({ mode: 'key-value', marker: '[OTHER]', fields: [{ key: 'draw' }] });
  assert.equal(parser.parse(frameLine), null);
  assert.equal(convertUnit(93600, 'us', 'ms'), 93.6);
  assert.equal(convertUnit(2, 's', 'ms'), 2000);
});

test('automatic key-value mode recognizes equals and colon without treating source locations as fields', () => {
  const line = 'fn: [FRAME_PERF] count=3 draw:11000us mo_dual_disp.c:187';
  const fields = discoverChartFields(line, { mode: 'key-value', marker: '[FRAME_PERF]', keyValueSeparator: 'auto' });
  assert.deepEqual(fields.map(field => field.key), ['count', 'draw']);
});

test('rejects rows with no finite active series or an invalid non-empty active value', () => {
  const parser = createChartParser({
    mode: 'key-value', keyValueSeparator: 'auto',
    fields: [{ key: 'a', role: 'series' }, { key: 'b', role: 'series' }]
  });
  assert.equal(parser.parse('unrelated=1'), null);
  assert.equal(parser.parse('a=NaN b=2'), null);
  assert.deepEqual(parser.parse('a=1', { receivedAt: 1 }).values, { a: 1, b: null });
});

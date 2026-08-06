'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getHorizontalInsertionIndex } = require('../tab-reorder');

test('tab insertion follows horizontal tab centers', () => {
  const rects = [
    { left: 10, width: 80 },
    { left: 90, width: 100 },
    { left: 190, width: 60 }
  ];

  assert.equal(getHorizontalInsertionIndex(rects, 20), 0);
  assert.equal(getHorizontalInsertionIndex(rects, 80), 1);
  assert.equal(getHorizontalInsertionIndex(rects, 160), 2);
  assert.equal(getHorizontalInsertionIndex(rects, 270), 3);
  assert.equal(getHorizontalInsertionIndex([], 20), 0);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getVerticalInsertionIndex } = require('../quick-send-reorder');

const shortcutRects = [
  { top: 400, height: 36 },
  { top: 442, height: 36 },
  { top: 484, height: 36 }
];

test('quick-send insertion accepts the empty area above the first shortcut', () => {
  assert.equal(getVerticalInsertionIndex(shortcutRects, 120), 0);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 399), 0);
});

test('quick-send insertion follows item centers and accepts the trailing area', () => {
  assert.equal(getVerticalInsertionIndex(shortcutRects, 419), 1);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 465), 2);
  assert.equal(getVerticalInsertionIndex(shortcutRects, 700), 3);
});

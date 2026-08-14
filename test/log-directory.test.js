'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { formatLocalDate, getLogDirectory } = require('../log-directory');

test('formats local dates and optionally creates a dated log path', () => {
  const date = new Date(2026, 7, 14, 23, 59, 59);

  assert.equal(formatLocalDate(date), '2026-08-14');
  assert.equal(getLogDirectory('D:\\logs', false, date), 'D:\\logs');
  assert.equal(getLogDirectory('D:\\logs', true, date), path.join('D:\\logs', '2026-08-14'));
});

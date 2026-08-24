'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  deleteSearchHistoryItem,
  normalizeSearchHistory,
  recordSearchHistory,
  setSearchHistoryPinned
} = require('../search-history');

function ids() {
  let next = 0;
  return () => `id-${++next}`;
}

function entry(id, query, lastUsedAt, pinned = false, options = {}) {
  return {
    id,
    query,
    regex: options.regex === true,
    caseSensitive: options.caseSensitive === true,
    wholeWord: options.wholeWord === true,
    pinned,
    createdAt: lastUsedAt,
    lastUsedAt,
    sortOrder: lastUsedAt
  };
}

test('normalizes fields, removes duplicate searches, and preserves stable metadata', () => {
  const history = normalizeSearchHistory([
    entry('older', 'ready', 10, true),
    entry('newer', 'ready', 20),
    { query: 'error', regex: true, createdAt: 30 }
  ], 20, { now: 40, createId: ids() });

  assert.equal(history.length, 2);
  assert.deepEqual(history[0], {
    id: 'older', query: 'ready', regex: false, caseSensitive: false, wholeWord: false,
    pinned: true, createdAt: 10, lastUsedAt: 20, sortOrder: 10
  });
  assert.equal(history[1].id, 'id-1');
  assert.equal(history[1].query, 'error');
  assert.equal(history[1].regex, true);
});

test('recording reuses an exact search and treats option changes as distinct searches', () => {
  const createId = ids();
  let history = recordSearchHistory([], { query: 'ready' }, 20, { now: 10, createId });
  history = recordSearchHistory(history, { query: 'ready' }, 20, { now: 20, createId });
  history = recordSearchHistory(history, { query: 'ready', caseSensitive: true }, 20, { now: 30, createId });

  assert.equal(history.length, 2);
  assert.equal(history[0].caseSensitive, true);
  assert.equal(history[1].lastUsedAt, 20);
});

test('limits total entries by evicting the oldest unpinned searches', () => {
  const history = normalizeSearchHistory([
    entry('pinned', 'keep', 1, true),
    entry('old', 'old', 2),
    entry('new', 'new', 3)
  ], 2);

  assert.deepEqual(history.map(item => item.id), ['pinned', 'new']);
});

test('keeps every pinned search when pinned entries exceed the configured limit', () => {
  const history = normalizeSearchHistory([
    entry('pin-1', 'one', 1, true),
    entry('pin-2', 'two', 2, true),
    entry('normal', 'three', 3)
  ], 1);

  assert.deepEqual(history.map(item => item.id), ['pin-2', 'pin-1']);
  assert.deepEqual(normalizeSearchHistory(history, 0).map(item => item.id), ['pin-2', 'pin-1']);
});

test('pin, unpin, and delete operations reapply the configured limit', () => {
  let history = [entry('one', 'one', 1, true), entry('two', 'two', 2, true)];
  history = setSearchHistoryPinned(history, 'one', false, 1);
  assert.deepEqual(history.map(item => item.id), ['two']);
  history = deleteSearchHistoryItem(history, 'two', 1);
  assert.deepEqual(history, []);
});

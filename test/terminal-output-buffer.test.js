'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { appendPendingOutput, countTextLines, dropOldestLines, takePendingChunk } = require('../terminal-output-buffer');

function createState() {
  return { pending: [], pendingLength: 0, pendingLines: 0 };
}

test('counts only newline-terminated lines', () => {
  assert.equal(countTextLines(''), 0);
  assert.equal(countTextLines('a'), 0);
  assert.equal(countTextLines('a\n'), 1);
  assert.equal(countTextLines('a\r\nb\r\n'), 2);
  assert.equal(countTextLines('a\nb'), 1);
});

test('queues everything until the scrollback line limit is reached', () => {
  const state = createState();
  const dropped = appendPendingOutput(state, 'a\nb\nc\n', { maxLines: 5, maxBytes: 1024 });
  assert.equal(dropped, 0);
  assert.equal(state.pendingLines, 3);
  assert.equal(state.pending.join(''), 'a\nb\nc\n');
});

test('drops oldest whole lines once the line limit is exceeded', () => {
  const state = createState();
  appendPendingOutput(state, 'l1\nl2\nl3\n', { maxLines: 4, maxBytes: 1024 });
  const dropped = appendPendingOutput(state, 'l4\nl5\n', { maxLines: 4, maxBytes: 1024 });
  assert.equal(dropped, 3);
  assert.equal(state.pending.join(''), 'l2\nl3\nl4\nl5\n');
  assert.equal(state.pendingLines, 4);
});

test('trims an oversized single chunk to the trailing line limit', () => {
  const state = createState();
  const dropped = appendPendingOutput(state, 'l1\nl2\nl3\nl4\n', { maxLines: 2, maxBytes: 1024 });
  assert.equal(dropped, 6);
  assert.equal(state.pending.join(''), 'l3\nl4\n');
  assert.equal(state.pendingLines, 2);
});

test('keeps the byte hard limit as a backstop for very long lines', () => {
  const state = createState();
  const chunkA = `${'x'.repeat(90)}\n`;
  const chunkB = `${'y'.repeat(90)}\n`;
  appendPendingOutput(state, chunkA, { maxLines: 1000, maxBytes: 120 });
  const dropped = appendPendingOutput(state, chunkB, { maxLines: 1000, maxBytes: 120 });
  assert.equal(dropped, chunkA.length);
  assert.equal(state.pending.join(''), chunkB);
  assert.equal(state.pendingLength, chunkB.length);
  assert.equal(state.pendingLines, 1);
});

test('always keeps at least the newest line under the byte backstop', () => {
  const state = createState();
  const line = `${'z'.repeat(200)}\n`;
  const dropped = appendPendingOutput(state, line, { maxLines: 1000, maxBytes: 60 });
  assert.equal(dropped, 0);
  assert.equal(state.pending.join(''), line);
});

test('dropOldestLines never splits a line and updates accounting', () => {
  const state = createState();
  appendPendingOutput(state, 'a\nbb\nccc\n', { maxLines: 100, maxBytes: 1024 });
  const dropped = dropOldestLines(state, 2);
  assert.equal(dropped, 5);
  assert.equal(state.pending.join(''), 'ccc\n');
  assert.equal(state.pendingLines, 1);
  assert.equal(state.pendingLength, 4);
});

test('preserves byte accounting across appends and drops', () => {
  const state = createState();
  appendPendingOutput(state, 'aa\n', { maxLines: 2, maxBytes: 1024 });
  appendPendingOutput(state, 'bb\n', { maxLines: 2, maxBytes: 1024 });
  assert.equal(state.pendingLines, 2);
  assert.equal(state.pendingLength, state.pending.join('').length);
  assert.equal(state.pendingLength, 6);
});

test('takePendingChunk returns a single small block whole', () => {
  const state = createState();
  appendPendingOutput(state, 'aa\nbb\n', { maxLines: 100, maxBytes: 4096 });
  assert.equal(takePendingChunk(state, 4096), 'aa\nbb\n');
  assert.equal(state.pending.length, 0);
  assert.equal(state.pendingLength, 0);
  assert.equal(state.pendingLines, 0);
});

test('takePendingChunk concatenates only whole blocks within the byte budget', () => {
  const state = createState();
  appendPendingOutput(state, 'aa\n', { maxLines: 100, maxBytes: 4096 });
  appendPendingOutput(state, 'bb\n', { maxLines: 100, maxBytes: 4096 });
  appendPendingOutput(state, 'cc\n', { maxLines: 100, maxBytes: 4096 });
  const first = takePendingChunk(state, 4);
  assert.equal(first, 'aa\n');
  assert.equal(state.pending.join(''), 'bb\ncc\n');
  assert.equal(state.pendingLines, 2);
  assert.equal(state.pendingLength, 6);
});

test('takePendingChunk splits an oversized block on a line boundary', () => {
  const state = createState();
  appendPendingOutput(state, 'l1\nl2\nl3\nl4\n', { maxLines: 100, maxBytes: 4096 });
  const first = takePendingChunk(state, 6);
  assert.equal(first, 'l1\nl2\n');
  assert.equal(state.pending.join(''), 'l3\nl4\n');
  assert.equal(state.pendingLines, 2);
});

test('takePendingChunk returns empty and keeps state when the buffer is drained', () => {
  const state = createState();
  appendPendingOutput(state, 'a\nb\n', { maxLines: 100, maxBytes: 4096 });
  assert.equal(takePendingChunk(state, 2), 'a\n');
  assert.equal(takePendingChunk(state, 2), 'b\n');
  assert.equal(takePendingChunk(state, 2), '');
  assert.equal(state.pendingLength, 0);
});
